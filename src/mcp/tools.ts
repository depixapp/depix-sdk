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
  ConversionResumeSummary,
  DepositParams,
  DepositResult,
  GuardrailReadout,
  PendingItem,
  RecoverySummary,
  ResumeSummary,
  SendParams,
  SendResult,
  WalletBalances,
  WalletDiagnostics,
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
import type {
  ConvertFunding,
  ConvertParams,
  ConvertResult,
  RouteLegQuote,
  RouteQuote,
} from "../convert/intent.js";
import type { ConvertIntent, IntentAsset, IntentNetwork } from "../convert/routes.js";
import type { SwapQuoteParams } from "../convert/sideswap.js";
import type { SideShiftSendResult } from "../convert/sideshift.js";
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

/**
 * The `wallet.convert.sideshift` sub-facade (§5.4) — CUSTODIAL, signalled (G4).
 * `send()` is the money-mover the wallet_shift_usdt tool wraps.
 */
export interface McpSideshiftFacade {
  send(params: {
    network: string;
    amountSats: bigint;
    settleAddress: string;
    refundAddress?: string;
  }): Promise<SideShiftSendResult>;
}

/** The `wallet.convert` sub-facade the fast-follow tools consume (§5). */
export interface McpConvertFacade {
  readonly sideswap: McpSwapFacade;
  /** Throws WALLET_NOT_FOUND on a view-only/wiped wallet (no seed to sign). */
  readonly boltz: McpBoltzFacade;
  /** SideShift USDt cross-network (§5.4) — CUSTODIAL. */
  readonly sideshift: McpSideshiftFacade;
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
  recover(): Promise<RecoverySummary>;
  getPending(): Promise<PendingItem[]>;
  diagnostics(): Promise<WalletDiagnostics>;
  /** wallet.quote() (PR-B) — enumerate + estimate every candidate route, read-only. */
  quote(params: ConvertIntent): Promise<RouteQuote[]>;
  /**
   * wallet.convert (PR-B/PR-C) — CALLABLE (the intent executor wallet_convert
   * wraps) AND the carrier of the advanced provider sub-namespaces the
   * fast-follow tools consume. DepixWallet's ConvertFacade satisfies both.
   */
  readonly convert: McpConvertFacade & ((params: ConvertParams) => Promise<ConvertResult>);
  readonly giftcards: McpGiftcardsFacade;
}

/** Process-level context the money-neutral tools read (server-supplied). */
export interface ToolContext {
  /** Key mode derived LOCALLY from the sk_ prefix (§6.2) — never an /api/me call. */
  keyMode: "live" | "test" | "unknown";
  apiKeyConfigured: boolean;
  /** Crash-resume summary captured at boot (§3.2.9). */
  bootResume: ResumeSummary;
  /** Conversion crash-resume summary captured at boot (§5 recovery wiring). */
  bootConversions: ConversionResumeSummary;
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

function withdrawalsResumeToOutput(r: ResumeSummary) {
  return {
    resumed: r.resumed,
    rebroadcast: r.rebroadcast,
    reposted: r.reposted,
    discarded: r.discarded,
    failed: r.failed,
  };
}

function conversionsResumeToOutput(c: ConversionResumeSummary) {
  return {
    boltz: c.boltz
      ? {
          submarine_resumed: c.boltz.submarineResumed,
          submarine_refunded: c.boltz.submarineRefunded,
          reverse_resumed: c.boltz.reverseResumed,
          stablecoin_resumed: c.boltz.stablecoinResumed,
          stablecoin_refunded: c.boltz.stablecoinRefunded,
          discarded: c.boltz.discarded,
          removed: c.boltz.removed,
          failed: c.boltz.failed,
        }
      : null,
    pegin: { pending: c.pegin.pending, cleared: c.pegin.cleared, failed: c.pegin.failed },
    sideshift: { checked: c.sideshift.checked, refreshed: c.sideshift.refreshed, failed: c.sideshift.failed },
    plans: {
      checked: c.plans.checked,
      advanced: c.plans.advanced,
      completed: c.plans.completed,
      needs_review: c.plans.needsReview,
      discarded: c.plans.discarded,
      failed: c.plans.failed,
    },
  };
}

// ── handlers ──
export async function statusTool(wallet: McpWalletFacade, ctx: ToolContext) {
  const guardrails = await wallet.getGuardrails();
  return {
    mode: ctx.keyMode,
    api_key_configured: ctx.apiKeyConfigured,
    backup_confirmed: wallet.isBackupConfirmed(),
    guardrails: guardrailBudget(guardrails),
    pending_withdrawals: withdrawalsResumeToOutput(ctx.bootResume),
    pending_conversions: conversionsResumeToOutput(ctx.bootConversions),
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
  // take() removes the entry (and clears its abandon timer) BEFORE we await
  // execute(), so a concurrent server.close() → disposeAll() can never double-close
  // a socket that is mid-broadcast. The deliberate consequence: a stream that is
  // in execute() is no longer registry-tracked, so disposeAll() cannot reach it —
  // only the `finally { entry.stream.close() }` below does. The "clean shutdown
  // leaves no live socket" guarantee therefore holds strictly for QUOTED-but-not-
  // executed streams; an execute() that hangs is an in-flight money broadcast (the
  // guardrail has already signed in the wallet layer) and is reclaimed by the stdio
  // bin's process.exit(0) — or, if close() itself wedged, the runtime hard-exit
  // watchdog. That is acceptable and unavoidable for an in-flight broadcast; there
  // is no true socket leak in the packaged bin.
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

/**
 * Down-cast a validated (`/^\d+$/`, unbounded) `amount_sats` string to the JS
 * `number` the two Boltz inflows (`receiveLightning` / `toStablecoin`) take —
 * their wallet API signature is `amountSats: number`, unlike the swap tools which
 * carry `amount_sats` as bigint end-to-end via `BigInt()`. `Number()` would
 * SILENTLY round a value above 2^53-1, so we guard the trust boundary here: reject
 * with a typed error rather than let a lossily-rounded amount reach the wallet.
 * (Comparison is done in BigInt to avoid the very lossiness we are guarding.)
 */
function amountSatsToNumber(amountSats: string): number {
  // amountSatsField is /^\d+$/, so BigInt() never throws and the value is >= 0.
  if (BigInt(amountSats) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ToolError(
      `amount_sats ${amountSats} exceeds the maximum safely-representable integer ` +
        `(${Number.MAX_SAFE_INTEGER}). This flow hands amountSats to the wallet as a JS number, ` +
        "and a larger value would silently lose precision — request an amount at or below that ceiling.",
      "amount_sats_too_large",
    );
  }
  return Number(amountSats);
}

export async function receiveLightningTool(wallet: McpWalletFacade, args: { amount_sats: string }) {
  const r = await wallet.convert.boltz.receiveLightning({ amountSats: amountSatsToNumber(args.amount_sats) });
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
    amountSats: amountSatsToNumber(args.amount_sats),
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

/**
 * wallet_shift_usdt (§5.4/G4) — the ONE CUSTODIAL tool. Wraps
 * wallet.convert.sideshift.send(): SEND USDt from Liquid to another network via
 * SideShift. Zero money logic here — the guardrail choke point + allowlist + signing
 * live in the wallet method; a SideShiftApiError (upstream text) maps through the
 * SAME safe-by-default mapToolError (untrusted path) as every provider transport.
 */
/**
 * wallet_recover — re-run crash recovery for every rail (withdrawals §3.2.9 +
 * conversions §5) mid-session. Zero money logic here: each rail's resume owns
 * its own idempotency invariants (same bytes / same Idempotency-Key / persisted
 * swap keys); this handler only maps the per-rail counters to snake_case.
 */
export async function recoverTool(wallet: McpWalletFacade) {
  const r = await wallet.recover();
  return {
    withdrawals: withdrawalsResumeToOutput(r.withdrawals),
    ...conversionsResumeToOutput(r),
  };
}

function pendingItemToOutput(item: PendingItem) {
  const out: Record<string, unknown> = {
    rail: item.rail,
    id: item.id,
    state: item.state,
    created_at: item.createdAt,
  };
  switch (item.rail) {
    case "withdrawal":
      out.withdrawal_id = item.withdrawalId;
      out.txid = item.txid;
      break;
    case "boltz":
      out.swap_type = item.swapType;
      break;
    case "pegin":
      out.peg_addr = item.pegAddr;
      out.recv_addr = item.recvAddr;
      break;
    case "sideshift":
      out.shift_type = item.shiftType;
      out.network = item.network;
      break;
    case "plan":
      out.route_id = item.routeId;
      out.hops = item.hops;
      out.current_leg = item.currentLeg;
      if (item.note !== undefined) out.note = item.note;
      break;
  }
  return out;
}

/** wallet_pending — unified read-only view over the four pending stores. */
export async function pendingTool(wallet: McpWalletFacade) {
  const items = await wallet.getPending();
  return { pending: items.map(pendingItemToOutput) };
}

/**
 * wallet_diagnostics (PR-D) — read-only health snapshot for support. Maps ONE
 * wallet method (wallet.diagnostics()); the wallet layer guarantees the
 * snapshot carries NO key material (getPending()'s fund-safety rule).
 */
export async function diagnosticsTool(wallet: McpWalletFacade) {
  const d = await wallet.diagnostics();
  return {
    sdk_version: d.sdkVersion,
    lwk_version: d.lwkVersion,
    data_dir: d.dataDir,
    backup_confirmed: d.backupConfirmed,
    has_seed: d.hasSeed,
    api_key_configured: d.apiKeyConfigured,
    sync: {
      last_scan_at: d.sync.lastScanAt,
      last_success_at: d.sync.lastSuccessAt,
      last_persist_failed_at: d.sync.lastPersistFailedAt,
      last_persist_error_name: d.sync.lastPersistErrorName,
      persisted_updates: d.sync.persistedUpdates,
      wallet_loaded: d.sync.walletLoaded,
    },
    pending: {
      withdrawals: d.pending.withdrawals,
      boltz_swaps: d.pending.boltzSwaps,
      pegins: d.pending.pegins,
      sideshift_shifts: d.pending.sideshiftShifts,
      plans: d.pending.plans,
    },
    guardrails: d.guardrails ? guardrailBudget(d.guardrails) : null,
  };
}

// ── intent layer: wallet_quote + wallet_convert (PR-B/PR-C) ──
//
// The PRIMARY conversion surface. Same rule as everything above — ZERO money
// logic here: wallet_convert wraps the callable wallet.convert() (which routes
// every money-moving leg through the §4.3 guardrail choke point inside the
// provider methods) and wallet_quote wraps the read-only wallet.quote(). The
// tools only translate snake_case args and reshape bigints to strings.

/** Snake_case intent-trio args shared by wallet_quote and wallet_convert. */
export interface McpIntentArgs {
  from: IntentAsset;
  to: IntentAsset;
  network?: IntentNetwork;
  from_network?: IntentNetwork;
  amount_sats: string;
}

function intentFromArgs(args: McpIntentArgs): ConvertIntent {
  return {
    from: args.from,
    to: args.to,
    ...(args.network !== undefined ? { network: args.network } : {}),
    ...(args.from_network !== undefined ? { fromNetwork: args.from_network } : {}),
    // amount_sats is /^\d+$/-validated, so BigInt() never throws; the wallet
    // rejects 0 with a typed INVALID_AMOUNT.
    amount: BigInt(args.amount_sats),
  };
}

function legQuoteToOutput(leg: RouteLegQuote) {
  return {
    provider: leg.provider,
    method: leg.method,
    from: leg.from,
    from_network: leg.fromNetwork,
    to: leg.to,
    network: leg.network,
    custodial: leg.custodial,
    estimated_received_sats: leg.estimatedReceivedSats !== null ? leg.estimatedReceivedSats.toString() : null,
    estimated_fee_sats: leg.estimatedFeeSats !== null ? leg.estimatedFeeSats.toString() : null,
    fee_asset: leg.feeAsset,
    ...(leg.note !== undefined ? { note: leg.note } : {}),
  };
}

function routeQuoteToOutput(route: RouteQuote) {
  return {
    id: route.id,
    hops: route.hops,
    custodial: route.custodial,
    estimated_received_sats:
      route.estimatedReceivedSats !== null ? route.estimatedReceivedSats.toString() : null,
    estimated_fee_total_sats:
      route.estimatedFeeTotalSats !== null ? route.estimatedFeeTotalSats.toString() : null,
    fee_asset: route.feeAsset,
    estimate_complete: route.estimateComplete,
    notes: [...route.notes],
    legs: route.legs.map(legQuoteToOutput),
  };
}

/** wallet_quote — enumerate + estimate EVERY candidate route (read-only). */
export async function quoteTool(wallet: McpWalletFacade, args: McpIntentArgs) {
  const routes = await wallet.quote(intentFromArgs(args));
  return { routes: routes.map(routeQuoteToOutput) };
}

function fundingToOutput(funding: ConvertFunding) {
  const out: Record<string, unknown> = { kind: funding.kind };
  if (funding.address !== undefined) out.address = funding.address;
  if (funding.invoice !== undefined) out.invoice = funding.invoice;
  if (funding.network !== undefined) out.network = funding.network;
  if (funding.min !== undefined) out.min = funding.min;
  if (funding.max !== undefined) out.max = funding.max;
  if (funding.expiresAt !== undefined) out.expires_at = funding.expiresAt;
  return out;
}

function convertResultToOutput(r: ConvertResult) {
  const out: Record<string, unknown> = {
    route_id: r.route.id,
    hops: r.route.hops,
    custodial: r.custodial,
    status: r.status,
    txids: [...r.txids],
    received_sats: r.receivedSats !== null ? r.receivedSats.toString() : null,
  };
  if (r.trackingId !== undefined) out.tracking_id = r.trackingId;
  if (r.funding !== undefined) out.funding = fundingToOutput(r.funding);
  if (r.nextStep !== undefined) out.next_step = r.nextStep;
  return out;
}

/**
 * wallet_convert — execute ONE conversion intent via the callable
 * wallet.convert(). A MULTIPLE_ROUTES_AVAILABLE refusal propagates to
 * mapToolError, which surfaces the candidate routes in error.data.routes plus a
 * next_step (the tool is stateless — the agent re-calls with `route`).
 */
export async function convertTool(
  wallet: McpWalletFacade,
  args: McpIntentArgs & {
    route?: string;
    address?: string;
    invoice?: string;
    refund_address?: string;
    wait?: boolean;
    timeout_seconds?: number;
  },
  maxWaitSeconds: number = MAX_WAIT_SECONDS_CEILING,
) {
  const params: ConvertParams = {
    ...intentFromArgs(args),
    ...(args.route !== undefined ? { route: args.route } : {}),
    ...(args.address !== undefined ? { address: args.address } : {}),
    ...(args.invoice !== undefined ? { invoice: args.invoice } : {}),
    ...(args.refund_address !== undefined ? { refundAddress: args.refund_address } : {}),
    ...(args.wait !== undefined ? { wait: args.wait } : {}),
    ...(args.timeout_seconds !== undefined
      ? { timeoutMs: Math.min(args.timeout_seconds, maxWaitSeconds) * 1000 }
      : {}),
  };
  const result = await wallet.convert(params);
  return convertResultToOutput(result);
}

export async function shiftUsdtTool(
  wallet: McpWalletFacade,
  args: { network: string; amount_sats: string; settle_address: string; refund_address?: string },
) {
  const r: SideShiftSendResult = await wallet.convert.sideshift.send({
    network: args.network,
    amountSats: BigInt(args.amount_sats),
    settleAddress: args.settle_address,
    ...(args.refund_address !== undefined ? { refundAddress: args.refund_address } : {}),
  });
  return {
    shift_id: r.shiftId,
    network: r.network,
    deposit_address: r.depositAddress,
    settle_address: r.settleAddress,
    refund_address: r.refundAddress,
    deposit_amount_sats: r.depositAmountSats.toString(),
    settle_amount: r.settleAmount,
    status: r.status,
    txid: r.txid,
    brl_cents: r.brlCents,
    custodial: r.custodial,
  };
}
