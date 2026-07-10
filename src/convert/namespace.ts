// wallet.convert.* namespace (spec §2.3, §5). PR4 wires the SideSwap sub-tree;
// PR5 (Boltz) adds sibling sub-trees to the SAME `convert` object the same way.
// Kept small and additive so a merge of the two PRs conflicts minimally.

import type { FetchLike } from "../api/client.js";
import { ConversionError, WalletError } from "../errors.js";
import type { BoltzConvert } from "./boltz/convert.js";
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
import { SideShiftNamespace, type SendUsdt } from "./sideshift.js";
import { SideShiftStore } from "./sideshift-store.js";

export interface ConvertNamespaceOptions {
  /** Client factory (default: real WS). Tests inject a fake. */
  clientFactory?: (options: SideSwapClientOptions) => SideSwapClient;
  /** Foreign-PSET signer override (tests). */
  signForeignPset?: SideSwapMarketDeps["signForeignPset"];
  now?: () => number;
  /** SideShift injection (§5.4) — tests inject fetch / affiliateId / store / signing seam. */
  sideshift?: {
    fetchImpl?: FetchLike;
    affiliateId?: string;
    store?: SideShiftStore;
    sendUsdt?: SendUsdt;
  };
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

/** The `wallet.convert` object. PR5 adds `boltz`, PR5c `sideshift`, alongside `sideswap`. */
export class ConvertNamespace {
  readonly sideswap: SideSwapNamespace;
  /** SideShift USDt cross-network (§5.4) — CUSTODIAL, signalled (G4). */
  readonly sideshift: SideShiftNamespace;
  // The Boltz Lightning sub-namespace (§5.3) — null on a view-only/wiped wallet
  // (no seed to sign the L-BTC lockup). The wallet constructs the BoltzConvert
  // (it needs the seed store + lockup signer) and injects it here; `.boltz`
  // surfaces it, mirroring how `.sideswap` sits beside it.
  private readonly boltzNamespace: BoltzConvert | null;

  constructor(
    hooks: ConvertWalletHooks,
    options: ConvertNamespaceOptions = {},
    boltz: BoltzConvert | null = null
  ) {
    const market = new SideSwapMarket({
      hooks,
      clientFactory: options.clientFactory,
      signForeignPset: options.signForeignPset,
      now: options.now
    });
    const pending = new PendingPegIn(hooks.dataDir, { now: options.now, logger: hooks.logger });
    const peg = new SideSwapPeg({ hooks, pending, clientFactory: options.clientFactory });
    this.sideswap = new SideSwapNamespace(market, peg);
    // SideShift (§5.4) — CUSTODIAL, signalled (G4). Reuses the SAME hooks (choke
    // point, valuator, op mutex, encrypted seed) as .sideswap; the affiliate id is
    // baked at build (never env/backend). A view-only/wiped wallet cannot SEND (no
    // seed), but quote/receive/getStatus are safe — no seed gate at construction.
    this.sideshift = new SideShiftNamespace({
      hooks,
      store: options.sideshift?.store ?? new SideShiftStore({ dataDir: hooks.dataDir, logger: hooks.logger }),
      ...(options.sideshift?.fetchImpl ? { fetchImpl: options.sideshift.fetchImpl } : {}),
      ...(options.sideshift?.affiliateId !== undefined ? { affiliateId: options.sideshift.affiliateId } : {}),
      ...(options.sideshift?.sendUsdt ? { sendUsdt: options.sideshift.sendUsdt } : {}),
      ...(options.now ? { now: options.now } : {})
    });
    this.boltzNamespace = boltz;
  }

  /**
   * The Boltz Lightning sub-namespace: `wallet.convert.boltz.*` (§5.3) — LN
   * send/receive + refund. Throws WALLET_NOT_FOUND on a view-only/wiped wallet
   * (no seed to sign the lockup), the same gate the seed-bound flows use.
   */
  get boltz(): BoltzConvert {
    if (!this.boltzNamespace) {
      throw new WalletError(
        "WALLET_NOT_FOUND",
        "This wallet has no seed material (view-only/wiped) — Lightning conversions are unavailable."
      );
    }
    return this.boltzNamespace;
  }
}
