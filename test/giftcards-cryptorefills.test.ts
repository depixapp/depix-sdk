// CryptoRefills REST client + pure helpers (spec §5.5). No network — the fetch
// seam is mocked. Proves the catalog/order shapes, the 1% fee (ceil, 0–10%
// band), the BOLT11 invoice extraction, the order-status mapping, and the KYC
// (e-money) signal, all as a faithful Node port of the frontend modules.
import { describe, expect, it, vi } from "vitest";
import {
  CryptorefillsClient,
  type CryptorefillsFetch,
  type CryptorefillsFetchResponse,
  buildLightningOrderBody,
  beneficiaryOf,
  computeGiftcardFeeSats,
  cryptorefillsBrandUrl,
  extractDelivery,
  extractLightningInvoice,
  filterBrands,
  isLightningRailAvailable,
  mapOrderStatus,
  normalizeBrands,
  requiresExternalCheckout
} from "../src/giftcards/cryptorefills.js";
import { CryptorefillsApiError } from "../src/errors.js";

const INVOICE = "lnbc2500u1pvjluezexampleinvoice";

function jsonResponse(body: unknown, status = 200): CryptorefillsFetchResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

describe("computeGiftcardFeeSats — 1% ceil, sane 0–10% band (§5.5)", () => {
  it("rounds the fee UP to whole sats", () => {
    expect(computeGiftcardFeeSats(250_000, 0.01)).toBe(2500n);
    expect(computeGiftcardFeeSats(12_345, 0.01)).toBe(124n); // ceil(123.45)
    expect(computeGiftcardFeeSats(1, 0.01)).toBe(1n); // ceil(0.01)
  });
  it("yields 0n for a zero / out-of-band / non-finite rate", () => {
    expect(computeGiftcardFeeSats(250_000, 0)).toBe(0n);
    expect(computeGiftcardFeeSats(250_000, 0.11)).toBe(0n); // > 10%
    expect(computeGiftcardFeeSats(250_000, -0.01)).toBe(0n);
    expect(computeGiftcardFeeSats(250_000, Number.NaN)).toBe(0n);
  });
  it("yields 0n for a non-positive invoice amount", () => {
    expect(computeGiftcardFeeSats(0, 0.01)).toBe(0n);
    expect(computeGiftcardFeeSats(-5, 0.01)).toBe(0n);
  });
  it("accepts the exact 10% ceiling", () => {
    expect(computeGiftcardFeeSats(1000, 0.1)).toBe(100n);
  });
});

describe("buildLightningOrderBody / beneficiaryOf", () => {
  it("builds a USER_WALLET BTC Lightning order with N deliveries + beneficiary", () => {
    const body = buildLightningOrderBody({
      brandName: "Amazon",
      denomination: "50",
      countryCode: "br",
      email: "agent@example.com",
      quantity: 2
    });
    expect(body.payment).toMatchObject({ payment_via: "USER_WALLET", coin: "BTC", network: "Lightning" });
    const deliveries = body.deliveries as Array<Record<string, unknown>>;
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({
      brand_name: "Amazon",
      denomination: "50",
      beneficiary_account: "agent@example.com",
      country_code: "BR"
    });
    expect(beneficiaryOf(body)).toBe("agent@example.com");
  });

  it("uses an explicit beneficiaryAccount over the email + clamps quantity to 1–10", () => {
    const body = buildLightningOrderBody({
      brandName: "Netflix",
      denomination: "range",
      countryCode: "BR",
      email: "acct@example.com",
      beneficiaryAccount: "gift@example.com",
      productValue: "35",
      quantity: 99
    });
    expect((body.deliveries as unknown[]).length).toBe(10);
    expect(beneficiaryOf(body)).toBe("gift@example.com");
    expect((body.deliveries as Array<Record<string, unknown>>)[0]!.product_value).toBe("35");
  });
});

describe("extractLightningInvoice", () => {
  it("reads the BOLT11 from wallet_address, or strips the lightning: URI from qr_text", () => {
    expect(extractLightningInvoice({ wallet_address: INVOICE })).toBe(INVOICE);
    expect(extractLightningInvoice({ qr_text: `lightning:${INVOICE}` })).toBe(INVOICE);
    expect(extractLightningInvoice({ wallet_address: "not-an-invoice" })).toBeNull();
    expect(extractLightningInvoice({})).toBeNull();
  });
});

describe("mapOrderStatus + extractDelivery", () => {
  it("collapses order_state / payment_state into a single phase", () => {
    expect(mapOrderStatus({ order_state: "Done", pin_code: "ABC-123" })).toMatchObject({
      phase: "delivered",
      terminal: true,
      delivery: { kind: "code", value: "ABC-123" }
    });
    expect(mapOrderStatus({ order_state: "Expired" })).toMatchObject({ phase: "expired", terminal: true });
    expect(mapOrderStatus({ payment_state: "PaymentReceived" })).toMatchObject({ phase: "paid", terminal: false });
    expect(mapOrderStatus({})).toMatchObject({ phase: "awaiting_payment", terminal: false });
  });
  it("classifies URL vs code delivery", () => {
    expect(extractDelivery({ pin_code: "https://redeem.example/x" })).toEqual({
      kind: "url",
      value: "https://redeem.example/x"
    });
    expect(extractDelivery({})).toEqual({ kind: "none", value: null });
  });
});

describe("normalizeBrands / filterBrands / KYC gate", () => {
  const raw = {
    country_code: "BR",
    all_brands: [
      { brand: "Amazon", family: "Amazon", kind: "giftcard", category: "e-commerce" },
      { brand: "Rewarble VISA", family: "Rewarble", kind: "giftcard", category: "e-money" },
      { brand: "Claro", family: "Claro", kind: "mobile_recharge", category: "mobile_credits" },
      { brand: "PhysicalNFT", family: "NFT", kind: "nft_giftcard", category: "nft_bundle" },
      { brand: "SteamOOS", family: "Steam", kind: "giftcard", category: "games", is_out_of_stock: true }
    ],
    popular_brands: [{ brand: "Amazon" }]
  };
  it("keeps only fulfillable kinds and derives sorted categories", () => {
    const n = normalizeBrands(raw);
    expect(n.allBrands.map((b) => b.brand)).toEqual(["Amazon", "Rewarble VISA", "Claro", "SteamOOS"]);
    expect(n.categories).toEqual(["e-commerce", "e-money", "games", "mobile_credits"]);
    expect(n.countryCode).toBe("BR");
  });
  it("filters by query + category and sorts out-of-stock last", () => {
    const n = normalizeBrands(raw);
    expect(filterBrands(n.allBrands, { query: "amaz" }).map((b) => b.brand)).toEqual(["Amazon"]);
    expect(filterBrands(n.allBrands, { category: "games" }).map((b) => b.brand)).toEqual(["SteamOOS"]);
  });
  it("flags e-money as KYC-gated (external checkout) and builds a deep link", () => {
    expect(requiresExternalCheckout({ category: "e-money" })).toBe(true);
    expect(requiresExternalCheckout({ category: "games" })).toBe(false);
    expect(cryptorefillsBrandUrl({ family: "Rewarble" }, "BR")).toBe(
      "https://www.cryptorefills.com/en/brazil/gift_cards/rewarble"
    );
  });
});

describe("isLightningRailAvailable", () => {
  it("is true only for an unsuspended USER_WALLET→BTC→Lightning path", () => {
    const vias = [
      {
        name: "USER_WALLET",
        currencies: [{ name: "BTC", networks: [{ name: "Lightning", is_suspended: false }] }]
      }
    ];
    expect(isLightningRailAvailable(vias)).toBe(true);
    expect(
      isLightningRailAvailable([
        { name: "USER_WALLET", currencies: [{ name: "BTC", networks: [{ name: "Lightning", is_suspended: true }] }] }
      ])
    ).toBe(false);
    expect(isLightningRailAvailable(null)).toBe(false);
  });
});

describe("CryptorefillsClient — REST over a mocked fetch (§5.5)", () => {
  function client(handler: (url: string, init: { method: string; body?: string }) => CryptorefillsFetchResponse): {
    client: CryptorefillsClient;
    calls: Array<{ url: string; method: string; body?: string }>;
  } {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl: CryptorefillsFetch = async (url, init) => {
      calls.push({ url, method: init.method, ...(init.body !== undefined ? { body: init.body } : {}) });
      return handler(url, init);
    };
    return { client: new CryptorefillsClient({ fetchImpl }), calls };
  }

  it("createOrder POSTs the body directly and returns the invoice-bearing order", async () => {
    const { client: c, calls } = client((url) => {
      if (url.endsWith("/v5/orders")) {
        return jsonResponse({ id: "ord-1", wallet_address: INVOICE, order_state: "WaitingForPayment" });
      }
      return jsonResponse({}, 404);
    });
    const body = buildLightningOrderBody({ brandName: "Amazon", denomination: "50", email: "a@b.com" });
    const order = await c.createOrder(body);
    expect(order.id).toBe("ord-1");
    expect(extractLightningInvoice(order)).toBe(INVOICE);
    expect(calls[0]!.method).toBe("POST");
    // Payload sent DIRECTLY (not wrapped in { body }).
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ payment: { payment_via: "USER_WALLET" } });
  });

  it("listBrands validates the country code and hits /v2/brands", async () => {
    const { client: c } = client((url) =>
      url.includes("/v2/brands?country_code=BR")
        ? jsonResponse({ country_code: "BR", all_brands: [] })
        : jsonResponse({}, 404)
    );
    await expect(c.listBrands("br")).resolves.toMatchObject({ country_code: "BR" });
    // An invalid country code is caller misuse — rejected synchronously.
    expect(() => c.listBrands("BRA")).toThrow(CryptorefillsApiError);
  });

  it("throws a typed CryptorefillsApiError carrying status + body on a non-2xx", async () => {
    const { client: c } = client(() => jsonResponse({ detail: "LOGIN_REQUIRED" }, 422));
    let caught: unknown;
    try {
      await c.createOrder({});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CryptorefillsApiError);
    expect((caught as CryptorefillsApiError).status).toBe(422);
    expect((caught as CryptorefillsApiError).body).toMatchObject({ detail: "LOGIN_REQUIRED" });
  });

  it("maps a network throw to a status-0 CryptorefillsApiError", async () => {
    const fetchImpl: CryptorefillsFetch = async () => {
      throw new Error("ECONNRESET");
    };
    const c = new CryptorefillsClient({ fetchImpl });
    await expect(c.getOrderStatus("ord-9")).rejects.toSatisfy(
      (e: unknown) => e instanceof CryptorefillsApiError && (e as CryptorefillsApiError).status === 0
    );
  });

  it("aborts a hung request with a timeout error", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl: CryptorefillsFetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      const c = new CryptorefillsClient({ fetchImpl, timeoutMs: 50 });
      const p = c.getCurrencies();
      const assertion = expect(p).rejects.toSatisfy(
        (e: unknown) => e instanceof CryptorefillsApiError && /timed out/i.test((e as Error).message)
      );
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
