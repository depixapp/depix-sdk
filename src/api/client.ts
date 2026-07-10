// DePix API HTTP client (spec §3 wire contracts + §7 typed errors / retry /
// idempotency). Talks to the canonical base https://api.depixapp.com.
//
//   - Authorization: Bearer sk_… forwarded on every call; NEVER logged (the key
//     is registered with the PR1 logger for redaction, defense-in-depth).
//   - Idempotency-Key auto-generated (UUID v4) on the idempotent money-moving
//     POSTs (deposit/withdraw); a retry reuses the SAME key and receives the
//     server replay (§7.2). Callers override it for crash-resume (§3.2.9).
//   - Client-side pacing (§3.4): creation 2/min per (endpoint, key), status
//     reads 30/min per (endpoint, key). Retries are spaced through the same
//     throttle.
//   - Structured envelope { error: { code, message, request_id, retry_after?,
//     docs_url, details? } } → DepixApiError, with details.field /
//     details.required_scope hoisted to first class and the provider PT message
//     preserved in legacyErrorMessage. Unstructured (network/HTML) → a
//     synthetic upstream_error carrying the truncated body (§7.1).
//   - Retry (§7.3): network + any 5xx (idempotency makes money-moving POST
//     replays safe) with 1→2→4s jittered backoff, max 3; 429 honoring
//     retry_after (else 30s), max 2; 409 idempotency_in_flight after retry_after
//     (5s), max 3. Every other 4xx is surfaced, never retried.

import { randomUUID } from "node:crypto";
import { DepixApiError, type DepixApiErrorDetails } from "../errors.js";
import { defaultLogger, registerSecret, type Logger } from "../logger.js";
import { defaultSleep, Throttle, type SleepFn } from "./throttle.js";

export const DEFAULT_API_BASE = "https://api.depixapp.com";

// Server per-key, PER-ROUTE buckets (router.js:74-75 creation, :79-80 reads).
// The per-user limit is keyed by `scope + ":u"` (router.js perUser step), so
// deposit and withdraw NEVER share a budget on the server — each route gets its
// own perUser:2/min. The client mirrors this with separate `deposit:`/`withdraw:`
// buckets (see createDeposit/createWithdraw) rather than one shared bucket, so
// it never overshoots into a 429 it could have avoided.
const CREATE_LIMIT_PER_MIN = 2;
const READ_LIMIT_PER_MIN = 30;

const MAX_RETRY_TRANSIENT = 3; // network + 5xx
const MAX_RETRY_RATE_LIMITED = 2; // 429
const MAX_RETRY_IN_FLIGHT = 3; // 409 idempotency_in_flight
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 30_000;
const DEFAULT_IN_FLIGHT_RETRY_SECONDS = 5;

// ─── wire shapes (mirror the live handlers — routes/deposit.js, withdraw.js) ──

export interface DepositRequestBody {
  amountInCents: number;
  depixAddress: string;
  payer_tax_number?: string;
}

export interface DepositWireResponse {
  qrCopyPaste: string;
  qrImageUrl: string | null;
  id: string;
  sandbox?: boolean;
}

export interface WithdrawRequestBody {
  pixKey: string;
  taxNumber?: string;
  depositAmountInCents?: number;
  payoutAmountInCents?: number;
}

export interface WithdrawWireResponse {
  withdrawalId: string;
  depositAddress: string;
  depositAmountInCents: number;
  payoutAmountInCents: number;
  /** GROSS leaving the wallet — present only when the split fee is active (§3.2.2). */
  totalDepositAmountInCents?: number;
  split?: { address: string; amountCentavos: number };
  /** = split.amountCentavos — API-key path, when quoted (§3.2.2). */
  fee_cents?: number;
  /** Non-confidential (ex1) fee address — PROPOSITAL so F0.9 can verify (§3.2.3). */
  fee_address?: string;
  sandbox?: boolean;
}

export interface StatusReadResponse {
  id: string;
  type: "deposit" | "withdraw";
  amount_cents: number | null;
  status: string;
  created_at: string;
  updated_at: string;
  /** deposit: always an array (empty when not refused). */
  rejection_reasons?: string[];
  /** withdraw: COALESCE(blockchain_tx_id, liquid_txid) when settled. */
  liquid_txid?: string;
  sandbox?: boolean;
}

// ─── merchant light-profile (§5.6) ───────────────────────────────────────────

/** GET /api/me — merchant identity probe (scope merchant_read). */
export interface MeWireResponse {
  merchant_id: string;
  name: string;
  username: string | null;
  merchant_slug: string;
  is_live: boolean;
  created_at: string;
}

/**
 * PATCH /api/merchants/me body — ONLY the 5 LIGHT fields an API key may edit
 * (§5.6). liquid_address/split_address/cnpj are deliberately absent: they are
 * owner/admin-only and rejected by the server on the key path.
 */
export interface MerchantUpdateWireBody {
  business_name?: string;
  website?: string | null;
  logo_url?: string | null;
  default_callback_url?: string | null;
  default_redirect_url?: string | null;
}

/** PATCH /api/merchants/me success shape. */
export interface MerchantUpdateWireResponse {
  success: true;
  merchant_slug: string;
}

// ─── fetch seam ──────────────────────────────────────────────────────────

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<FetchResponseLike>;

export interface ApiClientOptions {
  /** sk_live_… / sk_test_… — required for any API call. */
  apiKey: string;
  /** Default: $DEPIX_API_BASE ?? https://api.depixapp.com. */
  apiBase?: string;
  /** Advanced/testing: inject the fetch implementation. */
  fetch?: FetchLike;
  logger?: Logger;
  /** Clock injection for tests (throttle + backoff timing). */
  now?: () => number;
  /** Sleep injection for tests. */
  sleep?: SleepFn;
  /** Random jitter source (0..1) — injected for deterministic tests. */
  random?: () => number;
}

interface RequestSpec {
  method: "GET" | "POST" | "PATCH";
  path: string;
  bucket: string;
  throttle: Throttle;
  body?: unknown;
  idempotencyKey?: string;
}

export class DepixApiClient {
  private readonly apiKey: string;
  readonly apiBase: string;
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;
  private readonly sleep: SleepFn;
  private readonly random: () => number;
  private readonly createThrottle: Throttle;
  private readonly readThrottle: Throttle;

  constructor(options: ApiClientOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.length === 0) {
      throw new TypeError("DepixApiClient requires an apiKey (sk_live_/sk_test_).");
    }
    this.apiKey = options.apiKey;
    // The key already lives in memory for the session; registering it makes the
    // logger scrub it from any line (defense-in-depth, never a license to log).
    registerSecret(this.apiKey);
    this.apiBase = normalizeBase(options.apiBase ?? process.env.DEPIX_API_BASE ?? DEFAULT_API_BASE);
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.logger = options.logger ?? defaultLogger;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    const now = options.now ?? Date.now;
    this.createThrottle = new Throttle({ limit: CREATE_LIMIT_PER_MIN, now, sleep: this.sleep });
    this.readThrottle = new Throttle({ limit: READ_LIMIT_PER_MIN, now, sleep: this.sleep });
  }

  /** Key mode derived LOCALLY from the prefix — zero /api/me call (§6.2). */
  get keyMode(): "live" | "test" {
    return this.apiKey.startsWith("sk_live_") ? "live" : "test";
  }

  get isSandbox(): boolean {
    return this.keyMode === "test";
  }

  /** Generate a fresh idempotency key (UUID v4). */
  static newIdempotencyKey(): string {
    return randomUUID();
  }

  // ─── money-moving POSTs ──────────────────────────────────────────────────

  async createDeposit(
    body: DepositRequestBody,
    opts: { idempotencyKey?: string } = {}
  ): Promise<DepositWireResponse> {
    const { data } = await this.request<{ response: DepositWireResponse }>({
      method: "POST",
      path: "/api/deposit",
      bucket: `deposit:${this.apiKey}`,
      throttle: this.createThrottle,
      body,
      idempotencyKey: opts.idempotencyKey ?? DepixApiClient.newIdempotencyKey()
    });
    if (!data?.response?.id) {
      throw new DepixApiError("upstream_error", "Malformed deposit response (missing response.id)", {
        status: 200
      });
    }
    return data.response;
  }

  async createWithdraw(
    body: WithdrawRequestBody,
    opts: { idempotencyKey?: string } = {}
  ): Promise<WithdrawWireResponse> {
    const { data } = await this.request<{ response: WithdrawWireResponse }>({
      method: "POST",
      path: "/api/withdraw",
      bucket: `withdraw:${this.apiKey}`,
      throttle: this.createThrottle,
      body,
      idempotencyKey: opts.idempotencyKey ?? DepixApiClient.newIdempotencyKey()
    });
    if (!data?.response?.withdrawalId) {
      throw new DepixApiError(
        "upstream_error",
        "Malformed withdraw response (missing response.withdrawalId)",
        { status: 200 }
      );
    }
    return data.response;
  }

  // ─── status reads ────────────────────────────────────────────────────────

  async getDeposit(id: string): Promise<StatusReadResponse> {
    const { data } = await this.request<StatusReadResponse>({
      method: "GET",
      path: `/api/deposits/${encodeURIComponent(id)}`,
      bucket: `deposit-status:${this.apiKey}`,
      throttle: this.readThrottle
    });
    return data;
  }

  async getWithdrawal(id: string): Promise<StatusReadResponse> {
    const { data } = await this.request<StatusReadResponse>({
      method: "GET",
      path: `/api/withdrawals/${encodeURIComponent(id)}`,
      bucket: `withdraw-status:${this.apiKey}`,
      throttle: this.readThrottle
    });
    return data;
  }

  // ─── merchant light-profile (§5.6) ─────────────────────────────────────────

  /**
   * GET /api/me — the merchant identity behind the key (scope merchant_read).
   * The read surface wallet.merchant.get() maps to. Shares the read throttle.
   */
  async getMe(): Promise<MeWireResponse> {
    const { data } = await this.request<MeWireResponse>({
      method: "GET",
      path: "/api/me",
      bucket: `me:${this.apiKey}`,
      throttle: this.readThrottle
    });
    return data;
  }

  /**
   * PATCH /api/merchants/me — edit the LIGHT profile fields (scope
   * merchant_write, §5.6). No Idempotency-Key: the update is state-idempotent
   * (last-write-wins on the same fields), so the generic 5xx retry is safe. The
   * server rejects any owner-only field (liquid_address/cnpj/password) with a
   * 400 validation_error and emails the owner on success (G11) — no client work.
   */
  async patchMerchantProfile(body: MerchantUpdateWireBody): Promise<MerchantUpdateWireResponse> {
    const { data } = await this.request<MerchantUpdateWireResponse>({
      method: "PATCH",
      path: "/api/merchants/me",
      bucket: `merchant-update:${this.apiKey}`,
      throttle: this.readThrottle,
      body
    });
    return data;
  }

  // ─── core request / retry loop ─────────────────────────────────────────────

  private async request<T>(spec: RequestSpec): Promise<{ data: T; replayed: boolean }> {
    let transientAttempts = 0;
    let rateLimitedAttempts = 0;
    let inFlightAttempts = 0;

    for (;;) {
      // Pace (and space retries) through the per-(endpoint, key) budget.
      await spec.throttle.acquire(spec.bucket);

      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json"
      };
      if (spec.body !== undefined) headers["Content-Type"] = "application/json";
      if (spec.idempotencyKey) headers["Idempotency-Key"] = spec.idempotencyKey;

      let res: FetchResponseLike;
      try {
        res = await this.fetchImpl(this.apiBase + spec.path, {
          method: spec.method,
          headers,
          body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined
        });
      } catch (networkErr) {
        if (transientAttempts < MAX_RETRY_TRANSIENT) {
          transientAttempts++;
          await this.sleep(this.backoffMs(transientAttempts));
          continue;
        }
        throw new DepixApiError(
          "upstream_error",
          `Network error contacting ${spec.path}: ${errMessage(networkErr)}`,
          { status: 0, cause: networkErr }
        );
      }

      const text = await res.text();
      const json = safeJsonParse(text);

      if (res.ok) {
        const replayed = (res.headers.get("Idempotency-Replayed") ?? "").toLowerCase() === "true";
        if (replayed) {
          this.logger.debug("idempotent replay", { path: spec.path });
        }
        return { data: json as T, replayed };
      }

      const code = extractCode(json);
      const retryAfter = readRetryAfter(json, res);

      if (res.status === 429 && rateLimitedAttempts < MAX_RETRY_RATE_LIMITED) {
        rateLimitedAttempts++;
        await this.sleep(retryAfter !== undefined ? retryAfter * 1000 : DEFAULT_RATE_LIMIT_BACKOFF_MS);
        continue;
      }

      if (
        res.status === 409 &&
        code === "idempotency_in_flight" &&
        inFlightAttempts < MAX_RETRY_IN_FLIGHT
      ) {
        inFlightAttempts++;
        await this.sleep((retryAfter ?? DEFAULT_IN_FLIGHT_RETRY_SECONDS) * 1000);
        continue;
      }

      if (res.status >= 500 && transientAttempts < MAX_RETRY_TRANSIENT) {
        // Any 5xx is retryable: GETs are idempotent, and money-moving POSTs
        // carry the Idempotency-Key so a retry replays instead of double-paying
        // (covers 502 upstream_error / 503 and the rate-limit-infra 500 note).
        transientAttempts++;
        await this.sleep(this.backoffMs(transientAttempts));
        continue;
      }

      throw mapApiError(res.status, json, text, res);
    }
  }

  /** 1s → 2s → 4s with up-to-250ms jitter (spec §7.3). */
  private backoffMs(attempt: number): number {
    const base = 2 ** (attempt - 1) * 1000;
    return base + Math.floor(this.random() * 250);
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function normalizeBase(base: string): string {
  return base.replace(/\/+$/, "");
}

function safeJsonParse(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errMessage(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function extractCode(json: unknown): string | undefined {
  const error = asRecord(asRecord(json)?.error);
  return typeof error?.code === "string" ? error.code : undefined;
}

/** retry_after from the envelope (preferred) or the Retry-After header. */
function readRetryAfter(json: unknown, res: FetchResponseLike): number | undefined {
  const error = asRecord(asRecord(json)?.error);
  if (typeof error?.retry_after === "number" && Number.isFinite(error.retry_after)) {
    return error.retry_after;
  }
  const header = res.headers.get("Retry-After");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds;
  }
  return undefined;
}

/**
 * Map an error HTTP response to a DepixApiError (spec §7.1). A structured
 * envelope hoists details.field / details.required_scope to first class and
 * preserves the provider PT message; anything unstructured becomes a synthetic
 * upstream_error carrying the truncated body.
 */
export function mapApiError(
  status: number,
  json: unknown,
  rawText: string,
  res?: FetchResponseLike
): DepixApiError {
  const root = asRecord(json);
  const error = asRecord(root?.error);
  if (error && typeof error.code === "string") {
    const details = asRecord(error.details) as DepixApiErrorDetails | undefined;
    const legacy = asRecord(root?.response)?.errorMessage;
    // details.field is NOT guaranteed on every validation_error — provider
    // (Eulen) rejections have no details. Fall back to the legacy
    // response.errors[0].field when present (§7.1).
    const legacyErrors = asRecord(root?.response)?.errors;
    const legacyField =
      Array.isArray(legacyErrors) && asRecord(legacyErrors[0])?.field !== undefined
        ? String(asRecord(legacyErrors[0])?.field)
        : undefined;
    const field = typeof details?.field === "string" ? details.field : legacyField;
    const requiredScope =
      typeof details?.required_scope === "string" ? details.required_scope : undefined;
    return new DepixApiError(error.code, typeof error.message === "string" ? error.message : undefined, {
      status,
      requestId: typeof error.request_id === "string" ? error.request_id : undefined,
      retryAfter: res ? readRetryAfter(json, res) : typeof error.retry_after === "number" ? error.retry_after : undefined,
      docsUrl: typeof error.docs_url === "string" ? error.docs_url : undefined,
      details,
      legacyErrorMessage: typeof legacy === "string" ? legacy : undefined,
      field,
      requiredScope
    });
  }

  // No structured envelope (network/HTML/5xx without body) → synthetic
  // upstream_error with the truncated body (§7.1).
  const bodyPreview = (rawText ?? "").slice(0, 500);
  return new DepixApiError("upstream_error", `Unstructured error response (HTTP ${status})`, {
    status,
    details: bodyPreview ? { body: bodyPreview } : undefined
  });
}
