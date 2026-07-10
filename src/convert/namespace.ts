// wallet.convert.* namespace (spec §2.3, §5). PR4 wires the SideSwap sub-tree;
// PR5 (Boltz) adds sibling sub-trees to the SAME `convert` object the same way.
// Kept small and additive so a merge of the two PRs conflicts minimally.

import { ConversionError } from "../errors.js";
import type { ConvertWalletHooks } from "./hooks.js";
import { PendingPegIn } from "./pending-pegin.js";
import {
  resolveQuoteStream,
  SideSwapMarket,
  type SideSwapMarketDeps,
  type SwapExecuteResult,
  type SwapQuoteParams,
  type SwapQuoteStream
} from "./sideswap.js";
import {
  SideSwapPeg,
  type PegInResult,
  type PegOutParams,
  type PegOutResult,
  type PegStatusResult
} from "./sideswap-peg.js";
import type { SideSwapClient, SideSwapClientOptions } from "./sideswap-client.js";

export interface ConvertNamespaceOptions {
  /** Client factory (default: real WS). Tests inject a fake. */
  clientFactory?: (options: SideSwapClientOptions) => SideSwapClient;
  /** Foreign-PSET signer override (tests). */
  signForeignPset?: SideSwapMarketDeps["signForeignPset"];
  now?: () => number;
}

/**
 * The SideSwap sub-namespace: `wallet.convert.sideswap.*`.
 *   quote()   → a live SwapQuoteStream (stream of quotes with TTL); call
 *               stream.next() (or async-iterate) then stream.execute(quote).
 *   execute() → convenience for stream.execute — resolves the originating
 *               stream from the quote object (the quote_id is socket-bound).
 *   pegIn/pegOut/pegStatus → §5.2.
 */
export class SideSwapNamespace {
  private readonly market: SideSwapMarket;
  private readonly peg: SideSwapPeg;

  constructor(market: SideSwapMarket, peg: SideSwapPeg) {
    this.market = market;
    this.peg = peg;
  }

  /** Open a live quote stream (§5.1). Remember to stream.close() when done. */
  quote(params: SwapQuoteParams): Promise<SwapQuoteStream> {
    return this.market.quote(params);
  }

  /**
   * Execute a quote returned by a stream's next() (§5.1). Delegates to the
   * originating stream (execute must run on the quote's socket). Prefer
   * stream.execute(quote) directly when you hold the stream.
   */
  execute(quote: Parameters<SwapQuoteStream["execute"]>[0]): Promise<SwapExecuteResult> {
    const stream = resolveQuoteStream(quote);
    if (!stream) {
      throw new ConversionError(
        "SWAP_VALIDATION_FAILED",
        "this quote has no live stream (its socket was closed) — request a fresh quote via convert.sideswap.quote()"
      );
    }
    return stream.execute(quote);
  }

  /** Start a peg-in (BTC → L-BTC) — one in flight at a time (§5.2). */
  pegIn(): Promise<PegInResult> {
    return this.peg.pegIn();
  }

  /** Peg-out (L-BTC → BTC) to a BTC address checked against allowlist.btcAddresses (§5.2). */
  pegOut(params: PegOutParams): Promise<PegOutResult> {
    return this.peg.pegOut(params);
  }

  /** Poll a peg order status (read-only). */
  pegStatus(args: { orderId: string; pegIn: boolean }): Promise<PegStatusResult> {
    return this.peg.pegStatus(args);
  }

  /** Read the tracked in-flight peg-in, if any. */
  getPendingPegIn(): Promise<PegInResult | null> {
    return this.peg.getPendingPegIn();
  }

  /** Clear the tracked in-flight peg-in (e.g. once settled). */
  clearPendingPegIn(): Promise<void> {
    return this.peg.clearPendingPegIn();
  }
}

/** The `wallet.convert` object. PR5 adds `boltz` alongside `sideswap`. */
export class ConvertNamespace {
  readonly sideswap: SideSwapNamespace;

  constructor(hooks: ConvertWalletHooks, options: ConvertNamespaceOptions = {}) {
    const market = new SideSwapMarket({
      hooks,
      clientFactory: options.clientFactory,
      signForeignPset: options.signForeignPset,
      now: options.now
    });
    const pending = new PendingPegIn(hooks.dataDir, { now: options.now, logger: hooks.logger });
    const peg = new SideSwapPeg({ hooks, pending, clientFactory: options.clientFactory });
    this.sideswap = new SideSwapNamespace(market, peg);
  }
}
