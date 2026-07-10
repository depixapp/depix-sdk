// Boltz REST v2 client + shared status WebSocket (spec §5.3, port of
// depix-frontend/wallet/boltz/client.js). Thin, dependency-injected wrapper over
// the endpoints the Lightning send (submarine) flow needs. Node ≥22.4 has global
// fetch AND WebSocket, so no shims. No keys/secrets live here — HTTP only; the
// cryptographic claim/refund construction lives in reverse.ts / refund.ts.
//
// The boltz-swaps package is configured VIEM-FREE: createBoltzClient (the main
// barrel) transitively imports viem (an EVM/stablecoin concern, PR5b), so this
// module configures the client via `setBoltzSwapsConfig(mainnetConfig)` from the
// `boltz-swaps/config` + `boltz-swaps/presets/mainnet` subpaths instead — the
// reverse/refund cooperative-signing calls in `boltz-swaps/client` then target
// mainnet api.boltz.exchange without pulling viem.

import { BoltzApiError } from "../../errors.js";

export const BOLTZ_API_BASE = "https://api.boltz.exchange";
export const BOLTZ_WS_URL = "wss://api.boltz.exchange/v2/ws";

/** Injectable fetch (defaults to Node's global). */
export type BoltzFetch = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; credentials?: string }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Minimal WebSocket surface the status subscription drives (global in Node ≥22.4). */
export interface BoltzWebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (ev: unknown) => void): void;
}
export type BoltzWebSocketCtor = new (url: string) => BoltzWebSocketLike;

export interface BoltzClientOptions {
  fetchImpl?: BoltzFetch;
  wsImpl?: BoltzWebSocketCtor;
  apiBase?: string;
  wsUrl?: string;
}

function resolveFetch(fetchImpl?: BoltzFetch): BoltzFetch {
  const impl =
    fetchImpl ??
    (typeof fetch === "function"
      ? (fetch.bind(globalThis) as unknown as BoltzFetch)
      : null);
  if (!impl) throw new BoltzApiError("No fetch implementation available");
  return impl;
}

// ── boltz-swaps config (viem-free) ────────────────────────────────────────────
let configured = false;
/**
 * Configure the boltz-swaps client for mainnet exactly once. Uses the viem-free
 * `setBoltzSwapsConfig` (config subpath) rather than the main-barrel
 * `createBoltzClient`, which transitively imports viem (PR5b). Idempotent.
 */
export async function ensureBoltzConfig(): Promise<void> {
  if (configured) return;
  const [{ setBoltzSwapsConfig }, { mainnetConfig }] = await Promise.all([
    import("boltz-swaps/config"),
    import("boltz-swaps/presets/mainnet")
  ]);
  setBoltzSwapsConfig(mainnetConfig as never);
  configured = true;
}

/** Test hook — forget the one-shot boltz-swaps config latch. */
export function resetBoltzConfigForTests(): void {
  configured = false;
}

// ── REST helpers ──────────────────────────────────────────────────────────────

export interface SubmarinePair {
  hash?: string;
  fees?: { percentage?: number; minerFees?: number | Record<string, number> };
  limits?: { minimal?: number; maximal?: number };
}
export type PairMatrix = Record<string, Record<string, SubmarinePair | undefined>>;

export interface CreatedSubmarineSwap {
  id: string;
  address: string;
  expectedAmount: number;
  swapTree: unknown;
  claimPublicKey: string;
  blindingKey?: string;
  timeoutBlockHeight: number;
  [k: string]: unknown;
}

export class BoltzClient {
  private readonly doFetch: BoltzFetch;
  private readonly WS: BoltzWebSocketCtor | null;
  private readonly apiBase: string;
  private readonly wsUrl: string;

  constructor(options: BoltzClientOptions = {}) {
    this.doFetch = resolveFetch(options.fetchImpl);
    this.WS =
      options.wsImpl ??
      ((typeof globalThis !== "undefined" && (globalThis as { WebSocket?: unknown }).WebSocket
        ? ((globalThis as { WebSocket: unknown }).WebSocket as BoltzWebSocketCtor)
        : null));
    this.apiBase = options.apiBase ?? BOLTZ_API_BASE;
    this.wsUrl = options.wsUrl ?? BOLTZ_WS_URL;
  }

  private async request<T>(path: string, init: { method: string; body?: string }): Promise<T> {
    const res = await this.doFetch(`${this.apiBase}${path}`, {
      method: init.method,
      headers: { "content-type": "application/json" },
      ...(init.body !== undefined ? { body: init.body } : {}),
      credentials: "omit"
    });
    let body: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      const msg =
        (body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error
          : null) ?? `Boltz API ${res.status}`;
      throw new BoltzApiError(msg, { status: res.status, body });
    }
    return body as T;
  }

  /** GET /v2/swap/submarine — pair matrix (limits + fees + pair hash). */
  getSubmarinePairs(): Promise<PairMatrix> {
    return this.request<PairMatrix>("/v2/swap/submarine", { method: "GET" });
  }

  /** Resolve the L-BTC->BTC submarine pair hash from the live matrix. */
  async getSubmarinePairHash(): Promise<string> {
    const pairs = await this.getSubmarinePairs();
    const pair = pairs?.["L-BTC"]?.["BTC"];
    if (!pair?.hash) throw new BoltzApiError("Boltz has no L-BTC->BTC submarine pair");
    return pair.hash;
  }

  /**
   * POST /v2/swap/submarine — create a submarine swap for a BOLT11 invoice.
   * `from=L-BTC`, `to=BTC` (the Lightning side). Returns the L-BTC lockup
   * address + expected amount + swap tree.
   */
  createSubmarineSwap(params: {
    invoice: string;
    refundPublicKey: string;
    pairHash: string;
    referralId?: string;
  }): Promise<CreatedSubmarineSwap> {
    const body: Record<string, unknown> = {
      from: "L-BTC",
      to: "BTC",
      invoice: params.invoice,
      refundPublicKey: params.refundPublicKey,
      pairHash: params.pairHash
    };
    if (params.referralId) body.referralId = params.referralId;
    return this.request<CreatedSubmarineSwap>("/v2/swap/submarine", {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  /** GET /v2/swap/{id} — one-shot status (WS reconciliation + resume poll). */
  getSwapStatus(id: string): Promise<{ status?: string } & Record<string, unknown>> {
    return this.request(`/v2/swap/${encodeURIComponent(id)}`, { method: "GET" });
  }

  /**
   * GET /v2/chain/{asset}/height — current block height, or null on an
   * unrecognised shape. Used to bound a swap's refund timeout.
   */
  async getChainHeight(asset = "L-BTC"): Promise<number | null> {
    const res = await this.request<Record<string, unknown>>(
      `/v2/chain/${encodeURIComponent(asset)}/height`,
      { method: "GET" }
    );
    const direct = res?.height;
    if (typeof direct === "number") return direct;
    const nested = (res?.[asset] as { height?: unknown } | undefined)?.height;
    return typeof nested === "number" ? nested : null;
  }

  /**
   * Subscribe to a swap's live status over the WebSocket. Calls onStatus(raw)
   * with each raw Boltz status string; returns an unsubscribe function. The
   * socket auto-reconnects with backoff and reconciles via GET /v2/swap/{id} on
   * every (re)connect — consumers may see a status repeated and MUST treat
   * statuses idempotently (all our claim/refund guards + terminal latches do).
   */
  subscribeSwap(swapId: string, onStatus: (raw: string) => void): () => void {
    const WS = this.WS;
    if (!WS) throw new BoltzApiError("No WebSocket implementation available");
    let closed = false;
    let ws: BoltzWebSocketLike | null = null;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const reconcile = async (): Promise<void> => {
      try {
        const res = await this.getSwapStatus(swapId);
        if (!closed && res?.status) onStatus(res.status);
      } catch {
        // best-effort — the WS remains the primary channel
      }
    };

    const connect = (): void => {
      if (closed) return;
      ws = new WS(this.wsUrl);
      const scheduleReconnect = (): void => {
        if (closed || retryTimer !== null) return;
        try {
          ws?.close();
        } catch {
          // noop
        }
        const delay = WS_RECONNECT_DELAYS_MS[Math.min(attempt, WS_RECONNECT_DELAYS_MS.length - 1)]!;
        attempt += 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          connect();
        }, delay);
      };
      ws.addEventListener("open", () => {
        attempt = 0;
        ws?.send(JSON.stringify({ op: "subscribe", channel: "swap.update", args: [swapId] }));
        void reconcile();
      });
      ws.addEventListener("message", (ev) => {
        let msg: { event?: string; args?: Array<{ id?: string; status?: string }> };
        try {
          msg = JSON.parse((ev as { data: string }).data);
        } catch {
          return;
        }
        if (msg?.event === "update" && Array.isArray(msg.args)) {
          for (const u of msg.args) {
            if (u && u.id === swapId && u.status) onStatus(u.status);
          }
        }
      });
      ws.addEventListener("close", scheduleReconnect);
      ws.addEventListener("error", scheduleReconnect);
    };
    connect();

    return () => {
      if (closed) return;
      closed = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      try {
        ws?.close();
      } catch {
        // noop
      }
    };
  }
}

// Reconnect backoff schedule (ms) for the status WebSocket — swaps outlive any
// single socket (mobile/agent networks drop sockets routinely).
const WS_RECONNECT_DELAYS_MS = [1000, 3000, 10000, 30000];
