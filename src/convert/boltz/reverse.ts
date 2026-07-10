// Reverse swap engine — RECEIVE over Lightning into the non-custodial L-BTC
// wallet (spec §5.3; port of depix-frontend/wallet/boltz/reverse.js).
//
// Flow (Boltz reverse swap, BTC/Lightning -> L-BTC):
//   1. The client generates a preimage + claim keypair and asks Boltz to create
//      a reverse swap. Boltz returns a BOLT11 invoice for the SENDER to pay.
//   2. The user shares that invoice. When it is paid, Boltz locks L-BTC on-chain
//      to a Taproot address only the client can sweep (it knows the preimage).
//   3. The client builds a claim tx spending Boltz's lockup to its own L-BTC
//      receive address, cooperatively co-signs via MuSig2, and broadcasts. Funds
//      land directly in the wallet — Boltz never holds the user's key.
//
// A RECEIVE is an INFLOW, so it does NOT pass the guardrail (§4.3) — funds come
// IN. The claim is signed with a SWAP-SCOPED claim key (not the wallet seed).
//
// The crypto (confidential claim + MuSig2) is delegated to the audited
// boltz-swaps primitives; this module orchestrates create -> watch -> claim ->
// broadcast and computes the network fee. Unit tests inject the crypto/subscribe
// deps and assert the ordering (no claim before the lockup is seen) + the invoice
// hash binding.

import { hex } from "@scure/base";
import { ConversionError } from "../../errors.js";
import { ensureBoltzConfig } from "./client.js";
import { ensureBoltzUtxoSecp } from "./secp.js";
import { decodeInvoicePaymentHash } from "./lightning.js";

export const REVERSE_PHASE = Object.freeze({
  CREATING: "creating",
  AWAITING_PAYMENT: "awaiting_payment",
  LOCKED: "locked",
  CLAIMING: "claiming",
  COMPLETED: "completed",
  FAILED: "failed"
} as const);
export type ReversePhase = (typeof REVERSE_PHASE)[keyof typeof REVERSE_PHASE];

// Raw Boltz reverse-swap statuses -> coarse internal buckets.
const REVERSE_STATUS: Readonly<Record<string, ReverseBucket>> = Object.freeze({
  "swap.created": "pending",
  "minerfee.paid": "pending",
  "transaction.mempool": "locked",
  "transaction.confirmed": "locked",
  "invoice.settled": "settled",
  "transaction.claimed": "settled",
  "invoice.expired": "failed",
  "swap.expired": "failed",
  "transaction.failed": "failed",
  "transaction.refunded": "failed",
  "transaction.lockupFailed": "failed"
});
export type ReverseBucket = "pending" | "locked" | "settled" | "failed";

export function mapReverseStatus(raw: unknown): ReverseBucket | null {
  return typeof raw === "string" ? (REVERSE_STATUS[raw] ?? null) : null;
}

const LBTC = "L-BTC";
const NETWORK = "mainnet";
const WITNESS_VBYTES = 20;
const LIQUID_MIN_FEE_RATE = 0.1;
const FALLBACK_FEE_RATE = 0.11;

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

/** Resolve the BTC->L-BTC reverse pair hash + invoice amount limits (sats) + fees. */
export async function getReverseLimits(): Promise<{
  hash: string;
  min: number | null;
  max: number | null;
  fees: unknown;
}> {
  await ensureBoltzConfig();
  const { getPairs } = (await import("boltz-swaps/client")) as unknown as {
    getPairs: () => Promise<{ reverse?: { BTC?: { "L-BTC"?: ReversePairInfo } } }>;
  };
  const pairs = await getPairs();
  const pair = pairs?.reverse?.BTC?.["L-BTC"];
  if (!pair?.hash) throw new ConversionError("SWAP_VALIDATION_FAILED", "Boltz has no BTC->L-BTC reverse pair");
  return {
    hash: pair.hash,
    min: typeof pair.limits?.minimal === "number" ? pair.limits.minimal : null,
    max: typeof pair.limits?.maximal === "number" ? pair.limits.maximal : null,
    fees: pair.fees ?? null
  };
}

interface ReversePairInfo {
  hash?: string;
  limits?: { minimal?: number; maximal?: number };
  fees?: { percentage?: number; minerFees?: { claim?: number; lockup?: number } };
}

/** Estimate what the user actually receives for a given invoice amount (sats). Pure. */
export function estimateReverseReceive(
  amountSats: number,
  fees: { percentage?: number; minerFees?: { claim?: number; lockup?: number } } | null | undefined
): { receiveSats: number; serviceFeeSats: number; minerFeesSats: number; percent: number } {
  const amount = Number.isFinite(amountSats) ? Math.max(0, Math.floor(amountSats)) : 0;
  const percent = typeof fees?.percentage === "number" ? fees.percentage : 0;
  const lockup = Number(fees?.minerFees?.lockup) || 0;
  const claim = Number(fees?.minerFees?.claim) || 0;
  const serviceFeeSats = Math.ceil((percent / 100) * amount);
  const minerFeesSats = lockup + claim;
  return { receiveSats: amount - serviceFeeSats - minerFeesSats, serviceFeeSats, minerFeesSats, percent };
}

export interface ReverseSwapRecord {
  swapId: string;
  invoice: string;
  lockupAddress: string;
  onchainAmount: number;
  swapTree: unknown;
  refundPublicKey: string;
  blindingKey?: string;
  timeoutBlockHeight: number;
  claimAddress: string;
  preimageHex: string;
  claimPublicKeyHex: string;
  /** Authorizes claiming THIS swap's L-BTC into the wallet — NOT the wallet seed. */
  claimPrivateKeyHex: string;
  claimTxId?: string | null;
}

interface ClaimKeys {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/**
 * Build the L-BTC claim tx that sweeps Boltz's reverse-swap lockup to the wallet,
 * returning broadcastable hex. Tries the COOPERATIVE key-path claim first (cheap,
 * MuSig2-cosigned with Boltz); on failure falls back to the trustless
 * UNCOOPERATIVE script-path claim — the wallet can build it entirely on its own,
 * so funds are claimable even with Boltz fully offline (mirrors Boltz's own
 * claimReverseSwap cooperative → catch → uncooperative).
 */
export async function buildReverseClaimTx(args: {
  swap: ReverseSwapRecord;
  lockupTxHex: string;
  claimKeys: ClaimKeys;
  preimage: Uint8Array;
  claimAddress: string;
}): Promise<string> {
  const { swap, lockupTxHex, claimKeys, preimage, claimAddress } = args;
  await ensureBoltzConfig();
  await ensureBoltzUtxoSecp();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const utxo = (await import("boltz-swaps/utxo")) as any;
  const boltzCore = (await import("boltz-core")) as any;
  const client = (await import("boltz-swaps/client")) as any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const net = utxo.getNetwork(LBTC, NETWORK);
  const boltzPub = hex.decode(swap.refundPublicKey);
  const tree = boltzCore.SwapTreeSerializer.deserializeSwapTree(swap.swapTree);
  const keyAgg = utxo.createMusig(claimKeys, boltzPub);
  const tweaked = utxo.tweakMusig(LBTC, keyAgg, tree.tree);

  const lockupTx = utxo.getTransaction(LBTC).fromHex(lockupTxHex);
  const swapOutput = utxo.detectSwap(tweaked.aggPubkey, lockupTx);
  if (swapOutput === undefined) {
    throw new ConversionError("SWAP_VALIDATION_FAILED", "reverse claim: could not find the swap output in the lockup tx");
  }

  const blindingPrivateKey = swap.blindingKey ? Buffer.from(swap.blindingKey, "hex") : undefined;
  const decoded = utxo.decodeAddress(LBTC, claimAddress, NETWORK);
  const construct = utxo.getConstructClaimTransaction(LBTC);

  // Verify Boltz locked AT LEAST what it promised BEFORE building any claim: a
  // short lockup would otherwise be claimed in full from the payer's side while
  // shorting the receiver.
  const inputSum = await utxo.getOutputAmount(LBTC, {
    ...swapOutput,
    cooperative: true,
    swapTree: tree,
    privateKey: claimKeys.privateKey,
    type: boltzCore.OutputType.Taproot,
    transactionId: utxo.txToId(lockupTx),
    blindingPrivateKey,
    internalKey: keyAgg.aggPubkey,
    preimage
  });
  const promisedSats = Number(swap.onchainAmount);
  if (Number.isFinite(promisedSats) && promisedSats > 0 && inputSum < promisedSats) {
    throw new ConversionError(
      "SWAP_VALIDATION_FAILED",
      `reverse claim: lockup pays ${inputSum} sats, less than the promised ${promisedSats}`
    );
  }

  const feeRate = Math.max(await resolveFeeRate(), LIQUID_MIN_FEE_RATE);

  const buildClaim = (
    cooperative: boolean
  ): { details: unknown[]; fee: number; claimTx: unknown } => {
    const details = [
      {
        ...swapOutput,
        cooperative,
        swapTree: tree,
        privateKey: claimKeys.privateKey,
        type: boltzCore.OutputType.Taproot,
        transactionId: utxo.txToId(lockupTx),
        blindingPrivateKey,
        internalKey: keyAgg.aggPubkey,
        preimage
      }
    ];
    const skeleton = construct(details, decoded.script, 1, true, net, decoded.blindingKey);
    const vbytes =
      typeof skeleton.virtualSize === "function" ? skeleton.virtualSize() : Math.ceil(skeleton.weight() / 4);
    const fee = Math.max(1, Math.ceil((vbytes + WITNESS_VBYTES) * feeRate));
    if (fee >= inputSum) {
      throw new ConversionError("SWAP_VALIDATION_FAILED", "reverse claim: network fee exceeds the locked amount");
    }
    return { details, fee, claimTx: construct(details, decoded.script, fee, true, net, decoded.blindingKey) };
  };

  // 1. Cooperative key-path claim.
  try {
    const { details, claimTx } = buildClaim(true);
    const sigHash = utxo.hashForWitnessV1(LBTC, net, details, claimTx, 0);
    const withNonce = tweaked.message(sigHash).generateNonce();
    const boltzSig = await client.getPartialReverseClaimSignature(
      swap.swapId,
      preimage,
      withNonce.publicNonce,
      utxo.txToHex(claimTx),
      0
    );
    const aggNonces = withNonce.aggregateNonces([[boltzPub, boltzSig.pubNonce]]);
    const session = aggNonces.initializeSession();
    const withTheirs = session.addPartial(boltzPub, boltzSig.signature);
    const signed = withTheirs.signPartial();
    utxo.setCooperativeWitness(claimTx, 0, signed.aggregatePartials());
    return utxo.txToHex(claimTx);
  } catch (coopErr) {
    // 2. Boltz unreachable / refused → trustless script-path claim. The fee guard
    //    (inputSum) is the only thing that can still throw; surface the
    //    cooperative error for diagnostics.
    try {
      const { claimTx } = buildClaim(false);
      return utxo.txToHex(claimTx);
    } catch (uncoopErr) {
      (uncoopErr as { cause?: unknown }).cause = coopErr;
      throw uncoopErr;
    }
  }
}

export interface ReverseDeps {
  deriveSecrets: () => Promise<{ preimage: Uint8Array; preimageHash: Uint8Array; claimKeys: ClaimKeys }>;
  getClaimAddress: () => Promise<string>;
  subscribe: (swapId: string, onRaw: (raw: string) => void) => () => void;
  /** Persist the record. Awaited for the initial write (durability §5.3). */
  persist?: (record: ReverseSwapRecord) => void | Promise<void>;
  onPhase?: (phase: ReversePhase, ctx?: Record<string, unknown>) => void;
  onInvoice?: (invoice: string, record: ReverseSwapRecord) => void;
  /** Override the claim builder (tests). */
  claim?: (args: {
    swap: ReverseSwapRecord;
    lockupTxHex: string;
    claimKeys: ClaimKeys;
    preimage: Uint8Array;
    claimAddress: string;
  }) => Promise<string>;
  /** Override the L-BTC broadcast (tests). */
  broadcast?: (asset: string, txHex: string) => Promise<{ id?: string } | null>;
  /** Override the lockup-tx fetch (tests). */
  getLockupTx?: (swapId: string) => Promise<{ hex?: string } | null>;
  /** Override the Boltz reverse-swap create (tests). */
  createReverseSwap?: (
    from: string,
    to: string,
    amountSats: number,
    preimageHashHex: string,
    pairHash: string,
    claimPublicKeyHex: string,
    claimAddress: string
  ) => Promise<CreatedReverseSwap>;
}

interface CreatedReverseSwap {
  id: string;
  invoice: string;
  lockupAddress: string;
  onchainAmount: number;
  swapTree: unknown;
  refundPublicKey: string;
  blindingKey?: string;
  timeoutBlockHeight: number;
}

export interface ReverseOutcome {
  swapId: string;
  phase: ReversePhase;
  record: ReverseSwapRecord;
  reason?: string;
}

/**
 * Create a Boltz reverse swap and drive it to completion: surface the invoice,
 * watch for the lockup, then claim + broadcast into the wallet.
 */
export async function receiveViaLightning(
  params: { amountSats: number; pairHash: string },
  deps: ReverseDeps
): Promise<ReverseOutcome> {
  const d = { onPhase: () => {}, onInvoice: () => {}, persist: () => {}, ...deps };
  if (typeof d.deriveSecrets !== "function" || typeof d.getClaimAddress !== "function" || typeof d.subscribe !== "function") {
    throw new TypeError("receiveViaLightning requires deriveSecrets, getClaimAddress and subscribe deps");
  }
  if (!Number.isInteger(params?.amountSats) || params.amountSats <= 0) {
    throw new TypeError("receiveViaLightning requires a positive integer amountSats");
  }

  await ensureBoltzConfig();
  d.onPhase(REVERSE_PHASE.CREATING);

  const { preimage, preimageHash, claimKeys } = await d.deriveSecrets();
  const claimAddress = await d.getClaimAddress();

  const createReverseSwap =
    d.createReverseSwap ??
    (async (...a: Parameters<NonNullable<ReverseDeps["createReverseSwap"]>>) => {
      const { createReverseSwap: real } = (await import("boltz-swaps/client")) as unknown as {
        createReverseSwap: NonNullable<ReverseDeps["createReverseSwap"]>;
      };
      return real(...a);
    });
  const created = await createReverseSwap(
    "BTC",
    "L-BTC",
    params.amountSats,
    hex.encode(preimageHash),
    params.pairHash,
    hex.encode(claimKeys.publicKey),
    claimAddress
  );
  if (!created?.id || !created?.invoice || !created?.lockupAddress) {
    throw new ConversionError("SWAP_VALIDATION_FAILED", "Boltz createReverseSwap returned an incomplete response");
  }
  // Verify the invoice Boltz returned pays against OUR preimage hash BEFORE it is
  // shown to a payer. A substituted invoice would settle the payer's payment with
  // a preimage Boltz controls, while our claim never unlocks. Fail closed on an
  // undecodable invoice.
  const invoiceHash = decodeInvoicePaymentHash(created.invoice);
  if (!invoiceHash || invoiceHash !== hex.encode(preimageHash)) {
    throw new ConversionError(
      "INVOICE_HASH_MISMATCH",
      "Boltz returned an invoice whose payment hash does not match our preimage"
    );
  }

  const record: ReverseSwapRecord = {
    swapId: created.id,
    invoice: created.invoice,
    lockupAddress: created.lockupAddress,
    onchainAmount: created.onchainAmount,
    swapTree: created.swapTree,
    refundPublicKey: created.refundPublicKey,
    blindingKey: created.blindingKey,
    timeoutBlockHeight: created.timeoutBlockHeight,
    claimAddress,
    preimageHex: hex.encode(preimage),
    claimPublicKeyHex: hex.encode(claimKeys.publicKey),
    claimPrivateKeyHex: hex.encode(claimKeys.privateKey)
  };
  // Awaited: the claim key must be durable BEFORE the invoice is surfaced — a
  // crash after the payer pays but before this persists would strand the lockup.
  await d.persist(record);
  d.onInvoice(created.invoice, record);
  d.onPhase(REVERSE_PHASE.AWAITING_PAYMENT, { swapId: created.id, invoice: created.invoice });

  return watchReverseSwap({ swapId: created.id, record, claimKeys, preimage, claimAddress }, d);
}

/** Resume watching + claiming a reverse swap created in a previous session. */
export async function resumeReverseSwap(record: ReverseSwapRecord, deps: ReverseDeps): Promise<ReverseOutcome> {
  const d = { onPhase: () => {}, onInvoice: () => {}, persist: () => {}, ...deps };
  if (typeof d.subscribe !== "function") {
    throw new TypeError("resumeReverseSwap requires a subscribe dep");
  }
  if (!record?.swapId || !record?.claimPrivateKeyHex || !record?.claimPublicKeyHex || !record?.preimageHex) {
    throw new TypeError("resumeReverseSwap: record is missing claim material");
  }
  await ensureBoltzConfig();
  const claimKeys: ClaimKeys = {
    privateKey: hex.decode(record.claimPrivateKeyHex),
    publicKey: hex.decode(record.claimPublicKeyHex)
  };
  const preimage = hex.decode(record.preimageHex);
  if (record.invoice) d.onInvoice(record.invoice, record);
  d.onPhase(REVERSE_PHASE.AWAITING_PAYMENT, { swapId: record.swapId, invoice: record.invoice });
  return watchReverseSwap(
    { swapId: record.swapId, record, claimKeys, preimage, claimAddress: record.claimAddress },
    d
  );
}

// Subscribe to a reverse swap's status; when Boltz locks the L-BTC, build +
// broadcast the claim into the wallet; resolve on settle/fail.
function watchReverseSwap(
  args: {
    swapId: string;
    record: ReverseSwapRecord;
    claimKeys: ClaimKeys;
    preimage: Uint8Array;
    claimAddress: string;
  },
  d: Required<Pick<ReverseDeps, "onPhase" | "onInvoice" | "persist">> & ReverseDeps
): Promise<ReverseOutcome> {
  const { swapId, record, claimKeys, preimage, claimAddress } = args;
  return new Promise<ReverseOutcome>((resolve, reject) => {
    let settled = false;
    let claiming = false;
    let unsubscribe: () => void = () => {};
    const finish = (phase: ReversePhase, extra?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      try {
        unsubscribe();
      } catch {
        // noop
      }
      d.onPhase(phase, { swapId, ...extra });
      resolve({ swapId, phase, record, ...extra });
    };

    const doClaim = async (): Promise<void> => {
      if (claiming || settled) return;
      claiming = true;
      try {
        d.onPhase(REVERSE_PHASE.CLAIMING, { swapId });
        const getLockupTx =
          d.getLockupTx ??
          (async (id: string) => {
            const { getReverseTransaction } = (await import("boltz-swaps/client")) as unknown as {
              getReverseTransaction: (id: string) => Promise<{ hex?: string } | null>;
            };
            return getReverseTransaction(id);
          });
        const lockup = await getLockupTx(swapId);
        const lockupTxHex = lockup?.hex;
        if (!lockupTxHex) throw new ConversionError("SWAP_VALIDATION_FAILED", "reverse claim: lockup transaction unavailable");
        const claimFn = d.claim ?? buildReverseClaimTx;
        const claimTxHex = await claimFn({ swap: record, lockupTxHex, claimKeys, preimage, claimAddress });
        const broadcast =
          d.broadcast ??
          (async (asset: string, txHex: string) => {
            const { broadcastApiTransaction } = (await import("boltz-swaps/client")) as unknown as {
              broadcastApiTransaction: (a: string, h: string) => Promise<{ id?: string }>;
            };
            return broadcastApiTransaction(asset, txHex);
          });
        const res = await broadcast("L-BTC", claimTxHex);
        record.claimTxId = res?.id ?? null;
        d.persist(record);
      } catch (e) {
        claiming = false;
        // Tear down the socket before rejecting so a transient claim error does
        // not leak a zombie socket that keeps firing doClaim on every status.
        settled = true;
        try {
          unsubscribe();
        } catch {
          // noop
        }
        reject(e);
      }
    };

    const onUpdate = (raw: string): void => {
      const bucket = mapReverseStatus(raw);
      if (bucket === null) return;
      if (bucket === "locked") void doClaim();
      else if (bucket === "settled") finish(REVERSE_PHASE.COMPLETED);
      else if (bucket === "failed") finish(REVERSE_PHASE.FAILED, { reason: raw });
    };

    try {
      unsubscribe = d.subscribe(swapId, (raw) => {
        try {
          onUpdate(raw);
        } catch (e) {
          reject(e);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}
