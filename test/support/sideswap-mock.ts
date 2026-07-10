// Test doubles for the SideSwap suites (not a *.test.ts — not collected).
//
// FakeWebSocket drives the raw JSON-RPC client (sideswap-client.test.ts):
// auto-opens on the next microtask, records every client→server frame, and lets
// the test respond by id or push notifications. FakeSideSwapClient is the
// higher-level double for the orchestrator suites (market/peg) — it implements
// the SideSwapClient surface with spies and a controllable quote channel.

import type {
  PegResult,
  PegStatusResult,
  SideSwapClient,
  SideSwapQuoteEvent,
  StartQuotesParams,
  SubscriptionHandle,
  WebSocketCtor,
  WebSocketLike
} from "../../src/convert/sideswap-client.js";

type ServerFrame = { jsonrpc: string; id?: number | null; result?: unknown; error?: { message?: string }; method?: string; params?: unknown };
type ClientFrame = { jsonrpc: string; id: number; method: string; params: Record<string, unknown> };

/** A minimal scripted WebSocket. onSend fires on every client→server frame. */
export class FakeWebSocket implements WebSocketLike {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  readonly sent: ClientFrame[] = [];
  private readonly onSend?: (msg: ClientFrame, ws: FakeWebSocket) => void;

  constructor(_url: string, onSend?: (msg: ClientFrame, ws: FakeWebSocket) => void) {
    this.onSend = onSend;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data: string): void {
    const msg = JSON.parse(data) as ClientFrame;
    this.sent.push(msg);
    this.onSend?.(msg, this);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  /** Deliver a raw server frame to the client. */
  deliver(frame: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  respond(id: number, result: unknown): void {
    this.deliver({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number, message: string): void {
    this.deliver({ jsonrpc: "2.0", id, error: { message } });
  }

  notify(method: string, params: unknown): void {
    this.deliver({ jsonrpc: "2.0", method, params });
  }
}

/** Build a WebSocket ctor bound to a send handler; exposes created instances. */
export function makeFakeWebSocket(onSend?: (msg: ClientFrame, ws: FakeWebSocket) => void): {
  WebSocketImpl: WebSocketCtor;
  instances: FakeWebSocket[];
} {
  const instances: FakeWebSocket[] = [];
  class Bound extends FakeWebSocket {
    constructor(url: string) {
      super(url, onSend);
      instances.push(this);
    }
  }
  return { WebSocketImpl: Bound as unknown as WebSocketCtor, instances };
}

// ─── higher-level orchestrator double ────────────────────────────────────────

export interface FakeClientScript {
  getQuote?: (quoteId: number | string) => Promise<{ pset: string; quoteId: number | string; ttlMs: number | null }>;
  takerSign?: (args: { quoteId: number | string; signedPset: string }) => Promise<{ txid: string }>;
  pegIn?: (args: { recvAddr: string }) => Promise<PegResult>;
  pegOut?: (args: { recvAddr: string; blocks?: number }) => Promise<PegResult>;
  pegStatus?: (args: { orderId: string; pegIn: boolean }) => Promise<PegStatusResult>;
}

/** A controllable SideSwapClient double. Push quotes/errors via the captured handlers. */
export class FakeSideSwapClient implements SideSwapClient {
  connectCount = 0;
  disconnectCount = 0;
  readonly startQuotesCalls: StartQuotesParams[] = [];
  readonly getQuoteCalls: Array<number | string> = [];
  readonly takerSignCalls: Array<{ quoteId: number | string; signedPset: string }> = [];
  readonly pegOutCalls: Array<{ recvAddr: string; blocks?: number }> = [];
  readonly pegInCalls: Array<{ recvAddr: string }> = [];
  private onQuote?: (q: SideSwapQuoteEvent) => void;
  private onError?: (err: unknown) => void;

  constructor(private readonly script: FakeClientScript = {}) {}

  async connect(): Promise<void> {
    this.connectCount++;
  }
  disconnect(): void {
    this.disconnectCount++;
  }
  isConnected(): boolean {
    return true;
  }
  hasMarkets(): boolean {
    return true;
  }

  startQuotes(params: StartQuotesParams): SubscriptionHandle {
    this.startQuotesCalls.push(params);
    this.onQuote = params.onQuote;
    this.onError = params.onError as (err: unknown) => void;
    return { unsubscribe: () => {} };
  }

  /** Test helper — push a quote tick to the active subscription. */
  emitQuote(q: SideSwapQuoteEvent): void {
    this.onQuote?.(q);
  }
  /** Test helper — push an error to the active subscription. */
  emitError(err: unknown): void {
    this.onError?.(err);
  }

  async getQuote(quoteId: number | string): Promise<{ pset: string; quoteId: number | string; ttlMs: number | null }> {
    this.getQuoteCalls.push(quoteId);
    if (this.script.getQuote) return this.script.getQuote(quoteId);
    return { pset: "FAKE_PSET_B64", quoteId, ttlMs: 30_000 };
  }

  async takerSign(args: { quoteId: number | string; signedPset: string }): Promise<{ txid: string }> {
    this.takerSignCalls.push(args);
    if (this.script.takerSign) return this.script.takerSign(args);
    return { txid: "fake_txid" };
  }

  async pegIn(args: { recvAddr: string }): Promise<PegResult> {
    this.pegInCalls.push(args);
    if (this.script.pegIn) return this.script.pegIn(args);
    return { orderId: "peg_order_in", pegAddr: "bc1qpegin", expiresAt: null };
  }

  async pegOut(args: { recvAddr: string; blocks?: number }): Promise<PegResult> {
    this.pegOutCalls.push(args);
    if (this.script.pegOut) return this.script.pegOut(args);
    // A REAL valid mainnet Liquid address so the peg-out build reaches finish()
    // (an unparseable placeholder would trip INVALID_ADDRESS first).
    return {
      orderId: "peg_order_out",
      pegAddr:
        "lq1qqvxk052kf3qtkxmrakx50a9gc3smqad2ync54hzntjt980kfej9kkfe0247rp5h4yzmdftsahhw64uy8pzfe7cpg4fgykm7cv",
      recvAmount: null,
      expiresAt: null,
      createdAt: null
    };
  }

  async pegStatus(args: { orderId: string; pegIn: boolean }): Promise<PegStatusResult> {
    if (this.script.pegStatus) return this.script.pegStatus(args);
    return { orderId: args.orderId, status: "Unknown", confirmations: 0, txid: null, deposits: [] };
  }

  async serverStatus(): Promise<Record<string, unknown>> {
    return {};
  }
}
