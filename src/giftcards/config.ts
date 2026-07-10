// Gift-card runtime config from the PUBLIC /api/config endpoint (spec §5.5).
// Node port of depix-frontend/wallet/config.js focused on the gift-card fields:
//   giftcardEnabled, giftcardFeeRate, giftcardSplitAddress, giftcardCountryDefault
// (api/_lib/routes/config.js). The endpoint needs NO auth (it's the same public
// payload the PWA reads on boot). Cached 5 minutes in-memory.
//
// FAIL-CLOSED (§5.5, diverges from the frontend's fail-OPEN): when the config is
// unreachable / malformed, `enabled` resolves to false — the gift-card flow then
// throws GIFTCARDS_DISABLED rather than proceeding without a confirmed
// splitAddress / feeRate. Blocking a purchase during a config outage is the safe
// default; the backend is the source of truth.

import { DEFAULT_API_BASE, type FetchLike } from "../api/client.js";
import { defaultLogger, type Logger } from "../logger.js";

export interface ResolvedGiftcardConfig {
  /** CryptoRefills integration on (CRYPTOREFILLS_ENABLED). Fail-closed default false. */
  enabled: boolean;
  /** Service fee rate (0–0.10), default 0.01 (1%). */
  feeRate: number;
  /** L-BTC address the fee output pays (DEPIX_SPLIT_ADDRESS); null when disabled. */
  splitAddress: string | null;
  /** Default country (ISO 3166-1 alpha-2). */
  countryDefault: string;
}

/** The read seam the gift-card namespace depends on (fakes inject a stub). */
export interface GiftcardConfigSource {
  getGiftcardConfig(opts?: { force?: boolean }): Promise<ResolvedGiftcardConfig>;
}

export interface GiftcardConfigClientOptions {
  /** DePix API base (default: $DEPIX_API_BASE ?? https://api.depixapp.com). */
  apiBase?: string;
  /** Injected fetch (default: Node global). */
  fetch?: FetchLike;
  now?: () => number;
  logger?: Logger;
  timeoutMs?: number;
}

const CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 4_000;

/** Fail-closed default (feature OFF) — used on outage/malformed payload (§5.5). */
export const DISABLED_GIFTCARD_CONFIG: Readonly<ResolvedGiftcardConfig> = Object.freeze({
  enabled: false,
  feeRate: 0.01,
  splitAddress: null,
  countryDefault: "BR"
});

export class GiftcardConfigClient implements GiftcardConfigSource {
  private readonly endpoint: string;
  private readonly doFetch: FetchLike;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private cached: ResolvedGiftcardConfig | null = null;
  private cachedAt = 0;
  private inflight: Promise<ResolvedGiftcardConfig> | null = null;

  constructor(options: GiftcardConfigClientOptions = {}) {
    const base = (options.apiBase ?? process.env.DEPIX_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, "");
    this.endpoint = `${base}/api/config`;
    this.doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? defaultLogger;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getGiftcardConfig(opts: { force?: boolean } = {}): Promise<ResolvedGiftcardConfig> {
    const now = this.now();
    if (!opts.force && this.cached && now - this.cachedAt < CACHE_TTL_MS) return this.cached;
    if (!this.inflight) {
      this.inflight = this.fetchFresh()
        .catch((err) => {
          this.logger.warn(
            "gift-card /api/config unreachable — failing closed (feature OFF unless a still-fresh cache exists)",
            { error: String((err as Error)?.message ?? err) }
          );
          // Fail-closed (§5.5): tolerate a SHORT blip by reusing the last config
          // only while it is still within the cache TTL. Once the last successful
          // fetch is stale we can no longer confirm the kill switch is off →
          // GIFTCARDS_DISABLED. The safe side of a kill switch is OFF when the
          // backend can't be confirmed (spec: "/api/config inalcançável → DISABLED").
          if (this.cached && this.now() - this.cachedAt < CACHE_TTL_MS) return this.cached;
          return DISABLED_GIFTCARD_CONFIG;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  private async fetchFresh(): Promise<ResolvedGiftcardConfig> {
    // Wire an AbortController (mirrors CryptorefillsClient.crFetch) so the timeout
    // also CANCELS the underlying request, not just the race — no leaked pending
    // socket on a hung /api/config.
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const res = await this.withTimeout(
      this.doFetch(this.endpoint, {
        method: "GET",
        headers: { Accept: "application/json" },
        ...(controller ? { signal: controller.signal } : {})
      }),
      controller
    );
    if (!res.ok) throw new Error(`config HTTP ${res.status}`);
    const text = await res.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    let resolved = resolveGiftcardConfig(body);
    // Broken backend config (§5.5): giftcardEnabled=true with NO giftcardSplitAddress
    // would make buy() compute the 1% fee but DROP the fee output (no address to pay
    // it to) — a silent under-charge. Fail closed rather than sell without the fee.
    if (resolved.enabled && !resolved.splitAddress) {
      this.logger.warn(
        "gift-card /api/config has giftcardEnabled=true but no giftcardSplitAddress — " +
          "treating as DISABLED (refusing to sell without the 1% service-fee output)"
      );
      resolved = DISABLED_GIFTCARD_CONFIG;
    }
    this.cached = resolved;
    this.cachedAt = this.now();
    return resolved;
  }

  private async withTimeout<T>(p: Promise<T>, controller?: AbortController | null): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Abort the underlying fetch too (not just the race) so a hung request
        // is actually released rather than left pending in the background.
        controller?.abort();
        reject(new Error("config request timed out"));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Resolve a raw /api/config body to the gift-card config, with the same
 * validation as the frontend: enabled only when strictly true; feeRate accepted
 * only in (0, 0.10] else 1%; splitAddress a non-empty string else null;
 * countryDefault a 2-letter code (uppercased) else BR.
 */
export function resolveGiftcardConfig(body: Record<string, unknown> | null | undefined): ResolvedGiftcardConfig {
  const enabled = body?.giftcardEnabled === true;
  const rawFee = body?.giftcardFeeRate;
  const feeRate =
    typeof rawFee === "number" && Number.isFinite(rawFee) && rawFee > 0 && rawFee <= 0.1 ? rawFee : 0.01;
  const rawSplit = body?.giftcardSplitAddress;
  const splitAddress = typeof rawSplit === "string" && rawSplit ? rawSplit : null;
  const rawCountry = body?.giftcardCountryDefault;
  const countryDefault =
    typeof rawCountry === "string" && /^[A-Za-z]{2}$/.test(rawCountry) ? rawCountry.toUpperCase() : "BR";
  return { enabled, feeRate, splitAddress, countryDefault };
}
