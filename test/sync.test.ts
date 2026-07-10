// Sync engine (spec §2.6/§2.7): waterfalls→vanilla provider chain with
// lastGoodProviderIndex rotation, ESPLORA_UNAVAILABLE only when ALL providers
// fail, fullScan in a worker_thread by default, single in-flight dedup.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ESPLORA_PROVIDERS,
  SyncEngine,
  type EsploraClientLike
} from "../src/sync/sync.js";
import { UpdateStore } from "../src/store/update-store.js";
import { buildWollet, descriptorFromMnemonic, generateMnemonic } from "../src/engine/lwk.js";
import { isDepixSdkError } from "../src/errors.js";
import type { Wollet } from "lwk_node";

const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// A real, small Liquid mainnet tx hex (public), parseable by Transaction.fromString.
const FIXTURE_TXID = "21cb9e1fd71f5d9e9d9f5843f14f912ffd2f023b089fd0b78f2718fcdde52f33";
const FIXTURE_HEX =
  "0200000001010000000000000000000000000000000000000000000000000000000000000000ffffffff060365843c0101ffffffff03016d521c38ec1ea15734ae22b7c46064412829c0d0579f0a713d1c04ede979026f01000000000000000000266a240a8ce26f7f113667dccb98522fb9c292911d81ec200d31adc94501000000000000000000016d521c38ec1ea15734ae22b7c46064412829c0d0579f0a713d1c04ede979026f01000000000000010d001976a914fc26751a5025129a2fd006c6fbfa598ddd67f7e188ac016d521c38ec1ea15734ae22b7c46064412829c0d0579f0a713d1c04ede979026f01000000000000000000266a24aa21a9ed8fbc0adfe56fb749b2640b7b9131e42c6043588725c997c70c3658eea333f1510000000000000120000000000000000000000000000000000000000000000000000000000000000000000000000000";

let dataDir: string;
let wollet: Wollet;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-sync-"));
  wollet = buildWollet(descriptorFromMnemonic(KNOWN_MNEMONIC));
});

afterEach(async () => {
  wollet.free();
  await rm(dataDir, { recursive: true, force: true });
});

function makeEngine(opts: {
  factory?: (provider: { name: string }) => EsploraClientLike;
  providers?: { name: string; url: string; waterfalls: boolean }[];
}): SyncEngine {
  return new SyncEngine({
    descriptor: descriptorFromMnemonic(KNOWN_MNEMONIC),
    dataDir,
    updateStore: new UpdateStore(dataDir),
    providers: opts.providers ?? [
      { name: "p0", url: "http://localhost:1", waterfalls: true },
      { name: "p1", url: "http://localhost:1", waterfalls: false }
    ],
    worker: false,
    clientFactory: opts.factory,
    syncTimeoutMs: 5_000
  });
}

describe("provider chain (spec §2.6)", () => {
  it("default chain is waterfalls→vanilla on api.depixapp.com (canonical base)", () => {
    expect(DEFAULT_ESPLORA_PROVIDERS).toEqual([
      {
        name: "depix-proxy-waterfalls",
        url: "https://api.depixapp.com/api/esplora",
        waterfalls: true
      },
      {
        name: "depix-proxy-esplora",
        url: "https://api.depixapp.com/api/esplora",
        waterfalls: false
      }
    ]);
  });

  it("falls through to the next provider and pins lastGoodProviderIndex", async () => {
    const calls: string[] = [];
    const factory = (provider: { name: string }): EsploraClientLike => ({
      fullScan: async () => {
        calls.push(provider.name);
        if (provider.name === "p0") throw new Error("waterfalls tip flake (404)");
        return undefined; // successful scan, no changes
      },
      broadcast: async () => {
        throw new Error("not used");
      },
      free: () => {}
    });
    const engine = makeEngine({ factory });
    await engine.sync(wollet);
    expect(calls).toEqual(["p0", "p1"]);
    // Next sync starts at the last good provider (p1) — no retry of p0.
    calls.length = 0;
    await engine.sync(wollet);
    expect(calls).toEqual(["p1"]);
  });

  it("throws ESPLORA_UNAVAILABLE only when ALL providers fail", async () => {
    const factory = (): EsploraClientLike => ({
      fullScan: async () => {
        throw new Error("boom");
      },
      broadcast: async () => {
        throw new Error("not used");
      },
      free: () => {}
    });
    const engine = makeEngine({ factory });
    await expect(engine.sync(wollet)).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "ESPLORA_UNAVAILABLE")
    );
  });

  it("dedups concurrent sync calls into one in-flight scan", async () => {
    let scans = 0;
    const factory = (): EsploraClientLike => ({
      fullScan: async () => {
        scans++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return undefined;
      },
      broadcast: async () => {
        throw new Error("not used");
      },
      free: () => {}
    });
    const engine = makeEngine({ factory });
    await Promise.all([engine.sync(wollet), engine.sync(wollet), engine.sync(wollet)]);
    expect(scans).toBe(1);
  });
});

describe("inline scan timeout (spec §2.7 — withTimeout cannot cancel the wasm scan)", () => {
  it("a late-resolving inline scan is NOT applied — the timeout wins and its result is ignored", async () => {
    let lateResolved = 0;
    const factory = (): EsploraClientLike => ({
      // Resolves AFTER the sync timeout: withTimeout rejects first, so this
      // late result must never be applied to the Wollet the caller left idle.
      fullScan: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            lateResolved++;
            resolve(undefined);
          }, 80);
        }),
      broadcast: async () => {
        throw new Error("not used");
      },
      free: () => {}
    });
    const engine = new SyncEngine({
      descriptor: descriptorFromMnemonic(KNOWN_MNEMONIC),
      dataDir,
      updateStore: new UpdateStore(dataDir),
      providers: [
        { name: "p0", url: "http://localhost:1", waterfalls: true },
        { name: "p1", url: "http://localhost:1", waterfalls: false }
      ],
      worker: false,
      clientFactory: factory,
      // A fresh wollet is neverScanned() → cold timeout applies; pin both small.
      syncTimeoutMs: 10,
      coldStartTimeoutMs: 10
    });
    await expect(engine.sync(wollet)).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "ESPLORA_UNAVAILABLE")
    );
    // Let the abandoned scans settle late; nothing must have been applied.
    await new Promise((r) => setTimeout(r, 130));
    expect(lateResolved).toBeGreaterThanOrEqual(1); // the scan really did resolve late
    expect(wollet.neverScanned()).toBe(true); // no late update reached the Wollet
  });
});

describe("broadcast chain (spec §3.2.6 parity)", () => {
  it("rotates providers and fails with BROADCAST_FAILED only when all refuse", async () => {
    const attempts: string[] = [];
    const factory = (provider: { name: string }): EsploraClientLike => ({
      fullScan: async () => undefined,
      broadcast: async () => {
        attempts.push(provider.name);
        throw new Error("rejected");
      },
      free: () => {}
    });
    const engine = makeEngine({ factory });
    await expect(engine.broadcast({} as never)).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "BROADCAST_FAILED")
    );
    expect(attempts).toEqual(["p0", "p1"]);
  });

  it("returns the txid from the first provider that accepts", async () => {
    const factory = (provider: { name: string }): EsploraClientLike => ({
      fullScan: async () => undefined,
      broadcast: async () => {
        if (provider.name === "p0") throw new Error("rejected");
        return "aa".repeat(32);
      },
      free: () => {}
    });
    const engine = makeEngine({ factory });
    const txid = await engine.broadcast({} as never);
    expect(txid).toBe("aa".repeat(32));
  });
});

describe("broadcastRawTx returns the locally-derived txid (spec §3.2.9 resume)", () => {
  it("returns localTxid even when broadcastTx resolves a non-string Txid object", async () => {
    // The real lwk_node EsploraClient.broadcastTx resolves a Txid object, not a
    // string — the result must derive from the tx bytes, never from the wasm
    // Txid.toString() shape (which is telemetry-only, §3.2.7).
    const engine = makeEngine({
      factory: () => ({
        fullScan: async () => undefined,
        broadcast: async () => {
          throw new Error("not used");
        },
        broadcastTx: async () => ({ toString: () => "not-the-real-txid" }),
        free: () => {}
      })
    });
    const txid = await engine.broadcastRawTx(FIXTURE_HEX);
    expect(txid).toBe(FIXTURE_TXID);
  });
});

// Live integration — REAL Esplora mainnet sync of a freshly-generated (empty)
// wallet through the default provider chain, exercising the worker_thread
// path (§2.7). Read-only: nothing is broadcast, no funds involved.
// Opt out with DEPIX_SDK_OFFLINE=1.
describe.skipIf(process.env.DEPIX_SDK_OFFLINE === "1")("mainnet integration (read-only)", () => {
  it("fullScan of a fresh wallet syncs empty via the default chain, in a worker", async () => {
    const mnemonic = generateMnemonic();
    const descriptor = descriptorFromMnemonic(mnemonic);
    const freshWollet = buildWollet(descriptor);
    const engine = new SyncEngine({
      descriptor,
      dataDir,
      updateStore: new UpdateStore(dataDir),
      worker: true
    });
    try {
      expect(freshWollet.neverScanned()).toBe(true);
      await engine.sync(freshWollet);
      expect(freshWollet.neverScanned()).toBe(false);
      // Empty wallet: no transactions.
      expect(freshWollet.transactions().length).toBe(0);
      const meta = await new UpdateStore(dataDir).readMeta();
      expect(typeof meta.lastScanAt).toBe("number");
    } finally {
      freshWollet.free();
    }
  }, 120_000);
});

describe("provider fallback with mocked fetch (real EsploraClient, inline mode)", () => {
  it("walks the whole chain at the network layer and surfaces ESPLORA_UNAVAILABLE", async () => {
    const realFetch = globalThis.fetch;
    const seenUrls: string[] = [];
    // The lwk_node wasm glue resolves HTTP through the global fetch — stub it
    // so every provider fails at the network layer, no sockets involved.
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      seenUrls.push(String(input instanceof Request ? input.url : input));
      throw new Error("network down (mocked fetch)");
    }) as typeof fetch;
    try {
      const engine = new SyncEngine({
        descriptor: descriptorFromMnemonic(KNOWN_MNEMONIC),
        dataDir,
        updateStore: new UpdateStore(dataDir),
        worker: false, // inline: the scan runs in-thread where fetch is stubbed
        syncTimeoutMs: 10_000
      });
      await expect(engine.sync(wollet)).rejects.toSatisfy((err: unknown) =>
        isDepixSdkError(err, "ESPLORA_UNAVAILABLE")
      );
      // Both default providers were attempted against the canonical base.
      expect(seenUrls.length).toBeGreaterThanOrEqual(2);
      expect(seenUrls.every((url) => url.includes("api.depixapp.com/api/esplora"))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
