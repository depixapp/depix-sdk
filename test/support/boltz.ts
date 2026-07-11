// Shared Boltz test fixtures (not a *.test.ts — not collected).
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { ensureBoltzConfig } from "../../src/convert/boltz/client.js";
import { ensureBoltzUtxoSecp } from "../../src/convert/boltz/secp.js";

// BOLT11 example invoice (BOLT #11 spec): amount 2500u = 250_000 sats,
// payment_hash = 0001020304050607080900010203040506070809000102030405060708090102.
export const TEST_INVOICE =
  "lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxa" +
  "tsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77" +
  "w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp";
export const TEST_INVOICE_SATS = 250_000;
export const TEST_PAYMENT_HASH =
  "0001020304050607080900010203040506070809000102030405060708090102";

export interface HonestSubmarineLockup {
  lockupAddress: string;
  swapTree: unknown;
  claimPublicKey: string;
  refundPublicKey: string;
  refundPrivateKey: string;
  paymentHash: string;
  timeoutBlockHeight: number;
  /**
   * A minimal, parseable Liquid tx with one explicit L-BTC output paying the
   * lockup script — enough to drive buildReverseClaimTx/buildRefundTx through
   * the real boltz-core detectSwap (the `utxo.detectSwap` port bug was invisible
   * to every test because none supplied a lockup tx to parse).
   */
  lockupTxHex: string;
}

/** Explicit (unblinded) Liquid confidential-value buffer: 0x01 + 8-byte BE amount. */
function explicitValue(sats: number): Buffer {
  const b = Buffer.alloc(9);
  b[0] = 0x01;
  b.writeBigUInt64BE(BigInt(sats), 1);
  return b;
}

/**
 * Build an HONEST Boltz submarine lockup with the real boltz-core / boltz-swaps
 * primitives (the same ones Boltz uses server-side), so verify-lockup tests can
 * assert honest→accept and any tamper→reject — mirrors the frontend's own
 * verify-lockup unit test.
 */
export async function buildHonestSubmarineLockup(
  opts: { paymentHash?: string; timeoutBlockHeight?: number } = {}
): Promise<HonestSubmarineLockup> {
  await ensureBoltzConfig();
  await ensureBoltzUtxoSecp();
  const boltzCore = (await import("boltz-core")) as any;
  const utxo = (await import("boltz-swaps/utxo")) as any;
  const liquid = (await import("liquidjs-lib")) as any;

  const refundPriv = secp256k1.utils.randomSecretKey();
  const refundPub = secp256k1.getPublicKey(refundPriv, true);
  const claimPriv = secp256k1.utils.randomSecretKey();
  const claimPub = secp256k1.getPublicKey(claimPriv, true);
  const paymentHashHex = opts.paymentHash ?? TEST_PAYMENT_HASH;
  const paymentHash = hex.decode(paymentHashHex);
  const timeout = opts.timeoutBlockHeight ?? 900_000;

  const tree = boltzCore.swapTree(true, paymentHash, claimPub, refundPub, timeout);
  const serialized = boltzCore.SwapTreeSerializer.serializeSwapTree(tree);
  const tweaked = utxo.tweakMusig(
    "L-BTC",
    utxo.createMusig({ privateKey: refundPriv, publicKey: refundPub }, claimPub),
    tree.tree
  );
  const script = boltzCore.Scripts.p2trOutput(tweaked.aggPubkey);
  const net = liquid.networks?.liquid ?? liquid.default?.networks?.liquid;
  const addrmod = liquid.address ?? liquid.default?.address;
  const lockupAddress = addrmod.fromOutputScript(Buffer.from(script), net);

  // One explicit L-BTC output paying the lockup script — a real, parseable
  // Liquid tx so buildReverseClaimTx/buildRefundTx reach boltz-core.detectSwap.
  const Tx = liquid.Transaction ?? liquid.default?.Transaction;
  const assetExplicit = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(32, 0x11)]);
  const lockupTx = new Tx();
  lockupTx.addInput(Buffer.alloc(32), 0);
  lockupTx.addOutput(Buffer.from(script), explicitValue(100_000), assetExplicit, Buffer.from([0x00]));
  const lockupTxHex = lockupTx.toHex();

  return {
    lockupAddress,
    swapTree: serialized,
    claimPublicKey: hex.encode(claimPub),
    refundPublicKey: hex.encode(refundPub),
    refundPrivateKey: hex.encode(refundPriv),
    paymentHash: paymentHashHex,
    timeoutBlockHeight: timeout,
    lockupTxHex
  };
}

/** A second, valid, DIFFERENT honest lockup address (for the address-tamper case). */
export async function anotherLockupAddress(): Promise<string> {
  return (await buildHonestSubmarineLockup({ paymentHash: "11".repeat(32) })).lockupAddress;
}
