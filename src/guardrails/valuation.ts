// BRL valuation of an asset amount (spec §4.4, parity with the frontend's
// asset-registry.js convertSatsToBrl at lines 159-227).
//
//   DePix : 1:1 BRL peg — integer, ceil(sats / 10^6) cents (rounding UP so
//           fractional cents can never shave a ceiling).
//   USDt  : amount × usdBrl
//   L-BTC : amount × btcUsd × usdBrl
//
// Fail-closed (G6): when the quote needed for a non-DePix asset is not
// available (not even stale), signing is BLOCKED with QUOTES_UNAVAILABLE.
// Failing OPEN would make the ceiling bypassable by taking down a public
// endpoint. Non-DePix results are ceil'd to integer cents for the same
// no-shaving reason; the choke point then re-checks integer-finite-positive
// (§4.4 arithmetic fail-closed) so an overflow can never slip through.

import { ASSETS, DEPIX_SATS_PER_BRL_CENT, type AssetKey } from "../assets.js";
import { GuardrailError } from "../errors.js";
import type { QuotesSource } from "./quotes.js";

/** BigInt-safe sats → decimal string (port of asset-registry.js satsToAmount). */
function satsToAmount(sats: bigint, decimals: number): string {
  if (sats < 0n) return `-${satsToAmount(-sats, decimals)}`;
  if (decimals === 0) return sats.toString();
  const base = 10n ** BigInt(decimals);
  const whole = sats / base;
  const rem = (sats % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return rem.length === 0 ? whole.toString() : `${whole}.${rem}`;
}

/** DePix peg (§4.4): exact integer ceil(sats / 10^6) — no quote needed. */
export function depixSatsToBrlCents(amountSats: bigint): number {
  const cents = (amountSats + DEPIX_SATS_PER_BRL_CENT - 1n) / DEPIX_SATS_PER_BRL_CENT;
  return Number(cents);
}

export class BrlValuator {
  constructor(private readonly quotes: QuotesSource) {}

  /**
   * Value `amountSats` of `asset` in integer BRL cents (ceil). DePix is exact;
   * L-BTC/USDt need /api/quotes and fail CLOSED with QUOTES_UNAVAILABLE when no
   * fresh-or-stale quote is available (§4.4/G6).
   */
  async valuate(asset: AssetKey, amountSats: bigint): Promise<number> {
    if (asset === "DEPIX") return depixSatsToBrlCents(amountSats);

    const quotes = await this.quotes.get();
    if (!quotes) {
      throw new GuardrailError(
        "QUOTES_UNAVAILABLE",
        `BRL valuation for ${asset} needs a quote from GET /api/quotes, which is unavailable ` +
          "(no fresh or stale value) — signing is blocked for non-DePix assets (fail-closed, spec §4.4).",
        {
          details: {
            nextStep:
              "retry in a few seconds — the quote endpoint is usually back quickly. If it persists, check " +
              "connectivity to the DePix API. DePix-denominated operations still work (the 1:1 BRL peg needs no quote)."
          }
        }
      );
    }

    const info = ASSETS[asset];
    const amount = Number(satsToAmount(amountSats, info.decimals));
    let brl: number;
    if (info.brlFormula === "usd") {
      brl = amount * quotes.usdBrl;
    } else if (info.brlFormula === "btc") {
      brl = amount * quotes.btcUsd * quotes.usdBrl;
    } else {
      // Only "peg" remains, and DePix was handled above — defensive.
      throw new GuardrailError(
        "QUOTES_UNAVAILABLE",
        `No BRL formula for ${asset} — signing blocked (fail-closed).`
      );
    }
    if (!Number.isFinite(brl) || brl <= 0) {
      throw new GuardrailError(
        "QUOTES_UNAVAILABLE",
        `BRL valuation for ${asset} produced a non-finite/zero value — signing blocked (fail-closed).`
      );
    }
    // Ceil to integer cents (no shaving). The choke point re-validates that the
    // result is a positive safe integer (§4.4) and fails closed otherwise.
    return Math.ceil(brl * 100);
  }

  /**
   * Best-effort BRL estimate for read surfaces (getBalances brlEstimate, §2.3):
   * returns null instead of throwing when quotes are unavailable — a display
   * read must not fail closed the way a signing gate does.
   */
  async estimateBrlCents(asset: AssetKey, amountSats: bigint): Promise<number | null> {
    if (amountSats <= 0n) return 0;
    try {
      return await this.valuate(asset, amountSats);
    } catch {
      return null;
    }
  }
}
