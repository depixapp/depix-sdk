// Unified crash recovery over EVERY rail (fund-safety wiring): open()
// auto-resumes conversions (Boltz / peg-in / SideShift) alongside withdrawals,
// wallet.recover() re-drives all rails mid-session, and wallet.getPending()
// gives one read-only view over the four durable stores. This suite covers the
// WIRING — the per-rail refund/claim logic is proven by its own suites
// (boltz-refund/boltz-convert/pending/sideswap-peg/sideshift-*).
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DepixWallet } from "../src/wallet.js";
import { BoltzConvert, type BoltzResumeSummary } from "../src/convert/boltz/convert.js";
import {
  BoltzSwapStore,
  type StoredReverseSwap,
  type StoredStablecoinSwap,
  type StoredSubmarineSwap
} from "../src/convert/boltz/store.js";
import { PendingPegIn, PENDING_PEGIN_FILE } from "../src/convert/pending-pegin.js";
import { SideShiftStore, type StoredSideShift } from "../src/convert/sideshift-store.js";
import { PendingWithdrawals } from "../src/pending.js";
import type { FetchLike, FetchResponseLike } from "../src/api/client.js";
import { FakeSideSwapClient } from "./support/sideswap-mock.js";

const PASSPHRASE = "correct-horse-battery-staple";
const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const EMPTY_BOLTZ: BoltzResumeSummary = {
  submarineResumed: 0,
  submarineRefunded: 0,
  reverseResumed: 0,
  stablecoinResumed: 0,
  stablecoinRefunded: 0,
  discarded: 0,
  removed: 0,
  failed: 0
};

let dataDir: string;
const openedWallets: DepixWallet[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-recovery-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const w of openedWallets.splice(0)) {
    await w.close().catch(() => {});
  }
  await rm(dataDir, { recursive: true, force: true });
});

function track<T extends DepixWallet>(wallet: T): T {
  openedWallets.push(wallet);
  return wallet;
}

/** Create wallet.json (and its salt) without auto-resume side effects. */
async function seedWalletFile(): Promise<string> {
  const w = await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC });
  await w.close();
  return saltOf();
}

async function saltOf(): Promise<string> {
  return JSON.parse(await readFile(join(dataDir, "wallet.json"), "utf8")).salt as string;
}

/** Minimal SideShift REST fake: GET /shifts/:id returns the scripted status. */
function shiftStatusFetch(status: string): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    const body = { id: url.split("/").pop(), status, settleAmount: "9.9", depositAmount: "10" };
    const res: FetchResponseLike = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body)
    };
    return res;
  };
  return { fetchImpl, calls };
}

function storedShift(id: string, status: string): StoredSideShift {
  return {
    id,
    type: "send",
    asset: "USDT",
    network: "tron",
    depositAddress: "lq1qdeposit",
    settleAddress: "T" + "x".repeat(33),
    refundAddress: null,
    status,
    createdAt: 1_720_000_000_000,
    updatedAt: 1_720_000_000_000
  };
}

function storedSubmarine(swapId: string): StoredSubmarineSwap {
  return {
    type: "submarine",
    swapId,
    invoice: "lnbc1...",
    lockupAddress: "lq1qlockup",
    expectedAmountSats: 90_000,
    invoiceSats: 89_000,
    swapTree: {},
    claimPublicKey: "02" + "b".repeat(64),
    timeoutBlockHeight: 3_100_000,
    refundPrivateKeyHex: "c".repeat(64),
    refundPublicKeyHex: "02" + "d".repeat(64),
    state: "locked_up",
    createdAt: 1_720_000_000_000
  };
}

// Sentinel secrets (distinct 64-hex values) so the no-leak assertions can prove
// each rail's key material stays out of the read-only view.
const REVERSE_PREIMAGE_HEX = "b1".repeat(32);
const REVERSE_CLAIM_PRIV_HEX = "b2".repeat(32);
const STABLECOIN_REFUND_PRIV_HEX = "e1".repeat(32);
const STABLECOIN_EVM_PRIV_HEX = "e2".repeat(32);
const STABLECOIN_PREIMAGE_HEX = "e3".repeat(32);

/** A stored reverse (LN RECEIVE) swap — carries a claim key + preimage. */
function storedReverse(swapId: string): StoredReverseSwap {
  return {
    type: "reverse",
    swapId,
    invoice: "lnbc1...",
    lockupAddress: "lq1qrevlockup",
    onchainAmount: 200_000,
    swapTree: {},
    refundPublicKey: "03" + "cc".repeat(32),
    timeoutBlockHeight: 3_100_000,
    claimAddress: "lq1qclaim",
    preimageHex: REVERSE_PREIMAGE_HEX,
    claimPublicKeyHex: "02" + "ab".repeat(32),
    claimPrivateKeyHex: REVERSE_CLAIM_PRIV_HEX,
    state: "awaiting_payment",
    createdAt: 1_720_000_000_000
  };
}

/** A stored stablecoin (L-BTC -> USDT) swap — carries a refund key, EVM key + preimage. */
function storedStablecoin(swapId: string): StoredStablecoinSwap {
  return {
    type: "stablecoin",
    swapId,
    asset: "USDT",
    networkId: "tron",
    claimAddress: "T" + "x".repeat(33),
    lockupAddress: "lq1qstlockup",
    lockAmountSats: 500_000,
    serverPublicKey: "02" + "cd".repeat(32),
    swapTree: {},
    timeoutBlockHeight: 3_100_000,
    refundPrivateKeyHex: STABLECOIN_REFUND_PRIV_HEX,
    refundPublicKeyHex: "02" + "ef".repeat(32),
    preimageHex: STABLECOIN_PREIMAGE_HEX,
    evmPrivateKeyHex: STABLECOIN_EVM_PRIV_HEX,
    createdSwap: {},
    plan: {},
    state: "locked_up",
    createdAt: 1_720_000_000_000
  };
}

// ─── open() auto-invokes the conversion recovery (mirror of withdrawals) ──────

describe("open() auto-resumes pending conversions (§5 recovery wiring)", () => {
  it("calls convert.boltz.resume() on open() by default", async () => {
    await seedWalletFile();
    const resumeSpy = vi.spyOn(BoltzConvert.prototype, "resume").mockResolvedValue({ ...EMPTY_BOLTZ });
    const wallet = track(await DepixWallet.open({ dataDir, passphrase: PASSPHRASE }));
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(wallet.isBackupConfirmed()).toBe(true);
  });

  it("skips the conversion resume when resumePendingConversionsOnOpen: false", async () => {
    await seedWalletFile();
    const resumeSpy = vi.spyOn(BoltzConvert.prototype, "resume").mockResolvedValue({ ...EMPTY_BOLTZ });
    track(await DepixWallet.open({ dataDir, passphrase: PASSPHRASE, resumePendingConversionsOnOpen: false }));
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it("NEVER fails open() when the conversion resume blows up", async () => {
    await seedWalletFile();
    vi.spyOn(BoltzConvert.prototype, "resume").mockRejectedValue(new Error("boltz is down"));
    const wallet = track(await DepixWallet.open({ dataDir, passphrase: PASSPHRASE }));
    // The wallet opened and is fully usable despite the failed resume.
    expect(wallet.isBackupConfirmed()).toBe(true);
  });

  it("resumePendingConversions() itself never throws on a per-rail failure", async () => {
    await seedWalletFile();
    vi.spyOn(BoltzConvert.prototype, "resume").mockRejectedValue(new Error("boom"));
    const wallet = track(
      await DepixWallet.open({ dataDir, passphrase: PASSPHRASE, resumePendingConversionsOnOpen: false })
    );
    const summary = await wallet.resumePendingConversions();
    expect(summary.boltz).toBeNull(); // rail failed → no summary, but no throw
    expect(summary.pegin).toEqual({ pending: 0, cleared: 0, failed: 0 });
    expect(summary.sideshift).toEqual({ checked: 0, refreshed: 0, failed: 0 });
  });
});

// ─── wallet.recover(): every rail, mid-session, idempotent ────────────────────

describe("wallet.recover() re-drives every rail (§3.2.9 + §5)", () => {
  it("resumes withdrawals + boltz + peg-in + sideshift and reports per-rail counts", async () => {
    const boltzSummary: BoltzResumeSummary = { ...EMPTY_BOLTZ, submarineResumed: 1 };
    const resumeSpy = vi.spyOn(BoltzConvert.prototype, "resume").mockResolvedValue(boltzSummary);

    // Seed a pending peg-in that SideSwap now reports Done, and a waiting shift
    // that SideShift now reports settled.
    const pegClient = new FakeSideSwapClient({
      pegStatus: async (args) => ({ orderId: args.orderId, status: "Done", confirmations: 102, txid: "ab".repeat(32), deposits: [] })
    });
    const { fetchImpl, calls } = shiftStatusFetch("settled");
    const wallet = track(
      await DepixWallet.restore({
        dataDir,
        passphrase: PASSPHRASE,
        mnemonic: KNOWN_MNEMONIC,
        convert: { clientFactory: () => pegClient, sideshift: { fetchImpl, affiliateId: "test-affiliate" } }
      })
    );
    await new PendingPegIn(dataDir).put({ orderId: "peg_1", pegAddr: "bc1qpeg", recvAddr: "lq1qrecv" });
    await new SideShiftStore({ dataDir }).save(storedShift("sh_pending", "waiting"));

    const summary = await wallet.recover();

    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(summary.withdrawals).toEqual({ resumed: 0, rebroadcast: 0, reposted: 0, discarded: 0, failed: 0 });
    expect(summary.boltz).toEqual(boltzSummary);
    // Done at SideSwap → the tracked peg-in was cleared.
    expect(summary.pegin).toEqual({ pending: 0, cleared: 1, failed: 0 });
    await expect(readFile(join(dataDir, PENDING_PEGIN_FILE), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    // The waiting shift was refreshed from SideShift and folded into the log.
    expect(summary.sideshift).toEqual({ checked: 1, refreshed: 1, failed: 0 });
    expect(calls.length).toBe(1);
    expect((await new SideShiftStore({ dataDir }).get("sh_pending"))?.status).toBe("settled");

    // Idempotent: a second recover() finds nothing left to reconcile.
    const again = await wallet.recover();
    expect(again.pegin).toEqual({ pending: 0, cleared: 0, failed: 0 });
    expect(again.sideshift).toEqual({ checked: 0, refreshed: 0, failed: 0 });
  });

  it("keeps a still-in-flight peg-in tracked (pending, not cleared)", async () => {
    vi.spyOn(BoltzConvert.prototype, "resume").mockResolvedValue({ ...EMPTY_BOLTZ });
    const pegClient = new FakeSideSwapClient({
      pegStatus: async (args) => ({ orderId: args.orderId, status: "Detected", confirmations: 12, txid: null, deposits: [] })
    });
    const wallet = track(
      await DepixWallet.restore({
        dataDir,
        passphrase: PASSPHRASE,
        mnemonic: KNOWN_MNEMONIC,
        convert: { clientFactory: () => pegClient }
      })
    );
    await new PendingPegIn(dataDir).put({ orderId: "peg_2", pegAddr: "bc1qpeg", recvAddr: "lq1qrecv" });

    const summary = await wallet.recover();
    expect(summary.pegin).toEqual({ pending: 1, cleared: 0, failed: 0 });
    // Still tracked for the next resume/agent poll.
    expect(await wallet.convert.sideswap.getPendingPegIn()).toMatchObject({ orderId: "peg_2" });
  });

  it("counts a failed sideshift refresh without aborting the rail sweep", async () => {
    vi.spyOn(BoltzConvert.prototype, "resume").mockResolvedValue({ ...EMPTY_BOLTZ });
    const failingFetch: FetchLike = async () => {
      throw new Error("sideshift unreachable");
    };
    const wallet = track(
      await DepixWallet.restore({
        dataDir,
        passphrase: PASSPHRASE,
        mnemonic: KNOWN_MNEMONIC,
        convert: { sideshift: { fetchImpl: failingFetch, affiliateId: "test-affiliate" } }
      })
    );
    await new SideShiftStore({ dataDir }).save(storedShift("sh_a", "waiting"));
    await new SideShiftStore({ dataDir }).save(storedShift("sh_b", "pending"));

    const summary = await wallet.recover();
    expect(summary.sideshift).toEqual({ checked: 2, refreshed: 0, failed: 2 });
    // Records survive for the next resume.
    expect((await new SideShiftStore({ dataDir }).list()).length).toBe(2);
  });
});

// ─── wallet.getPending(): one read-only view over the four stores ─────────────

describe("wallet.getPending() unifies the four pending stores", () => {
  it("returns withdrawal + boltz + pegin + sideshift items with rail/id/state", async () => {
    const wallet = track(
      await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC })
    );
    const salt = await saltOf();

    // Seed each store the same way its own flow persists.
    const withdrawals = new PendingWithdrawals({ dataDir, passphrase: PASSPHRASE, saltB64: salt });
    await withdrawals.putRequested({
      idempotencyKey: "idem-1",
      request: { pixKey: "k", taxNumber: "t", depositAmountInCents: 500 }
    });
    const boltzStore = new BoltzSwapStore({ dataDir, passphrase: PASSPHRASE, saltB64: salt });
    // Seed one of EACH boltz rail — each stores different key material.
    await boltzStore.put(storedSubmarine("sub_1"));
    await boltzStore.put(storedReverse("rev_1"));
    await boltzStore.put(storedStablecoin("stbl_1"));
    await new PendingPegIn(dataDir).put({ orderId: "peg_1", pegAddr: "bc1qpeg", recvAddr: "lq1qrecv" });
    const shifts = new SideShiftStore({ dataDir });
    await shifts.save(storedShift("sh_pending", "waiting"));
    await shifts.save(storedShift("sh_done", "settled")); // terminal → excluded

    const items = await wallet.getPending();
    expect(items).toHaveLength(6);

    const byRail = Object.fromEntries(items.map((i) => [i.rail, i]));
    expect(byRail.withdrawal).toMatchObject({ id: "idem-1", state: "requested", withdrawalId: null, txid: null });
    expect(byRail.pegin).toMatchObject({ id: "peg_1", state: "pending", pegAddr: "bc1qpeg", recvAddr: "lq1qrecv" });
    // The unified view surfaces the peg-in's REAL createdAt (was hardcoded null).
    expect(byRail.pegin?.createdAt).toEqual(expect.any(Number));
    expect(byRail.sideshift).toMatchObject({ id: "sh_pending", state: "waiting", shiftType: "send", network: "tron" });

    // All three boltz rails surface rail/id/state/swapType metadata only.
    const boltzById = Object.fromEntries(items.filter((i) => i.rail === "boltz").map((i) => [i.id, i]));
    expect(Object.keys(boltzById)).toHaveLength(3);
    expect(boltzById.sub_1).toMatchObject({ state: "locked_up", swapType: "submarine" });
    expect(boltzById.rev_1).toMatchObject({ state: "awaiting_payment", swapType: "reverse" });
    expect(boltzById.stbl_1).toMatchObject({ state: "locked_up", swapType: "stablecoin" });

    // NO key material leaks through the read-only view — this is the fund-safety
    // invariant the PR leans on, so it is checked for EVERY rail's secrets:
    // submarine refund key, reverse claim key + preimage, stablecoin refund/EVM
    // key + preimage. All must stay inside the encrypted store.
    const flat = JSON.stringify(items);
    // submarine
    expect(flat).not.toContain("refundPrivateKeyHex");
    expect(flat).not.toContain("c".repeat(64));
    expect(flat).not.toContain("signedTxHex");
    // reverse — claim key + preimage
    expect(flat).not.toContain("claimPrivateKeyHex");
    expect(flat).not.toContain("preimageHex");
    expect(flat).not.toContain(REVERSE_PREIMAGE_HEX);
    expect(flat).not.toContain(REVERSE_CLAIM_PRIV_HEX);
    // stablecoin — refund key, ephemeral EVM key + preimage
    expect(flat).not.toContain("evmPrivateKeyHex");
    expect(flat).not.toContain(STABLECOIN_REFUND_PRIV_HEX);
    expect(flat).not.toContain(STABLECOIN_EVM_PRIV_HEX);
    expect(flat).not.toContain(STABLECOIN_PREIMAGE_HEX);
  });

  it("returns an empty list when nothing is in flight", async () => {
    const wallet = track(
      await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC })
    );
    expect(await wallet.getPending()).toEqual([]);
  });
});
