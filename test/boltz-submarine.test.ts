// prepareSubmarineSwap (spec §5.3) — the LN-send guard cadence with mocked deps
// (no network, no WASM). Asserts the guards fire in order and, critically, that
// verify-lockup is bound to the payment hash of the SUPPLIED invoice.
import { describe, expect, it, vi } from "vitest";
import { prepareSubmarineSwap, type PrepareSubmarineDeps } from "../src/convert/boltz/submarine.js";
import type { CreatedSubmarineSwap } from "../src/convert/boltz/client.js";
import { isDepixSdkError } from "../src/errors.js";
import { TEST_INVOICE, TEST_PAYMENT_HASH } from "./support/boltz.js";

const REFUND = { privHex: "aa".repeat(32), pubHex: "02" + "bb".repeat(32) };

function baseDeps(created: Partial<CreatedSubmarineSwap> = {}): {
  deps: PrepareSubmarineDeps;
  verify: ReturnType<typeof vi.fn>;
} {
  const verify = vi.fn(async () => {});
  const deps: PrepareSubmarineDeps = {
    getSubmarinePairHash: async () => "pair-hash",
    createSubmarineSwap: async () => ({
      id: "swap-1",
      address: "lq1lockup-address",
      expectedAmount: 260_000,
      swapTree: { claimLeaf: {}, refundLeaf: {} },
      claimPublicKey: "03" + "cc".repeat(32),
      blindingKey: "dd".repeat(32),
      timeoutBlockHeight: 1_000_100,
      ...created
    }),
    getChainHeight: async () => 1_000_000,
    genRefundKeypair: () => REFUND,
    verifyLockup: verify as unknown as PrepareSubmarineDeps["verifyLockup"]
  };
  return { deps, verify };
}

describe("prepareSubmarineSwap — happy path", () => {
  it("runs the cadence and binds verify-lockup to the SUPPLIED invoice's payment hash", async () => {
    const { deps, verify } = baseDeps();
    const prepared = await prepareSubmarineSwap({ invoice: TEST_INVOICE }, deps);

    expect(prepared.swapId).toBe("swap-1");
    expect(prepared.lockupAddress).toBe("lq1lockup-address");
    expect(prepared.expectedAmountSats).toBe(260_000);
    expect(prepared.invoiceSats).toBe(250_000);
    expect(prepared.refundPublicKeyHex).toBe(REFUND.pubHex);
    expect(prepared.refundPrivateKeyHex).toBe(REFUND.privHex);

    // The binding is the whole point: verify-lockup gets the invoice payment hash
    // + OUR refund key, tagged submarine. An attacker-chosen invoice would still
    // verify here (Boltz created the swap for it) — the allowlist, not this check,
    // gates the final payee (covered in boltz-convert.test.ts).
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]![0]).toMatchObject({
      swapType: "submarine",
      lockupAddress: "lq1lockup-address",
      serverPublicKey: "03" + "cc".repeat(32),
      refundPublicKey: REFUND.pubHex,
      refundPrivateKey: REFUND.privHex,
      expectedHash: TEST_PAYMENT_HASH,
      timeoutBlockHeight: 1_000_100
    });
  });
});

describe("prepareSubmarineSwap — fail-closed guards (§5.3)", () => {
  it("rejects an amount-less invoice with INVOICE_NO_AMOUNT before creating a swap", async () => {
    const { deps } = baseDeps();
    const createSpy = vi.spyOn(deps, "createSubmarineSwap");
    await expect(
      prepareSubmarineSwap({ invoice: "lnbc1pamountless" }, deps)
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "INVOICE_NO_AMOUNT"));
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("rejects an inflated expectedAmount with LOCKUP_INFLATED", async () => {
    // ceiling for 250_000 = ceil(*1.05)+2000 = 264_500; 300_000 is over.
    const { deps } = baseDeps({ expectedAmount: 300_000 });
    await expect(
      prepareSubmarineSwap({ invoice: TEST_INVOICE }, deps)
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "LOCKUP_INFLATED"));
  });

  it("rejects an out-of-bounds refund timeout with TIMEOUT_OUT_OF_BOUNDS", async () => {
    const { deps } = baseDeps({ timeoutBlockHeight: 9_999_999 }); // >> height + max
    await expect(
      prepareSubmarineSwap({ invoice: TEST_INVOICE }, deps)
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "TIMEOUT_OUT_OF_BOUNDS"));
  });

  it("propagates a verify-lockup rejection (LOCKUP_TREE_MISMATCH)", async () => {
    const { deps } = baseDeps();
    deps.verifyLockup = (async () => {
      throw new (await import("../src/errors.js")).ConversionError("LOCKUP_TREE_MISMATCH", "tampered");
    }) as unknown as PrepareSubmarineDeps["verifyLockup"];
    await expect(
      prepareSubmarineSwap({ invoice: TEST_INVOICE }, deps)
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "LOCKUP_TREE_MISMATCH"));
  });

  it("rejects an incomplete Boltz response with SWAP_VALIDATION_FAILED", async () => {
    const { deps } = baseDeps();
    deps.createSubmarineSwap = async () =>
      ({ id: "x", address: "", expectedAmount: 0 }) as unknown as CreatedSubmarineSwap;
    await expect(
      prepareSubmarineSwap({ invoice: TEST_INVOICE }, deps)
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "SWAP_VALIDATION_FAILED"));
  });
});
