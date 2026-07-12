// CryptoRefills REST API client + pure helpers (spec §5.5). Node port of
// depix-frontend/wallet/cryptorefills.js (+ the catalog/order/status helpers of
// shop-logic.js). The public catalog + order endpoints require NO API key and
// NO authentication — the DePix backend is never in the loop for gift cards
// (browser-direct in the PWA, fetch-direct here). This layer is pure HTTP: it
// never touches wallet keys or funds. The Lightning payment of the returned
// BOLT11 invoice is driven by the Boltz submarine flow (convert/boltz/*),
// through the guardrail choke point (§4.3) — see giftcards/namespace.ts.

import { CryptorefillsApiError } from "../errors.js";

export const CRYPTOREFILLS_API_BASE = "https://api.cryptorefills.com";
export const DEFAULT_COUNTRY = "BR";
export const DEFAULT_LANG = "pt";
const DEFAULT_TIMEOUT_MS = 20_000;

// The payment rail we drive: a USER_WALLET BTC payment on the Lightning
// network. createOrder with this shape returns a BOLT11 invoice (in
// `wallet_address`), which the Boltz submarine swap pays from the wallet's
// L-BTC balance.
export const LIGHTNING_PAYMENT = Object.freeze({
  type: "via",
  payment_via: "USER_WALLET",
  coin: "BTC",
  network: "Lightning"
});

// Brand kinds the shop can fulfil (email/phone delivery). Anything else — e.g.
// the physical "nft_giftcard" — is dropped from the catalog.
export const SUPPORTED_BRAND_KINDS = Object.freeze(["giftcard", "mobile_recharge"]);

// Prepaid / "e-money" brands (Rewarble VISA/PayPal, iCash, …) require a
// logged-in, KYC-verified CryptoRefills web account — orders return 422
// LOGIN_REQUIRED and the public API is anonymous. The browser-direct Lightning
// flow can't fulfil them (§5.5). Signal is the "e-money" category ONLY.
export const EXTERNAL_CHECKOUT_CATEGORIES = Object.freeze(["e-money"]);

// ── fetch seam ───────────────────────────────────────────────────────────────

export interface CryptorefillsFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type CryptorefillsFetch = (
  url: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    credentials?: string;
  }
) => Promise<CryptorefillsFetchResponse>;

export interface CryptorefillsClientOptions {
  /** Injected fetch (defaults to Node's global). */
  fetchImpl?: CryptorefillsFetch;
  apiBase?: string;
  timeoutMs?: number;
}

// ── loose response shapes (the catalog is large + evolving; we type only what
//    we read) ──────────────────────────────────────────────────────────────────

export interface CryptorefillsBrand {
  brand?: string;
  family?: string;
  kind?: string;
  category?: string;
  additional_categories?: string[];
  is_out_of_stock?: boolean;
  [k: string]: unknown;
}

export interface CryptorefillsBrandsRaw {
  country_code?: string;
  all_brands?: CryptorefillsBrand[];
  popular_brands?: CryptorefillsBrand[];
  [k: string]: unknown;
}

export interface NormalizedBrands {
  countryCode: string | null;
  allBrands: CryptorefillsBrand[];
  popularBrands: CryptorefillsBrand[];
  categories: string[];
}

export interface CryptorefillsOrder {
  /**
   * The order id. The LIVE POST /v5/orders response returns it as `order_id`;
   * `id`/`orderId` are accepted as fallbacks (the frontend reads all three,
   * order_id first). Always resolve via the three-way fallback, never `id` alone.
   */
  order_id?: string;
  id?: string;
  orderId?: string;
  order_state?: string;
  payment_state?: string;
  wallet_address?: string;
  qr_text?: string;
  coin_amount?: string;
  pin_code?: string;
  voucher_code?: string;
  pin?: string;
  [k: string]: unknown;
}

export interface OrderDelivery {
  kind: "url" | "code" | "none";
  value: string | null;
}

export interface OrderPhase {
  phase: "delivered" | "expired" | "canceled" | "manual" | "paid" | "awaiting_payment";
  terminal: boolean;
  delivery?: OrderDelivery;
}

export interface LightningOrderBodyParams {
  brandName: string;
  denomination: string;
  countryCode?: string;
  email: string;
  beneficiaryAccount?: string;
  productValue?: string;
  quantity?: number;
}

// ── product / denomination shapes (GET /v5/products/country + /v4/products/price)
//    — typed only for the fields we read (raw passthrough elsewhere) ────────────

/** A face-value block on a product: fiat currency + (fixed) price / (range) bounds. */
export interface CryptorefillsFaceValue {
  currency_code?: string;
  amount?: {
    price?: number | string;
    min?: number | string;
    minimum?: number | string;
    max?: number | string;
    maximum?: number | string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** A raw product (denomination) inside a /v5/products/country entry. */
export interface CryptorefillsRawProduct {
  denomination?: string;
  localized_denomination?: string;
  /** The fixed-vs-range decider (Boolean(is_dynamic) === range/custom-value). */
  is_dynamic?: boolean;
  /** BTC amount for a FIXED product (→ sats via satsFromBtcAmount). */
  coin_amount?: string;
  face_value?: CryptorefillsFaceValue;
  [k: string]: unknown;
}

/** A /v5/products/country entry — a brand plus its nested products[]. */
export interface CryptorefillsProductsEntry {
  brand?: string;
  products?: CryptorefillsRawProduct[];
  [k: string]: unknown;
}

/** The /v4/products/price response for a range (dynamic) product's custom value. */
export interface CryptorefillsPrice {
  coin_amount?: string;
  [k: string]: unknown;
}

/**
 * A normalized product/denomination — a faithful projection of a
 * CryptorefillsRawProduct: `is_dynamic` becomes `isDynamic`; a FIXED product's
 * BTC `coin_amount` becomes `coinAmountSats`; the `face_value` block becomes the
 * fiat `{ currency, price, min, max }`. Range products carry no coinAmountSats
 * (they are priced per value via getProductPrice).
 */
export interface CryptorefillsProduct {
  /** The exact denomination string to pass to buy() for a FIXED product. */
  denomination: string;
  /** Localized label, when the API provides one. */
  localizedDenomination?: string;
  /** true = range/custom-value ("range" + productValue); false = fixed. */
  isDynamic: boolean;
  /** BTC price in sats for a FIXED product; absent for a range product. */
  coinAmountSats?: number;
  /** Fiat face value: currency + (fixed) price and (range) min/max bounds. */
  faceValue?: {
    currency?: string;
    price?: number;
    min?: number;
    max?: number;
  };
}

function resolveFetch(fetchImpl?: CryptorefillsFetch): CryptorefillsFetch {
  const impl =
    fetchImpl ??
    (typeof fetch === "function" ? (fetch.bind(globalThis) as unknown as CryptorefillsFetch) : null);
  if (!impl) throw new CryptorefillsApiError("No fetch implementation available");
  return impl;
}

function requireCountry(countryCode: string | undefined): string {
  const cc = String(countryCode || DEFAULT_COUNTRY).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) {
    throw new CryptorefillsApiError(`Invalid country_code: ${String(countryCode)}`);
  }
  return cc;
}

/** REST client — thin, dependency-injected, unauthenticated (§5.5). */
export class CryptorefillsClient {
  private readonly doFetch: CryptorefillsFetch;
  private readonly apiBase: string;
  private readonly timeoutMs: number;

  constructor(options: CryptorefillsClientOptions = {}) {
    this.doFetch = resolveFetch(options.fetchImpl);
    this.apiBase = (options.apiBase ?? CRYPTOREFILLS_API_BASE).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async crFetch<T>(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string } = { method: "GET" }
  ): Promise<T> {
    // Bound every call so a hung CryptoRefills endpoint can't wedge an agent
    // loop. The 15-minute Lightning order window is plenty; a single request
    // taking 20s is already a failure worth surfacing.
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    let res: CryptorefillsFetchResponse;
    try {
      res = await this.doFetch(`${this.apiBase}${path}`, {
        method: init.method,
        headers: { accept: "application/json", ...(init.headers ?? {}) },
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(controller ? { signal: controller.signal } : {}),
        credentials: "omit"
      });
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        throw new CryptorefillsApiError("CryptoRefills request timed out", { status: 0 });
      }
      throw new CryptorefillsApiError((err as Error)?.message || "CryptoRefills network error", {
        status: 0,
        cause: err
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    let body: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
      const msg =
        (rec && (typeof rec.error === "string" ? rec.error : typeof rec.message === "string" ? rec.message : null)) ??
        `CryptoRefills API ${res.status}`;
      throw new CryptorefillsApiError(msg, { status: res.status, body });
    }
    return body as T;
  }

  private jsonPost(path: string, obj: unknown): Promise<unknown> {
    return this.crFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(obj)
    });
  }

  // --- Catalog (read-only) --------------------------------------------------

  /** GET /v3/currencies — supported payment cryptocurrencies. */
  getCurrencies(): Promise<unknown> {
    return this.crFetch("/v3/currencies", { method: "GET" });
  }

  /** GET /v3/payment_vias — payment methods mapped to currencies + networks. */
  getPaymentVias(): Promise<unknown> {
    return this.crFetch("/v3/payment_vias", { method: "GET" });
  }

  /** GET /v2/brands?country_code=CC — full brand catalog for a country. */
  listBrands(countryCode?: string): Promise<CryptorefillsBrandsRaw> {
    const cc = requireCountry(countryCode);
    return this.crFetch<CryptorefillsBrandsRaw>(`/v2/brands?country_code=${cc}`, { method: "GET" });
  }

  /** GET /v2/search/{cc}?q=&lang= — full-text product search (param is `q`, not `query`). */
  searchProducts(countryCode: string, q: string, opts: { lang?: string } = {}): Promise<unknown> {
    const cc = requireCountry(countryCode);
    const params = new URLSearchParams({ q: String(q ?? ""), lang: opts.lang ?? DEFAULT_LANG });
    return this.crFetch(`/v2/search/${cc}?${params.toString()}`, { method: "GET" });
  }

  /** GET /v5/products/country/{cc} — detailed product list with denominations. */
  listProductsForCountry(
    countryCode: string,
    opts: { brandName?: string; familyName?: string; coin?: string; paymentMethod?: string; lang?: string } = {}
  ): Promise<CryptorefillsProductsEntry[]> {
    const cc = requireCountry(countryCode);
    const params = new URLSearchParams();
    if (opts.brandName) params.set("brand_name", opts.brandName);
    if (opts.familyName) params.set("family_name", opts.familyName);
    if (opts.coin) params.set("coin", opts.coin);
    if (opts.paymentMethod) params.set("payment_method", opts.paymentMethod);
    params.set("lang", opts.lang || DEFAULT_LANG);
    return this.crFetch<CryptorefillsProductsEntry[]>(`/v5/products/country/${cc}?${params.toString()}`, {
      method: "GET"
    });
  }

  /** GET /v4/products/price — exact crypto price for a RANGE (dynamic) product. */
  getProductPrice(params: {
    brandName: string;
    countryCode?: string;
    faceValue: string | number;
    coin?: string;
    promoCode?: string;
  }): Promise<CryptorefillsPrice> {
    const cc = requireCountry(params.countryCode);
    const q = new URLSearchParams({
      brand_name: String(params.brandName ?? ""),
      country_code: cc,
      face_value: String(params.faceValue ?? ""),
      coin: params.coin ?? "BTC"
    });
    if (params.promoCode) q.set("promo_code", params.promoCode);
    return this.crFetch<CryptorefillsPrice>(`/v4/products/price?${q.toString()}`, { method: "GET" });
  }

  // --- Orders ---------------------------------------------------------------

  /** POST /v5/orders/validations — pre-flight validation (payload sent DIRECTLY, not wrapped). */
  validateOrder(orderBody: unknown): Promise<unknown> {
    return this.jsonPost("/v5/orders/validations", orderBody);
  }

  /** POST /v5/orders — create the order; for Lightning the response carries the BOLT11 invoice. */
  createOrder(orderBody: unknown): Promise<CryptorefillsOrder> {
    return this.jsonPost("/v5/orders", orderBody) as Promise<CryptorefillsOrder>;
  }

  /** GET /v5/orders/{id} — poll status + delivery. */
  getOrderStatus(orderId: string): Promise<CryptorefillsOrder> {
    const id = encodeURIComponent(String(orderId ?? ""));
    return this.crFetch<CryptorefillsOrder>(`/v5/orders/${id}`, { method: "GET" });
  }
}

// ── pure helpers (no network) ────────────────────────────────────────────────

/**
 * The 1% (or configured rate) service fee on the invoice value, rounded UP to
 * whole sats, as a BigInt (spec §5.5; parity with computeGiftcardFeeSats /
 * feeSatsFor in the frontend). The fee is charged on the gift-card cost (the
 * invoice amount), not on the Boltz lockup total — Boltz's own fees are not part
 * of the service-fee base. A rate of 0 (or out of the sane 0–10% band) yields 0n
 * (no fee output).
 */
export function computeGiftcardFeeSats(invoiceSats: number | bigint, feeRate: number): bigint {
  const sats = Number(invoiceSats);
  const rate = Number(feeRate);
  if (!Number.isFinite(sats) || sats <= 0) return 0n;
  if (!Number.isFinite(rate) || rate <= 0 || rate > 0.1) return 0n;
  return BigInt(Math.ceil(sats * rate));
}

/**
 * Build the CryptoRefills order body for a single delivery paid via Lightning
 * (spec §5.5). `denomination` is the exact denomination string for fixed
 * products, or "range" + `productValue` for dynamic ones. `beneficiaryAccount`
 * is where the product is delivered — the buyer's email for gift cards / eSIMs,
 * an E.164 phone for mobile recharge; defaults to `email`. Quantity = N
 * identical deliveries (the API's deliveries[] accepts 1–10).
 */
export function buildLightningOrderBody(params: LightningOrderBodyParams): Record<string, unknown> {
  const cc = requireCountry(params.countryCode);
  const delivery: Record<string, unknown> = {
    denomination: String(params.denomination ?? ""),
    brand_name: String(params.brandName ?? ""),
    beneficiary_account: String(params.beneficiaryAccount ?? params.email ?? ""),
    country_code: cc
  };
  if (params.productValue != null && String(params.productValue).length) {
    delivery.product_value = String(params.productValue);
  }
  const n = Math.max(1, Math.min(10, Number(params.quantity) || 1));
  return {
    payment: { ...LIGHTNING_PAYMENT },
    deliveries: Array.from({ length: n }, () => ({ ...delivery })),
    user: { email: String(params.email ?? "") },
    lang: DEFAULT_LANG
  };
}

/**
 * The raw BOLT11 invoice from a createOrder response. For a Lightning order the
 * invoice lives in `wallet_address` (e.g. "lnbc18510n1p..."); `qr_text` is the
 * SAME invoice prefixed with the "lightning:" URI scheme. Returns null if
 * neither field looks like a BOLT11 invoice.
 */
export function extractLightningInvoice(order: CryptorefillsOrder | null | undefined): string | null {
  const isBolt11 = (s: unknown): boolean => /^ln(bc|tb|bcrt|bs|tbs)/i.test(String(s || ""));
  const wa = String(order?.wallet_address || "");
  if (isBolt11(wa)) return wa;
  const qr = String(order?.qr_text || "").replace(/^lightning:/i, "").trim();
  if (isBolt11(qr)) return qr;
  return null;
}

/** The beneficiary_account of the FIRST delivery of an order body (§4.3 allowlist class). */
export function beneficiaryOf(orderBody: unknown): string | null {
  const rec = orderBody && typeof orderBody === "object" ? (orderBody as Record<string, unknown>) : null;
  const deliveries = rec && Array.isArray(rec.deliveries) ? (rec.deliveries as unknown[]) : [];
  const first = deliveries[0];
  const acct =
    first && typeof first === "object" ? (first as Record<string, unknown>).beneficiary_account : undefined;
  return typeof acct === "string" && acct.length > 0 ? acct : null;
}

/** Pull the redemption value out of a delivered order (pin_code / voucher / URL). */
export function extractDelivery(order: CryptorefillsOrder | null | undefined): OrderDelivery {
  const pin = order?.pin_code ?? order?.voucher_code ?? order?.pin ?? null;
  if (typeof pin === "string" && pin.trim()) {
    const v = pin.trim();
    return /^https?:\/\//i.test(v) ? { kind: "url", value: v } : { kind: "code", value: v };
  }
  return { kind: "none", value: null };
}

/**
 * Collapse CryptoRefills order_state + payment_state into a single phase the
 * caller polls on (spec §5.5). `terminal` stops the poll loop.
 */
export function mapOrderStatus(order: CryptorefillsOrder | null | undefined): OrderPhase {
  const orderState = String(order?.order_state || "").trim();
  const paymentState = String(order?.payment_state || "").trim();

  if (orderState === "Done" || orderState === "Completed") {
    return { phase: "delivered", terminal: true, delivery: extractDelivery(order) };
  }
  if (orderState === "Expired") return { phase: "expired", terminal: true };
  if (orderState === "Canceled" || orderState === "Cancelled") return { phase: "canceled", terminal: true };
  if (orderState === "WaitingForManualAction") return { phase: "manual", terminal: false };
  if (paymentState === "PaymentReceived") return { phase: "paid", terminal: false };
  if (paymentState === "Expired" || paymentState === "ExpiredAfterPaymentDetection") {
    return { phase: "expired", terminal: true };
  }
  return { phase: "awaiting_payment", terminal: false };
}

/**
 * Normalize the /v2/brands response into the catalog shape list() returns.
 * Only SUPPORTED_BRAND_KINDS are kept; categories are derived from the per-brand
 * `category` field (the top-level categories array has observed-null names).
 */
export function normalizeBrands(raw: CryptorefillsBrandsRaw | null | undefined): NormalizedBrands {
  const supported = new Set(SUPPORTED_BRAND_KINDS);
  const all = Array.isArray(raw?.all_brands) ? raw.all_brands : [];
  const allBrands = all.filter((b) => supported.has(String(b?.kind)));
  const popularBrands = Array.isArray(raw?.popular_brands) ? raw.popular_brands : [];
  const categorySet = new Set<string>();
  for (const b of allBrands) {
    if (b && typeof b.category === "string" && b.category.trim()) categorySet.add(b.category.trim());
  }
  return {
    countryCode: raw?.country_code ?? null,
    allBrands,
    popularBrands,
    categories: Array.from(categorySet).sort()
  };
}

function normalizeText(s: unknown): string {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

/**
 * Filter + order brands for the catalog. `query` matches the brand/family name
 * (case- + accent-insensitive); `category` matches the brand's primary or
 * additional categories. Out-of-stock brands sort last (not removed).
 */
export function filterBrands(
  brands: CryptorefillsBrand[] | null | undefined,
  opts: { query?: string; category?: string } = {}
): CryptorefillsBrand[] {
  const list = Array.isArray(brands) ? brands : [];
  const q = normalizeText(opts.query);
  const cat = String(opts.category || "").trim().toLowerCase();
  const matched = list.filter((b) => {
    if (!b) return false;
    if (cat) {
      const cats = [b.category, ...(Array.isArray(b.additional_categories) ? b.additional_categories : [])]
        .filter(Boolean)
        .map((c) => String(c).toLowerCase());
      if (!cats.includes(cat)) return false;
    }
    if (q) {
      const hay = normalizeText(`${b.brand || ""} ${b.family || ""}`);
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  return matched
    .map((b, i) => ({ b, i }))
    .sort((a, c) => (a.b.is_out_of_stock ? 1 : 0) - (c.b.is_out_of_stock ? 1 : 0) || a.i - c.i)
    .map((x) => x.b);
}

/**
 * Parse a BTC decimal amount ("0.00025000" or a number) into whole sats as a
 * BigInt — faithful port of the frontend `satsFromBtcAmount` (shop-logic.js).
 * Sub-sat precision is truncated; returns null for malformed input.
 */
export function satsFromBtcAmount(btc: unknown): bigint | null {
  if (btc == null) return null;
  const s = String(btc).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [intPart = "0", fracRaw = ""] = s.split(".");
  const frac = (fracRaw + "00000000").slice(0, 8);
  try {
    return BigInt(intPart) * 100_000_000n + BigInt(frac);
  } catch {
    return null;
  }
}

/** The /v4/products/price coin_amount → whole sats as a Number, or null. */
export function priceToSats(price: CryptorefillsPrice | null | undefined): number | null {
  const sats = satsFromBtcAmount(price?.coin_amount);
  return sats == null ? null : Number(sats);
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeFaceValue(fv: CryptorefillsFaceValue | undefined): CryptorefillsProduct["faceValue"] | undefined {
  if (!fv || typeof fv !== "object") return undefined;
  const amount = fv.amount && typeof fv.amount === "object" ? fv.amount : {};
  const out: NonNullable<CryptorefillsProduct["faceValue"]> = {};
  if (typeof fv.currency_code === "string" && fv.currency_code.trim()) out.currency = fv.currency_code;
  const price = numOrNull(amount.price);
  if (price != null) out.price = price;
  const min = numOrNull(amount.min ?? amount.minimum);
  if (min != null) out.min = min;
  const max = numOrNull(amount.max ?? amount.maximum);
  if (max != null) out.max = max;
  return Object.keys(out).length ? out : undefined;
}

/** Project one raw product (denomination) into the normalized CryptorefillsProduct. */
export function normalizeProduct(raw: CryptorefillsRawProduct | null | undefined): CryptorefillsProduct {
  const isDynamic = Boolean(raw?.is_dynamic);
  const product: CryptorefillsProduct = { denomination: String(raw?.denomination ?? ""), isDynamic };
  const label = raw?.localized_denomination;
  if (typeof label === "string" && label.trim()) product.localizedDenomination = label;
  // Fixed products carry their BTC price directly; range products are priced per
  // value on demand via getProductPrice, so they get no coinAmountSats here.
  if (!isDynamic) {
    const sats = satsFromBtcAmount(raw?.coin_amount);
    if (sats != null) product.coinAmountSats = Number(sats);
  }
  const faceValue = normalizeFaceValue(raw?.face_value);
  if (faceValue) product.faceValue = faceValue;
  return product;
}

/**
 * Normalize a /v5/products/country response into a brand's products. Mirrors the
 * frontend entry-selection (shop-ui.js): the response is a list of brand
 * entries; pick the one matching `brandName` that has products, else the first
 * non-empty entry. Returns ALL products (fixed AND range) — unlike the frontend
 * UI, which collapses a mixed brand to a single range input.
 */
export function normalizeProducts(
  raw: CryptorefillsProductsEntry[] | null | undefined,
  brandName?: string
): CryptorefillsProduct[] {
  const entries = Array.isArray(raw) ? raw : [];
  const want = String(brandName ?? "").trim();
  const hasProducts = (e: CryptorefillsProductsEntry | undefined): boolean =>
    Boolean(e && Array.isArray(e.products) && e.products.length);
  const entry =
    (want ? entries.find((e) => e?.brand === want && hasProducts(e)) : undefined) ?? entries.find(hasProducts);
  const products = entry && Array.isArray(entry.products) ? entry.products : [];
  return products.map(normalizeProduct);
}

/** True when a product takes a free-form amount within a min/max range. */
export function isRangeProduct(product: { is_dynamic?: unknown } | null | undefined): boolean {
  return Boolean(product?.is_dynamic);
}

/** The denomination string to send: the exact one for fixed, or "range" for dynamic. */
export function orderDenomination(
  product: { is_dynamic?: unknown; denomination?: unknown } | null | undefined
): string {
  return isRangeProduct(product) ? "range" : String(product?.denomination ?? "");
}

/**
 * True when the brand is a KYC-gated "e-money" product that only a logged-in,
 * verified CryptoRefills web account can buy — unfulfillable by the anonymous
 * Lightning flow (§5.5). The signal is the "e-money" category ONLY.
 */
export function requiresExternalCheckout(brand: CryptorefillsBrand | null | undefined): boolean {
  const category = String(brand?.category || "").toLowerCase();
  return EXTERNAL_CHECKOUT_CATEGORIES.includes(category);
}

/**
 * Deep link to a brand's purchase page on cryptorefills.com — surfaced in the
 * GIFTCARD_KYC_CATEGORY error so the agent's owner can buy it directly.
 */
export function cryptorefillsBrandUrl(
  brand: CryptorefillsBrand | null | undefined,
  countryIso: string | undefined
): string {
  const base = "https://www.cryptorefills.com/en";
  const name = brand?.family || brand?.brand || "";
  let region = "";
  try {
    region = new Intl.DisplayNames(["en"], { type: "region" }).of(String(countryIso || "").toUpperCase()) || "";
  } catch {
    // Unknown region code → fall back to the homepage below.
  }
  const country = region.toLowerCase().trim().replace(/\s+/g, "_");
  if (!name || !country) return base;
  const slug = encodeURIComponent(String(name).toLowerCase().trim().replace(/\s+/g, "_"));
  return `${base}/${country}/gift_cards/${slug}`;
}

/**
 * True when the live payment_vias matrix offers USER_WALLET → BTC → Lightning
 * unsuspended. The buy flow can be gated on this so we never create an order we
 * can't pay over Lightning (parity with isLightningRailAvailable).
 */
export function isLightningRailAvailable(paymentVias: unknown): boolean {
  if (!Array.isArray(paymentVias)) return false;
  const wallet = paymentVias.find(
    (v) => (v as { name?: string })?.name === "USER_WALLET" && (v as { available?: boolean })?.available !== false
  ) as { currencies?: unknown[] } | undefined;
  if (!wallet || !Array.isArray(wallet.currencies)) return false;
  const btc = wallet.currencies.find(
    (c) => (c as { name?: string })?.name === "BTC" && (c as { is_suspended?: boolean })?.is_suspended !== true
  ) as { networks?: unknown[] } | undefined;
  if (!btc || !Array.isArray(btc.networks)) return false;
  return btc.networks.some(
    (n) => (n as { name?: string })?.name === "Lightning" && (n as { is_suspended?: boolean })?.is_suspended !== true
  );
}
