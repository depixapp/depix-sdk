// verify-lockup — validate a Boltz L-BTC lockup BEFORE funding it (spec §5.3,
// PR#80 hardening; port of depix-frontend/wallet/boltz/verify-lockup.js).
//
// The address Boltz returns must NOT be trusted verbatim: a malicious/compromised
// Boltz could return a (swapTree, address) whose refund leaf is not our key, or
// whose claim leaf commits to a preimage hash Boltz controls — stranding or
// stealing the locked L-BTC. So we RE-DERIVE the expected lockup from values WE
// know (our refund key + the expected hash) and assert the server's tree AND
// address match it byte-for-byte — exactly the Boltz reference clients' check.
//
// Shared by the submarine (Lightning send) and chain (L-BTC -> stablecoin) paths:
// both lock L-BTC to the same Taproot 2-of-2 with a timeout refund leaf; only the
// hash binding the claim leaf differs —
//   - submarine: the BOLT11 invoice's payment hash;
//   - chain:     the swap preimage's SHA256 hash.
//
// CRITICAL nuance (why the allowlist still gates the Lightning payee, §4.3): this
// binds the tree to the payment hash of the SUPPLIED invoice. If the invoice is
// the attacker's, the "verified" lockup faithfully pays the attacker — so
// protocol-bound verification does NOT make the flow exempt from the allowlist.

import { hex } from "@scure/base";
import { ConversionError } from "../../errors.js";
import { ensureBoltzConfig } from "./client.js";
import { ensureBoltzUtxoSecp } from "./secp.js";

const LBTC = "L-BTC";
const NETWORK = "mainnet";

/** Length-checked byte compare (public scripts — timing is not sensitive). */
function bytesEqual(a: Uint8Array | undefined | null, b: Uint8Array | undefined | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export interface VerifyLockupParams {
  /** "submarine" locks use swapTree; "chain" user-locks use reverseSwapTree. */
  swapType: "submarine" | "chain";
  /** Server address we are about to fund. */
  lockupAddress: string;
  /** Server serialized swap tree. */
  swapTree: unknown;
  /** Boltz's claim key (hex) — claimPublicKey (submarine) / serverPublicKey (chain). */
  serverPublicKey: string;
  /** Our refund pubkey (hex, 33-byte compressed). */
  refundPublicKey: string;
  /** Our refund privkey (hex). */
  refundPrivateKey: string;
  /** Hash the claim leaf must commit to (hex, 32-byte): invoice payment hash / preimage SHA256. */
  expectedHash: string;
  /** Refund leaf CLTV height. */
  timeoutBlockHeight: number;
}

/**
 * Throw (BEFORE any L-BTC is locked) unless the Boltz lockup is provably bound to
 * the user: the server's swap tree must equal the tree we reconstruct from our
 * refund key + the expected hash, AND the server's address must pay to exactly
 * that tree's Taproot output. Throws ConversionError("LOCKUP_TREE_MISMATCH") on
 * any mismatch or missing material — the caller MUST NOT lock funds.
 */
export async function assertLockupAddressBindsToUser(params: VerifyLockupParams): Promise<void> {
  const {
    swapType,
    lockupAddress,
    swapTree: serverSwapTree,
    serverPublicKey,
    refundPublicKey,
    refundPrivateKey,
    expectedHash,
    timeoutBlockHeight
  } = params;

  if (swapType !== "submarine" && swapType !== "chain") {
    throw new ConversionError(
      "LOCKUP_TREE_MISMATCH",
      `Boltz lockup verification: unknown swapType "${String(swapType)}" — cancelled before locking funds`
    );
  }
  if (
    !lockupAddress ||
    !serverSwapTree ||
    !serverPublicKey ||
    !refundPublicKey ||
    !refundPrivateKey ||
    !expectedHash
  ) {
    throw new ConversionError(
      "LOCKUP_TREE_MISMATCH",
      "Boltz lockup verification: missing material — cancelled before locking funds"
    );
  }

  const refundKeys = { privateKey: hex.decode(refundPrivateKey), publicKey: hex.decode(refundPublicKey) };
  const claimPub = hex.decode(serverPublicKey);
  const hashBytes = hex.decode(expectedHash);
  const timeout = Number(timeoutBlockHeight) || 0;

  // 1. Reconstruct the tree from OUR inputs; require the server's to equal it
  //    byte-for-byte. Boltz is the claimer on the L-BTC lockup, so the claim leaf
  //    must commit to OUR expectedHash and the refund leaf to OUR key. Pure JS
  //    (no secp WASM) — runs first and cheaply.
  const boltzCore = (await import("boltz-core")) as unknown as {
    swapTree: (...a: unknown[]) => { tree: unknown };
    reverseSwapTree: (...a: unknown[]) => { tree: unknown };
    SwapTreeSerializer: { deserializeSwapTree: (t: unknown) => unknown };
    compareTrees: (a: unknown, b: unknown) => boolean;
    Scripts: { p2trOutput: (k: unknown) => Uint8Array };
  };
  const buildTree = swapType === "chain" ? boltzCore.reverseSwapTree : boltzCore.swapTree;
  const mine = buildTree(true, hashBytes, claimPub, refundKeys.publicKey, timeout);
  const server = boltzCore.SwapTreeSerializer.deserializeSwapTree(serverSwapTree);
  if (!boltzCore.compareTrees(mine, server)) {
    throw new ConversionError(
      "LOCKUP_TREE_MISMATCH",
      "Boltz lockup swap tree does not match the locally-derived tree — cancelled before locking funds"
    );
  }

  // 2. The address must pay to exactly that tree's Taproot output. Build the
  //    expected scriptPubKey the same way detectSwap does — p2trOutput of the
  //    MuSig-aggregated, tree-tweaked key — and compare to the address's
  //    unconfidential script (so a confidential blinding key can't affect the
  //    check). Needs the secp256k1-zkp WASM for the Liquid taproot tweak.
  await ensureBoltzConfig();
  await ensureBoltzUtxoSecp();
  const { createMusig, tweakMusig, decodeAddress } = (await import("boltz-swaps/utxo")) as unknown as {
    createMusig: (keys: unknown, pub: Uint8Array) => unknown;
    tweakMusig: (asset: string, musig: unknown, tree: unknown) => { aggPubkey: unknown };
    decodeAddress: (asset: string, addr: string, net: string) => { script: Uint8Array };
  };
  const tweaked = tweakMusig(LBTC, createMusig(refundKeys, claimPub), (mine as { tree: unknown }).tree);
  const expectedScript = boltzCore.Scripts.p2trOutput(tweaked.aggPubkey);
  const { script } = decodeAddress(LBTC, lockupAddress, NETWORK);
  if (!bytesEqual(expectedScript, script)) {
    throw new ConversionError(
      "LOCKUP_TREE_MISMATCH",
      "Boltz lockup address does not match the locally-derived swap script — cancelled before locking funds"
    );
  }
}
