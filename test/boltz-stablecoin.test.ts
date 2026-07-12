// Boltz stablecoin (L-BTC → USDC/USDT EVM) — pure helpers + the dependency-
// injected route orchestration (spec §5.3, PR5b). Everything is mocked: viem, the
// boltz-swaps route engine, verify-lockup. Proves the fail-closed guard cadence
// (unsupported target / bad destination / token-contract / inflated lockup /
// timeout-out-of-bounds / tree mismatch), the STABLECOIN_DEPS_MISSING guard on a
// failed dynamic viem import, and — critically — that the ephemeral EVM key is
// ZEROED after use (frontend zeroInMemory parity).
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, hex } from "@scure/base";
import {
  boltzVariantKey,
  checkStablecoinAmount,
  deriveStablecoinKeys,
  isValidTronAddress,
  mapChainSwapStatus,
  loadViem,
  buildLocalSigner,
  withEphemeralEvmSigner,
  prepareStablecoinRoute,
  executeStablecoinRoute,
  type LoadedViem,
  type LocalEvmSigner,
  type PrepareStablecoinDeps,
  type CreatedStablecoinRoute
} from "../src/convert/boltz/stablecoin.js";
import { isDepixSdkError } from "../src/errors.js";

// A valid TRON base58check address built from the real primitives (0x41 prefix +
// 20-byte payload + double-SHA256 checksum) — guaranteed to pass the validator.
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
const VALID_TRON = makeTronAddress(new Uint8Array(20).fill(0x11));
const VALID_EVM = "0x1234567890AbcdEF1234567890aBcdef12345678";

/** A fake viem module whose isAddress/privateKeyToAccount are deterministic. */
function fakeViem(over: { isAddress?: (v: string) => boolean; address?: string } = {}): LoadedViem {
  return {
    viem: {
      createWalletClient: () => ({ tag: "wallet-client" }),
      createPublicClient: () => ({ tag: "public-client" }),
      http: () => ({ tag: "transport" }),
      isAddress: over.isAddress ?? (() => true)
    },
    accounts: {
      privateKeyToAccount: () => ({ address: over.address ?? "0xEPHEMERALSIGNER0000000000000000000000000" })
    }
  };
}

/** A createRoute that echoes userLockAmount back and captures its args. */
function fakeCreateRoute(over: Partial<CreatedStablecoinRoute["createdSwap"]["lockupDetails"]> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const fn = vi.fn(async (args: Record<string, unknown>): Promise<CreatedStablecoinRoute> => {
    calls.push(args);
    return {
      createdSwap: {
        id: "chain-swap-1",
        lockupDetails: {
          lockupAddress: "lq1lockupaddr",
          amount: (args.userLockAmount as number) ?? 10_000,
          timeoutBlockHeight: 1_000_050,
          swapTree: { chainLeaf: {} },
          serverPublicKey: "03" + "cc".repeat(32),
          blindingKey: "dd".repeat(32),
          ...over
        }
      },
      plan: { legs: ["chain-swap", "dex", "bridge"] }
    };
  });
  return { fn, calls };
}

function baseDeps(over: Partial<PrepareStablecoinDeps> = {}): { deps: PrepareStablecoinDeps; verify: ReturnType<typeof vi.fn>; evmKey: Uint8Array } {
  const evmKey = new Uint8Array(32).fill(0x42);
  const verify = vi.fn(async () => {});
  const { fn: createRoute } = fakeCreateRoute();
  const deps: PrepareStablecoinDeps = {
    viemImporter: async () => fakeViem(),
    ensureConfig: async () => {},
    deriveKeys: () => ({
      preimage: new Uint8Array(32).fill(1),
      preimageHash: new Uint8Array(32).fill(2),
      refundPrivateKey: new Uint8Array(32).fill(3),
      refundPublicKey: new Uint8Array(33).fill(4),
      evmPrivateKey: evmKey
    }),
    getPairs: async () => ({}),
    createRoute,
    isKnownTokenAddress: () => false,
    verifyLockup: verify as unknown as PrepareStablecoinDeps["verifyLockup"],
    // Permissive economic pre-check by default (viem-free, no real quote engine):
    // the test amounts (10_000 / 20_000 sats) sit inside these chain-swap limits.
    estimate: async () => ({ minSats: 1000, maxSats: 100_000_000 }),
    ...over
  };
  return { deps, verify, evmKey };
}

describe("boltzVariantKey — (asset, network) → boltz-swaps variant", () => {
  it("maps supported targets and rejects unsupported ones", () => {
    expect(boltzVariantKey("USDC", "arbitrum")).toBe("USDC");
    expect(boltzVariantKey("USDC", "polygon")).toBe("USDC-POL");
    expect(boltzVariantKey("USDT", "arbitrum")).toBe("USDT0");
    expect(boltzVariantKey("USDT", "tron")).toBe("USDT0-TRON");
    expect(boltzVariantKey("USDC", "tron")).toBeNull(); // no native USDC on Tron
  });
});

describe("isValidTronAddress — base58check", () => {
  it("accepts a well-formed Tron address and rejects garbage", () => {
    expect(isValidTronAddress(VALID_TRON)).toBe(true);
    expect(isValidTronAddress("not-an-address")).toBe(false);
    expect(isValidTronAddress(VALID_TRON.slice(0, -1) + "x")).toBe(false); // bad checksum
    expect(isValidTronAddress(VALID_EVM)).toBe(false);
  });
});

describe("mapChainSwapStatus — recovery bucket", () => {
  it("maps raw statuses to done/resume/refund/null", () => {
    expect(mapChainSwapStatus("transaction.claimed")).toBe("done");
    expect(mapChainSwapStatus("transaction.direct.claimed")).toBe("done");
    expect(mapChainSwapStatus("transaction.server.confirmed")).toBe("resume");
    expect(mapChainSwapStatus("transaction.server.mempool")).toBe("resume");
    expect(mapChainSwapStatus("swap.expired")).toBe("refund");
    expect(mapChainSwapStatus("transaction.failed")).toBe("refund");
    expect(mapChainSwapStatus("swap.created")).toBeNull();
    expect(mapChainSwapStatus(undefined)).toBeNull();
  });
});

describe("checkStablecoinAmount — economic/dust guard (pure)", () => {
  it("passes a healthy amount", () => {
    expect(checkStablecoinAmount({ amountSats: 100_000, sendUsd: 60, receiveUsd: 58 }).ok).toBe(true);
  });
  it("rejects empty, below-min, above-max", () => {
    expect(checkStablecoinAmount({ amountSats: 0 })).toEqual({ ok: false, reason: "empty" });
    expect(checkStablecoinAmount({ amountSats: 500, minSats: 1000 })).toMatchObject({ ok: false, reason: "below_min", minSats: 1000 });
    expect(checkStablecoinAmount({ amountSats: 2000, maxSats: 1000 })).toMatchObject({ ok: false, reason: "above_max", maxSats: 1000 });
  });
  it("rejects when the fixed bridge fee dominates", () => {
    const r = checkStablecoinAmount({ amountSats: 1200, bridgeFeeSats: 1000 });
    expect(r).toMatchObject({ ok: false, reason: "bridge_fee", bridgeFeeSats: 1000 });
  });
  it("rejects when the total fee ratio exceeds the cap", () => {
    const r = checkStablecoinAmount({ amountSats: 100_000, sendUsd: 60, receiveUsd: 40 }); // 33% fee
    expect(r).toMatchObject({ ok: false, reason: "fee_ratio" });
  });
});

describe("loadViem — STABLECOIN_DEPS_MISSING when the dynamic import fails (§2.2)", () => {
  it("throws the typed error when the injected importer rejects", async () => {
    const importer = vi.fn(async () => {
      throw new Error("ERR_MODULE_NOT_FOUND: viem");
    });
    await expect(loadViem(importer)).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "STABLECOIN_DEPS_MISSING"));
  });

  it("buildLocalSigner also surfaces STABLECOIN_DEPS_MISSING on a broken viem", async () => {
    await expect(
      buildLocalSigner(("0x" + "11".repeat(32)) as `0x${string}`, {
        importer: async () => {
          throw new Error("no viem");
        }
      })
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "STABLECOIN_DEPS_MISSING"));
  });

  it("returns the loaded module when the importer succeeds", async () => {
    const loaded = await loadViem(async () => fakeViem());
    expect(typeof loaded.viem.isAddress).toBe("function");
  });
});

describe("withEphemeralEvmSigner — zeroes the ephemeral EVM key after use", () => {
  it("builds a signer from the key's 0x-hex and zeroes the bytes on success", async () => {
    const key = new Uint8Array(32).fill(0x7f);
    const expectedHex = ("0x" + hex.encode(key)) as `0x${string}`;
    let seenHex: string | null = null;
    const buildSigner = async (h: `0x${string}`): Promise<LocalEvmSigner> => {
      seenHex = h;
      return { address: "0xabc", walletClient: {}, provider: {}, rdns: "gas-abstraction" };
    };
    const result = await withEphemeralEvmSigner(key, async (s) => s.address, { buildSigner });
    expect(result).toBe("0xabc");
    expect(seenHex).toBe(expectedHex);
    // The ephemeral EVM key is zeroed — no live buffer lingers past its use.
    expect([...key].every((b) => b === 0)).toBe(true);
  });

  it("STILL zeroes the key when `use` throws (post-lockup execution failure)", async () => {
    const key = new Uint8Array(32).fill(0x99);
    const buildSigner = async (): Promise<LocalEvmSigner> => ({
      address: "0xabc",
      walletClient: {},
      provider: {},
      rdns: "gas-abstraction"
    });
    await expect(
      withEphemeralEvmSigner(
        key,
        async () => {
          throw new Error("executeRoute reverted");
        },
        { buildSigner }
      )
    ).rejects.toThrow("executeRoute reverted");
    expect([...key].every((b) => b === 0)).toBe(true);
  });
});

describe("deriveStablecoinKeys — fresh per-swap material", () => {
  it("produces a preimage/hash, refund keypair and a 32-byte EVM key", () => {
    const k = deriveStablecoinKeys();
    expect(k.preimage.length).toBe(32);
    expect(k.preimageHash.length).toBe(32);
    expect(hex.encode(sha256(k.preimage))).toBe(hex.encode(k.preimageHash));
    expect(k.refundPublicKey.length).toBe(33);
    expect(k.evmPrivateKey.length).toBe(32);
    // Distinct random material.
    expect(hex.encode(k.evmPrivateKey)).not.toBe(hex.encode(k.preimage));
  });
});

describe("prepareStablecoinRoute — fail-closed guard cadence (§5.3)", () => {
  it("creates + verifies the route, committing the EPHEMERAL signer as the claim address", async () => {
    const { fn: createRoute, calls } = fakeCreateRoute();
    const { deps, verify, evmKey } = baseDeps({ createRoute });
    const prepared = await prepareStablecoinRoute(
      { asset: "USDC", networkId: "arbitrum", amountSats: 10_000, claimAddress: VALID_EVM },
      deps
    );
    expect(prepared.swapId).toBe("chain-swap-1");
    expect(prepared.lockupAddress).toBe("lq1lockupaddr");
    expect(prepared.lockAmountSats).toBe(10_000);
    expect(prepared.claimAddress).toBe(VALID_EVM); // FINAL recipient = the user's address
    expect(prepared.evmPrivateKey).toBe(evmKey); // returned for the caller to persist+zero
    expect(prepared.createdSwap).toBeTruthy();
    expect(prepared.plan).toBeTruthy();
    // The chain swap commits the SIGNER's EOA (not the user's address) as its claim.
    expect(calls[0]!.claimAddress).toBe("0xEPHEMERALSIGNER0000000000000000000000000");
    expect(calls[0]!.userLockAmount).toBe(10_000);
    // verify-lockup ran with swapType "chain" binding OUR preimage hash.
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]![0]).toMatchObject({ swapType: "chain", expectedHash: hex.encode(new Uint8Array(32).fill(2)) });
  });

  it("hex-encodes preimageHash for createRoute — regression: boltz-swaps' chain-swap createRoute expects a hex STRING (like reverse.ts), not raw bytes, or Boltz rejects the request with 'invalid parameter: preimageHash'", async () => {
    const { fn: createRoute, calls } = fakeCreateRoute();
    const preimage = new Uint8Array(32).fill(9);
    const preimageHash = sha256(preimage);
    const { deps } = baseDeps({
      createRoute,
      deriveKeys: () => ({
        preimage,
        preimageHash,
        refundPrivateKey: new Uint8Array(32).fill(3),
        refundPublicKey: new Uint8Array(33).fill(4),
        evmPrivateKey: new Uint8Array(32).fill(0x42)
      })
    });
    await prepareStablecoinRoute(
      { asset: "USDC", networkId: "arbitrum", amountSats: 10_000, claimAddress: VALID_EVM },
      deps
    );
    const sentPreimageHash = calls[0]!.preimageHash;
    expect(typeof sentPreimageHash).toBe("string");
    expect(sentPreimageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sentPreimageHash).toBe(hex.encode(preimageHash));
  });

  it("supports a Tron destination (base58check, no viem needed to validate)", async () => {
    const { deps } = baseDeps();
    const prepared = await prepareStablecoinRoute(
      { asset: "USDT", networkId: "tron", amountSats: 20_000, claimAddress: VALID_TRON },
      deps
    );
    expect(prepared.claimAddress).toBe(VALID_TRON);
  });

  it("rejects an unsupported (asset, network) → SWAP_VALIDATION_FAILED", async () => {
    const { deps } = baseDeps();
    await expect(
      prepareStablecoinRoute({ asset: "USDC", networkId: "tron", amountSats: 10_000, claimAddress: VALID_EVM }, deps)
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "SWAP_VALIDATION_FAILED"));
  });

  it("rejects an invalid EVM destination (viem isAddress false) → SWAP_VALIDATION_FAILED", async () => {
    const { deps } = baseDeps({ viemImporter: async () => fakeViem({ isAddress: () => false }) });
    await expect(
      prepareStablecoinRoute({ asset: "USDC", networkId: "arbitrum", amountSats: 10_000, claimAddress: "0xbad" }, deps)
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "SWAP_VALIDATION_FAILED"));
  });

  it("rejects a token-CONTRACT destination → SWAP_VALIDATION_FAILED (before any swap)", async () => {
    const createRoute = vi.fn();
    const { deps } = baseDeps({ isKnownTokenAddress: () => true, createRoute: createRoute as never });
    await expect(
      prepareStablecoinRoute({ asset: "USDC", networkId: "arbitrum", amountSats: 10_000, claimAddress: VALID_EVM }, deps)
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "SWAP_VALIDATION_FAILED"));
    expect(createRoute).not.toHaveBeenCalled(); // fail-closed before creating the swap
  });

  it("rejects an INFLATED lockup (amount > requested) → LOCKUP_INFLATED", async () => {
    const { fn: createRoute } = fakeCreateRoute({ amount: 20_000 }); // asks for more than 10_000
    const { deps } = baseDeps({ createRoute });
    await expect(
      prepareStablecoinRoute({ asset: "USDC", networkId: "arbitrum", amountSats: 10_000, claimAddress: VALID_EVM }, deps)
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "LOCKUP_INFLATED"));
  });

  it("rejects a NON-POSITIVE lockup amount (≤0) → LOCKUP_INFLATED (review low, lower bound)", async () => {
    const { fn: createRoute } = fakeCreateRoute({ amount: 0 }); // buggy/hostile route returns 0
    const { deps } = baseDeps({ createRoute });
    await expect(
      prepareStablecoinRoute({ asset: "USDC", networkId: "arbitrum", amountSats: 10_000, claimAddress: VALID_EVM }, deps)
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "LOCKUP_INFLATED"));
  });

  it("rejects a DUST amount below the route minimum BEFORE creating any swap (review medium — economic guard wired)", async () => {
    const createRoute = vi.fn();
    const { deps } = baseDeps({
      createRoute: createRoute as never,
      estimate: async () => ({ minSats: 50_000, maxSats: 100_000_000 }) // amount 10_000 < 50_000
    });
    await expect(
      prepareStablecoinRoute({ asset: "USDC", networkId: "arbitrum", amountSats: 10_000, claimAddress: VALID_EVM }, deps)
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "SWAP_VALIDATION_FAILED"));
    // Fail-closed BEFORE the swap is created → no L-BTC can be locked.
    expect(createRoute).not.toHaveBeenCalled();
  });

  it("rejects an amount above the route maximum before creating any swap (economic guard)", async () => {
    const createRoute = vi.fn();
    const { deps } = baseDeps({
      createRoute: createRoute as never,
      estimate: async () => ({ minSats: 1000, maxSats: 5000 }) // amount 10_000 > 5000
    });
    await expect(
      prepareStablecoinRoute({ asset: "USDC", networkId: "arbitrum", amountSats: 10_000, claimAddress: VALID_EVM }, deps)
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "SWAP_VALIDATION_FAILED"));
    expect(createRoute).not.toHaveBeenCalled();
  });

  it("REJECTS a route whose returned claim address is not our ephemeral signer (review medium — sponsor trust boundary)", async () => {
    // createRoute echoes a FOREIGN tBTC claim EOA — the SDK must refuse to fund it.
    const createRoute = vi.fn(async (): Promise<CreatedStablecoinRoute> => ({
      createdSwap: {
        id: "chain-swap-1",
        claimDetails: { claimAddress: "0xATTACKER00000000000000000000000000000000" },
        lockupDetails: {
          lockupAddress: "lq1lockupaddr",
          amount: 10_000,
          timeoutBlockHeight: 1_000_050,
          swapTree: { chainLeaf: {} },
          serverPublicKey: "03" + "cc".repeat(32),
          blindingKey: "dd".repeat(32)
        }
      },
      plan: { legs: [] }
    }));
    const { deps } = baseDeps({ createRoute });
    await expect(
      prepareStablecoinRoute({ asset: "USDC", networkId: "arbitrum", amountSats: 10_000, claimAddress: VALID_EVM }, deps)
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "SWAP_VALIDATION_FAILED"));
  });

  it("ACCEPTS a route whose returned claim address matches our ephemeral signer (case-insensitive)", async () => {
    const createRoute = vi.fn(async (): Promise<CreatedStablecoinRoute> => ({
      createdSwap: {
        id: "chain-swap-1",
        // fakeViem's privateKeyToAccount address, upper-cased — must still match.
        claimDetails: { claimAddress: "0xEPHEMERALSIGNER0000000000000000000000000".toUpperCase() },
        lockupDetails: {
          lockupAddress: "lq1lockupaddr",
          amount: 10_000,
          timeoutBlockHeight: 1_000_050,
          swapTree: { chainLeaf: {} },
          serverPublicKey: "03" + "cc".repeat(32),
          blindingKey: "dd".repeat(32)
        }
      },
      plan: { legs: [] }
    }));
    const { deps } = baseDeps({ createRoute });
    const prepared = await prepareStablecoinRoute(
      { asset: "USDC", networkId: "arbitrum", amountSats: 10_000, claimAddress: VALID_EVM },
      deps
    );
    expect(prepared.swapId).toBe("chain-swap-1");
  });

  it("rejects a refund timeout outside the safe window → TIMEOUT_OUT_OF_BOUNDS", async () => {
    const { fn: createRoute } = fakeCreateRoute({ timeoutBlockHeight: 5_000_000 });
    const { deps } = baseDeps({ createRoute, getChainHeight: async () => 1_000_000 });
    await expect(
      prepareStablecoinRoute({ asset: "USDC", networkId: "arbitrum", amountSats: 10_000, claimAddress: VALID_EVM }, deps)
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "TIMEOUT_OUT_OF_BOUNDS"));
  });

  it("propagates a verify-lockup mismatch (LOCKUP_TREE_MISMATCH) before funding", async () => {
    const verify = vi.fn(async () => {
      const { ConversionError } = await import("../src/errors.js");
      throw new ConversionError("LOCKUP_TREE_MISMATCH", "tree mismatch");
    });
    const { deps } = baseDeps({ verifyLockup: verify as unknown as PrepareStablecoinDeps["verifyLockup"] });
    await expect(
      prepareStablecoinRoute({ asset: "USDC", networkId: "arbitrum", amountSats: 10_000, claimAddress: VALID_EVM }, deps)
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "LOCKUP_TREE_MISMATCH"));
  });
});

describe("executeStablecoinRoute — chain claim → DEX → bridge (sponsor gas, key zeroed)", () => {
  it("waits for the server lockup, then runs executeRoute with the gas-abstraction signer", async () => {
    const originalKey = new Uint8Array(32).fill(0x55);
    const evmHex = hex.encode(originalKey);
    let seenRecipient: string | null = null;
    let seenSignerRdns: string | null = null;
    let seenPreimage: string | null = null;
    let seenSignerHex: string | null = null;

    const waitForServerLockup = vi.fn(async () => {});
    const buildSigner = vi.fn(async (h: `0x${string}`): Promise<LocalEvmSigner> => {
      seenSignerHex = h;
      return { address: "0xSIGNER", walletClient: { tag: "wc" }, provider: {}, rdns: "gas-abstraction" };
    });
    const executeRoute = vi.fn(async (a: { signer: LocalEvmSigner; recipient: string; preimage: Uint8Array }) => {
      seenRecipient = a.recipient;
      seenSignerRdns = a.signer.rdns;
      seenPreimage = hex.encode(a.preimage);
      return { claimTransactionId: "claim-tx-1" };
    });

    const out = await executeStablecoinRoute(
      {
        swapId: "chain-swap-1",
        claimAddress: VALID_EVM,
        createdSwap: { id: "chain-swap-1" },
        plan: { legs: [] },
        preimageHex: "ab".repeat(32),
        evmPrivateKeyHex: evmHex
      },
      { waitForServerLockup, executeRoute, buildSigner, ensureConfig: async () => {} }
    );

    expect(out).toEqual({ swapId: "chain-swap-1", claimTransactionId: "claim-tx-1" });
    expect(waitForServerLockup).toHaveBeenCalledWith("chain-swap-1");
    expect(seenRecipient).toBe(VALID_EVM); // delivered to the FINAL user address
    expect(seenSignerRdns).toBe("gas-abstraction"); // gas paid by the hosted sponsor
    expect(seenPreimage).toBe("ab".repeat(32));
    // The signer was built from the ephemeral key's 0x-hex …
    expect(seenSignerHex).toBe(("0x" + evmHex) as `0x${string}`);
    // … and `originalKey` is untouched (execute decodes its OWN copy from hex,
    // which withEphemeralEvmSigner zeroes — covered by the withEphemeralEvmSigner
    // suite; here we only assert the record's hex was used, not mutated).
    expect(hex.encode(originalKey)).toBe(evmHex);
  });
});
