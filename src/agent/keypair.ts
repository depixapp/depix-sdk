// Ed25519 agent-identity keypair + the §2.3 signed-request canonical form.
//
// This is the FIRST Ed25519 code in the SDK. The keypair is independent of the
// Liquid wallet seed — it proves control of the agent ACCOUNT (register + key
// lifecycle), not of funds. The canonical string here MUST reproduce the
// server's `buildCanonicalString` (backend `_lib/agent-auth.js`) byte-for-byte,
// or every signed request 401s.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/** Scheme tag — must equal the server's AUTH_SCHEME_VERSION. */
export const AGENT_AUTH_SCHEME = "depix-agent-auth:v1";

/** Default signed-request audience — must equal the server's authAudience(). */
export const DEFAULT_AGENT_AUTH_AUDIENCE = "api.depixapp.com";

export interface AgentKeypair {
  /** Raw 32-byte Ed25519 secret key. */
  secretKey: Uint8Array;
  /** Raw 32-byte Ed25519 public key. */
  publicKey: Uint8Array;
  /** Public key as 64 lowercase hex chars (the X-Agent-Public-Key header value). */
  publicKeyHex: string;
}

/** Generate a fresh Ed25519 agent keypair. */
export function generateAgentKeypair(): AgentKeypair {
  const { secretKey, publicKey } = ed25519.keygen();
  return { secretKey, publicKey, publicKeyHex: bytesToHex(publicKey) };
}

/** Reconstruct a keypair from a stored raw 32-byte secret key. */
export function keypairFromSecret(secretKey: Uint8Array): AgentKeypair {
  const publicKey = ed25519.getPublicKey(secretKey);
  return { secretKey, publicKey, publicKeyHex: bytesToHex(publicKey) };
}

/** sha256 of a UTF-8 string, lowercase hex. */
export function sha256Hex(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)));
}

export interface CanonicalInput {
  method: string;
  /** Request path, e.g. "/api/agents/status". */
  path: string;
  /** Unix SECONDS as a string — the exact value sent in X-Agent-Timestamp. */
  timestamp: string;
  nonce: string;
  /** The exact wire body string ("" for no body). */
  rawBody: string;
  /** Signed-request audience (default DEFAULT_AGENT_AUTH_AUDIENCE). */
  audience?: string;
}

/**
 * Build the canonical string that gets signed. Mirrors the server verbatim:
 * scheme \n audience \n METHOD \n path \n timestamp \n nonce \n sha256hex(body).
 */
export function buildCanonicalString(input: CanonicalInput): string {
  return [
    AGENT_AUTH_SCHEME,
    input.audience ?? DEFAULT_AGENT_AUTH_AUDIENCE,
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    sha256Hex(input.rawBody ?? ""),
  ].join("\n");
}

export interface SignedRequest {
  /** X-Agent-* headers to attach to the HTTP request. */
  headers: Record<string, string>;
  /** The exact body string to send on the wire ("" for no body). */
  rawBody: string;
}

/**
 * The wire body string, MATCHING the server's getRawBody normalization: null,
 * undefined, and an empty object all serialize to "". This must stay in lockstep
 * with the backend — a POST with an empty body (e.g. createKey() with defaults)
 * signs over sha256("") because the server rebuilds the canonical over "" after
 * parsing an empty object; anything else would 401.
 */
export function canonicalBody(body: unknown): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "object" && Object.keys(body as object).length === 0) return "";
  return JSON.stringify(body);
}

export interface SignRequestInput {
  keypair: AgentKeypair;
  method: string;
  path: string;
  /** Request body object; serialized with plain JSON.stringify (compact, key-insertion order). */
  body?: unknown;
  /** Unix milliseconds (defaults to Date.now()). Injected for deterministic tests. */
  nowMs?: number;
  /** Nonce override (defaults to a fresh 16-byte random hex). Injected for tests. */
  nonce?: string;
  audience?: string;
}

/**
 * Sign a request and return the X-Agent-* headers plus the exact wire body.
 *
 * The body hash is over `JSON.stringify(body)` — the same string sent as the
 * HTTP body — because the server re-serializes its parsed `req.body` the same
 * way (both sides are V8, key insertion order preserved, no whitespace). A
 * no-body request signs over "". Each call uses a FRESH nonce, so a signed
 * request is single-shot: never replay the same headers (the server's nonce
 * guard is fail-closed) — re-sign to retry.
 */
export function signAgentRequest(input: SignRequestInput): SignedRequest {
  const rawBody = canonicalBody(input.body);
  const timestamp = String(Math.floor((input.nowMs ?? Date.now()) / 1000));
  const nonce = input.nonce ?? bytesToHex(randomBytes(16));
  const canonical = buildCanonicalString({
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    rawBody,
    audience: input.audience,
  });
  const signature = bytesToHex(ed25519.sign(utf8ToBytes(canonical), input.keypair.secretKey));
  return {
    rawBody,
    headers: {
      "X-Agent-Public-Key": input.keypair.publicKeyHex,
      "X-Agent-Timestamp": timestamp,
      "X-Agent-Nonce": nonce,
      "X-Agent-Signature": signature,
    },
  };
}

/** Verify a signature (test/diagnostic helper — the server is the real verifier). */
export function verifyAgentSignature(publicKeyHex: string, signatureHex: string, message: string): boolean {
  try {
    return ed25519.verify(hexToBytes(signatureHex), utf8ToBytes(message), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}
