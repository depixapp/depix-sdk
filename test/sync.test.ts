// Sync engine (spec §2.6/§2.7): waterfalls→vanilla provider chain with
// lastGoodProviderIndex rotation, ESPLORA_UNAVAILABLE only when ALL providers
// fail, fullScan in a worker_thread by default, single in-flight dedup.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
