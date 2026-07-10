// wallet.giftcards.* (spec §5.5 / §4.3) — wallet-level integration with the
// CryptoRefills client + /api/config source + Boltz submarine flow all INJECTED
// (no network, no WASM). Proves:
//   - the whole flow is gated on giftcardEnabled (GIFTCARDS_DISABLED when off);
//   - the KYC "e-money" category is not sellable (GIFTCARD_KYC_CATEGORY + link),
//     also mapped from a CryptoRefills 422 LOGIN_REQUIRED;
//   - the DUAL-CLASS allowlist (§4.3): with the allowlist ON, BOTH the Lightning
//     payee (allowLightning) AND the beneficiary_account (giftcardBeneficiaries)
//     must be opted in — a missing class fails closed GUARDRAIL_ALLOWLIST_BLOCKED;
//   - the guardrail counts the expectedAmount L-BTC in BRL;
//   - the order is tracked (listOrders) and its status re-pollable.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DepixWallet } from "../src/wallet.js";
import type { BoltzClient } from "../src/convert/boltz/client.js";
import type { CryptorefillsClient, CryptorefillsOrder } from "../src/giftcards/cryptorefills.js";
import type { GiftcardConfigSource, ResolvedGiftcardConfig } from "../src/giftcards/config.js";
import type { QuotesSource } from "../src/guardrails/quotes.js";
import type { GuardrailConfig } from "../src/guardrails/guardrails.js";
import { CryptorefillsApiError, ConversionError, GuardrailError, isDepixSdkError } from "../src/errors.js";
import { TEST_INVOICE } from "./support/boltz.js";

const PASSPHRASE = "correct-horse-battery-staple";
const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// A valid mainnet confidential address (golden addr[1]) — a fundable lockup /
// fee-split target.
const LOCKUP_ADDRESS =
  "lq1qqfk0uw9vlmqlggzs7cxmw49x8ks37l87udspmpt3ssgxjrkqqlww63xvus3c5gaz89r2kd393c4fvurwxf06qj87y2kd3vsln";
const EMAIL = "agent@example.com";

const QUOTES: QuotesSource = { get: async () => ({ btcUsd: 100_000, usdBrl: 5 }) };

const ENABLED_CONFIG: ResolvedGiftcardConfig = {
  enabled: true,
  feeRate: 0.01,
  splitAddress: LOCKUP_ADDRESS,
  countryDefault: "BR"
};

function fakeConfig(cfg: ResolvedGiftcardConfig): GiftcardConfigSource {
  return { getGiftcardConfig: async () => cfg };
}

/** Fake Boltz REST/WS client — the same shape as the boltz-convert tests. */
function fakeBoltzClient(over: Partial<Record<keyof BoltzClient, unknown>> = {}): BoltzClient {
  return {
    getSubmarinePairHash: async () => "pair-hash",
    createSubmarineSwap: async () => ({
      id: "sub-1",
      address: LOCKUP_ADDRESS,
      expectedAmount: 10_000, // 0.0001 L-BTC = R$50 @ (100_000 × 5)
      swapTree: { claimLeaf: {}, refundLeaf: {} },
      claimPublicKey: "03" + "cc".repeat(32),
      blindingKey: "dd".repeat(32),
      timeoutBlockHeight: 1_000_100
    }),
    getChainHeight: async () => 1_000_000,
    getSwapStatus: async () => ({ status: "swap.created" }),
    subscribeSwap: () => () => {},
    ...over
  } as unknown as BoltzClient;
}

interface FakeCryptorefills {
  client: CryptorefillsClient;
  createOrder: ReturnType<typeof vi.fn>;
  validateOrder: ReturnType<typeof vi.fn>;
  listBrands: ReturnType<typeof vi.fn>;
  getOrderStatus: ReturnType<typeof vi.fn>;
}

function fakeCryptorefills(over: {
  order?: CryptorefillsOrder;
  createOrderImpl?: () => Promise<CryptorefillsOrder>;
  brands?: unknown;
  statusOrder?: CryptorefillsOrder;
} = {}): FakeCryptorefills {
  const order = over.order ?? {
    id: "ord-1",
    wallet_address: TEST_INVOICE,
    order_state: "WaitingForPayment",
    payment_state: "WaitingForPayment"
  };
  const createOrder = vi.fn(over.createOrderImpl ?? (async () => order));
  const validateOrder = vi.fn(async () => ({ valid: true }));
  const listBrands = vi.fn(
    async () =>
      over.brands ?? {
        country_code: "BR",
        all_brands: [
          { brand: "Amazon", family: "Amazon", kind: "giftcard", category: "e-commerce" },
          { brand: "Rewarble", family: "Rewarble", kind: "giftcard", category: "e-money" }
        ],
        popular_brands: []
      }
  );
  const getOrderStatus = vi.fn(async () => over.statusOrder ?? { id: "ord-1", order_state: "Done", pin_code: "CODE-42" });
  const client = { createOrder, validateOrder, listBrands, getOrderStatus } as unknown as CryptorefillsClient;
  return { client, createOrder, validateOrder, listBrands, getOrderStatus };
}

let dataDir: string;
let wallet: DepixWallet;

afterEach(async () => {
  await wallet?.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
});

async function restore(opts: {
  config?: ResolvedGiftcardConfig;
  cryptorefills?: FakeCryptorefills;
  guardrails?: GuardrailConfig;
  quotes?: QuotesSource;
  boltzClient?: BoltzClient;
} = {}): Promise<{ wallet: DepixWallet; cr: FakeCryptorefills }> {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-giftcards-"));
  const cr = opts.cryptorefills ?? fakeCryptorefills();
  wallet = await DepixWallet.restore({
    dataDir,
    passphrase: PASSPHRASE,
    mnemonic: KNOWN_MNEMONIC,
    quotes: opts.quotes ?? QUOTES,
    ...(opts.guardrails ? { guardrails: opts.guardrails } : {}),
    boltz: { client: opts.boltzClient ?? fakeBoltzClient(), verifyLockup: vi.fn(async () => {}) },
    giftcards: { config: fakeConfig(opts.config ?? ENABLED_CONFIG), cryptorefills: cr.client }
  });
  return { wallet, cr };
}

const buyParams = { brandName: "Amazon", denomination: "50", email: EMAIL };

describe("gift cards — config gate (§5.5)", () => {
  it("buy() throws GIFTCARDS_DISABLED when giftcardEnabled is off (before any order)", async () => {
    const { wallet: w, cr } = await restore({ config: { ...ENABLED_CONFIG, enabled: false } });
    await expect(w.giftcards.buy(buyParams)).rejects.toSatisfy((e: unknown) =>
      isDepixSdkError(e, "GIFTCARDS_DISABLED")
    );
    expect(cr.createOrder).not.toHaveBeenCalled();
  });

  it("list() throws GIFTCARDS_DISABLED when off", async () => {
    const { wallet: w } = await restore({ config: { ...ENABLED_CONFIG, enabled: false } });
    await expect(w.giftcards.list()).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "GIFTCARDS_DISABLED"));
  });
});

describe("gift cards — KYC (e-money) category is not sellable (§5.5)", () => {
  it("buy() rejects an e-money brand with GIFTCARD_KYC_CATEGORY + external deep-link", async () => {
    const { wallet: w, cr } = await restore();
    let caught: unknown;
    try {
      await w.giftcards.buy({ ...buyParams, brand: { family: "Rewarble", category: "e-money" } });
    } catch (e) {
      caught = e;
    }
    expect(isDepixSdkError(caught, "GIFTCARD_KYC_CATEGORY")).toBe(true);
    expect((caught as ConversionError).details?.externalUrl).toContain("cryptorefills.com");
    expect(cr.createOrder).not.toHaveBeenCalled(); // gated BEFORE ordering
  });

  it("maps a CryptoRefills 422 LOGIN_REQUIRED to GIFTCARD_KYC_CATEGORY", async () => {
    const cr = fakeCryptorefills({
      createOrderImpl: async () => {
        throw new CryptorefillsApiError("login required", { status: 422, body: { detail: "LOGIN_REQUIRED" } });
      }
    });
    const { wallet: w } = await restore({ cryptorefills: cr });
    await expect(w.giftcards.buy(buyParams)).rejects.toSatisfy((e: unknown) =>
      isDepixSdkError(e, "GIFTCARD_KYC_CATEGORY")
    );
  });
});

describe("gift cards — DUAL-CLASS allowlist: Lightning payee AND beneficiary (§4.3)", () => {
  it("BLOCKS with class 'lightning' when allowLightning is not opted in", async () => {
    const { wallet: w } = await restore({
      guardrails: { allowlist: { enabled: true, allowLightning: false, giftcardBeneficiaries: [EMAIL] } }
    });
    let caught: unknown;
    try {
      await w.giftcards.buy(buyParams);
    } catch (e) {
      caught = e;
    }
    expect(isDepixSdkError(caught, "GUARDRAIL_ALLOWLIST_BLOCKED")).toBe(true);
    expect((caught as GuardrailError).details?.class).toBe("lightning");
  });

  it("BLOCKS with class 'giftcardBeneficiary' when the beneficiary is not allowlisted", async () => {
    const { wallet: w } = await restore({
      // Lightning IS opted in, but the beneficiary_account is NOT in the list.
      guardrails: { allowlist: { enabled: true, allowLightning: true, giftcardBeneficiaries: [] } }
    });
    let caught: unknown;
    try {
      await w.giftcards.buy(buyParams);
    } catch (e) {
      caught = e;
    }
    expect(isDepixSdkError(caught, "GUARDRAIL_ALLOWLIST_BLOCKED")).toBe(true);
    expect((caught as GuardrailError).details?.class).toBe("giftcardBeneficiary");
  });

  it("PASSES the allowlist when BOTH classes are opted in (then fails at build for lack of funds)", async () => {
    const { wallet: w } = await restore({
      guardrails: { allowlist: { enabled: true, allowLightning: true, giftcardBeneficiaries: [EMAIL] } }
    });
    // Both classes cleared → the guardrail lets it through; the empty wallet then
    // fails to build the lockup (INSUFFICIENT_FUNDS), proving the flow reached the
    // sign step with both classes satisfied.
    await expect(w.giftcards.buy(buyParams)).rejects.toSatisfy((e: unknown) =>
      isDepixSdkError(e, "INSUFFICIENT_FUNDS")
    );
  });
});

describe("gift cards — guardrail counts the expectedAmount in BRL (§4.3)", () => {
  it("BLOCKS with GUARDRAIL_PER_TX_LIMIT when the L-BTC lockup valued in BRL exceeds the cap", async () => {
    const { wallet: w, cr } = await restore({ guardrails: { perTxLimitBrlCents: 1_000 } }); // R$10 cap
    let caught: unknown;
    try {
      await w.giftcards.buy(buyParams);
    } catch (e) {
      caught = e;
    }
    expect(isDepixSdkError(caught, "GUARDRAIL_PER_TX_LIMIT")).toBe(true);
    // expectedAmount 10_000 sats × 100_000 × 5 = R$50.
    expect((caught as GuardrailError).details?.attemptedCents).toBe(5_000);
    // The order was created + tracked before the guardrail blocked the payment.
    expect(cr.createOrder).toHaveBeenCalledTimes(1);
    const orders = await w.giftcards.listOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ orderId: "ord-1", phase: "awaiting_payment", feeSats: "2500", swapId: "" });
  });
});

describe("gift cards — order body + tracking (§5.5)", () => {
  it("posts a Lightning order with the beneficiary + runs the pre-flight validation", async () => {
    const { wallet: w, cr } = await restore({ guardrails: { perTxLimitBrlCents: 1_000 } });
    await w.giftcards.buy(buyParams).catch(() => {}); // guardrail blocks the payment; the order still posted
    expect(cr.validateOrder).toHaveBeenCalledTimes(1);
    const body = cr.createOrder.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toMatchObject({ payment: { payment_via: "USER_WALLET", coin: "BTC", network: "Lightning" } });
    const deliveries = body.deliveries as Array<Record<string, unknown>>;
    expect(deliveries[0]).toMatchObject({ brand_name: "Amazon", denomination: "50", beneficiary_account: EMAIL });
  });

  it("can skip the pre-flight validation with validate:false", async () => {
    const { wallet: w, cr } = await restore({ guardrails: { perTxLimitBrlCents: 1_000 } });
    await w.giftcards.buy({ ...buyParams, validate: false }).catch(() => {});
    expect(cr.validateOrder).not.toHaveBeenCalled();
    expect(cr.createOrder).toHaveBeenCalledTimes(1);
  });
});

describe("gift cards — list() + getOrderStatus() (§5.5)", () => {
  it("list() returns the fulfillable catalog, filtered", async () => {
    const { wallet: w } = await restore();
    const cat = await w.giftcards.list({ query: "amaz" });
    expect(cat.countryCode).toBe("BR");
    expect(cat.brands.map((b) => b.brand)).toEqual(["Amazon"]);
    expect(cat.categories).toContain("e-commerce");
  });

  it("getOrderStatus() polls CryptoRefills, maps the phase, and folds it into the log", async () => {
    const { wallet: w } = await restore({ guardrails: { perTxLimitBrlCents: 1_000 } });
    await w.giftcards.buy(buyParams).catch(() => {}); // seeds the order log
    const phase = await w.giftcards.getOrderStatus("ord-1");
    expect(phase).toMatchObject({ phase: "delivered", terminal: true, delivery: { kind: "code", value: "CODE-42" } });
    expect((await w.giftcards.listOrders())[0]?.phase).toBe("delivered");
  });
});
