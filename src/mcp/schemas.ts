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

export const statusOutput = {
  mode: z
    .enum(["live", "test", "unknown"])
    .describe("Key mode, derived LOCALLY from the sk_live_/sk_test_ prefix — no API call (§6.2)."),
  api_key_configured: z.boolean().describe("Whether an API key is set (deposit/withdraw need one)."),
  backup_confirmed: z.boolean().describe("Whether the seed backup was confirmed — receive is gated until true (§2.9)."),
  guardrails: guardrailBudget(),
  pending_withdrawals: z
    .object({
      resumed: z.number().int(),
      rebroadcast: z.number().int(),
      reposted: z.number().int(),
      discarded: z.number().int(),
      failed: z.number().int(),
    })
    .describe("Crash-recovery summary from boot (§3.2.9): auto-resumed/re-broadcast/discarded records."),
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
