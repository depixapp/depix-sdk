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

/**
 * Conversion-flow failures (spec §5 / §7.1). The code list is CLOSED (no
 * "..."): every conversion outcome maps to one of these. PR4 (SideSwap) uses
 * SWAP_VALIDATION_FAILED (the fail-closed secondary check, G3 §5.1),
 * SWAP_LOW_BALANCE (dealer-side insufficient liquidity), SWAP_QUOTE_EXPIRED and
 * PEG_IN_ALREADY_PENDING (§5.2, one in-flight peg-in at a time).
 *
 * The Boltz PR5 subset:
 *   LOCKUP_INFLATED       — Boltz's expectedAmount exceeds the invoice + bounded
 *                           fee margin (assertLockupNotInflated, §5.3).
 *   LOCKUP_TREE_MISMATCH  — the re-derived swap tree / lockup script does NOT
 *                           match Boltz's response (verify-lockup, §5.3). It binds
 *                           to the payment hash of the SUPPLIED invoice — an
 *                           attacker-chosen payee still verifies, which is WHY
 *                           the allowlist treats the Lightning payee as free.
 *   INVOICE_HASH_MISMATCH — a reverse-swap invoice Boltz returned does not pay
 *                           against OUR preimage hash (§5.3 receive).
 *   INVOICE_NO_AMOUNT     — an amount-less / unparseable BOLT11 (no trusted
 *                           ceiling to lock against, §5.3).
 *   TIMEOUT_OUT_OF_BOUNDS — the refund timeout height is out of the sane bound
 *                           (MAX_SUBMARINE_TIMEOUT_BLOCKS for LN; MAX_CHAIN_
 *                           TIMEOUT_BLOCKS for the stablecoin chain swap, §5.3).
 *
 * The gift-card subset (PR6):
 *   GIFTCARDS_DISABLED     — the backend has the CryptoRefills integration OFF
 *                            (/api/config `giftcardEnabled` is false, or the
 *                            config is unreachable → fail-closed, §5.5).
 *   GIFTCARD_KYC_CATEGORY  — the selected brand is a KYC-gated "e-money" product
 *                            (Rewarble VISA/PayPal, iCash, …) the anonymous
 *                            browser-direct Lightning flow cannot fulfil; the
 *                            typed error carries the external deep-link (§5.5).
 *
 * The stablecoin subset (PR5b, Boltz stablecoin, G5 — L-BTC → USDC/USDT EVM) reuses
 * SWAP_VALIDATION_FAILED (unsupported target / invalid or token-contract
 * destination / uneconomical amount), LOCKUP_INFLATED (route asks to lock more than
 * requested, or ≤ 0), LOCKUP_TREE_MISMATCH (chain-swap verify-lockup) and adds
 * STABLECOIN_DEPS_MISSING — the EVM signing stack (viem) could not be dynamically
 * resolved (§2.2). viem is a REGULAR dependency (G5), so this is a defense-in-depth
 * guard for a broken/partial install, never the norm.
 *
 * The remaining codes (CUSTODIAL_NOT_ACKNOWLEDGED, AFFILIATE_ID_MISSING) arrive
 * with the SideShift/affiliate flows.
 */
export class ConversionError extends DepixSdkError {
  constructor(code: string, message?: string, options?: DepixSdkErrorOptions) {
    super(code, message, options);
    this.name = "ConversionError";
  }
}

/**
 * SideSwap WebSocket transport / protocol error (spec §5.1). Kept distinct from
 * the semantic ConversionError the same way ESPLORA_UNAVAILABLE/BROADCAST_FAILED
 * are transport WalletErrors, not conversion outcomes. Codes come from
 * `SS_ERROR` (sideswap-client.ts, frontend parity): NOT_CONNECTED, TIMEOUT,
 * CONNECTION_LOST, SERVER_ERROR, INVALID_RESPONSE, LOW_BALANCE, NO_MARKET.
 * Extends DepixSdkError so callers can narrow with isDepixSdkError.
 */
export class SideSwapError extends DepixSdkError {
  constructor(code: string, message?: string, options?: DepixSdkErrorOptions) {
    super(code, message, options);
    this.name = "SideSwapError";
  }
}

/**
 * A network/HTTP error from the Boltz REST/WS API (api.boltz.exchange, §5.3).
 * Distinct from ConversionError (whose list is closed and covers our OWN
 * fail-closed guards) — a provider transport failure is not one of those codes,
 * so it is its own DepixSdkError with the upstream status/body attached.
 */
export class BoltzApiError extends DepixSdkError {
  readonly status?: number;
  readonly body?: unknown;

  constructor(message: string, init: { status?: number; body?: unknown; cause?: unknown } = {}) {
    super("BOLTZ_API_ERROR", message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "BoltzApiError";
    if (init.status !== undefined) this.status = init.status;
    if (init.body !== undefined) this.body = init.body;
  }
}

/**
 * A network/HTTP error from the CryptoRefills REST API (api.cryptorefills.com,
 * §5.5). Distinct from ConversionError (the closed catalog of our OWN gift-card
 * guards) — a catalog/order transport failure is not one of those codes, so it
 * is its own DepixSdkError with the upstream status/body attached (mirrors
 * BoltzApiError). A 422 `LOGIN_REQUIRED` body is mapped by the gift-card
 * namespace to the typed GIFTCARD_KYC_CATEGORY (not surfaced raw).
 */
export class CryptorefillsApiError extends DepixSdkError {
  readonly status?: number;
  readonly body?: unknown;

  constructor(message: string, init: { status?: number; body?: unknown; cause?: unknown } = {}) {
    super("CRYPTOREFILLS_API_ERROR", message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "CryptorefillsApiError";
    if (init.status !== undefined) this.status = init.status;
    if (init.body !== undefined) this.body = init.body;
  }
}

/** Narrow an unknown value to a DepixSdkError, optionally matching a code. */
export function isDepixSdkError(err: unknown, code?: string): err is DepixSdkError {
  if (!(err instanceof DepixSdkError)) return false;
  if (code === undefined) return true;
  return err.code === code;
}
