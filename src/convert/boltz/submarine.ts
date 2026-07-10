// Submarine swap orchestrator — LN SEND: pay a BOLT11 invoice by locking L-BTC
// (spec §5.3). The client locks L-BTC into the swap address; Boltz pays the
// Lightning invoice and claims the lockup with the preimage it learns. The client
// never cosigns — its only safety job is to REFUND (refund.ts) if Boltz fails to
// pay before the timeout.
//
// This module is the PURE, dependency-injected orchestration the frontend drove
// inline in wallet-ui.js (onLightningPreview): it creates the swap and runs the
// fail-closed guard cadence, returning a prepared record. It does NOT sign or
// broadcast — the wallet (convert.ts) runs the guardrail choke point then signs
// the L-BTC lockup, so the guardrail sees the real expectedAmount and the
// allowlist sees the Lightning payee.
//
// Guard cadence (frontend order, all fail-closed):
//   decodeInvoiceAmountSats → createSubmarineSwap → assertLockupNotInflated
//   (ceil(invoiceSats*1.05)+2000) → assertTimeoutInBounds
//   (MAX_SUBMARINE_TIMEOUT_BLOCKS) → assertLockupAddressBindsToUser (re-derives
//   the tree with boltz-core and binds the payment hash of the SUPPLIED invoice).

import { ConversionError } from "../../errors.js";
import type { CreatedSubmarineSwap } from "./client.js";
import { randomKeypair } from "./keys.js";
import {
  assertLockupNotInflated,
  assertTimeoutInBounds,
  decodeInvoiceAmountSats,
  decodeInvoicePaymentHash
} from "./lightning.js";
import { assertLockupAddressBindsToUser } from "./verify-lockup.js";

/** The prepared, verified submarine lockup — ready for the wallet to fund. */
export interface PreparedSubmarineSwap {
  swapId: string;
  invoice: string;
  /** L-BTC lockup address to fund. */
  lockupAddress: string;
  /** Sats Boltz says the wallet must lock (validated not-inflated). */
  expectedAmountSats: number;
  /** Decoded invoice amount (sats) — the trusted ceiling. */
  invoiceSats: number;
  swapTree: unknown;
  claimPublicKey: string;
  blindingKey?: string;
  timeoutBlockHeight: number;
  refundPrivateKeyHex: string;
  refundPublicKeyHex: string;
}

export interface PrepareSubmarineDeps {
  getSubmarinePairHash: () => Promise<string>;
  createSubmarineSwap: (params: {
    invoice: string;
    refundPublicKey: string;
    pairHash: string;
  }) => Promise<CreatedSubmarineSwap>;
  /** Current L-BTC chain height for the timeout bound; null = skip the bound. */
  getChainHeight?: () => Promise<number | null>;
  /** Override the refund keypair generator (tests). */
  genRefundKeypair?: () => { privHex: string; pubHex: string };
  /** Override the lockup verifier (tests) — defaults to the real re-derivation. */
  verifyLockup?: typeof assertLockupAddressBindsToUser;
  /** Override the max timeout bound (default MAX_SUBMARINE_TIMEOUT_BLOCKS). */
  maxTimeoutBlocks?: number;
}

/**
 * Create a submarine swap for `invoice` and run the full fail-closed guard
 * cadence, returning a verified PreparedSubmarineSwap. Throws ConversionError on
 * any guard violation BEFORE the caller locks any funds. Amount-less invoices are
 * rejected up front (INVOICE_NO_AMOUNT) — Boltz pays the exact invoice value, so
 * there is no amount to lock against.
 */
export async function prepareSubmarineSwap(
  params: { invoice: string },
  deps: PrepareSubmarineDeps
): Promise<PreparedSubmarineSwap> {
  const invoice = params.invoice;
  if (typeof invoice !== "string" || invoice.trim().length === 0) {
    throw new ConversionError("INVOICE_NO_AMOUNT", "A BOLT11 invoice is required");
  }
  const invoiceSats = decodeInvoiceAmountSats(invoice);
  if (invoiceSats == null) {
    throw new ConversionError(
      "INVOICE_NO_AMOUNT",
      "This invoice has no defined amount — use a Lightning invoice with an amount."
    );
  }

  const [pairHash, currentHeight] = await Promise.all([
    deps.getSubmarinePairHash(),
    deps.getChainHeight ? deps.getChainHeight().catch(() => null) : Promise.resolve(null)
  ]);

  const refund = (deps.genRefundKeypair ?? (() => randomKeypair()))();
  const created = await deps.createSubmarineSwap({
    invoice,
    refundPublicKey: refund.pubHex,
    pairHash
  });
  if (!created?.address || !created?.expectedAmount) {
    throw new ConversionError("SWAP_VALIDATION_FAILED", "Boltz submarine response incomplete");
  }

  // Guard 1: the quoted lockup must not be inflated beyond the invoice + margin.
  assertLockupNotInflated(created.expectedAmount, invoiceSats);

  // Guard 2: sane-bound the refund timeout (best-effort when height unknown).
  assertTimeoutInBounds(created.timeoutBlockHeight, currentHeight, deps.maxTimeoutBlocks);

  // Guard 3 (CRITICAL): re-derive the lockup and assert Boltz's address/tree
  // match. Binds the claim leaf to the payment hash of THIS invoice — an
  // attacker-supplied invoice still verifies (Boltz created the swap for it), so
  // the allowlist, NOT this check, gates the final Lightning payee (§4.3).
  const expectedHash = decodeInvoicePaymentHash(invoice);
  if (!expectedHash) {
    throw new ConversionError("INVOICE_NO_AMOUNT", "Could not decode the invoice payment hash");
  }
  const verify = deps.verifyLockup ?? assertLockupAddressBindsToUser;
  await verify({
    swapType: "submarine",
    lockupAddress: created.address,
    swapTree: created.swapTree,
    serverPublicKey: created.claimPublicKey,
    refundPublicKey: refund.pubHex,
    refundPrivateKey: refund.privHex,
    expectedHash,
    timeoutBlockHeight: created.timeoutBlockHeight
  });

  return {
    swapId: created.id,
    invoice,
    lockupAddress: created.address,
    expectedAmountSats: created.expectedAmount,
    invoiceSats,
    swapTree: created.swapTree,
    claimPublicKey: created.claimPublicKey,
    blindingKey: created.blindingKey,
    timeoutBlockHeight: created.timeoutBlockHeight,
    refundPrivateKeyHex: refund.privHex,
    refundPublicKeyHex: refund.pubHex
  };
}
