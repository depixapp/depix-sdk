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
import { ToolError, mapToolError } from "./errors.js";
import { defaultLogger as logger } from "../logger.js";
import * as s from "./schemas.js";
import { MAX_WAIT_SECONDS_CEILING } from "./schemas.js";
import {
  createDepositTool,
  createWithdrawalTool,
  getAddressTool,
  getBalancesTool,
  getGuardrailsTool,
  listTransactionsTool,
  sendTool,
  statusTool,
  waitDepositTool,
  waitWithdrawalTool,
  type McpWalletFacade,
  type ToolContext,
} from "./tools.js";

export const SERVER_NAME = "com.depixapp/wallet";
export const SERVER_TITLE = "DePix Wallet";
export const DEFAULT_SERVER_VERSION = "1.0.0";

/** The exact MVP catalog (§6.2), prefixed `wallet_` (G10). Exported for tests/docs. */
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

  const server = new McpServer(
    { name: SERVER_NAME, title: SERVER_TITLE, version: opts.version ?? DEFAULT_SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

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
    (args) => run(() => createDepositTool(wallet, args as { amount_cents: number; payer_tax_number: string })),
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
      run(() =>
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
      run(() =>
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
      run(() =>
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

  return server;
}

function clampCeiling(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return MAX_WAIT_SECONDS_CEILING;
  return Math.min(Math.floor(value), MAX_WAIT_SECONDS_CEILING);
}
