// Server-side registry for the OPEN SideSwap quote streams that wallet_swap_quote
// creates and wallet_swap_execute must run on (spec §6.2 fast-follow). SideSwap's
// quote_id is bound to the stream's SOCKET, so execute has to reuse the exact same
// stream — which means the socket must stay open ACROSS the two tool calls. This
// registry is where that cross-call state lives.
//
// SHUTDOWN HYGIENE (the reason these tools were deferred out of PR8, §6.1): a quote
// stream owns a live WebSocket + its waiters. The Boltz Lightning/gift-card/
// stablecoin watches are already disposed by wallet.close() (BoltzConvert.dispose,
// §5.3) — but a SideSwap quote stream is owned by the MCP LAYER, not the wallet, so
// nothing else would tear it down. Therefore:
//   • server.close() calls disposeAll() → every held stream is closed (socket +
//     subscription torn down) — opening a quote then closing the server cancels it,
//     with no hang (close() is synchronous), and the runtime hard-exit watchdog is
//     the backstop if a stream's close() ever wedged.
//   • an abandoned quote (never executed) is force-closed a short grace after its
//     TTL lapses, so a socket never leaks even without a shutdown; the timer is
//     .unref()'d so it never keeps the process alive.

import { randomUUID } from "node:crypto";
import type { SideSwapQuote, SwapExecuteResult, SwapQuoteParams } from "../convert/sideswap.js";
import { ConversionError } from "../errors.js";

export type { SideSwapQuote, SwapExecuteResult, SwapQuoteParams };

/**
 * The minimal SideSwap quote-stream surface the MCP layer drives. The real
 * SwapQuoteStream (convert/sideswap.ts) satisfies it structurally; tests inject a
 * fake so the socket-bound behaviour is exercised without a real WebSocket.
 */
export interface McpSwapQuoteStream {
  next(options?: { timeoutMs?: number }): Promise<SideSwapQuote>;
  execute(quote: SideSwapQuote): Promise<SwapExecuteResult>;
  close(): void;
}

/** The SideSwap sub-facade the fast-follow swap tools call (test-fakeable). */
export interface McpSwapFacade {
  quote(params: SwapQuoteParams): Promise<McpSwapQuoteStream>;
}

interface Entry {
  stream: McpSwapQuoteStream;
  quote: SideSwapQuote;
  timer: ReturnType<typeof setTimeout>;
}

/** Grace after a quote's TTL before the registry force-closes an abandoned stream. */
export const ABANDON_GRACE_MS = 2_000;

export class SwapStreamRegistry {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** How many streams are currently held open (test/introspection). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Hold an open quote stream + its pinned quote under a fresh id, returned to the
   * agent so wallet_swap_execute can find the same socket. Arms an .unref()'d
   * timer that force-closes the stream if it is neither executed nor cleaned up by
   * the time its TTL (+grace) elapses. If the registry is already disposed (server
   * shutting down), the just-opened stream is closed and the call rejects rather
   * than leaking a socket.
   */
  register(stream: McpSwapQuoteStream, quote: SideSwapQuote): string {
    if (this.disposed) {
      try {
        stream.close();
      } catch {
        /* best effort */
      }
      throw new ConversionError(
        "SWAP_STREAM_CLOSED",
        "the wallet server is shutting down — request a fresh quote once it is back up",
      );
    }
    const id = randomUUID();
    const delay = Math.max(0, quote.expiresAt - this.now()) + ABANDON_GRACE_MS;
    const timer = setTimeout(() => this.evict(id), delay);
    timer.unref?.();
    this.entries.set(id, { stream, quote, timer });
    return id;
  }

  /**
   * Take an entry OUT of the registry for execution (execute is terminal — it
   * broadcasts, then the caller closes the stream). Removing it first means a
   * concurrent disposeAll() never double-closes a stream mid-execute. Returns
   * undefined for an unknown/expired/already-used id.
   */
  take(id: string): { stream: McpSwapQuoteStream; quote: SideSwapQuote } | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.entries.delete(id);
    return { stream: entry.stream, quote: entry.quote };
  }

  /** Timer-driven eviction of an abandoned stream: close its socket and drop it. */
  private evict(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    try {
      entry.stream.close();
    } catch {
      /* best effort */
    }
  }

  /**
   * Close every held stream and block new registrations. Called by server.close()
   * on shutdown so a quoted-but-not-executed swap never leaves a live socket
   * behind. Idempotent and synchronous — it must not make shutdown hang.
   */
  disposeAll(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
      try {
        entry.stream.close();
      } catch {
        /* best effort */
      }
    }
    this.entries.clear();
  }
}
