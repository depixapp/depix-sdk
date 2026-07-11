// wallet.diagnostics() (PR-D) — a read-only health snapshot for support:
// sync-state (last scan/success, last persist failure §2.5), versions (SDK +
// pinned lwk), pending counters (reusing getPending()), dataDir and
// backupConfirmed, plus the guardrail usage readout. The fund-safety rule of
// getPending() applies verbatim: NEVER any key material — no seed, mnemonic,
// passphrase or descriptor in the snapshot.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DepixWallet } from "../src/wallet.js";
import { descriptorFromMnemonic } from "../src/engine/lwk.js";
import type { EsploraClientLike } from "../src/sync/sync.js";
import { PendingWithdrawals } from "../src/pending.js";
import { SideShiftStore, type StoredSideShift } from "../src/convert/sideshift-store.js";
import { isDepixSdkError } from "../src/errors.js";

const PASSPHRASE = "correct-horse-battery-staple";
const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

let dataDir: string;
let wallet: DepixWallet;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-diag-"));
});
afterEach(async () => {
  await wallet?.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
});

const fakeClient = (): EsploraClientLike => ({
  fullScan: async () => undefined,
  broadcast: async () => {
    throw new Error("not used");
  },
  free: () => {}
});

async function restore(extra: Record<string, unknown> = {}): Promise<DepixWallet> {
  return DepixWallet.restore({
    dataDir,
    passphrase: PASSPHRASE,
    mnemonic: KNOWN_MNEMONIC,
    sync: {
      clientFactory: fakeClient,
      providers: [{ name: "p0", url: "http://localhost:1", waterfalls: false }]
    },
    ...extra
  });
}

async function packageManifest(): Promise<{ version: string; dependencies: Record<string, string> }> {
  return JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
}

describe("wallet.diagnostics() — the support snapshot", () => {
  it("reports versions, dataDir, backup state and a zeroed sync/pending baseline", async () => {
    wallet = await restore();
    const diag = await wallet.diagnostics();
    const pkg = await packageManifest();

    expect(diag.sdkVersion).toBe(pkg.version);
    expect(diag.lwkVersion).toBe(pkg.dependencies.lwk_node);
    expect(diag.dataDir).toBe(dataDir);
    expect(diag.backupConfirmed).toBe(true); // restore() is born confirmed
    expect(diag.hasSeed).toBe(true);
    expect(diag.apiKeyConfigured).toBe(false);
    expect(diag.sync).toEqual({
      lastScanAt: null,
      lastSuccessAt: null,
      lastPersistFailedAt: null,
      lastPersistErrorName: null,
      persistedUpdates: 0,
      walletLoaded: false
    });
    expect(diag.pending).toEqual({
      withdrawals: 0,
      boltzSwaps: 0,
      pegins: 0,
      sideshiftShifts: 0,
      plans: 0
    });
    expect(diag.guardrails).toEqual(await wallet.getGuardrails());
  });

  it("reflects sync state after a sync (lastScanAt/lastSuccessAt stamped, wollet loaded)", async () => {
    wallet = await restore();
    await wallet.sync();
    const diag = await wallet.diagnostics();
    expect(diag.sync.lastScanAt).toEqual(expect.any(Number));
    expect(diag.sync.lastSuccessAt).toEqual(expect.any(Number));
    expect(diag.sync.lastPersistFailedAt).toBeNull();
    expect(diag.sync.lastPersistErrorName).toBeNull();
    expect(diag.sync.walletLoaded).toBe(true);
  });

  it("counts pending items per rail via the same stores as getPending()", async () => {
    wallet = await restore({
      resumePendingWithdrawalsOnOpen: false,
      resumePendingConversionsOnOpen: false
    });
    const salt = JSON.parse(await readFile(join(dataDir, "wallet.json"), "utf8")).salt as string;
    await new PendingWithdrawals({ dataDir, passphrase: PASSPHRASE, saltB64: salt }).putRequested({
      idempotencyKey: "idem-1",
      request: { pixKey: "k", taxNumber: "t", depositAmountInCents: 500 }
    });
    const shift: StoredSideShift = {
      id: "sh_1",
      type: "send",
      asset: "USDT",
      network: "tron",
      depositAddress: "lq1qdeposit",
      settleAddress: "T" + "x".repeat(33),
      refundAddress: null,
      status: "waiting",
      createdAt: 1_720_000_000_000,
      updatedAt: 1_720_000_000_000
    };
    await new SideShiftStore({ dataDir }).save(shift);

    const diag = await wallet.diagnostics();
    expect(diag.pending).toEqual({
      withdrawals: 1,
      boltzSwaps: 0,
      pegins: 0,
      sideshiftShifts: 1,
      plans: 0
    });
  });

  it("NEVER leaks key material — no mnemonic word, passphrase or descriptor", async () => {
    wallet = await restore();
    const diag = await wallet.diagnostics();
    const flat = JSON.stringify(diag);
    expect(flat).not.toContain("abandon"); // any mnemonic word
    expect(flat).not.toContain(PASSPHRASE);
    expect(flat).not.toContain(descriptorFromMnemonic(KNOWN_MNEMONIC));
    expect(flat).not.toContain("slip77"); // the confidential descriptor's blinding-key marker
    expect(flat.toLowerCase()).not.toContain("mnemonic");
    expect(flat.toLowerCase()).not.toContain("xprv");
  });

  it("works on a view-only (wiped) wallet — hasSeed false, snapshot still complete", async () => {
    wallet = await restore();
    await wallet.wipe();
    await wallet.close();
    wallet = await DepixWallet.open({ dataDir });
    const diag = await wallet.diagnostics();
    expect(diag.hasSeed).toBe(false);
    expect(diag.dataDir).toBe(dataDir);
    expect(diag.pending).toEqual({
      withdrawals: 0,
      boltzSwaps: 0,
      pegins: 0,
      sideshiftShifts: 0,
      plans: 0
    });
  });

  it("fails fast with WALLET_NOT_FOUND on a closed wallet", async () => {
    wallet = await restore();
    await wallet.close();
    await expect(wallet.diagnostics()).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "WALLET_NOT_FOUND")
    );
  });
});
