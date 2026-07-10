// withdraw() contract — pure, offline-testable helpers (spec §3.2).
//
// The orchestration (mutex, POST, sign, broadcast, pending/resume) lives on
// DepixWallet; everything here is a side-effect-free validator so the F0.9
// fee-output contract is unit-testable without funds or a network:
//   - normalizeWithdrawResponse: NET / GROSS (= total ?? deposit, §3.2.4) /
//     payout, fee presence, arithmetic fail-closed on every amount.
//   - assertFeeAddressExplicit: fail-closed FEE_ADDRESS_NOT_EXPLICIT when the
//     fee_address is confidential (lq1) or unparseable — paying a blinded fee
//     is "unpaid" to the F0.9 verifier, which blocks the account (§3.2.3).
//   - assertSplitConsistent: NET + fee === GROSS or WITHDRAW_SPLIT_MISMATCH.
//   - assertWithdrawPsetOutputs: re-pins the built PSET — the Eulen output pays
//     depositAddress's script, and (when fee'd) the fee output is EXPLICIT
//     (readable asset+value) paying the fee script exactly (§3.2.5).

import { ASSETS, DEPIX_SATS_PER_BRL_CENT } from "../assets.js";
import { Address } from "../engine/lwk.js";
import { WithdrawContractError } from "../errors.js";
import type { WithdrawWireResponse } from "../api/client.js";

export type WithdrawMode = "send" | "payout";

export interface NormalizedWithdraw {
  withdrawalId: string;
  depositAddress: string;
  /** NET DePix that must reach Eulen (output A). */
  netCents: number;
  /** GROSS leaving the wallet — guardrail counts this (§3.2.4). */
  grossCents: number;
  /** BRL that lands on the Pix. */
  payoutCents: number;
  /** True when the split fee fields are present (§3.2.2 branch). */
  hasFee: boolean;
  feeCents: number | null;
  feeAddress: string | null;
  sandbox: boolean;
}

function assertPositiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new WithdrawContractError(
      "WITHDRAW_SPLIT_MISMATCH",
      `withdraw response ${label} is not a positive integer: ${String(value)}`
    );
  }
  return value;
}

/**
 * Normalize the authenticated withdraw response into the values the flow acts
 * on. GROSS = totalDepositAmountInCents ?? depositAmountInCents (§3.2.4): the
 * fallback is normative — without it a split-less response would pass
 * `undefined` to the guardrail and `NaN > limit === false` would slip past both
 * ceilings (arithmetic fail-open). fee fields are present together or not at
 * all (§3.2.2 single-output branch).
 */
export function normalizeWithdrawResponse(wire: WithdrawWireResponse): NormalizedWithdraw {
  const sandbox = wire.sandbox === true;
  const netCents = assertPositiveInt(wire.depositAmountInCents, "depositAmountInCents");
  const payoutCents = assertPositiveInt(wire.payoutAmountInCents, "payoutAmountInCents");
  const grossCents =
    wire.totalDepositAmountInCents !== undefined
      ? assertPositiveInt(wire.totalDepositAmountInCents, "totalDepositAmountInCents")
      : netCents;

  const hasFeeCents = wire.fee_cents !== undefined && wire.fee_cents !== null;
  const hasFeeAddress = typeof wire.fee_address === "string" && wire.fee_address.length > 0;
  // The backend emits fee_cents and fee_address together (§3.2.2). A partial
  // pair is a contract violation — treat as mismatch rather than silently
  // dropping the fee output (which would evade F0.9).
  if (hasFeeCents !== hasFeeAddress) {
    throw new WithdrawContractError(
      "WITHDRAW_SPLIT_MISMATCH",
      "withdraw response has only one of fee_cents / fee_address — the pair must be present together"
    );
  }

  const hasFee = hasFeeCents && hasFeeAddress;
  const feeCents = hasFee ? assertPositiveInt(wire.fee_cents, "fee_cents") : null;

  return {
    withdrawalId: String(wire.withdrawalId),
    depositAddress: String(wire.depositAddress),
    netCents,
    grossCents,
    payoutCents,
    hasFee,
    feeCents,
    feeAddress: hasFee ? String(wire.fee_address) : null,
    sandbox
  };
}

/**
 * Fail-closed BEFORE signing (§3.2.3): the fee_address must parse as a Liquid
 * address WITHOUT a blinding key (the ex1 explicit form). A confidential (lq1)
 * or unparseable address would make the fee output blinded/absent → the F0.9
 * cron reads it as unpaid → the account is blocked. Returns the parsed Address
 * (caller frees it).
 */
export function assertFeeAddressExplicit(feeAddress: string): InstanceType<typeof Address> {
  let addr: InstanceType<typeof Address>;
  try {
    addr = new Address(feeAddress);
  } catch (err) {
    throw new WithdrawContractError(
      "FEE_ADDRESS_NOT_EXPLICIT",
      `fee_address is not a parseable Liquid address: ${feeAddress}`,
      { cause: err }
    );
  }
  if (addr.isBlinded()) {
    try {
      addr.free();
    } catch {
      // best effort
    }
    throw new WithdrawContractError(
      "FEE_ADDRESS_NOT_EXPLICIT",
      "fee_address is confidential (lq1) — the fee output would be blinded and " +
        "unverifiable by the F0.9 cron, which blocks the account. Aborting before signing."
    );
  }
  return addr;
}

/** NET + fee === GROSS, or WITHDRAW_SPLIT_MISMATCH (§3.2.4). */
export function assertSplitConsistent(netCents: number, feeCents: number, grossCents: number): void {
  if (netCents + feeCents !== grossCents) {
    throw new WithdrawContractError(
      "WITHDRAW_SPLIT_MISMATCH",
      `NET (${netCents}) + fee (${feeCents}) !== GROSS (${grossCents})`,
      { details: { netCents, feeCents, grossCents } }
    );
  }
}

/** 1 BRL cent → 10^6 DePix base units (§3.2.5). */
export function centsToDepixSats(cents: number): bigint {
  return BigInt(cents) * DEPIX_SATS_PER_BRL_CENT;
}

// ─── PSET output re-pin (§3.2.5) ─────────────────────────────────────────────

interface ScriptLike {
  toString(): string;
}
interface AssetLike {
  toString(): string;
}
export interface PsetOutputLike {
  scriptPubkey(): ScriptLike;
  amount(): bigint | undefined;
  asset(): AssetLike | undefined;
}
export interface PsetLike {
  outputs(): PsetOutputLike[];
}

export interface WithdrawOutputExpectation {
  /** scriptPubkey hex of depositAddress (Eulen — output A, confidential). */
  depositScriptHex: string;
  netSats: bigint;
  /** Present iff the split fee is active — scriptPubkey hex of the ex1 fee address. */
  feeScriptHex?: string;
  feeSats?: bigint;
}

const DEPIX_ASSET_ID = ASSETS.DEPIX.id;

/**
 * Pre-signature validation of the built PSET (§3.2.5). Output A (Eulen) is
 * confidential, so only its script can be pinned (value/asset are blinded).
 * Output B (fee) MUST be EXPLICIT: readable asset+value, paying the fee script
 * exactly — that explicitness is what lets the F0.9 cron verify it on-chain. A
 * blinded fee output here is fatal (FEE_ADDRESS_NOT_EXPLICIT).
 */
export function assertWithdrawPsetOutputs(pset: PsetLike, expect: WithdrawOutputExpectation): void {
  const outputs = pset.outputs();

  const paysDeposit = outputs.some((o) => o.scriptPubkey().toString() === expect.depositScriptHex);
  if (!paysDeposit) {
    throw new WithdrawContractError(
      "WITHDRAW_SPLIT_MISMATCH",
      "built PSET does not pay the Eulen depositAddress (output A script not found)"
    );
  }

  if (expect.feeScriptHex === undefined) return;

  const feeOutput = outputs.find((o) => o.scriptPubkey().toString() === expect.feeScriptHex);
  if (!feeOutput) {
    throw new WithdrawContractError(
      "WITHDRAW_SPLIT_MISMATCH",
      "built PSET does not pay the fee address (output B script not found)"
    );
  }
  const amount = feeOutput.amount();
  const asset = feeOutput.asset();
  if (amount === undefined || asset === undefined) {
    throw new WithdrawContractError(
      "FEE_ADDRESS_NOT_EXPLICIT",
      "fee output is blinded (asset/value not explicit) — F0.9 cannot verify it on-chain"
    );
  }
  if (amount !== expect.feeSats) {
    throw new WithdrawContractError(
      "WITHDRAW_SPLIT_MISMATCH",
      `fee output value ${amount} !== expected ${expect.feeSats}`
    );
  }
  if (asset.toString() !== DEPIX_ASSET_ID) {
    throw new WithdrawContractError(
      "WITHDRAW_SPLIT_MISMATCH",
      `fee output asset ${asset.toString()} is not DePix`
    );
  }
}
