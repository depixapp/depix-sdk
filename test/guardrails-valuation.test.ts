// BRL valuation via /api/quotes (spec §4.4, G6 fail-closed) + the QuotesClient
// cache (fresh 30s / stale 5min). Quotes are mocked — no network.
import { describe, expect, it } from "vitest";
import { BrlValuator } from "../src/guardrails/valuation.js";
import { QuotesClient, type Quotes, type QuotesSource } from "../src/guardrails/quotes.js";
import { isDepixSdkError } from "../src/errors.js";

const SATS_PER_DEPIX_CENT = 1_000_000n; // 10^(8-2)
const ONE_UNIT = 100_000_000n; // 1.0 of an 8-decimal asset

function fixedQuotes(q: Quotes | null): QuotesSource {
  return { get: async () => q };
}

describe("DePix — 1:1 peg, rounded UP (no quote needed)", () => {
  it("values exact cents and ceils fractional sats", async () => {
    const v = new BrlValuator(fixedQuotes(null)); // DePix never consults quotes
    expect(await v.valuate("DEPIX", 10_000n * SATS_PER_DEPIX_CENT)).toBe(10_000);
    expect(await v.valuate("DEPIX", 10_000n * SATS_PER_DEPIX_CENT + 1n)).toBe(10_001);
    expect(await v.valuate("DEPIX", 1n)).toBe(1); // sub-cent rounds up to 1
  });
});

describe("USDt — amount × usdBrl", () => {
  it("values 1 USDt at usdBrl BRL", async () => {
    const v = new BrlValuator(fixedQuotes({ btcUsd: 100_000, usdBrl: 5 }));
    expect(await v.valuate("USDT", ONE_UNIT)).toBe(500); // 1 × 5 = R$5,00
  });

  it("ceils fractional cents (no shaving)", async () => {
    const v = new BrlValuator(fixedQuotes({ btcUsd: 100_000, usdBrl: 5.005 }));
    // 1 × 5.005 = R$5,005 → ceil(500.5) = 501 cents
    expect(await v.valuate("USDT", ONE_UNIT)).toBe(501);
  });
});

describe("L-BTC — amount × btcUsd × usdBrl", () => {
  it("values via the two-hop rate", async () => {
    const v = new BrlValuator(fixedQuotes({ btcUsd: 100_000, usdBrl: 5 }));
    // 0.0001 BTC × 100_000 × 5 = R$50,00
    expect(await v.valuate("LBTC", 10_000n)).toBe(5_000);
  });
});

describe("fail-closed (G6) — no quote blocks non-DePix signing", () => {
  it("throws QUOTES_UNAVAILABLE for L-BTC and USDt when quotes are null", async () => {
    const v = new BrlValuator(fixedQuotes(null));
    for (const asset of ["LBTC", "USDT"] as const) {
      await expect(v.valuate(asset, 1_000n)).rejects.toSatisfy((e: unknown) =>
        isDepixSdkError(e, "QUOTES_UNAVAILABLE")
      );
    }
    // DePix is unaffected (no quote needed).
    await expect(v.valuate("DEPIX", SATS_PER_DEPIX_CENT)).resolves.toBe(1);
  });
});

describe("estimateBrlCents — read surface fails SOFT (null, not throw)", () => {
  it("returns null when a needed quote is unavailable, 0 for empty, cents for DePix", async () => {
    const noQuotes = new BrlValuator(fixedQuotes(null));
    expect(await noQuotes.estimateBrlCents("LBTC", 10_000n)).toBeNull();
    expect(await noQuotes.estimateBrlCents("LBTC", 0n)).toBe(0); // zero balance needs no quote
    expect(await noQuotes.estimateBrlCents("DEPIX", 100n * SATS_PER_DEPIX_CENT)).toBe(100);
    const withQuotes = new BrlValuator(fixedQuotes({ btcUsd: 100_000, usdBrl: 5 }));
    expect(await withQuotes.estimateBrlCents("USDT", ONE_UNIT)).toBe(500);
  });
});

// ── QuotesClient cache (fresh 30s / stale 5min) ─────────────────────────────

interface FakeMode {
  fail: boolean;
  body: unknown;
}

function makeClient(mode: FakeMode, clock: () => number) {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (mode.fail) throw new Error("network down");
    return { ok: true, json: async () => mode.body } as unknown as Response;
  }) as unknown as typeof fetch;
  const client = new QuotesClient({ apiBase: "https://api.depixapp.com", fetchImpl, clock });
  return { client, calls: () => calls };
}

describe("QuotesClient cache", () => {
  it("serves fresh from cache within 30s (one fetch)", async () => {
    let t = 1_000;
    const mode: FakeMode = { fail: false, body: { btcUsd: 100_000, usdBrl: 5 } };
    const { client, calls } = makeClient(mode, () => t);
    expect(await client.get()).toEqual({ btcUsd: 100_000, usdBrl: 5 });
    t += 29_000; // still inside the 30s fresh window
    expect(await client.get()).toEqual({ btcUsd: 100_000, usdBrl: 5 });
    expect(calls()).toBe(1); // second call was served from cache
  });

  it("falls back to a stale value when upstream errors (within 5min)", async () => {
    let t = 1_000;
    const mode: FakeMode = { fail: false, body: { btcUsd: 100_000, usdBrl: 5 } };
    const { client } = makeClient(mode, () => t);
    await client.get(); // primes lastGood
    t += 60_000; // past fresh (30s), within stale (5min)
    mode.fail = true; // upstream now down
    expect(await client.get()).toEqual({ btcUsd: 100_000, usdBrl: 5 }); // stale served
  });

  it("returns null when nothing is cached and upstream is down (→ fail-closed)", async () => {
    const mode: FakeMode = { fail: true, body: null };
    const { client } = makeClient(mode, () => 1_000);
    expect(await client.get()).toBeNull();
  });

  it("returns null once the stale window (5min) is exceeded", async () => {
    let t = 1_000;
    const mode: FakeMode = { fail: false, body: { btcUsd: 100_000, usdBrl: 5 } };
    const { client } = makeClient(mode, () => t);
    await client.get();
    t += 6 * 60_000; // beyond the 5min stale window
    mode.fail = true;
    expect(await client.get()).toBeNull();
  });

  it("treats a response missing btcUsd/usdBrl as an error (no cache)", async () => {
    const mode: FakeMode = { fail: false, body: { btcUsd: "oops" } };
    const { client } = makeClient(mode, () => 1_000);
    expect(await client.get()).toBeNull();
  });
});
