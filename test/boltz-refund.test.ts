// refund (spec §5.3) — the cooperative → timeout(uncooperative) orchestration,
// with the crypto/broadcast injected (parity with the frontend's own refund
// tests). Always L-BTC back to the wallet.
import { describe, expect, it, vi } from "vitest";
import {
  refundLockTime,
  refundSubmarineSwap,
  type RefundDeps,
  type SubmarineRefundRecord
} from "../src/convert/boltz/refund.js";
import { isDepixSdkError } from "../src/errors.js";

const RECORD: SubmarineRefundRecord = {
  swapId: "swap-1",
  claimPublicKey: "03" + "cc".repeat(32),
  swapTree: { claimLeaf: {}, refundLeaf: {} },
  blindingKey: "dd".repeat(32),
  timeoutBlockHeight: 1_000_000,
  refundPrivateKeyHex: "aa".repeat(32),
  refundPublicKeyHex: "02" + "bb".repeat(32)
};

describe("refundLockTime", () => {
  it("is 0 for a cooperative refund (must be final) and the timeout for the trustless one", () => {
    expect(refundLockTime(true, 1_000_000)).toBe(0);
    expect(refundLockTime(false, 1_000_000)).toBe(1_000_000);
  });
});

describe("refundSubmarineSwap — cooperative first", () => {
  it("broadcasts the cooperative refund when Boltz co-signs", async () => {
    const refund = vi.fn(async (a: { cooperative?: boolean }) =>
      a.cooperative ? "tx-coop" : "tx-uncoop"
    );
    const broadcast = vi.fn(async () => ({ id: "txid-coop" }));
    const deps: RefundDeps = {
      getRefundAddress: async () => "lq1refund",
      getLockupHex: async () => "lockup-hex",
      refund: refund as unknown as RefundDeps["refund"],
      broadcast
    };
    const res = await refundSubmarineSwap(RECORD, deps);
    expect(res).toEqual({ refundTxId: "txid-coop", cooperative: true });
    expect(refund.mock.calls[0]![0]).toMatchObject({ cooperative: true });
    expect(broadcast).toHaveBeenCalledWith("L-BTC", "tx-coop");
  });
});

describe("refundSubmarineSwap — timeout fallback", () => {
  it("throws RefundPendingError when cooperative fails and the timeout is not reached", async () => {
    const deps: RefundDeps = {
      getRefundAddress: async () => "lq1refund",
      getLockupHex: async () => "lockup-hex",
      refund: (async (a: { cooperative?: boolean }) => {
        if (a.cooperative) throw new Error("boltz offline");
        return "tx-uncoop";
      }) as unknown as RefundDeps["refund"],
      broadcast: async () => ({ id: "x" }),
      getBlockHeight: async () => 999_999 // < timeoutBlockHeight (1_000_000)
    };
    await expect(refundSubmarineSwap(RECORD, deps)).rejects.toSatisfy(
      (e: unknown) => isDepixSdkError(e, "SWAP_VALIDATION_FAILED") && (e as { refundPending?: boolean }).refundPending === true
    );
  });

  it("falls back to the trustless timeout refund once the lock has expired", async () => {
    const refund = vi.fn(async (a: { cooperative?: boolean }) => {
      if (a.cooperative) throw new Error("boltz offline");
      return "tx-uncoop";
    });
    const broadcast = vi.fn(async () => ({ id: "txid-uncoop" }));
    const deps: RefundDeps = {
      getRefundAddress: async () => "lq1refund",
      getLockupHex: async () => "lockup-hex",
      refund: refund as unknown as RefundDeps["refund"],
      broadcast,
      getBlockHeight: async () => 1_000_050 // >= timeoutBlockHeight
    };
    const res = await refundSubmarineSwap(RECORD, deps);
    expect(res).toEqual({ refundTxId: "txid-uncoop", cooperative: false });
    // cooperative attempted first, then the uncooperative fallback.
    expect(refund.mock.calls.map((c) => (c[0] as { cooperative?: boolean }).cooperative)).toEqual([
      true,
      false
    ]);
    expect(broadcast).toHaveBeenCalledWith("L-BTC", "tx-uncoop");
  });
});

describe("refundSubmarineSwap — guards", () => {
  it("throws without a getRefundAddress dep", async () => {
    await expect(
      refundSubmarineSwap(RECORD, {} as unknown as RefundDeps)
    ).rejects.toThrow(/getRefundAddress/);
  });

  it("throws when the record is missing refund material", async () => {
    await expect(
      refundSubmarineSwap({ swapId: "x" } as unknown as SubmarineRefundRecord, {
        getRefundAddress: async () => "lq1"
      })
    ).rejects.toThrow(/missing refund material/);
  });
});
