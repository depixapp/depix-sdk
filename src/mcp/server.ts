// Local wallet MCP server factory (spec §6). Registers the MVP catalog of
// `wallet_*` tools (§6.2) on an McpServer bound to a single DepixWallet running
// in the AGENT's environment — the seed never leaves the machine (§6.1). Every
// tool call routes to the SAME wallet facade, so guardrails (§4), typed errors
// (§7) and persistence are shared; there is ZERO money logic in this layer.
//
// Naming (G10): every tool is prefixed `wallet_`, a set disjoint from the 16
// unprefixed tools of the remote @depixapp/mcp (F2), so a host can mount both
// servers side by side without collision — remote = receive/merchant/status
// reads, local = pay/sign.
//
// The catalog deliberately has NO tool that exports the mnemonic/seed/descriptor
// -with-keys, mutates guardrails, edits liquid_address/split_address, or pays a
// checkout QR (§6.2): no tool call — not even from a fully injected LLM — can
// reach the seed or raise a ceiling.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ResumeSummary } from "../wallet.js";
import { ToolError, mapToolError, missingApiKeyError } from "./errors.js";
import { defaultLogger as logger } from "../logger.js";
import * as s from "./schemas.js";
import { MAX_WAIT_SECONDS_CEILING } from "./schemas.js";
import {
  buyGiftcardTool,
  createDepositTool,
  createWithdrawalTool,
  getAddressTool,
  getBalancesTool,
  getGuardrailsTool,
  listGiftcardOrdersTool,
  listTransactionsTool,
  payLightningInvoiceTool,
  receiveLightningTool,
  sendTool,
  statusTool,
  swapExecuteTool,
  swapQuoteTool,
  toStablecoinTool,
  waitDepositTool,
  waitWithdrawalTool,
  type McpWalletFacade,
  type ToolContext,
} from "./tools.js";
import { SwapStreamRegistry } from "./swap-streams.js";
import type { StablecoinAsset } from "../convert/boltz/stablecoin.js";
import type { AssetKey } from "../assets.js";

export const SERVER_NAME = "com.depixapp/wallet";
export const SERVER_TITLE = "DePix Wallet";
export const DEFAULT_SERVER_VERSION = "1.0.0";

/**
 * The full catalog (§6.2), prefixed `wallet_` (G10). Exported for tests/docs.
 * The MVP 10 (PR8) plus the fast-follow conversions + gift cards (PR8b). SideShift
 * (wallet_shift_usdt, §5.4/G4) is intentionally absent: its wallet flow does not
 * exist on main, so there is nothing to wrap without reimplementing a custodial
 * provider (out of scope).
 */
export const WALLET_TOOL_NAMES = [
  "wallet_status",
  "wallet_get_address",
  "wallet_get_balances",
  "wallet_list_transactions",
  "wallet_send",
  "wallet_create_deposit",
  "wallet_wait_deposit",
  "wallet_create_withdrawal",
  "wallet_wait_withdrawal",
  "wallet_get_guardrails",
  "wallet_swap_quote",
  "wallet_swap_execute",
  "wallet_pay_lightning_invoice",
  "wallet_receive_lightning",
  "wallet_to_stablecoin",
  "wallet_buy_giftcard",
  "wallet_list_giftcard_orders",
] as const;

const INSTRUCTIONS = [
  "DePix Wallet MCP — a NON-CUSTODIAL Liquid wallet that signs locally, in the agent's own environment.",
  "The seed never leaves this machine: keys, passphrase and dataDir are configured via environment variables (DEPIX_API_KEY, DEPIX_WALLET_PASSPHRASE, DEPIX_WALLET_DIR, DEPIX_GUARDRAIL_*), never via tools.",
  "Money-moving tools (wallet_send, wallet_create_withdrawal) pass through the owner's guardrails (per-tx + rolling-24h BRL caps, optional allowlist) BEFORE signing — the facade never bypasses them.",
  "Amounts carry their unit in the field name: amount_cents is BRL cents; amount_sats is the asset's base units (1 DePix cent = 1,000,000 sats). Never mix them.",
  "There is no tool to export the seed, change guardrails, or pay a merchant checkout QR — by design.",
  "wallet_create_deposit returns a Pix copy-and-paste the human OWNER pays; the agent has no bank.",
].join(" ");

function ok(out: unknown): CallToolResult {
  return {
    // Full JSON in the text block, matching structuredContent — truncating would
    // hand hosts that only render `content` an invalid, cut-off document.
    content: [{ type: "text", text: JSON.stringify(out) }],
    structuredContent: out as Record<string, unknown>,
  };
}

function fail(err: ToolError): CallToolResult {
  return {
    isError: true,
    content: [
      { type: "text", text: err.message },
      {
        type: "text",
        text: JSON.stringify({ error: { code: err.code, retryable: err.retryable, ...err.data } }),
      },
    ],
  };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    const toolError = mapToolError(err);
    // Log only the code (never the raw message — it may echo untrusted upstream
    // text) so a bug surfaces without breaking the redaction boundary.
    if (toolError.code === "internal_error") {
      logger.error("tool_unexpected_error", { name: err instanceof Error ? err.name : "unknown" });
    }
    return fail(toolError);
  }
}

export interface CreateWalletMcpServerOptions {
  /** The wallet every tool calls (DepixWallet in prod; a fake in tests). */
  wallet: McpWalletFacade;
  /** Key mode derived from the sk_ prefix at boot (§6.2). "unknown" when no key. */
  keyMode?: "live" | "test" | "unknown";
  /** Whether an API key is configured (deposit/withdraw/wait need one). */
  apiKeyConfigured?: boolean;
  /** Crash-resume summary captured at boot (§3.2.9) — surfaced by wallet_status. */
  bootResume?: ResumeSummary;
  /** Hard ceiling for the wait tools' timeout_seconds (§6.2d). Default 900. */
  maxWaitSeconds?: number;
  version?: string;
}

const EMPTY_RESUME: ResumeSummary = {
  resumed: 0,
  rebroadcast: 0,
  reposted: 0,
  discarded: 0,
  failed: 0,
};

export function createWalletMcpServer(opts: CreateWalletMcpServerOptions): McpServer {
  const wallet = opts.wallet;
  const maxWaitSeconds = clampCeiling(opts.maxWaitSeconds);
  const ctx: ToolContext = {
    keyMode: opts.keyMode ?? "unknown",
    apiKeyConfigured: opts.apiKeyConfigured ?? false,
    bootResume: opts.bootResume ?? EMPTY_RESUME,
  };

  // The tools that hit the DePix API (deposit/withdraw + their waits) short-circuit
  // with an ACTIONABLE api_key_required error when DEPIX_API_KEY is absent, instead
  // of letting the api client surface a generic auth/internal error — the agent
  // cannot set the key itself, so it needs the one-line remediation (§6.1).
  const runKeyed = (fn: () => Promise<unknown>): Promise<CallToolResult> =>
    run(() => {
      if (!ctx.apiKeyConfigured) throw missingApiKeyError();
      return fn();
    });

  const server = new McpServer(
    { name: SERVER_NAME, title: SERVER_TITLE, version: opts.version ?? DEFAULT_SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  // Holds the OPEN SideSwap quote streams that wallet_swap_quote creates and
  // wallet_swap_execute runs on (the quote_id is socket-bound). Unlike the Boltz
  // watches — which wallet.close() disposes (§5.3) — these streams are owned by
  // the MCP layer, so server.close() must tear them down: we wrap close() to
  // disposeAll() FIRST, so a shutdown with a quote in flight leaves no live socket
  // (the deferral-critical guarantee, §6.1). disposeAll() is synchronous, so it
  // never makes shutdown hang; the runtime hard-exit watchdog is the backstop.
  const swapStreams = new SwapStreamRegistry();
  const baseClose = server.close.bind(server);
  server.close = async (): Promise<void> => {
    swapStreams.disposeAll();
    await baseClose();
  };

  const read: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
  const write: ToolAnnotations = { readOnlyHint: false, openWorldHint: true };
  const money: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

  server.registerTool(
    "wallet_status",
    {
      title: "Wallet status",
      description:
        "Read wallet operational status: key mode (live/test, derived locally from the sk_ prefix — no API call), " +
        "whether an API key is configured, whether the seed backup is confirmed, the current guardrail budget " +
        "(rolling-24h + per-tx caps and usage), and the crash-resume summary from boot. Moves no money.",
      inputSchema: s.statusInput,
      outputSchema: s.statusOutput,
      annotations: read,
    },
    () => run(() => statusTool(wallet, ctx)),
  );

  server.registerTool(
    "wallet_get_address",
    {
      title: "Get receive address",
      description:
        "Return a FRESH, unused Liquid receive address for this wallet (no on-chain reuse across calls). " +
        "Blocked with BACKUP_REQUIRED until the seed backup is exported and confirmed (§2.9). Moves no money.",
      inputSchema: s.getAddressInput,
      outputSchema: s.getAddressOutput,
      annotations: read,
    },
    (args) => run(() => getAddressTool(wallet, args as { index?: number })),
  );

  server.registerTool(
    "wallet_get_balances",
    {
      title: "Get balances",
      description:
        "Return confirmed on-chain balances for DePix, L-BTC and USDt in base units (sats, as strings), plus a total " +
        "BRL-cent estimate (null if a needed quote is unavailable). Moves no money.",
      inputSchema: s.getBalancesInput,
      outputSchema: s.getBalancesOutput,
      annotations: read,
    },
    () => run(() => getBalancesTool(wallet)),
  );

  server.registerTool(
    "wallet_list_transactions",
    {
      title: "List transactions",
      description:
        "Return the wallet's transaction history (txid, height, timestamp, type, network fee and per-asset balance " +
        "deltas in base units). Moves no money.",
      inputSchema: s.listTransactionsInput,
      outputSchema: s.listTransactionsOutput,
      annotations: read,
    },
    () => run(() => listTransactionsTool(wallet)),
  );

  server.registerTool(
    "wallet_send",
    {
      title: "Send Liquid asset",
      description:
        "Sign and broadcast a Liquid send of DePix/L-BTC/USDt to an address. amount_sats is BASE UNITS. " +
        "MOVES MONEY: passes through the owner's guardrails (per-tx + rolling-24h BRL caps; allowlist if enabled) " +
        "BEFORE signing. Irreversible once broadcast.",
      inputSchema: s.sendInput,
      outputSchema: s.sendOutput,
      annotations: money,
    },
    (args) =>
      run(() => sendTool(wallet, args as { asset: "DEPIX" | "LBTC" | "USDT"; amount_sats: string; address: string })),
  );

  server.registerTool(
    "wallet_create_deposit",
    {
      title: "Create Pix deposit",
      description:
        "Create a Pix deposit charge, returning a copy-and-paste (BR Code) the human OWNER pays to fund this wallet " +
        "with DePix. amount_cents is BRL cents; payer_tax_number is the PAYER's CPF/CNPJ. Not a checkout QR. " +
        "Creates a charge but moves no money itself.",
      inputSchema: s.createDepositInput,
      outputSchema: s.createDepositOutput,
      annotations: write,
    },
    (args) => runKeyed(() => createDepositTool(wallet, args as { amount_cents: number; payer_tax_number: string })),
  );

  server.registerTool(
    "wallet_wait_deposit",
    {
      title: "Wait for deposit",
      description:
        "Poll a deposit until it reaches a terminal status (success is depix_sent). Bounded by timeout_seconds " +
        `(default ${s.DEFAULT_WAIT_SECONDS}, hard ceiling ${MAX_WAIT_SECONDS_CEILING}). Moves no money.`,
      inputSchema: s.waitInput(maxWaitSeconds),
      outputSchema: s.statusReadOutput,
      annotations: read,
    },
    (args) =>
      runKeyed(() =>
        waitDepositTool(
          wallet,
          args as { id: string; interval_seconds?: number; timeout_seconds?: number },
          maxWaitSeconds,
        ),
      ),
  );

  server.registerTool(
    "wallet_create_withdrawal",
    {
      title: "Create Pix withdrawal",
      description:
        "Withdraw to a Pix key: build ONE Liquid transaction (Eulen output + explicit fee output), sign and broadcast. " +
        "amount_cents is BRL cents; mode `send` = the DePix you send, `payout` = the BRL the recipient receives; " +
        "recipient_tax_number is the DESTINATION Pix key holder's CPF/CNPJ. MOVES MONEY: passes through guardrails on " +
        "the GROSS before signing. Irreversible once broadcast.",
      inputSchema: s.createWithdrawalInput,
      outputSchema: s.createWithdrawalOutput,
      annotations: money,
    },
    (args) =>
      runKeyed(() =>
        createWithdrawalTool(
          wallet,
          args as {
            pix_key: string;
            recipient_tax_number: string;
            amount_cents: number;
            mode: "send" | "payout";
          },
        ),
      ),
  );

  server.registerTool(
    "wallet_wait_withdrawal",
    {
      title: "Wait for withdrawal",
      description:
        "Poll a withdrawal until terminal (success is sent; sandbox is confirmed). Bounded by timeout_seconds " +
        `(default ${s.DEFAULT_WAIT_SECONDS}, hard ceiling ${MAX_WAIT_SECONDS_CEILING}). Moves no money.`,
      inputSchema: s.waitInput(maxWaitSeconds),
      outputSchema: s.statusReadOutput,
      annotations: read,
    },
    (args) =>
      runKeyed(() =>
        waitWithdrawalTool(
          wallet,
          args as { id: string; interval_seconds?: number; timeout_seconds?: number },
          maxWaitSeconds,
        ),
      ),
  );

  server.registerTool(
    "wallet_get_guardrails",
    {
      title: "Get guardrails",
      description:
        "Read the owner's guardrail config and current rolling-24h usage (caps in BRL cents, used, remaining, whether " +
        "the allowlist is on). Read-only — guardrails are immutable at runtime and no tool can change them (G9).",
      inputSchema: s.getGuardrailsInput,
      outputSchema: s.getGuardrailsOutput,
      annotations: read,
    },
    () => run(() => getGuardrailsTool(wallet)),
  );

  // ── fast-follow: conversions + gift cards (§6.2 fast-follow, §5). Client-direct
  // providers (SideSwap/Boltz/CryptoRefills) — NOT gated on DEPIX_API_KEY. ──

  server.registerTool(
    "wallet_swap_quote",
    {
      title: "Quote a SideSwap market swap",
      description:
        "Get a live SideSwap market-swap quote between DePix, L-BTC and USDt (NON-custodial — the swap pays back into " +
        "your OWN wallet). Returns a single-use swap_quote_id to pass to wallet_swap_execute before expires_at_ms. " +
        "amount_sats and the quoted amounts are BASE UNITS. Opens a short-lived quote socket held server-side until you " +
        "execute, it expires, or the server shuts down. Moves no money by itself.",
      inputSchema: s.swapQuoteInput,
      outputSchema: s.swapQuoteOutput,
      annotations: write,
    },
    (args) =>
      run(() =>
        swapQuoteTool(
          wallet,
          swapStreams,
          args as { from: AssetKey; to: AssetKey; amount_sats: string; timeout_seconds?: number },
        ),
      ),
  );

  server.registerTool(
    "wallet_swap_execute",
    {
      title: "Execute a SideSwap quote",
      description:
        "Execute a quote from wallet_swap_quote by its swap_quote_id (must run before the quote expires). MOVES MONEY: " +
        "validates the swap PSET pays your own receive address, signs, and lets SideSwap broadcast. Passes the SENT side " +
        "through the owner's value guardrails BEFORE signing (market swaps are allowlist-exempt — funds return to your " +
        "wallet). Irreversible once broadcast.",
      inputSchema: s.swapExecuteInput,
      outputSchema: s.swapExecuteOutput,
      annotations: money,
    },
    (args) => run(() => swapExecuteTool(swapStreams, args as { swap_quote_id: string })),
  );

  server.registerTool(
    "wallet_pay_lightning_invoice",
    {
      title: "Pay a Lightning invoice",
      description:
        "Pay a BOLT11 Lightning invoice by locking L-BTC via a Boltz submarine swap (NON-custodial; L-BTC only, never " +
        "DePix). MOVES MONEY: the L-BTC lockup passes through the owner's guardrails (value caps; the Lightning payee is " +
        "checked against the allowlist when it is enabled) BEFORE signing. Returns once the lockup is broadcast; Boltz " +
        "then pays the invoice, or the lockup auto-refunds on failure (watched in the background, cancelled cleanly on " +
        "shutdown). Amounts are base units (sats).",
      inputSchema: s.payLightningInvoiceInput,
      outputSchema: s.payLightningInvoiceOutput,
      annotations: money,
    },
    (args) => run(() => payLightningInvoiceTool(wallet, args as { invoice: string })),
  );

  server.registerTool(
    "wallet_receive_lightning",
    {
      title: "Receive over Lightning",
      description:
        "Receive over Lightning INTO this wallet via a Boltz reverse swap (NON-custodial). Returns a BOLT11 invoice for " +
        "a payer to pay; once paid, the L-BTC is claimed into your wallet in the background (watched, cancelled cleanly " +
        "on shutdown). An INFLOW — no guardrail. amount_sats is base units.",
      inputSchema: s.receiveLightningInput,
      outputSchema: s.receiveLightningOutput,
      annotations: write,
    },
    (args) => run(() => receiveLightningTool(wallet, args as { amount_sats: string })),
  );

  server.registerTool(
    "wallet_to_stablecoin",
    {
      title: "Convert L-BTC to USDC/USDT",
      description:
        "Convert L-BTC to USDC/USDT delivered to an external EVM or Tron address via a Boltz chain swap (NON-custodial " +
        "on the Liquid side; the L-BTC lockup is refundable). MOVES MONEY: the L-BTC lockup passes through the owner's " +
        "guardrails (value caps; the destination claim_address is checked against the allowlist when it is enabled) " +
        "BEFORE signing. The EVM legs run in the background after funding. amount_sats is L-BTC base units.",
      inputSchema: s.toStablecoinInput,
      outputSchema: s.toStablecoinOutput,
      annotations: money,
    },
    (args) =>
      run(() =>
        toStablecoinTool(
          wallet,
          args as { asset: StablecoinAsset; network_id: string; amount_sats: string; claim_address: string },
        ),
      ),
  );

  server.registerTool(
    "wallet_buy_giftcard",
    {
      title: "Buy a gift card",
      description:
        "Buy a gift card or mobile top-up from CryptoRefills and pay it over Lightning via Boltz (NON-custodial). MOVES " +
        "MONEY: the L-BTC lockup passes through the owner's guardrails (value caps; with the allowlist on, BOTH the " +
        "Lightning payee AND the gift-card beneficiary must be opted in) BEFORE signing, plus a 1% DePix service fee. " +
        "Delivery goes to `email` (or beneficiary_account). Returns once the lockup is broadcast; Boltz then pays the " +
        "invoice in the background. Amounts are base units (sats).",
      inputSchema: s.buyGiftcardInput,
      outputSchema: s.buyGiftcardOutput,
      annotations: money,
    },
    (args) =>
      run(() =>
        buyGiftcardTool(
          wallet,
          args as {
            brand_name: string;
            denomination: string;
            email: string;
            beneficiary_account?: string;
            country_code?: string;
            product_value?: string;
            quantity?: number;
            validate?: boolean;
          },
        ),
      ),
  );

  server.registerTool(
    "wallet_list_giftcard_orders",
    {
      title: "List gift-card orders",
      description:
        "List the locally tracked gift-card orders (newest first): order id, brand, denomination, beneficiary, amounts " +
        "and last-known phase. Read-only — no network, no config gate. Moves no money.",
      inputSchema: s.listGiftcardOrdersInput,
      outputSchema: s.listGiftcardOrdersOutput,
      annotations: read,
    },
    () => run(() => listGiftcardOrdersTool(wallet)),
  );

  return server;
}

function clampCeiling(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return MAX_WAIT_SECONDS_CEILING;
  return Math.min(Math.floor(value), MAX_WAIT_SECONDS_CEILING);
}
