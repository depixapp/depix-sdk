// Seed crypto (spec §2.4) — Argon2id (hash-wasm, frontend params) + AES-256-GCM.
import { describe, expect, it } from "vitest";
import {
  ARGON2_PARAMS,
  MIN_PASSPHRASE_LENGTH,
  assertStrongPassphrase,
  decryptSeed,
  deriveKey,
  deriveKeyBytes,
  encryptSeed,
  randomIv,
  randomSalt
} from "../src/store/crypto.js";
import { isDepixSdkError } from "../src/errors.js";

const PASSPHRASE = "correct-horse-battery-staple";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("Argon2id derivation — frontend parity (spec §2.4)", () => {
  it("uses the exact frontend params (wallet-crypto.js + constants.js)", () => {
    expect(ARGON2_PARAMS).toEqual({
      parallelism: 1,
      iterations: 2,
      memorySize: 19456, // KiB = 19 MiB
      hashLength: 32
    });
  });

  it("golden vector: derives bit-identical key material to the frontend wallet-crypto.js", async () => {
    // Generated once by running depix-frontend/wallet/wallet-crypto.js
    // deriveKeyBytes("correct-horse-battery-staple", 0x000102...0f) with
    // hash-wasm@4.12.0 — same pin as this package.
    const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
    const raw = await deriveKeyBytes(PASSPHRASE, salt);
    expect(Buffer.from(raw).toString("hex")).toBe(
      "6987cef77cc4e8697dc7803a3af7fa5b7e5bfed49b45d3ec55c18d8a6dba2429"
    );
  });
});

describe("seed encryption roundtrip", () => {
  it("encrypts and decrypts the mnemonic", async () => {
    const salt = randomSalt();
    const iv = randomIv();
    expect(salt.length).toBe(16);
    expect(iv.length).toBe(12);
    const key = await deriveKey(PASSPHRASE, salt);
    const ciphertext = await encryptSeed(MNEMONIC, key, iv);
    expect(ciphertext.length).toBeGreaterThan(MNEMONIC.length); // GCM tag appended
    const plaintext = await decryptSeed(ciphertext, key, iv);
    expect(plaintext).toBe(MNEMONIC);
  });

  it("wrong passphrase fails with WRONG_PASSPHRASE (no wipe, no counter — G8)", async () => {
    const salt = randomSalt();
    const iv = randomIv();
    const key = await deriveKey(PASSPHRASE, salt);
    const ciphertext = await encryptSeed(MNEMONIC, key, iv);
    const wrongKey = await deriveKey("another-passphrase-of-12+", salt);
    await expect(decryptSeed(ciphertext, wrongKey, iv)).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "WRONG_PASSPHRASE")
    );
  });

  it("tampered ciphertext fails with WRONG_PASSPHRASE (GCM auth)", async () => {
    const salt = randomSalt();
    const iv = randomIv();
    const key = await deriveKey(PASSPHRASE, salt);
    const ciphertext = await encryptSeed(MNEMONIC, key, iv);
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    await expect(decryptSeed(ciphertext, key, iv)).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "WRONG_PASSPHRASE")
    );
  });
});

describe("passphrase policy (spec §2.4 — 12+ chars, WEAK_PASSPHRASE)", () => {
  it("rejects short, empty and non-string passphrases", () => {
    expect(MIN_PASSPHRASE_LENGTH).toBe(12);
    for (const bad of ["", "short", "elevenchars", undefined, null, 123456]) {
      try {
        assertStrongPassphrase(bad as string);
        expect.unreachable(`should reject: ${String(bad)}`);
      } catch (err) {
        expect(isDepixSdkError(err, "WEAK_PASSPHRASE"), String(bad)).toBe(true);
      }
    }
  });

  it("accepts 12+ character passphrases", () => {
    expect(() => assertStrongPassphrase("twelve-chars")).not.toThrow();
    expect(() => assertStrongPassphrase(PASSPHRASE)).not.toThrow();
  });
});
