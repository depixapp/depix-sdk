// Authenticated encryption of the guardrails-state file (spec §4.5).
//
// For pure Liquid sends, swaps and gift cards the client-side guardrail is the
// ONLY layer (§4.6). An injected agent with filesystem write access that could
// forge or reset the rolling-24h accumulator would defeat the daily ceiling. So
// the state is AES-256-GCM authenticated with the SAME key derived from the
// passphrase as the seed store (§2.4) — a write without the key produces an
// invalid GCM tag on read. A fixed AAD binds the ciphertext to this file's role
// (so it can't be confused with the seed blob, which uses no AAD).

import { base64 } from "@scure/base";
import { randomIv } from "../store/crypto.js";

const STATE_AAD = new TextEncoder().encode("depix-sdk-guardrails-state-v1");

export interface StateEnvelope {
  /** Envelope format version (distinct from the plaintext state version). */
  v: 1;
  iv: string; // base64, 12 bytes
  ct: string; // base64 — AES-256-GCM ciphertext + appended 128-bit tag
}

/** Encrypt a UTF-8 plaintext into an authenticated envelope. */
export async function encryptState(plaintext: string, key: CryptoKey): Promise<StateEnvelope> {
  const iv = randomIv();
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer>, additionalData: STATE_AAD },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { v: 1, iv: base64.encode(iv), ct: base64.encode(new Uint8Array(ciphertext)) };
}

export type DecryptResult =
  | { ok: true; plaintext: string }
  | { ok: false; reason: "malformed" | "auth" };

/**
 * Decrypt + verify an envelope. Returns a discriminated result rather than
 * throwing so the caller can distinguish a tampered/wrong-key blob ("auth")
 * from a structurally broken file ("malformed") — both are treated as
 * fail-closed-with-marker (§4.5), but the log distinguishes them.
 */
export async function decryptState(raw: string, key: CryptoKey): Promise<DecryptResult> {
  let env: StateEnvelope;
  try {
    const parsed = JSON.parse(raw) as StateEnvelope;
    if (parsed.v !== 1 || typeof parsed.iv !== "string" || typeof parsed.ct !== "string") {
      return { ok: false, reason: "malformed" };
    }
    env = parsed;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  let iv: Uint8Array;
  let ct: Uint8Array;
  try {
    iv = base64.decode(env.iv);
    ct = base64.decode(env.ct);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  try {
    const plaintext = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer>, additionalData: STATE_AAD },
      key,
      ct as Uint8Array<ArrayBuffer>
    );
    return { ok: true, plaintext: new TextDecoder("utf-8", { fatal: true }).decode(plaintext) };
  } catch {
    // GCM tag mismatch (tampered / wrong key) or bad UTF-8.
    return { ok: false, reason: "auth" };
  }
}
