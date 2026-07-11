// wallet.advanced.* (PR-D) — the power-user surface: the SAME provider
// namespace instances that back wallet.convert()/wallet.quote(), re-exposed
// under one dedicated namespace for fine-grained control (quote streams,
// pegStatus, manual resume, refunds…). Backward-compat is load-bearing: the
// legacy wallet.convert.{sideswap,boltz,sideshift} getters keep working
// (deprecated in docs, never removed in 1.x).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DepixWallet } from "../src/wallet.js";
import { isDepixSdkError } from "../src/errors.js";

const PASSPHRASE = "correct-horse-battery-staple";
const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

let dataDir: string;
let wallet: DepixWallet;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-advanced-"));
});
afterEach(async () => {
  await wallet?.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
});

async function restore(): Promise<DepixWallet> {
  return DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC });
}

describe("wallet.advanced points at the SAME provider instances as wallet.convert", () => {
  it("advanced.{sideswap,sideshift,boltz} are reference-identical to the legacy getters", async () => {
    wallet = await restore();
    expect(wallet.advanced.sideswap).toBe(wallet.convert.sideswap);
    expect(wallet.advanced.sideshift).toBe(wallet.convert.sideshift);
    expect(wallet.advanced.boltz).toBe(wallet.convert.boltz);
  });

  it("carries the fine-grained provider methods (quote-stream, pegStatus, manual resume…)", async () => {
    wallet = await restore();
    expect(typeof wallet.advanced.sideswap.quote).toBe("function");
    expect(typeof wallet.advanced.sideswap.pegIn).toBe("function");
    expect(typeof wallet.advanced.sideswap.pegOut).toBe("function");
    expect(typeof wallet.advanced.sideswap.pegStatus).toBe("function");
    expect(typeof wallet.advanced.boltz.resume).toBe("function");
    expect(typeof wallet.advanced.boltz.payLightningInvoice).toBe("function");
    expect(typeof wallet.advanced.sideshift.getStatus).toBe("function");
    expect(typeof wallet.advanced.sideshift.listShifts).toBe("function");
  });

  it("legacy wallet.convert surface is untouched: callable facade + working sub-getters", async () => {
    wallet = await restore();
    expect(typeof wallet.convert).toBe("function"); // the intent facade stays callable
    expect(typeof wallet.convert.sideswap.quote).toBe("function");
    expect(typeof wallet.convert.sideshift.getStatus).toBe("function");
    expect(typeof wallet.convert.boltz.resume).toBe("function");
  });

  it("getters are non-enumerable — spreading/serializing never trips the boltz view-only gate", async () => {
    wallet = await restore();
    expect(Object.keys(wallet.advanced)).toEqual([]);
    expect(() => ({ ...wallet.advanced })).not.toThrow();
  });

  it("advanced.boltz preserves the view-only WALLET_NOT_FOUND gate verbatim", async () => {
    wallet = await restore();
    await wallet.wipe();
    await wallet.close();
    // Reopen the wiped dataDir: view-only — no seed, no Boltz rail.
    wallet = await DepixWallet.open({ dataDir });
    expect(() => wallet.advanced.boltz).toThrow();
    try {
      void wallet.advanced.boltz;
      expect.unreachable("advanced.boltz must throw on a view-only wallet");
    } catch (err) {
      expect(isDepixSdkError(err, "WALLET_NOT_FOUND")).toBe(true);
    }
    // The always-available namespaces stay reachable on a view-only wallet.
    expect(wallet.advanced.sideswap).toBe(wallet.convert.sideswap);
    expect(wallet.advanced.sideshift).toBe(wallet.convert.sideshift);
  });
});
