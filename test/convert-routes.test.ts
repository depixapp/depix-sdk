// Intent routing table (PR-B): the trio (from-asset, to-asset, to-network)
// deterministically enumerates EVERY candidate route — single-hop AND
// multi-hop — with the right provider per leg and the custodial flag right.
// No policy: the SDK never picks among candidates; the agent does.
import { describe, expect, it } from "vitest";
import { enumerateRoutes, type Route } from "../src/convert/routes.js";

function ids(routes: readonly Route[]): string[] {
  return routes.map((r) => r.id);
}

describe("routing table — single-hop rows map to the right provider", () => {
  it.each([
    ["DEPIX", "LBTC", "sideswap.swap:DEPIX@liquid>LBTC@liquid"],
    ["DEPIX", "USDT", "sideswap.swap:DEPIX@liquid>USDT@liquid"],
    ["USDT", "LBTC", "sideswap.swap:USDT@liquid>LBTC@liquid"],
    ["LBTC", "DEPIX", "sideswap.swap:LBTC@liquid>DEPIX@liquid"]
  ] as const)("%s → %s @liquid = sideswap market swap", (from, to, id) => {
    const routes = enumerateRoutes({ from, to, network: "liquid" });
    expect(ids(routes)).toEqual([id]);
    expect(routes[0]).toMatchObject({ hops: 1, custodial: false });
    expect(routes[0]!.legs[0]).toMatchObject({ provider: "sideswap", method: "swap" });
  });

  it("network defaults to liquid", () => {
    expect(ids(enumerateRoutes({ from: "DEPIX", to: "LBTC" }))).toEqual([
      "sideswap.swap:DEPIX@liquid>LBTC@liquid"
    ]);
  });

  it("BTC on-chain → LBTC = sideswap peg-in (fromNetwork bitcoin)", () => {
    const routes = enumerateRoutes({ from: "BTC", to: "LBTC", network: "liquid", fromNetwork: "bitcoin" });
    expect(ids(routes)).toEqual(["sideswap.pegIn:BTC@bitcoin>LBTC@liquid"]);
    expect(routes[0]!.custodial).toBe(false);
  });

  it("BTC lightning → LBTC = boltz receiveLightning (fromNetwork lightning)", () => {
    const routes = enumerateRoutes({ from: "BTC", to: "LBTC", network: "liquid", fromNetwork: "lightning" });
    expect(ids(routes)).toEqual(["boltz.receiveLightning:BTC@lightning>LBTC@liquid"]);
  });

  it("BTC → LBTC without fromNetwork enumerates BOTH entry rails (agent chooses)", () => {
    const routes = enumerateRoutes({ from: "BTC", to: "LBTC", network: "liquid" });
    expect(ids(routes).sort()).toEqual([
      "boltz.receiveLightning:BTC@lightning>LBTC@liquid",
      "sideswap.pegIn:BTC@bitcoin>LBTC@liquid"
    ]);
  });

  it("LBTC → BTC @bitcoin = sideswap peg-out", () => {
    const routes = enumerateRoutes({ from: "LBTC", to: "BTC", network: "bitcoin" });
    expect(ids(routes)).toEqual(["sideswap.pegOut:LBTC@liquid>BTC@bitcoin"]);
    expect(routes[0]!.custodial).toBe(false);
  });

  it("LBTC → BTC @lightning = boltz payLightningInvoice", () => {
    const routes = enumerateRoutes({ from: "LBTC", to: "BTC", network: "lightning" });
    expect(ids(routes)).toEqual(["boltz.payLightningInvoice:LBTC@liquid>BTC@lightning"]);
  });

  it.each(["polygon", "ethereum", "arbitrum", "optimism", "base"] as const)(
    "LBTC → USDC @%s = boltz toStablecoin (NON-custodial)",
    (network) => {
      const routes = enumerateRoutes({ from: "LBTC", to: "USDC", network });
      expect(ids(routes)).toEqual([`boltz.toStablecoin:LBTC@liquid>USDC@${network}`]);
      expect(routes[0]!.custodial).toBe(false);
    }
  );

  it("LBTC → USDT @arbitrum/@optimism = boltz only (SideShift has no such network)", () => {
    for (const network of ["arbitrum", "optimism"] as const) {
      expect(ids(enumerateRoutes({ from: "LBTC", to: "USDT", network }))).toEqual([
        `boltz.toStablecoin:LBTC@liquid>USDT@${network}`
      ]);
    }
  });

  it.each(["ethereum", "tron", "bsc", "polygon", "solana"] as const)(
    "USDT-liquid → USDT @%s includes the sideshift.send single-hop (CUSTODIAL)",
    (network) => {
      const routes = enumerateRoutes({ from: "USDT", to: "USDT", network });
      const direct = routes.find((r) => r.hops === 1);
      expect(direct?.id).toBe(`sideshift.send:USDT@liquid>USDT@${network}`);
      expect(direct?.custodial).toBe(true);
    }
  );

  it("USDT @bsc/@solana has NO boltz alternative (sideshift only)", () => {
    for (const network of ["bsc", "solana"] as const) {
      const routes = enumerateRoutes({ from: "USDT", to: "USDT", network });
      expect(ids(routes)).toEqual([`sideshift.send:USDT@liquid>USDT@${network}`]);
    }
  });

  it("USDT external → USDT-liquid = sideshift.receive (fromNetwork chosen)", () => {
    const routes = enumerateRoutes({ from: "USDT", to: "USDT", network: "liquid", fromNetwork: "ethereum" });
    expect(ids(routes)).toEqual(["sideshift.receive:USDT@ethereum>USDT@liquid"]);
    expect(routes[0]!.custodial).toBe(true);
  });

  it("USDT → USDT @liquid without fromNetwork enumerates every inbound source network", () => {
    const routes = enumerateRoutes({ from: "USDT", to: "USDT", network: "liquid" });
    expect(ids(routes).sort()).toEqual(
      ["ethereum", "tron", "bsc", "polygon", "solana"]
        .map((n) => `sideshift.receive:USDT@${n}>USDT@liquid`)
        .sort()
    );
  });
});

describe("routing table — multi-hop enumeration (the agent chooses; PR-C automates)", () => {
  it("DEPIX → USDT @ethereum enumerates BOTH 2-hop routes with the right custodial flags", () => {
    const routes = enumerateRoutes({ from: "DEPIX", to: "USDT", network: "ethereum" });
    expect(ids(routes)).toEqual([
      "sideswap.swap:DEPIX@liquid>LBTC@liquid+boltz.toStablecoin:LBTC@liquid>USDT@ethereum",
      "sideswap.swap:DEPIX@liquid>USDT@liquid+sideshift.send:USDT@liquid>USDT@ethereum"
    ]);
    expect(routes[0]).toMatchObject({ hops: 2, custodial: false });
    expect(routes[1]).toMatchObject({ hops: 2, custodial: true });
    // Route custodiality is the OR of its legs.
    expect(routes[1]!.legs.map((l) => l.custodial)).toEqual([false, true]);
  });

  it("LBTC → USDT @ethereum: boltz single-hop first, sideshift 2-hop second", () => {
    const routes = enumerateRoutes({ from: "LBTC", to: "USDT", network: "ethereum" });
    expect(ids(routes)).toEqual([
      "boltz.toStablecoin:LBTC@liquid>USDT@ethereum",
      "sideswap.swap:LBTC@liquid>USDT@liquid+sideshift.send:USDT@liquid>USDT@ethereum"
    ]);
  });

  it("DEPIX → BTC @lightning = swap + payLightningInvoice (2 hops)", () => {
    const routes = enumerateRoutes({ from: "DEPIX", to: "BTC", network: "lightning" });
    expect(ids(routes)).toEqual([
      "sideswap.swap:DEPIX@liquid>LBTC@liquid+boltz.payLightningInvoice:LBTC@liquid>BTC@lightning"
    ]);
  });

  it("BTC → DEPIX: entry rail + market swap (2 hops each)", () => {
    const routes = enumerateRoutes({ from: "BTC", to: "DEPIX", network: "liquid" });
    expect(ids(routes).sort()).toEqual([
      "boltz.receiveLightning:BTC@lightning>LBTC@liquid+sideswap.swap:LBTC@liquid>DEPIX@liquid",
      "sideswap.pegIn:BTC@bitcoin>LBTC@liquid+sideswap.swap:LBTC@liquid>DEPIX@liquid"
    ]);
  });

  it("BTC → USDT @ethereum: full composition (2× 2-hop via boltz, 2× 3-hop via sideshift)", () => {
    const routes = enumerateRoutes({ from: "BTC", to: "USDT", network: "ethereum" });
    expect(routes).toHaveLength(4);
    expect(routes.filter((r) => r.hops === 2)).toHaveLength(2);
    expect(routes.filter((r) => r.hops === 3)).toHaveLength(2);
    // 2-hop (fewer hops) come first; sideshift legs mark the route custodial.
    expect(routes[0]!.hops).toBe(2);
    expect(routes.filter((r) => r.custodial)).toHaveLength(2);
  });

  it("BTC lightning → BTC on-chain composes through L-BTC; the same-rail roundtrip is dropped", () => {
    const routes = enumerateRoutes({ from: "BTC", to: "BTC", network: "bitcoin" });
    expect(ids(routes)).toEqual([
      "boltz.receiveLightning:BTC@lightning>LBTC@liquid+sideswap.pegOut:LBTC@liquid>BTC@bitcoin"
    ]);
    // Explicit on-chain origin to an on-chain destination = a pure roundtrip → none.
    expect(enumerateRoutes({ from: "BTC", to: "BTC", network: "bitcoin", fromNetwork: "bitcoin" })).toEqual([]);
  });
});

describe("routing table — no route", () => {
  it.each([
    ["USDC", "DEPIX", "liquid"], // no inbound USDC rail
    ["LBTC", "LBTC", "liquid"], // same asset, same network — a no-op
    ["LBTC", "BTC", "liquid"], // BTC does not live on liquid
    ["DEPIX", "USDC", "liquid"], // no liquid USDC
    ["DEPIX", "DEPIX", "ethereum"] // DEPIX exists only on liquid
  ] as const)("%s → %s @%s yields no routes", (from, to, network) => {
    expect(enumerateRoutes({ from, to, network })).toEqual([]);
  });

  it("unknown asset / network strings yield no routes (validated upstream)", () => {
    expect(enumerateRoutes({ from: "DOGE" as never, to: "LBTC", network: "liquid" })).toEqual([]);
    expect(enumerateRoutes({ from: "DEPIX", to: "USDT", network: "mars" as never })).toEqual([]);
  });
});
