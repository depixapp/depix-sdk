// Boltz L-BTC lockup refund engine (spec §5.3; port of
// depix-frontend/wallet/boltz/refund.js). Recovers the user's L-BTC lockup when
// a submarine swap can't complete — always L-BTC back to the wallet.
//
// Two modes, tried in order (runRefund):
//   - COOPERATIVE (nLockTime=0): a Taproot key-path spend co-signed via MuSig2
//     with Boltz — fast, low fee, broadcastable now. Needs Boltz online.
//   - UNCOOPERATIVE / TIMEOUT (nLockTime=timeoutBlockHeight): the trustless
//     script-path spend via the refund leaf, signed locally. No Boltz needed,
//     but only mineable AFTER the lock expires — before that, RefundPendingError
//     so the caller retries later (resume, §5.3).
//
// The crypto is delegated to the audited boltz-swaps/utxo + boltz-core/liquid
// primitives; the unit tests inject deps.refund/broadcast/getBlockHeight and
// assert the cooperative→timeout orchestration without touching real crypto.

import { hex } from "@scure/base";
import { ConversionError } from "../../errors.js";
import { ensureBoltzConfig } from "./client.js";
import { ensureBoltzUtxoSecp } from "./secp.js";

const LBTC = "L-BTC";
const NETWORK = "mainnet";
const WITNESS_VBYTES = 20;
const LIQUID_MIN_FEE_RATE = 0.1;
const FALLBACK_FEE_RATE = 0.11;

/**
 * nLockTime for a refund tx. The trustless (script-path) refund spends the CLTV
 * refund leaf, so it MUST equal the timeout. The cooperative (MuSig2 key-path)
 * refund does NOT touch the timeout leaf, so it must be FINAL (0) — a future
 * locktime makes the tx non-final and the node rejects it as "non-final" until
 * the timeout passes, breaking the fast cooperative refund.
 */
export function refundLockTime(cooperative: boolean, timeout: number): number {
  return cooperative ? 0 : Number(timeout) || 0;
}

/** Thrown when the cooperative refund failed AND the timeout hasn't been reached
 *  yet — the trustless fallback can't broadcast. Keep the record and retry later. */
export class RefundPendingError extends ConversionError {
  readonly refundPending = true;
  constructor(message: string, cause?: unknown) {
    super("SWAP_VALIDATION_FAILED", message, cause !== undefined ? { cause } : undefined);
    this.name = "RefundPendingError";
  }
}

/** Persisted submarine-swap refund material (a subset of the boltz-swaps record). */
export interface SubmarineRefundRecord {
  swapId: string;
  claimPublicKey: string;
  swapTree: unknown;
  blindingKey?: string;
  timeoutBlockHeight: number;
  refundPrivateKeyHex: string;
  refundPublicKeyHex: string;
}

export interface RefundResult {
  refundTxId: string | null;
  cooperative: boolean;
}

interface RefundKeys {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface BuildRefundTxParams {
  swapId: string;
  /** Boltz's key in the lockup (hex) — claimPublicKey (submarine). Aggregated FIRST. */
  boltzPublicKey: string;
  swapTree: unknown;
  blindingKey?: string;
  timeoutBlockHeight: number;
  swapType: "submarine" | "chain";
  lockupTxHex: string;
  refundKeys: RefundKeys;
  refundAddress: string;
  cooperative?: boolean;
}

async function resolveFeeRate(): Promise<number> {
  try {
    const { getFeeEstimations } = (await import("boltz-swaps/client")) as unknown as {
      getFeeEstimations: () => Promise<Record<string, number>>;
    };
    const fees = await getFeeEstimations();
    const rate = fees?.[LBTC] ?? fees?.["L-BTC"];
    if (typeof rate === "number" && rate > 0) return rate;
  } catch {
    // fall through
  }
  return FALLBACK_FEE_RATE;
}

/**
 * Build a refund tx that sweeps a Boltz L-BTC lockup back to the wallet, returning
 * the broadcastable hex. Generic over swap type (submarine differs only in
 * `boltzPublicKey`/`swapType`).
 */
export async function buildRefundTx(params: BuildRefundTxParams): Promise<string> {
  const {
    swapId,
    boltzPublicKey,
    swapTree,
    blindingKey,
    timeoutBlockHeight,
    swapType,
    lockupTxHex,
    refundKeys,
    refundAddress,
    cooperative = true
  } = params;

  await ensureBoltzConfig();
  await ensureBoltzUtxoSecp();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const utxo = (await import("boltz-swaps/utxo")) as any;
  const boltzCore = (await import("boltz-core")) as any;
  const liquid = (await import("boltz-core/liquid")) as any;
  const client = (await import("boltz-swaps/client")) as any;
  const { SwapType } = (await import("boltz-swaps/types")) as any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const net = utxo.getNetwork(LBTC, NETWORK);
  // Boltz is the CLAIMER on the lockup; the user refunds. The key aggregation
  // always lists Boltz's key first (matches the swap address).
  const boltzPub = hex.decode(boltzPublicKey);
  const tree = boltzCore.SwapTreeSerializer.deserializeSwapTree(swapTree);
  const keyAgg = utxo.createMusig(refundKeys, boltzPub);
  const tweaked = utxo.tweakMusig(LBTC, keyAgg, tree.tree);

  const lockupTx = utxo.getTransaction(LBTC).fromHex(lockupTxHex);
  const swapOutput = utxo.detectSwap(tweaked.aggPubkey, lockupTx);
  if (swapOutput === undefined) {
    throw new ConversionError(
      "SWAP_VALIDATION_FAILED",
      "refund: could not find the swap output in the lockup tx"
    );
  }

  const blindingPrivateKey = blindingKey ? Buffer.from(blindingKey, "hex") : undefined;
  const details = [
    {
      ...swapOutput,
      cooperative,
      swapTree: tree,
      privateKey: refundKeys.privateKey,
      type: boltzCore.OutputType.Taproot,
      transactionId: utxo.txToId(lockupTx),
      blindingPrivateKey,
      internalKey: keyAgg.aggPubkey
      // no preimage — this is a refund, not a claim
    }
  ];

  const inputSum = await utxo.getOutputAmount(LBTC, details[0]);
  const decoded = utxo.decodeAddress(LBTC, refundAddress, NETWORK);
  const timeout = Number(timeoutBlockHeight) || 0;
  const lockTime = refundLockTime(cooperative, timeout);

  const feeRate = Math.max(await resolveFeeRate(), LIQUID_MIN_FEE_RATE);
  const skeleton = liquid.constructRefundTransaction(
    details,
    decoded.script,
    lockTime,
    1n,
    true,
    net,
    decoded.blindingKey
  );
  const vbytes =
    typeof skeleton.virtualSize === "function"
      ? skeleton.virtualSize()
      : Math.ceil(skeleton.weight() / 4);
  const fee = Math.max(1, Math.ceil((vbytes + WITNESS_VBYTES) * feeRate));
  if (fee >= inputSum) {
    throw new ConversionError("SWAP_VALIDATION_FAILED", "refund: network fee exceeds the locked amount");
  }
  const refundTx = liquid.constructRefundTransaction(
    details,
    decoded.script,
    lockTime,
    BigInt(fee),
    true,
    net,
    decoded.blindingKey
  );

  if (cooperative) {
    const sigHash = utxo.hashForWitnessV1(LBTC, net, details, refundTx, 0);
    const withNonce = tweaked.message(sigHash).generateNonce();
    const type = swapType === "chain" ? SwapType.Chain : SwapType.Submarine;
    const boltzSig = await client.getPartialRefundSignature(
      swapId,
      type,
      withNonce.publicNonce,
      utxo.txToHex(refundTx),
      0
    );
    const aggNonces = withNonce.aggregateNonces([[boltzPub, boltzSig.pubNonce]]);
    const session = aggNonces.initializeSession();
    const withTheirs = session.addPartial(boltzPub, boltzSig.signature);
    const signed = withTheirs.signPartial();
    utxo.setCooperativeWitness(refundTx, 0, signed.aggregatePartials());
  }
  // Non-cooperative path: constructRefundTransaction already signed the
  // script-path spend via the refund leaf — nothing more to do.

  return utxo.txToHex(refundTx);
}

/** SUBMARINE lockup refund builder — Boltz's key is claimPublicKey. */
export function buildSubmarineRefundTx(args: {
  swap: SubmarineRefundRecord;
  lockupTxHex: string;
  refundKeys: RefundKeys;
  refundAddress: string;
  cooperative?: boolean;
}): Promise<string> {
  return buildRefundTx({
    swapId: args.swap.swapId,
    boltzPublicKey: args.swap.claimPublicKey,
    swapTree: args.swap.swapTree,
    blindingKey: args.swap.blindingKey,
    timeoutBlockHeight: args.swap.timeoutBlockHeight,
    swapType: "submarine",
    lockupTxHex: args.lockupTxHex,
    refundKeys: args.refundKeys,
    refundAddress: args.refundAddress,
    cooperative: args.cooperative ?? true
  });
}

export interface RefundDeps {
  /** Required — the wallet L-BTC receive address the lockup is refunded to. */
  getRefundAddress: () => Promise<string>;
  /** Override the lockup-hex fetch (default: boltz-swaps/client getLockupTransaction). */
  getLockupHex?: () => Promise<string | null | undefined>;
  /** Override the L-BTC broadcast (default: boltz-swaps/client broadcastApiTransaction). */
  broadcast?: (asset: string, txHex: string) => Promise<{ id?: string } | null>;
  /** Override the chain-height read for the timeout gate. */
  getBlockHeight?: () => Promise<number | null>;
  /** Override the tx builder (tests). */
  refund?: (args: {
    swap: SubmarineRefundRecord;
    lockupTxHex: string;
    refundKeys: RefundKeys;
    refundAddress: string;
    cooperative?: boolean;
  }) => Promise<string>;
}

/**
 * Shared cooperative→timeout orchestration. Tries the cooperative refund (Boltz
 * co-signs — broadcastable now). On failure, falls back to the trustless TIMEOUT
 * refund — but only once the lock has expired; otherwise RefundPendingError.
 */
async function runRefund(args: {
  record: SubmarineRefundRecord;
  refundKeys: RefundKeys;
  refundFn: (a: {
    swap: SubmarineRefundRecord;
    lockupTxHex: string;
    refundKeys: RefundKeys;
    refundAddress: string;
    cooperative?: boolean;
  }) => Promise<string>;
  getLockupHex: () => Promise<string | null | undefined>;
  timeoutBlockHeight: number;
  deps: RefundDeps;
}): Promise<RefundResult> {
  const { record, refundKeys, refundFn, getLockupHex, timeoutBlockHeight, deps } = args;
  const refundAddress = await deps.getRefundAddress();
  const lockupTxHex = await getLockupHex();
  if (!lockupTxHex) {
    throw new ConversionError("SWAP_VALIDATION_FAILED", "refund: lockup transaction unavailable");
  }

  const broadcast =
    deps.broadcast ??
    (async (asset: string, txHex: string) => {
      const { broadcastApiTransaction } = (await import("boltz-swaps/client")) as unknown as {
        broadcastApiTransaction: (a: string, h: string) => Promise<{ id?: string }>;
      };
      return broadcastApiTransaction(asset, txHex);
    });

  // 1. Cooperative refund — fast, broadcastable now.
  try {
    const txHex = await refundFn({ swap: record, lockupTxHex, refundKeys, refundAddress, cooperative: true });
    const res = await broadcast("L-BTC", txHex);
    return { refundTxId: res?.id ?? null, cooperative: true };
  } catch (coopErr) {
    // 2. Cooperative failed → trustless TIMEOUT refund. Only valid once the lock
    //    has expired (the tx's nLockTime is non-final before then).
    let height: number | null = null;
    try {
      height = deps.getBlockHeight
        ? await deps.getBlockHeight()
        : await defaultChainHeight();
    } catch {
      // height unknown
    }
    if (height == null || !Number.isFinite(height) || height < timeoutBlockHeight) {
      throw new RefundPendingError(
        "refund: cooperative failed and the timeout has not been reached yet",
        coopErr
      );
    }
    const txHex = await refundFn({ swap: record, lockupTxHex, refundKeys, refundAddress, cooperative: false });
    const res = await broadcast("L-BTC", txHex);
    return { refundTxId: res?.id ?? null, cooperative: false };
  }
}

async function defaultChainHeight(): Promise<number | null> {
  const { getChainHeight } = (await import("boltz-swaps/client")) as unknown as {
    getChainHeight?: (a: string) => Promise<number | null>;
  };
  if (typeof getChainHeight === "function") return getChainHeight("L-BTC");
  return null;
}

/** Refund a failed SUBMARINE swap from its persisted boltz-swaps record. */
export async function refundSubmarineSwap(
  record: SubmarineRefundRecord,
  deps: RefundDeps
): Promise<RefundResult> {
  if (typeof deps?.getRefundAddress !== "function") {
    throw new TypeError("refundSubmarineSwap requires a getRefundAddress dep");
  }
  if (
    !record?.swapId ||
    !record?.claimPublicKey ||
    !record?.refundPrivateKeyHex ||
    !record?.refundPublicKeyHex
  ) {
    throw new TypeError("refundSubmarineSwap: record is missing refund material");
  }
  await ensureBoltzConfig();
  const refundKeys: RefundKeys = {
    privateKey: hex.decode(record.refundPrivateKeyHex),
    publicKey: hex.decode(record.refundPublicKeyHex)
  };
  const getLockupHex =
    deps.getLockupHex ??
    (async () => {
      const [{ getLockupTransaction }, { SwapType }] = (await Promise.all([
        import("boltz-swaps/client"),
        import("boltz-swaps/types")
      ])) as unknown as [
        { getLockupTransaction: (id: string, t: unknown) => Promise<{ hex?: string }> },
        { SwapType: { Submarine: unknown } }
      ];
      return (await getLockupTransaction(record.swapId, SwapType.Submarine))?.hex;
    });
  return runRefund({
    record,
    refundKeys,
    refundFn: deps.refund ?? buildSubmarineRefundTx,
    getLockupHex,
    timeoutBlockHeight: Number(record.timeoutBlockHeight) || 0,
    deps
  });
}
