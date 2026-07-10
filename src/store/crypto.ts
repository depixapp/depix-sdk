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

/**
 * HKDF info label for the guardrails-state subkey (spec §4.5 / review hygiene).
 * Same string as the state file's GCM AAD (state-crypto.ts) — one role, one label.
 */
export const GUARDRAIL_STATE_HKDF_INFO = "depix-sdk-guardrails-state-v1";

/**
 * Derive a per-ROLE AES-256-GCM subkey from the seed-store root key material via
 * HKDF-SHA256 (review low, state-crypto.ts:14). The seed blob and the
 * guardrails-state blob share a single passphrase / single Argon2 derivation
 * (spec §4.5 "mesma chave do seed-store"), but HKDF domain-separates the
 * KEYSTREAM so the two files never share raw AES-GCM key space — which matters
 * now that the seed is re-encrypted with a FRESH IV on every guardrail write
 * (§4.5 anti-replay), raising the historical IV-collision surface under a shared
 * key. `info` binds the subkey to its role; an empty salt is fine for HKDF.
 */
export async function deriveStateSubkey(rootKeyBytes: Uint8Array): Promise<CryptoKey> {
  const hkdfKey = await globalThis.crypto.subtle.importKey(
    "raw",
    rootKeyBytes as Uint8Array<ArrayBuffer>,
    "HKDF",
    false,
    ["deriveKey"]
  );
  return globalThis.crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0) as Uint8Array<ArrayBuffer>,
      info: new TextEncoder().encode(GUARDRAIL_STATE_HKDF_INFO) as Uint8Array<ArrayBuffer>
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypt the mnemonic. The optional `aad` (spec §4.5) binds extra plaintext to
 * the GCM tag WITHOUT encrypting it — used to anchor the guardrail marker/epoch
 * to the seed so stripping/editing those fields breaks seed authentication.
 */
export async function encryptSeed(
  mnemonic: string,
  key: CryptoKey,
  iv: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  if (typeof mnemonic !== "string" || !mnemonic) {
    throw new TypeError("mnemonic must be a non-empty string");
  }
  const plaintext = new TextEncoder().encode(mnemonic);
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    aad
      ? {
          name: "AES-GCM",
          iv: iv as Uint8Array<ArrayBuffer>,
          additionalData: aad as Uint8Array<ArrayBuffer>
        }
      : { name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer> },
    key,
    plaintext
  );
  return new Uint8Array(ciphertext);
}

export async function decryptSeed(
  ciphertext: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array,
  aad?: Uint8Array
): Promise<string> {
  try {
    const plaintext = await globalThis.crypto.subtle.decrypt(
      aad
        ? {
            name: "AES-GCM",
            iv: iv as Uint8Array<ArrayBuffer>,
            additionalData: aad as Uint8Array<ArrayBuffer>
          }
        : { name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer> },
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

/**
 * Authenticated AES-256-GCM encryption of arbitrary bytes with additional
 * authenticated data (spec §3.2.9). The pending-withdrawals store uses this
 * with the SAME key derived from the seed store (deriveKey), binding each
 * record's ciphertext to its AAD (the withdrawalId, or the idempotencyKey
 * before the withdrawalId is known). An injected agent that rewrites the file
 * cannot forge the GCM tag without the key.
 */
export async function aesGcmEncrypt(
  plaintext: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array,
  additionalData?: Uint8Array
): Promise<Uint8Array> {
  const algorithm = {
    name: "AES-GCM",
    iv: iv as Uint8Array<ArrayBuffer>,
    ...(additionalData ? { additionalData: additionalData as Uint8Array<ArrayBuffer> } : {})
  };
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    algorithm,
    key,
    plaintext as Uint8Array<ArrayBuffer>
  );
  return new Uint8Array(ciphertext);
}

/**
 * Authenticated AES-256-GCM decryption. Throws a plain Error on
 * authentication failure (wrong key, tampered ciphertext or mismatched AAD) —
 * callers map that to their domain error (e.g. PENDING_RECORD_TAMPERED),
 * unlike decryptSeed which is passphrase-specific.
 */
export async function aesGcmDecrypt(
  ciphertext: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array,
  additionalData?: Uint8Array
): Promise<Uint8Array> {
  const algorithm = {
    name: "AES-GCM",
    iv: iv as Uint8Array<ArrayBuffer>,
    ...(additionalData ? { additionalData: additionalData as Uint8Array<ArrayBuffer> } : {})
  };
  const plaintext = await globalThis.crypto.subtle.decrypt(
    algorithm,
    key,
    ciphertext as Uint8Array<ArrayBuffer>
  );
  return new Uint8Array(plaintext);
}
