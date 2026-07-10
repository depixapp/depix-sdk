// verify-lockup (spec §5.3, PR#80) — REAL boltz-core / secp256k1-zkp crypto.
// Builds an HONEST submarine lockup with the same primitives Boltz uses
// server-side, then asserts honest → accept and every tamper → reject
// (LOCKUP_TREE_MISMATCH). This is the money-critical binding: the swap tree's
// refund leaf must be OUR key and its claim leaf must commit to the SUPPLIED
// invoice's payment hash, and the address must pay to exactly that tree's
// Taproot output.
import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { assertLockupAddressBindsToUser } from "../src/convert/boltz/verify-lockup.js";
import { isDepixSdkError } from "../src/errors.js";
import { anotherLockupAddress, buildHonestSubmarineLockup } from "./support/boltz.js";

async function expectMismatch(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toSatisfy((err: unknown) =>
    isDepixSdkError(err, "LOCKUP_TREE_MISMATCH")
  );
}

describe("assertLockupAddressBindsToUser — honest lockup", () => {
  it("ACCEPTS a lockup re-derived byte-for-byte from our key + the invoice hash", async () => {
    const lk = await buildHonestSubmarineLockup();
    await expect(
      assertLockupAddressBindsToUser({
        swapType: "submarine",
        lockupAddress: lk.lockupAddress,
        swapTree: lk.swapTree,
        serverPublicKey: lk.claimPublicKey,
        refundPublicKey: lk.refundPublicKey,
        refundPrivateKey: lk.refundPrivateKey,
        expectedHash: lk.paymentHash,
        timeoutBlockHeight: lk.timeoutBlockHeight
      })
    ).resolves.toBeUndefined();
  });
});

describe("assertLockupAddressBindsToUser — tampered lockup REJECTED (§5.3)", () => {
  it("rejects a claim leaf bound to a DIFFERENT payment hash (attacker-controlled preimage)", async () => {
    const lk = await buildHonestSubmarineLockup();
    await expectMismatch(
      assertLockupAddressBindsToUser({
        swapType: "submarine",
        lockupAddress: lk.lockupAddress,
        swapTree: lk.swapTree,
        serverPublicKey: lk.claimPublicKey,
        refundPublicKey: lk.refundPublicKey,
        refundPrivateKey: lk.refundPrivateKey,
        expectedHash: hex.encode(randomBytes(32)), // different hash → tree mismatch
        timeoutBlockHeight: lk.timeoutBlockHeight
      })
    );
  });

  it("rejects a refund leaf keyed to a DIFFERENT (non-ours) refund key", async () => {
    const lk = await buildHonestSubmarineLockup();
    const otherPriv = secp256k1.utils.randomSecretKey();
    const otherPub = secp256k1.getPublicKey(otherPriv, true);
    await expectMismatch(
      assertLockupAddressBindsToUser({
        swapType: "submarine",
        lockupAddress: lk.lockupAddress,
        swapTree: lk.swapTree,
        serverPublicKey: lk.claimPublicKey,
        refundPublicKey: hex.encode(otherPub),
        refundPrivateKey: hex.encode(otherPriv),
        expectedHash: lk.paymentHash,
        timeoutBlockHeight: lk.timeoutBlockHeight
      })
    );
  });

  it("rejects an address that does NOT pay to the derived swap script", async () => {
    const lk = await buildHonestSubmarineLockup();
    const wrongAddress = await anotherLockupAddress(); // valid, but a different tree
    await expectMismatch(
      assertLockupAddressBindsToUser({
        swapType: "submarine",
        lockupAddress: wrongAddress,
        swapTree: lk.swapTree,
        serverPublicKey: lk.claimPublicKey,
        refundPublicKey: lk.refundPublicKey,
        refundPrivateKey: lk.refundPrivateKey,
        expectedHash: lk.paymentHash,
        timeoutBlockHeight: lk.timeoutBlockHeight
      })
    );
  });

  it("rejects missing material and an unknown swapType before any crypto", async () => {
    const lk = await buildHonestSubmarineLockup();
    await expectMismatch(
      assertLockupAddressBindsToUser({
        swapType: "submarine",
        lockupAddress: lk.lockupAddress,
        swapTree: undefined,
        serverPublicKey: lk.claimPublicKey,
        refundPublicKey: lk.refundPublicKey,
        refundPrivateKey: lk.refundPrivateKey,
        expectedHash: lk.paymentHash,
        timeoutBlockHeight: lk.timeoutBlockHeight
      })
    );
    await expectMismatch(
      assertLockupAddressBindsToUser({
        swapType: "chain-typo" as never,
        lockupAddress: lk.lockupAddress,
        swapTree: lk.swapTree,
        serverPublicKey: lk.claimPublicKey,
        refundPublicKey: lk.refundPublicKey,
        refundPrivateKey: lk.refundPrivateKey,
        expectedHash: lk.paymentHash,
        timeoutBlockHeight: lk.timeoutBlockHeight
      })
    );
  });
});
