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
 * Merchant light-profile errors (spec §5.6) — raised client-side by
 * wallet.merchant.update() BEFORE any request. Codes:
 *   MERCHANT_FIELD_NOT_EDITABLE — a field outside the 5 editable light fields
 *                                 was passed (details.field names it). The
 *                                 owner/admin-only fields (liquid_address,
 *                                 split_address, cnpj, password) are NOT part of
 *                                 this surface and can never be edited by a key.
 *   MERCHANT_UPDATE_EMPTY       — update() was called with no field to change.
 *   MERCHANT_UPDATE_INVALID     — update() was not given a fields object.
 * A server-side rejection of a light field's VALUE (bad URL, name length) or an
 * insufficient scope arrives instead as a DepixApiError (validation_error /
 * insufficient_scope), never as a MerchantError.
 */
export class MerchantError extends DepixSdkError {
  constructor(code: string, message?: string, options?: DepixSdkErrorOptions) {
    super(code, message, options);
    this.name = "MerchantError";
  }
}

/**
 * Agent self-onboarding errors (F4). Raised CLIENT-side by DepixAgent before or
 * around a signed request. Codes:
 *   agent_not_initialized    — DepixAgent.open() found no identity in dataDir;
 *                              call DepixAgent.create() (or register) first.
 *   agent_already_initialized — DepixAgent.create() refused to overwrite an
 *                              existing identity (pass { force: true } to replace).
 *   agent_store_corrupted    — the on-disk identity file is malformed.
 *   agent_key_unreadable     — the identity key could not be decrypted (wrong
 *                              passphrase or a tampered file — GCM can't tell which).
 *
 * SERVER-side rejections of a signed request arrive as `DepixApiError` (branch on
 * `err.code`), NOT as AgentError. The agent-surface codes to expect:
 *   agent_invalid_signature   — signature/headers malformed or wrong key.
 *   agent_signature_expired   — the timestamp is outside the ±window; re-sign
 *                               (details.server_time gives the server clock to resync).
 *   agent_replay_detected     — the nonce was already used; every request must use a fresh one.
 *   invalid_operator_token / operator_token_revoked — the register operator token (§2.9).
 *   registration_blocked / agent_pubkey_exists / username_taken — register conflicts.
 *   graduation_pending        — a live key was requested before the account graduated (§3.1).
 *   domain_required           — a merchant_* scope was requested without a verified domain (§2.9).
 *   agents_disabled           — the agent program kill switch is on (503).
 *   field_immutable           — an attempt to change a register-fixed field (e.g. liquid_address).
 */
export class AgentError extends DepixSdkError {
  constructor(code: string, message?: string, options?: DepixSdkErrorOptions) {
    super(code, message, options);
    this.name = "AgentError";
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
 * The SideShift subset (PR5c, §5.4 — USDt cross-network, CUSTODIAL/G4):
 *   AFFILIATE_ID_MISSING     — the DePix affiliate id was not baked into the build
 *                              (SIDESHIFT_AFFILIATE_ID unset at publish time), so no
 *                              shift can be created. Mirrors the frontend's "SideShift
 *                              is not configured" throw. (G4 dropped the acceptCustodial
 *                              gate → there is NO CUSTODIAL_NOT_ACKNOWLEDGED code; the
 *                              custodial nature is signalled in docs + custodial:true.)
 *   SIDESHIFT_AMOUNT_MISMATCH — the fixed shift's depositAmount does not match (or
 *                              exceeds) the quoted amount — fail-closed before signing.
 *
 * The intent-layer subset (PR-B, wallet.quote()/wallet.convert() — every one of
 * these carries an actionable `details.nextStep`, G3):
 *   MULTIPLE_ROUTES_AVAILABLE  — the intent trio resolves to more than one
 *                              candidate (two entry rails, an inbound intent
 *                              with an unknown source network, several
 *                              compositions). The SDK never chooses:
 *                              `details.routes` lists every candidate; quote()
 *                              compares them and convert({route}) executes one
 *                              (multi-hop routes run end to end behind a
 *                              persisted plan — PR-C).
 *   PLAN_VALIDATION_FAILED     — a stored multi-hop conversion plan failed
 *                              AES-GCM authentication (tampered) — discarded,
 *                              never acted upon (PR-C).
 *   ROUTE_NOT_FOUND            — a `route` id that is not among the intent's
 *                              candidates (details.availableRouteIds lists them).
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

/**
 * A network/HTTP error from the SideShift REST API (sideshift.ai/api/v2, §5.4).
 * SideShift replies `{ error: { message } }` with NO machine-readable code, so the
 * message is upstream (untrusted) text — this is its own DepixSdkError carrying the
 * upstream status/body (mirrors BoltzApiError / CryptorefillsApiError), NOT a
 * ConversionError (whose catalog is our OWN closed set of fail-closed guards).
 *
 * Kept distinct from `SideSwapError` (the WS provider): SideShift is a REST provider
 * whose `.message` is set VERBATIM from an upstream body, so mapToolError (§6.2e)
 * routes it to `data.untrusted_api_message` BY CONSTRUCTION — it is deliberately NOT
 * in the SDK-authored allowlist, so an injected upstream string can never reach a
 * tool message.
 */
export class SideShiftApiError extends DepixSdkError {
  readonly status?: number;
  readonly body?: unknown;

  constructor(message: string, init: { status?: number; body?: unknown; cause?: unknown } = {}) {
    super("SIDESHIFT_API_ERROR", message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "SideShiftApiError";
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
