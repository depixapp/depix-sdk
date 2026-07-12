// wallet.giftcards.* — the CryptoRefills gift-card namespace (spec §5.5 / §2.3).
//
// buy() drives the browser-direct CryptoRefills order flow (config gate → create
// order → BOLT11 invoice), then pays the invoice by REUSING the Boltz submarine
// flow (convert/boltz — same prepare → verify-lockup → guardrail choke point →
// L-BTC lockup → refund/watch machinery, NOT duplicated). Two things are added on
// top of a plain LN send (§5.5):
//   1. the DUAL-CLASS allowlist (§4.3): the payment enforces BOTH the Lightning
//      payee (`allowLightning`) AND the CryptoRefills beneficiary_account
//      (`giftcardBeneficiaries`) — with the allowlist ON, a non-opt-in class is
//      fail-closed GUARDRAIL_ALLOWLIST_BLOCKED;
//   2. the 1% DePix service fee — a second L-BTC output in the SAME lockup tx
//      paying the config splitAddress (computeGiftcardFeeSats, ceil).
//
// The whole flow is gated by /api/config `giftcardEnabled` (fail-closed
// GIFTCARDS_DISABLED when off/unreachable). No wallet key or fund logic lives
// here — signing stays in the wallet's lockupLbtc seam through Boltz.

import { ConversionError, CryptorefillsApiError, WalletError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { BoltzConvert, SubmarineOutcome } from "../convert/boltz/convert.js";
import { decodeInvoiceAmountSats } from "../convert/boltz/lightning.js";
import type { GiftcardConfigSource, ResolvedGiftcardConfig } from "./config.js";
import type { GiftcardOrderStore, StoredGiftcardOrder } from "./store.js";
import {
  beneficiaryOf,
  buildLightningOrderBody,
  computeGiftcardFeeSats,
  cryptorefillsBrandUrl,
  extractLightningInvoice,
  filterBrands,
  mapOrderStatus,
  normalizeBrands,
  requiresExternalCheckout,
  type CryptorefillsBrand,
  type CryptorefillsClient,
  type OrderPhase
} from "./cryptorefills.js";

export interface ListGiftcardsParams {
  /** ISO 3166-1 alpha-2; default: config `countryDefault` (BR). */
  countryCode?: string;
  /** Filter by brand/family name (case- + accent-insensitive). */
  query?: string;
  /** Filter by category key (e.g. "streaming"). */
  category?: string;
}

export interface GiftcardCatalog {
  countryCode: string;
  brands: CryptorefillsBrand[];
  popularBrands: CryptorefillsBrand[];
  categories: string[];
}

export interface BuyGiftcardParams {
  brandName: string;
  /** Exact denomination for fixed products, or "range" for dynamic ones. */
  denomination: string;
  /** Account email — the default delivery target + the beneficiary_account. */
  email: string;
  /** Delivery target override (email for gift cards, E.164 phone for recharge). */
  beneficiaryAccount?: string;
  /** ISO 3166-1 alpha-2; default: config `countryDefault`. */
  countryCode?: string;
  /** For dynamic (range) products: the chosen face value. */
  productValue?: string;
  /** N identical deliveries, 1–10 (default 1). */
  quantity?: number;
  /** Run the CryptoRefills pre-flight /v5/orders/validations first (default true). */
  validate?: boolean;
  /** The selected brand — enables the KYC "e-money" gate + the deep-link on reject. */
  brand?: CryptorefillsBrand;
}

export interface BuyGiftcardResult {
  orderId: string;
  invoice: string;
  swapId: string;
  lockupTxid: string;
  /** Decoded BOLT11 amount (sats). */
  invoiceSats: number;
  /** 1% DePix service fee (sats). */
  feeSats: bigint;
  /** L-BTC the Boltz lockup locked (expectedAmount). */
  expectedAmountSats: number;
  /** expectedAmount + fee (L-BTC leaving the wallet; network fee is separate). */
  totalSats: bigint;
  beneficiaryAccount: string;
  /** Resolves when Boltz pays the invoice (paid) or the lockup is refunded (§5.3). */
  completion: Promise<SubmarineOutcome>;
}

export interface GiftcardsNamespaceDeps {
  config: GiftcardConfigSource;
  cryptorefills: CryptorefillsClient;
  /** null on a view-only/wiped wallet (no seed to sign the L-BTC lockup). */
  boltz: BoltzConvert | null;
  store: GiftcardOrderStore;
  logger: Logger;
  now?: () => number;
}

export class GiftcardsNamespace {
  private readonly config: GiftcardConfigSource;
  private readonly cryptorefills: CryptorefillsClient;
  private readonly boltz: BoltzConvert | null;
  private readonly store: GiftcardOrderStore;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(deps: GiftcardsNamespaceDeps) {
    this.config = deps.config;
    this.cryptorefills = deps.cryptorefills;
    this.boltz = deps.boltz;
    this.store = deps.store;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Browse the CryptoRefills catalog for a country (§5.5). Gated on
   * `giftcardEnabled` (GIFTCARDS_DISABLED when off) — an operator with the shop
   * off exposes no catalog. Returns the fulfillable brands (gift cards + mobile
   * recharge) filtered by query/category, in-stock first.
   */
  async list(params: ListGiftcardsParams = {}): Promise<GiftcardCatalog> {
    const cfg = await this.requireEnabled();
    const cc = params.countryCode ?? cfg.countryDefault;
    const raw = await this.cryptorefills.listBrands(cc);
    const normalized = normalizeBrands(raw);
    const brands = filterBrands(normalized.allBrands, {
      ...(params.query !== undefined ? { query: params.query } : {}),
      ...(params.category !== undefined ? { category: params.category } : {})
    });
    return {
      countryCode: normalized.countryCode ?? cc.toUpperCase(),
      brands,
      popularBrands: normalized.popularBrands,
      categories: normalized.categories
    };
  }

  /**
   * Buy a gift card and pay it over Lightning via the Boltz submarine flow
   * (§5.5). Gated on `giftcardEnabled`. The KYC-gated "e-money" category is not
   * sellable → GIFTCARD_KYC_CATEGORY (with the external deep-link). The payment
   * passes through the guardrail choke point BEFORE the lockup is signed,
   * enforcing BOTH allowlist classes (Lightning payee + gift-card beneficiary,
   * §4.3) and adding the 1% fee output. Throws (nothing partial) on any
   * guard/funds/allowlist failure.
   */
  async buy(params: BuyGiftcardParams): Promise<BuyGiftcardResult> {
    const cfg = await this.requireEnabled();
    if (!this.boltz) {
      throw new WalletError(
        "WALLET_NOT_FOUND",
        "This wallet has no seed material (view-only/wiped) — it cannot pay a gift-card invoice."
      );
    }
    const email = String(params.email ?? "").trim();
    if (!email) {
      throw new TypeError("giftcards.buy requires `email` (the delivery target + beneficiary_account).");
    }
    if (!String(params.brandName ?? "").trim() || !String(params.denomination ?? "").trim()) {
      throw new TypeError("giftcards.buy requires `brandName` and `denomination`.");
    }
    const countryCode = params.countryCode ?? cfg.countryDefault;

    // KYC gate BEFORE creating an order (§5.5) — the anonymous Lightning flow
    // cannot fulfil an "e-money" brand; point the owner at the external page.
    // When the caller omits `brand`, resolve it from the catalog so the gate is
    // applied pre-order rather than relying only on the 422 LOGIN_REQUIRED
    // backstop (best-effort: a catalog lookup failure falls through to that
    // backstop in mapCryptorefillsError, so it never blocks a fulfillable buy).
    const brand = params.brand ?? (await this.resolveBrand(params.brandName, countryCode));
    if (brand && requiresExternalCheckout(brand)) {
      throw this.kycError(brand, countryCode);
    }

    const orderBody = buildLightningOrderBody({
      brandName: params.brandName,
      denomination: params.denomination,
      countryCode,
      email,
      ...(params.beneficiaryAccount !== undefined ? { beneficiaryAccount: params.beneficiaryAccount } : {}),
      ...(params.productValue !== undefined ? { productValue: params.productValue } : {}),
      ...(params.quantity !== undefined ? { quantity: params.quantity } : {})
    });
    const beneficiary = beneficiaryOf(orderBody) ?? email;

    // Pre-flight validation (surfaces catalog/denomination errors before the order).
    if (params.validate !== false) {
      try {
        await this.cryptorefills.validateOrder(orderBody);
      } catch (err) {
        throw this.mapCryptorefillsError(err, brand, countryCode);
      }
    }

    // NOTE (§4.3 choke-point ordering): the CryptoRefills order + BOLT11 invoice
    // are created BEFORE the guardrail/allowlist, which run at the SIGNING choke
    // point inside boltz.payLightningInvoice → lockupLbtc.enforce (below). This is
    // deliberate — the guardrail values the L-BTC LOCKUP amount, which only exists
    // once Boltz has the invoice. A buy() that the caps/allowlist will block still
    // creates an UNPAID order upstream; it commits no funds and EXPIRES on the
    // CryptoRefills side (harmless — proven by the guardrail-block tests). A cheap
    // pre-order allowlist dry-check would need the allowlist exposed through the
    // Boltz seam (convert.ts), which is out of scope for this PR.
    let order;
    try {
      order = await this.cryptorefills.createOrder(orderBody);
    } catch (err) {
      throw this.mapCryptorefillsError(err, brand, countryCode);
    }

    // The live POST /v5/orders response returns the id as `order_id`; read the
    // same three-way fallback as the frontend (order_id first), NOT `id` alone —
    // reading only `id` yielded an empty id against the real API and broke every
    // buy (the SDK's own fixtures used to mask this with the wrong field).
    const orderId = String(order?.order_id ?? order?.id ?? order?.orderId ?? "").trim();
    const invoice = extractLightningInvoice(order);
    if (!orderId || !invoice) {
      throw new CryptorefillsApiError(
        "CryptoRefills order response is missing the order id or the Lightning invoice.",
        { status: 200, body: order }
      );
    }

    const invoiceSats = decodeInvoiceAmountSats(invoice);
    if (invoiceSats == null) {
      throw new ConversionError(
        "INVOICE_NO_AMOUNT",
        "The CryptoRefills Lightning invoice has no amount — cannot value or pay it safely."
      );
    }
    const feeSats = computeGiftcardFeeSats(invoiceSats, cfg.feeRate);
    const feeSplit =
      feeSats > 0n && cfg.splitAddress ? { address: cfg.splitAddress, amountSats: feeSats } : undefined;

    // Track the order BEFORE paying so a payment failure still leaves it in the
    // log (trackable / re-pollable). Best-effort — a persist failure never blocks
    // the purchase.
    const createdAt = this.now();
    const baseRecord: StoredGiftcardOrder = {
      orderId,
      brandName: String(params.brandName),
      denomination: String(params.denomination),
      beneficiaryAccount: beneficiary,
      invoice,
      invoiceSats,
      feeSats: feeSats.toString(),
      expectedAmountSats: 0,
      swapId: "",
      phase: mapOrderStatus(order).phase,
      createdAt,
      updatedAt: createdAt
    };
    await this.store.save(baseRecord).catch((e: unknown) => {
      this.logger.warn("failed to persist gift-card order before payment", {
        orderId,
        error: String((e as Error)?.message ?? e)
      });
    });

    // Pay the invoice via the Boltz submarine flow — DUAL-CLASS allowlist +
    // service-fee output (§4.3/§5.5). enforce() runs BEFORE the lockup signs.
    const pay = await this.boltz.payLightningInvoice({
      invoice,
      extraDestinations: [{ kind: "giftcardBeneficiary", beneficiary }],
      ...(feeSplit ? { feeSplit } : {}),
      spendKind: "giftcard"
    });

    await this.store
      .update(orderId, {
        swapId: pay.swapId,
        lockupTxid: pay.lockupTxid,
        expectedAmountSats: pay.expectedAmountSats
      })
      .catch(() => {});

    return {
      orderId,
      invoice,
      swapId: pay.swapId,
      lockupTxid: pay.lockupTxid,
      invoiceSats,
      feeSats,
      expectedAmountSats: pay.expectedAmountSats,
      totalSats: BigInt(pay.expectedAmountSats) + feeSats,
      beneficiaryAccount: beneficiary,
      completion: pay.completion
    };
  }

  /** Every tracked order, newest first (local log — no config gate, no network). */
  listOrders(): Promise<StoredGiftcardOrder[]> {
    return this.store.list();
  }

  /**
   * Poll one order's CryptoRefills status and fold the result back into the
   * local log (read-only, no config gate). Returns the mapped phase + delivery.
   */
  async getOrderStatus(orderId: string): Promise<OrderPhase> {
    const order = await this.cryptorefills.getOrderStatus(orderId);
    const phase = mapOrderStatus(order);
    await this.store.update(orderId, { phase: phase.phase }).catch(() => {});
    return phase;
  }

  private async requireEnabled(): Promise<ResolvedGiftcardConfig> {
    const cfg = await this.config.getGiftcardConfig();
    if (!cfg.enabled) {
      throw new ConversionError(
        "GIFTCARDS_DISABLED",
        "Gift cards are disabled: the DePix backend has the CryptoRefills integration off " +
          "(or /api/config is unreachable — fail-closed). Ask the account owner to enable it."
      );
    }
    return cfg;
  }

  private kycError(brand: CryptorefillsBrand, countryCode: string): ConversionError {
    const url = cryptorefillsBrandUrl(brand, countryCode);
    return new ConversionError(
      "GIFTCARD_KYC_CATEGORY",
      `This brand is a KYC-gated "e-money" product that the anonymous browser-direct ` +
        `Lightning flow cannot buy. Purchase it directly (verified web account required): ${url}`,
      { details: { externalUrl: url, category: "e-money" } }
    );
  }

  /**
   * Map a CryptoRefills 422 LOGIN_REQUIRED (an e-money brand that slipped past
   * the category gate) to the typed GIFTCARD_KYC_CATEGORY; every other error is
   * re-thrown unchanged.
   */
  private mapCryptorefillsError(err: unknown, brand: CryptorefillsBrand | undefined, countryCode: string): unknown {
    if (err instanceof CryptorefillsApiError && err.status === 422) {
      const body = err.body;
      const detail = body && typeof body === "object" ? (body as Record<string, unknown>).detail : undefined;
      if (detail === "LOGIN_REQUIRED") return this.kycError(brand ?? {}, countryCode);
    }
    return err;
  }

  /**
   * Best-effort catalog lookup of a brand by name — used to apply the KYC
   * "e-money" gate pre-order when the caller didn't pass `params.brand`. Matches
   * on brand or family name (case-insensitive). Returns undefined on a catalog
   * miss/failure, so the 422 LOGIN_REQUIRED mapping stays the backstop and this
   * never blocks a fulfillable buy.
   */
  private async resolveBrand(brandName: string, countryCode: string): Promise<CryptorefillsBrand | undefined> {
    const want = String(brandName ?? "").trim().toLowerCase();
    if (!want) return undefined;
    try {
      const raw = await this.cryptorefills.listBrands(countryCode);
      const all = Array.isArray(raw?.all_brands) ? raw.all_brands : [];
      return all.find(
        (b) => String(b?.brand ?? "").toLowerCase() === want || String(b?.family ?? "").toLowerCase() === want
      );
    } catch {
      return undefined;
    }
  }
}
