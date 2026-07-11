// Regression: the Boltz reverse-claim and refund paths must call
// boltz-core.detectSwap, NOT boltz-swaps/utxo.detectSwap (mainnet e2e,
// 2026-07-11). The published 1.0.1 called `utxo.detectSwap` — a function that
// does not exist on boltz-swaps/utxo — and threw
// "utxo.detectSwap is not a function" from inside the claim/refund builder,
// stranding every PAID Lightning receive (and any on-failure lockup refund)
// until the Boltz timeout. The whole 800-test suite + pre-publish audit missed
// it because nothing supplied a parseable lockup tx to drive the builders as
// far as the detectSwap call.
//
// These drive the REAL builders (real boltz-core / boltz-swaps) with a lockup
// tx that does NOT carry this swap's output — so detectSwap runs, returns
// undefined, and the code throws the TYPED SWAP_VALIDATION_FAILED. That typed
// throw proves detectSwap was reachable and callable. On the bug the throw is a
// bare TypeError ("is not a function") BEFORE any typed check.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import { buildReverseClaimTx } from "../src/convert/boltz/reverse.js";
import { buildRefundTx } from "../src/convert/boltz/refund.js";
import { isDepixSdkError } from "../src/errors.js";
import { buildHonestSubmarineLockup } from "./support/boltz.js";

function randomKeys(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = secp256k1.utils.randomSecretKey();
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  return { privateKey, publicKey };
}

const notAFunction = (err: unknown): boolean =>
  /is not a function/.test(String((err as Error)?.message ?? err));

describe("Boltz claim/refund reach boltz-core.detectSwap (mainnet e2e regression, 2026-07-11)", () => {
  it("module boundary: detectSwap is a boltz-core export, absent on boltz-swaps/utxo", async () => {
    const boltzCore = (await import("boltz-core")) as Record<string, unknown>;
    const utxo = (await import("boltz-swaps/utxo")) as Record<string, unknown>;
    expect(typeof boltzCore.detectSwap).toBe("function");
    expect(utxo.detectSwap).toBeUndefined();
  });

  it("buildReverseClaimTx (Lightning receive) reaches detectSwap → typed error, not a TypeError", async () => {
    const lk = await buildHonestSubmarineLockup();
    let err: unknown;
    try {
      await buildReverseClaimTx({
        swap: {
          swapId: "regression",
          swapTree: lk.swapTree,
          refundPublicKey: lk.refundPublicKey
        } as unknown as Parameters<typeof buildReverseClaimTx>[0]["swap"],
        lockupTxHex: lk.lockupTxHex,
        claimKeys: randomKeys(),
        preimage: new Uint8Array(32),
        claimAddress: lk.lockupAddress
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(notAFunction(err)).toBe(false);
    expect(isDepixSdkError(err, "SWAP_VALIDATION_FAILED")).toBe(true);
  });

  it("buildRefundTx (on-failure lockup refund) reaches detectSwap → typed error, not a TypeError", async () => {
    const lk = await buildHonestSubmarineLockup();
    let err: unknown;
    try {
      await buildRefundTx({
        swapId: "regression",
        boltzPublicKey: lk.claimPublicKey,
        swapTree: lk.swapTree,
        timeoutBlockHeight: lk.timeoutBlockHeight,
        swapType: "submarine",
        lockupTxHex: lk.lockupTxHex,
        refundKeys: randomKeys(),
        refundAddress: lk.lockupAddress
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(notAFunction(err)).toBe(false);
    expect(isDepixSdkError(err, "SWAP_VALIDATION_FAILED")).toBe(true);
  });
});
