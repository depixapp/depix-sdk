// Swap-scoped keypair + reverse-swap secret generation (spec §5.3). These keys
// are NOT the wallet seed — a refund key authorizes only refunding a specific
// submarine lockup; a claim key + preimage authorize only claiming a specific
// reverse lockup into the wallet. secp256k1 from @noble/curves + WebCrypto RNG
// (frontend parity: boltzSecp.utils.randomSecretKey / getPublicKey compressed).

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";

export interface Keypair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  privHex: string;
  pubHex: string;
}

/** A fresh compressed-pubkey secp256k1 keypair for a swap's refund/claim leaf. */
export function randomKeypair(): Keypair {
  const privateKey = secp256k1.utils.randomSecretKey();
  const publicKey = secp256k1.getPublicKey(privateKey, true); // compressed (33 bytes)
  return { privateKey, publicKey, privHex: hex.encode(privateKey), pubHex: hex.encode(publicKey) };
}

/** Reverse-swap secrets: our own preimage, its SHA256 hash, and a claim keypair. */
export function deriveReverseSecrets(): {
  preimage: Uint8Array;
  preimageHash: Uint8Array;
  claimKeys: { privateKey: Uint8Array; publicKey: Uint8Array };
} {
  const preimage = new Uint8Array(32);
  globalThis.crypto.getRandomValues(preimage);
  const preimageHash = sha256(preimage);
  const kp = randomKeypair();
  return { preimage, preimageHash, claimKeys: { privateKey: kp.privateKey, publicKey: kp.publicKey } };
}
