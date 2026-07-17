// Server-parity: independently reproduce the BACKEND's request verification
// (node:crypto verify over an SPKI-wrapped raw Ed25519 key) and its getRawBody
// normalization, then prove that what signAgentRequest emits verifies under it.
// This is the guard that catches canonical-string drift from the server — the
// self-referential buildCanonicalString tests cannot. It specifically pins the
// empty-object body case (createKey() with no args → wire "" → server hashes "").

import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AGENT_AUTH_SCHEME,
  DEFAULT_AGENT_AUTH_AUDIENCE,
  generateAgentKeypair,
  signAgentRequest,
} from "../src/agent/keypair.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Replica of backend verifyAgentSignature (node crypto, SPKI-wrapped raw key). */
function serverVerify(publicKeyHex: string, signatureHex: string, message: string): boolean {
  const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]);
  const keyObject = createPublicKey({ key: der, format: "der", type: "spki" });
  return nodeVerify(null, Buffer.from(message), keyObject, Buffer.from(signatureHex, "hex"));
}

/** Replica of backend getRawBody: parse the wire string the way the runtime does, then normalize. */
function serverRawBodyFromWire(wireBody: string): string {
  if (wireBody === "") return "";
  const parsed = JSON.parse(wireBody);
  if (parsed == null || (typeof parsed === "object" && Object.keys(parsed).length === 0)) return "";
  return JSON.stringify(parsed);
}

/** Replica of backend buildCanonicalString, over the SERVER-reconstructed body. */
function serverCanonical(method: string, path: string, timestamp: string, nonce: string, wireBody: string): string {
  const bodyHash = createHash("sha256").update(serverRawBodyFromWire(wireBody), "utf8").digest("hex");
  return [
    AGENT_AUTH_SCHEME,
    DEFAULT_AGENT_AUTH_AUDIENCE,
    method.toUpperCase(),
    path,
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");
}

/** End-to-end: sign, then verify exactly as the server would (rebuilding from the wire body). */
function signsVerifiableByServer(method: string, path: string, body?: unknown): boolean {
  const kp = generateAgentKeypair();
  const signed = signAgentRequest({ keypair: kp, method, path, body });
  const canonical = serverCanonical(
    method,
    path,
    signed.headers["X-Agent-Timestamp"]!,
    signed.headers["X-Agent-Nonce"]!,
    signed.rawBody // the exact wire body the server would receive
  );
  return serverVerify(kp.publicKeyHex, signed.headers["X-Agent-Signature"]!, canonical);
}

describe("agent request signing — verifiable by the backend verifier", () => {
  it("GET with no body", () => {
    expect(signsVerifiableByServer("GET", "/api/agents/status")).toBe(true);
  });

  it("POST with a full body (register)", () => {
    const body = { name: "Acme", operator_token: "op_1", operator_email: "o@x.com", liquid_address: "lq1q" };
    expect(signsVerifiableByServer("POST", "/api/agents/register", body)).toBe(true);
  });

  it("POST with an EMPTY object body (createKey defaults) — must normalize to \"\"", () => {
    // Regression guard for the interop bug: {} → server hashes "", so the SDK
    // must too. A naive JSON.stringify({}) === "{}" would 401 here.
    const signed = signAgentRequest({ keypair: generateAgentKeypair(), method: "POST", path: "/api/agents/keys", body: {} });
    expect(signed.rawBody).toBe(""); // not "{}"
    expect(signsVerifiableByServer("POST", "/api/agents/keys", {})).toBe(true);
  });

  it("POST with a non-empty body (revoke)", () => {
    expect(signsVerifiableByServer("POST", "/api/agents/keys/revoke", { id: "key_1" })).toBe(true);
  });

  it("a mismatched canonical does NOT verify under the server", () => {
    const kp = generateAgentKeypair();
    // Signed at timestamp "1" (nowMs 1000)...
    const signed = signAgentRequest({ keypair: kp, method: "GET", path: "/api/agents/status", nonce: "n", nowMs: 1000 });
    // ...but the server rebuilds the canonical with a different timestamp "2".
    const wrongCanonical = serverCanonical("GET", "/api/agents/status", "2", "n", "");
    expect(serverVerify(kp.publicKeyHex, signed.headers["X-Agent-Signature"]!, wrongCanonical)).toBe(false);
  });
});
