// wallet.convert.boltz.* (spec §5.3 / §4.3) — wallet-level integration with the
// Boltz REST/WS client + verify-lockup INJECTED (no network, no WASM). Proves:
//   - the submarine lockup passes through the guardrail choke point valuing the
//     expectedAmount L-BTC in BRL;
//   - the allowlist gates the FINAL Lightning payee even when verify-lockup
//     PASSES (a protocol-bound lockup does NOT exempt the flow — §4.3);
//   - quotes fail CLOSED;
//   - resume() recovers refund (submarine) + claim (reverse) from boltz-swaps.json.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DepixWallet } from "../src/wallet.js";
import { BoltzConvert, type BoltzConvertDeps, type BoltzWalletContext } from "../src/convert/boltz/convert.js";
import type { BoltzClient } from "../src/convert/boltz/client.js";
import type { Logger } from "../src/logger.js";
import type {
  RefundDeps,
  RefundResult,
  SubmarineRefundRecord
} from "../src/convert/boltz/refund.js";
import { BoltzSwapStore, type StoredReverseSwap, type StoredSubmarineSwap } from "../src/convert/boltz/store.js";
import type { QuotesSource } from "../src/guardrails/quotes.js";
import type { GuardrailConfig } from "../src/guardrails/guardrails.js";
import { GuardrailError, isDepixSdkError } from "../src/errors.js";
import { TEST_INVOICE, TEST_PAYMENT_HASH } from "./support/boltz.js";
import { hex } from "@scure/base";

const PASSPHRASE = "correct-horse-battery-staple";
const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// A valid mainnet confidential address (golden addr[1]) — a fundable lockup target.
const LOCKUP_ADDRESS =
  "lq1qqfk0uw9vlmqlggzs7cxmw49x8ks37l87udspmpt3ssgxjrkqqlww63xvus3c5gaz89r2kd393c4fvurwxf06qj87y2kd3vsln";

const QUOTES: QuotesSource = { get: async () => ({ btcUsd: 100_000, usdBrl: 5 }) };
const NO_QUOTES: QuotesSource = { get: async () => null };

const SILENT_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const SALT_B64 = Buffer.from(new Uint8Array(16).fill(7)).toString("base64");

/** Fake BoltzClient with just the surface the flows drive. */
function fakeClient(over: Partial<Record<keyof BoltzClient, unknown>> = {}): BoltzClient {
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

/** Boltz deps: injected client + a verify-lockup that PASSES (attacker-invoice-agnostic). */
function boltzDeps(client: BoltzClient, verify = vi.fn(async () => {})): {
  deps: BoltzConvertDeps;
  verify: ReturnType<typeof vi.fn>;
} {
  return {
    deps: { client, verifyLockup: verify as unknown as BoltzConvertDeps["verifyLockup"] },
    verify
  };
}

let dataDir: string;
let wallet: DepixWallet;

afterEach(async () => {
  await wallet?.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
});

async function restore(opts: {
  quotes?: QuotesSource;
  guardrails?: GuardrailConfig;
  boltz?: BoltzConvertDeps;
}): Promise<DepixWallet> {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-boltz-conv-"));
  wallet = await DepixWallet.restore({
    dataDir,
    passphrase: PASSPHRASE,
    mnemonic: KNOWN_MNEMONIC,
    quotes: opts.quotes ?? QUOTES,
    ...(opts.guardrails ? { guardrails: opts.guardrails } : {}),
    ...(opts.boltz ? { boltz: opts.boltz } : {})
  });
  return wallet;
}

describe("payLightningInvoice — guardrail counts the expectedAmount in BRL (§4.3)", () => {
  it("BLOCKS when the L-BTC expectedAmount valued in BRL exceeds the per-tx cap", async () => {
    const { deps, verify } = boltzDeps(fakeClient());
    const w = await restore({ guardrails: { perTxLimitBrlCents: 1_000 }, boltz: deps }); // R$10 cap
    let caught: unknown;
    try {
      await w.convert.boltz.payLightningInvoice({ invoice: TEST_INVOICE });
    } catch (e) {
      caught = e;
    }
    expect(isDepixSdkError(caught, "GUARDRAIL_PER_TX_LIMIT")).toBe(true);
    // The counted value IS the expectedAmount valued in BRL: 10_000 sats × 100_000 × 5 = R$50.
    expect((caught as GuardrailError).details?.attemptedCents).toBe(5_000);
    expect(verify).toHaveBeenCalledTimes(1); // verify ran; the guardrail still blocked
    // Nothing funded → the record was rolled back.
    await expect(readFile(join(dataDir, "boltz-swaps.json"), "utf8")).resolves.toContain('"records": []');
  });

  it("PASSES the guardrail, then fails at build on an empty wallet (INSUFFICIENT_FUNDS)", async () => {
    const { deps } = boltzDeps(fakeClient());
    const w = await restore({ boltz: deps }); // default caps: R$100/tx, R$500/day > R$50
    await expect(
      w.convert.boltz.payLightningInvoice({ invoice: TEST_INVOICE })
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "INSUFFICIENT_FUNDS"));
    await expect(readFile(join(dataDir, "boltz-swaps.json"), "utf8")).resolves.toContain('"records": []');
  });
});

describe("payLightningInvoice — allowlist gates the Lightning payee even when verify-lockup passes (§4.3)", () => {
  it("BLOCKS with GUARDRAIL_ALLOWLIST_BLOCKED when allowLightning is not opted in", async () => {
    const { deps, verify } = boltzDeps(fakeClient());
    const w = await restore({
      guardrails: { allowlist: { enabled: true, allowLightning: false } },
      boltz: deps
    });
    let caught: unknown;
    try {
      await w.convert.boltz.payLightningInvoice({ invoice: TEST_INVOICE });
    } catch (e) {
      caught = e;
    }
    // verify-lockup PASSED (the lockup is provably bound to the supplied invoice),
    // yet the allowlist still blocks the agent-chosen payee — the whole point.
    expect(verify).toHaveBeenCalledTimes(1);
    expect(isDepixSdkError(caught, "GUARDRAIL_ALLOWLIST_BLOCKED")).toBe(true);
    expect((caught as GuardrailError).details?.class).toBe("lightning");
  });

  it("ALLOWS when allowLightning is opted in (then fails at build only for lack of funds)", async () => {
    const { deps } = boltzDeps(fakeClient());
    const w = await restore({
      guardrails: { allowlist: { enabled: true, allowLightning: true } },
      boltz: deps
    });
    await expect(
      w.convert.boltz.payLightningInvoice({ invoice: TEST_INVOICE })
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "INSUFFICIENT_FUNDS"));
  });
});

describe("payLightningInvoice — quotes fail closed (G6)", () => {
  it("BLOCKS with QUOTES_UNAVAILABLE when the L-BTC quote is unavailable", async () => {
    const { deps } = boltzDeps(fakeClient());
    const w = await restore({ quotes: NO_QUOTES, boltz: deps });
    await expect(
      w.convert.boltz.payLightningInvoice({ invoice: TEST_INVOICE })
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "QUOTES_UNAVAILABLE"));
  });
});

describe("payLightningInvoice — refund key survives a broadcast-stage lockup failure (§5.3)", () => {
  // The swap record is the SOLE holder of `refundPrivateKeyHex`. If lockupLbtc
  // fails AT/AFTER broadcast the L-BTC may already be locked to the Boltz Taproot
  // address, so the record MUST survive for resume()/refund — dropping it would
  // make a funded-but-unpaid lockup irrecoverable. The wallet flags a provably
  // pre-broadcast failure with `nothingLocked`; only then may the caller roll back.
  async function convertOver(lockupLbtc: BoltzWalletContext["lockupLbtc"]): Promise<{
    convert: BoltzConvert;
    store: BoltzSwapStore;
  }> {
    dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-boltz-conv-"));
    const store = new BoltzSwapStore({ dataDir, passphrase: PASSPHRASE, saltB64: SALT_B64 });
    const ctx: BoltzWalletContext = {
      store,
      logger: SILENT_LOGGER,
      lockupLbtc,
      getReceiveAddress: async () => LOCKUP_ADDRESS
    };
    const convert = new BoltzConvert(ctx, { client: fakeClient(), verifyLockup: vi.fn(async () => {}) });
    return { convert, store };
  }

  it("PRESERVES the record + refund key when lockupLbtc fails at/after broadcast (no `nothingLocked`)", async () => {
    // Simulates syncEngine.broadcast() rejecting AFTER the tx propagated: an error
    // with NO `nothingLocked` marker — the lockup may be live.
    const broadcastErr = new Error("network reset after the node accepted the tx");
    const { convert, store } = await convertOver(async () => {
      throw broadcastErr;
    });

    await expect(convert.payLightningInvoice({ invoice: TEST_INVOICE })).rejects.toBe(broadcastErr);

    const rec = (await store.get("sub-1")) as StoredSubmarineSwap | null;
    expect(rec).not.toBeNull();
    // The refund material is intact — resume()/refund can still recover the L-BTC.
    expect(rec!.refundPrivateKeyHex).toBeTruthy();
    expect(rec!.type).toBe("submarine");
  });

  it("ROLLS BACK the record only when the failure is provably pre-broadcast (`nothingLocked`)", async () => {
    // Mirrors a guardrail/build failure the wallet tags as pre-broadcast.
    const preBroadcastErr = Object.assign(new Error("guardrail blocked before signing"), {
      nothingLocked: true
    });
    const { convert, store } = await convertOver(async () => {
      throw preBroadcastErr;
    });

    await expect(convert.payLightningInvoice({ invoice: TEST_INVOICE })).rejects.toBe(preBroadcastErr);
    // Nothing was locked → no orphan record for resume to act on.
    expect(await store.get("sub-1")).toBeNull();
  });
});

describe("receiveLightning — returns the invoice for the payer (INFLOW, no guardrail)", () => {
  it("creates a reverse swap and surfaces the bound invoice", async () => {
    const client = fakeClient();
    const deps: BoltzConvertDeps = {
      client,
      getReversePairHash: async () => "rev-pair",
      deriveSecrets: () => ({
        preimage: new Uint8Array(32).fill(9),
        preimageHash: hex.decode(TEST_PAYMENT_HASH), // matches TEST_INVOICE
        claimKeys: { privateKey: new Uint8Array(32).fill(1), publicKey: new Uint8Array(33).fill(2) }
      }),
      reverseCreate: async () => ({
        id: "rev-1",
        invoice: TEST_INVOICE,
        lockupAddress: "lq1revlockup",
        onchainAmount: 200_000,
        swapTree: {},
        refundPublicKey: "03" + "cc".repeat(32),
        blindingKey: "dd".repeat(32),
        timeoutBlockHeight: 1_000_100
      })
    };
    const w = await restore({ boltz: deps });
    const res = await w.convert.boltz.receiveLightning({ amountSats: 250_000 });
    expect(res.swapId).toBe("rev-1");
    expect(res.invoice).toBe(TEST_INVOICE);
    expect(res.lockupAddress).toBe("lq1revlockup");
    res.completion.catch(() => {}); // pending forever in this test — don't leak
  });
});

describe("close() cancels in-flight Boltz watches (§5.3 resource hygiene)", () => {
  it("tears down a reverse claim watch's subscription (status socket + reconnect timer) on close()", async () => {
    const unsubscribe = vi.fn();
    const subscribeSwap = vi.fn(() => unsubscribe);
    const client = fakeClient({ subscribeSwap });
    const deps: BoltzConvertDeps = {
      client,
      getReversePairHash: async () => "rev-pair",
      deriveSecrets: () => ({
        preimage: new Uint8Array(32).fill(9),
        preimageHash: hex.decode(TEST_PAYMENT_HASH),
        claimKeys: { privateKey: new Uint8Array(32).fill(1), publicKey: new Uint8Array(33).fill(2) }
      }),
      reverseCreate: async () => ({
        id: "rev-1",
        invoice: TEST_INVOICE,
        lockupAddress: "lq1revlockup",
        onchainAmount: 200_000,
        swapTree: {},
        refundPublicKey: "03" + "cc".repeat(32),
        blindingKey: "dd".repeat(32),
        timeoutBlockHeight: 1_000_100
      })
    };
    const w = await restore({ boltz: deps });
    const res = await w.convert.boltz.receiveLightning({ amountSats: 250_000 });
    res.completion.catch(() => {}); // stays pending after close — must not surface as unhandled

    // The watch is live: it subscribed (a real status WebSocket + reconnect timer
    // in prod) and nothing has torn it down yet.
    expect(subscribeSwap).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();

    await w.close();
    // close() disposed the namespace → the subscription (socket + timer) is gone.
    // Without this, a closed wallet keeps reconnecting to Boltz forever.
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("resume() — recovers claim/refund from boltz-swaps.json after a crash (§5.3)", () => {
  it("refunds an expired submarine lockup and re-attaches a reverse claim watch", async () => {
    const refundSpy = vi.fn<(record: SubmarineRefundRecord, deps: RefundDeps) => Promise<RefundResult>>(
      async () => ({ refundTxId: "refund-txid", cooperative: true })
    );
    const client = fakeClient({ getSwapStatus: async () => ({ status: "swap.expired" }) });
    const deps: BoltzConvertDeps = {
      client,
      refundSubmarine: refundSpy as unknown as BoltzConvertDeps["refundSubmarine"]
    };
    const w = await restore({ boltz: deps });

    // Pre-seed boltz-swaps.json (a crash left in-flight swaps) using the wallet's
    // OWN salt, so the wallet's store can authenticate them.
    const walletFile = JSON.parse(await readFile(join(dataDir, "wallet.json"), "utf8")) as { salt: string };
    const store = new BoltzSwapStore({ dataDir, passphrase: PASSPHRASE, saltB64: walletFile.salt });
    const sub: StoredSubmarineSwap = {
      type: "submarine",
      swapId: "sub-1",
      invoice: TEST_INVOICE,
      lockupAddress: LOCKUP_ADDRESS,
      expectedAmountSats: 10_000,
      invoiceSats: 250_000,
      swapTree: { claimLeaf: {}, refundLeaf: {} },
      claimPublicKey: "03" + "cc".repeat(32),
      blindingKey: "dd".repeat(32),
      timeoutBlockHeight: 1_000_100,
      refundPrivateKeyHex: "aa".repeat(32),
      refundPublicKeyHex: "02" + "bb".repeat(32),
      state: "locked_up",
      createdAt: 0
    };
    const rev: StoredReverseSwap = {
      type: "reverse",
      swapId: "rev-1",
      invoice: TEST_INVOICE,
      lockupAddress: "lq1revlockup",
      onchainAmount: 200_000,
      swapTree: {},
      refundPublicKey: "03" + "ee".repeat(32),
      timeoutBlockHeight: 1_000_200,
      claimAddress: "lq1claim",
      preimageHex: "ff".repeat(32),
      claimPublicKeyHex: "02" + "11".repeat(32),
      claimPrivateKeyHex: "22".repeat(32),
      state: "awaiting_payment",
      createdAt: 0
    };
    await store.put(sub);
    await store.put(rev);

    const summary = await w.convert.boltz.resume();
    expect(summary.submarineRefunded).toBe(1);
    expect(summary.reverseResumed).toBe(1);
    // The injected refund saw the persisted refund material (survived the crash).
    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect(refundSpy.mock.calls[0]![0]).toMatchObject({
      swapId: "sub-1",
      refundPrivateKeyHex: "aa".repeat(32),
      claimPublicKey: "03" + "cc".repeat(32)
    });
    // The refunded submarine record is gone; the reverse watch is still in flight.
    expect(await store.get("sub-1")).toBeNull();
    expect(await store.get("rev-1")).not.toBeNull();
  });

  it("discards a tampered record instead of acting on it", async () => {
    const client = fakeClient();
    const w = await restore({ boltz: { client } });
    const walletFile = JSON.parse(await readFile(join(dataDir, "wallet.json"), "utf8")) as { salt: string };
    const store = new BoltzSwapStore({ dataDir, passphrase: PASSPHRASE, saltB64: walletFile.salt });
    await store.put({
      type: "submarine",
      swapId: "sub-x",
      invoice: TEST_INVOICE,
      lockupAddress: LOCKUP_ADDRESS,
      expectedAmountSats: 10_000,
      invoiceSats: 250_000,
      swapTree: {},
      claimPublicKey: "03" + "cc".repeat(32),
      timeoutBlockHeight: 1_000_100,
      refundPrivateKeyHex: "aa".repeat(32),
      refundPublicKeyHex: "02" + "bb".repeat(32),
      state: "locked_up",
      createdAt: 0
    });
    // Corrupt the ciphertext.
    const path = join(dataDir, "boltz-swaps.json");
    const file = JSON.parse(await readFile(path, "utf8")) as { records: { ct: string }[] };
    const ct = file.records[0]!.ct;
    file.records[0]!.ct = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    await (await import("node:fs/promises")).writeFile(path, JSON.stringify(file));

    const summary = await w.convert.boltz.resume();
    expect(summary.discarded).toBe(1);
    expect(await store.count()).toBe(0);
  });
});
