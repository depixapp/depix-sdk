// Tool-error translation with the anti-injection discipline ported VERBATIM
// from the F2 remote MCP (depix-mcp/src/errors.ts), adapted to the SDK's typed
// error hierarchy (spec §6.2e / §7.1).
//
// MCP↔API TRUST BOUNDARY. The host LLM reads a tool-error `message` as part of
// its context. So for a DepixApiError the `message` is a function of `error.code`
// ONLY — canned English prose written here. The provider's free text
// (`legacyErrorMessage`, the Portuguese `response.errorMessage`; and the upstream
// `error.message`) is CONTENT, never code: concatenating it into the message
// would open a second-order prompt-injection channel. It is routed to
// `data.api_message`, truncated and explicitly labeled UNTRUSTED. Only low-risk
// STRUCTURED fields (required_scope from a closed set, numbers, a regex-guarded
// short `field`) are interpolated into the message.
//
// Errors the SDK itself raises (WalletError, GuardrailError, …) carry OUR own
// canned English message — safe to surface — plus a sanitized `details` block.

import {
  DepixApiError,
  DepixSdkError,
  type DepixApiErrorDetails,
} from "../errors.js";

/** The closed set of API-key scopes (OpenAPI 0.6.0). */
export const SCOPES = ["merchant_read", "merchant_write", "wallet_read", "wallet_write"] as const;
export type Scope = (typeof SCOPES)[number];

const UNTRUSTED_MAX = 300;

/** A tool-execution error surfaced to the agent as an isError tool result. */
export class ToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly data: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    opts: { retryable?: boolean; data?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.data = opts.data ?? {};
  }
}

/** Clear error when no API key is configured (deposit/withdraw/wait need one). */
export function missingApiKeyError(): ToolError {
  return new ToolError(
    "No DePix API key is configured on this MCP server. Set the DEPIX_API_KEY environment variable " +
      "(sk_test_ for sandbox, sk_live_ for production) and restart — tools cannot set it.",
    "api_key_required",
  );
}

// ── helpers ──
function truncate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length > UNTRUSTED_MAX ? value.slice(0, UNTRUSTED_MAX) + "…" : value;
}
function asInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function asScope(value: unknown): Scope | undefined {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value)
    ? (value as Scope)
    : undefined;
}
// A short, safe field identifier — regex-guarded so crafted free text cannot be
// smuggled into the tool message via `details.field` (§6.2e).
function asFieldName(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.]{1,64}$/.test(value) ? value : undefined;
}
function retryAfterPhrase(seconds: number | undefined): string {
  return seconds !== undefined ? `${seconds}s` : "a moment";
}

/** API error codes the agent may retry (advisory — the api client already retries transient). */
export const AUTO_RETRY_CODES = new Set<string>([
  "rate_limited",
  "merchant_rate_limited",
  "payer_velocity_limit",
  "service_unavailable",
  "platform_shutdown",
  "upstream_error",
  "idempotency_in_flight",
]);

/** Canned English message for a DePix API error — a function of `code` ONLY. */
function cannedApiMessage(
  code: string,
  status: number,
  details: DepixApiErrorDetails | undefined,
  requiredScope: string | undefined,
  retryAfter: number | undefined,
): string {
  const field = asFieldName(details?.field);
  const minCents = asInt(details?.min_cents);
  const maxCents = asInt(details?.max_cents);
  const limitCents = asInt(details?.limit_cents);
  const usedCents = asInt(details?.used_cents);
  const scope = asScope(requiredScope);

  switch (code) {
    case "unauthorized":
      return "Authentication failed. Provide a valid `sk_` API key.";
    case "invalid_api_key":
      return "Invalid or unknown API key. Check the `sk_` you configured.";
    case "invalid_token":
      return "Invalid token. The wallet MCP authenticates with `sk_` keys only.";
    case "insufficient_scope":
      return scope
        ? `Your key lacks the \`${scope}\` scope for this tool. Ask the owner to create a key with that scope.`
        : "Your key lacks the scope required by this tool. Ask the owner to add the required scope.";
    case "account_blocked":
      return "This account is blocked. Contact support.";
    case "merchant_required":
      return "Your key is valid but has no merchant profile.";
    case "live_access_required":
      return "This action requires a verified live key (sk_live_).";
    case "whatsapp_verification_required":
      return "This action requires WhatsApp verification on the OWNER's account. Ask the owner to verify it in the app — the agent cannot.";
    case "withdraw_disabled":
      return "Withdrawals are currently disabled for this account.";
    case "external_wallet_disabled":
      return "External-wallet withdrawals are disabled for this account.";
    case "sandbox_only":
      return "This action is sandbox-only. Use an sk_test_ key.";
    case "tax_number_required":
      return "A tax number is required. Pass the payer's CPF/CNPJ (payer_tax_number).";
    case "validation_error":
      return field
        ? `Invalid input for field \`${field}\`. See error.data for details.`
        : "Invalid input. See error.data for details.";
    case "amount_out_of_range":
      return minCents !== undefined && maxCents !== undefined
        ? `Amount must be between ${minCents} and ${maxCents} BRL cents.`
        : "Amount is out of the accepted range for this endpoint.";
    case "account_limit_exceeded":
    case "key_limit_exceeded":
      return limitCents !== undefined && usedCents !== undefined
        ? `Spending limit reached (used ${usedCents} of ${limitCents} BRL cents).`
        : limitCents !== undefined
          ? `Spending limit reached (limit ${limitCents} BRL cents).`
          : "Spending limit reached for this key/account.";
    case "not_found":
      return "Resource not found (or not owned by this key).";
    case "conflict":
      return "Conflicting state — the resource cannot transition as requested.";
    case "idempotency_in_flight":
      return `A request with this idempotency key is already in flight. Retry after ${retryAfterPhrase(retryAfter)}.`;
    case "idempotency_key_reuse":
      return "This idempotency key was already used with a different payload.";
    case "payer_velocity_limit":
      return `Too many charges for this payer. Retry after ${retryAfterPhrase(retryAfter)}.`;
    case "rate_limited":
      return `Rate limited. Retry after ${retryAfterPhrase(retryAfter)}.`;
    case "merchant_rate_limited":
      return `Rate limited (merchant, 30/min). Retry after ${retryAfterPhrase(retryAfter)}.`;
    case "platform_shutdown":
      return `The DePix platform is temporarily shut down. Retry after ${retryAfterPhrase(retryAfter)}.`;
    case "service_unavailable":
      return `DePix API temporarily unavailable. Retry after ${retryAfterPhrase(retryAfter)}.`;
    case "upstream_error":
      return "Upstream provider error at the DePix API. Please retry.";
    case "internal_error":
      return "Internal error at the DePix API. Quote request_id in a support request.";
    default:
      return `DePix API error (${/^[a-z0-9_]{1,64}$/i.test(code) ? code : `http_${status}`}). See error.data.`;
  }
}

/** Keep only primitive, low-risk values from an SDK error's `details` block. */
function sanitizeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details || typeof details !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") {
      const t = truncate(v);
      if (t !== undefined) out[k] = t;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Map any thrown error to a ToolError. DepixApiError → canned-by-code message +
 * untrusted provider text routed to `data.api_message`; other SDK errors →
 * their own canned English message + sanitized details; anything else → a
 * generic internal error (the raw message is NEVER surfaced).
 */
export function mapToolError(err: unknown): ToolError {
  if (err instanceof DepixApiError) {
    const code = err.code;
    const retryable = AUTO_RETRY_CODES.has(code);
    const message = cannedApiMessage(code, err.status, err.details, err.requiredScope, err.retryAfter);

    const data: Record<string, unknown> = { code, http_status: err.status, retryable };
    if (err.requestId !== undefined) data.request_id = err.requestId;
    if (err.retryAfter !== undefined) data.retry_after = err.retryAfter;

    const safeDetails: Record<string, unknown> = {};
    const scope = asScope(err.requiredScope);
    if (scope) safeDetails.required_scope = scope;
    const field = asFieldName(err.details?.field);
    if (field) safeDetails.field = field;
    for (const key of ["min_cents", "max_cents", "limit_cents", "used_cents"] as const) {
      const n = asInt(err.details?.[key]);
      if (n !== undefined) safeDetails[key] = n;
    }
    if (Object.keys(safeDetails).length > 0) data.details = safeDetails;

    // Untrusted upstream text: PT provider message first, then the raw API
    // message — truncated, labeled, and never in `message`.
    const apiMessage = truncate(err.legacyErrorMessage) ?? truncate(err.message);
    if (apiMessage !== undefined) data.api_message = apiMessage;

    return new ToolError(message, code, { retryable, data });
  }

  if (err instanceof DepixSdkError) {
    // Our own error — the message is canned English written in the SDK. Surface
    // it, with the code and a sanitized structured details block.
    const data: Record<string, unknown> = { code: err.code, retryable: false };
    const details = sanitizeDetails(err.details);
    if (details) data.details = details;
    return new ToolError(err.message, err.code, { data });
  }

  // Unexpected (a bug, not a modeled error): never surface the raw message.
  return new ToolError("Unexpected error while executing the tool.", "internal_error");
}
