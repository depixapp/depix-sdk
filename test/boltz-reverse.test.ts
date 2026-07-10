// reverse / LN RECEIVE (spec §5.3) — orchestration with the crypto/subscribe
// injected: the invoice hash binding, no-claim-before-lockup ordering, and the
// settle/fail terminals. An INFLOW — no guardrail.
import { hex } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import {
  receiveViaLightning,
  REVERSE_PHASE,
  type ReverseDeps,
  type ReverseSwapRecord
} from "../src/convert/boltz/reverse.js";
import { isDepixSdkError } from "../src/errors.js";
import { TEST_INVOICE, TEST_PAYMENT_HASH } from "./support/boltz.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

function secrets(preimageHashHex: string) {
  return () => ({
    preimage: new Uint8Array(32).fill(9),
    preimageHash: hex.decode(preimageHashHex),
    claimKeys: { privateKey: new Uint8Array(32).fill(1), publicKey: new Uint8Array(33).fill(2) }
  });
}

function baseDeps(over: Partial<ReverseDeps> = {}): {
  deps: ReverseDeps;
  emit: (raw: string) => void;
  claim: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
} {
  let emit: (raw: string) => void = () => {};
  const claim = vi.fn(async () => "claim-tx-hex");
  const broadcast = vi.fn(async () => ({ id: "claim-txid" }));
  const deps: ReverseDeps = {
    // preimageHash matches TEST_INVOICE's payment hash → binding passes.
    deriveSecrets: async () => secrets(TEST_PAYMENT_HASH)(),
    getClaimAddress: async () => "lq1claim-address",
    subscribe: (_id, onRaw) => {
      emit = onRaw;
      return () => {};
    },
    createReverseSwap: async () => ({
      id: "rev-1",
      invoice: TEST_INVOICE,
      lockupAddress: "lq1lockup",
      onchainAmount: 200_000,
      swapTree: {},
      refundPublicKey: "03" + "cc".repeat(32),
      blindingKey: "dd".repeat(32),
      timeoutBlockHeight: 1_000_100
    }),
    getLockupTx: async () => ({ hex: "lockup-tx-hex" }),
    claim: claim as unknown as ReverseDeps["claim"],
    broadcast: broadcast as unknown as ReverseDeps["broadcast"],
    ...over
  };
  return { deps, emit: (r) => emit(r), claim, broadcast };
}

describe("receiveViaLightning — invoice hash binding (§5.3)", () => {
  it("aborts with INVOICE_HASH_MISMATCH when Boltz's invoice does not pay OUR preimage", async () => {
    const { deps } = baseDeps({
      // OUR preimage hashes to something ELSE → the returned TEST_INVOICE
      // (payment hash TEST_PAYMENT_HASH) does not match → abort.
      deriveSecrets: async () => secrets("11".repeat(32))()
    });
    await expect(
      receiveViaLightning({ amountSats: 250_000, pairHash: "ph" }, deps)
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "INVOICE_HASH_MISMATCH"));
  });
});

describe("receiveViaLightning — watch → claim ordering", () => {
  it("surfaces the invoice, does NOT claim until locked, then claims + broadcasts on settle", async () => {
    const onInvoice = vi.fn();
    const { deps, emit, claim, broadcast } = baseDeps({ onInvoice });
    const done = receiveViaLightning({ amountSats: 250_000, pairHash: "ph" }, deps);
    // Let create + subscribe run and surface the invoice.
    await tick();
    expect(onInvoice).toHaveBeenCalledWith(TEST_INVOICE, expect.objectContaining({ swapId: "rev-1" }));

    // A pending status must NOT trigger a claim.
    emit("swap.created");
    await tick();
    expect(claim).not.toHaveBeenCalled();

    // Lockup seen → build + broadcast the claim into the wallet.
    emit("transaction.mempool");
    await tick();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith("L-BTC", "claim-tx-hex");

    // Settled → resolve COMPLETED with the claim txid recorded.
    emit("invoice.settled");
    const outcome = await done;
    expect(outcome.phase).toBe(REVERSE_PHASE.COMPLETED);
    expect((outcome.record as ReverseSwapRecord).claimTxId).toBe("claim-txid");
  });

  it("resolves FAILED (no claim) when the swap expires before a lockup", async () => {
    const { deps, emit, claim } = baseDeps();
    const done = receiveViaLightning({ amountSats: 250_000, pairHash: "ph" }, deps);
    await tick();
    emit("swap.expired");
    const outcome = await done;
    expect(outcome.phase).toBe(REVERSE_PHASE.FAILED);
    expect(claim).not.toHaveBeenCalled();
  });
});
