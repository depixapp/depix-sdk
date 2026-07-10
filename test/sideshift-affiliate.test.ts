// The SideShift affiliate id is BAKED AT BUILD (spec §5.4) — the committed source
// reads process.env for dev/test (SIDESHIFT_AFFILIATE_ID=test-affiliate, wired in
// package.json); the published dist has the literal baked in by
// scripts/bake-affiliate.mjs (no runtime env read). These assertions are robust
// whether or not the env is set, so the suite never flakes on it.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Wollet } from "lwk_node";
import { isDepixSdkError } from "../src/errors.js";
import type { ConvertWalletHooks } from "../src/convert/hooks.js";
import { SIDESHIFT_AFFILIATE_ID } from "../src/convert/sideshift-affiliate.js";
import { SideShiftNamespace } from "../src/convert/sideshift.js";
import { SideShiftStore } from "../src/convert/sideshift-store.js";

const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

function hooksFor(dataDir: string): ConvertWalletHooks {
  return {
    dataDir,
    logger: SILENT,
    ensureWollet: async () => ({}) as unknown as Wollet,
    getReceiveAddress: async () => "lq1qmyreceive",
    decryptMnemonic: async () => {
      throw new Error("unused");
    },
    valuate: async () => 1_000,
    enforceGuardrails: async () => {},
    recordSpend: async () => {},
    runExclusive: (fn) => fn(),
    broadcast: async () => "unused",
    assertOpen: () => {},
    now: () => 0
  };
}

describe("SIDESHIFT_AFFILIATE_ID — baked from the env at module load", () => {
  it("equals process.env.SIDESHIFT_AFFILIATE_ID (or empty when unset)", () => {
    expect(SIDESHIFT_AFFILIATE_ID).toBe(process.env.SIDESHIFT_AFFILIATE_ID ?? "");
  });
});

describe("the namespace defaults to the baked affiliate id", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-affiliate-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("throws AFFILIATE_ID_MISSING iff the baked constant is empty (no injection)", async () => {
    const store = new SideShiftStore({ dataDir, logger: SILENT });
    // No affiliateId injected → the namespace uses the baked SIDESHIFT_AFFILIATE_ID.
    const ns = new SideShiftNamespace({
      hooks: hooksFor(dataDir),
      store,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ id: "q1" })
      })
    });
    if (SIDESHIFT_AFFILIATE_ID) {
      // Env set (e.g. `npm test` → test-affiliate): a quote goes through.
      await expect(ns.quote({ network: "tron", amountSats: 1n })).resolves.toMatchObject({ custodial: true });
    } else {
      // Env unset: mirrors the frontend's "SideShift is not configured" throw.
      await expect(ns.quote({ network: "tron", amountSats: 1n })).rejects.toSatisfy((e) =>
        isDepixSdkError(e, "AFFILIATE_ID_MISSING")
      );
    }
  });
});
