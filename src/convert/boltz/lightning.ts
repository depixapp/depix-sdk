// Pure Lightning (submarine/reverse) helpers — BOLT11 decoding + the fail-closed
// guards (spec §5.3). No network, no WASM, no wallet — HTTP + arithmetic only,
// so these are exhaustively unit-testable. Near-literal port of
// depix-frontend/wallet/boltz/lightning.js with the tagged-Error guards replaced
// by typed ConversionError codes.

import { bech32 } from "@scure/base";
import { ConversionError } from "../../errors.js";

// Raw Boltz submarine statuses → coarse internal buckets.
const SUBMARINE_STATUS: Readonly<Record<string, SubmarineBucket>> = Object.freeze({
  "swap.created": "pending",
  "transaction.mempool": "pending",
  "transaction.confirmed": "pending",
  "invoice.set": "pending",
  "invoice.pending": "paying",
  "invoice.paid": "paying",
  "transaction.claim.pending": "paying",
  "transaction.claimed": "completed",
  "invoice.failedToPay": "refund",
  "invoice.expired": "refund",
  "swap.expired": "refund",
  "transaction.lockupFailed": "refund",
  "transaction.refunded": "refunded",
  "swap.refunded": "refunded"
});

export type SubmarineBucket = "pending" | "paying" | "completed" | "refund" | "refunded";

export function mapSubmarineStatus(raw: unknown): SubmarineBucket | null {
  return typeof raw === "string" ? (SUBMARINE_STATUS[raw] ?? null) : null;
}

// BOLT11 amount multipliers as a fraction of 1 BTC (BOLT #11): m=10^-3, u=10^-6,
// n=10^-9, p=10^-12. 1 BTC = 10^8 sat = 10^11 msat, so the amount in msat is
// digits * 10^11 * <multiplier-fraction>. We work in millisats to stay exact for
// the `p` multiplier (sub-satoshi), then require a whole number of sats.
const BOLT11_MSAT_PER_BTC = 100_000_000_000n; // 10^8 sat * 10^3 msat
const BOLT11_MULTIPLIER_DIV: Readonly<Record<string, bigint>> = Object.freeze({
  m: 1_000n,
  u: 1_000_000n,
  n: 1_000_000_000n,
  p: 1_000_000_000_000n
});

/**
 * Decode the amount of a BOLT11 invoice to whole satoshis, parsing ONLY the
 * human-readable part (`lnbc…<amount><multiplier>1`). No bech32/signature
 * verification (unnecessary for an amount check).
 *
 * Returns null for amount-less invoices (payer chooses the amount) or an
 * unparseable HRP — callers MUST treat null as "cannot validate" and refuse to
 * lock funds.
 */
export function decodeInvoiceAmountSats(invoice: unknown): number | null {
  if (typeof invoice !== "string") return null;
  const lower = invoice.trim().toLowerCase();
  const sepIndex = lower.lastIndexOf("1");
  if (sepIndex <= 0) return null;
  const hrp = lower.slice(0, sepIndex);
  const m = /^ln(bc|tb|bcrt|tbs|sb)([0-9]+)?([munp])?$/.exec(hrp);
  if (!m) return null;
  const digits = m[2];
  const multiplier = m[3];
  if (!digits) return null; // no amount encoded (trailing multiplier w/o digits is malformed too)
  let msat: bigint;
  const amount = BigInt(digits);
  if (multiplier) {
    const div = BOLT11_MULTIPLIER_DIV[multiplier];
    if (div === undefined) return null;
    const numerator = amount * BOLT11_MSAT_PER_BTC;
    // The `p` multiplier may encode sub-msat; BOLT11 forbids that.
    if (numerator % div !== 0n) return null;
    msat = numerator / div;
  } else {
    msat = amount * BOLT11_MSAT_PER_BTC; // no multiplier => whole BTC
  }
  if (msat % 1000n !== 0n) return null; // lockups are whole sats
  const sats = msat / 1000n;
  if (sats <= 0n || sats > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(sats);
}

// How much over the invoice amount the wallet may lock to cover Boltz's swap +
// on-chain fees: a proportional margin plus a small fixed allowance. A quoted
// expectedAmount above this ceiling means a buggy/tampered Boltz response.
export const LOCKUP_FEE_MARGIN = 0.05;
export const LOCKUP_FIXED_ALLOWANCE_SATS = 2000;

/**
 * Assert Boltz's quoted lockup amount is not inflated beyond the invoice + a
 * bounded fee margin (ceil(invoiceSats * 1.05) + 2000). Throws ConversionError
 * (fail-closed, §5.3) — refuse to lock rather than over-pay.
 */
export function assertLockupNotInflated(expectedAmount: number, invoiceSats: number | null): void {
  if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) {
    throw new ConversionError(
      "LOCKUP_INFLATED",
      "Invalid Boltz lockup amount — payment cancelled for safety."
    );
  }
  if (invoiceSats == null) {
    // Amount-less invoice / undecodable HRP: no trusted ceiling → refuse rather
    // than lock an unbounded amount.
    throw new ConversionError(
      "INVOICE_NO_AMOUNT",
      "Could not read the Lightning invoice amount to validate the payment — cancelled for safety."
    );
  }
  const ceiling = Math.ceil(invoiceSats * (1 + LOCKUP_FEE_MARGIN)) + LOCKUP_FIXED_ALLOWANCE_SATS;
  if (expectedAmount > ceiling) {
    throw new ConversionError(
      "LOCKUP_INFLATED",
      `Lockup amount ${expectedAmount} sats exceeds the ceiling ${ceiling} for this invoice — ` +
        "cancelled for safety."
    );
  }
}

/**
 * Sane-bound the submarine refund timeout height (spec §5.3). Best-effort: when
 * the current chain height is unknown (read failed) the bound is skipped (parity
 * with the frontend). When known, the timeout must be strictly in the future and
 * within `maxTimeoutBlocks` — otherwise TIMEOUT_OUT_OF_BOUNDS (fail-closed).
 *
 * VALUE: reconciled to the PROD frontend LN-send path (wallet-ui.js
 * onLightningPreview → MAX_SUBMARINE_TIMEOUT_BLOCKS = 20160, ≈14 days of Liquid
 * blocks). The 1500 constant belongs to a DIFFERENT frontend path (gift-card
 * payment, giftcard-payment.js) and would reject VALID Boltz submarine lockups
 * whose real timeout exceeds +1500 blocks with TIMEOUT_OUT_OF_BOUNDS. Kept
 * overridable (`maxTimeoutBlocks`) so the effective bound is still a one-line
 * change if live Boltz timeouts move.
 */
export const MAX_SUBMARINE_TIMEOUT_BLOCKS = 20160;

export function assertTimeoutInBounds(
  timeoutBlockHeight: unknown,
  currentHeight: number | null,
  maxTimeoutBlocks: number = MAX_SUBMARINE_TIMEOUT_BLOCKS
): void {
  const timeout = Number(timeoutBlockHeight);
  if (currentHeight == null || !Number.isFinite(currentHeight) || !Number.isFinite(timeout)) {
    return; // best-effort — height unknown, skip the bound (frontend parity)
  }
  if (timeout <= currentHeight || timeout > currentHeight + maxTimeoutBlocks) {
    throw new ConversionError(
      "TIMEOUT_OUT_OF_BOUNDS",
      `Boltz refund timeout height ${timeout} is out of bounds relative to chain height ` +
        `${currentHeight} (max +${maxTimeoutBlocks}) — cancelled for safety.`
    );
  }
}

// BOLT11 signature = 104 words at the end of the data part; timestamp = first 7
// words; payment_hash (tag 1) = 256 bits → 52 words.
const BOLT11_SIGNATURE_WORDS = 104;
const BOLT11_TIMESTAMP_WORDS = 7;
const BOLT11_PAYMENT_HASH_TAG = 1;
const BOLT11_PAYMENT_HASH_WORDS = 52;

/**
 * Decode the payment_hash of a BOLT11 invoice (64-char lowercase hex), or null
 * if unparseable. Walks the tagged fields of the bech32 data part — no signature
 * verification (the caller only compares the hash against a locally-generated
 * preimage hash). Used by the reverse (receive) flow to verify Boltz's invoice
 * pays against OUR preimage — without it a compromised Boltz could substitute an
 * invoice whose preimage it controls.
 */
export function decodeInvoicePaymentHash(invoice: unknown): string | null {
  if (typeof invoice !== "string") return null;
  let decoded;
  try {
    decoded = bech32.decode(invoice.trim().toLowerCase() as `${string}1${string}`, 2048);
  } catch {
    return null;
  }
  if (!/^ln(bc|tb|bcrt|tbs|sb)/.test(decoded.prefix)) return null;
  const words = decoded.words;
  const fieldsEnd = words.length - BOLT11_SIGNATURE_WORDS;
  let i = BOLT11_TIMESTAMP_WORDS;
  while (i + 3 <= fieldsEnd) {
    const tag = words[i]!;
    const len = words[i + 1]! * 32 + words[i + 2]!;
    const start = i + 3;
    const end = start + len;
    if (end > fieldsEnd) return null;
    if (tag === BOLT11_PAYMENT_HASH_TAG && len === BOLT11_PAYMENT_HASH_WORDS) {
      try {
        const bytes = bech32.fromWords(words.slice(start, end));
        let s = "";
        for (let j = 0; j < bytes.length; j++) s += bytes[j]!.toString(16).padStart(2, "0");
        return s;
      } catch {
        return null;
      }
    }
    i = end;
  }
  return null;
}
