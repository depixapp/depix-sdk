// Passphrase → AES-256-GCM key derivation + seed encryption (spec §2.4).
//
// Near-literal port of depix-frontend/wallet/wallet-crypto.js with the PIN
// replaced by a passphrase:
//   - KDF: Argon2id via hash-wasm with the frontend's EXACT params
//     (constants.js:27-30). Bit-for-bit derivation parity is pinned by a
//     golden vector test — a hash-wasm bump that changes defaults would break
//     decryption of existing wallets.
//   - Cipher: AES-256-GCM via WebCrypto (globalThis.crypto, native in Node).
//   - Secret: passphrase, minimum 12 chars (WEAK_PASSPHRASE below that) —
//     the file can be exfiltrated, and offline brute-force of a 6-digit PIN
//     is trivial; 12+ chars with Argon2id 19 MiB gives real margin.
//   - NO auto-wipe on wrong passphrase (G8): errors are WRONG_PASSPHRASE,
//     no persisted counter. A headless loop with a bad passphrase must never
//     destroy the wallet, and an attacker with the file brute-forces offline
//     anyway.

import { argon2id } from "hash-wasm";
import { WalletError } from "../errors.js";

export const ARGON2_PARAMS = Object.freeze({
  parallelism: 1,
  iterations: 2,
  memorySize: 19456, // KiB = 19 MiB — frontend ARGON2_MEMORY_KIB
  hashLength: 32 // AES-256 key length
});

export const AES_IV_LENGTH_BYTES = 12;
export const SALT_LENGTH_BYTES = 16;
export const MIN_PASSPHRASE_LENGTH = 12;

/** Reject passphrases under 12 chars (spec §2.4 — WEAK_PASSPHRASE). */
export function assertStrongPassphrase(passphrase: string): void {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new WalletError(
      "WEAK_PASSPHRASE",
      `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters ` +
        "(set DEPIX_WALLET_PASSPHRASE or pass `passphrase`)"
    );
  }
}

export function randomBytes(length: number): Uint8Array {
  const buf = new Uint8Array(length);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

export function randomSalt(): Uint8Array {
  return randomBytes(SALT_LENGTH_BYTES);
}

export function randomIv(): Uint8Array {
  return randomBytes(AES_IV_LENGTH_BYTES);
}

/** Argon2id: passphrase + salt → raw 32-byte key material. */
export async function deriveKeyBytes(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new TypeError("passphrase must be a non-empty string");
  }
  if (salt.length < 8) {
    throw new TypeError("salt too short");
  }
  return argon2id({
    password: passphrase,
    salt,
    parallelism: ARGON2_PARAMS.parallelism,
    iterations: ARGON2_PARAMS.iterations,
    memorySize: ARGON2_PARAMS.memorySize,
    hashLength: ARGON2_PARAMS.hashLength,
    outputType: "binary"
  });
}

export async function importAesKey(rawBytes: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    rawBytes as Uint8Array<ArrayBuffer>,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Passphrase → CryptoKey in one step. */
export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  return importAesKey(await deriveKeyBytes(passphrase, salt));
}

export async function encryptSeed(
  mnemonic: string,
  key: CryptoKey,
  iv: Uint8Array
): Promise<Uint8Array> {
  if (typeof mnemonic !== "string" || !mnemonic) {
    throw new TypeError("mnemonic must be a non-empty string");
  }
  const plaintext = new TextEncoder().encode(mnemonic);
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer> },
    key,
    plaintext
  );
  return new Uint8Array(ciphertext);
}

export async function decryptSeed(
  ciphertext: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array
): Promise<string> {
  try {
    const plaintext = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer> },
      key,
      ciphertext as Uint8Array<ArrayBuffer>
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch (err) {
    throw new WalletError(
      "WRONG_PASSPHRASE",
      "Decryption failed — wrong passphrase or corrupted data",
      { cause: err }
    );
  }
}
