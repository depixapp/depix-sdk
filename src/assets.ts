// Liquid mainnet asset registry — mirror of the frontend's asset-registry.js
// (GT §1.5). All three assets use 8 decimals on Liquid.

export type AssetKey = "DEPIX" | "USDT" | "LBTC";

export interface AssetInfo {
  readonly key: AssetKey;
  readonly id: string; // Liquid asset id (hex, mainnet)
  readonly symbol: string;
  readonly decimals: number;
  /** BRL valuation formula: peg = 1:1 BRL; usd/btc need /api/quotes (PR3). */
  readonly brlFormula: "peg" | "usd" | "btc";
}

export const ASSETS: Readonly<Record<AssetKey, AssetInfo>> = Object.freeze({
  DEPIX: Object.freeze({
    key: "DEPIX" as const,
    id: "02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189",
    symbol: "DePix",
    decimals: 8,
    brlFormula: "peg" as const
  }),
  USDT: Object.freeze({
    key: "USDT" as const,
    id: "ce091c998b83c78bb71a632313ba3760f1763d9cfcffae02258ffa9865a37bd2",
    symbol: "USDt",
    decimals: 8,
    brlFormula: "usd" as const
  }),
  LBTC: Object.freeze({
    key: "LBTC" as const,
    id: "6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d",
    symbol: "L-BTC",
    decimals: 8,
    brlFormula: "btc" as const
  })
});

/** Reverse map: mainnet asset id (hex) → asset key. */
export const MAINNET_ASSET_ID_TO_KEY: Readonly<Record<string, AssetKey>> = Object.freeze(
  Object.fromEntries(
    (Object.values(ASSETS) as AssetInfo[]).map((asset) => [asset.id, asset.key])
  ) as Record<string, AssetKey>
);

/**
 * DePix is pegged 1:1 to BRL and has 8 decimals, so 1 BRL cent corresponds to
 * 10^(8-2) = 1_000_000 base units ("sats") — spec §3.2.5.
 */
export const DEPIX_SATS_PER_BRL_CENT = 10n ** BigInt(ASSETS.DEPIX.decimals - 2);
