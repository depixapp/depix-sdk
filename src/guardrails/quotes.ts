// Client for the public GET /api/quotes proxy (spec §4.4, parity with the
// frontend's wallet/quotes.js). Keeps { btcUsd, usdBrl } fresh with a 30s
// window; if the upstream is down we serve the last successful response for up
// to 5 minutes before giving up and returning null. The valuation layer treats
// null as fail-closed (QUOTES_UNAVAILABLE) — a downed public endpoint must
// NEVER make the BRL ceilings bypassable (G6).
//
// Base URL is the canonical api.depixapp.com (§0.3/§2.6), NOT the legacy vercel
// alias the browser still uses. fetch/clock are injectable so the valuation and
// send tests never touch the network.

/** The three-asset BRL valuation pair returned by /api/quotes. */
export interface Quotes {
  /** BTC priced in USDT (SideSwap's USD unit). */
  btcUsd: number;
  /** USDT priced in BRL. */
  usdBrl: number;
}

/** Minimal contract the BRL valuator depends on (injectable for tests). */
export interface QuotesSource {
  get(options?: { force?: boolean }): Promise<Quotes | null>;
}

/** Canonical base (§0.3/§2.6). PR2 wires the apiBase option; until then env/default. */
export const DEFAULT_API_BASE = "https://api.depixapp.com";

const FRESH_WINDOW_MS = 30_000;
const STALE_WINDOW_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;

export function resolveApiBase(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return explicit ?? env.DEPIX_API_BASE ?? DEFAULT_API_BASE;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

function normalizeQuotes(raw: unknown): Quotes | null {
  if (!raw || typeof raw !== "object") return null;
  const btcUsd = Number((raw as Record<string, unknown>).btcUsd);
  const usdBrl = Number((raw as Record<string, unknown>).usdBrl);
  if (!isFiniteNumber(btcUsd) || !isFiniteNumber(usdBrl)) return null;
  return { btcUsd, usdBrl };
}

export interface QuotesClientOptions {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  timeoutMs?: number;
}

/**
 * In-memory quotes cache. get() returns fresh (<30s) from cache, refetches
 * otherwise, and falls back to a stale value (<5min) when the upstream errors.
 * Returns null only when nothing usable is cached AND the upstream is
 * unreachable — the caller (valuation) then fails closed.
 */
export class QuotesClient implements QuotesSource {
  private readonly endpoint: string;
  private readonly doFetch: typeof fetch;
  private readonly getNow: () => number;
  private readonly timeoutMs: number;
  private lastGood: Quotes | null = null;
  private lastGoodAt = 0;
  private inflight: Promise<{ quotes: Quotes | null; stale: boolean }> | null = null;

  constructor(options: QuotesClientOptions = {}) {
    this.endpoint = `${resolveApiBase(options.apiBase).replace(/\/+$/, "")}/api/quotes`;
    const impl = options.fetchImpl ?? (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    if (!impl) throw new Error("QuotesClient requires a fetch implementation");
    this.doFetch = impl;
    this.getNow = options.clock ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async fetchFresh(): Promise<{ quotes: Quotes; stale: false }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.doFetch(this.endpoint, { signal: ac.signal, credentials: "omit" });
      if (!res.ok) throw new Error(`quotes HTTP ${res.status}`);
      const body = await res.json();
      const quotes = normalizeQuotes(body);
      if (!quotes) throw new Error("quotes response missing btcUsd/usdBrl");
      this.lastGood = quotes;
      this.lastGoodAt = this.getNow();
      return { quotes, stale: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async get({ force = false }: { force?: boolean } = {}): Promise<Quotes | null> {
    const now = this.getNow();
    if (!force && this.lastGood && now - this.lastGoodAt < FRESH_WINDOW_MS) {
      return this.lastGood;
    }
    if (!this.inflight) {
      this.inflight = this.fetchFresh()
        .catch((err) => {
          // Serve a stale value within the 5-minute window; otherwise give up.
          const age = this.getNow() - this.lastGoodAt;
          if (this.lastGood && age < STALE_WINDOW_MS) {
            return { quotes: this.lastGood, stale: true };
          }
          void err;
          return { quotes: null, stale: true };
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    const result = await this.inflight;
    return result.quotes;
  }
}
