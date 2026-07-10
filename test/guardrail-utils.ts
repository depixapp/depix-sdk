// Shared test helpers for the guardrail suites (not a *.test file — vitest
// ignores it). Provides a deterministic state key + an in-memory marker so the
// Guardrails class can be exercised without a full wallet.

import { importAesKey } from "../src/store/crypto.js";
import type { GuardrailMarkerStore } from "../src/guardrails/guardrails.js";

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

/** In-memory equivalent of the wallet.json guardrailsStateInitialized marker (§4.5). */
export class InMemoryMarker implements GuardrailMarkerStore {
  present: boolean;
  constructor(initial = false) {
    this.present = initial;
  }
  async isInitialized(): Promise<boolean> {
    return this.present;
  }
  async markInitialized(): Promise<void> {
    this.present = true;
  }
}
