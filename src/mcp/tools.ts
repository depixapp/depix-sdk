// Pure tool handlers for the local wallet MCP facade (spec §6.2). Each maps ONE
// tool to ONE DepixWallet method — zero money logic lives here; guardrails,
// typed errors and persistence all belong to the wallet the tools call (§6.1).
// Handlers throw the SDK's typed errors; the server wrapper turns them into
// isError results via mapToolError (errors.ts).
//
// Results are reshaped to be JSON-serializable and unit-explicit: bigint sats
// become decimal STRINGS (a bigint is not JSON-serializable and a Number would
// lose precision), and every money field carries its unit in the name.

import type {
  DepositParams,
  DepositResult,
  GuardrailReadout,
  ResumeSummary,
  SendParams,
  SendResult,
  WalletBalances,
  WalletTransaction,
  WithdrawParams,
  WithdrawResult,
} from "../wallet.js";
import type { StatusReadResponse } from "../api/client.js";
import type { WaitOptions } from "../flows/status.js";
import type { AssetKey } from "../assets.js";
import type { WithdrawMode } from "../flows/withdraw.js";
import type {
  PayLightningResult,
  ReceiveLightningResult,
  ToStablecoinResult,
} from "../convert/boltz/convert.js";
import type { StablecoinAsset, StablecoinParams } from "../convert/boltz/stablecoin.js";
import type { SwapQuoteParams } from "../convert/sideswap.js";
import type { BuyGiftcardParams, BuyGiftcardResult } from "../giftcards/namespace.js";
import type { StoredGiftcardOrder } from "../giftcards/store.js";
import type { McpSwapFacade, SwapStreamRegistry } from "./swap-streams.js";
import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS_CEILING,
  SWAP_QUOTE_DEFAULT_WAIT_SECONDS,
  SWAP_QUOTE_MAX_WAIT_SECONDS,
} from "./schemas.js";
import { ToolError } from "./errors.js";

/**
 * The Boltz Lightning/stablecoin sub-facade the fast-follow tools consume (§5.3).
 * BoltzConvert satisfies it structurally; on a view-only/wiped wallet the parent
 * `convert.boltz` GETTER throws WALLET_NOT_FOUND before any of these run.
 */
export interface McpBoltzFacade {
  payLightningInvoice(params: { invoice: string }): Promise<PayLightningResult>;
  receiveLightning(params: { amountSats: number }): Promise<ReceiveLightningResult>;
  toStablecoin(params: StablecoinParams): Promise<ToStablecoinResult>;
}

/** The `wallet.convert` sub-facade the fast-follow tools consume (§5). */
export interface McpConvertFacade {
  readonly sideswap: McpSwapFacade;
  /** Throws WALLET_NOT_FOUND on a view-only/wiped wallet (no seed to sign). */
  readonly boltz: McpBoltzFacade;
}

/** The `wallet.giftcards` sub-facade the fast-follow tools consume (§5.5). */
export interface McpGiftcardsFacade {
  buy(params: BuyGiftcardParams): Promise<BuyGiftcardResult>;
  listOrders(): Promise<StoredGiftcardOrder[]>;
}

/**
 * The subset of DepixWallet the tools consume (§6.2). DepixWallet satisfies this
 * structurally; tests inject a fake to exercise mapping without a real Liquid
 * engine. The `convert`/`giftcards` namespaces back the fast-follow tools.
 */
export interface McpWalletFacade {
  isBackupConfirmed(): boolean;
  getGuardrails(): Promise<GuardrailReadout>;
  getReceiveAddress(options?: { index?: number }): Promise<string>;
  getBalances(): Promise<WalletBalances>;
  listTransactions(): Promise<WalletTransaction[]>;
  send(params: SendParams): Promise<SendResult>;
  deposit(params: DepositParams): Promise<DepositResult>;
  withdraw(params: WithdrawParams): Promise<WithdrawResult>;
  waitForDeposit(id: string, options?: WaitOptions): Promise<StatusReadResponse>;
  waitForWithdrawal(id: string, options?: WaitOptions): Promise<StatusReadResponse>;
  readonly convert: McpConvertFacade;
  readonly giftcards: McpGiftcardsFacade;
}

/** Process-level context the money-neutral tools read (server-supplied). */
export interface ToolContext {
  /** Key mode derived LOCALLY from the sk_ prefix (§6.2) — never an /api/me call. */
  keyMode: "live" | "test" | "unknown";
  apiKeyConfigured: boolean;
  /** Crash-resume summary captured at boot (§3.2.9). */
  bootResume: ResumeSummary;
}

// ── reshapers ──
function guardrailBudget(g: GuardrailReadout) {
  return {
    used_cents: g.usedCents,
    daily_limit_cents: g.dailyLimitCents,
    per_tx_limit_cents: g.perTxLimitCents,
    remaining_cents: g.remainingCents,
    allowlist_enabled: g.allowlistEnabled,
  };
}

function balancesToSats(b: WalletBalances["balances"]) {
  return {
    depix_sats: b.DEPIX.toString(),
    lbtc_sats: b.LBTC.toString(),
    usdt_sats: b.USDT.toString(),
  };
}

function txToOutput(tx: WalletTransaction) {
  const balance: Record<string, string> = {};
  for (const [asset, delta] of Object.entries(tx.balance)) balance[asset] = delta.toString();
  return {
    txid: tx.txid,
    height: tx.height,
    timestamp: tx.timestamp,
    type: tx.type,
    fee_sats: tx.feeSats.toString(),
    balance,
  };
}

function statusReadToOutput(s: StatusReadResponse) {
  const out: Record<string, unknown> = { id: s.id, status: s.status };
  if (s.type !== undefined) out.type = s.type;
  if (s.amount_cents !== undefined) out.amount_cents = s.amount_cents;
  if (s.created_at !== undefined) out.created_at = s.created_at;
  if (s.updated_at !== undefined) out.updated_at = s.updated_at;
  if (s.rejection_reasons !== undefined) out.rejection_reasons = s.rejection_reasons;
  if (s.liquid_txid !== undefined) out.liquid_txid = s.liquid_txid;
  if (s.sandbox !== undefined) out.sandbox = s.sandbox;
  return out;
}

/** Translate a wait tool's second-based, ceiling-bound args into WaitOptions. */
function waitOptions(
  args: { interval_seconds?: number; timeout_seconds?: number },
  maxWaitSeconds: number,
): WaitOptions {
  const timeoutSeconds = Math.min(args.timeout_seconds ?? DEFAULT_WAIT_SECONDS, maxWaitSeconds);
  const intervalSeconds = args.interval_seconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
  return { intervalMs: intervalSeconds * 1000, timeoutMs: timeoutSeconds * 1000 };
}

// ── handlers ──
export async function statusTool(wallet: McpWalletFacade, ctx: ToolContext) {
  const guardrails = await wallet.getGuardrails();
  return {
    mode: ctx.keyMode,
    api_key_configured: ctx.apiKeyConfigured,
    backup_confirmed: wallet.isBackupConfirmed(),
    guardrails: guardrailBudget(guardrails),
    pending_withdrawals: {
      resumed: ctx.bootResume.resumed,
      rebroadcast: ctx.bootResume.rebroadcast,
      reposted: ctx.bootResume.reposted,
      discarded: ctx.bootResume.discarded,
      failed: ctx.bootResume.failed,
    },
  };
}

export async function getAddressTool(wallet: McpWalletFacade, args: { index?: number }) {
  const address =
    args.index !== undefined
      ? await wallet.getReceiveAddress({ index: args.index })
      : await wallet.getReceiveAddress();
  return { address };
}

export async function getBalancesTool(wallet: McpWalletFacade) {
  const { balances, brlEstimate } = await wallet.getBalances();
  return { balances: balancesToSats(balances), brl_estimate_cents: brlEstimate };
}

export async function listTransactionsTool(wallet: McpWalletFacade) {
  const txs = await wallet.listTransactions();
  return { transactions: txs.map(txToOutput) };
}

export async function sendTool(
  wallet: McpWalletFacade,
  args: { asset: AssetKey; amount_sats: string; address: string },
) {
  const result = await wallet.send({
    asset: args.asset,
    amountSats: BigInt(args.amount_sats),
    address: args.address,
  } satisfies SendParams);
  return { txid: result.txid };
}

export async function createDepositTool(
  wallet: McpWalletFacade,
  args: { amount_cents: number; payer_tax_number: string },
) {
  const result: DepositResult = await wallet.deposit({
    amountCents: args.amount_cents,
    payerTaxNumber: args.payer_tax_number,
  });
  const out: { id: string; qr_copy_paste: string; sandbox?: true } = {
    id: result.id,
    qr_copy_paste: result.qrCopyPaste,
  };
  if (result.sandbox) out.sandbox = true;
  return out;
}

export async function createWithdrawalTool(
  wallet: McpWalletFacade,
  args: { pix_key: string; recipient_tax_number: string; amount_cents: number; mode: WithdrawMode },
) {
  const r: WithdrawResult = await wallet.withdraw({
    pixKey: args.pix_key,
    recipientTaxNumber: args.recipient_tax_number,
    amountCents: args.amount_cents,
    mode: args.mode,
  });
  const out: Record<string, unknown> = {
    withdrawal_id: r.withdrawalId,
    txid: r.txid,
    fee_cents: r.feeCents,
    fee_address: r.feeAddress,
    net_cents: r.netCents,
    gross_cents: r.grossCents,
    payout_cents: r.payoutCents,
  };
  if (r.sandbox) out.sandbox = true;
  return out;
}

export async function waitDepositTool(
  wallet: McpWalletFacade,
  args: { id: string; interval_seconds?: number; timeout_seconds?: number },
  maxWaitSeconds: number = MAX_WAIT_SECONDS_CEILING,
) {
  const status = await wallet.waitForDeposit(args.id, waitOptions(args, maxWaitSeconds));
  return statusReadToOutput(status);
}

export async function waitWithdrawalTool(
  wallet: McpWalletFacade,
  args: { id: string; interval_seconds?: number; timeout_seconds?: number },
  maxWaitSeconds: number = MAX_WAIT_SECONDS_CEILING,
) {
  const status = await wallet.waitForWithdrawal(args.id, waitOptions(args, maxWaitSeconds));
  return statusReadToOutput(status);
}

export async function getGuardrailsTool(wallet: McpWalletFacade) {
  return guardrailBudget(await wallet.getGuardrails());
}

// ── fast-follow handlers: conversions + gift cards (spec §6.2 fast-follow, §5) ──
//
// Same rule as above — ZERO money logic here. Each handler wraps ONE wallet
// namespace method (wallet.convert.*, wallet.giftcards.*), which owns the
// guardrail choke point + signing (§4.3). Provider-transport errors (SideSwap /
// Boltz / CryptoRefills) map through the SAME safe-by-default mapToolError, so
// their bodies never enter a tool message (§6.2e). Long completions (Lightning /
// gift-card watches) are NOT awaited here — the tool returns once the lockup is
// broadcast, and BoltzConvert.dispose() (via wallet.close()) cancels the watch on
// shutdown.

export async function swapQuoteTool(
  wallet: McpWalletFacade,
  registry: SwapStreamRegistry,
  args: { from: AssetKey; to: AssetKey; amount_sats: string; timeout_seconds?: number },
) {
  const params: SwapQuoteParams = {
    from: args.from,
    to: args.to,
    amountSats: BigInt(args.amount_sats),
  };
  const timeoutMs =
    Math.min(args.timeout_seconds ?? SWAP_QUOTE_DEFAULT_WAIT_SECONDS, SWAP_QUOTE_MAX_WAIT_SECONDS) * 1000;
  const stream = await wallet.convert.sideswap.quote(params);
  let quote;
  try {
    quote = await stream.next({ timeoutMs });
  } catch (err) {
    // A doomed quote must not leak its socket — tear the stream down before
    // surfacing the error (timeout / low balance / stream failure).
    stream.close();
    throw err;
  }
  const swapQuoteId = registry.register(stream, quote);
  return {
    swap_quote_id: swapQuoteId,
    from: quote.from,
    to: quote.to,
    send_amount_sats: quote.sendAmountSats.toString(),
    recv_amount_sats: quote.recvAmountSats.toString(),
    server_fee_sats: quote.serverFeeSats.toString(),
    fixed_fee_sats: quote.fixedFeeSats.toString(),
    fee_asset: quote.feeAsset,
    ttl_ms: quote.ttlMs,
    expires_at_ms: quote.expiresAt,
  };
}

export async function swapExecuteTool(registry: SwapStreamRegistry, args: { swap_quote_id: string }) {
  const entry = registry.take(args.swap_quote_id);
  if (!entry) {
    throw new ToolError(
      "Unknown or already-used swap_quote_id (a quote is single-use and expires quickly). " +
        "Request a fresh quote with wallet_swap_quote and execute that one.",
      "swap_quote_not_found",
    );
  }
  try {
    const r = await entry.stream.execute(entry.quote);
    return {
      txid: r.txid,
      from: r.from,
      to: r.to,
      send_amount_sats: r.sendAmountSats.toString(),
      recv_amount_sats: r.recvAmountSats.toString(),
      brl_cents: r.brlCents,
    };
  } finally {
    // execute is terminal (SideSwap broadcasts) — close the socket either way.
    entry.stream.close();
  }
}

export async function payLightningInvoiceTool(wallet: McpWalletFacade, args: { invoice: string }) {
  const r = await wallet.convert.boltz.payLightningInvoice({ invoice: args.invoice });
  return {
    swap_id: r.swapId,
    lockup_txid: r.lockupTxid,
    expected_amount_sats: r.expectedAmountSats,
    invoice_sats: r.invoiceSats,
    invoice: r.invoice,
  };
}

export async function receiveLightningTool(wallet: McpWalletFacade, args: { amount_sats: string }) {
  const r = await wallet.convert.boltz.receiveLightning({ amountSats: Number(args.amount_sats) });
  return {
    swap_id: r.swapId,
    invoice: r.invoice,
    lockup_address: r.lockupAddress,
    amount_sats: r.amountSats.toString(),
  };
}

export async function toStablecoinTool(
  wallet: McpWalletFacade,
  args: { asset: StablecoinAsset; network_id: string; amount_sats: string; claim_address: string },
) {
  const r = await wallet.convert.boltz.toStablecoin({
    asset: args.asset,
    networkId: args.network_id,
    amountSats: Number(args.amount_sats),
    claimAddress: args.claim_address,
  });
  return {
    swap_id: r.swapId,
    lockup_txid: r.lockupTxid,
    lock_amount_sats: r.lockAmountSats,
    asset: r.asset,
    network_id: r.networkId,
    claim_address: r.claimAddress,
  };
}

export async function buyGiftcardTool(
  wallet: McpWalletFacade,
  args: {
    brand_name: string;
    denomination: string;
    email: string;
    beneficiary_account?: string;
    country_code?: string;
    product_value?: string;
    quantity?: number;
    validate?: boolean;
  },
) {
  const params: BuyGiftcardParams = {
    brandName: args.brand_name,
    denomination: args.denomination,
    email: args.email,
    ...(args.beneficiary_account !== undefined ? { beneficiaryAccount: args.beneficiary_account } : {}),
    ...(args.country_code !== undefined ? { countryCode: args.country_code } : {}),
    ...(args.product_value !== undefined ? { productValue: args.product_value } : {}),
    ...(args.quantity !== undefined ? { quantity: args.quantity } : {}),
    ...(args.validate !== undefined ? { validate: args.validate } : {}),
  };
  const r = await wallet.giftcards.buy(params);
  return {
    order_id: r.orderId,
    invoice: r.invoice,
    swap_id: r.swapId,
    lockup_txid: r.lockupTxid,
    invoice_sats: r.invoiceSats,
    fee_sats: r.feeSats.toString(),
    expected_amount_sats: r.expectedAmountSats,
    total_sats: r.totalSats.toString(),
    beneficiary_account: r.beneficiaryAccount,
  };
}

function giftcardOrderToOutput(o: StoredGiftcardOrder) {
  const out: Record<string, unknown> = {
    order_id: o.orderId,
    brand_name: o.brandName,
    denomination: o.denomination,
    beneficiary_account: o.beneficiaryAccount,
    invoice_sats: o.invoiceSats,
    fee_sats: o.feeSats,
    expected_amount_sats: o.expectedAmountSats,
    swap_id: o.swapId,
    phase: o.phase,
    created_at: o.createdAt,
    updated_at: o.updatedAt,
  };
  if (o.lockupTxid !== undefined) out.lockup_txid = o.lockupTxid;
  return out;
}

export async function listGiftcardOrdersTool(wallet: McpWalletFacade) {
  const orders = await wallet.giftcards.listOrders();
  return { orders: orders.map(giftcardOrderToOutput) };
}
