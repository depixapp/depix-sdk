// The swap-stream registry holds the socket-bound SideSwap quote streams that
// wallet_swap_quote opens and wallet_swap_execute consumes. It must: hand back a
// stream by id exactly once, force-close an abandoned stream after its TTL, and —
// the deferral-critical guarantee — close EVERY held stream on disposeAll() so a
// server shutdown with a quote in flight leaves no live socket (§6.1).

import { describe, expect, it, vi } from "vitest";
import { ABANDON_GRACE_MS, SwapStreamRegistry, type McpSwapQuoteStream } from "../src/mcp/swap-streams.js";
import type { SideSwapQuote, SwapExecuteResult } from "../src/convert/sideswap.js";

/** A fake quote stream that records close() and never touches a socket. */
class FakeStream implements McpSwapQuoteStream {
  closed = 0;
  constructor(private readonly execResult?: SwapExecuteResult) {}
  next(): Promise<SideSwapQuote> {
    return Promise.reject(new Error("not used in these tests"));
  }
  execute(): Promise<SwapExecuteResult> {
    return Promise.resolve(this.execResult ?? ({ txid: "tx" } as SwapExecuteResult));
  }
  close(): void {
    this.closed++;
  }
}

function quote(expiresAt: number): SideSwapQuote {
  return {
    quoteId: 1,
    from: "DEPIX",
    to: "LBTC",
    sendAmountSats: 1_000n,
    recvAmountSats: 900n,
    serverFeeSats: 1n,
    fixedFeeSats: 0n,
    feeAsset: null,
    ttlMs: 20_000,
    expiresAt,
    receiveAddress: "lq1qrecv",
  };
}

describe("SwapStreamRegistry", () => {
  it("registers a stream and takes it back exactly once", () => {
    const reg = new SwapStreamRegistry({ now: () => 0 });
    const stream = new FakeStream();
    const id = reg.register(stream, quote(20_000));
    expect(reg.size).toBe(1);
    const taken = reg.take(id);
    expect(taken?.stream).toBe(stream);
    expect(reg.size).toBe(0);
    // A second take is a miss (used) — and the id is a fresh UUID, not guessable.
    expect(reg.take(id)).toBeUndefined();
  });

  it("take() clears the abandon timer so the stream is not double-closed later", () => {
    vi.useFakeTimers();
    const reg = new SwapStreamRegistry({ now: () => 0 });
    const stream = new FakeStream();
    const id = reg.register(stream, quote(20_000));
    reg.take(id);
    vi.advanceTimersByTime(20_000 + ABANDON_GRACE_MS + 1_000);
    expect(stream.closed).toBe(0); // taken → its timer was cleared
    vi.useRealTimers();
  });

  it("force-closes an abandoned (never-executed) stream after TTL + grace", () => {
    vi.useFakeTimers();
    const reg = new SwapStreamRegistry({ now: () => 0 });
    const stream = new FakeStream();
    reg.register(stream, quote(20_000));
    vi.advanceTimersByTime(20_000 + ABANDON_GRACE_MS - 1);
    expect(stream.closed).toBe(0);
    vi.advanceTimersByTime(2);
    expect(stream.closed).toBe(1);
    expect(reg.size).toBe(0);
    vi.useRealTimers();
  });

  it("disposeAll() closes EVERY held stream (shutdown with quotes in flight)", () => {
    const reg = new SwapStreamRegistry({ now: () => 0 });
    const a = new FakeStream();
    const b = new FakeStream();
    reg.register(a, quote(20_000));
    reg.register(b, quote(20_000));
    expect(reg.size).toBe(2);
    reg.disposeAll();
    expect(a.closed).toBe(1);
    expect(b.closed).toBe(1);
    expect(reg.size).toBe(0);
  });

  it("disposeAll() is idempotent and synchronous (never hangs shutdown)", () => {
    const reg = new SwapStreamRegistry({ now: () => 0 });
    const a = new FakeStream();
    reg.register(a, quote(20_000));
    reg.disposeAll();
    reg.disposeAll();
    expect(a.closed).toBe(1); // closed exactly once
  });

  it("rejects registration after disposal and closes the just-opened stream", () => {
    const reg = new SwapStreamRegistry({ now: () => 0 });
    reg.disposeAll();
    const late = new FakeStream();
    expect(() => reg.register(late, quote(20_000))).toThrow(/shutting down/);
    expect(late.closed).toBe(1); // not leaked
  });
});
