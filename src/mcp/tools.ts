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
import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS_CEILING,
} from "./schemas.js";

/**
 * The subset of DepixWallet the MVP tools consume (§6.2). DepixWallet satisfies
 * this structurally; tests inject a fake to exercise mapping without a real
 * Liquid engine.
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
