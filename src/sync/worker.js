// @ts-check
// fullScan worker (spec §2.7 — default ON).
//
// The wasm CPU work (blinding/parsing) is synchronous on its thread — a cold
// scan of a wallet with history must not freeze the agent's event loop (the
// root cause of the "syncs forever" iOS PWA freeze, GT §1.6). This worker
// instantiates its OWN isolated wasm (module import = init), rebuilds the
// Wollet from the descriptor, replays the persisted update chain, runs the
// fullScan and posts the pruned serialized Update back; the main thread does
// applyUpdate + persistence.
//
// Deliberately plain JavaScript and self-contained (only lwk_node + node
// builtins): worker_threads loads this file directly with Node's loader, so
// it cannot import the TypeScript modules of the SDK. Cost of the isolation:
// +1 wasm init (1-2 ms) and ~+90 MB RSS during the scan (SPIKE measurements).
//
// Protocol (workerData in): { descriptor, dataDir, provider: { url,
// waterfalls, concurrency }, scanToIndex }
// scanToIndex > 0 → degraded coverage-floor replay: scan via
// fullScanToIndex(scanToIndex) instead of the plain gap_limit=20 fullScan
// (the main thread only passes a non-zero value on the vanilla fallback —
// see scanInWorker). (postMessage out): { ok: true, bytes: Uint8Array|null }
// | { ok: false, error: string }
// Timeout/termination is enforced by the main thread (worker.terminate()).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { EsploraClient, Network, Update, Wollet, WolletDescriptor } from "lwk_node";

/**
 * Replay the persisted update chain into a fresh Wollet (tolerant: a missing
 * or corrupt link terminates the walk — parity with §2.5 tolerant reads).
 * @param {import("lwk_node").Wollet} wollet
 * @param {string} dataDir
 */
async function replayChain(wollet, dataDir) {
  const visited = new Set();
  for (;;) {
    const status = wollet.status().toString();
    if (visited.has(status)) break;
    visited.add(status);
    let bytes;
    try {
      bytes = await readFile(join(dataDir, "updates", `${status}.bin`));
    } catch {
      break;
    }
    try {
      wollet.applyUpdate(new Update(new Uint8Array(bytes)));
    } catch {
      break; // broken tail — fullScan below recovers
    }
  }
}

async function main() {
  const { descriptor, dataDir, provider, scanToIndex } = /** @type {{ descriptor: string, dataDir: string, provider: { url: string, waterfalls: boolean, concurrency: number }, scanToIndex?: number }} */ (
    workerData
  );
  const network = Network.mainnet();
  const wollet = new Wollet(network, new WolletDescriptor(descriptor));
  await replayChain(wollet, dataDir);
  const client = new EsploraClient(
    network,
    provider.url,
    provider.waterfalls,
    provider.concurrency,
    false
  );
  // Degraded coverage-floor replay: a vanilla fullScan truncates at
  // gap_limit=20; scanning to the proven floor prevents a wrong-balance
  // rebuild during a waterfalls outage (main thread decides the value).
  const useToIndex =
    provider.waterfalls === false &&
    typeof scanToIndex === "number" &&
    Number.isInteger(scanToIndex) &&
    scanToIndex > 0;
  const update = useToIndex
    ? await client.fullScanToIndex(wollet, scanToIndex)
    : await client.fullScan(wollet);
  if (!update) {
    parentPort?.postMessage({ ok: true, bytes: null });
    return;
  }
  wollet.applyUpdate(update);
  try {
    update.prune(wollet);
  } catch {
    // best effort — un-pruned updates are still valid chain links
  }
  const bytes = update.serialize();
  const buffer = /** @type {ArrayBuffer} */ (bytes.buffer);
  parentPort?.postMessage({ ok: true, bytes }, [buffer]);
}

main().catch((err) => {
  parentPort?.postMessage({
    ok: false,
    error: String((err && /** @type {Error} */ (err).message) || err)
  });
});
