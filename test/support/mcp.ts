// Test doubles for the local wallet MCP facade suites (not a *.test.ts).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWalletMcpServer, type CreateWalletMcpServerOptions } from "../../src/mcp/server.js";
import type { McpWalletFacade } from "../../src/mcp/tools.js";
import type {
  DepositParams,
  DepositResult,
  GuardrailReadout,
  SendParams,
  SendResult,
  WalletBalances,
  WalletTransaction,
  WithdrawParams,
  WithdrawResult,
} from "../../src/wallet.js";
import type { StatusReadResponse } from "../../src/api/client.js";
import type { WaitOptions } from "../../src/flows/status.js";

export interface RecordedCall {
  method: keyof McpWalletFacade;
  args: unknown[];
}

/**
 * A configurable in-memory McpWalletFacade. Every call is recorded; return
 * values are preset public fields; an entry in `throws` makes that method reject
 * with the given error (to exercise mapToolError).
 */
export class FakeWallet implements McpWalletFacade {
  calls: RecordedCall[] = [];
  throws: Partial<Record<keyof McpWalletFacade, unknown>> = {};

  backupConfirmed = true;
  guardrails: GuardrailReadout = {
    usedCents: 12_000,
    dailyLimitCents: 50_000,
    perTxLimitCents: 10_000,
    remainingCents: 38_000,
    allowlistEnabled: false,
  };
  address = "lq1qqfakeaddressfortesting0000000000000000000000000000000000000000";
  balancesValue: WalletBalances = {
    balances: { DEPIX: 1_500_000n, LBTC: 4_200n, USDT: 0n },
    brlEstimate: 15_042,
  };
  transactionsValue: WalletTransaction[] = [
    {
      txid: "aa".repeat(32),
      height: 3_000_000,
      timestamp: 1_720_000_000,
      type: "incoming",
      feeSats: 26n,
      balance: { DEPIX: 1_500_000n, LBTC: -26n },
    },
  ];
  sendResult: SendResult = { txid: "bb".repeat(32) };
  depositResult: DepositResult = { id: "dep_1", qrCopyPaste: "00020126-QR" };
  withdrawResult: WithdrawResult = {
    withdrawalId: "wd_1",
    txid: "cc".repeat(32),
    feeCents: 100,
    feeAddress: "ex1qfee",
    netCents: 9_900,
    grossCents: 10_000,
    payoutCents: 9_800,
  };
  depositStatus: StatusReadResponse = {
    id: "dep_1",
    type: "deposit",
    amount_cents: 1_000,
    status: "depix_sent",
    created_at: "2026-07-10 12:00:00",
    updated_at: "2026-07-10 12:01:00",
    rejection_reasons: [],
  };
  withdrawStatus: StatusReadResponse = {
    id: "wd_1",
    type: "withdraw",
    amount_cents: 10_000,
    status: "sent",
    created_at: "2026-07-10 12:00:00",
    updated_at: "2026-07-10 12:02:00",
    liquid_txid: "cc".repeat(32),
  };
  lastWaitOptions?: WaitOptions;

  private rec(method: keyof McpWalletFacade, args: unknown[]): void {
    this.calls.push({ method, args });
    if (method in this.throws) throw this.throws[method];
  }

  isBackupConfirmed(): boolean {
    this.rec("isBackupConfirmed", []);
    return this.backupConfirmed;
  }
  async getGuardrails(): Promise<GuardrailReadout> {
    this.rec("getGuardrails", []);
    return this.guardrails;
  }
  async getReceiveAddress(options?: { index?: number }): Promise<string> {
    this.rec("getReceiveAddress", [options]);
    return this.address;
  }
  async getBalances(): Promise<WalletBalances> {
    this.rec("getBalances", []);
    return this.balancesValue;
  }
  async listTransactions(): Promise<WalletTransaction[]> {
    this.rec("listTransactions", []);
    return this.transactionsValue;
  }
  async send(params: SendParams): Promise<SendResult> {
    this.rec("send", [params]);
    return this.sendResult;
  }
  async deposit(params: DepositParams): Promise<DepositResult> {
    this.rec("deposit", [params]);
    return this.depositResult;
  }
  async withdraw(params: WithdrawParams): Promise<WithdrawResult> {
    this.rec("withdraw", [params]);
    return this.withdrawResult;
  }
  async waitForDeposit(id: string, options?: WaitOptions): Promise<StatusReadResponse> {
    this.rec("waitForDeposit", [id, options]);
    this.lastWaitOptions = options;
    return this.depositStatus;
  }
  async waitForWithdrawal(id: string, options?: WaitOptions): Promise<StatusReadResponse> {
    this.rec("waitForWithdrawal", [id, options]);
    this.lastWaitOptions = options;
    return this.withdrawStatus;
  }

  /** Convenience: find the args of the last recorded call to `method`. */
  lastArgs(method: keyof McpWalletFacade): unknown[] | undefined {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      if (this.calls[i]!.method === method) return this.calls[i]!.args;
    }
    return undefined;
  }
}

/** Connect an MCP Client to a wallet server over an in-memory transport. */
export async function connectWallet(
  opts: Partial<CreateWalletMcpServerOptions> & { wallet: McpWalletFacade },
): Promise<{ client: Client; server: ReturnType<typeof createWalletMcpServer> }> {
  const server = createWalletMcpServer({
    keyMode: "test",
    apiKeyConfigured: true,
    ...opts,
  });
  const client = new Client({ name: "test-host", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, server };
}

/** Parse the structured error payload from an isError tool result. */
export function errorPayload(result: {
  content: Array<{ type: string; text?: string }>;
}): { error: { code: string; retryable?: boolean; [k: string]: unknown } } {
  const jsonBlock = result.content.find((c) => c.type === "text" && c.text?.trim().startsWith("{"));
  return JSON.parse(jsonBlock!.text!) as {
    error: { code: string; retryable?: boolean; [k: string]: unknown };
  };
}

/** The message block of an isError tool result (the canned prose). */
export function errorMessage(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.text ?? "";
}
