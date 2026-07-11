// Test doubles for the local wallet MCP facade suites (not a *.test.ts).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWalletMcpServer, type CreateWalletMcpServerOptions } from "../../src/mcp/server.js";
import type {
  McpBoltzFacade,
  McpConvertFacade,
  McpGiftcardsFacade,
  McpSideshiftFacade,
  McpWalletFacade,
} from "../../src/mcp/tools.js";
import type { McpSwapQuoteStream } from "../../src/mcp/swap-streams.js";
import type {
  DepositParams,
  DepositResult,
  GuardrailReadout,
  PendingItem,
  RecoverySummary,
  SendParams,
  SendResult,
  WalletBalances,
  WalletDiagnostics,
  WalletTransaction,
  WithdrawParams,
  WithdrawResult,
} from "../../src/wallet.js";
import type { StatusReadResponse } from "../../src/api/client.js";
import type { WaitOptions } from "../../src/flows/status.js";
import type {
  PayLightningResult,
  ReceiveLightningResult,
  ToStablecoinResult,
} from "../../src/convert/boltz/convert.js";
import type { StablecoinParams } from "../../src/convert/boltz/stablecoin.js";
import type { ConvertParams, ConvertResult, RouteQuote } from "../../src/convert/intent.js";
import type { ConvertIntent, Route } from "../../src/convert/routes.js";
import type { SideSwapQuote, SwapExecuteResult, SwapQuoteParams } from "../../src/convert/sideswap.js";
import type { SideShiftSendResult } from "../../src/convert/sideshift.js";
import type { BuyGiftcardParams, BuyGiftcardResult } from "../../src/giftcards/namespace.js";
import type { StoredGiftcardOrder } from "../../src/giftcards/store.js";

export interface RecordedCall {
  method: keyof McpWalletFacade;
  args: unknown[];
}

/** A fake SideSwap quote stream: records next/execute/close, no real socket. */
export class FakeSwapStream implements McpSwapQuoteStream {
  closed = 0;
  nextCalls = 0;
  executeCalls = 0;
  constructor(
    public quote: SideSwapQuote,
    public execResult: SwapExecuteResult,
    public opts: { nextError?: unknown; executeError?: unknown } = {},
  ) {}
  async next(): Promise<SideSwapQuote> {
    this.nextCalls++;
    if (this.opts.nextError) throw this.opts.nextError;
    return this.quote;
  }
  async execute(): Promise<SwapExecuteResult> {
    this.executeCalls++;
    if (this.opts.executeError) throw this.opts.executeError;
    return this.execResult;
  }
  close(): void {
    this.closed++;
  }
}

function defaultQuote(): SideSwapQuote {
  return {
    quoteId: 42,
    from: "DEPIX",
    to: "LBTC",
    sendAmountSats: 100_000n,
    recvAmountSats: 900n,
    serverFeeSats: 5n,
    fixedFeeSats: 26n,
    feeAsset: null,
    ttlMs: 20_000,
    expiresAt: Date.now() + 20_000,
    receiveAddress: "lq1qrecv",
  };
}

/** Configurable wallet.convert fake (SideSwap stream + Boltz namespace). */
export class FakeConvert implements McpConvertFacade {
  swapQuoteCalls: SwapQuoteParams[] = [];
  boltzCalls: Array<{ method: string; args: unknown }> = [];
  stream = new FakeSwapStream(defaultQuote(), {
    txid: "swap".padEnd(64, "0"),
    from: "DEPIX",
    to: "LBTC",
    sendAmountSats: 100_000n,
    recvAmountSats: 900n,
    brlCents: 10_000,
  });
  quoteError?: unknown;
  /** When set, the `boltz` GETTER throws (view-only/wiped wallet parity). */
  boltzThrows?: unknown;
  boltzMethodThrows: Partial<Record<"payLightningInvoice" | "receiveLightning" | "toStablecoin", unknown>> = {};

  payResult: PayLightningResult = {
    swapId: "sub_1",
    lockupTxid: "lock".padEnd(64, "0"),
    expectedAmountSats: 90_000,
    invoiceSats: 89_000,
    invoice: "lnbc890...",
    completion: Promise.resolve({ swapId: "sub_1", status: "paid" }),
  };
  receiveResult: ReceiveLightningResult = {
    swapId: "rev_1",
    invoice: "lnbc50...",
    lockupAddress: "lq1qlockup",
    amountSats: 50_000,
    // The tools never read completion; keep the fake free of ReverseOutcome plumbing.
    completion: Promise.resolve(null as never),
  };
  stablecoinResult: ToStablecoinResult = {
    swapId: "chain_1",
    lockupTxid: "clk".padEnd(64, "0"),
    lockAmountSats: 120_000,
    asset: "USDC",
    networkId: "polygon",
    claimAddress: "0xrecipient",
    completion: Promise.resolve({ swapId: "chain_1", status: "settled" }),
  };

  readonly sideswap = {
    quote: async (params: SwapQuoteParams): Promise<McpSwapQuoteStream> => {
      this.swapQuoteCalls.push(params);
      if (this.quoteError) throw this.quoteError;
      return this.stream;
    },
  };

  private readonly boltzImpl: McpBoltzFacade = {
    payLightningInvoice: async (params: { invoice: string }): Promise<PayLightningResult> => {
      this.boltzCalls.push({ method: "payLightningInvoice", args: params });
      if (this.boltzMethodThrows.payLightningInvoice) throw this.boltzMethodThrows.payLightningInvoice;
      return this.payResult;
    },
    receiveLightning: async (params: { amountSats: number }): Promise<ReceiveLightningResult> => {
      this.boltzCalls.push({ method: "receiveLightning", args: params });
      if (this.boltzMethodThrows.receiveLightning) throw this.boltzMethodThrows.receiveLightning;
      return this.receiveResult;
    },
    toStablecoin: async (params: StablecoinParams): Promise<ToStablecoinResult> => {
      this.boltzCalls.push({ method: "toStablecoin", args: params });
      if (this.boltzMethodThrows.toStablecoin) throw this.boltzMethodThrows.toStablecoin;
      return this.stablecoinResult;
    },
  };

  get boltz(): McpBoltzFacade {
    if (this.boltzThrows) throw this.boltzThrows;
    return this.boltzImpl;
  }

  sideshiftSendCalls: Array<{ network: string; amountSats: bigint; settleAddress: string; refundAddress?: string }> = [];
  sideshiftError?: unknown;
  sideshiftSendResult: SideShiftSendResult = {
    shiftId: "shift_1",
    network: "tron",
    depositAddress: "lq1qshiftdeposit",
    settleAddress: "TXYZrecipientaddressbase58check000000000",
    refundAddress: null,
    depositAmountSats: 1_000_000_000n,
    settleAmount: "9.9",
    status: "waiting",
    txid: "sh".repeat(32),
    brlCents: 5_000,
    custodial: true,
  };

  readonly sideshift: McpSideshiftFacade = {
    send: async (params): Promise<SideShiftSendResult> => {
      this.sideshiftSendCalls.push(params);
      if (this.sideshiftError) throw this.sideshiftError;
      return this.sideshiftSendResult;
    },
  };
}

/** Configurable wallet.giftcards fake. */
export class FakeGiftcards implements McpGiftcardsFacade {
  buyCalls: BuyGiftcardParams[] = [];
  buyError?: unknown;
  buyResult: BuyGiftcardResult = {
    orderId: "ord_1",
    invoice: "lnbc123...",
    swapId: "gc_sub_1",
    lockupTxid: "gclk".padEnd(64, "0"),
    invoiceSats: 25_000,
    feeSats: 250n,
    expectedAmountSats: 26_000,
    totalSats: 26_250n,
    beneficiaryAccount: "user@example.com",
    completion: Promise.resolve({ swapId: "gc_sub_1", status: "paid" }),
  };
  orders: StoredGiftcardOrder[] = [
    {
      orderId: "ord_1",
      brandName: "Amazon",
      denomination: "50",
      beneficiaryAccount: "user@example.com",
      invoice: "lnbc123...",
      invoiceSats: 25_000,
      feeSats: "250",
      expectedAmountSats: 26_000,
      swapId: "gc_sub_1",
      lockupTxid: "gclk".padEnd(64, "0"),
      phase: "pending",
      createdAt: 1_720_000_000_000,
      updatedAt: 1_720_000_050_000,
    },
  ];

  async buy(params: BuyGiftcardParams): Promise<BuyGiftcardResult> {
    this.buyCalls.push(params);
    if (this.buyError) throw this.buyError;
    return this.buyResult;
  }
  async listOrders(): Promise<StoredGiftcardOrder[]> {
    return this.orders;
  }
}

/**
 * A configurable in-memory McpWalletFacade. Every call is recorded; return
 * values are preset public fields; an entry in `throws` makes that method reject
 * with the given error (to exercise mapToolError).
 */
/** The single-hop route FakeWallet's intent fakes report. */
const FAKE_MARKET_ROUTE: Route = {
  id: "sideswap.swap:DEPIX@liquid>LBTC@liquid",
  hops: 1,
  custodial: false,
  legs: [
    {
      provider: "sideswap",
      method: "swap",
      from: "DEPIX",
      fromNetwork: "liquid",
      to: "LBTC",
      network: "liquid",
      custodial: false,
    },
  ],
};

export class FakeWallet implements McpWalletFacade {
  calls: RecordedCall[] = [];
  throws: Partial<Record<keyof McpWalletFacade, unknown>> = {};

  /**
   * wallet.convert fake backing the fast-follow tools AND — like the real
   * ConvertFacade — CALLABLE for wallet_convert. Property reads/writes proxy to
   * the FakeConvert instance so `wallet.convert.stream`/`.boltzThrows = …`
   * keep working; calling it records "convert" and returns `convertResult`.
   */
  readonly convert: McpWalletFacade["convert"] & FakeConvert;
  readonly giftcards = new FakeGiftcards();

  quoteResult: RouteQuote[] = [
    {
      id: FAKE_MARKET_ROUTE.id,
      hops: 1,
      custodial: false,
      estimatedReceivedSats: 900n,
      estimatedFeeTotalSats: 31n,
      feeAsset: "LBTC",
      estimateComplete: true,
      notes: [],
      legs: [
        {
          ...FAKE_MARKET_ROUTE.legs[0]!,
          estimatedReceivedSats: 900n,
          estimatedFeeSats: 31n,
          feeAsset: "LBTC",
        },
      ],
    },
  ];
  convertResult: ConvertResult = {
    route: FAKE_MARKET_ROUTE,
    status: "settled",
    txids: ["cv".repeat(32)],
    receivedSats: 900n,
    custodial: false,
  };

  constructor() {
    const state = new FakeConvert();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const callable = async (params: ConvertParams): Promise<ConvertResult> => {
      self.rec("convert", [params]);
      return self.convertResult;
    };
    this.convert = new Proxy(callable, {
      get(target, prop, receiver) {
        if (prop in state) return Reflect.get(state, prop);
        return Reflect.get(target, prop, receiver);
      },
      set(_target, prop, value) {
        (state as unknown as Record<PropertyKey, unknown>)[prop] = value;
        return true;
      },
      has(target, prop) {
        return prop in state || prop in target;
      },
    }) as McpWalletFacade["convert"] & FakeConvert;
  }

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
  recoverResult: RecoverySummary = {
    withdrawals: { resumed: 1, rebroadcast: 1, reposted: 0, discarded: 0, failed: 0 },
    boltz: {
      submarineResumed: 1,
      submarineRefunded: 0,
      reverseResumed: 1,
      stablecoinResumed: 0,
      stablecoinRefunded: 1,
      discarded: 0,
      removed: 2,
      failed: 0,
    },
    pegin: { pending: 1, cleared: 1, failed: 0 },
    sideshift: { checked: 2, refreshed: 2, failed: 0 },
    plans: { checked: 1, advanced: 1, completed: 1, needsReview: 0, discarded: 0, failed: 0 },
  };
  pendingItems: PendingItem[] = [
    {
      rail: "withdrawal",
      id: "idem-1",
      state: "signed",
      createdAt: 1_720_000_000_000,
      withdrawalId: "wd_1",
      txid: "cc".repeat(32),
    },
    { rail: "boltz", id: "sub_1", state: "locked_up", createdAt: 1_720_000_001_000, swapType: "submarine" },
    { rail: "pegin", id: "peg_1", state: "pending", createdAt: null, pegAddr: "bc1qpeg", recvAddr: "lq1qrecv" },
    {
      rail: "sideshift",
      id: "shift_1",
      state: "waiting",
      createdAt: 1_720_000_002_000,
      shiftType: "send",
      network: "tron",
    },
  ];
  diagnosticsResult: WalletDiagnostics = {
    sdkVersion: "1.0.0",
    lwkVersion: "0.18.0",
    dataDir: "/home/agent/.depix-wallet",
    backupConfirmed: true,
    hasSeed: true,
    apiKeyConfigured: true,
    sync: {
      lastScanAt: 1_720_000_100_000,
      lastSuccessAt: 1_720_000_100_000,
      lastPersistFailedAt: null,
      lastPersistErrorName: null,
      persistedUpdates: 3,
      walletLoaded: true,
    },
    pending: { withdrawals: 1, boltzSwaps: 2, pegins: 0, sideshiftShifts: 1, plans: 0 },
    guardrails: {
      usedCents: 12_000,
      dailyLimitCents: 50_000,
      perTxLimitCents: 10_000,
      remainingCents: 38_000,
      allowlistEnabled: false,
    },
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
  async recover(): Promise<RecoverySummary> {
    this.rec("recover", []);
    return this.recoverResult;
  }
  async getPending(): Promise<PendingItem[]> {
    this.rec("getPending", []);
    return this.pendingItems;
  }
  async diagnostics(): Promise<WalletDiagnostics> {
    this.rec("diagnostics", []);
    return this.diagnosticsResult;
  }
  async quote(params: ConvertIntent): Promise<RouteQuote[]> {
    this.rec("quote", [params]);
    return this.quoteResult;
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
