// The high-level INTENT layer (PR-B/PR-C): wallet.quote() + wallet.convert().
//
// quote({from, to, network, amount})   → EVERY candidate route (single- and
//   multi-hop) with per-leg estimates. No policy: the SDK never ranks or picks
//   beyond a stable ordering — the AGENT chooses.
// convert({from, to, network, amount}) → executes exactly ONE route and hides
//   the provider mechanics behind one call:
//     sideswap market — the quote stream (quote → next → execute → close) is
//       managed internally; the agent never sees a stream or a quote TTL.
//     boltz           — the `completion` promise the provider methods return is
//       awaited internally (bounded by a timeout).
//     sideshift/peg   — status is polled to a terminal state internally
//       (bounded by a timeout).
//   By default (wait: true) convert() returns only once the conversion settled;
//   on timeout it returns status "pending" with an actionable nextStep — funds
//   in flight are never an exception.
//
// MULTI-HOP (PR-C): a route with hops > 1 executes end to end — legs run in
//   sequence on REAL settled amounts behind a durable encrypted plan with
//   crash recovery (src/convert/multihop.ts).
//
// Ambiguity is a typed error, never a silent choice: without an explicit
// `route`, convert() executes when the trio resolves to exactly one single-hop
// table row (multi-hop compositions of that same intent are quote() material,
// not implicit competitors), OR when exactly ONE candidate exists at all —
// even multi-hop (nothing to choose between; the locked rule is
// "1 route → execute"). Anything else throws MULTIPLE_ROUTES_AVAILABLE
// carrying every candidate.
//
// GUARDRAILS: this layer adds NO signing path. Every money-moving leg delegates
// to the provider methods (§5.1–§5.4), each of which routes through the §4.3
// choke point (valuate → enforce → sign → record) under the wallet op mutex —
// the intent layer cannot bypass it by construction. A multi-hop plan counts
// its value ONCE (§4.3 count-once — see multihop.ts/continuation.ts).

import { MAINNET_ASSET_ID_TO_KEY, type AssetKey } from "../assets.js";
import { ConversionError, WalletError, type ErrorDetails } from "../errors.js";
import { estimateReverseReceive, getReverseLimits } from "./boltz/reverse.js";
import {
  estimateStablecoinOut,
  type StablecoinAsset,
  type StablecoinEstimate
} from "./boltz/stablecoin.js";
import type {
  PayLightningResult,
  ReceiveLightningResult,
  ToStablecoinResult
} from "./boltz/convert.js";
import type { BoltzConvert } from "./boltz/convert.js";
import type { Logger } from "../logger.js";
import { executeMultiHopRoute } from "./multihop.js";
import type { ConversionPlanStore } from "./plan-store.js";
import type { ConvertNamespace, SideSwapNamespace } from "./namespace.js";
import { enumerateRoutes, type ConvertIntent, type Route, type RouteLeg } from "./routes.js";
import type {
  NextQuoteOptions,
  SideSwapQuote,
  SwapExecuteResult,
  SwapQuoteParams
} from "./sideswap.js";
import type { PegInResult, PegOutParams, PegOutResult } from "./sideswap-peg.js";
import type { PegStatusResult } from "./sideswap-client.js";
import {
  usdtDecimalToSats,
  type SideShiftNamespace,
  type SideShiftQuote,
  type SideShiftReceiveResult,
  type SideShiftSendResult,
  type SideShiftStatusResult
} from "./sideshift.js";

export type { ConvertIntent, Route, RouteLeg } from "./routes.js";

// ─── provider seam (structural — the real namespaces satisfy these) ───────────

/** The slice of a SwapQuoteStream the intent layer drives (and hides). */
export interface IntentQuoteStream {
  next(options?: NextQuoteOptions): Promise<SideSwapQuote>;
  execute(quote: SideSwapQuote): Promise<SwapExecuteResult>;
  close(): void;
}

export interface IntentSideswap {
  quote(params: SwapQuoteParams): Promise<IntentQuoteStream>;
  pegIn(): Promise<PegInResult>;
  pegOut(params: PegOutParams): Promise<PegOutResult>;
  pegStatus(args: { orderId: string; pegIn: boolean }): Promise<PegStatusResult>;
}

export interface IntentSideshift {
  quote(params: { network: string; amountSats: bigint }): Promise<SideShiftQuote>;
  send(params: {
    network: string;
    amountSats: bigint;
    settleAddress: string;
    refundAddress?: string;
  }): Promise<SideShiftSendResult>;
  receive(params: { network: string; refundAddress?: string }): Promise<SideShiftReceiveResult>;
  getStatus(shiftId: string): Promise<SideShiftStatusResult>;
}

export interface IntentBoltz {
  payLightningInvoice(params: { invoice: string }): Promise<PayLightningResult>;
  receiveLightning(params: { amountSats: number }): Promise<ReceiveLightningResult>;
  toStablecoin(params: {
    asset: StablecoinAsset;
    networkId: string;
    amountSats: number;
    claimAddress: string;
  }): Promise<ToStablecoinResult>;
}

/** Everything the intent layer needs — the wallet wires the real namespaces. */
export interface IntentDeps {
  sideswap: IntentSideswap;
  sideshift: IntentSideshift;
  /** Lazy: `convert.boltz` throws WALLET_NOT_FOUND on a view-only/wiped wallet. */
  getBoltz: () => IntentBoltz;
  /** Stablecoin route estimator (default: estimateStablecoinOut — read-only). */
  estimateStablecoin?: (p: {
    asset: StablecoinAsset;
    networkId: string;
    amountSats: number;
  }) => Promise<StablecoinEstimate>;
  /** Reverse (BTC-lightning → L-BTC) pair fees (default: getReverseLimits). */
  reverseLimits?: () => Promise<{ fees: unknown }>;
  /** Settle-poll cadence (default 5 s). Tests inject 1 ms. */
  pollIntervalMs?: number;
  /** Default settle wait bound (default 15 min); per-call timeoutMs overrides. */
  settleTimeoutMs?: number;
  /**
   * Durable, encrypted multi-hop conversion-plan store (PR-C). null/absent on a
   * view-only/wiped wallet (no seed key) — multi-hop convert() is then refused
   * with a per-leg fallback instruction.
   */
  planStore?: ConversionPlanStore | null;
  /**
   * Probe a Boltz swap's stored state by swapId (multi-hop recovery). Reads the
   * SAME durable swap store boltz.resume() drives; absent on a seedless wallet.
   */
  probeBoltzSwap?: (swapId: string) => Promise<{ type: string; state: string } | null>;
  /** Plan id factory (tests inject deterministic ids). Default: crypto.randomUUID. */
  newPlanId?: () => string;
  /** Clock injection (plan createdAt). Default Date.now. */
  now?: () => number;
  /** Logger for the multi-hop executor/recovery (default: the module logger). */
  logger?: Logger;
}

/** Advanced/testing overrides for the intent layer (ConvertNamespaceOptions.intent). */
export interface ConvertIntentOptions {
  estimateStablecoin?: IntentDeps["estimateStablecoin"];
  reverseLimits?: IntentDeps["reverseLimits"];
  pollIntervalMs?: number;
  settleTimeoutMs?: number;
}

// ─── public types ─────────────────────────────────────────────────────────────

/** A route leg with its (best-effort) estimates. All amounts in 8-decimal base units. */
export interface RouteLegQuote extends RouteLeg {
  /** Estimated output of this leg in 8-decimal base units of `to`; null = unavailable. */
  estimatedReceivedSats: bigint | null;
  /** Estimated fee of this leg in 8-decimal base units of `feeAsset`; null = unavailable. */
  estimatedFeeSats: bigint | null;
  /** The asset the fee is denominated in (null when unknown / no fee reported). */
  feeAsset: AssetKey | null;
  /** Why an estimate is missing / any caveat. */
  note?: string;
}

/** One candidate route with chained estimates — what quote() returns. */
export interface RouteQuote {
  id: string;
  legs: readonly RouteLegQuote[];
  hops: number;
  /** true iff ANY leg transits a custodial provider (SideShift) — signalled (G4). */
  custodial: boolean;
  /** Final estimated receipt in 8-decimal base units of the intent's `to`; null = incomplete. */
  estimatedReceivedSats: bigint | null;
  /**
   * Sum of the leg fees — only when every leg reported a fee in the SAME asset
   * (`feeAsset`); otherwise null (compare estimatedReceivedSats instead).
   */
  estimatedFeeTotalSats: bigint | null;
  feeAsset: AssetKey | null;
  /** true when every leg produced an estimate (the chain is complete). */
  estimateComplete: boolean;
  notes: readonly string[];
}

export interface ConvertParams extends ConvertIntent {
  /** A route id (or a quote() route object) — REQUIRED when >1 candidate exists. */
  route?: string | { id: string };
  /** Wait for settlement (default true). Inflow routes return funding details immediately. */
  wait?: boolean;
  /** FINAL destination for outbound cross-network routes (pegOut / toStablecoin / sideshift.send). */
  address?: string;
  /** BOLT11 invoice — the destination of an LBTC → BTC@lightning conversion. */
  invoice?: string;
  /** SideShift refund address (send only; allowlist-gated like the settle address). */
  refundAddress?: string;
  /** Settle wait bound in ms (default: deps.settleTimeoutMs ?? 15 min). */
  timeoutMs?: number;
}

export type ConvertStatus =
  | "settled"
  | "pending"
  | "awaiting_funding"
  | "refunded"
  | "refund_pending"
  | "failed";

/** Funding instructions for INFLOW routes (external party must act first). */
export interface ConvertFunding {
  kind: "bitcoin-address" | "lightning-invoice" | "external-deposit-address";
  address?: string;
  invoice?: string;
  /** The network the external funds must be sent on. */
  network?: string;
  min?: string | null;
  max?: string | null;
  expiresAt?: number | null;
}

export interface ConvertResult {
  route: Route;
  status: ConvertStatus;
  /** Every txid this conversion produced so far (lockup/send first, payout/claim after). */
  txids: readonly string[];
  /** Actual receipt in 8-decimal base units of `to`, when the provider reports it. */
  receivedSats: bigint | null;
  /** true when the executed route transits a custodial provider (G4, signalled). */
  custodial: boolean;
  /** Provider tracking id (swapId / shiftId / peg orderId). */
  trackingId?: string;
  funding?: ConvertFunding;
  /** What to do next when the result is not terminal (G3 — always actionable). */
  nextStep?: string;
}

// ─── defaults / small helpers ─────────────────────────────────────────────────

const DEFAULT_SETTLE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

const VALID_INTENT_HINT =
  "Assets: DEPIX | USDT | LBTC | BTC | USDC. Networks: liquid (default) | bitcoin | lightning | " +
  "ethereum | polygon | arbitrum | optimism | base | tron | bsc | solana. " +
  "Examples: {from:'DEPIX',to:'LBTC'} (market swap), {from:'LBTC',to:'BTC',network:'lightning'} (pay an invoice), " +
  "{from:'USDT',to:'USDT',network:'tron'} (SideShift out).";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function conversionError(code: string, message: string, details: ErrorDetails): ConversionError {
  return new ConversionError(code, message, { details });
}

/** JSON-safe view of a route for error details (bigint-free by construction). */
function routeForDetails(route: Route): Record<string, unknown> {
  return {
    id: route.id,
    hops: route.hops,
    custodial: route.custodial,
    legs: route.legs.map((l) => ({ ...l }))
  };
}

/** A leg as an explicit single-hop convert() call — the manual/per-leg fallback text. */
export function legAsConvertCall(leg: RouteLeg): string {
  const fromNetwork = leg.fromNetwork !== "liquid" ? `, fromNetwork: '${leg.fromNetwork}'` : "";
  return `convert({ from: '${leg.from}', to: '${leg.to}', network: '${leg.network}'${fromNetwork}, amount: <bigint> })`;
}

/**
 * Narrow a bigint sats amount to the `number` a boltz provider method expects.
 * These legs are LBTC-denominated (BTC sats), so the value stays far below 2^53
 * (~90M BTC) — safe in practice. This is the ONLY place the otherwise-bigint
 * pipeline drops to float, so guard the bound explicitly rather than let a
 * precision cliff pass silently.
 */
function toProviderAmount(amountSats: bigint): number {
  if (amountSats > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new WalletError("INVALID_AMOUNT", `amount ${amountSats} exceeds the provider's safe-integer bound`, {
      details: {
        nextStep: `split the conversion into smaller amounts (max ${Number.MAX_SAFE_INTEGER} sats per leg).`
      }
    });
  }
  return Number(amountSats);
}

function validateIntent(intent: ConvertIntent): void {
  if (typeof intent.amount !== "bigint" || intent.amount <= 0n) {
    throw new WalletError("INVALID_AMOUNT", "amount must be a positive bigint (8-decimal base units of `from`)", {
      details: { nextStep: "pass `amount` as a bigint in sats, e.g. 100_000_000n for 1.0 of an 8-decimal asset" }
    });
  }
}

function resolveRoutesOrThrow(intent: ConvertIntent): Route[] {
  const routes = enumerateRoutes(intent);
  if (routes.length === 0) {
    throw new WalletError(
      "UNSUPPORTED_ASSET",
      `No conversion route exists for ${intent.from}${intent.fromNetwork ? `@${intent.fromNetwork}` : ""} → ` +
        `${intent.to}@${intent.network ?? "liquid"}.`,
      { details: { nextStep: `Adjust the intent trio. ${VALID_INTENT_HINT}` } }
    );
  }
  return routes;
}

async function pollUntil<T>(
  poll: () => Promise<T>,
  isDone: (value: T) => boolean,
  opts: { timeoutMs: number; intervalMs: number }
): Promise<{ last: T; timedOut: boolean }> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const last = await poll();
    if (isDone(last)) return { last, timedOut: false };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { last, timedOut: true };
    await sleep(Math.max(1, Math.min(opts.intervalMs, remaining)));
  }
}

/** Race a provider `completion` promise against the settle bound (timer cleared). */
async function awaitCompletion<T>(
  completion: Promise<T>,
  timeoutMs: number
): Promise<{ outcome: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      completion.then((outcome) => ({ outcome })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ─── quote(): enumerate + estimate ────────────────────────────────────────────

interface LegEstimate {
  receivedSats: bigint | null;
  feeSats: bigint | null;
  feeAsset: AssetKey | null;
  note?: string;
}

const NO_ESTIMATE_NOTES: Partial<Record<RouteLeg["method"], string>> = {
  pegIn:
    "peg-in fees are applied by SideSwap at order time (plus the BTC network fee you pay to fund) — no pre-estimate",
  pegOut: "peg-out fees are applied by SideSwap at order time — no pre-estimate",
  payLightningInvoice:
    "Boltz submarine fees are invoice-specific — pass `invoice` to convert() for exact amounts",
  receive: "SideShift variable-rate shift — the rate is fixed only when the deposit arrives"
};

async function estimateLeg(leg: RouteLeg, amountIn: bigint, deps: IntentDeps): Promise<LegEstimate> {
  switch (leg.method) {
    case "swap": {
      // A short-lived quote stream, closed immediately — estimate only.
      const stream = await deps.sideswap.quote({
        from: leg.from as AssetKey,
        to: leg.to as AssetKey,
        amountSats: amountIn
      });
      try {
        const quote = await stream.next();
        const feeAssetKey = quote.feeAsset ? (MAINNET_ASSET_ID_TO_KEY[quote.feeAsset] ?? null) : null;
        return {
          receivedSats: quote.recvAmountSats,
          feeSats: quote.serverFeeSats + quote.fixedFeeSats,
          feeAsset: feeAssetKey
        };
      } finally {
        stream.close();
      }
    }
    case "receiveLightning": {
      const limits = await (deps.reverseLimits ?? getReverseLimits)();
      const est = estimateReverseReceive(
        Number(amountIn),
        limits.fees as Parameters<typeof estimateReverseReceive>[1]
      );
      return {
        receivedSats: BigInt(est.receiveSats),
        feeSats: BigInt(est.serviceFeeSats + est.minerFeesSats),
        feeAsset: "LBTC"
      };
    }
    case "toStablecoin": {
      const est = await (deps.estimateStablecoin ?? estimateStablecoinOut)({
        asset: leg.to as StablecoinAsset,
        networkId: leg.network,
        amountSats: Number(amountIn)
      });
      // Normalize the EVM-decimals receipt to the SDK's 8-decimal base units by
      // UP-scaling. Every boltz stablecoin is ≤8-decimal today (STABLECOIN_DECIMALS=6),
      // so 8 - decimals ≥ 0. A >8-decimal token would need DOWN-scaling (divide); the
      // former Math.max(0, …) clamp would instead leave scale=1 and SILENTLY over-report
      // the receipt by 10^(decimals-8). Fail loud if a future boltz variant breaks the
      // assumption (estimate-only path — surfaced upstream as a route note, never a
      // bad number). None exists today.
      if (est.decimals > 8) {
        throw new Error(
          `stablecoin decimals ${est.decimals} > 8 not supported: up-scaling would over-report the receipt`
        );
      }
      const scale = 10n ** BigInt(8 - est.decimals);
      const percentFee =
        typeof est.boltzPercent === "number" && est.boltzPercent > 0
          ? BigInt(Math.ceil((Number(amountIn) * est.boltzPercent) / 100))
          : 0n;
      return {
        receivedSats: est.receiveAmount * scale,
        feeSats: BigInt(est.minerFeesSats) + percentFee,
        feeAsset: "LBTC"
      };
    }
    case "send": {
      const quote = await deps.sideshift.quote({ network: leg.network, amountSats: amountIn });
      const settled = quote.settleAmount !== null ? usdtDecimalToSats(quote.settleAmount) : null;
      if (settled === null) {
        return { receivedSats: null, feeSats: null, feeAsset: null, note: "SideShift quoted no settle amount" };
      }
      return {
        receivedSats: settled,
        feeSats: settled <= amountIn ? amountIn - settled : 0n,
        feeAsset: "USDT"
      };
    }
    default: {
      const note = NO_ESTIMATE_NOTES[leg.method] ?? "no estimator available for this leg";
      return { receivedSats: null, feeSats: null, feeAsset: null, note };
    }
  }
}

async function quoteRoute(route: Route, intent: ConvertIntent, deps: IntentDeps): Promise<RouteQuote> {
  const legs: RouteLegQuote[] = [];
  const notes: string[] = [];
  let carry: bigint | null = intent.amount;

  for (const [index, leg] of route.legs.entries()) {
    let estimate: LegEstimate;
    if (carry === null) {
      estimate = {
        receivedSats: null,
        feeSats: null,
        feeAsset: null,
        note: "upstream leg estimate unavailable — cannot chain"
      };
    } else {
      try {
        estimate = await estimateLeg(leg, carry, deps);
      } catch (err) {
        const reason = String((err as { code?: string }).code ?? (err as Error)?.message ?? err);
        estimate = { receivedSats: null, feeSats: null, feeAsset: null, note: `estimate unavailable: ${reason}` };
      }
    }
    if (estimate.note) notes.push(`leg ${index + 1} (${leg.provider}.${leg.method}): ${estimate.note}`);
    legs.push({
      ...leg,
      estimatedReceivedSats: estimate.receivedSats,
      estimatedFeeSats: estimate.feeSats,
      feeAsset: estimate.feeAsset,
      ...(estimate.note !== undefined ? { note: estimate.note } : {})
    });
    carry = estimate.receivedSats;
  }

  const estimateComplete = legs.every((l) => l.estimatedReceivedSats !== null);
  const feeAssets = new Set(legs.map((l) => l.feeAsset));
  const feesComplete = legs.every((l) => l.estimatedFeeSats !== null) && feeAssets.size === 1;
  const feeAsset = feesComplete ? (legs[0]?.feeAsset ?? null) : null;
  const estimatedFeeTotalSats =
    feesComplete && feeAsset !== null ? legs.reduce((sum, l) => sum + (l.estimatedFeeSats ?? 0n), 0n) : null;
  if (!feesComplete && legs.length > 1 && estimateComplete) {
    notes.push("leg fees are denominated in different assets — compare estimatedReceivedSats across routes instead");
  }

  return {
    id: route.id,
    legs,
    hops: route.hops,
    custodial: route.custodial,
    estimatedReceivedSats: estimateComplete ? carry : null,
    estimatedFeeTotalSats,
    feeAsset,
    estimateComplete,
    notes
  };
}

/**
 * Enumerate EVERY candidate route for the intent and estimate each leg
 * (best-effort — an unestimatable leg yields nulls plus a note, never a throw).
 * The agent compares and passes its choice to convert({ route }).
 */
export async function quoteRoutes(intent: ConvertIntent, deps: IntentDeps): Promise<RouteQuote[]> {
  validateIntent(intent);
  const routes = resolveRoutesOrThrow(intent);
  const quotes: RouteQuote[] = [];
  for (const route of routes) {
    quotes.push(await quoteRoute(route, intent, deps));
  }
  return quotes;
}

// ─── convert(): resolve ONE route, execute single-hop, settle ─────────────────

function resolveSingleRoute(params: ConvertParams): Route {
  const routes = resolveRoutesOrThrow(params);
  const requestedId = typeof params.route === "string" ? params.route : params.route?.id;

  let route: Route;
  if (requestedId !== undefined) {
    const found = routes.find((r) => r.id === requestedId);
    if (!found) {
      throw conversionError("ROUTE_NOT_FOUND", `No candidate route has id "${requestedId}".`, {
        availableRouteIds: routes.map((r) => r.id),
        nextStep:
          "call wallet.quote({ from, to, network, amount }) and pass one of the returned route ids " +
          "(details.availableRouteIds lists them) back to convert({ route })."
      });
    }
    route = found;
  } else {
    // The routing table maps each trio to its designated SINGLE-HOP provider —
    // that unique row executes directly. A trio with exactly ONE candidate of
    // any shape also executes (locked rule: "1 route → execute" — a single
    // multi-hop candidate leaves nothing to choose between). Anything else
    // (two entry rails, several compositions) is ambiguity the SDK refuses to
    // resolve: the agent compares via quote() and passes `route`.
    const singleHop = routes.filter((r) => r.hops === 1);
    if (singleHop.length === 1) {
      // Custodial single-hop auto-executes BY DESIGN. For USDT-liquid → USDT-external
      // the only single-hop row is `sideshift.send` (custodial), so convert() runs it
      // without an explicit `route` — the "one single-hop row ⇒ execute it" rule is
      // provider-agnostic; there is no allowCustodial opt-in. Custody is DISCLOSED, not
      // gated: quote() surfaces `custodial:true` per route BEFORE running, and the
      // ConvertResult carries `custodial:true` AFTER. An integrator who wants a
      // non-custodial path passes the multi-hop boltz route id to convert({ route }).
      route = singleHop[0]!;
    } else if (routes.length === 1) {
      route = routes[0]!;
    } else {
      throw conversionError(
        "MULTIPLE_ROUTES_AVAILABLE",
        `${routes.length} candidate route(s) resolve this intent — the SDK does not choose for you.`,
        {
          routes: routes.map(routeForDetails),
          nextStep:
            "call wallet.quote({ from, to, network, amount }) to compare estimates (fees, receipts, custodial " +
            "flags), then pass your choice back: wallet.convert({ ..., route: '<route id>' }). Multi-hop " +
            "candidates execute end to end (sequential legs behind a crash-safe persisted plan)."
        }
      );
    }
  }
  return route;
}

/** Require the FINAL destination address a route leg delivers to (typed error). */
export function requireConvertAddress(params: ConvertParams, leg: RouteLeg, what: string): string {
  const address = typeof params.address === "string" ? params.address.trim() : "";
  if (!address) {
    throw new WalletError("INVALID_ADDRESS", `This route needs a destination: ${what}.`, {
      details: {
        nextStep:
          `pass \`address\` — the FINAL ${leg.network} destination the funds are delivered to ` +
          "(allowlist-gated when the allowlist is ON, §4.3)."
      }
    });
  }
  return address;
}

/** Require the BOLT11 invoice a lightning-exit leg pays (typed error). */
export function requireConvertInvoice(params: ConvertParams): string {
  const invoice = typeof params.invoice === "string" ? params.invoice.trim() : "";
  if (!invoice) {
    throw new WalletError("INVALID_ADDRESS", "A lightning conversion pays a BOLT11 invoice.", {
      details: {
        nextStep:
          "pass `invoice` — the BOLT11 invoice to pay (its embedded amount governs; `amount` is " +
          "used only for quoting). The lightning payee is allowlist-gated when the allowlist is ON (§4.3)."
      }
    });
  }
  return invoice;
}

/** Per-execution settle/wait knobs shared by the leg executors. */
export interface ExecuteContext {
  route: Route;
  wait: boolean;
  timeoutMs: number;
  intervalMs: number;
}

async function executeMarketSwap(
  leg: RouteLeg,
  params: ConvertParams,
  deps: IntentDeps,
  ctx: ExecuteContext
): Promise<ConvertResult> {
  const stream = await deps.sideswap.quote({
    from: leg.from as AssetKey,
    to: leg.to as AssetKey,
    amountSats: params.amount
  });
  try {
    // One fresh quote, executed on its own stream (the TTL/stream mechanics stay
    // hidden). execute() runs the §4.3 choke point and SideSwap broadcasts — a
    // returned txid IS settlement.
    const quote = await stream.next();
    const result = await stream.execute(quote);
    return {
      route: ctx.route,
      status: "settled",
      txids: [result.txid],
      receivedSats: result.recvAmountSats,
      custodial: false
    };
  } finally {
    stream.close();
  }
}

async function executePegIn(deps: IntentDeps, ctx: ExecuteContext): Promise<ConvertResult> {
  const peg = await deps.sideswap.pegIn();
  return {
    route: ctx.route,
    status: "awaiting_funding",
    txids: [],
    receivedSats: null,
    custodial: false,
    trackingId: peg.orderId,
    funding: {
      kind: "bitcoin-address",
      address: peg.pegAddr,
      network: "bitcoin",
      expiresAt: peg.expiresAt ?? null
    },
    nextStep:
      "fund the BTC address from any bitcoin wallet; SideSwap delivers L-BTC to this wallet after " +
      "~102 BTC confirmations. Track it with wallet.convert.sideswap.pegStatus({ orderId, pegIn: true }) " +
      "or wallet.getPending()."
  };
}

async function executePegOut(
  leg: RouteLeg,
  params: ConvertParams,
  deps: IntentDeps,
  ctx: ExecuteContext
): Promise<ConvertResult> {
  const address = requireConvertAddress(params, leg, "the BTC address the peg-out pays");
  // Guardrail (§4.3: BRL ceilings + btcAddress allowlist) runs inside pegOut().
  const peg = await deps.sideswap.pegOut({ recvAddr: address, amountSats: params.amount });
  const base = {
    route: ctx.route,
    custodial: false,
    trackingId: peg.orderId
  };
  // `peg.recvAmount` is the ORDER-TIME estimate, not a confirmed receipt. Only
  // report it once the peg-out is actually "Done" — on pending/timeout the BTC
  // has NOT been paid out yet, so receivedSats stays null (parity with the boltz
  // executors + the ConvertResult.receivedSats contract: "Actual receipt ... when
  // the provider reports it"). A non-terminal result must never read as delivered.
  const settledReceivedSats = peg.recvAmount !== null ? BigInt(peg.recvAmount) : null;
  const pendingNextStep =
    `the L-BTC was sent (txid ${peg.txid}); SideSwap pays the BTC out-of-band. Poll ` +
    `wallet.convert.sideswap.pegStatus({ orderId: '${peg.orderId}', pegIn: false }) until status "Done".`;
  if (!ctx.wait) {
    return { ...base, status: "pending", txids: [peg.txid], receivedSats: null, nextStep: pendingNextStep };
  }
  const { last, timedOut } = await pollUntil(
    () => deps.sideswap.pegStatus({ orderId: peg.orderId, pegIn: false }),
    (s) => s.status.toLowerCase() === "done",
    { timeoutMs: ctx.timeoutMs, intervalMs: ctx.intervalMs }
  );
  if (timedOut) {
    return { ...base, status: "pending", txids: [peg.txid], receivedSats: null, nextStep: pendingNextStep };
  }
  return {
    ...base,
    status: "settled",
    txids: last.txid ? [peg.txid, last.txid] : [peg.txid],
    receivedSats: settledReceivedSats
  };
}

async function executePayLightning(
  params: ConvertParams,
  deps: IntentDeps,
  ctx: ExecuteContext
): Promise<ConvertResult> {
  const invoice = requireConvertInvoice(params);
  // Guardrail (§4.3) runs inside payLightningInvoice via the wallet's L-BTC lockup.
  const swap = await deps.getBoltz().payLightningInvoice({ invoice });
  const base = { route: ctx.route, custodial: false, trackingId: swap.swapId };
  const pendingNextStep =
    "the L-BTC lockup is in flight; the swap settles (or refunds) in the background — crash-safe. " +
    "Track it with wallet.getPending(); wallet.recover() finishes or refunds it after a restart.";
  if (!ctx.wait) {
    return { ...base, status: "pending", txids: [swap.lockupTxid], receivedSats: null, nextStep: pendingNextStep };
  }
  const settled = await awaitCompletion(swap.completion, ctx.timeoutMs);
  if ("timedOut" in settled) {
    return { ...base, status: "pending", txids: [swap.lockupTxid], receivedSats: null, nextStep: pendingNextStep };
  }
  const outcome = settled.outcome;
  const txids = outcome.refundTxId ? [swap.lockupTxid, outcome.refundTxId] : [swap.lockupTxid];
  if (outcome.status === "paid") {
    return { ...base, status: "settled", txids, receivedSats: BigInt(swap.invoiceSats) };
  }
  return {
    ...base,
    status: outcome.status, // refunded | refund_pending | failed
    txids,
    receivedSats: null,
    nextStep:
      outcome.status === "refund_pending"
        ? "the refund timeout has not been reached yet — wallet.recover() retries it; funds are safe."
        : outcome.status === "failed"
          ? "the swap failed before any settlement — check wallet.getPending() and retry."
          : "the invoice was not paid and the L-BTC came back on-chain — nothing further to do."
  };
}

async function executeReceiveLightning(
  params: ConvertParams,
  deps: IntentDeps,
  ctx: ExecuteContext
): Promise<ConvertResult> {
  const swap = await deps.getBoltz().receiveLightning({ amountSats: toProviderAmount(params.amount) });
  // An INFLOW: the invoice must reach the payer before anything can settle, so
  // convert() never blocks here — `wait` does not apply.
  return {
    route: ctx.route,
    status: "awaiting_funding",
    txids: [],
    receivedSats: null,
    custodial: false,
    trackingId: swap.swapId,
    funding: { kind: "lightning-invoice", invoice: swap.invoice, network: "lightning" },
    nextStep:
      "share the BOLT11 invoice with the payer; once paid, the wallet claims the L-BTC automatically " +
      "(crash-safe — wallet.recover() resumes the claim). Track it with wallet.getPending()."
  };
}

async function executeToStablecoin(
  leg: RouteLeg,
  params: ConvertParams,
  deps: IntentDeps,
  ctx: ExecuteContext
): Promise<ConvertResult> {
  const address = requireConvertAddress(params, leg, `the ${leg.network} address the ${leg.to} is delivered to`);
  // Guardrail (§4.3: BRL ceilings + evm/tron allowlist) runs inside toStablecoin.
  const swap = await deps.getBoltz().toStablecoin({
    asset: leg.to as StablecoinAsset,
    networkId: leg.network,
    amountSats: toProviderAmount(params.amount),
    claimAddress: address
  });
  const base = { route: ctx.route, custodial: false, trackingId: swap.swapId, receivedSats: null };
  const pendingNextStep =
    "the L-BTC lockup is in flight; the EVM legs run in the background — crash-safe. " +
    "wallet.recover() finishes (or refunds) it after a restart; wallet.getPending() tracks it.";
  if (!ctx.wait) {
    return { ...base, status: "pending", txids: [swap.lockupTxid], nextStep: pendingNextStep };
  }
  const settled = await awaitCompletion(swap.completion, ctx.timeoutMs);
  if ("timedOut" in settled) {
    return { ...base, status: "pending", txids: [swap.lockupTxid], nextStep: pendingNextStep };
  }
  const outcome = settled.outcome;
  const txids = [swap.lockupTxid];
  if (outcome.claimTransactionId) txids.push(outcome.claimTransactionId);
  if (outcome.refundTxId) txids.push(outcome.refundTxId);
  if (outcome.status === "settled") {
    return { ...base, status: "settled", txids };
  }
  return {
    ...base,
    status: outcome.status, // pending | refunded | refund_pending | failed
    txids,
    ...(outcome.status === "pending" || outcome.status === "refund_pending" ? { nextStep: pendingNextStep } : {})
  };
}

async function executeSideshiftSend(
  leg: RouteLeg,
  params: ConvertParams,
  deps: IntentDeps,
  ctx: ExecuteContext
): Promise<ConvertResult> {
  const address = requireConvertAddress(params, leg, `the ${leg.network} address the USDT is delivered to`);
  const refundAddress = typeof params.refundAddress === "string" ? params.refundAddress.trim() : "";
  // Guardrail (§4.3: BRL ceilings + settle/refund allowlist) runs inside send().
  const shift = await deps.sideshift.send({
    network: leg.network,
    amountSats: params.amount,
    settleAddress: address,
    ...(refundAddress ? { refundAddress } : {})
  });
  const base = { route: ctx.route, custodial: true, trackingId: shift.shiftId };
  const receivedOf = (settleAmount: string | null): bigint | null =>
    settleAmount !== null ? usdtDecimalToSats(settleAmount) : null;
  const pendingNextStep =
    `the USDt deposit was sent (txid ${shift.txid}); SideShift settles on ${leg.network} — CUSTODIAL mid-flight. ` +
    `Poll wallet.convert.sideshift.getStatus('${shift.shiftId}') until it is terminal.`;
  // CUSTODIAL leg: on any non-terminal (pending/timeout) status the USDt is still
  // mid-flight in SideShift custody. `shift.settleAmount` is only the QUOTED amount
  // (the shift is "waiting" and could settle for less / refund / expire), so we must
  // NOT surface it as receivedSats — which reads as "delivered". receivedSats is
  // populated ONLY once the shift is terminally "settled", from the actual settled
  // amount. Parity with the boltz executors + the ConvertResult.receivedSats contract.
  if (!ctx.wait) {
    return {
      ...base,
      status: "pending",
      txids: [shift.txid],
      receivedSats: null,
      nextStep: pendingNextStep
    };
  }
  const { last, timedOut } = await pollUntil(
    () => deps.sideshift.getStatus(shift.shiftId),
    (s) => s.terminal,
    { timeoutMs: ctx.timeoutMs, intervalMs: ctx.intervalMs }
  );
  if (timedOut) {
    return { ...base, status: "pending", txids: [shift.txid], receivedSats: null, nextStep: pendingNextStep };
  }
  const status: ConvertStatus =
    last.status === "settled" ? "settled" : last.inRefund ? "refunded" : "failed";
  return {
    ...base,
    status,
    txids: [shift.txid],
    receivedSats: status === "settled" ? receivedOf(last.settleAmount ?? shift.settleAmount) : null,
    ...(status === "failed"
      ? {
          nextStep:
            `the shift ended in status "${last.status}". If funds are stuck, set a refund address with ` +
            `wallet.convert.sideshift.setRefundAddress('${shift.shiftId}', <liquid address>).`
        }
      : {})
  };
}

async function executeSideshiftReceive(
  leg: RouteLeg,
  params: ConvertParams,
  deps: IntentDeps,
  ctx: ExecuteContext
): Promise<ConvertResult> {
  const refundAddress = typeof params.refundAddress === "string" ? params.refundAddress.trim() : "";
  const shift = await deps.sideshift.receive({
    network: leg.fromNetwork,
    ...(refundAddress ? { refundAddress } : {})
  });
  return {
    route: ctx.route,
    status: "awaiting_funding",
    txids: [],
    receivedSats: null,
    custodial: true,
    trackingId: shift.shiftId,
    funding: {
      kind: "external-deposit-address",
      address: shift.depositAddress,
      network: leg.fromNetwork,
      min: shift.min,
      max: shift.max,
      expiresAt: shift.expiresAt
    },
    nextStep:
      `send USDT on ${leg.fromNetwork} to the deposit address (CUSTODIAL mid-flight — SideShift settles ` +
      `USDt to this wallet). Poll wallet.convert.sideshift.getStatus('${shift.shiftId}') for progress.`
  };
}

/**
 * Execute ONE route leg via its provider method. `params.amount` is the leg's
 * INPUT amount (for a multi-hop continuation leg: the REAL settled output of
 * the previous leg, never an estimate). Shared by the single-hop path and the
 * multi-hop executor/recovery (multihop.ts).
 */
export async function executeLeg(
  leg: RouteLeg,
  params: ConvertParams,
  deps: IntentDeps,
  ctx: ExecuteContext
): Promise<ConvertResult> {
  switch (leg.method) {
    case "swap":
      return executeMarketSwap(leg, params, deps, ctx);
    case "pegIn":
      return executePegIn(deps, ctx);
    case "pegOut":
      return executePegOut(leg, params, deps, ctx);
    case "payLightningInvoice":
      return executePayLightning(params, deps, ctx);
    case "receiveLightning":
      return executeReceiveLightning(params, deps, ctx);
    case "toStablecoin":
      return executeToStablecoin(leg, params, deps, ctx);
    case "send":
      return executeSideshiftSend(leg, params, deps, ctx);
    case "receive":
      return executeSideshiftReceive(leg, params, deps, ctx);
  }
}

/**
 * Execute ONE conversion intent. Resolves the route from the trio (refusing to
 * choose among multiple candidates — MULTIPLE_ROUTES_AVAILABLE) and executes
 * it: single-hop directly, multi-hop end to end behind a persisted plan with
 * crash recovery (PR-C, multihop.ts). Waits for settlement by default; every
 * non-terminal result carries a nextStep.
 */
export async function convertIntent(params: ConvertParams, deps: IntentDeps): Promise<ConvertResult> {
  validateIntent(params);
  const route = resolveSingleRoute(params);
  const ctx: ExecuteContext = {
    route,
    wait: params.wait ?? true,
    timeoutMs: params.timeoutMs ?? deps.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
    intervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  };
  if (route.hops > 1) {
    return executeMultiHopRoute(route, params, deps, ctx);
  }
  return executeLeg(route.legs[0]!, params, deps, ctx);
}

// ─── wallet facade: callable convert() carrying the advanced namespaces ───────

/**
 * `wallet.convert` — callable ({intent} → result) AND, for backward
 * compatibility, still carrying the provider namespaces (`.sideswap`, `.boltz`,
 * `.sideshift`). The namespaces' canonical home is now `wallet.advanced.*`
 * (PR-D); these getters alias the SAME instances and stay supported in 1.x.
 */
export interface ConvertFacade {
  (params: ConvertParams): Promise<ConvertResult>;
  /** @deprecated Use `wallet.advanced.sideswap` — the same instance. */
  readonly sideswap: SideSwapNamespace;
  /** @deprecated Use `wallet.advanced.sideshift` — the same instance. */
  readonly sideshift: SideShiftNamespace;
  /**
   * Throws WALLET_NOT_FOUND on a view-only/wiped wallet (no seed to sign).
   * @deprecated Use `wallet.advanced.boltz` — the same instance, same gate.
   */
  readonly boltz: BoltzConvert;
}

// ─── wallet.advanced low-level primitives (PR-E) ──────────────────────────────
// The types live here (next to WalletAdvanced) so the namespace module is
// self-contained; the implementations are private DepixWallet methods injected
// via makeAdvancedNamespace — the namespace itself holds NO wallet machinery.

/** One UTXO of the wallet — the read-only view of advanced.listUtxos(). */
export interface WalletUtxo {
  /** AssetKey for the three known mainnet assets; the raw hex asset id otherwise. */
  asset: AssetKey | string;
  /** Unblinded amount in base units (8 decimals on Liquid). */
  amountSats: bigint;
  outpoint: { txid: string; vout: number };
  /** The confidential receive address this output pays. */
  address: string;
  /** Block height when confirmed; null while in the mempool. */
  height: number | null;
  /** tip − height + 1 when confirmed and the tip is known; 0 otherwise. */
  confirmations: number;
}

export interface SelectCoinsParams {
  asset: AssetKey;
  /** Target amount to cover, in base units. */
  targetSats: bigint;
}

/**
 * advanced.selectCoins() result — INFORMATIONAL ONLY. LWK's TxBuilder performs
 * its own coin selection at build time; this mirrors it (confirmed-first,
 * largest-first greedy) so an agent can reason about which coins WOULD fund a
 * target, but nothing here reserves or spends anything.
 */
export interface CoinSelection {
  /** The UTXOs that would cover the target (greedy, confirmed-first, largest-first). */
  utxos: WalletUtxo[];
  totalSats: bigint;
  targetSats: bigint;
  /** totalSats − targetSats. The network fee is NOT modeled here. */
  changeSats: bigint;
}

export interface SendManyRecipient {
  asset: AssetKey;
  amountSats: bigint;
  address: string;
}

export interface SendManyParams {
  recipients: readonly SendManyRecipient[];
}

export interface SendManyResult {
  txid: string;
}

/**
 * The low-level wallet primitives carried by `wallet.advanced` (PR-E).
 *
 * listUtxos/selectCoins are READ-ONLY — they move nothing and sign nothing.
 * sendMany MOVES FUNDS and therefore crosses the §4.3 guardrail choke point
 * EXACTLY like wallet.send(): the TOTAL BRL value of all outputs (summed per
 * asset, valued via §4.4) is enforced against the per-tx and rolling-24h
 * ceilings, EVERY destination address is checked against the allowlist, and
 * the spend is recorded at signing time — all under the wallet op mutex.
 * There is deliberately NO buildPset/signPset/broadcastPset here: a signed
 * PSET is broadcastable by any code path, so signing outside the choke point
 * would be a guardrail bypass (footgun documented in the PR-E decision).
 */
export interface WalletAdvancedPrimitives {
  listUtxos(): Promise<WalletUtxo[]>;
  selectCoins(params: SelectCoinsParams): Promise<CoinSelection>;
  sendMany(params: SendManyParams): Promise<SendManyResult>;
}

/**
 * `wallet.advanced` (PR-D) — the power-user surface: the SAME provider
 * namespace instances that back wallet.convert()/wallet.quote(), exposed for
 * fine-grained control (SideSwap quote streams and pegStatus, Boltz manual
 * resume/refund watches, SideShift shift log and refund addresses…). Every
 * money-moving method still crosses the §4.3 guardrail choke point inside the
 * provider — this namespace adds NO signing path and NO bypass. PR-E adds the
 * low-level wallet primitives (listUtxos/selectCoins/sendMany) under the same
 * invariant.
 */
export interface WalletAdvanced extends WalletAdvancedPrimitives {
  /** SideSwap market swaps + BTC↔L-BTC peg (§5.1/§5.2 — non-custodial). */
  readonly sideswap: SideSwapNamespace;
  /** SideShift USDt cross-network (§5.4 — CUSTODIAL, signalled). */
  readonly sideshift: SideShiftNamespace;
  /**
   * Boltz Lightning/stablecoin swaps (§5.3 — non-custodial). Throws
   * WALLET_NOT_FOUND on a view-only/wiped wallet (no seed to sign).
   */
  readonly boltz: BoltzConvert;
}

/** Build the intent deps from the real ConvertNamespace (+ test overrides). */
export function intentDepsFromNamespace(ns: ConvertNamespace, options: ConvertIntentOptions = {}): IntentDeps {
  return {
    sideswap: ns.sideswap,
    sideshift: ns.sideshift,
    getBoltz: () => ns.boltz,
    ...(options.estimateStablecoin ? { estimateStablecoin: options.estimateStablecoin } : {}),
    ...(options.reverseLimits ? { reverseLimits: options.reverseLimits } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    ...(options.settleTimeoutMs !== undefined ? { settleTimeoutMs: options.settleTimeoutMs } : {})
  };
}

/**
 * Wrap a ConvertNamespace into the callable facade. The sub-namespaces are
 * exposed via getters so `.boltz`'s view-only WALLET_NOT_FOUND gate is
 * preserved verbatim.
 */
export function makeConvertFacade(
  ns: ConvertNamespace,
  deps: IntentDeps,
  assertOpen?: () => void
): ConvertFacade {
  // Parity with wallet.quote(): assert the wallet is open at the facade boundary so
  // a closed/view-only wallet fails fast with a clear WALLET_NOT_FOUND instead of
  // only tripping deep inside an outbound provider leg (inflow legs that just mint a
  // funding address may not assert at all). `async` so a thrown assertOpen surfaces
  // as a rejected promise — matching how quote() behaves.
  const facade = (async (params: ConvertParams): Promise<ConvertResult> => {
    assertOpen?.();
    return convertIntent(params, deps);
  }) as ConvertFacade;
  // Non-enumerable getters: `.boltz` throws WALLET_NOT_FOUND on a view-only/wiped
  // wallet (gate preserved by design). Keeping them non-enumerable means incidental
  // enumeration — object spread `{ ...wallet.convert }`, structuredClone, a logger or
  // serializer walking own enumerable keys — does NOT invoke the throwing getter.
  // Direct property access (wallet.convert.boltz) still works and still gates.
  Object.defineProperty(facade, "sideswap", { get: () => ns.sideswap, enumerable: false });
  Object.defineProperty(facade, "sideshift", { get: () => ns.sideshift, enumerable: false });
  Object.defineProperty(facade, "boltz", { get: () => ns.boltz, enumerable: false });
  return facade;
}

/**
 * Build `wallet.advanced` over the SAME ConvertNamespace the facade wraps —
 * reference-identical instances, so state (shift logs, peg tracking, Boltz
 * watches) is shared, never duplicated. Same getter discipline as the facade:
 * non-enumerable, so spreading/serializing `wallet.advanced` never trips the
 * `.boltz` view-only WALLET_NOT_FOUND gate; direct access still gates.
 *
 * `primitives` (PR-E) are closures bound to the OWNING DepixWallet instance:
 * the namespace never holds keys, guardrails or a signer of its own — sendMany
 * delegates into the wallet, where the §4.3 choke point is structurally
 * unavoidable (enforce→sign→record under the op mutex). Also non-enumerable,
 * for the same spread/serialize hygiene.
 */
export function makeAdvancedNamespace(
  ns: ConvertNamespace,
  primitives: WalletAdvancedPrimitives
): WalletAdvanced {
  const advanced = {} as WalletAdvanced;
  Object.defineProperty(advanced, "sideswap", { get: () => ns.sideswap, enumerable: false });
  Object.defineProperty(advanced, "sideshift", { get: () => ns.sideshift, enumerable: false });
  Object.defineProperty(advanced, "boltz", { get: () => ns.boltz, enumerable: false });
  Object.defineProperty(advanced, "listUtxos", { value: primitives.listUtxos, enumerable: false });
  Object.defineProperty(advanced, "selectCoins", { value: primitives.selectCoins, enumerable: false });
  Object.defineProperty(advanced, "sendMany", { value: primitives.sendMany, enumerable: false });
  return advanced;
}
