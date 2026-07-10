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
import { DepixWallet } from "../src/wallet.js";
import {
  BoltzConvert,
  type BoltzConvertDeps,
  type BoltzWalletContext
} from "../src/convert/boltz/convert.js";
import type { BoltzClient } from "../src/convert/boltz/client.js";
import type { CreatedStablecoinRoute, LocalEvmSigner, LoadedViem } from "../src/convert/boltz/stablecoin.js";
import { BoltzSwapStore, type StoredStablecoinSwap } from "../src/convert/boltz/store.js";
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
        verifyLockup: passVerify
      },
      ...over
    }
  };
  return { deps, evmKey };
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

describe("resume() — refunds an expired stablecoin (chain) lockup from boltz-swaps.json (§5.3)", () => {
  it("drives refundChainSwap for an expired chain lockup and drops the record", async () => {
    const refundSpy = vi.fn<(record: ChainRefundRecord, deps: ChainRefundDeps) => Promise<RefundResult>>(async () => ({
      refundTxId: "refund-txid",
      cooperative: true
    }));
    const boltz: BoltzConvertDeps = {
      client: fakeClient({ getSwapStatus: async () => ({ status: "swap.expired" }) }),
      stablecoin: { refundChain: refundSpy as unknown as NonNullable<BoltzConvertDeps["stablecoin"]>["refundChain"] }
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
