// wallet.sync({ rescan: true }) (PR-D) — deep re-scan from zero for a wallet
// that looks desynchronized: drop the persisted update-chain cache, cold-scan
// a VIRGIN wollet (neverScanned → the engine's cold path) and swap it in only
// after the scan succeeded. Backward-compat is load-bearing: sync() with no
// args stays the incremental sync on the SAME in-memory wollet.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Wollet } from "lwk_node";
import { DepixWallet } from "../src/wallet.js";
import type { EsploraClientLike } from "../src/sync/sync.js";
import { UpdateStore } from "../src/store/update-store.js";
import { isDepixSdkError } from "../src/errors.js";

const PASSPHRASE = "correct-horse-battery-staple";
const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

let dataDir: string;
let wallet: DepixWallet;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-rescan-"));
});
afterEach(async () => {
  await wallet?.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
});

/** Records every fullScan: which Wollet instance and whether it was virgin at scan time. */
function scanRecorder() {
  const scans: { wollet: Wollet; neverScanned: boolean }[] = [];
  const state = { fail: false };
  const factory = (): EsploraClientLike => ({
    fullScan: async (wollet: Wollet) => {
      if (state.fail) throw new Error("scripted scan failure");
      scans.push({ wollet, neverScanned: wollet.neverScanned() });
      return undefined; // successful scan, no chain changes
    },
    broadcast: async () => {
      throw new Error("not used");
    },
    free: () => {}
  });
  return { scans, state, factory };
}

async function openWallet(factory: () => EsploraClientLike): Promise<DepixWallet> {
  return DepixWallet.restore({
    dataDir,
    passphrase: PASSPHRASE,
    mnemonic: KNOWN_MNEMONIC,
    sync: {
      clientFactory: factory,
      providers: [{ name: "p0", url: "http://localhost:1", waterfalls: false }]
    }
  });
}

describe("wallet.sync() backward-compat (incremental)", () => {
  it("no-arg sync() reuses the SAME in-memory wollet across calls and keeps the cache", async () => {
    const { scans, factory } = scanRecorder();
    wallet = await openWallet(factory);
    const store = new UpdateStore(dataDir);
    await store.putUpdate("1", new Uint8Array([1, 2, 3])); // pre-existing chain link

    await wallet.sync();
    await wallet.sync();
    expect(scans).toHaveLength(2);
    expect(scans[1]!.wollet).toBe(scans[0]!.wollet); // incremental: same instance
    // The persisted scan cache is untouched by an incremental sync.
    expect(await store.listStatuses()).toContain("1");
  });
});

describe("wallet.sync({ rescan: true }) — deep re-scan from zero", () => {
  it("clears the persisted cache and cold-scans a FRESH (neverScanned) wollet", async () => {
    const { scans, factory } = scanRecorder();
    wallet = await openWallet(factory);
    const store = new UpdateStore(dataDir);

    await wallet.sync(); // warm the incremental path first
    await store.putUpdate("1", new Uint8Array([1, 2, 3]));

    const result = await wallet.sync({ rescan: true });
    expect(result).toEqual({ updated: false });
    expect(scans).toHaveLength(2);
    expect(scans[1]!.wollet).not.toBe(scans[0]!.wollet); // a virgin wollet, not the warm one
    expect(scans[1]!.neverScanned).toBe(true); // deep scan: LWK sees a never-scanned state
    // The stale persisted chain is gone; the meta was re-stamped by the scan.
    expect(await store.listStatuses()).not.toContain("1");
    const meta = await store.readMeta();
    expect(typeof meta.lastScanAt).toBe("number");
    expect(typeof meta.lastSuccessAt).toBe("number");
  });

  it("swaps the freshly scanned wollet in — subsequent syncs are incremental on it", async () => {
    const { scans, factory } = scanRecorder();
    wallet = await openWallet(factory);
    await wallet.sync();
    await wallet.sync({ rescan: true });
    await wallet.sync();
    expect(scans).toHaveLength(3);
    expect(scans[2]!.wollet).toBe(scans[1]!.wollet); // the fresh wollet took over
    expect(scans[2]!.wollet).not.toBe(scans[0]!.wollet);
  });

  it("a failed rescan surfaces ESPLORA_UNAVAILABLE and leaves the wallet usable on the old state", async () => {
    const { scans, state, factory } = scanRecorder();
    wallet = await openWallet(factory);
    await wallet.sync();

    state.fail = true;
    await expect(wallet.sync({ rescan: true })).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "ESPLORA_UNAVAILABLE")
    );

    // Old in-memory state intact: reads still work and the next incremental
    // sync drives the SAME pre-rescan wollet (no half-swapped instance).
    state.fail = false;
    const { balances } = await wallet.getBalances();
    expect(balances.DEPIX).toBe(0n);
    await wallet.sync();
    expect(scans[scans.length - 1]!.wollet).toBe(scans[0]!.wollet);
  });

  it("rescan on a closed wallet fails fast with WALLET_NOT_FOUND", async () => {
    const { factory } = scanRecorder();
    wallet = await openWallet(factory);
    await wallet.close();
    await expect(wallet.sync({ rescan: true })).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "WALLET_NOT_FOUND")
    );
  });
});

describe("wallet sync options — timeout bounds are plumbed to the sync engine", () => {
  it("honors a custom coldStartTimeoutMs — a hung deep/cold scan fails at that bound, not the 10min default", async () => {
    // A scan that never resolves: the timeout is the ONLY way out. A freshly
    // restored wallet is virgin (neverScanned), so the COLD-start bound applies —
    // with the default (600s) this would hang; a plumbed 40ms fails fast.
    // (syncTimeoutMs is plumbed through the identical path for the warm case.)
    const hangingFactory = (): EsploraClientLike => ({
      fullScan: () => new Promise<undefined>(() => {}),
      broadcast: async () => {
        throw new Error("not used");
      },
      free: () => {}
    });
    wallet = await DepixWallet.restore({
      dataDir,
      passphrase: PASSPHRASE,
      mnemonic: KNOWN_MNEMONIC,
      sync: {
        coldStartTimeoutMs: 40,
        clientFactory: hangingFactory,
        providers: [{ name: "p0", url: "http://localhost:1", waterfalls: false }]
      }
    });
    const start = Date.now();
    await expect(wallet.sync()).rejects.toThrow(/timed out after 40ms/);
    // Fired at the custom 40ms bound, NOT the 600s COLD_START default.
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
