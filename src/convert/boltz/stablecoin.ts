// L-BTC -> USDC/USDT on an EVM chain, non-custodial (spec §5.3, decision G5 —
// stablecoin EVM is IN the F3 MVP). Port of
// depix-frontend/wallet/boltz/stablecoin.js (+ networks.js).
//
// The route: an L-BTC -> tBTC Boltz CHAIN swap, then a DEX on Arbitrum, then a
// LayerZero/OFT bridge to the destination chain, delivered to a pasted EVM (or
// Tron) address. The EVM legs (DEX + bridge + claim) are signed by an EPHEMERAL
// viem account derived from a per-swap key — NO walletconnect, NO browser wallet
// — with gas paid by Boltz's hosted sponsor (sponsor.ccxp.space; no Alchemy key
// of ours). "Paste an address, send L-BTC, done."
//
// This module is PURE + dependency-injected like submarine.ts: it plans/creates
// the route and runs the fail-closed guards, but it does NOT sign the L-BTC
// lockup or touch the guardrail — the wallet (convert.ts → ctx.lockupLbtc) runs
// the guardrail choke point valuing the L-BTC lockup in BRL and checking the
// FINAL EVM settle address against allowlist.evmAddresses (a protocol-bound
// lockup does NOT exempt the agent-chosen destination, §4.3), then signs it.
//
// viem + the boltz-swaps route/evm subpaths are imported DYNAMICALLY (frontend
// parity, GT §7.1). Even though viem is now a REGULAR dependency (G5), the
// dynamic import + the STABLECOIN_DEPS_MISSING typed error stay as a defense so a
// broken/partial install fails with an actionable typed error, never a raw
// ERR_MODULE_NOT_FOUND mid-flow.

import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { ConversionError } from "../../errors.js";
import { ensureBoltzConfig } from "./client.js";
import { randomKeypair } from "./keys.js";
import { assertLockupAddressBindsToUser } from "./verify-lockup.js";

// USDC/USDT on EVM chains are 6-decimal tokens.
export const STABLECOIN_DECIMALS = 6;

/** Stablecoin assets Boltz can deliver (distinct from the in-wallet Liquid USDt). */
export type StablecoinAsset = "USDC" | "USDT";

// Our (asset, networkId) -> boltz-swaps variant key. USDC = CCTP variants; USDT =
// USDT0 (OFT) variants. Arbitrum is the canonical landing chain, so its key is
// the bare asset. Verbatim from the frontend's VARIANT_KEYS.
export const VARIANT_KEYS: Readonly<Record<StablecoinAsset, Readonly<Record<string, string>>>> =
  Object.freeze({
    USDC: Object.freeze({
      arbitrum: "USDC",
      polygon: "USDC-POL",
      ethereum: "USDC-ETH",
      optimism: "USDC-OP",
      base: "USDC-BASE"
    }),
    USDT: Object.freeze({
      arbitrum: "USDT0",
      polygon: "USDT0-POL",
      ethereum: "USDT0-ETH",
      optimism: "USDT0-OP",
      tron: "USDT0-TRON"
    })
  });

/** Resolve the boltz-swaps variant key, or null for an unsupported (asset, network). */
export function boltzVariantKey(asset: StablecoinAsset, networkId: string): string | null {
  return VARIANT_KEYS[asset]?.[networkId] ?? null;
}

// ── destination networks + per-family address validation (port of networks.js) ──

export type AddressFamily = "evm" | "tron";

interface StablecoinNetwork {
  id: string;
  label: string;
  family: AddressFamily;
  assets: readonly StablecoinAsset[];
}

export const BOLTZ_STABLECOIN_NETWORKS: readonly StablecoinNetwork[] = Object.freeze([
  { id: "polygon", label: "Polygon (PoS)", family: "evm", assets: ["USDC", "USDT"] },
  { id: "ethereum", label: "Ethereum (ERC20)", family: "evm", assets: ["USDC", "USDT"] },
  { id: "arbitrum", label: "Arbitrum One", family: "evm", assets: ["USDC", "USDT"] },
  { id: "optimism", label: "Optimism", family: "evm", assets: ["USDC", "USDT"] },
  { id: "base", label: "Base", family: "evm", assets: ["USDC"] },
  // Tron carries no USDC (Circle sunset native USDC on Tron in 2024); USDT is the
  // canonical TRC-20 token through the USDT0 adapter.
  { id: "tron", label: "Tron (TRC-20)", family: "tron", assets: ["USDT"] }
].map((n) => Object.freeze(n)) as StablecoinNetwork[]);

export function getStablecoinNetwork(id: string): StablecoinNetwork | null {
  return BOLTZ_STABLECOIN_NETWORKS.find((n) => n.id === id) ?? null;
}

// Tron base58check: 25 bytes = 0x41 prefix + 20-byte payload + 4-byte
// double-SHA256 checksum. base58 + sha256 come from the SDK's existing deps, so
// this never touches viem.
const TRON_ADDRESS_LENGTH = 25;
const TRON_PAYLOAD_LENGTH = 21;
const TRON_PREFIX = 0x41;

export function isValidTronAddress(address: string): boolean {
  if (typeof address !== "string") return false;
  let decoded: Uint8Array;
  try {
    decoded = base58.decode(address.trim());
  } catch {
    return false;
  }
  if (decoded.length !== TRON_ADDRESS_LENGTH) return false;
  const payload = decoded.subarray(0, TRON_PAYLOAD_LENGTH);
  if (payload[0] !== TRON_PREFIX) return false;
  const checksum = decoded.subarray(TRON_PAYLOAD_LENGTH);
  const expected = sha256(sha256(payload)).slice(0, 4);
  return checksum.every((byte, i) => byte === expected[i]);
}

// ── chain-swap status → recovery bucket (verbatim mapping from the frontend) ────

export type ChainSwapBucket = "done" | "resume" | "refund" | null;

/**
 * Map a raw Boltz chain-swap status to a recovery bucket for a persisted swap
 * whose L-BTC lockup already landed:
 *   "done"   — already claimed/settled; drop the record.
 *   "resume" — Boltz locked the destination (server lock); CLAIM to finish.
 *   "refund" — swap failed/expired; sweep the L-BTC lockup back.
 *   null     — still pending (user lockup not yet server-locked); wait.
 * Money-critical: a wrong bucket on a swap with funds locked either strands the
 * L-BTC (missed refund) or wastes a claim attempt. Pure + exported for tests.
 */
export function mapChainSwapStatus(raw: string | undefined | null): ChainSwapBucket {
  switch (raw) {
    case "transaction.claimed":
    case "transaction.direct.claimed":
      return "done";
    case "transaction.server.mempool":
    case "transaction.server.confirmed":
      return "resume";
    case "swap.expired":
    case "transaction.lockupFailed":
    case "transaction.refunded":
    case "transaction.failed":
      return "refund";
    default:
      return null;
  }
}

// Statuses after which the swap can no longer be executed — the refund path takes
// over via the persisted record.
export const CHAIN_SWAP_FAILURE_STATUSES: ReadonlySet<string> = new Set([
  "swap.expired",
  "transaction.lockupFailed",
  "transaction.failed",
  "transaction.refunded"
]);

/**
 * Distinguish a PERMANENT route-execution failure (the swap can NEVER settle,
 * regardless of retries) from a TRANSIENT one (network blip, dynamic-import chunk
 * 404). The boltz-swaps route engine throws plain Errors, so the match is on the
 * message text. FAITHFUL mirror of the EXACT patterns in
 * depix-frontend/wallet/swap-ui.js:2258-2261 — keep them in sync. Exported so the
 * recovery loop (convert.ts executeStablecoin) can steer a permanently-
 * unexecutable swap straight to refund instead of looping resume until the swap
 * expires.
 */
export function isPermanentRouteError(err: unknown): boolean {
  const msg = String((err as { message?: unknown } | null | undefined)?.message ?? err ?? "");
  return /too small to cover bridge messaging fee|RouteUnavailable|no .*route|unsupported/i.test(msg);
}

/** The chain-swap transactions shape the never-locked probe reads (subset). */
export interface ChainSwapTransactions {
  userLock?: unknown;
  serverLock?: unknown;
}
/** Injectable chain-swap transactions fetch (tests) — default: boltz-swaps/client. */
export type GetChainSwapTransactions = (swapId: string) => Promise<ChainSwapTransactions | null | undefined>;

/**
 * True IFF Boltz DEFINITIVELY confirms this chain swap NEVER locked any coins
 * on-chain (created then abandoned, or expired before the user funded it) — so
 * there is nothing to refund and the orphan record can be safely dropped. FAIL-
 * SAFE: a transient/unknown error returns false, so a record that MAY hold real
 * funds is NEVER dropped — only a definitive "no coins were locked up yet" from
 * Boltz (or a resolved response carrying no userLock) returns true.
 * `getTransactions` is injectable for tests; the default configures the (viem-
 * free) boltz-swaps client and calls its getChainSwapTransactions. Port of
 * depix-frontend/wallet/boltz/stablecoin.js:186-196.
 */
export async function chainSwapNeverLocked(
  swapId: string,
  getTransactions?: GetChainSwapTransactions
): Promise<boolean> {
  if (!swapId) return false;
  try {
    const fetchTx: GetChainSwapTransactions =
      getTransactions ??
      (async (id: string) => {
        // The SDK configures the boltz-swaps client lazily (the frontend does it
        // globally at app init), so ensure the viem-free mainnet config is set
        // before the REST probe — otherwise the request would use an unconfigured
        // base URL and the fail-safe would degrade to "keep + re-error".
        await ensureBoltzConfig();
        const { getChainSwapTransactions } = (await import("boltz-swaps/client")) as unknown as {
          getChainSwapTransactions: (id: string) => Promise<ChainSwapTransactions>;
        };
        return getChainSwapTransactions(id);
      });
    const res = await fetchTx(swapId);
    return !res?.userLock; // resolved with no userLock = never locked
  } catch (e) {
    return /no coins were locked up yet/i.test(String((e as { message?: unknown } | null | undefined)?.message ?? e ?? ""));
  }
}

// Upper bound on how far in the future the chain-swap refund timeout may sit
// (~2 weeks at 1 L-BTC block/min). Mirrors MAX_SUBMARINE_TIMEOUT_BLOCKS.
export const MAX_CHAIN_TIMEOUT_BLOCKS = 20160;

// Max share of the swap value the route's fees may consume. Below this floor a
// swap is uneconomical AND risks reverting at execution: the route ends in a DEX
// (+ a LayerZero bridge for non-Arbitrum targets) whose FIXED costs dominate tiny
// amounts. The chain swap's own ~1000-sat minimum is far too low to catch this.
export const STABLECOIN_MAX_FEE_RATIO = 0.15;

export interface CheckStablecoinAmountParams {
  amountSats: number;
  sendUsd?: number;
  receiveUsd?: number;
  minSats?: number | null;
  maxSats?: number | null;
  bridgeFeeSats?: number | null;
}

export type CheckStablecoinAmountResult =
  | { ok: true }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "below_min"; minSats: number }
  | { ok: false; reason: "above_max"; maxSats: number }
  | { ok: false; reason: "bridge_fee"; bridgeFeeSats: number; suggestedMinSats: number }
  | { ok: false; reason: "fee_ratio"; feeRatio: number; suggestedMinSats: number };

/**
 * Decide whether an L-BTC -> stablecoin amount is allowed, BEFORE locking any
 * L-BTC. Pure + synchronous (port of the frontend's checkStablecoinAmount). The
 * guardrail choke point (§4) is separate and mandatory; this is the economic /
 * dust guard so a swap does not lock funds it cannot settle.
 */
export function checkStablecoinAmount(p: CheckStablecoinAmountParams): CheckStablecoinAmountResult {
  const amt = Number(p.amountSats) || 0;
  if (amt <= 0) return { ok: false, reason: "empty" };
  if (typeof p.minSats === "number" && amt < p.minSats) return { ok: false, reason: "below_min", minSats: p.minSats };
  if (typeof p.maxSats === "number" && amt > p.maxSats) return { ok: false, reason: "above_max", maxSats: p.maxSats };
  // Fixed bridge cost (Tron/non-Arbitrum). NOT reflected in the quote's
  // receiveAmount, so it must be gated explicitly: a swap at or below the bridge
  // fee CANNOT execute, and one marginally above it is uneconomical.
  if (typeof p.bridgeFeeSats === "number" && p.bridgeFeeSats > 0) {
    if (amt <= p.bridgeFeeSats || p.bridgeFeeSats / amt > STABLECOIN_MAX_FEE_RATIO) {
      return {
        ok: false,
        reason: "bridge_fee",
        bridgeFeeSats: p.bridgeFeeSats,
        suggestedMinSats: Math.ceil(p.bridgeFeeSats / STABLECOIN_MAX_FEE_RATIO)
      };
    }
  }
  if (typeof p.sendUsd === "number" && p.sendUsd > 0 && typeof p.receiveUsd === "number") {
    const feeRatio = (p.sendUsd - p.receiveUsd) / p.sendUsd;
    if (feeRatio > STABLECOIN_MAX_FEE_RATIO) {
      const suggestedMinSats = Math.ceil(((p.sendUsd - p.receiveUsd) / STABLECOIN_MAX_FEE_RATIO) * (amt / p.sendUsd));
      return { ok: false, reason: "fee_ratio", feeRatio, suggestedMinSats };
    }
  }
  return { ok: true };
}

// ── ephemeral viem signer (dynamic import, STABLECOIN_DEPS_MISSING-guarded) ─────

/** Minimal shape the boltz-swaps route executor needs from a local viem signer. */
export interface LocalEvmSigner {
  address: string;
  walletClient: unknown;
  provider: unknown;
  /** "gas-abstraction" — marks the hosted-sponsor gas path (sponsor.ccxp.space). */
  rdns: string;
}

// Reads happen on Arbitrum (where tBTC lands + the DEX runs); the gas-sponsored
// sends route through Boltz's hosted sponsor, NOT this RPC (no Alchemy key ours).
export const ARBITRUM_RPC = "https://arb1.arbitrum.io/rpc";

/** The viem surface used by the stablecoin path — a subset for the dynamic import. */
export interface ViemLike {
  createWalletClient: (opts: { account: unknown; transport: unknown }) => unknown;
  createPublicClient: (opts: { transport: unknown }) => unknown;
  http: (url?: string) => unknown;
  isAddress: (value: string) => boolean;
}
export interface ViemAccountsLike {
  privateKeyToAccount: (hex0x: `0x${string}`) => { address: string };
}

export interface LoadedViem {
  viem: ViemLike;
  accounts: ViemAccountsLike;
}

/** Override the viem importer (tests) — defaults to the real dynamic imports. */
export type ViemImporter = () => Promise<LoadedViem>;

/**
 * Dynamically import viem (+ viem/accounts), wrapping any resolution failure in
 * the typed STABLECOIN_DEPS_MISSING error (§2.2). viem is a regular dependency
 * (G5), so this normally succeeds; the guard is defense-in-depth for a broken or
 * partial install.
 */
export async function loadViem(importer?: ViemImporter): Promise<LoadedViem> {
  const doImport: ViemImporter =
    importer ??
    (async () => {
      const [viem, accounts] = await Promise.all([import("viem"), import("viem/accounts")]);
      return { viem: viem as unknown as ViemLike, accounts: accounts as unknown as ViemAccountsLike };
    });
  try {
    return await doImport();
  } catch (err) {
    throw new ConversionError(
      "STABLECOIN_DEPS_MISSING",
      "The EVM signing stack (viem) could not be loaded — reinstall @depixapp/sdk with its viem dependency to use stablecoin conversions.",
      { cause: err }
    );
  }
}

/**
 * Build a LOCAL viem signer from an ephemeral 0x-hex private key — no
 * walletconnect, no browser wallet. Shaped like boltz-web-app's
 * getGasAbstractionSigner (walletClient + address + provider + rdns). Gas is paid
 * by the hosted sponsor, so the returned signer carries the "gas-abstraction"
 * rdns marker. Pure w.r.t. the wallet seed (this key is per-swap, never the seed).
 */
export async function buildLocalSigner(
  evmPrivateKeyHex0x: `0x${string}`,
  opts: { importer?: ViemImporter; rpc?: string } = {}
): Promise<LocalEvmSigner> {
  const { viem, accounts } = await loadViem(opts.importer);
  const account = accounts.privateKeyToAccount(evmPrivateKeyHex0x);
  const transport = viem.http(opts.rpc ?? ARBITRUM_RPC);
  const walletClient = viem.createWalletClient({ account, transport });
  const provider = viem.createPublicClient({ transport });
  const signer = Object.assign(walletClient as object, {
    address: account.address,
    provider,
    rdns: "gas-abstraction"
  });
  return { address: account.address, walletClient: signer, provider, rdns: "gas-abstraction" };
}

/**
 * Run `use` with an ephemeral viem signer built from `keyBytes`, ALWAYS zeroing
 * `keyBytes` afterward — even if `use` throws (a post-lockup execution failure).
 * This is the SDK's parity with the frontend's zeroInMemory discipline: the
 * per-swap EVM key never lingers in a live buffer past its signing session. The
 * only persistent copy is AES-256-GCM-encrypted at rest in boltz-swaps.json.
 */
export async function withEphemeralEvmSigner<T>(
  keyBytes: Uint8Array,
  use: (signer: LocalEvmSigner) => Promise<T>,
  deps: { buildSigner?: (hex0x: `0x${string}`) => Promise<LocalEvmSigner>; importer?: ViemImporter; rpc?: string } = {}
): Promise<T> {
  // viem's privateKeyToAccount requires a 0x-hex STRING; JS strings are immutable
  // and cannot be wiped, so this copy is an inherent, TRANSIENT residual — it is
  // materialized only for this signing session and released when the call returns
  // (GC-eligible). The authoritative buffer (keyBytes) IS zeroed in `finally`.
  const hex0x = (`0x${hex.encode(keyBytes)}`) as `0x${string}`;
  try {
    const build =
      deps.buildSigner ??
      ((h: `0x${string}`) => buildLocalSigner(h, { ...(deps.importer ? { importer: deps.importer } : {}), ...(deps.rpc ? { rpc: deps.rpc } : {}) }));
    const signer = await build(hex0x);
    return await use(signer);
  } finally {
    keyBytes.fill(0); // zero the ephemeral EVM key after use (frontend parity)
  }
}

// ── per-swap key material ───────────────────────────────────────────────────

export interface StablecoinKeys {
  /** Chain-swap preimage (bytes) — revealed at claim to release the L-BTC lockup. */
  preimage: Uint8Array;
  /** SHA256(preimage) — binds the lockup's claim leaf. */
  preimageHash: Uint8Array;
  /** L-BTC lockup refund keypair (the ONLY key that can sweep the lockup back). */
  refundPrivateKey: Uint8Array;
  refundPublicKey: Uint8Array;
  /** Ephemeral EVM key for the gasless DEX/bridge/claim legs (bytes; zeroed after use). */
  evmPrivateKey: Uint8Array;
}

/**
 * Fresh per-swap secrets (port of deriveBoltzStableKeys): a chain-swap preimage
 * (+ hash), an L-BTC refund keypair, and an ephemeral EVM key. All from the CSPRNG
 * — none is the wallet seed.
 */
export function deriveStablecoinKeys(): StablecoinKeys {
  const preimage = new Uint8Array(32);
  globalThis.crypto.getRandomValues(preimage);
  const preimageHash = sha256(preimage);
  const refund = randomKeypair();
  const evmPrivateKey = new Uint8Array(32);
  globalThis.crypto.getRandomValues(evmPrivateKey);
  return {
    preimage,
    preimageHash,
    refundPrivateKey: refund.privateKey,
    refundPublicKey: refund.publicKey,
    evmPrivateKey
  };
}

// ── route creation + verification (the pre-lockup, fail-closed guard cadence) ───

/** Boltz createRoute response (the subset the flow consumes). */
export interface CreatedStablecoinRoute {
  createdSwap: {
    id: string;
    /**
     * The tBTC (claim-side) details Boltz commits. Its `claimAddress`, when
     * present, MUST equal our ephemeral signer EOA — the strongest recipient
     * check the SDK can make against returned data (see prepareStablecoinRoute).
     */
    claimDetails?: { claimAddress?: string };
    lockupDetails: {
      lockupAddress: string;
      amount: number | string;
      timeoutBlockHeight: number | string;
      swapTree: unknown;
      serverPublicKey: string;
      blindingKey?: string;
    };
  };
  plan: unknown;
}

export interface StablecoinParams {
  asset: StablecoinAsset;
  networkId: string;
  /** L-BTC to convert (sats). */
  amountSats: number;
  /** FINAL recipient address (EVM/Tron) the stablecoin is delivered to. */
  claimAddress: string;
}

export interface PrepareStablecoinDeps {
  /** viem importer override (tests) — also gates STABLECOIN_DEPS_MISSING. */
  viemImporter?: ViemImporter;
  /** Configure the boltz-swaps client (default: createBoltzClient(mainnetConfig)). */
  ensureConfig?: () => Promise<void>;
  /** Derive the per-swap key material (default deriveStablecoinKeys). */
  deriveKeys?: () => StablecoinKeys;
  /** Fetch the full boltz-swaps pairs object (default: dynamic import). */
  getPairs?: () => Promise<unknown>;
  /** Route quote for the default economic pre-check (forwarded to estimateStablecoinOut). */
  quoteRouteAmountOut?: EstimateStablecoinDeps["quoteRouteAmountOut"];
  /** Bridge-fee DEX quote for the default economic pre-check (forwarded to estimateStablecoinOut). */
  quoteDexAmountOut?: EstimateStablecoinDeps["quoteDexAmountOut"];
  /** Create the chain swap route (default: boltz-swaps/routeExecute createRoute). */
  createRoute?: (args: {
    from: string;
    to: string;
    pairs: unknown;
    preimageHash: string;
    claimAddress: string;
    refundPublicKey: string;
    userLockAmount: number;
  }) => Promise<CreatedStablecoinRoute>;
  /** Token-contract-destination guard (default: boltz-swaps/evm isKnownTokenAddress). */
  isKnownTokenAddress?: (variant: string, address: string) => boolean | Promise<boolean>;
  /** Lockup verifier override (default: the real re-derivation). */
  verifyLockup?: typeof assertLockupAddressBindsToUser;
  /** Current L-BTC height for the timeout bound; null = skip (best-effort). */
  getChainHeight?: () => Promise<number | null>;
  /** Override the max timeout bound (default MAX_CHAIN_TIMEOUT_BLOCKS). */
  maxTimeoutBlocks?: number;
  /** Build the ephemeral signer (tests) — default buildLocalSigner. */
  buildSigner?: (hex0x: `0x${string}`) => Promise<LocalEvmSigner>;
  rpc?: string;
  /**
   * Economic / dust pre-check source (default: estimateStablecoinOut, viem-free).
   * Supplies the chain-swap min/max AND the fixed bridge fee (all in L-BTC sats)
   * that checkStablecoinAmount uses to reject an amount the route cannot settle
   * BEFORE any L-BTC is locked. `bridgeFeeSats` is null for non-bridged (Arbitrum)
   * routes; it is optional here so a test may inject a min/max-only estimate.
   */
  estimate?: (p: {
    asset: StablecoinAsset;
    networkId: string;
    amountSats: number;
  }) => Promise<Pick<StablecoinEstimate, "minSats" | "maxSats"> & { bridgeFeeSats?: number | null }>;
}

/**
 * The verified, ready-to-fund stablecoin route. Carries the resume/refund
 * material the store persists (encrypted) BEFORE the L-BTC is locked, plus the
 * ephemeral `evmPrivateKey` BYTES the caller zeroes once persisted / after
 * execution.
 */
export interface PreparedStablecoinRoute {
  swapId: string;
  asset: StablecoinAsset;
  networkId: string;
  claimAddress: string;
  lockupAddress: string;
  /** Sats Boltz says the wallet must lock (validated not-inflated). */
  lockAmountSats: number;
  timeoutBlockHeight: number;
  createdSwap: unknown;
  plan: unknown;
  serverPublicKey: string;
  swapTree: unknown;
  blindingKey?: string;
  preimageHex: string;
  refundPrivateKeyHex: string;
  refundPublicKeyHex: string;
  /** Ephemeral EVM key (bytes) — caller must zero after persisting/executing. */
  evmPrivateKey: Uint8Array;
}

const LBTC_VIA_ASSET = "L-BTC";

// The native gas token sentinel (address(0)) — mirrors `zeroAddress` in boltz-swaps
// routeExecute.claimViaRouterBridge, where the bridge messaging fee is priced against
// the native gas token via quoteDexAmountOut(dex.chain, dex.tokenIn, zeroAddress, …).
const ZERO_GAS_TOKEN = "0x0000000000000000000000000000000000000000";
// tBTC is an 18-decimal ERC-20 (Arbitrum); L-BTC sats are 8-decimal. wei / 1e10 = sats.
const TBTC_WEI_PER_LBTC_SAT = 10_000_000_000n;

/**
 * Create a Boltz chain swap for `params` and run the full fail-closed guard
 * cadence (frontend runUsdcSwap steps 1–9), returning a verified route. Throws
 * ConversionError on any guard violation BEFORE the caller locks any funds:
 *   - unsupported target / invalid destination / token-contract → SWAP_VALIDATION_FAILED
 *   - inflated lockup amount → LOCKUP_INFLATED
 *   - refund timeout out of the safe window → TIMEOUT_OUT_OF_BOUNDS
 *   - re-derived lockup tree/address mismatch → LOCKUP_TREE_MISMATCH (verify-lockup)
 *   - missing viem → STABLECOIN_DEPS_MISSING (loadViem)
 *
 * The chain swap commits the EPHEMERAL signer's address as its own claim address;
 * the user's destination is only ever executeRoute's `recipient` (§5.3).
 *
 * @internal Returns the raw ephemeral EVM key BYTES in `PreparedStablecoinRoute`,
 * so it is NOT part of the public surface (not re-exported from the barrels). Use
 * `wallet.convert.boltz.toStablecoin`, which owns and zeroes the key.
 */
export async function prepareStablecoinRoute(
  params: StablecoinParams,
  deps: PrepareStablecoinDeps = {}
): Promise<PreparedStablecoinRoute> {
  const variant = boltzVariantKey(params.asset, params.networkId);
  if (!variant) {
    throw new ConversionError(
      "SWAP_VALIDATION_FAILED",
      `Unsupported Boltz stablecoin target: ${params.asset} on ${params.networkId}`
    );
  }
  const network = getStablecoinNetwork(params.networkId);
  const dest = typeof params.claimAddress === "string" ? params.claimAddress.trim() : "";
  if (!dest) {
    throw new ConversionError("SWAP_VALIDATION_FAILED", "A destination address is required");
  }
  if (!Number.isFinite(params.amountSats) || params.amountSats <= 0) {
    throw new ConversionError("SWAP_VALIDATION_FAILED", "amountSats must be a positive number of L-BTC sats");
  }

  // Strict destination validation, dispatched by family. EVM uses viem's isAddress
  // (EIP-55 checksum — catches a mistyped/corrupted address; all-lowercase carries
  // no checksum and passes). Tron base58check IS its own checksum. Loading viem
  // here also surfaces STABLECOIN_DEPS_MISSING up front, before any swap is made.
  if (network?.family === "tron") {
    if (!isValidTronAddress(dest)) {
      throw new ConversionError("SWAP_VALIDATION_FAILED", "Invalid Tron destination address (base58check failed)");
    }
  } else {
    const { viem } = await loadViem(deps.viemImporter);
    if (!viem.isAddress(dest)) {
      throw new ConversionError("SWAP_VALIDATION_FAILED", "Invalid EVM destination address (EIP-55 checksum failed)");
    }
  }

  if (deps.ensureConfig) await deps.ensureConfig();
  else await ensureStablecoinConfig();

  // Token-CONTRACT guard: delivering to a token's own contract burns the funds
  // forever. Same guard boltz.exchange uses (isKnownTokenAddress over Boltz's
  // full catalog). Defense-in-depth — the engine re-checks at execution.
  const isTokenContract = deps.isKnownTokenAddress ?? defaultIsKnownTokenAddress;
  if (await isTokenContract(variant, dest)) {
    throw new ConversionError(
      "SWAP_VALIDATION_FAILED",
      "Destination is a token CONTRACT address — funds sent to it are unrecoverable. Paste a wallet/exchange address."
    );
  }

  // Economic / dust guard (§5.3): reject an amount the chain-swap + DEX (+ bridge)
  // route cannot settle BEFORE locking any L-BTC. A sub-minimum lock would strand
  // funds in a forced refund cycle (wasted lockup + refund fees; principal is
  // refundable). Boltz's own chain-swap min/max encodes the route's fixed-cost
  // floor, and both bounds are in L-BTC sats (same unit as amountSats). On a
  // BRIDGED destination (LayerZero/OFT — non-Arbitrum) that min/max is far too low
  // to catch the fixed bridge messaging fee, which is NOT reflected in the quote:
  // the estimate also surfaces `bridgeFeeSats` (null for Arbitrum), and passing it
  // through here makes checkStablecoinAmount's bridge_fee / fee_ratio branches live
  // so an amount that could not cover the bridge fee is rejected pre-lockup instead
  // of locking then reverting at executeRoute ("amount too small to cover bridge
  // messaging fee"). Fail-closed. Port of depix-frontend swap-ui.js (~L1251-1256).
  const estimate =
    deps.estimate ??
    ((p: { asset: StablecoinAsset; networkId: string; amountSats: number }) =>
      estimateStablecoinOut(p, {
        ...(deps.ensureConfig ? { ensureConfig: deps.ensureConfig } : {}),
        ...(deps.getPairs ? { getPairs: deps.getPairs } : {}),
        ...(deps.quoteRouteAmountOut ? { quoteRouteAmountOut: deps.quoteRouteAmountOut } : {}),
        ...(deps.quoteDexAmountOut ? { quoteDexAmountOut: deps.quoteDexAmountOut } : {})
      }));
  const limits = await estimate({
    asset: params.asset,
    networkId: params.networkId,
    amountSats: params.amountSats
  });
  const econ = checkStablecoinAmount({
    amountSats: params.amountSats,
    ...(typeof limits.minSats === "number" ? { minSats: limits.minSats } : {}),
    ...(typeof limits.maxSats === "number" ? { maxSats: limits.maxSats } : {}),
    ...(typeof limits.bridgeFeeSats === "number" ? { bridgeFeeSats: limits.bridgeFeeSats } : {})
  });
  if (!econ.ok) {
    const detail =
      econ.reason === "below_min"
        ? `below the route minimum of ${econ.minSats} sats`
        : econ.reason === "above_max"
          ? `above the route maximum of ${econ.maxSats} sats`
          : econ.reason === "bridge_fee"
            ? `at or under the bridge fee (need ~${econ.suggestedMinSats} sats)`
            : econ.reason === "fee_ratio"
              ? `uneconomical — fees exceed ${Math.round(STABLECOIN_MAX_FEE_RATIO * 100)}% of the amount`
              : "not a positive amount";
    throw new ConversionError(
      "SWAP_VALIDATION_FAILED",
      `Amount ${params.amountSats} sats cannot settle to ${params.asset} on ${params.networkId}: ${detail} — no L-BTC was locked.`
    );
  }

  const keys = (deps.deriveKeys ?? deriveStablecoinKeys)();

  // The chain swap commits the SIGNER's EOA as its claim address (the EIP-712
  // claim signature comes from this key). Derive that address without keeping a
  // live signer — the ephemeral key is rebuilt + zeroed only inside the execute
  // session (withEphemeralEvmSigner). The user's destination stays the recipient.
  // Transient 0x-hex string (viem requirement, immutable/non-wipeable) — used only
  // to derive the signer address, then goes out of scope. The persisted copy is the
  // ENCRYPTED record; the caller zeroes the key BYTES (keys.evmPrivateKey) after use.
  const evmHex0x = (`0x${hex.encode(keys.evmPrivateKey)}`) as `0x${string}`;
  const { accounts } = await loadViem(deps.viemImporter);
  const signerAddress =
    deps.buildSigner !== undefined
      ? (await deps.buildSigner(evmHex0x)).address
      : accounts.privateKeyToAccount(evmHex0x).address;

  const getPairs = deps.getPairs ?? defaultGetPairs;
  const createRoute = deps.createRoute ?? defaultCreateRoute;
  const pairs = await getPairs();
  const { createdSwap, plan } = await createRoute({
    from: LBTC_VIA_ASSET,
    to: variant,
    pairs,
    // boltz-swaps' chain-swap createRoute wants preimageHash as a HEX STRING (it
    // spreads args raw into the POST /v2/swap/chain body) — same as reverse.ts.
    // A raw Uint8Array JSON-serializes to {"0":..,"1":..} and Boltz rejects the
    // request with "invalid parameter: preimageHash". Keep this hex.encode() in
    // sync with reverse.ts so the asymmetry doesn't creep back in.
    preimageHash: hex.encode(keys.preimageHash),
    claimAddress: signerAddress,
    refundPublicKey: hex.encode(keys.refundPublicKey),
    userLockAmount: params.amountSats
  });

  const ld = createdSwap?.lockupDetails;
  if (!createdSwap?.id || !ld?.lockupAddress || ld?.amount === undefined || ld?.amount === null) {
    throw new ConversionError("SWAP_VALIDATION_FAILED", "Boltz createRoute returned an incomplete swap");
  }

  // Sponsor / boltz-swaps trust boundary (§5.3, G5): treat the returned route as
  // untrusted. The strongest recipient check the SDK can make against RETURNED
  // data is to bind the chain-swap CLAIM side to OUR ephemeral EOA: when Boltz
  // echoes a claim address, it MUST be exactly the signer address we committed —
  // this refuses a hostile/compromised route that advertises a foreign tBTC
  // claimer. The FINAL DEX/bridge delivery to the user's `claimAddress` is built
  // inside boltz-swaps and is NOT exposed for SDK inspection (RoutePlan carries
  // only asset/chain metadata, no address), so that leg stays the accepted G5
  // dependency risk — bounded: the ephemeral key never leaves the device and the
  // EOA only ever holds this one swap's tBTC. A missing field is best-effort
  // skipped (never fail-OPEN on a PRESENT mismatch).
  const returnedClaim = createdSwap.claimDetails?.claimAddress;
  if (typeof returnedClaim === "string" && returnedClaim.trim().toLowerCase() !== signerAddress.trim().toLowerCase()) {
    throw new ConversionError(
      "SWAP_VALIDATION_FAILED",
      `Boltz route claim address ${returnedClaim} does not match our ephemeral signer ${signerAddress} — refusing to fund a route that would claim to a foreign EOA.`
    );
  }

  // Guard 1: the lockup must never exceed what the caller agreed to send (a buggy
  // /compromised route response trying to drain extra L-BTC). A smaller amount is
  // safe and allowed. Mirrors the submarine assertLockupNotInflated.
  // Bound the lock amount BOTH ways: an inflated lock drains extra L-BTC, and a
  // zero/negative lock from a buggy/hostile response must be rejected here rather
  // than relying solely on the downstream guardrail's fail-closed arithmetic.
  const lockAmount = Number(ld.amount);
  if (!Number.isFinite(lockAmount) || lockAmount <= 0 || lockAmount > params.amountSats) {
    throw new ConversionError(
      "LOCKUP_INFLATED",
      `Boltz route asks to lock ${String(ld.amount)} sats, more than the requested ${params.amountSats}`
    );
  }

  // Guard 2: sane-bound the refund timeout against live L-BTC height (best-effort).
  const timeoutBlockHeight = Number(ld.timeoutBlockHeight);
  let chainHeight: number | null = null;
  if (deps.getChainHeight) {
    try {
      chainHeight = await deps.getChainHeight();
    } catch {
      chainHeight = null;
    }
  }
  const maxBound = deps.maxTimeoutBlocks ?? MAX_CHAIN_TIMEOUT_BLOCKS;
  if (
    chainHeight !== null &&
    Number.isFinite(chainHeight) &&
    Number.isFinite(timeoutBlockHeight) &&
    (timeoutBlockHeight <= chainHeight || timeoutBlockHeight > chainHeight + maxBound)
  ) {
    throw new ConversionError(
      "TIMEOUT_OUT_OF_BOUNDS",
      `Boltz route refund timeout ${timeoutBlockHeight} is outside the safe window (height ${chainHeight}) — cancelled before locking funds`
    );
  }

  // Guard 3 (CRITICAL): re-derive the expected lockup from OUR refund key +
  // preimage hash and assert Boltz's address/tree match byte-for-byte (chain swap
  // tree). Never fund an address whose refund leaf isn't ours or whose claim leaf
  // commits to a hash Boltz controls.
  const verify = deps.verifyLockup ?? assertLockupAddressBindsToUser;
  await verify({
    swapType: "chain",
    lockupAddress: ld.lockupAddress,
    swapTree: ld.swapTree,
    serverPublicKey: ld.serverPublicKey,
    refundPublicKey: hex.encode(keys.refundPublicKey),
    refundPrivateKey: hex.encode(keys.refundPrivateKey),
    expectedHash: hex.encode(keys.preimageHash),
    timeoutBlockHeight
  });

  return {
    swapId: createdSwap.id,
    asset: params.asset,
    networkId: params.networkId,
    claimAddress: dest,
    lockupAddress: ld.lockupAddress,
    lockAmountSats: lockAmount,
    timeoutBlockHeight,
    createdSwap,
    plan,
    serverPublicKey: ld.serverPublicKey,
    swapTree: ld.swapTree,
    ...(ld.blindingKey !== undefined ? { blindingKey: ld.blindingKey } : {}),
    preimageHex: hex.encode(keys.preimage),
    refundPrivateKeyHex: hex.encode(keys.refundPrivateKey),
    refundPublicKeyHex: hex.encode(keys.refundPublicKey),
    evmPrivateKey: keys.evmPrivateKey
  };
}

// ── execution (post-lockup: wait for server lockup, then claim → DEX → bridge) ──

export interface ExecuteStablecoinRecord {
  swapId: string;
  claimAddress: string;
  createdSwap: unknown;
  plan: unknown;
  preimageHex: string;
  /** Ephemeral EVM key, hex (from the encrypted store) — decoded, used, zeroed. */
  evmPrivateKeyHex: string;
}

export interface ExecuteStablecoinDeps {
  /** Wait until the chain swap's destination is server-locked (claimable). */
  waitForServerLockup: (swapId: string) => Promise<void>;
  /** Run the router claim → DEX → bridge → deliver (default: boltz-swaps executeRoute). */
  executeRoute?: (args: {
    createdSwap: unknown;
    plan: unknown;
    preimage: string;
    signer: LocalEvmSigner;
    recipient: string;
  }) => Promise<{ claimTransactionId: string }>;
  buildSigner?: (hex0x: `0x${string}`) => Promise<LocalEvmSigner>;
  viemImporter?: ViemImporter;
  ensureConfig?: () => Promise<void>;
  rpc?: string;
}

/**
 * Finish a stablecoin swap whose L-BTC lockup already landed: wait for Boltz's
 * confirmed destination lockup, then run the router claim + DEX + bridge, signed
 * by the ephemeral viem account (gas via the hosted sponsor). The ephemeral EVM
 * key is decoded from the record, used inside withEphemeralEvmSigner, and ZEROED
 * afterward. The destination claim reveals the preimage, so completing the swap is
 * what makes the locked L-BTC go through.
 */
export async function executeStablecoinRoute(
  record: ExecuteStablecoinRecord,
  deps: ExecuteStablecoinDeps
): Promise<{ swapId: string; claimTransactionId: string }> {
  if (!record?.createdSwap || !record?.plan || !record?.preimageHex || !record?.evmPrivateKeyHex || !record?.claimAddress) {
    throw new ConversionError(
      "SWAP_VALIDATION_FAILED",
      "executeStablecoinRoute: record is missing resume material (createdSwap/plan/preimage/evmPrivateKey)"
    );
  }
  if (deps.ensureConfig) await deps.ensureConfig();
  else await ensureStablecoinConfig();

  await deps.waitForServerLockup(record.swapId);

  const executeRoute = deps.executeRoute ?? defaultExecuteRoute;
  // boltz-swaps' executeRoute wants the preimage as a HEX STRING — its EVM claim
  // leg calls prefix0x(val) => (val.startsWith("0x") ? …) on it, and a Uint8Array
  // has no .startsWith (throws "val.startsWith is not a function"). record.preimageHex
  // is already bare hex; boltz-swaps normalizes it. Same class as the preimageHash fix.
  const preimage = record.preimageHex;
  const keyBytes = hex.decode(record.evmPrivateKeyHex);
  const { claimTransactionId } = await withEphemeralEvmSigner(
    keyBytes,
    (signer) =>
      executeRoute({
        createdSwap: record.createdSwap,
        plan: record.plan,
        preimage,
        signer,
        recipient: record.claimAddress
      }),
    {
      ...(deps.buildSigner ? { buildSigner: deps.buildSigner } : {}),
      ...(deps.viemImporter ? { importer: deps.viemImporter } : {}),
      ...(deps.rpc ? { rpc: deps.rpc } : {})
    }
  );
  return { swapId: record.swapId, claimTransactionId };
}

// ── read-only estimate (viem-free) ─────────────────────────────────────────────

export interface StablecoinEstimate {
  receiveAmount: bigint;
  decimals: number;
  sendAmountSats: number;
  boltzPercent: number | null;
  minerFeesSats: number;
  /**
   * Fixed bridge cost in L-BTC sats for a BRIDGED destination (LayerZero/OFT —
   * non-Arbitrum targets like Tron/Polygon/Optimism/Ethereum, or USDC on Base),
   * or `null` when the route has no bridge leg (Arbitrum) or the fee could not be
   * priced. NOT reflected in `receiveAmount`, so the caller must gate on it
   * explicitly (checkStablecoinAmount bridge_fee / fee_ratio) BEFORE locking any
   * L-BTC — see the derivation in estimateStablecoinOut.
   */
  bridgeFeeSats: number | null;
  minSats: number | null;
  maxSats: number | null;
}

export interface EstimateStablecoinDeps {
  ensureConfig?: () => Promise<void>;
  getPairs?: () => Promise<unknown>;
  quoteRouteAmountOut?: (args: { from: string; to: string; pairs: unknown; amountIn: bigint }) => Promise<{
    receiveAmount: bigint;
    sendAmount?: bigint | number;
    legs?: Array<Record<string, unknown>>;
  }>;
  /**
   * Price the bridge messaging fee (native gas token) in the DEX's input token
   * (tBTC), used only to derive bridgeFeeSats. Injected for offline tests; the
   * default dynamically imports boltz-swaps/client's quoteDexAmountOut — the same
   * function routeExecute.claimViaRouterBridge uses to gate the bridge leg.
   */
  quoteDexAmountOut?: (
    chain: string,
    tokenIn: string,
    tokenOut: string,
    amountOut: bigint
  ) => Promise<Array<{ quote: string | number | bigint }>>;
}

/**
 * Estimate how much USDC/USDT a given L-BTC amount yields (chain swap + DEX +
 * bridge), using the same route math Boltz's own site shows. Read-only, viem-free
 * — creates no swap. Feeds the caller's economic guard (checkStablecoinAmount).
 */
export async function estimateStablecoinOut(
  params: { asset: StablecoinAsset; networkId: string; amountSats: number | bigint },
  deps: EstimateStablecoinDeps = {}
): Promise<StablecoinEstimate> {
  const variant = boltzVariantKey(params.asset, params.networkId);
  if (!variant) {
    throw new ConversionError(
      "SWAP_VALIDATION_FAILED",
      `Unsupported Boltz stablecoin target: ${params.asset} on ${params.networkId}`
    );
  }
  if (deps.ensureConfig) await deps.ensureConfig();
  else await ensureStablecoinConfig();

  const getPairs = deps.getPairs ?? defaultGetPairs;
  const quoteRouteAmountOut = deps.quoteRouteAmountOut ?? defaultQuoteRouteAmountOut;
  const pairs = (await getPairs()) as { chain?: Record<string, Record<string, { limits?: { minimal?: number; maximal?: number } }>> };
  const quote = await quoteRouteAmountOut({ from: LBTC_VIA_ASSET, to: variant, pairs, amountIn: BigInt(params.amountSats) });

  let boltzPercent: number | null = null;
  let minerFeesSats = 0;
  for (const leg of quote.legs ?? []) {
    if ((leg as { kind?: string }).kind === "chain-swap" && (leg as { fees?: unknown }).fees) {
      const fees = (leg as { fees: { percentage?: number; minerFees?: Record<string, number> } }).fees;
      if (typeof fees.percentage === "number") boltzPercent = fees.percentage;
      const m = fees.minerFees;
      if (m) minerFeesSats += Number(m.server || 0) + Number(m.userLockup || 0) + Number(m.userClaim || 0);
    }
  }

  // BRIDGE messaging fee (LayerZero/OFT for non-Arbitrum targets like Tron) is a
  // FIXED cost paid in destination-chain gas, deducted from the tBTC BEFORE the DEX
  // leg — and it is NOT reflected in quote.receiveAmount, so the quote looks healthy
  // for an amount that cannot actually execute ("amount too small to cover bridge
  // messaging fee" is thrown only at executeRoute, AFTER the L-BTC is locked; see
  // boltz-swaps routeExecute.claimViaRouterBridge). Pre-flight it here, replicating
  // that gate with the quote's own numbers + one read-only DEX quote, so the caller
  // (checkStablecoinAmount) can block the swap BEFORE any funds move. Best-effort:
  // any structural surprise leaves bridgeFeeSats null and the min/max/ratio guards
  // still apply. Arbitrum has no bridge leg → stays null (unaffected). Port of
  // depix-frontend/wallet/boltz/stablecoin.js estimateStablecoinOut (~L132-145).
  let bridgeFeeSats: number | null = null;
  try {
    const legs = (quote.legs ?? []) as Array<Record<string, unknown>>;
    const bridgeLeg = legs.find((l) => l.kind === "bridge");
    const dexLeg = legs.find((l) => l.kind === "dex");
    const chainLeg = legs.find((l) => l.kind === "chain-swap");
    const messagingFee = (bridgeLeg?.messagingFee as { amount?: bigint | number | string } | undefined)?.amount;
    const dexChain = dexLeg?.chain as string | undefined;
    const dexTokenIn = dexLeg?.tokenIn as string | undefined;
    const chainReceive = chainLeg?.receiveAmount;
    if (messagingFee && dexChain && chainReceive) {
      const quoteDexAmountOut = deps.quoteDexAmountOut ?? defaultQuoteDexAmountOut;
      // Price the messaging fee (native gas token, address(0)) in the DEX input
      // token (tBTC), exactly as routeExecute does: quoteDexAmountOut(dex.chain,
      // dex.tokenIn, zeroAddress, msgFee).
      const [feeQuote] = await quoteDexAmountOut(dexChain, dexTokenIn ?? "", ZERO_GAS_TOKEN, BigInt(messagingFee));
      // tBTC (18-decimal ERC-20 on Arbitrum) → L-BTC sats (8-decimal): divide by 1e10.
      const feeTbtcWei = BigInt(feeQuote!.quote);
      bridgeFeeSats = Number(feeTbtcWei / TBTC_WEI_PER_LBTC_SAT);
    }
  } catch {
    /* leave null — the min/max/ratio guards still apply */
  }

  const chainLimits = pairs?.chain?.[LBTC_VIA_ASSET]?.["TBTC"]?.limits ?? null;
  return {
    receiveAmount: quote.receiveAmount,
    decimals: STABLECOIN_DECIMALS,
    sendAmountSats: Number(quote.sendAmount ?? params.amountSats),
    boltzPercent,
    minerFeesSats,
    // Fixed bridge cost in L-BTC sats (null when the route has no bridge or it
    // couldn't be priced). The caller blocks the swap when this is not comfortably
    // covered — see checkStablecoinAmount's bridge_fee / fee_ratio branches.
    bridgeFeeSats,
    minSats: typeof chainLimits?.minimal === "number" ? chainLimits.minimal : null,
    maxSats: typeof chainLimits?.maximal === "number" ? chainLimits.maximal : null
  };
}

// ── default (real) dynamic-import bindings ─────────────────────────────────────

let stablecoinConfigured = false;
/**
 * Configure the boltz-swaps client for the stablecoin route exactly once. Unlike
 * the Lightning path (client.ts, which uses the viem-FREE setBoltzSwapsConfig),
 * the stablecoin route needs the FULL client (route/EVM execution), so it uses
 * createBoltzClient from the main barrel — the one place viem is pulled in.
 */
export async function ensureStablecoinConfig(): Promise<void> {
  if (stablecoinConfigured) return;
  try {
    const [{ createBoltzClient }, { mainnetConfig }] = await Promise.all([
      import("boltz-swaps"),
      import("boltz-swaps/presets/mainnet")
    ]);
    (createBoltzClient as (c: unknown) => void)(mainnetConfig);
    stablecoinConfigured = true;
  } catch (err) {
    throw new ConversionError(
      "STABLECOIN_DEPS_MISSING",
      "The boltz-swaps stablecoin engine (with viem) could not be loaded — reinstall @depixapp/sdk to use stablecoin conversions.",
      { cause: err }
    );
  }
}

/** Test hook — forget the one-shot stablecoin config latch. */
export function resetStablecoinConfigForTests(): void {
  stablecoinConfigured = false;
}

async function defaultGetPairs(): Promise<unknown> {
  const { getPairs } = (await import("boltz-swaps")) as unknown as { getPairs: () => Promise<unknown> };
  return getPairs();
}

async function defaultQuoteRouteAmountOut(args: {
  from: string;
  to: string;
  pairs: unknown;
  amountIn: bigint;
}): Promise<{ receiveAmount: bigint; sendAmount?: bigint | number; legs?: Array<Record<string, unknown>> }> {
  const { quoteRouteAmountOut } = (await import("boltz-swaps")) as unknown as {
    quoteRouteAmountOut: (a: typeof args) => Promise<{ receiveAmount: bigint; sendAmount?: bigint | number; legs?: Array<Record<string, unknown>> }>;
  };
  return quoteRouteAmountOut(args);
}

async function defaultQuoteDexAmountOut(
  chain: string,
  tokenIn: string,
  tokenOut: string,
  amountOut: bigint
): Promise<Array<{ quote: string }>> {
  const { quoteDexAmountOut } = (await import("boltz-swaps/client")) as unknown as {
    quoteDexAmountOut: (c: string, ti: string, to: string, a: bigint) => Promise<Array<{ quote: string }>>;
  };
  return quoteDexAmountOut(chain, tokenIn, tokenOut, amountOut);
}

async function defaultCreateRoute(args: {
  from: string;
  to: string;
  pairs: unknown;
  preimageHash: string;
  claimAddress: string;
  refundPublicKey: string;
  userLockAmount: number;
}): Promise<CreatedStablecoinRoute> {
  const { createRoute } = (await import("boltz-swaps/routeExecute")) as unknown as {
    createRoute: (a: typeof args) => Promise<CreatedStablecoinRoute>;
  };
  return createRoute(args);
}

async function defaultExecuteRoute(args: {
  createdSwap: unknown;
  plan: unknown;
  preimage: string;
  signer: LocalEvmSigner;
  recipient: string;
}): Promise<{ claimTransactionId: string }> {
  const { executeRoute } = (await import("boltz-swaps/routeExecute")) as unknown as {
    executeRoute: (a: { createdSwap: unknown; plan: unknown; preimage: string; signer: unknown; recipient: string }) => Promise<{ claimTransactionId: string }>;
  };
  return executeRoute({ ...args, signer: args.signer.walletClient });
}

async function defaultIsKnownTokenAddress(variant: string, address: string): Promise<boolean> {
  const { isKnownTokenAddress } = (await import("boltz-swaps/evm")) as unknown as {
    isKnownTokenAddress: (v: string, a: string) => boolean;
  };
  return isKnownTokenAddress(variant, address);
}
