// Shared test helpers for the guardrail suites (not a *.test file — vitest
// ignores it). Provides a deterministic state key + an in-memory anchor so the
// Guardrails class can be exercised without a full wallet, PLUS a real
// SeedStore-backed anchor so the §4.5 marker/epoch can be tested on the REAL
// disk path (not just the in-memory double, which cannot exhibit the plaintext
// malleability the HIGH review comment is about).

import { base64 } from "@scure/base";
import {
  deriveStateSubkey,
  deriveKey,
  deriveKeyBytes,
  importAesKey
} from "../src/store/crypto.js";
import { SeedStore } from "../src/store/seed-store.js";
import type { GuardrailAnchorStore } from "../src/guardrails/guardrails.js";

/**
 * A stable 32-byte AES-256-GCM key. Stable so state written by one Guardrails
 * instance decrypts in another instance over the same dataDir (the "restart"
 * tests). Two CryptoKeys imported from the same bytes are interchangeable.
 */
export async function testStateKey(): Promise<CryptoKey> {
  return importAesKey(new Uint8Array(32).fill(7));
}

/** A different key — used to prove a wrong-key read fails authentication. */
export async function otherStateKey(): Promise<CryptoKey> {
  return importAesKey(new Uint8Array(32).fill(42));
}

/** Memoize a key provider so Argon2id-shaped repeated derivation is avoided in tests. */
export function keyProvider(derive: () => Promise<CryptoKey> = testStateKey): () => Promise<CryptoKey> {
  let p: Promise<CryptoKey> | null = null;
  return () => (p ??= derive());
}

/**
 * In-memory equivalent of the wallet.json seed-bound guardrail anchor (§4.5).
 * Tracks the marker + monotonic epoch; advance() sets initialized and bumps the
 * epoch. Share ONE instance across "restart" test instances to model the single
 * persisted wallet.json.
 */
export class InMemoryAnchor implements GuardrailAnchorStore {
  initialized: boolean;
  epoch: number;
  constructor(initialized = false, epoch = 0) {
    this.initialized = initialized;
    this.epoch = epoch;
  }
  async read(): Promise<{ initialized: boolean; epoch: number }> {
    return { initialized: this.initialized, epoch: this.epoch };
  }
  async advance(): Promise<number> {
    this.initialized = true;
    this.epoch += 1;
    return this.epoch;
  }
}

const ANCHOR_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ANCHOR_DESCRIPTOR =
  "ct(slip77(9c8e4f05c7711a98c838be228bcb84924d4570ca53f35fa1c793e58841d47023),elwpkh([73c5da0a/84'/1776'/0']xpub6CRFzUgHFDaiDAQFNX7VeV9JNPDRabq6NYSpzVZ8zW8ANUCiDdenkb1gBoEZuXNZb3wPc1SVcDXgD2ww5UBtTb8s8ArAbTkoRQ8qn34KgcY/<0;1>/*))#87kykuta";

/**
 * A REAL SeedStore-backed anchor over a real wallet.json — the disk path the
 * HIGH comment targets. `advance()` re-encrypts the seed under the bumped anchor;
 * the state key is the HKDF subkey of the same seed material (production wiring).
 */
export interface RealAnchorFixture {
  seedStore: SeedStore;
  anchor: GuardrailAnchorStore;
  stateKey: () => Promise<CryptoKey>;
  passphrase: string;
  mnemonic: string;
}

export async function makeRealAnchor(
  dataDir: string,
  passphrase = "correct-horse-battery-staple"
): Promise<RealAnchorFixture> {
  const seedStore = new SeedStore(dataDir);
  await seedStore.initialize({
    passphrase,
    mnemonic: ANCHOR_MNEMONIC,
    descriptor: ANCHOR_DESCRIPTOR
  });
  const file = (await seedStore.read())!;
  const rootBytes = await deriveKeyBytes(passphrase, base64.decode(file.salt!));
  const seedKey = await importAesKey(rootBytes);
  const stateSubkey = await deriveStateSubkey(rootBytes);
  const anchor: GuardrailAnchorStore = {
    read: () => seedStore.readGuardrailAnchor(),
    advance: () => seedStore.advanceGuardrailAnchor(seedKey)
  };
  return {
    seedStore,
    anchor,
    stateKey: async () => stateSubkey,
    passphrase,
    mnemonic: ANCHOR_MNEMONIC
  };
}

/** Convenience for asserting the seed still decrypts (or no longer does). */
export async function tryDecryptSeed(seedStore: SeedStore, passphrase: string): Promise<string> {
  return seedStore.decryptMnemonic(passphrase);
}

// Re-export so callers that want the raw seed key can build one.
export { deriveKey };
