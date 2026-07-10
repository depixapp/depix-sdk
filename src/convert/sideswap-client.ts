// SideSwap WebSocket client — protocol layer only (spec §5.1). Direct port of
// depix-frontend/wallet/sideswap.js (GT §4.A), adapted to headless Node: uses
// the global WebSocket (stable since Node 22.4 — the engines floor; no `ws`
// dependency, SPIKE) and typed SideSwapError instead of the browser class.
//
// SideSwap is a NON-custodial swap service on Liquid. Endpoint:
// wss://api.sideswap.io/json-rpc-ws — an open API, no key required.
//
// Flows:
//  - Market swaps (Liquid ↔ Liquid): start_quotes → get_quote → taker_sign
//  - Peg-in  (BTC on-chain → L-BTC): peg { peg_in: true }  → peg_status polling
//  - Peg-out (L-BTC → BTC on-chain): peg { peg_in: false } → peg_status polling
//
// Dealer queue (instant_swap:false): the server pre-signs the maker input(s)
// before delivering the PSET, so wollet.finalize(pset) produces a fully-signed
// tx in one shot (no per-input witness manipulation) — the same shape Satsails
// uses via lwk-dart.

import { SideSwapError } from "../errors.js";

export const SIDESWAP_WS_URL = "wss://api.sideswap.io/json-rpc-ws";

/** SideSwap transport/protocol error codes (parity with the frontend SS_ERROR). */
export const SS_ERROR = Object.freeze({
  SERVER_ERROR: "SERVER_ERROR",
  CONNECTION_LOST: "CONNECTION_LOST",
  TIMEOUT: "TIMEOUT",
  NOT_CONNECTED: "NOT_CONNECTED",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  LOW_BALANCE: "LOW_BALANCE",
  NO_MARKET: "NO_MARKET"
} as const);

const RPC_TIMEOUT_MS = 15_000;
const RECONNECT_DELAYS = [250, 500, 1000, 2000, 4000, 8000];
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_PSET_BYTES = 1_500_000; // 1.5 MB sanity cap on server-supplied PSETs

/** The subset of the WHATWG WebSocket the client drives (global in Node ≥22.4). */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}
export interface WebSocketCtor {
  new (url: string): WebSocketLike;
  readonly OPEN?: number;
}

function ssError(code: string, message: string, cause?: unknown): SideSwapError {
  return new SideSwapError(code, message, cause !== undefined ? { cause } : undefined);
}

// Coerce a server-supplied numeric to BigInt. Accepts numbers and decimal
// strings; throws SideSwapError(INVALID_RESPONSE) otherwise so a raw
// "BigInt: Cannot convert ..." never bubbles up.
export function safeBigInt(v: unknown, name: string): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "bigint") return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  throw ssError(SS_ERROR.INVALID_RESPONSE, `Invalid numeric ${name}: ${String(v)}`);
}

/** A UTXO shape SideSwap's dealer flow needs (blinding factors included). */
export interface SideSwapUtxo {
  txid: string;
  vout: number;
  asset: string;
  asset_bf: string;
  value: number;
  value_bf: string;
  redeem_script: string | null;
  height: number | null;
}

export interface SideSwapQuoteEvent {
  quoteId: number | string;
  sendAmount: bigint;
  recvAmount: bigint;
  serverFee: bigint;
  fixedFee: bigint;
  feeAsset: string | null;
  ttlMs: number;
  sendAsset: string;
  recvAsset: string;
}

export interface StartQuotesParams {
  sendAsset: string;
  recvAsset: string;
  sendAmountSats: number;
  utxos: SideSwapUtxo[];
  receiveAddress: string;
  changeAddress: string;
  onQuote?: (q: SideSwapQuoteEvent) => void;
  onError?: (err: SideSwapError) => void;
}

export interface PegResult {
  orderId: string;
  pegAddr: string;
  recvAmount?: number | null;
  expiresAt?: number | null;
  createdAt?: number | null;
}

export interface PegStatusResult {
  orderId: string;
  status: string;
  confirmations: number;
  txid: string | null;
  deposits: unknown[];
}

interface Market {
  asset_pair: { base: string; quote: string };
  fee_asset?: string;
  type?: string;
}

interface MarketCandidate {
  base: string;
  quote: string;
  asset_type: "Base" | "Quote";
  trade_dir: "Sell";
  amount: number;
  _priority: number;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Subscription {
  method: string;
  subParams: unknown;
  onError?: (err: SideSwapError) => void;
  cleanup?: () => void;
  onResubscribed?: (res: unknown) => void;
  onPreResubscribe?: () => void;
}

export interface SideSwapClientOptions {
  wsUrl?: string;
  /** Injected WebSocket constructor (tests). Defaults to the Node global. */
  WebSocketImpl?: WebSocketCtor;
  onFatal?: (err: SideSwapError) => void;
  onConnectionLost?: () => void;
  onReconnected?: () => void;
  /** Test-only: skip the automatic list_markets fetch and use this canned list. */
  presetMarkets?: Market[];
}

export interface SubscriptionHandle {
  unsubscribe(): void;
}

/** The frozen client surface (parity with the frontend factory). */
export interface SideSwapClient {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  hasMarkets(): boolean;
  startQuotes(params: StartQuotesParams): SubscriptionHandle;
  getQuote(quoteId: number | string): Promise<{ pset: string; quoteId: number | string; ttlMs: number | null }>;
  takerSign(args: { quoteId: number | string; signedPset: string }): Promise<{ txid: string }>;
  pegIn(args: { recvAddr: string }): Promise<PegResult>;
  pegOut(args: { recvAddr: string; blocks?: number }): Promise<PegResult>;
  pegStatus(args: { orderId: string; pegIn: boolean }): Promise<PegStatusResult>;
  serverStatus(args?: { forceRefresh?: boolean }): Promise<Record<string, unknown>>;
}

/**
 * Build a SideSwap WS client. Faithful port of createSideSwapClient — same
 * reconnect/resubscribe, market resolution, quote_sub_id guard and candidate
 * fallback. The verbose closure shape is kept deliberately so the diff against
 * the frontend source-of-truth stays reviewable.
 */
export function createSideSwapClient(options: SideSwapClientOptions = {}): SideSwapClient {
  const wsUrl = options.wsUrl ?? SIDESWAP_WS_URL;
  const resolvedWs = options.WebSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketCtor | undefined);
  if (!resolvedWs) {
    throw ssError(SS_ERROR.NOT_CONNECTED, "No WebSocket implementation (Node ≥22.4 exposes a global)");
  }
  // Non-nullable binding so the narrowing survives into the nested closures.
  const WS: WebSocketCtor = resolvedWs;
  const OPEN = WS.OPEN ?? 1;

  let ws: WebSocketLike | null = null;
  let nextId = 1;
  let connected = false;
  let destroyed = false;
  let gaveUp = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectingPromise: Promise<void> | null = null;
  let connectingTimer: ReturnType<typeof setTimeout> | null = null;
  let markets: Market[] | null = options.presetMarkets ?? null;

  const pending = new Map<number, PendingRpc>();
  const subscriptions = new Map<string, Subscription>();
  const listeners = new Map<string, Set<(params: unknown) => void>>();

  function cancelReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function clearPending(err: SideSwapError): void {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    pending.clear();
  }

  function resubscribeAll(): void {
    for (const [key, sub] of subscriptions.entries()) {
      try {
        sub.onPreResubscribe?.();
      } catch {
        /* best-effort */
      }
      rpc(sub.method, sub.subParams)
        .then((res) => {
          try {
            sub.onResubscribed?.(res);
          } catch {
            /* best-effort */
          }
        })
        .catch((err) => {
          subscriptions.delete(key);
          sub.onError?.(err as SideSwapError);
        });
    }
  }

  function handleOpen(): void {
    connected = true;
    const wasReconnect = reconnectAttempt > 0;
    reconnectAttempt = 0;
    if (!options.presetMarkets) {
      rpc("market", { list_markets: {} })
        .then((res) => {
          markets = (res as { list_markets?: { markets?: Market[] } })?.list_markets?.markets ?? [];
          resubscribeAll();
          if (wasReconnect) {
            try {
              options.onReconnected?.();
            } catch {
              /* best-effort */
            }
          }
        })
        .catch(() => {
          markets = [];
          resubscribeAll();
        });
    } else {
      resubscribeAll();
      if (wasReconnect) {
        try {
          options.onReconnected?.();
        } catch {
          /* best-effort */
        }
      }
    }
  }

  // Given a fromAsset→toAsset direction, return candidate market shapes in
  // priority order (official markets before dealers). The server only accepts
  // ONE canonical direction in start_quotes, so the caller tries each until one
  // succeeds. Returns [] when no market matches.
  function resolveMarketParams(
    fromAsset: string,
    toAsset: string,
    sendAmountSats: number
  ): MarketCandidate[] {
    if (!markets) return [];
    const candidates: MarketCandidate[] = [];
    for (const market of markets) {
      const { base, quote } = market.asset_pair;
      const officialType = market.type === "Stablecoin" || market.type === "Token";
      const priority = officialType ? 0 : 1;
      if (base === fromAsset && quote === toAsset) {
        candidates.push({ base, quote, asset_type: "Base", trade_dir: "Sell", amount: sendAmountSats, _priority: priority });
      }
      if (quote === fromAsset && base === toAsset) {
        candidates.push({ base, quote, asset_type: "Quote", trade_dir: "Sell", amount: sendAmountSats, _priority: priority });
      }
    }
    candidates.sort((a, b) => a._priority - b._priority);
    return candidates;
  }

  function handleMessage(evt: { data: unknown }): void {
    let msg: { id?: number | null; error?: { message?: string }; result?: unknown; method?: string; params?: unknown };
    try {
      msg = JSON.parse(String(evt.data));
    } catch {
      return;
    }

    if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
      const entry = pending.get(msg.id)!;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(ssError(SS_ERROR.SERVER_ERROR, msg.error.message ?? "SideSwap server error"));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // Per JSON-RPC 2.0, an uncorrelated parse/request error arrives with id:null.
    if (msg.id === null && msg.error) {
      clearPending(ssError(SS_ERROR.SERVER_ERROR, msg.error.message ?? "SideSwap server error (id=null)"));
      return;
    }

    const method = msg.method;
    if (method && listeners.has(method)) {
      for (const fn of listeners.get(method)!) {
        try {
          fn(msg.params);
        } catch {
          /* best-effort */
        }
      }
    }
  }

  function handleClose(): void {
    const wasConnected = connected;
    connected = false;
    ws = null;
    if (!options.presetMarkets) markets = null;
    clearPending(ssError(SS_ERROR.CONNECTION_LOST, "WebSocket closed"));
    if (wasConnected && !destroyed) {
      try {
        options.onConnectionLost?.();
      } catch {
        /* best-effort */
      }
    }
    if (!destroyed) scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (destroyed) return;
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      gaveUp = true;
      const err = ssError(
        SS_ERROR.CONNECTION_LOST,
        `SideSwap reconnect gave up after ${MAX_RECONNECT_ATTEMPTS} attempts`
      );
      try {
        options.onFatal?.(err);
      } catch {
        /* best-effort */
      }
      return;
    }
    cancelReconnect();
    const baseDelay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)]!;
    const delay = baseDelay * (0.8 + Math.random() * 0.4); // ±20% jitter
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!destroyed) openWs();
    }, delay);
  }

  function openWs(): void {
    if (ws) return;
    try {
      ws = new WS(wsUrl);
    } catch {
      scheduleReconnect();
      return;
    }
    ws.onopen = handleOpen;
    ws.onmessage = handleMessage;
    ws.onclose = handleClose;
    ws.onerror = () => {
      /* onclose fires right after onerror; pending is cleared there. */
    };
  }

  function rawSend(params: unknown): boolean {
    if (!ws || ws.readyState !== OPEN) return false;
    try {
      ws.send(JSON.stringify(params));
      return true;
    } catch {
      return false;
    }
  }

  function rpc(method: string, params: unknown): Promise<unknown> {
    if (!connected) {
      return Promise.reject(ssError(SS_ERROR.NOT_CONNECTED, "Not connected to SideSwap"));
    }
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(ssError(SS_ERROR.TIMEOUT, `RPC timeout: ${method}`));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      const sent = rawSend({ jsonrpc: "2.0", id, method, params });
      if (!sent) {
        pending.delete(id);
        clearTimeout(timer);
        reject(ssError(SS_ERROR.NOT_CONNECTED, "Could not send RPC message"));
      }
    });
  }

  function addListener(method: string, fn: (params: unknown) => void): () => void {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method)!.add(fn);
    return () => {
      const set = listeners.get(method);
      if (!set) return;
      set.delete(fn);
      if (set.size === 0) listeners.delete(method);
    };
  }

  function connect(): Promise<void> {
    if (destroyed) return Promise.reject(ssError(SS_ERROR.NOT_CONNECTED, "Client destroyed"));
    if (connected) return Promise.resolve();
    if (gaveUp) {
      gaveUp = false;
      reconnectAttempt = 0;
    }
    if (connectingPromise) return connectingPromise;
    cancelReconnect();
    if (!ws) openWs();
    if (!ws) return Promise.reject(ssError(SS_ERROR.NOT_CONNECTED, "Could not open WebSocket"));
    const socket = ws;
    connectingPromise = new Promise<void>((resolve, reject) => {
      connectingTimer = setTimeout(() => {
        connectingTimer = null;
        reject(ssError(SS_ERROR.TIMEOUT, "Connection timeout"));
      }, RPC_TIMEOUT_MS);
      const prevOnOpen = socket.onopen;
      socket.onopen = (ev?: unknown) => {
        if (connectingTimer !== null) {
          clearTimeout(connectingTimer);
          connectingTimer = null;
        }
        if (prevOnOpen) prevOnOpen(ev);
        resolve();
      };
    });
    connectingPromise
      .finally(() => {
        connectingPromise = null;
      })
      .catch(() => {
        /* no-op: cleanup paths that don't await must not unhandled-reject */
      });
    return connectingPromise;
  }

  function disconnect(): void {
    destroyed = true;
    cancelReconnect();
    if (connectingTimer !== null) {
      clearTimeout(connectingTimer);
      connectingTimer = null;
    }
    clearPending(ssError(SS_ERROR.CONNECTION_LOST, "Client disconnected"));
    subscriptions.clear();
    listeners.clear();
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* best-effort */
      }
      ws = null;
    }
    connected = false;
  }

  function isConnected(): boolean {
    return connected;
  }

  function hasMarkets(): boolean {
    return markets !== null;
  }

  function startQuotes(params: StartQuotesParams): SubscriptionHandle {
    const { sendAsset, recvAsset, sendAmountSats, utxos, receiveAddress, changeAddress, onQuote, onError } = params;
    const key = `quotes_${sendAsset}_${recvAsset}`;

    const existing = subscriptions.get(key);
    if (existing) {
      try {
        existing.cleanup?.();
      } catch {
        /* best-effort */
      }
      subscriptions.delete(key);
    }

    const candidates = resolveMarketParams(sendAsset, recvAsset, sendAmountSats);
    if (candidates.length === 0) {
      onError?.(ssError(SS_ERROR.NO_MARKET, `No market found for ${sendAsset} → ${recvAsset}`));
      return { unsubscribe: () => {} };
    }

    let current = 0;
    let market = candidates[0]!;
    let sellingQuote = market.asset_type === "Quote";
    let quoteSubId: number | string | null = null;
    let feeAsset: string | null = null;
    let cancelled = false;

    const buildSubParams = (m: MarketCandidate): unknown => ({
      start_quotes: {
        asset_pair: { base: m.base, quote: m.quote },
        asset_type: m.asset_type,
        amount: m.amount,
        trade_dir: m.trade_dir,
        utxos,
        receive_address: receiveAddress,
        change_address: changeAddress,
        // Dealer queue flow — the server pre-signs the maker input(s), so
        // wollet.finalize(pset) yields a fully-signed tx in one shot. An empty
        // dealer queue returns LowBalance (surfaced as SWAP_LOW_BALANCE).
        instant_swap: false
      }
    });

    const removeListener = addListener("market", (data: unknown) => {
      const q = (data as { quote?: Record<string, unknown> })?.quote;
      if (!q) return;
      // Quote-id guard: reject every quote until quoteSubId is bound, so a
      // stale/hostile operator cannot inject a worse quote in the window
      // between start_quotes send and its RPC response.
      if (quoteSubId === null) return;
      if (q.quote_sub_id !== undefined && q.quote_sub_id !== quoteSubId) return;
      const status = q.status as Record<string, Record<string, unknown>> | undefined;
      const success = status?.Success;
      const lowBal = status?.LowBalance;
      const errStatus = status?.Error;
      if (success) {
        try {
          const sendAmount = sellingQuote
            ? safeBigInt(success.quote_amount, "quote_amount")
            : safeBigInt(success.base_amount, "base_amount");
          const recvAmount = sellingQuote
            ? safeBigInt(success.base_amount, "base_amount")
            : safeBigInt(success.quote_amount, "quote_amount");
          onQuote?.({
            quoteId: success.quote_id as number | string,
            sendAmount,
            recvAmount,
            serverFee: safeBigInt(success.server_fee, "server_fee"),
            fixedFee: safeBigInt(success.fixed_fee, "fixed_fee"),
            feeAsset,
            ttlMs: (success.ttl as number) ?? 30_000,
            sendAsset,
            recvAsset
          });
        } catch (err) {
          onError?.(err as SideSwapError);
        }
      } else if (lowBal) {
        const err = ssError(
          SS_ERROR.LOW_BALANCE,
          `Insufficient liquidity. Available: ${String(lowBal.available ?? 0)} sats`
        );
        onError?.(err);
      } else if (errStatus) {
        onError?.(ssError(SS_ERROR.SERVER_ERROR, (errStatus.error_msg as string) ?? "Quote error"));
      }
    });

    const cleanup = (): void => {
      cancelled = true;
      removeListener();
      if (connected && quoteSubId !== null) {
        rpc("market", { stop_quotes: { quote_sub_id: quoteSubId } }).catch(() => {});
      } else if (connected) {
        rpc("market", { stop_quotes: {} }).catch(() => {});
      }
    };

    const onResubscribed = (res: unknown): void => {
      if (cancelled) return;
      const sq = (res as { start_quotes?: { quote_sub_id?: number | string; fee_asset?: string } })?.start_quotes;
      quoteSubId = sq?.quote_sub_id ?? null;
      feeAsset = sq?.fee_asset ?? null;
    };
    const onPreResubscribe = (): void => {
      quoteSubId = null;
    };

    const tryNext = (): void => {
      if (cancelled) return;
      if (current >= candidates.length) return;
      market = candidates[current]!;
      sellingQuote = market.asset_type === "Quote";
      const subParams = buildSubParams(market);
      subscriptions.set(key, { method: "market", subParams, onError, cleanup, onResubscribed, onPreResubscribe });
      rpc("market", subParams)
        .then((res) => onResubscribed(res))
        .catch((err) => {
          if (cancelled) return;
          const msg = String((err as Error)?.message ?? "");
          const isUnknownMarket = msg.includes("unknown market");
          current++;
          if (isUnknownMarket && current < candidates.length) {
            tryNext();
          } else {
            subscriptions.delete(key);
            removeListener();
            onError?.(err as SideSwapError);
          }
        });
    };
    tryNext();

    return {
      unsubscribe: () => {
        const stored = subscriptions.get(key);
        subscriptions.delete(key);
        try {
          if (stored?.cleanup) stored.cleanup();
          else cleanup();
        } catch {
          /* best-effort */
        }
      }
    };
  }

  async function getQuote(
    quoteId: number | string
  ): Promise<{ pset: string; quoteId: number | string; ttlMs: number | null }> {
    const result = (await rpc("market", { get_quote: { quote_id: quoteId } })) as {
      get_quote?: { pset?: unknown; ttl?: number };
    };
    const pset = result?.get_quote?.pset;
    if (!pset) throw ssError(SS_ERROR.INVALID_RESPONSE, "No PSET in quote response");
    if (typeof pset !== "string" || pset.length > MAX_PSET_BYTES) {
      throw ssError(SS_ERROR.INVALID_RESPONSE, "PSET too large or invalid type");
    }
    return { pset, quoteId, ttlMs: result?.get_quote?.ttl ?? null };
  }

  async function takerSign(args: { quoteId: number | string; signedPset: string }): Promise<{ txid: string }> {
    const result = (await rpc("market", {
      taker_sign: { quote_id: args.quoteId, pset: args.signedPset }
    })) as { taker_sign?: { txid?: string } };
    const txid = result?.taker_sign?.txid;
    if (!txid) throw ssError(SS_ERROR.INVALID_RESPONSE, "taker_sign returned no txid");
    return { txid };
  }

  async function pegIn(args: { recvAddr: string }): Promise<PegResult> {
    const result = (await rpc("peg", { peg_in: true, recv_addr: args.recvAddr })) as Record<string, unknown>;
    return {
      orderId: (result?.order_id as string) ?? "",
      pegAddr: (result?.peg_addr as string) ?? "",
      expiresAt: (result?.expires_at as number) ?? null
    };
  }

  async function pegOut(args: { recvAddr: string; blocks?: number }): Promise<PegResult> {
    const params: Record<string, unknown> = { peg_in: false, recv_addr: args.recvAddr };
    if (typeof args.blocks === "number" && Number.isFinite(args.blocks) && args.blocks > 0) {
      params.blocks = args.blocks;
    }
    const result = (await rpc("peg", params)) as Record<string, unknown>;
    return {
      orderId: (result?.order_id as string) ?? "",
      pegAddr: (result?.peg_addr as string) ?? "",
      recvAmount: (result?.recv_amount as number) ?? null,
      expiresAt: (result?.expires_at as number) ?? null,
      createdAt: (result?.created_at as number) ?? null
    };
  }

  async function pegStatus(args: { orderId: string; pegIn: boolean }): Promise<PegStatusResult> {
    const result = (await rpc("peg_status", { order_id: args.orderId, peg_in: args.pegIn })) as {
      order_id?: string;
      list?: Array<{ status?: string; confirmations?: number; tx_id?: string }>;
    };
    const first = result?.list?.[0];
    return {
      orderId: result?.order_id ?? args.orderId,
      status: first?.status ?? "Unknown",
      confirmations: first?.confirmations ?? 0,
      txid: first?.tx_id ?? null,
      deposits: Array.isArray(result?.list) ? result.list : []
    };
  }

  let lastServerStatus: Record<string, unknown> | null = null;
  async function serverStatus(args: { forceRefresh?: boolean } = {}): Promise<Record<string, unknown>> {
    if (!args.forceRefresh && lastServerStatus) return lastServerStatus;
    const result = (await rpc("server_status", null)) as Record<string, unknown>;
    lastServerStatus = result ?? {};
    return lastServerStatus;
  }

  return Object.freeze({
    connect,
    disconnect,
    isConnected,
    hasMarkets,
    startQuotes,
    getQuote,
    takerSign,
    pegIn,
    pegOut,
    pegStatus,
    serverStatus
  });
}

/**
 * Transient dealer-side blinding failure (spec §5.1, memory "SideSwap
 * surjection failure"). SideSwap re-blinds a fresh swap PSET on EVERY quote
 * tick; the asset surjection proof is probabilistic (secp256k1-zkp samples
 * min(3,n) inputs, up to 100 iters). With many taker UTXOs vs 1-2 maker inputs
 * the per-tick failure is material and TRANSIENT by construction — the server
 * re-rolls with a fresh seed on the next tick, and the PREVIOUSLY delivered
 * quote stays executable within its TTL. Only the exact secp256k1-zkp message
 * classifies as transient; sibling errors ("too many tx inputs", "missing
 * UTXO") are deterministic and must keep surfacing. Ignored ONLY while quoting.
 */
export function isTransientBlindingError(err: unknown): boolean {
  return (
    !!err &&
    (err as SideSwapError).code === SS_ERROR.SERVER_ERROR &&
    typeof (err as SideSwapError).message === "string" &&
    /failed to prove surjection/i.test((err as SideSwapError).message)
  );
}
