// Intent routing table (PR-B) — PURE route enumeration, no I/O, no policy.
//
// The trio (from-asset, to-asset, to-network) deterministically enumerates
// EVERY candidate route, single-hop and multi-hop alike. The SDK never picks
// among candidates: quote() surfaces them all with estimates and the AGENT
// chooses (design locked in PR-B; PR-C automates multi-hop execution with a
// plan + recovery — until then convert() only executes single-hop routes).
//
// A route is a chain of up to three legs over the wallet's home network
// (Liquid):
//   entry  — bring an external asset ONTO Liquid
//              BTC on-chain   → L-BTC   (sideswap.pegIn)
//              BTC lightning  → L-BTC   (boltz.receiveLightning)
//              USDT external  → USDT    (sideshift.receive, CUSTODIAL)
//   market — swap between the Liquid assets {DEPIX, USDT, L-BTC}
//              (sideswap.swap — the §5.1 market)
//   exit   — leave Liquid to an external asset/network
//              L-BTC → BTC on-chain     (sideswap.pegOut)
//              L-BTC → BTC lightning    (boltz.payLightningInvoice)
//              L-BTC → USDC/USDT EVM/Tron (boltz.toStablecoin, NON-custodial)
//              USDT  → USDT ext. networks (sideshift.send, CUSTODIAL)
//
// Custodiality is per-leg (only SideShift legs are custodial) and a route is
// custodial iff ANY leg is — signalled, never gated (G4).

import type { AssetKey } from "../assets.js";
import { boltzVariantKey } from "./boltz/stablecoin.js";
import { USDT_NETWORKS } from "./sideshift.js";

/** Assets the intent layer routes between. The Liquid trio plus BTC and USDC. */
export type IntentAsset = AssetKey | "BTC" | "USDC";

/** Networks an intent can source from / deliver to. */
export type IntentNetwork =
  | "liquid"
  | "bitcoin"
  | "lightning"
  | "ethereum"
  | "polygon"
  | "arbitrum"
  | "optimism"
  | "base"
  | "tron"
  | "bsc"
  | "solana";

export type RouteProvider = "sideswap" | "boltz" | "sideshift";

/** Provider method a leg executes — mirrors the advanced `wallet.convert.*` names. */
export type RouteMethod =
  | "swap"
  | "pegIn"
  | "pegOut"
  | "payLightningInvoice"
  | "receiveLightning"
  | "toStablecoin"
  | "send"
  | "receive";

export interface RouteLeg {
  provider: RouteProvider;
  method: RouteMethod;
  from: IntentAsset;
  fromNetwork: IntentNetwork;
  to: IntentAsset;
  network: IntentNetwork;
  /** true only for SideShift legs — funds transit the provider's custody (G4). */
  custodial: boolean;
}

export interface Route {
  /** Stable id — pass it back to convert({ route }) to execute this candidate. */
  id: string;
  legs: readonly RouteLeg[];
  hops: number;
  /** true iff ANY leg is custodial (signalled, never gated — G4). */
  custodial: boolean;
}

/** The intent trio (+ optional origin-network narrowing). */
export interface RouteSelector {
  from: IntentAsset;
  to: IntentAsset;
  /** Destination network (default "liquid"). */
  network?: IntentNetwork;
  /**
   * Origin network. Liquid assets default to "liquid" (this wallet's holdings);
   * BTC/inbound-USDT intents leave it unset to enumerate every entry rail, or
   * set it ("bitcoin" | "lightning" | a USDT source network) to narrow.
   */
  fromNetwork?: IntentNetwork;
}

/** A conversion intent: the route selector plus the amount to convert. */
export interface ConvertIntent extends RouteSelector {
  /** Amount of `from`, in its 8-decimal base units (sats) — bigint, like the whole SDK. */
  amount: bigint;
}

const LIQUID_ASSETS: readonly IntentAsset[] = ["DEPIX", "USDT", "LBTC"];

/** SideShift's USDt networks that actually require a shift (liquid excluded). */
const SIDESHIFT_NETWORKS: readonly string[] = USDT_NETWORKS.filter((n) => n.requiresShift).map((n) => n.id);

function isLiquidAsset(asset: IntentAsset): asset is AssetKey {
  return LIQUID_ASSETS.includes(asset);
}

function legIdOf(leg: RouteLeg): string {
  return `${leg.provider}.${leg.method}:${leg.from}@${leg.fromNetwork}>${leg.to}@${leg.network}`;
}

function buildRoute(legs: RouteLeg[]): Route {
  return {
    id: legs.map(legIdOf).join("+"),
    legs,
    hops: legs.length,
    custodial: legs.some((l) => l.custodial)
  };
}

// ─── leg constructors ─────────────────────────────────────────────────────────

function marketLeg(from: AssetKey, to: AssetKey): RouteLeg {
  return { provider: "sideswap", method: "swap", from, fromNetwork: "liquid", to, network: "liquid", custodial: false };
}

function pegInLeg(): RouteLeg {
  return {
    provider: "sideswap",
    method: "pegIn",
    from: "BTC",
    fromNetwork: "bitcoin",
    to: "LBTC",
    network: "liquid",
    custodial: false
  };
}

function receiveLightningLeg(): RouteLeg {
  return {
    provider: "boltz",
    method: "receiveLightning",
    from: "BTC",
    fromNetwork: "lightning",
    to: "LBTC",
    network: "liquid",
    custodial: false
  };
}

function sideshiftReceiveLeg(sourceNetwork: IntentNetwork): RouteLeg {
  return {
    provider: "sideshift",
    method: "receive",
    from: "USDT",
    fromNetwork: sourceNetwork,
    to: "USDT",
    network: "liquid",
    custodial: true
  };
}

function pegOutLeg(): RouteLeg {
  return {
    provider: "sideswap",
    method: "pegOut",
    from: "LBTC",
    fromNetwork: "liquid",
    to: "BTC",
    network: "bitcoin",
    custodial: false
  };
}

function payLightningLeg(): RouteLeg {
  return {
    provider: "boltz",
    method: "payLightningInvoice",
    from: "LBTC",
    fromNetwork: "liquid",
    to: "BTC",
    network: "lightning",
    custodial: false
  };
}

function toStablecoinLeg(to: "USDC" | "USDT", network: IntentNetwork): RouteLeg {
  return {
    provider: "boltz",
    method: "toStablecoin",
    from: "LBTC",
    fromNetwork: "liquid",
    to,
    network,
    custodial: false
  };
}

function sideshiftSendLeg(network: IntentNetwork): RouteLeg {
  return {
    provider: "sideshift",
    method: "send",
    from: "USDT",
    fromNetwork: "liquid",
    to: "USDT",
    network,
    custodial: true
  };
}

// ─── enumeration ──────────────────────────────────────────────────────────────

/** Entry legs bringing `from` (an external asset) onto Liquid, honoring fromNetwork. */
function entryLegs(from: IntentAsset, fromNetwork: IntentNetwork | undefined): RouteLeg[] {
  if (from === "BTC") {
    const legs: RouteLeg[] = [];
    if (fromNetwork === undefined || fromNetwork === "bitcoin") legs.push(pegInLeg());
    if (fromNetwork === undefined || fromNetwork === "lightning") legs.push(receiveLightningLeg());
    return legs;
  }
  if (from === "USDT") {
    if (fromNetwork !== undefined) {
      return SIDESHIFT_NETWORKS.includes(fromNetwork) ? [sideshiftReceiveLeg(fromNetwork)] : [];
    }
    return SIDESHIFT_NETWORKS.map((n) => sideshiftReceiveLeg(n as IntentNetwork));
  }
  return []; // no inbound rail (e.g. USDC)
}

/** Exit legs delivering `to` on an external `network`, keyed by the Liquid pivot they consume. */
function exitLegs(to: IntentAsset, network: IntentNetwork): RouteLeg[] {
  const legs: RouteLeg[] = [];
  if (to === "BTC" && network === "bitcoin") legs.push(pegOutLeg());
  if (to === "BTC" && network === "lightning") legs.push(payLightningLeg());
  if ((to === "USDC" || to === "USDT") && boltzVariantKey(to, network) !== null) {
    legs.push(toStablecoinLeg(to, network));
  }
  if (to === "USDT" && SIDESHIFT_NETWORKS.includes(network)) legs.push(sideshiftSendLeg(network));
  return legs;
}

/** Prefix a leg chain with what it takes to hold `pivot` on Liquid, from `from`. */
function reachPivot(
  from: IntentAsset,
  fromNetwork: IntentNetwork | undefined,
  pivot: AssetKey
): RouteLeg[][] {
  if (isLiquidAsset(from) && (fromNetwork === undefined || fromNetwork === "liquid")) {
    return from === pivot ? [[]] : [[marketLeg(from, pivot)]];
  }
  // External origin: every entry rail, plus a market hop if it lands off-pivot.
  return entryLegs(from, fromNetwork).map((entry) =>
    entry.to === pivot ? [entry] : [entry, marketLeg(entry.to as AssetKey, pivot)]
  );
}

/**
 * Enumerate EVERY candidate route for the intent trio — pure and deterministic.
 * Returns [] when no rail exists (the caller maps that to a typed error).
 * Ordering: fewer hops first, then non-custodial first, then id (stable).
 */
export function enumerateRoutes(selector: RouteSelector): Route[] {
  const { from, fromNetwork } = selector;
  const to = selector.to;
  const network = selector.network ?? "liquid";
  const routes: Route[] = [];

  if (network === "liquid" && isLiquidAsset(to)) {
    if (isLiquidAsset(from) && (fromNetwork === undefined || fromNetwork === "liquid")) {
      if (from !== to) {
        routes.push(buildRoute([marketLeg(from, to)]));
      } else if (from === "USDT" && fromNetwork === undefined) {
        // The one same-asset liquid intent with a rail: inbound external USDT
        // (sideshift.receive). Ambiguous source → one candidate per network.
        for (const entry of entryLegs("USDT", undefined)) routes.push(buildRoute([entry]));
      }
    } else {
      // External origin landing on Liquid.
      for (const entry of entryLegs(from, fromNetwork)) {
        const chain = entry.to === to ? [entry] : [entry, marketLeg(entry.to as AssetKey, to)];
        routes.push(buildRoute(chain));
      }
    }
  } else {
    // External destination: [reach pivot] + exit.
    for (const exit of exitLegs(to, network)) {
      for (const prefix of reachPivot(from, fromNetwork, exit.from as AssetKey)) {
        const legs = [...prefix, exit];
        const first = legs[0]!;
        // Drop pure roundtrips (start == end, e.g. peg-in followed by peg-out).
        if (first.from === exit.to && first.fromNetwork === exit.network) continue;
        routes.push(buildRoute(legs));
      }
    }
  }

  routes.sort((a, b) => {
    if (a.hops !== b.hops) return a.hops - b.hops;
    if (a.custodial !== b.custodial) return a.custodial ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return routes;
}
