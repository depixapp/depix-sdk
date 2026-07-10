// Gift-card /api/config client (spec §5.5) — parsing + FAIL-CLOSED on
// outage/malformed payload (feature treated as OFF), 5-minute cache.
import { describe, expect, it, vi } from "vitest";
import { GiftcardConfigClient, resolveGiftcardConfig } from "../src/giftcards/config.js";
import type { FetchLike, FetchResponseLike } from "../src/api/client.js";
import type { Logger } from "../src/logger.js";

const SILENT: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function res(body: unknown, status = 200): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body)
  };
}

const ENABLED_BODY = {
  walletEnabled: true,
  giftcardEnabled: true,
  giftcardFeeRate: 0.01,
  giftcardSplitAddress: "lq1splitaddress",
  giftcardCountryDefault: "BR"
};

describe("resolveGiftcardConfig — mirrors the frontend validation", () => {
  it("enables only on strictly true, clamps the fee, validates the address + country", () => {
    expect(resolveGiftcardConfig(ENABLED_BODY)).toEqual({
      enabled: true,
      feeRate: 0.01,
      splitAddress: "lq1splitaddress",
      countryDefault: "BR"
    });
    // Out-of-band fee → 1%; empty address → null; bad country → BR.
    expect(resolveGiftcardConfig({ giftcardEnabled: true, giftcardFeeRate: 0.5 }).feeRate).toBe(0.01);
    expect(resolveGiftcardConfig({ giftcardEnabled: true, giftcardSplitAddress: "" }).splitAddress).toBeNull();
    expect(resolveGiftcardConfig({ giftcardEnabled: true, giftcardCountryDefault: "usa" }).countryDefault).toBe("BR");
    expect(resolveGiftcardConfig({ giftcardEnabled: 1 as unknown as boolean }).enabled).toBe(false);
    expect(resolveGiftcardConfig(null).enabled).toBe(false);
  });
});

describe("GiftcardConfigClient", () => {
  it("fetches /api/config and resolves the gift-card fields", async () => {
    let hits = 0;
    const fetchImpl: FetchLike = async (url) => {
      hits++;
      expect(url).toBe("https://api.depixapp.com/api/config");
      return res(ENABLED_BODY);
    };
    const c = new GiftcardConfigClient({ fetch: fetchImpl, logger: SILENT });
    await expect(c.getGiftcardConfig()).resolves.toMatchObject({ enabled: true, feeRate: 0.01 });
    // Cached within the TTL — a second call does not refetch.
    await c.getGiftcardConfig();
    expect(hits).toBe(1);
    // force bypasses the cache.
    await c.getGiftcardConfig({ force: true });
    expect(hits).toBe(2);
  });

  it("honors a custom apiBase", async () => {
    const fetchImpl: FetchLike = async (url) => {
      expect(url).toBe("https://api.example.test/api/config");
      return res(ENABLED_BODY);
    };
    const c = new GiftcardConfigClient({ apiBase: "https://api.example.test/", fetch: fetchImpl, logger: SILENT });
    await expect(c.getGiftcardConfig()).resolves.toMatchObject({ enabled: true });
  });

  it("FAILS CLOSED (enabled:false) on a non-2xx response", async () => {
    const fetchImpl: FetchLike = async () => res({}, 503);
    const c = new GiftcardConfigClient({ fetch: fetchImpl, logger: SILENT });
    await expect(c.getGiftcardConfig()).resolves.toMatchObject({ enabled: false, feeRate: 0.01 });
  });

  it("FAILS CLOSED on a network throw", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ENOTFOUND");
    };
    const c = new GiftcardConfigClient({ fetch: fetchImpl, logger: SILENT });
    await expect(c.getGiftcardConfig()).resolves.toMatchObject({ enabled: false });
  });

  it("FAILS CLOSED on a timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl: FetchLike = () => new Promise<FetchResponseLike>(() => {});
      const c = new GiftcardConfigClient({ fetch: fetchImpl, logger: SILENT, timeoutMs: 30 });
      const p = c.getGiftcardConfig();
      await vi.advanceTimersByTimeAsync(40);
      await expect(p).resolves.toMatchObject({ enabled: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes an AbortSignal and ABORTS the underlying request on timeout", async () => {
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | undefined;
      const fetchImpl: FetchLike = (_url, init) => {
        capturedSignal = init.signal;
        return new Promise<FetchResponseLike>(() => {}); // never settles on its own
      };
      const c = new GiftcardConfigClient({ fetch: fetchImpl, logger: SILENT, timeoutMs: 30 });
      const p = c.getGiftcardConfig();
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(capturedSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(40);
      await expect(p).resolves.toMatchObject({ enabled: false });
      // The timeout aborts the underlying fetch, not just the race.
      expect(capturedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("FAILS CLOSED once the last successful config is STALE and /api/config is unreachable (§5.5)", async () => {
    let clock = 1_000_000;
    let up = true;
    const fetchImpl: FetchLike = async () => {
      if (!up) throw new Error("ENOTFOUND");
      return res(ENABLED_BODY);
    };
    const c = new GiftcardConfigClient({ fetch: fetchImpl, logger: SILENT, now: () => clock });
    // A successful fetch caches enabled:true.
    await expect(c.getGiftcardConfig()).resolves.toMatchObject({ enabled: true });
    // Endpoint drops but we are still WITHIN the TTL → the fresh cache tolerates the blip.
    up = false;
    clock += 60_000; // +1 min (< 5-min TTL)
    await expect(c.getGiftcardConfig({ force: true })).resolves.toMatchObject({ enabled: true });
    // Past the TTL from the last success + still unreachable → fail closed to DISABLED.
    clock += 5 * 60_000;
    await expect(c.getGiftcardConfig()).resolves.toMatchObject({ enabled: false, splitAddress: null });
  });

  it("FAILS CLOSED when giftcardEnabled=true but giftcardSplitAddress is missing (§5.5)", async () => {
    // A backend that ships enabled:true with no split address would drop the 1%
    // fee output silently — treat it as broken config and disable.
    const fetchImpl: FetchLike = async () =>
      res({ walletEnabled: true, giftcardEnabled: true, giftcardFeeRate: 0.01, giftcardCountryDefault: "BR" });
    const c = new GiftcardConfigClient({ fetch: fetchImpl, logger: SILENT });
    await expect(c.getGiftcardConfig()).resolves.toMatchObject({ enabled: false, splitAddress: null });
  });
});
