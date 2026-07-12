// wallet.convert.boltz.toStablecoin (spec §5.3 / §4.3, PR5b) — wallet-level
// integration with viem + the boltz-swaps route engine INJECTED (no network, no
// EVM RPC, no real gas). Proves:
//   - the L-BTC lockup passes through the guardrail choke point valuing the
//     lock amount in BRL;
//   - the allowlist gates the FINAL EVM settle address (`evmAddresses` class) even
//     though the lockup is protocol-bound (§4.3);
//   - quotes fail CLOSED (QUOTES_UNAVAILABLE);
//   - a guardrail rejection rolls the record back AND zeroes the ephemeral EVM key;
//   - the funded happy path drives claim → DEX → bridge with the gas-abstraction
//     (sponsor) signer and the ephemeral EVM key is zeroed;
//   - resume() refunds an expired chain lockup from boltz-swaps.json.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base58 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { DepixWallet } from "../src/wallet.js";
import {
  BoltzConvert,
  type BoltzConvertDeps,
  type BoltzWalletContext
} from "../src/convert/boltz/convert.js";
import type { BoltzClient } from "../src/convert/boltz/client.js";
import type { CreatedStablecoinRoute, LocalEvmSigner, LoadedViem } from "../src/convert/boltz/stablecoin.js";
import { BoltzSwapStore, type StoredStablecoinSwap } from "../src/convert/boltz/store.js";
import { RefundPendingError } from "../src/convert/boltz/refund.js";
import type { ChainRefundDeps, ChainRefundRecord, RefundResult } from "../src/convert/boltz/refund.js";
import type { QuotesSource } from "../src/guardrails/quotes.js";
import type { GuardrailConfig } from "../src/guardrails/guardrails.js";
import type { Logger } from "../src/logger.js";
import { GuardrailError, isDepixSdkError } from "../src/errors.js";

const PASSPHRASE = "correct-horse-battery-staple";
const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// A valid mainnet confidential address — a fundable L-BTC lockup target.
const LOCKUP_ADDRESS =
  "lq1qqfk0uw9vlmqlggzs7cxmw49x8ks37l87udspmpt3ssgxjrkqqlww63xvus3c5gaz89r2kd393c4fvurwxf06qj87y2kd3vsln";
const VALID_EVM = "0x1234567890AbcdEF1234567890aBcdef12345678";
/** A valid Tron base58check address (0x41 prefix + 20-byte payload + double-SHA256 checksum). */
function makeTronAddress(payload20: Uint8Array): string {
  const body = new Uint8Array(21);
  body[0] = 0x41;
  body.set(payload20, 1);
  const checksum = sha256(sha256(body)).slice(0, 4);
  const full = new Uint8Array(25);
  full.set(body, 0);
  full.set(checksum, 21);
  return base58.encode(full);
}
const VALID_TRON = makeTronAddress(new Uint8Array(20).fill(0x22));
const SALT_B64 = Buffer.from(new Uint8Array(16).fill(7)).toString("base64");
const SILENT_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const QUOTES: QuotesSource = { get: async () => ({ btcUsd: 100_000, usdBrl: 5 }) };
const NO_QUOTES: QuotesSource = { get: async () => null };

function fakeViem(): LoadedViem {
  return {
    viem: {
      createWalletClient: () => ({ tag: "wallet-client" }),
      createPublicClient: () => ({ tag: "public-client" }),
      http: () => ({ tag: "transport" }),
      isAddress: () => true
    },
    accounts: { privateKeyToAccount: () => ({ address: "0xEPHEMERALSIGNER0000000000000000000000000" }) }
  };
}

/** createRoute that echoes the requested amount and locks to a REAL Liquid address. */
function stablecoinCreateRoute(): (args: Record<string, unknown>) => Promise<CreatedStablecoinRoute> {
  return async (args) => ({
    createdSwap: {
      id: "chain-swap-1",
      lockupDetails: {
        lockupAddress: LOCKUP_ADDRESS,
        amount: (args.userLockAmount as number) ?? 10_000,
        timeoutBlockHeight: 1_000_050,
        swapTree: { chainLeaf: {} },
        serverPublicKey: "03" + "cc".repeat(32),
        blindingKey: "dd".repeat(32)
      }
    },
    plan: { legs: ["chain-swap", "dex", "bridge"] }
  });
}

// verify-lockup passes (attacker-invoice-agnostic — the allowlist is the gate).
const passVerify = vi.fn(async () => {}) as unknown as NonNullable<
  NonNullable<BoltzConvertDeps["stablecoin"]>["prepare"]
>["verifyLockup"];

/** Boltz deps with the stablecoin prepare fully faked; returns the captured EVM key. */
function stablecoinDeps(over: Partial<NonNullable<BoltzConvertDeps["stablecoin"]>> = {}): {
  deps: BoltzConvertDeps;
  evmKey: Uint8Array;
} {
  const evmKey = new Uint8Array(32).fill(0x42);
  const deps: BoltzConvertDeps = {
    client: fakeClient(),
    stablecoin: {
      prepare: {
        viemImporter: async () => fakeViem(),
        ensureConfig: async () => {},
        getPairs: async () => ({}),
        deriveKeys: () => ({
          preimage: new Uint8Array(32).fill(1),
          preimageHash: new Uint8Array(32).fill(2),
          refundPrivateKey: new Uint8Array(32).fill(3),
          refundPublicKey: new Uint8Array(33).fill(4),
          evmPrivateKey: evmKey
        }),
        createRoute: stablecoinCreateRoute(),
        isKnownTokenAddress: () => false,
        verifyLockup: passVerify,
        // Permissive economic pre-check (viem-free) — 10_000 sats is within bounds.
        estimate: async () => ({ minSats: 1000, maxSats: 100_000_000 })
      },
      ...over
    }
  };
  return { deps, evmKey };
}

/** A funded (locked_up) chain-swap record, ready for execute/resume. */
function baseStablecoinRecord(over: Partial<StoredStablecoinSwap> = {}): StoredStablecoinSwap {
  return {
    type: "stablecoin",
    swapId: "chain-swap-1",
    asset: "USDC",
    networkId: "arbitrum",
    claimAddress: VALID_EVM,
    lockupAddress: LOCKUP_ADDRESS,
    lockAmountSats: 10_000,
    serverPublicKey: "03" + "cc".repeat(32),
    swapTree: { chainLeaf: {} },
    blindingKey: "dd".repeat(32),
    timeoutBlockHeight: 1_000_050,
    refundPrivateKeyHex: "aa".repeat(32),
    refundPublicKeyHex: "02" + "bb".repeat(32),
    preimageHex: "ee".repeat(32),
    evmPrivateKeyHex: "ff".repeat(32),
    createdSwap: { id: "chain-swap-1" },
    plan: { legs: [] },
    state: "locked_up",
    createdAt: 0,
    ...over
  };
}

function fakeClient(over: Partial<Record<keyof BoltzClient, unknown>> = {}): BoltzClient {
  return {
    getChainHeight: async () => 1_000_000,
    getSwapStatus: async () => ({ status: "swap.created" }),
    subscribeSwap: () => () => {},
    ...over
  } as unknown as BoltzClient;
}

let dataDir: string;
let wallet: DepixWallet | undefined;

afterEach(async () => {
  await wallet?.close().catch(() => {});
  wallet = undefined;
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

async function restore(opts: {
  quotes?: QuotesSource;
  guardrails?: GuardrailConfig;
  boltz?: BoltzConvertDeps;
}): Promise<DepixWallet> {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-stable-"));
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

describe("toStablecoin — guardrail counts the L-BTC lock amount in BRL (§4.3)", () => {
  it("BLOCKS when the lock amount valued in BRL exceeds the per-tx cap, and zeroes the ephemeral EVM key", async () => {
    const { deps, evmKey } = stablecoinDeps();
    const w = await restore({ guardrails: { perTxLimitBrlCents: 1_000 }, boltz: deps }); // R$10 cap
    let caught: unknown;
    try {
      await w.convert.boltz.toStablecoin({ asset: "USDC", networkId: "arbitrum", amountSats: 10_000, claimAddress: VALID_EVM });
    } catch (e) {
      caught = e;
    }
    expect(isDepixSdkError(caught, "GUARDRAIL_PER_TX_LIMIT")).toBe(true);
    // 10_000 sats L-BTC × 100_000 USD/BTC × 5 BRL/USD = R$50 = 5000 cents.
    expect((caught as GuardrailError).details?.attemptedCents).toBe(5_000);
    // The ephemeral EVM key was zeroed (persisted encrypted; in-memory copy wiped).
    expect([...evmKey].every((b) => b === 0)).toBe(true);
    // Nothing funded → the record rolled back.
    await expect(readFile(join(dataDir, "boltz-swaps.json"), "utf8")).resolves.toContain('"records": []');
  });
});

describe("toStablecoin — allowlist gates the FINAL EVM settle address (§4.3)", () => {
  it("BLOCKS with GUARDRAIL_ALLOWLIST_BLOCKED (class evmAddress) when the EVM address is not allowlisted", async () => {
    const { deps } = stablecoinDeps();
    const w = await restore({
      guardrails: { allowlist: { enabled: true, evmAddresses: ["0x0000000000000000000000000000000000000000"] } },
      boltz: deps
    });
    let caught: unknown;
    try {
      await w.convert.boltz.toStablecoin({ asset: "USDC", networkId: "arbitrum", amountSats: 10_000, claimAddress: VALID_EVM });
    } catch (e) {
      caught = e;
    }
    expect(isDepixSdkError(caught, "GUARDRAIL_ALLOWLIST_BLOCKED")).toBe(true);
    expect((caught as GuardrailError).details?.class).toBe("evmAddress");
  });

  it("ALLOWS when the EVM address IS allowlisted (then fails at build only for lack of funds)", async () => {
    const { deps } = stablecoinDeps();
    const w = await restore({
      guardrails: { allowlist: { enabled: true, evmAddresses: [VALID_EVM] } },
      boltz: deps
    });
    await expect(
      w.convert.boltz.toStablecoin({ asset: "USDC", networkId: "arbitrum", amountSats: 10_000, claimAddress: VALID_EVM })
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "INSUFFICIENT_FUNDS"));
  });
});

describe("toStablecoin — quotes fail closed (G6)", () => {
  it("BLOCKS with QUOTES_UNAVAILABLE when the L-BTC quote is unavailable", async () => {
    const { deps } = stablecoinDeps();
    const w = await restore({ quotes: NO_QUOTES, boltz: deps });
    await expect(
      w.convert.boltz.toStablecoin({ asset: "USDC", networkId: "arbitrum", amountSats: 10_000, claimAddress: VALID_EVM })
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "QUOTES_UNAVAILABLE"));
  });
});

describe("toStablecoin — funded happy path: chain → DEX → bridge, sponsor gas, key zeroed", () => {
  async function convertOver(opts: {
    lockupLbtc: BoltzWalletContext["lockupLbtc"];
    deps: BoltzConvertDeps;
  }): Promise<{ convert: BoltzConvert; store: BoltzSwapStore }> {
    dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-stable-"));
    const store = new BoltzSwapStore({ dataDir, passphrase: PASSPHRASE, saltB64: SALT_B64 });
    const ctx: BoltzWalletContext = {
      store,
      logger: SILENT_LOGGER,
      lockupLbtc: opts.lockupLbtc,
      getReceiveAddress: async () => LOCKUP_ADDRESS
    };
    return { convert: new BoltzConvert(ctx, opts.deps), store };
  }

  it("locks L-BTC, executes with the gas-abstraction signer, delivers to the EVM address, zeroes the key, drops the record", async () => {
    const { deps, evmKey } = stablecoinDeps();
    // Server confirms the destination lockup as soon as we subscribe.
    (deps.client as unknown as { subscribeSwap: unknown }).subscribeSwap = (
      _id: string,
      onStatus: (raw: string) => void
    ): (() => void) => {
      queueMicrotask(() => onStatus("transaction.server.confirmed"));
      return () => {};
    };
    let seenRecipient: string | null = null;
    let seenSignerRdns: string | null = null;
    let seenSignerHex: string | null = null;
    const buildSigner = vi.fn(async (h: `0x${string}`): Promise<LocalEvmSigner> => {
      seenSignerHex = h;
      return { address: "0xSIGNER", walletClient: { tag: "wc" }, provider: {}, rdns: "gas-abstraction" };
    });
    const executeRoute = vi.fn(async (a: { signer: LocalEvmSigner; recipient: string }) => {
      seenRecipient = a.recipient;
      seenSignerRdns = a.signer.rdns;
      return { claimTransactionId: "claim-tx-1" };
    });
    deps.stablecoin!.execute = { executeRoute, buildSigner, ensureConfig: async () => {} };

    const { convert, store } = await convertOver({
      lockupLbtc: async () => ({ txid: "lockup-tx" }),
      deps
    });

    const res = await convert.toStablecoin({ asset: "USDC", networkId: "arbitrum", amountSats: 10_000, claimAddress: VALID_EVM });
    expect(res.lockupTxid).toBe("lockup-tx");
    expect(res.lockAmountSats).toBe(10_000);
    expect(res.asset).toBe("USDC");
    expect(res.claimAddress).toBe(VALID_EVM);
    // The in-memory ephemeral EVM key is zeroed right after it is persisted (encrypted).
    expect([...evmKey].every((b) => b === 0)).toBe(true);

    const outcome = await res.completion;
    expect(outcome.status).toBe("settled");
    expect(outcome.claimTransactionId).toBe("claim-tx-1");
    // Delivered to the FINAL EVM address, signed by the hosted-sponsor gas path.
    expect(seenRecipient).toBe(VALID_EVM);
    expect(seenSignerRdns).toBe("gas-abstraction");
    // The signer was built from the ephemeral key's 0x-hex (fill(0x42)).
    expect(seenSignerHex).toBe(("0x" + "42".repeat(32)) as `0x${string}`);
    // Settled → the crash-safe record is gone.
    expect(await store.get("chain-swap-1")).toBeNull();
  });

  it("routes a Tron destination through the case-SENSITIVE `tronAddress` guardrail class (review low)", async () => {
    const { deps } = stablecoinDeps();
    let seenDestKind: string | null = null;
    let seenDestAddress: string | null = null;
    const { convert } = await convertOver({
      lockupLbtc: async ({ destinations }) => {
        const d = destinations[0] as { kind: string; address?: string };
        seenDestKind = d.kind;
        seenDestAddress = d.address ?? null;
        // Fail after capture so the completion path doesn't need a full execute mock.
        throw Object.assign(new Error("stop after guardrail capture"), { nothingLocked: true });
      },
      deps
    });
    await convert
      .toStablecoin({ asset: "USDT", networkId: "tron", amountSats: 10_000, claimAddress: VALID_TRON })
      .catch(() => {});
    // Tron (base58) must NOT be lowercased through the evmAddress class.
    expect(seenDestKind).toBe("tronAddress");
    expect(seenDestAddress).toBe(VALID_TRON);
  });

  it("routes an EVM destination through the `evmAddress` guardrail class", async () => {
    const { deps } = stablecoinDeps();
    let seenDestKind: string | null = null;
    const { convert } = await convertOver({
      lockupLbtc: async ({ destinations }) => {
        seenDestKind = (destinations[0] as { kind: string }).kind;
        throw Object.assign(new Error("stop"), { nothingLocked: true });
      },
      deps
    });
    await convert
      .toStablecoin({ asset: "USDC", networkId: "arbitrum", amountSats: 10_000, claimAddress: VALID_EVM })
      .catch(() => {});
    expect(seenDestKind).toBe("evmAddress");
  });

  it("DROPS the plaintext ephemeral-key hex from the in-memory record right after persisting it (review medium)", async () => {
    const { deps } = stablecoinDeps();
    let persistedRecord: StoredStablecoinSwap | null = null;
    const { convert, store } = await convertOver({
      lockupLbtc: async () => {
        // Capture AFTER put+zeroing has run (put resolved, record.evmPrivateKeyHex nulled).
        throw Object.assign(new Error("stop after persist"), { nothingLocked: false });
      },
      deps
    });
    const putSpy = vi.spyOn(store, "put").mockImplementation(async function (this: BoltzSwapStore, rec) {
      persistedRecord = rec as StoredStablecoinSwap;
      return BoltzSwapStore.prototype.put.call(this, rec);
    });
    await convert
      .toStablecoin({ asset: "USDC", networkId: "arbitrum", amountSats: 10_000, claimAddress: VALID_EVM })
      .catch(() => {});
    putSpy.mockRestore();
    // The long-lived in-memory record no longer holds the cleartext key string.
    expect(persistedRecord).not.toBeNull();
    expect(persistedRecord!.evmPrivateKeyHex).toBe("");
    // The ENCRYPTED store copy still carries the key (recovery/refund needs it).
    const stored = (await store.get("chain-swap-1")) as StoredStablecoinSwap | null;
    expect(stored!.evmPrivateKeyHex).toBe("42".repeat(32));
  });

  it("PRESERVES the record when lockupLbtc fails at/after broadcast (no `nothingLocked`)", async () => {
    const { deps } = stablecoinDeps();
    const broadcastErr = new Error("network reset after the node accepted the tx");
    const { convert, store } = await convertOver({
      lockupLbtc: async () => {
        throw broadcastErr;
      },
      deps
    });
    await expect(
      convert.toStablecoin({ asset: "USDC", networkId: "arbitrum", amountSats: 10_000, claimAddress: VALID_EVM })
    ).rejects.toBe(broadcastErr);
    const rec = (await store.get("chain-swap-1")) as StoredStablecoinSwap | null;
    expect(rec).not.toBeNull();
    // The refund material survives — resume() can still sweep the L-BTC back.
    expect(rec!.refundPrivateKeyHex).toBeTruthy();
    expect(rec!.evmPrivateKeyHex).toBeTruthy();
    expect(rec!.type).toBe("stablecoin");
  });
});

describe("toStablecoin — bridge-fee guard blocks an uneconomical BRIDGED amount BEFORE any lockup (fund-safety port)", () => {
  const PAIRS = { chain: { "L-BTC": { TBTC: { limits: { minimal: 1000, maximal: 100_000_000 } } } } };
  // Bridge fee resolves to 6000 sats (> the 5000-sat amount) → bridge_fee reject.
  const feeQuoteWei = (6000n * 10_000_000_000n).toString();
  const bridgedRouteQuote = () => async () => ({
    receiveAmount: 950_000n,
    sendAmount: 5000,
    legs: [
      { kind: "chain-swap", receiveAmount: 4_800n, fees: { percentage: 0.1, minerFees: { server: 10, userLockup: 20, userClaim: 30 } } },
      { kind: "dex", chain: "arbitrum", tokenIn: "0xTBTC", tokenOut: "0xUSDT" },
      { kind: "bridge", messagingFee: { amount: 1_000_000_000_000_000n } }
    ]
  });

  it("THROWS SWAP_VALIDATION_FAILED and NEVER calls lockupLbtc (no L-BTC locked, nothing persisted)", async () => {
    const { deps } = stablecoinDeps();
    const prepare = deps.stablecoin!.prepare!;
    // Drive the REAL estimate so bridgeFeeSats is derived from the route legs.
    delete prepare.estimate;
    prepare.getPairs = async () => PAIRS;
    prepare.quoteRouteAmountOut = bridgedRouteQuote();
    prepare.quoteDexAmountOut = async () => [{ quote: feeQuoteWei }];

    dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-stable-"));
    const store = new BoltzSwapStore({ dataDir, passphrase: PASSPHRASE, saltB64: SALT_B64 });
    const lockupLbtc = vi.fn(async () => ({ txid: "should-not-be-called" }));
    const ctx: BoltzWalletContext = {
      store,
      logger: SILENT_LOGGER,
      lockupLbtc,
      getReceiveAddress: async () => LOCKUP_ADDRESS
    };
    const convert = new BoltzConvert(ctx, deps);

    await expect(
      convert.toStablecoin({ asset: "USDT", networkId: "tron", amountSats: 5000, claimAddress: VALID_TRON })
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "SWAP_VALIDATION_FAILED"));
    // The guard fired pre-lockup: no L-BTC ever moved, no crash-safe record written.
    expect(lockupLbtc).not.toHaveBeenCalled();
    await expect(store.get("chain-swap-1")).resolves.toBeNull();
  });
});

describe("resume() — a PERMANENT execute failure steers the record to refund; a TRANSIENT one re-executes (FIX A)", () => {
  async function setupExecuteResume(executeImpl: () => Promise<{ claimTransactionId: string }>): Promise<{
    convert: BoltzConvert;
    store: BoltzSwapStore;
    executeRoute: ReturnType<typeof vi.fn>;
    refundChain: ReturnType<typeof vi.fn>;
  }> {
    dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-stable-"));
    const store = new BoltzSwapStore({ dataDir, passphrase: PASSPHRASE, saltB64: SALT_B64 });
    await store.put(baseStablecoinRecord());

    const executeRoute = vi.fn(executeImpl);
    const buildSigner = vi.fn(async (): Promise<LocalEvmSigner> => ({
      address: "0xSIGNER",
      walletClient: {},
      provider: {},
      rdns: "gas-abstraction"
    }));
    const refundChain = vi.fn(async (): Promise<RefundResult> => ({ refundTxId: "refund-tx", cooperative: true }));

    const deps: BoltzConvertDeps = {
      client: fakeClient({
        // The destination lockup confirms as soon as we subscribe → execution runs.
        subscribeSwap: (_id: string, onStatus: (raw: string) => void) => {
          queueMicrotask(() => onStatus("transaction.server.confirmed"));
          return () => {};
        },
        // Bucket null → falls through to the state==="locked_up" execute branch.
        getSwapStatus: async () => ({ status: "swap.created" })
      }),
      stablecoin: {
        execute: { executeRoute, buildSigner, ensureConfig: async () => {} },
        refundChain: refundChain as unknown as NonNullable<BoltzConvertDeps["stablecoin"]>["refundChain"],
        // The L-BTC DID land (userLock present) — NOT a never-locked orphan, so the
        // refund path sweeps it rather than dropping (isolates the FIX A behavior).
        getChainSwapTransactions: async () => ({ userLock: { transaction: { id: "lock-tx" } } })
      }
    };
    const ctx: BoltzWalletContext = {
      store,
      logger: SILENT_LOGGER,
      lockupLbtc: async () => ({ txid: "x" }),
      getReceiveAddress: async () => LOCKUP_ADDRESS
    };
    return { convert: new BoltzConvert(ctx, deps), store, executeRoute, refundChain };
  }

  it("a PERMANENT execute error sets outcome:refund, and the NEXT resume refunds WITHOUT re-executing", async () => {
    const { convert, store, executeRoute, refundChain } = await setupExecuteResume(async () => {
      throw new Error("amount too small to cover bridge messaging fee");
    });

    // First resume drives execution in the background; it fails permanently.
    await convert.resume();
    await vi.waitFor(async () => {
      const r = (await store.get("chain-swap-1")) as StoredStablecoinSwap | null;
      expect(r?.outcome).toBe("refund"); // steered to the refund path
    });
    expect(executeRoute).toHaveBeenCalledTimes(1);
    expect(refundChain).not.toHaveBeenCalled(); // the first resume did not refund

    // Second resume sees outcome:refund → straight to refundStablecoin, no re-execute.
    const summary = await convert.resume();
    expect(refundChain).toHaveBeenCalledTimes(1);
    expect(executeRoute).toHaveBeenCalledTimes(1); // NOT re-executed
    expect(summary.stablecoinRefunded).toBe(1);
    expect(await store.get("chain-swap-1")).toBeNull();
  });

  it("a TRANSIENT execute error leaves the record untouched and RE-RUNS execute on the next resume", async () => {
    const { convert, store, executeRoute, refundChain } = await setupExecuteResume(async () => {
      throw new Error("fetch failed");
    });

    await convert.resume();
    await vi.waitFor(() => expect(executeRoute).toHaveBeenCalledTimes(1));
    // Transient → record untouched: no outcome, still locked_up, still present.
    const r1 = (await store.get("chain-swap-1")) as StoredStablecoinSwap | null;
    expect(r1).not.toBeNull();
    expect(r1?.outcome).toBeUndefined();
    expect(r1?.state).toBe("locked_up");

    // The next resume RE-RUNS execute (retry) and still drives no refund.
    await convert.resume();
    await vi.waitFor(() => expect(executeRoute).toHaveBeenCalledTimes(2));
    expect(refundChain).not.toHaveBeenCalled();
    const r2 = (await store.get("chain-swap-1")) as StoredStablecoinSwap | null;
    expect(r2?.outcome).toBeUndefined();
  });
});

describe("resume() — a never-locked orphan chain record is DROPPED, not re-errored forever (FIX B)", () => {
  const ORPHAN_ID = "chain-orphan-1";

  async function seedOrphan(over: Partial<NonNullable<BoltzConvertDeps["stablecoin"]>>): Promise<{
    convert: BoltzConvert;
    store: BoltzSwapStore;
    refundChain: ReturnType<typeof vi.fn>;
  }> {
    dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-stable-"));
    const store = new BoltzSwapStore({ dataDir, passphrase: PASSPHRASE, saltB64: SALT_B64 });
    await store.put(baseStablecoinRecord({ swapId: ORPHAN_ID, state: "prepared" }));

    const refundChain = vi.fn(async (): Promise<RefundResult> => ({ refundTxId: null, cooperative: true }));
    const deps: BoltzConvertDeps = {
      client: fakeClient({ getSwapStatus: async () => ({ status: "swap.expired" }) }), // bucket → refund
      stablecoin: {
        refundChain: refundChain as unknown as NonNullable<BoltzConvertDeps["stablecoin"]>["refundChain"],
        ...over
      }
    };
    const ctx: BoltzWalletContext = {
      store,
      logger: SILENT_LOGGER,
      lockupLbtc: async () => ({ txid: "x" }),
      getReceiveAddress: async () => LOCKUP_ADDRESS
    };
    return { convert: new BoltzConvert(ctx, deps), store, refundChain };
  }

  it("DROPS the record (removed++, not failed++) when Boltz confirms nothing was ever locked", async () => {
    const { convert, store, refundChain } = await seedOrphan({
      // DEFINITIVE: Boltz resolves with NO userLock → nothing on-chain to sweep.
      getChainSwapTransactions: async () => ({})
    });

    const summary = await convert.resume();
    expect(refundChain).not.toHaveBeenCalled(); // dropped BEFORE attempting a refund
    expect(await store.get(ORPHAN_ID)).toBeNull(); // orphan gone
    expect(summary.removed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.stablecoinRefunded).toBe(0);
  });

  it("KEEPS the record on an AMBIGUOUS never-locked probe (fund-safety fail-safe — never drop a maybe-funded record)", async () => {
    const { convert, store } = await seedOrphan({
      // The probe fails ambiguously (transient) → NOT a definitive "never locked".
      getChainSwapTransactions: async () => {
        throw new Error("boltz temporarily unavailable");
      },
      // The refund can't complete yet → RefundPendingError keeps the record.
      refundChain: (async () => {
        throw new RefundPendingError("cooperative failed and the timeout has not been reached yet");
      }) as unknown as NonNullable<BoltzConvertDeps["stablecoin"]>["refundChain"]
    });

    const summary = await convert.resume();
    const kept = (await store.get(ORPHAN_ID)) as StoredStablecoinSwap | null;
    expect(kept).not.toBeNull(); // NOT dropped — it may still guard funds
    expect(kept?.state).toBe("refund_pending");
    expect(summary.removed).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.stablecoinResumed).toBe(1); // refund_pending → retry next resume
  });
});

describe("resume() — refunds an expired stablecoin (chain) lockup from boltz-swaps.json (§5.3)", () => {
  it("drives refundChainSwap for an expired chain lockup and drops the record", async () => {
    const refundSpy = vi.fn<(record: ChainRefundRecord, deps: ChainRefundDeps) => Promise<RefundResult>>(async () => ({
      refundTxId: "refund-txid",
      cooperative: true
    }));
    const boltz: BoltzConvertDeps = {
      client: fakeClient({ getSwapStatus: async () => ({ status: "swap.expired" }) }),
      stablecoin: {
        refundChain: refundSpy as unknown as NonNullable<BoltzConvertDeps["stablecoin"]>["refundChain"],
        // The lockup DID land on-chain (Boltz reports a userLock) → this is NOT a
        // never-locked orphan, so refundStablecoin sweeps it instead of dropping it.
        getChainSwapTransactions: async () => ({ userLock: { transaction: { id: "lock-tx" } } })
      }
    };
    const w = await restore({ boltz });

    // Pre-seed a crashed-in-flight chain swap using the wallet's OWN salt.
    const walletFile = JSON.parse(await readFile(join(dataDir, "wallet.json"), "utf8")) as { salt: string };
    const store = new BoltzSwapStore({ dataDir, passphrase: PASSPHRASE, saltB64: walletFile.salt });
    const rec: StoredStablecoinSwap = {
      type: "stablecoin",
      swapId: "chain-swap-9",
      asset: "USDC",
      networkId: "arbitrum",
      claimAddress: VALID_EVM,
      lockupAddress: LOCKUP_ADDRESS,
      lockAmountSats: 10_000,
      serverPublicKey: "03" + "cc".repeat(32),
      swapTree: { chainLeaf: {} },
      blindingKey: "dd".repeat(32),
      timeoutBlockHeight: 1_000_050,
      refundPrivateKeyHex: "aa".repeat(32),
      refundPublicKeyHex: "02" + "bb".repeat(32),
      preimageHex: "ee".repeat(32),
      evmPrivateKeyHex: "ff".repeat(32),
      createdSwap: { id: "chain-swap-9" },
      plan: { legs: [] },
      state: "locked_up",
      createdAt: 0
    };
    await store.put(rec);

    const summary = await w.convert.boltz.resume();
    expect(summary.stablecoinRefunded).toBe(1);
    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect(refundSpy.mock.calls[0]![0]).toMatchObject({
      swapId: "chain-swap-9",
      serverPublicKey: "03" + "cc".repeat(32),
      refundPrivateKeyHex: "aa".repeat(32)
    });
    expect(await store.get("chain-swap-9")).toBeNull();
  });
});
