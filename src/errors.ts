// Typed error hierarchy (spec §7.1). Consumers discriminate on `err.code`
// string literals; classes group codes by domain. `DepixApiError` (HTTP
// envelope of the DePix API) and `WithdrawContractError` arrive here in PR2
// (api client + withdraw contract). `ConversionError` still arrives with the
// conversion flows (PR4+).

/** Structured data attached to an error, safe to surface to callers. */
export type ErrorDetails = Record<string, unknown>;

export interface DepixSdkErrorOptions {
  cause?: unknown;
  details?: ErrorDetails;
}

export class DepixSdkError extends Error {
  readonly code: string;
  readonly details?: ErrorDetails;

  constructor(code: string, message?: string, options?: DepixSdkErrorOptions) {
    super(message ?? code, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "DepixSdkError";
    this.code = code;
    if (options?.details !== undefined) {
      this.details = options.details;
    }
  }
}

/**
 * Wallet lifecycle / engine errors.
 *
 * Codes used in PR1 (see spec §7.1 for the full catalog):
 *   INVALID_MNEMONIC, DESCRIPTOR_MISMATCH, WRONG_PASSPHRASE, WEAK_PASSPHRASE,
 *   WALLET_NOT_FOUND, WALLET_CORRUPTED, WALLET_ALREADY_EXISTS,
 *   WALLET_DIR_LOCKED, BACKUP_REQUIRED (§2.9), INVALID_ADDRESS, INVALID_AMOUNT,
 *   UNSUPPORTED_ASSET, INSUFFICIENT_FUNDS, INSUFFICIENT_LBTC_FOR_FEE,
 *   ESPLORA_UNAVAILABLE, BROADCAST_FAILED
 *
 * WALLET_CORRUPTED (distinct from WALLET_NOT_FOUND): a wallet.json is present
 * but unreadable (invalid JSON / unknown format-version). Callers branching on
 * err.code must NOT react by creating a fresh wallet — the file is recoverable.
 */
export class WalletError extends DepixSdkError {
  constructor(code: string, message?: string, options?: DepixSdkErrorOptions) {
    super(code, message, options);
    this.name = "WalletError";
  }
}

export interface GuardrailDetails extends ErrorDetails {
  limitCents?: number;
  attemptedCents?: number;
  usedCents?: number;
  /** For GUARDRAIL_ALLOWLIST_BLOCKED: the destination class that was blocked (§4.3). */
  class?: string;
}

/**
 * Guardrail choke-point errors (spec §4).
 *
 * Codes: GUARDRAIL_PER_TX_LIMIT, GUARDRAIL_DAILY_LIMIT, GUARDRAIL_INVALID_AMOUNT,
 * QUOTES_UNAVAILABLE, GUARDRAIL_ALLOWLIST_BLOCKED (§4.3 allowlist),
 * GUARDRAIL_CONFIG_INVALID (§4.2 — a bad option/env limit or allowlist, thrown
 * at open()/create()/restore(); 0/negative is never "disabled").
 */
export class GuardrailError extends DepixSdkError {
  declare readonly details?: GuardrailDetails;

  constructor(
    code: string,
    message?: string,
    options?: DepixSdkErrorOptions & { details?: GuardrailDetails }
  ) {
    super(code, message, options);
    this.name = "GuardrailError";
  }
}

/**
 * Structured `details` block of a DePix API error envelope (spec §7.1).
 * Every field is optional — provider (Eulen) rejections arrive as
 * `validation_error` with NO `details` at all (only `legacyErrorMessage`),
 * so nothing here is guaranteed.
 */
export interface DepixApiErrorDetails extends ErrorDetails {
  field?: string;
  required_scope?: string;
  min_cents?: number;
  max_cents?: number;
  limit?: string; // "per_tx" | "daily" | "first_deposit" | "cumulative" | …
  limit_cents?: number;
  used_cents?: number;
}

export interface DepixApiErrorInit {
  status: number;
  requestId?: string;
  retryAfter?: number;
  docsUrl?: string;
  details?: DepixApiErrorDetails;
  /** response.errorMessage (PT, provider-preserved) — NEVER surfaced to an MCP host verbatim (§6.2.e). */
  legacyErrorMessage?: string;
  /** details.field, falling back to legacy response.errors[0].field (§7.1). */
  field?: string;
  /** details.required_scope — the ONLY sanctioned scope-discovery path (§7.1). */
  requiredScope?: string;
  cause?: unknown;
}

/**
 * HTTP error from the DePix API — the structured envelope
 * `{ error: { code, message, request_id, retry_after?, docs_url, details? } }`
 * mapped to a typed error (spec §7.1). `code` is a member of the ERROR_CATALOG
 * (unknown codes do NOT break — they map to a generic DepixApiError,
 * forward-compatible). `details.field` and `details.required_scope` are hoisted
 * to first-class `field` / `requiredScope`. The provider's PT message, when
 * present, is preserved in `legacyErrorMessage` and never leaks into MCP tool
 * text (§6.2.e).
 */
export class DepixApiError extends DepixSdkError {
  readonly status: number;
  readonly requestId?: string;
  readonly retryAfter?: number;
  readonly docsUrl?: string;
  readonly legacyErrorMessage?: string;
  readonly field?: string;
  readonly requiredScope?: string;
  declare readonly details?: DepixApiErrorDetails;

  constructor(code: string, message: string | undefined, init: DepixApiErrorInit) {
    super(code, message, { cause: init.cause, details: init.details });
    this.name = "DepixApiError";
    this.status = init.status;
    if (init.requestId !== undefined) this.requestId = init.requestId;
    if (init.retryAfter !== undefined) this.retryAfter = init.retryAfter;
    if (init.docsUrl !== undefined) this.docsUrl = init.docsUrl;
    if (init.legacyErrorMessage !== undefined) this.legacyErrorMessage = init.legacyErrorMessage;
    if (init.field !== undefined) this.field = init.field;
    if (init.requiredScope !== undefined) this.requiredScope = init.requiredScope;
  }
}

/**
 * Withdraw-contract violations detected LOCALLY, before anything is signed
 * (spec §3.2 / §3.2.9).
 *
 * Codes: FEE_ADDRESS_NOT_EXPLICIT (fee output would be confidential →
 * unverifiable by the F0.9 cron → account block; fail-closed BEFORE signing),
 * WITHDRAW_SPLIT_MISMATCH (NET + fee ≠ GROSS), PENDING_RECORD_TAMPERED (a
 * pending-withdrawals record failed AES-256-GCM authentication — discarded,
 * never signed from).
 */
export class WithdrawContractError extends DepixSdkError {
  constructor(code: string, message?: string, options?: DepixSdkErrorOptions) {
    super(code, message, options);
    this.name = "WithdrawContractError";
  }
}

/** Narrow an unknown value to a DepixSdkError, optionally matching a code. */
export function isDepixSdkError(err: unknown, code?: string): err is DepixSdkError {
  if (!(err instanceof DepixSdkError)) return false;
  if (code === undefined) return true;
  return err.code === code;
}
