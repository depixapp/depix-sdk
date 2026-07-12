// Tool input/output schemas for the local wallet MCP facade (spec §6.2).
//
// Two disciplines are load-bearing here:
//   1. UNITS ARE IN THE FIELD NAME. Never a bare `amount`. BRL flows use
//      `amount_cents` (integer BRL cents); on-chain sends/conversions use
//      `amount_sats` (the asset's BASE UNITS). 1 DePix cent = 1,000,000 sats
//      (§3.2.5) — a unit slip by an LLM is catastrophic, so the ambiguity is
//      removed at the schema level, echoed in every description.
//   2. TAX DOCUMENTS ARE DISAMBIGUATED. The deposit `payer_tax_number` (the
//      OWNER paying the QR) and the withdraw `recipient_tax_number` (the HOLDER
//      of the destination Pix key) are DIFFERENT people (§2.3); each description
//      says whose document it is so an LLM cannot reuse the owner's CPF on a
//      third-party payout.
//
// Schemas are exported as ZodRawShape (plain objects of zod fields) — the shape
// `registerTool` expects. Shared fields are built by FACTORIES so every schema
// gets a fresh zod instance: reusing one instance across fields makes the JSON
// Schema converter emit a `$ref`, which some hosts will not resolve (depix-mcp
// lesson, mirrored by the no-$ref test).

import { z } from "zod";

/** Hard ceiling for a wait tool's `timeout_seconds` (§6.2d). */
export const MAX_WAIT_SECONDS_CEILING = 900;
/** Default `timeout_seconds` for the wait tools (§6.2d). */
export const DEFAULT_WAIT_SECONDS = 300;
/** Default poll spacing (guidance 5–15s, §3.4). */
export const DEFAULT_POLL_INTERVAL_SECONDS = 5;
/** Floor poll spacing — never poll faster than the shared 30/min read budget likes (§3.4). */
export const MIN_POLL_INTERVAL_SECONDS = 3;

/** The three Liquid assets the wallet can send (spec §2.3). */
export const SEND_ASSETS = ["DEPIX", "LBTC", "USDT"] as const;

/** Default wait for the first SideSwap quote tick (frontend arms ~20s, §5.1). */
export const SWAP_QUOTE_DEFAULT_WAIT_SECONDS = 20;
/** Hard ceiling for wallet_swap_quote's wait — quotes are fast; a long wait leaks a socket. */
export const SWAP_QUOTE_MAX_WAIT_SECONDS = 60;

/** Stablecoins Boltz can deliver (mirror of stablecoin.ts StablecoinAsset — parity test). */
export const STABLECOIN_ASSETS = ["USDC", "USDT"] as const;
/** Boltz stablecoin target networks (mirror of BOLTZ_STABLECOIN_NETWORKS ids — parity test). */
export const STABLECOIN_NETWORK_IDS = [
  "polygon",
  "ethereum",
  "arbitrum",
  "optimism",
  "base",
  "tron",
] as const;

// ── shared field factories (fresh instance per call → no $ref) ──
const amountCentsField = () =>
  z
    .number()
    .int()
    .positive()
    .describe(
      "Amount in BRL CENTS (integer). e.g. 1000 = R$10.00. DePix is pegged 1:1 to BRL. NOT sats.",
    );

const amountSatsField = () =>
  z
    .string()
    .regex(/^\d+$/, "amount_sats must be a non-negative integer string of base units (sats)")
    .describe(
      "Amount in the asset's BASE UNITS (sats), as a decimal integer STRING. " +
        "1 DePix cent = 1,000,000 sats. Never pass a BRL value here.",
    );

const liquidAddressField = () =>
  z.string().min(1).describe("Destination Liquid address (lq1…/ex1…/VJL…/Q…).");

const payerTaxNumberField = () =>
  z
    .string()
    .min(1)
    .describe(
      "CPF/CNPJ of the OWNER who will pay the Pix QR (the payer). It is the human funding " +
        "the deposit — not necessarily the wallet holder.",
    );

const recipientTaxNumberField = () =>
  z
    .string()
    .min(1)
    .describe(
      "CPF/CNPJ of the HOLDER of the DESTINATION Pix key (the person receiving the payout). " +
        "This is a DIFFERENT person from a deposit's payer — do not reuse the payer's document.",
    );

const idField = (what: string) =>
  z.string().min(1).describe(`The ${what} id returned by the matching create tool.`);

// ── inputs (ZodRawShape) ──
export const statusInput = {} as const;
export const getBalancesInput = {} as const;
export const listTransactionsInput = {} as const;
export const getGuardrailsInput = {} as const;

export const getAddressInput = {
  index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Advanced: derive a specific descriptor index. Omit for a FRESH, unused receive address " +
        "(recommended — the SDK guarantees no on-chain reuse across calls).",
    ),
} as const;

export const sendInput = {
  asset: z.enum(SEND_ASSETS).describe("Which Liquid asset to send: DEPIX, LBTC (L-BTC) or USDT (USDt)."),
  amount_sats: amountSatsField(),
  address: liquidAddressField(),
} as const;

export const createDepositInput = {
  amount_cents: amountCentsField(),
  payer_tax_number: payerTaxNumberField(),
} as const;

export const createWithdrawalInput = {
  pix_key: z.string().min(1).describe("Destination Pix key (CPF/CNPJ, email, phone, or random/EVP key)."),
  recipient_tax_number: recipientTaxNumberField(),
  amount_cents: amountCentsField(),
  mode: z
    .enum(["send", "payout"])
    .describe(
      "`send` = amount_cents is the DePix you SEND from the wallet (deposit side). " +
        "`payout` = amount_cents is the BRL the recipient RECEIVES on Pix (payout side).",
    ),
} as const;

/** Wait-tool input, ceiling-bound (§6.2d). Factory so the ceiling is configurable. */
export const waitInput = (maxWaitSeconds: number = MAX_WAIT_SECONDS_CEILING) =>
  ({
    id: idField("deposit/withdrawal"),
    interval_seconds: z
      .number()
      .int()
      .min(MIN_POLL_INTERVAL_SECONDS)
      .max(60)
      .optional()
      .describe(
        `Poll spacing in seconds (default ${DEFAULT_POLL_INTERVAL_SECONDS}, min ${MIN_POLL_INTERVAL_SECONDS}).`,
      ),
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .max(maxWaitSeconds)
      .optional()
      .describe(
        `Give up after this many seconds (default ${DEFAULT_WAIT_SECONDS}, hard ceiling ${maxWaitSeconds}).`,
      ),
  }) as const;

// ── outputs (ZodRawShape) ──
const guardrailBudget = () =>
  z.object({
    used_cents: z.number().int().describe("BRL cents committed in the rolling 24h window."),
    daily_limit_cents: z.number().int().describe("Owner-set rolling-24h cap in BRL cents (§4.2)."),
    per_tx_limit_cents: z.number().int().describe("Owner-set per-transaction cap in BRL cents (§4.2)."),
    remaining_cents: z.number().int().describe("daily_limit_cents − used_cents (never negative)."),
    allowlist_enabled: z.boolean().describe("Whether the owner turned the destination allowlist on (§4.3)."),
  });

/** Withdrawals crash-resume counters (§3.2.9) — shared by wallet_status and wallet_recover. */
const withdrawalsResumeSummary = () =>
  z.object({
    resumed: z.number().int(),
    rebroadcast: z.number().int(),
    reposted: z.number().int(),
    discarded: z.number().int(),
    failed: z.number().int(),
  });

/** Boltz conversion-resume counters (§5.3) — nullable: a view-only wallet has no Boltz rail. */
const boltzResumeSummary = () =>
  z.object({
    submarine_resumed: z.number().int(),
    submarine_refunded: z.number().int(),
    reverse_resumed: z.number().int(),
    stablecoin_resumed: z.number().int(),
    stablecoin_refunded: z.number().int(),
    discarded: z.number().int(),
    removed: z.number().int(),
    failed: z.number().int(),
  });

const peginResumeSummary = () =>
  z.object({
    pending: z.number().int().describe("In-flight peg-ins still tracked after reconciliation."),
    cleared: z.number().int().describe("Tracked peg-ins SideSwap reported Done — cleared."),
    failed: z.number().int().describe("Reconciliation attempts that failed (kept for the next resume)."),
  });

const sideshiftResumeSummary = () =>
  z.object({
    checked: z.number().int().describe("Non-terminal tracked shifts found in the local log."),
    refreshed: z.number().int().describe("Shifts whose status was refreshed from SideShift."),
    failed: z.number().int().describe("Status refreshes that failed (kept for the next resume)."),
  });

const plansResumeSummary = () =>
  z.object({
    checked: z.number().int().describe("In-flight multi-hop conversion plans found in the store."),
    advanced: z.number().int().describe("Plans that executed at least one leg this pass (from the last completed leg)."),
    completed: z.number().int().describe("Plans that reached a terminal outcome and were removed."),
    needs_review: z
      .number()
      .int()
      .describe("Plans parked for manual completion (recovery would have to guess) — see wallet_pending notes."),
    discarded: z.number().int().describe("Tampered plan records discarded (GCM auth failure) — never acted upon."),
    failed: z.number().int().describe("Probe/execution failures — plan kept for the next resume."),
  });

/** Conversion recovery summary (§5) — shared by wallet_status and wallet_recover. */
const conversionResumeSummary = () =>
  z.object({
    boltz: boltzResumeSummary()
      .nullable()
      .describe("Boltz swap reconciliation counters, or null when the wallet has no seed (no Boltz rail)."),
    pegin: peginResumeSummary(),
    sideshift: sideshiftResumeSummary(),
    plans: plansResumeSummary().describe("Multi-hop conversion plans resumed from the last completed leg (PR-C)."),
  });

export const statusOutput = {
  mode: z
    .enum(["live", "test", "unknown"])
    .describe("Key mode, derived LOCALLY from the sk_live_/sk_test_ prefix — no API call (§6.2)."),
  api_key_configured: z.boolean().describe("Whether an API key is set (deposit/withdraw need one)."),
  backup_confirmed: z.boolean().describe("Whether the seed backup was confirmed — receive is gated until true (§2.9)."),
  guardrails: guardrailBudget(),
  pending_withdrawals: withdrawalsResumeSummary().describe(
    "Crash-recovery summary from boot (§3.2.9): auto-resumed/re-broadcast/discarded records.",
  ),
  pending_conversions: conversionResumeSummary().describe(
    "Conversion crash-recovery summary from boot (§5): Boltz swaps reconciled, peg-in reconciled, SideShift shifts refreshed.",
  ),
} as const;

export const getAddressOutput = {
  address: z.string().describe("A fresh, unused Liquid receive address for this wallet."),
} as const;

export const getBalancesOutput = {
  balances: z
    .object({
      depix_sats: z.string().describe("DePix balance in base units (sats), as a decimal string."),
      lbtc_sats: z.string().describe("L-BTC balance in base units (sats)."),
      usdt_sats: z.string().describe("USDt balance in base units (sats)."),
    })
    .describe("Confirmed on-chain balances per asset, in base units."),
  brl_estimate_cents: z
    .number()
    .int()
    .nullable()
    .describe("Total BRL-cent estimate across assets, or null if a needed quote is unavailable (§4.4)."),
} as const;

export const listTransactionsOutput = {
  transactions: z
    .array(
      z.object({
        txid: z.string(),
        height: z.number().int().nullable(),
        timestamp: z.number().int().nullable(),
        type: z.string(),
        fee_sats: z.string(),
        balance: z.record(z.string(), z.string()).describe("Net balance delta per asset, base units (signed string)."),
      }),
    )
    .describe("Wallet transaction history, newest-first as LWK returns it."),
} as const;

export const sendOutput = {
  txid: z.string().describe("The broadcast Liquid transaction id."),
} as const;

export const createDepositOutput = {
  id: z.string().describe("Deposit id — pass it to wallet_wait_deposit."),
  qr_copy_paste: z.string().describe("The Pix copy-and-paste (BR Code) the human OWNER pays. Never a checkout QR."),
  sandbox: z.boolean().optional().describe("true when this is a sandbox (sk_test_) deposit — DO NOT pay it."),
} as const;

export const createWithdrawalOutput = {
  withdrawal_id: z.string().describe("Withdrawal id — pass it to wallet_wait_withdrawal."),
  txid: z.string().nullable().describe("Broadcast Liquid txid (null only in sandbox)."),
  fee_cents: z.number().int().nullable().describe("Service fee in BRL cents (null on the no-fee branch, §3.2.2)."),
  fee_address: z.string().nullable().describe("Explicit (ex1) fee address, or null on the no-fee branch."),
  net_cents: z.number().int().describe("NET BRL cents delivered to the payout provider."),
  gross_cents: z.number().int().describe("GROSS BRL cents leaving the wallet (net + fee)."),
  payout_cents: z.number().int().describe("BRL cents the recipient receives on Pix."),
  sandbox: z.boolean().optional().describe("true when this is a sandbox withdrawal — no on-chain leg ran."),
} as const;

/** Status-read shape (§3.4). External API payload — id/status always present, the rest optional. */
export const statusReadOutput = {
  id: z.string(),
  type: z.string().optional(),
  amount_cents: z.number().int().nullable().optional(),
  status: z.string(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  rejection_reasons: z.array(z.string()).optional(),
  liquid_txid: z.string().optional(),
  sandbox: z.boolean().optional(),
} as const;

export const getGuardrailsOutput = { ...guardrailBudget().shape } as const;

// ── fast-follow: conversions + gift cards (spec §6.2 fast-follow, §5) ─────────
//
// Same two disciplines as the MVP tools: units live in the field name
// (amount_sats = the asset's BASE UNITS) and every provider that takes funds
// OUT of the non-custodial sphere says so in its description. SideShift
// (wallet_shift_usdt, §5.4/G4) is the ONE CUSTODIAL flow — its description says so
// explicitly (G4 = documentation-signalled, no blocking gate).

/** SideShift SEND target networks (mirror of USDT_NETWORKS shiftable ids — parity test). */
export const SHIFT_NETWORK_IDS = ["ethereum", "tron", "bsc", "polygon", "solana"] as const;

const swapAssetField = () =>
  z.enum(SEND_ASSETS).describe("A Liquid asset: DEPIX (BRL-pegged), LBTC (L-BTC) or USDT (USDt).");

// ── inputs ──
export const swapQuoteInput = {
  from: swapAssetField(),
  to: swapAssetField(),
  amount_sats: amountSatsField(),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(SWAP_QUOTE_MAX_WAIT_SECONDS)
    .optional()
    .describe(
      `How long to wait for the first quote tick, in seconds (default ${SWAP_QUOTE_DEFAULT_WAIT_SECONDS}, ` +
        `hard ceiling ${SWAP_QUOTE_MAX_WAIT_SECONDS}).`,
    ),
} as const;

export const swapExecuteInput = {
  swap_quote_id: z
    .string()
    .min(1)
    .describe("The swap_quote_id returned by wallet_swap_quote. Single-use; execute before it expires."),
} as const;

export const payLightningInvoiceInput = {
  invoice: z
    .string()
    .min(1)
    .describe("A BOLT11 Lightning invoice (bolt11 / lnbc…). Must carry an amount — zero-amount invoices are rejected."),
} as const;

export const receiveLightningInput = {
  amount_sats: amountSatsField(),
} as const;

export const toStablecoinInput = {
  asset: z.enum(STABLECOIN_ASSETS).describe("Which stablecoin to receive: USDC or USDT."),
  network_id: z
    .enum(STABLECOIN_NETWORK_IDS)
    .describe(
      "Destination network for the stablecoin. EVM: polygon, ethereum, arbitrum, optimism, base. " +
        "Tron (TRC-20): tron (USDT only). USDC is not available on tron; USDC is not on base for USDT.",
    ),
  amount_sats: amountSatsField(),
  claim_address: z
    .string()
    .min(1)
    .describe(
      "FINAL recipient address the stablecoin is delivered to: a 0x… EVM address, or a T… Tron (TRC-20) " +
        "address for network_id=tron. Checked against the destination allowlist when it is enabled (§4.3).",
    ),
} as const;

export const buyGiftcardInput = {
  brand_name: z.string().min(1).describe("Brand/family name from wallet_list… (e.g. \"Amazon\", \"Netflix\")."),
  denomination: z
    .string()
    .min(1)
    .describe("The face value/product to buy (exact denomination for fixed products, or \"range\" for dynamic ones)."),
  email: z
    .string()
    .min(1)
    .describe("Delivery email — also the CryptoRefills beneficiary_account (checked against the allowlist, §4.3)."),
  beneficiary_account: z
    .string()
    .min(1)
    .optional()
    .describe("Delivery target override: an email for gift cards, or an E.164 phone for mobile top-ups."),
  country_code: z.string().min(2).max(2).optional().describe("ISO 3166-1 alpha-2 (e.g. BR). Defaults to the shop config."),
  product_value: z.string().min(1).optional().describe("For dynamic (range) products: the chosen face value."),
  quantity: z.number().int().min(1).max(10).optional().describe("Number of identical deliveries, 1–10 (default 1)."),
  validate: z
    .boolean()
    .optional()
    .describe("Run the CryptoRefills pre-flight validation before ordering (default true)."),
} as const;

export const listGiftcardOrdersInput = {} as const;

export const shiftUsdtInput = {
  network: z
    .enum(SHIFT_NETWORK_IDS)
    .describe(
      "Target network to send USDt to: ethereum, tron (TRC-20), bsc (BEP-20), polygon, or solana (SPL). " +
        "A Liquid→Liquid USDt move needs no shift — use wallet_send for that.",
    ),
  amount_sats: amountSatsField(),
  settle_address: z
    .string()
    .min(1)
    .describe(
      "FINAL destination address on `network` (0x… for EVM, T… for Tron, base58 for Solana). " +
        "Checked against the destination allowlist when it is enabled (§4.3).",
    ),
  refund_address: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional Liquid address SideShift refunds the USDt to if the shift fails. Checked against " +
        "allowlist.sideshiftRefundAddresses when the allowlist is enabled (§4.3).",
    ),
} as const;

// ── outputs ──
export const swapQuoteOutput = {
  swap_quote_id: z
    .string()
    .describe("Single-use handle — pass to wallet_swap_execute BEFORE expires_at_ms. Bound to a live quote socket."),
  from: z.string().describe("The asset being sold."),
  to: z.string().describe("The asset being bought."),
  send_amount_sats: z.string().describe("Base units of `from` that will LEAVE the wallet (dealer-quoted send side)."),
  recv_amount_sats: z.string().describe("Base units of `to` that will be RECEIVED (validated against the PSET on execute)."),
  server_fee_sats: z.string().describe("SideSwap server fee, base units."),
  fixed_fee_sats: z.string().describe("SideSwap fixed (network) fee, base units."),
  fee_asset: z.string().nullable().describe("Liquid asset id the fee is charged in, or null."),
  ttl_ms: z.number().int().describe("Quote time-to-live in milliseconds from issuance."),
  expires_at_ms: z
    .number()
    .int()
    .describe("Absolute epoch-ms deadline; wallet_swap_execute refuses within a few seconds of it."),
} as const;

export const swapExecuteOutput = {
  txid: z.string().describe("The broadcast Liquid swap transaction id."),
  from: z.string().describe("The asset sold."),
  to: z.string().describe("The asset bought."),
  send_amount_sats: z.string().describe("Base units of `from` that left the wallet."),
  recv_amount_sats: z.string().describe("Base units of `to` received."),
  brl_cents: z.number().int().describe("The SENT side valued in BRL cents — what was counted against the guardrail (§4.3)."),
} as const;

export const payLightningInvoiceOutput = {
  swap_id: z.string().describe("Boltz submarine swap id — track it, and used for refund on failure."),
  lockup_txid: z.string().describe("The broadcast L-BTC lockup transaction id."),
  expected_amount_sats: z.number().int().describe("L-BTC locked for the swap (base units)."),
  invoice_sats: z.number().int().describe("The decoded BOLT11 amount (sats)."),
  invoice: z.string().describe("The BOLT11 invoice that was paid."),
} as const;

export const receiveLightningOutput = {
  swap_id: z.string().describe("Boltz reverse swap id."),
  invoice: z.string().describe("The BOLT11 invoice for the PAYER to pay. Once paid, the L-BTC is claimed into this wallet."),
  lockup_address: z.string().describe("The Liquid lockup address Boltz will fund."),
  amount_sats: z.string().describe("L-BTC to be received into the wallet (base units)."),
} as const;

export const toStablecoinOutput = {
  swap_id: z.string().describe("Boltz chain-swap id."),
  lockup_txid: z.string().describe("The broadcast L-BTC lockup transaction id."),
  lock_amount_sats: z.number().int().describe("L-BTC locked for the swap (base units)."),
  asset: z.string().describe("The stablecoin being delivered (USDC/USDT)."),
  network_id: z.string().describe("The destination network."),
  claim_address: z.string().describe("The FINAL recipient address the stablecoin is delivered to."),
} as const;

// Fresh zod instance per use — a shared const would be emitted as a JSON-Schema
// $ref when referenced by more than one field (the catalog test forbids $ref).
/** A redemption delivery (the code/URL the buyer redeems), or null until delivered. */
const giftcardDelivery = () =>
  z
    .object({
      kind: z
        .enum(["url", "code", "none"])
        .describe("url = visit the link; code = enter the code; none = not delivered yet."),
      value: z.string().nullable().describe("The redemption code or URL; null until delivered."),
    })
    .nullable();

export const buyGiftcardOutput = {
  order_id: z.string().describe("CryptoRefills order id — poll wallet_get_giftcard_order_status to track it + read delivery."),
  invoice: z.string().describe("The BOLT11 invoice that was paid for the order."),
  swap_id: z.string().describe("Boltz submarine swap id for the Lightning payment."),
  lockup_txid: z.string().describe("The broadcast L-BTC lockup transaction id."),
  invoice_sats: z.number().int().describe("The decoded BOLT11 amount (sats)."),
  fee_sats: z.string().describe("The 1% DePix service fee (base units, as a string)."),
  expected_amount_sats: z.number().int().describe("L-BTC the Boltz lockup locked (base units)."),
  total_sats: z.string().describe("expected_amount + fee — L-BTC leaving the wallet, network fee excluded (base units)."),
  beneficiary_account: z.string().describe("The resolved delivery target (email or phone)."),
} as const;

export const listGiftcardOrdersOutput = {
  orders: z
    .array(
      z.object({
        order_id: z.string(),
        brand_name: z.string(),
        denomination: z.string(),
        beneficiary_account: z.string(),
        invoice_sats: z.number().int(),
        fee_sats: z.string().describe("Service fee in base units, as a string."),
        expected_amount_sats: z.number().int(),
        swap_id: z.string(),
        lockup_txid: z.string().optional(),
        phase: z.string().describe("Last-known CryptoRefills order phase."),
        delivery: giftcardDelivery()
          .optional()
          .describe("Persisted redemption code/URL (null until delivered; absent on legacy records)."),
        created_at: z.number().int(),
        updated_at: z.number().int(),
      }),
    )
    .describe("Locally tracked gift-card orders, newest first."),
} as const;

export const listGiftcardsInput = {
  country_code: z
    .string()
    .min(2)
    .max(2)
    .optional()
    .describe("ISO 3166-1 alpha-2 (e.g. BR). Defaults to the shop config country."),
  query: z.string().optional().describe("Filter by brand/family name (case- + accent-insensitive)."),
  category: z.string().optional().describe("Filter by category key (e.g. \"streaming\")."),
} as const;

const giftcardBrand = () =>
  z.object({
    brand: z.string().optional(),
    family: z.string().optional(),
    kind: z.string().optional().describe("giftcard | mobile_recharge."),
    category: z.string().optional(),
    is_out_of_stock: z.boolean().describe("In-stock brands sort first; out-of-stock last (kept, not removed)."),
  });

export const listGiftcardsOutput = {
  country_code: z.string(),
  brands: z
    .array(giftcardBrand())
    .describe("Fulfillable brands (gift cards + mobile recharge), filtered, in-stock first."),
  popular_brands: z.array(giftcardBrand()).describe("The operator's popular picks for the country."),
  categories: z.array(z.string()).describe("Distinct category keys for further filtering."),
} as const;

export const listGiftcardProductsInput = {
  brand_name: z.string().min(1).describe("Brand/family name from wallet_list_giftcards (e.g. \"Amazon\")."),
  country_code: z.string().min(2).max(2).optional().describe("ISO 3166-1 alpha-2. Defaults to the shop config country."),
} as const;

const giftcardProductShape = z.object({
  denomination: z
    .string()
    .describe("Pass this exact string to wallet_buy_giftcard for a FIXED product; \"range\" for a dynamic one."),
  label: z.string().describe("Human label (localized denomination)."),
  is_dynamic: z
    .boolean()
    .describe("true = custom-value (range) product: buy with denomination \"range\" + product_value within min..max."),
  price_sats: z
    .number()
    .int()
    .nullable()
    .describe("BTC cost in sats for a FIXED product; null for a range product (quote it with wallet_giftcard_price)."),
  currency: z.string().nullable().describe("Fiat currency code of the face value (e.g. BRL)."),
  min: z.number().nullable().describe("Range lower bound (fiat) for a dynamic product."),
  max: z.number().nullable().describe("Range upper bound (fiat) for a dynamic product."),
});

export const listGiftcardProductsOutput = {
  products: z
    .array(giftcardProductShape)
    .describe("The brand's products/denominations — FIXED (pick a denomination) AND range (pick a value in min..max)."),
} as const;

export const giftcardPriceInput = {
  brand_name: z.string().min(1).describe("Brand/family name of a RANGE (dynamic) product."),
  country_code: z.string().min(2).max(2).optional().describe("ISO 3166-1 alpha-2. Defaults to the shop config country."),
  face_value: z
    .union([z.string(), z.number()])
    .describe("The custom face value to quote (within the product's min..max), in the product's fiat currency."),
} as const;

export const giftcardPriceOutput = {
  price_sats: z.number().int().describe("BTC cost in sats for the requested custom value."),
  currency: z.string().nullable().describe("Fiat currency code, when the price response carries it (else null)."),
} as const;

export const getGiftcardOrderStatusInput = {
  order_id: z.string().min(1).describe("The CryptoRefills order id (from wallet_buy_giftcard)."),
} as const;

export const getGiftcardOrderStatusOutput = {
  phase: z.string().describe("delivered | expired | canceled | manual | paid | awaiting_payment."),
  terminal: z.boolean().describe("true when the order reached a final state (stop polling)."),
  delivery: giftcardDelivery().describe("The redemption code/URL once delivered; null otherwise."),
} as const;

// ── intent layer: wallet_quote + wallet_convert (PR-B/PR-C — the PRIMARY
// conversion surface). Same disciplines: amount_sats = the FROM asset's BASE
// UNITS; custody is per-route, SIGNALLED in the output (custodial flag), never
// gated (G4). ──

/** Assets the intent layer routes between (mirror of routes.ts IntentAsset). */
export const INTENT_ASSETS = ["DEPIX", "USDT", "LBTC", "BTC", "USDC"] as const;
/** Networks an intent can source from / deliver to (mirror of routes.ts IntentNetwork). */
export const INTENT_NETWORK_IDS = [
  "liquid",
  "bitcoin",
  "lightning",
  "ethereum",
  "polygon",
  "arbitrum",
  "optimism",
  "base",
  "tron",
  "bsc",
  "solana",
] as const;

const intentAssetField = (what: string) => z.enum(INTENT_ASSETS).describe(what);

const intentTrioFields = () =>
  ({
    from: intentAssetField("Asset to convert FROM: DEPIX, USDT, LBTC (L-BTC), BTC or USDC."),
    to: intentAssetField("Asset to convert TO: DEPIX, USDT, LBTC (L-BTC), BTC or USDC."),
    network: z
      .enum(INTENT_NETWORK_IDS)
      .optional()
      .describe(
        "DESTINATION network of `to` (default liquid). e.g. lightning for a BOLT11 payout, " +
          "ethereum/tron/… for an external stablecoin delivery.",
      ),
    from_network: z
      .enum(INTENT_NETWORK_IDS)
      .optional()
      .describe(
        "ORIGIN network of `from`. Liquid assets default to liquid (this wallet's holdings); " +
          "set it for external inflows (BTC: bitcoin | lightning; inbound USDT: its source network).",
      ),
    amount_sats: amountSatsField(),
  }) as const;

export const walletQuoteInput = { ...intentTrioFields() } as const;

export const walletConvertInput = {
  ...intentTrioFields(),
  route: z
    .string()
    .min(1)
    .optional()
    .describe(
      "A route id from wallet_quote. REQUIRED when more than one candidate route resolves the intent " +
        "(the SDK never chooses for you — MULTIPLE_ROUTES_AVAILABLE lists the candidates).",
    ),
  address: z
    .string()
    .min(1)
    .optional()
    .describe(
      "FINAL destination address for outbound cross-network routes (peg-out BTC address, EVM/Tron " +
        "stablecoin address, SideShift settle address). Checked against the allowlist when it is ON (§4.3).",
    ),
  invoice: z
    .string()
    .min(1)
    .optional()
    .describe(
      "BOLT11 invoice — the destination of an LBTC → BTC@lightning conversion (its embedded amount " +
        "governs; amount_sats is used only for quoting).",
    ),
  refund_address: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional Liquid refund address for SideShift send routes. Checked against the allowlist when it is ON.",
    ),
  wait: z
    .boolean()
    .optional()
    .describe(
      "Wait for settlement (default true). Inflow routes return funding details immediately either way; " +
        "with wait:false outbound routes return status pending right after the first broadcast.",
    ),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_WAIT_SECONDS_CEILING)
    .optional()
    .describe(
      `Settlement wait bound in seconds (hard ceiling ${MAX_WAIT_SECONDS_CEILING}). On timeout the result is ` +
        "status pending with a next_step — funds in flight are never an error.",
    ),
} as const;

const routeLegQuoteOutput = () =>
  z.object({
    provider: z.string().describe("Provider executing this leg: sideswap | boltz | sideshift."),
    method: z.string().describe("Provider method (swap, pegIn, pegOut, payLightningInvoice, …)."),
    from: z.string(),
    from_network: z.string(),
    to: z.string(),
    network: z.string(),
    custodial: z.boolean().describe("true only for SideShift legs — funds transit their custody (G4)."),
    estimated_received_sats: z
      .string()
      .nullable()
      .describe("Estimated leg output in 8-decimal base units of `to` (string), or null when unavailable."),
    estimated_fee_sats: z.string().nullable().describe("Estimated leg fee in base units of fee_asset, or null."),
    fee_asset: z.string().nullable().describe("Asset the fee is denominated in, or null when unknown."),
    note: z.string().optional().describe("Why an estimate is missing / any caveat."),
  });

export const walletQuoteOutput = {
  routes: z
    .array(
      z.object({
        id: z.string().describe("Stable route id — pass it to wallet_convert as `route` to execute this candidate."),
        hops: z.number().int().describe("Number of legs (multi-hop routes execute sequentially behind a crash-safe plan)."),
        custodial: z
          .boolean()
          .describe("true iff ANY leg transits a custodial provider (SideShift) — signalled, never gated (G4)."),
        estimated_received_sats: z
          .string()
          .nullable()
          .describe("Final estimated receipt in 8-decimal base units of `to` (string), or null when incomplete."),
        estimated_fee_total_sats: z
          .string()
          .nullable()
          .describe("Sum of leg fees when every leg reported one in the SAME asset; otherwise null."),
        fee_asset: z.string().nullable(),
        estimate_complete: z.boolean().describe("true when every leg produced an estimate (the chain is complete)."),
        notes: z.array(z.string()).describe("Per-leg caveats (missing estimators, mixed fee assets, …)."),
        legs: z.array(routeLegQuoteOutput()),
      }),
    )
    .describe("EVERY candidate route with chained estimates — the agent compares and chooses; the SDK never ranks."),
} as const;

export const walletConvertOutput = {
  route_id: z.string().describe("The executed route's id."),
  hops: z.number().int().describe("Legs in the executed route."),
  custodial: z.boolean().describe("true when the executed route transits a custodial provider (G4, signalled)."),
  status: z
    .enum(["settled", "pending", "awaiting_funding", "refunded", "refund_pending", "failed"])
    .describe(
      "settled = delivered. pending/refund_pending = in flight (see next_step; wallet_recover resumes). " +
        "awaiting_funding = an external party must fund first (see funding). refunded/failed = terminal, nothing delivered.",
    ),
  txids: z.array(z.string()).describe("Every txid the conversion produced so far (lockup/send first, payout/claim after)."),
  received_sats: z
    .string()
    .nullable()
    .describe("ACTUAL receipt in 8-decimal base units of `to` (string) — null until the provider reports delivery."),
  tracking_id: z.string().optional().describe("Provider tracking id (swap id / shift id / peg order id)."),
  funding: z
    .object({
      kind: z.enum(["bitcoin-address", "lightning-invoice", "external-deposit-address"]),
      address: z.string().optional().describe("Address the EXTERNAL party funds (BTC or provider deposit address)."),
      invoice: z.string().optional().describe("BOLT11 invoice for the payer to pay."),
      network: z.string().optional().describe("The network the external funds must be sent on."),
      min: z.string().nullable().optional(),
      max: z.string().nullable().optional(),
      expires_at: z.number().int().nullable().optional().describe("Epoch-ms funding deadline, when the provider sets one."),
    })
    .optional()
    .describe("Funding instructions for INFLOW routes (only with status awaiting_funding)."),
  next_step: z.string().optional().describe("What to do next when the result is not terminal — always actionable (G3)."),
} as const;

// ── recovery wiring: wallet_recover + wallet_pending (fund-safety) ────────────

export const recoverInput = {} as const;
export const pendingInput = {} as const;

// ── maintenance/support: wallet_diagnostics (PR-D) ────────────────────────────

export const diagnosticsInput = {} as const;

export const diagnosticsOutput = {
  sdk_version: z.string().describe("The @depixapp/sdk version this wallet runs."),
  lwk_version: z.string().describe("The exact pinned lwk_node (LWK) version this build ships."),
  data_dir: z.string().describe("The wallet data directory (local path — no key material lives in this snapshot)."),
  backup_confirmed: z.boolean().describe("Whether the seed backup was confirmed (§2.9)."),
  has_seed: z.boolean().describe("false on a view-only/wiped wallet. A boolean only — never the material."),
  api_key_configured: z.boolean().describe("Whether a DePix API key is set (deposit/withdraw need one)."),
  sync: z
    .object({
      last_scan_at: z.number().int().nullable().describe("Epoch-ms of the last completed scan pass, or null."),
      last_success_at: z.number().int().nullable().describe("Epoch-ms of the last scan that also persisted, or null."),
      last_persist_failed_at: z.number().int().nullable().describe("Epoch-ms of the last update-persist failure (§2.5), or null."),
      last_persist_error_name: z.string().nullable().describe("Error NAME of the last failed persist (never a message/path), or null."),
      persisted_updates: z.number().int().describe("Persisted update-chain links on disk."),
      wallet_loaded: z.boolean().describe("Whether the in-memory LWK state is initialized."),
    })
    .describe("Sync health (§2.5 meta): when the wallet last scanned/persisted and whether persistence is failing."),
  pending: z
    .object({
      withdrawals: z.number().int().describe("Pending Pix withdrawals (§3.2.9)."),
      boltz_swaps: z.number().int().describe("In-flight Boltz swaps (§5.3)."),
      pegins: z.number().int().describe("Tracked SideSwap peg-ins (§5.2)."),
      sideshift_shifts: z.number().int().describe("Non-terminal SideShift shifts (§5.4)."),
      plans: z.number().int().describe("In-flight multi-hop conversion plans (PR-C)."),
    })
    .describe("Per-rail pending counters — the wallet_pending tally; use wallet_recover to re-drive them."),
  guardrails: guardrailBudget()
    .nullable()
    .describe("Guardrail config + rolling-24h usage, or null when the readout is unavailable on this wallet."),
} as const;

export const recoverOutput = {
  withdrawals: withdrawalsResumeSummary().describe(
    "Pix withdrawals re-driven (§3.2.9): re-broadcast SAME bytes / re-POST same Idempotency-Key — never a double-pay.",
  ),
  boltz: boltzResumeSummary()
    .nullable()
    .describe("Boltz swaps reconciled (re-attach watch / claim / refund), or null when the wallet has no seed."),
  pegin: peginResumeSummary().describe("Tracked SideSwap peg-in reconciliation (§5.2)."),
  sideshift: sideshiftResumeSummary().describe("Non-terminal SideShift shifts refreshed into the local log (§5.4)."),
  plans: plansResumeSummary().describe(
    "Multi-hop conversion plans resumed from the last completed leg (PR-C) — a started leg is never re-executed.",
  ),
} as const;

export const pendingOutput = {
  pending: z
    .array(
      z.object({
        rail: z
          .enum(["withdrawal", "boltz", "pegin", "sideshift", "plan"])
          .describe("Which rail the item is in flight on ('plan' = a multi-hop conversion plan chaining the others)."),
        id: z
          .string()
          .describe(
            "Rail-scoped id: withdrawal Idempotency-Key, Boltz swap id, SideSwap peg order id, SideShift shift id, or conversion plan id.",
          ),
        state: z.string().describe("Rail-specific state/status string (e.g. requested/signed, locked_up, pending, waiting)."),
        created_at: z.number().int().nullable().describe("Epoch-ms creation time, when tracked."),
        withdrawal_id: z.string().nullable().optional().describe("withdrawal only: provider withdrawal id, when known."),
        txid: z.string().nullable().optional().describe("withdrawal only: broadcast Liquid txid, when known."),
        swap_type: z
          .enum(["submarine", "reverse", "stablecoin"])
          .optional()
          .describe("boltz only: which swap kind is in flight."),
        peg_addr: z.string().optional().describe("pegin only: the BTC address the owner funds externally."),
        recv_addr: z.string().optional().describe("pegin only: OUR Liquid address SideSwap pays L-BTC to."),
        shift_type: z.enum(["send", "receive"]).optional().describe("sideshift only: shift direction."),
        network: z.string().optional().describe("sideshift only: the non-Liquid network of the shift."),
        route_id: z.string().optional().describe("plan only: the multi-hop route being executed (its id lists every leg)."),
        hops: z.number().int().optional().describe("plan only: total legs in the route."),
        current_leg: z.number().int().optional().describe("plan only: 1-based leg currently being driven."),
        note: z
          .string()
          .optional()
          .describe("plan only: manual instruction when the plan is parked needs_review."),
      }),
    )
    .describe("Everything currently in flight across the four durable stores, newest data as stored. Empty when nothing is pending."),
} as const;

export const shiftUsdtOutput = {
  shift_id: z.string().describe("SideShift shift id — track it at sideshift.ai/orders/<id>."),
  network: z.string().describe("The target network the USDt was shifted to."),
  deposit_address: z
    .string()
    .describe("SideShift's Liquid deposit address the USDt was sent to — CUSTODIAL: this address is theirs."),
  settle_address: z.string().describe("The FINAL destination address on the target network."),
  refund_address: z.string().nullable().describe("The refund address, or null when none was set."),
  deposit_amount_sats: z.string().describe("USDt sent from the wallet (base units, as a decimal string)."),
  settle_amount: z.string().nullable().describe("USDt that will land on the target network (decimal), when quoted."),
  status: z.string().describe("SideShift shift status at creation (waiting/pending/…)."),
  txid: z.string().describe("The broadcast Liquid txid of the USDt send."),
  brl_cents: z
    .number()
    .int()
    .describe("The USDt sent valued in BRL cents — what was counted against the guardrail (§4.3)."),
  custodial: z
    .literal(true)
    .describe("Always true — SideShift is CUSTODIAL: once sent, the funds are in SideShift's custody, not yours."),
} as const;
