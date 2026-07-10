// SideSwap PSET validation (spec §5.1) — the load-bearing security core, pure
// and deterministic. Covers the PRIMARY hard check (PSET must pay OUR receive
// address) and the SECONDARY check that DIVERGES from the frontend by failing
// CLOSED (G3): a null / missing-asset inspection or a >1% divergence ABORTS with
// SWAP_VALIDATION_FAILED and nothing is signed. Also the peg-out recipient pin.
import { describe, expect, it } from "vitest";
import { ASSETS } from "../src/assets.js";
import { Pset, buildWollet, descriptorFromMnemonic } from "../src/engine/lwk.js";
import {
  assertSwapPsetPaysAndBalances,
  inspectSwapPset,
  type SwapPsetInspection
} from "../src/convert/sideswap.js";
import { assertPegOutRecipient, type PegOutRecipient } from "../src/convert/sideswap-peg.js";
import { isDepixSdkError } from "../src/errors.js";

const SCRIPT = "0014abcdef0011223344556677889900aabbccddeeff"; // our receive scriptPubkey hex
const OTHER_SCRIPT = "0014ffffffffffffffffffffffffffffffffffffffff";
const LBTC = ASSETS.LBTC.id;
const RECV = 1000n;

function inspection(over: Partial<SwapPsetInspection> = {}): SwapPsetInspection {
  return {
    outputScriptsHex: [SCRIPT],
    netBalances: new Map([[LBTC, RECV]]),
    ...over
  };
}
const expectValid = { expectedScriptHex: SCRIPT, recvAssetId: LBTC, recvAmountSats: RECV };
const isSwapFail = (e: unknown): boolean => isDepixSdkError(e, "SWAP_VALIDATION_FAILED");

describe("assertSwapPsetPaysAndBalances — PRIMARY hard check (§5.1)", () => {
  it("passes when an output pays our script and the net is within ±1%", () => {
    expect(() => assertSwapPsetPaysAndBalances(inspection(), expectValid)).not.toThrow();
    // Exactly on the ±1% bounds (tolerance = 10 for 1000) is accepted.
    expect(() =>
      assertSwapPsetPaysAndBalances(inspection({ netBalances: new Map([[LBTC, 1010n]]) }), expectValid)
    ).not.toThrow();
    expect(() =>
      assertSwapPsetPaysAndBalances(inspection({ netBalances: new Map([[LBTC, 990n]]) }), expectValid)
    ).not.toThrow();
  });

  it("aborts when NO output pays our receive address (fund-diversion guard)", () => {
    expect(() =>
      assertSwapPsetPaysAndBalances(inspection({ outputScriptsHex: [OTHER_SCRIPT] }), expectValid)
    ).toThrow();
    try {
      assertSwapPsetPaysAndBalances(inspection({ outputScriptsHex: [OTHER_SCRIPT] }), expectValid);
    } catch (e) {
      expect(isSwapFail(e)).toBe(true);
    }
  });
});

describe("assertSwapPsetPaysAndBalances — SECONDARY check is FAIL-CLOSED (G3, §5.1)", () => {
  it("FAIL-CLOSED: a null inspection (LWK read failed) aborts — never treated as passed", () => {
    // Primary passes (script present), but net-balance inspection is null.
    // Frontend proceeds here (fail-open); the SDK aborts (G3).
    expect(() => assertSwapPsetPaysAndBalances(inspection({ netBalances: null }), expectValid)).toThrow();
    try {
      assertSwapPsetPaysAndBalances(inspection({ netBalances: null }), expectValid);
    } catch (e) {
      expect(isSwapFail(e)).toBe(true);
    }
  });

  it("FAIL-CLOSED: recv asset absent from the net balances aborts", () => {
    const other = ASSETS.USDT.id;
    expect(() =>
      assertSwapPsetPaysAndBalances(inspection({ netBalances: new Map([[other, RECV]]) }), expectValid)
    ).toThrow();
  });

  it("aborts when the net diverges > 1% above or below the quote", () => {
    expect(() =>
      assertSwapPsetPaysAndBalances(inspection({ netBalances: new Map([[LBTC, 1011n]]) }), expectValid)
    ).toThrow();
    expect(() =>
      assertSwapPsetPaysAndBalances(inspection({ netBalances: new Map([[LBTC, 989n]]) }), expectValid)
    ).toThrow();
  });

  it("aborts when the net for the recv asset is non-positive", () => {
    expect(() =>
      assertSwapPsetPaysAndBalances(inspection({ netBalances: new Map([[LBTC, 0n]]) }), expectValid)
    ).toThrow();
  });

  it("tolerates asset-id hex case differences (frontend parity)", () => {
    const upper = new Map([[LBTC.toUpperCase(), RECV]]);
    expect(() => assertSwapPsetPaysAndBalances(inspection({ netBalances: upper }), expectValid)).not.toThrow();
  });

  it("rejects a non-positive quoted recv amount", () => {
    expect(() =>
      assertSwapPsetPaysAndBalances(inspection(), { ...expectValid, recvAmountSats: 0n })
    ).toThrow();
  });
});

describe("inspectSwapPset — offline lwk adapter smoke", () => {
  it("returns a Map (not null) and an output-scripts array for a real empty PSET", () => {
    const wollet = buildWollet(
      descriptorFromMnemonic(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
      )
    );
    const pset = new Pset("cHNldP8BAgQCAAAAAQQBAAEFAQABBgEDAfsEAgAAAAA=");
    const result = inspectSwapPset(pset as never, wollet as never);
    // The critical parsing property: entries() (a JS Map in lwk 0.18) is read
    // into a Map — NOT left null, which would fail-close every legit swap.
    expect(result.netBalances).toBeInstanceOf(Map);
    expect(Array.isArray(result.outputScriptsHex)).toBe(true);
    wollet.free();
  });
});

describe("assertPegOutRecipient — peg-out output pin (§5.2)", () => {
  const PEG_SCRIPT = "0014aaaa00112233445566778899aabbccddeeff0011";
  const good: PegOutRecipient[] = [{ asset: LBTC, value: 5000n, scriptHex: PEG_SCRIPT }];
  const expectPeg = { lbtcId: LBTC, authorizedSats: 5000n, expectedScriptHex: PEG_SCRIPT };

  it("passes for exactly one L-BTC recipient at the peg script, within the authorized amount", () => {
    expect(() => assertPegOutRecipient(good, expectPeg)).not.toThrow();
    // ≤ authorized is fine (network fee shaving would only reduce it).
    expect(() =>
      assertPegOutRecipient([{ asset: LBTC, value: 4900n, scriptHex: PEG_SCRIPT }], expectPeg)
    ).not.toThrow();
  });

  it("aborts on ≠1 external recipients", () => {
    expect(() => assertPegOutRecipient([], expectPeg)).toThrow();
    expect(() => assertPegOutRecipient([...good, ...good], expectPeg)).toThrow();
  });

  it("aborts on a non-L-BTC asset", () => {
    expect(() =>
      assertPegOutRecipient([{ asset: ASSETS.DEPIX.id, value: 5000n, scriptHex: PEG_SCRIPT }], expectPeg)
    ).toThrow();
  });

  it("aborts when the recipient exceeds the authorized amount", () => {
    expect(() =>
      assertPegOutRecipient([{ asset: LBTC, value: 5001n, scriptHex: PEG_SCRIPT }], expectPeg)
    ).toThrow();
  });

  it("aborts when the recipient does not pay the peg script", () => {
    expect(() =>
      assertPegOutRecipient([{ asset: LBTC, value: 5000n, scriptHex: OTHER_SCRIPT }], expectPeg)
    ).toThrow();
  });

  it("aborts on an unreadable / non-positive recipient value", () => {
    expect(() =>
      assertPegOutRecipient([{ asset: LBTC, value: null, scriptHex: PEG_SCRIPT }], expectPeg)
    ).toThrow();
    expect(() =>
      assertPegOutRecipient([{ asset: LBTC, value: 0n, scriptHex: PEG_SCRIPT }], expectPeg)
    ).toThrow();
  });
});
