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
import { SCAN_HINT_MAX, UpdateStore } from "../src/store/update-store.js";
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

describe("rescan() vs a concurrent plain sync() — the 'joins this pass' guarantee (PR-D)", () => {
  async function waitUntil(cond: () => boolean, what: string, ms = 5_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  const settleTicks = () => new Promise((resolve) => setTimeout(resolve, 25));

  it("drains the in-flight stale scan FIRST, then a sync() during the rescan pass JOINS it — the stale wollet is never re-scanned", async () => {
    // Deferred-controlled fullScan: each call records its target Wollet and
    // resolves only when the test releases it.
    const scans: Array<{ wollet: Wollet; release: () => void }> = [];
    const factory = (): EsploraClientLike => ({
      fullScan: (w: Wollet) =>
        new Promise((resolve) => {
          scans.push({ wollet: w, release: () => resolve(undefined) });
        }),
      broadcast: async () => {
        throw new Error("not used");
      },
      free: () => {}
    });
    const engine = makeEngine({ factory });
    const fresh = buildWollet(descriptorFromMnemonic(KNOWN_MNEMONIC));
    try {
      // 1. A stale-wollet scan is in flight.
      const stalePass = engine.sync(wollet);
      await waitUntil(() => scans.length === 1, "the stale scan to start");
      expect(scans[0]!.wollet).toBe(wollet);

      // 2. rescan() must NOT run beforeScan (the cache drop) while the stale
      //    scan could still persist across it — it drains the pass first.
      let beforeScanRan = 0;
      const rescanPass = engine.rescan(fresh, async () => {
        beforeScanRan++;
      });
      await settleTicks();
      expect(beforeScanRan).toBe(0); // still draining — the clear has not run
      expect(scans).toHaveLength(1); // and no second scan started either

      // 3. Release the stale scan: the rescan pass claims the slot, runs
      //    beforeScan, and cold-scans the FRESH (virgin) wollet.
      scans[0]!.release();
      await waitUntil(() => scans.length === 2, "the rescan's own scan to start");
      expect(beforeScanRan).toBe(1);
      expect(scans[1]!.wollet).toBe(fresh);

      // 4. THE RACE UNDER TEST: a plain sync() issued while the rescan pass is
      //    in flight must JOIN that pass instead of starting a new scan of the
      //    stale wollet (which would race the cache clear and could persist an
      //    orphan chain link).
      const joined = engine.sync(wollet);
      expect(engine.sync(wollet)).toBe(joined); // joiners share ONE in-flight pass
      await settleTicks();
      expect(scans).toHaveLength(2); // no third fullScan — nothing re-scanned the stale wollet

      // 5. Release the rescan; every caller settles on the SAME pass's result.
      scans[1]!.release();
      const [staleResult, rescanResult, joinedResult] = await Promise.all([stalePass, rescanPass, joined]);
      expect(staleResult).toEqual({ updated: false });
      expect(rescanResult).toEqual({ updated: false });
      expect(joinedResult).toEqual({ updated: false });
      // Final tally: the stale wollet was scanned EXACTLY once (before the
      // rescan), the fresh wollet exactly once — never interleaved.
      expect(scans.map((s) => s.wollet)).toEqual([wollet, fresh]);
    } finally {
      fresh.free();
    }
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

// Coverage floor for degraded scans (frontend cba130f parity). A vanilla
// (waterfalls:false) fallback truncates at gap_limit=20; during a waterfalls
// outage a from-zero scan therefore misses high-derivation-index history and
// rebuilds a WRONG balance. The floor (meta.scanToIndexHint — the deepest
// next-unused external index a successful scan proved) is replayed on the
// degraded path via client.fullScanToIndex so a truncated walk can never
// miss history below proven coverage.
describe("degraded-scan coverage floor (fullScanToIndex replay)", () => {
  // Real Wollets in this suite are virgin (next-unused index 0 — never records
  // a floor), so the hint paths are driven through a minimal fake exposing the
  // only surface the engine touches on a no-update scan.
  function fakeWollet(opts: { neverScanned?: boolean; nextUnusedIndex?: number } = {}): Wollet {
    return {
      neverScanned: () => opts.neverScanned ?? false,
      address: () => ({ index: () => opts.nextUnusedIndex ?? 0, free: () => {} }),
      status: () => ({ toString: () => "0" }),
      applyUpdate: () => {
        throw new Error("not used — fakes return no Update");
      },
      free: () => {}
    } as unknown as Wollet;
  }

  type ScanCall = { provider: string; kind: "fullScan" | "fullScanToIndex"; index?: number };

  function recordingFactory(
    calls: ScanCall[],
    opts: { withToIndex?: boolean; delayMs?: number } = {}
  ): (provider: { name: string }) => EsploraClientLike {
    const settle = async (): Promise<undefined> => {
      if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      return undefined;
    };
    return (provider) => ({
      fullScan: async () => {
        calls.push({ provider: provider.name, kind: "fullScan" });
        return settle();
      },
      ...(opts.withToIndex === false
        ? {}
        : {
            fullScanToIndex: async (_w: Wollet, index: number) => {
              calls.push({ provider: provider.name, kind: "fullScanToIndex", index });
              return settle();
            }
          }),
      broadcast: async () => {
        throw new Error("not used");
      },
      free: () => {}
    });
  }

  const DEGRADED_ONLY = [{ name: "p-vanilla", url: "http://localhost:1", waterfalls: false }];
  const WATERFALLS_ONLY = [{ name: "p-wf", url: "http://localhost:1", waterfalls: true }];

  it("replays the stored floor on the degraded vanilla provider via fullScanToIndex", async () => {
    await new UpdateStore(dataDir).bumpScanHint(240);
    const calls: ScanCall[] = [];
    const engine = makeEngine({ factory: recordingFactory(calls), providers: DEGRADED_ONLY });
    await engine.sync(fakeWollet());
    expect(calls).toEqual([{ provider: "p-vanilla", kind: "fullScanToIndex", index: 240 }]);
  });

  it("never uses fullScanToIndex on the full-coverage waterfalls provider", async () => {
    await new UpdateStore(dataDir).bumpScanHint(240);
    const calls: ScanCall[] = [];
    const engine = makeEngine({ factory: recordingFactory(calls), providers: WATERFALLS_ONLY });
    await engine.sync(fakeWollet());
    expect(calls).toEqual([{ provider: "p-wf", kind: "fullScan" }]);
  });

  it("without a stored floor the degraded path stays a plain gap-limit fullScan", async () => {
    const calls: ScanCall[] = [];
    const engine = makeEngine({ factory: recordingFactory(calls), providers: DEGRADED_ONLY });
    await engine.sync(fakeWollet());
    expect(calls).toEqual([{ provider: "p-vanilla", kind: "fullScan" }]);
  });

  it("a client without fullScanToIndex falls back to plain fullScan (injected doubles keep working)", async () => {
    await new UpdateStore(dataDir).bumpScanHint(240);
    const calls: ScanCall[] = [];
    const engine = makeEngine({
      factory: recordingFactory(calls, { withToIndex: false }),
      providers: DEGRADED_ONLY
    });
    await engine.sync(fakeWollet());
    expect(calls).toEqual([{ provider: "p-vanilla", kind: "fullScan" }]);
  });

  it("a corrupt oversized stored floor is clamped to SCAN_HINT_MAX on read", async () => {
    // writeMeta is a raw merge — this simulates a poisoned meta.json, which the
    // READ path must clamp (a permanent oversized floor would turn every
    // degraded scan into a guaranteed timeout).
    await new UpdateStore(dataDir).writeMeta({ scanToIndexHint: SCAN_HINT_MAX * 7 });
    const calls: ScanCall[] = [];
    const engine = makeEngine({ factory: recordingFactory(calls), providers: DEGRADED_ONLY });
    await engine.sync(fakeWollet());
    expect(calls).toEqual([
      { provider: "p-vanilla", kind: "fullScanToIndex", index: SCAN_HINT_MAX }
    ]);
  });

  it("every successful scan records the next-unused index as a MONOTONE floor", async () => {
    const store = new UpdateStore(dataDir);
    const calls: ScanCall[] = [];
    const engine = makeEngine({ factory: recordingFactory(calls), providers: WATERFALLS_ONLY });
    await engine.sync(fakeWollet({ nextUnusedIndex: 42 }));
    expect(await store.readScanHint()).toBe(42);
    // A shallower view (e.g. a later truncated scan) can never lower the floor.
    await engine.sync(fakeWollet({ nextUnusedIndex: 17 }));
    expect(await store.readScanHint()).toBe(42);
  });

  it("a hint-driven degraded scan gets the COLD budget — the warm budget would time out exactly the wallets the floor protects", async () => {
    const calls: ScanCall[] = [];
    // Scan takes 120ms: beyond the 30ms warm budget, within the 5s cold one.
    const factory = recordingFactory(calls, { delayMs: 120 });
    const makeSlow = (): SyncEngine =>
      new SyncEngine({
        descriptor: descriptorFromMnemonic(KNOWN_MNEMONIC),
        dataDir,
        updateStore: new UpdateStore(dataDir),
        providers: DEGRADED_ONLY,
        worker: false,
        clientFactory: factory,
        syncTimeoutMs: 30,
        coldStartTimeoutMs: 5_000
      });
    // Control: no floor → warm budget → the slow scan times out.
    await expect(makeSlow().sync(fakeWollet())).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "ESPLORA_UNAVAILABLE")
    );
    // With a floor the SAME slow scan succeeds under the cold budget.
    await new UpdateStore(dataDir).bumpScanHint(240);
    await expect(makeSlow().sync(fakeWollet())).resolves.toEqual({ updated: false });
    expect(calls.map((c) => c.kind)).toEqual(["fullScan", "fullScanToIndex"]);
  });
});

// Timed-out inline scans keep running inside wasm (Promise.race cannot cancel
// them). Freeing the EsploraClient — or the Wollet the zombie still borrows —
// while it runs is the "null pointer passed to rust" crash class. Real clients
// therefore get their free deferred to the zombie's settle, and
// drainAbandonedScans() lets owners wait before freeing the wollet.
describe("abandoned inline scans (real clients): deferred free + drain", () => {
  it("drainAbandonedScans waits for the zombie to settle; the wollet is safe to free afterwards", async () => {
    const realFetch = globalThis.fetch;
    const held: Array<(reason: unknown) => void> = [];
    let released = false;
    globalThis.fetch = (async () => {
      if (released) throw new Error("released (mocked fetch)");
      return new Promise<never>((_resolve, reject) => {
        held.push(reject);
      });
    }) as typeof fetch;
    try {
      const engine = new SyncEngine({
        descriptor: descriptorFromMnemonic(KNOWN_MNEMONIC),
        dataDir,
        updateStore: new UpdateStore(dataDir),
        providers: [{ name: "p0", url: "http://localhost:1", waterfalls: true }],
        worker: false, // inline: the real wasm client runs in-thread on stubbed fetch
        syncTimeoutMs: 40,
        coldStartTimeoutMs: 40
      });
      await expect(engine.sync(wollet)).rejects.toSatisfy((err: unknown) =>
        isDepixSdkError(err, "ESPLORA_UNAVAILABLE")
      );
      // The timed-out wasm scan is still running on the held fetch. Release it
      // so the zombie settles, then drain — after this, freeing the wollet
      // (afterEach) must not hit freed-client/wollet memory.
      released = true;
      for (const reject of held) reject(new Error("released (mocked fetch)"));
      await engine.drainAbandonedScans();
      expect(wollet.neverScanned()).toBe(true); // the zombie's failure applied nothing
    } finally {
      globalThis.fetch = realFetch;
    }
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
