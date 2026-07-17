import { describe, expect, it } from "vitest";
import {
  AGENT_AUTH_SCHEME,
  DEFAULT_AGENT_AUTH_AUDIENCE,
  buildCanonicalString,
  generateAgentKeypair,
  keypairFromSecret,
  sha256Hex,
  signAgentRequest,
  verifyAgentSignature,
} from "../src/agent/keypair.js";

// sha256("") — the empty-body hash used by GET requests.
const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("agent keypair", () => {
  it("generates a 32-byte keypair with a 64-hex public key", () => {
    const kp = generateAgentKeypair();
    expect(kp.secretKey.length).toBe(32);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(keypairFromSecret(kp.secretKey).publicKeyHex).toBe(kp.publicKeyHex);
  });

  it("sha256Hex matches the known empty-string digest", () => {
    expect(sha256Hex("")).toBe(SHA256_EMPTY);
  });
});

describe("buildCanonicalString — byte-exact server contract", () => {
  it("produces the 7-line form for a no-body GET", () => {
    const canonical = buildCanonicalString({
      method: "get",
      path: "/api/agents/status",
      timestamp: "1700000000",
      nonce: "deadbeef",
      rawBody: "",
    });
    expect(canonical).toBe(
      [
        "depix-agent-auth:v1",
        "api.depixapp.com",
        "GET",
        "/api/agents/status",
        "1700000000",
        "deadbeef",
        SHA256_EMPTY,
      ].join("\n")
    );
    expect(canonical.split("\n")[0]).toBe(AGENT_AUTH_SCHEME);
    expect(canonical.split("\n")[1]).toBe(DEFAULT_AGENT_AUTH_AUDIENCE);
  });

  it("hashes the compact JSON body and uppercases the method", () => {
    const body = { name: "Acme", live: true };
    const canonical = buildCanonicalString({
      method: "post",
      path: "/api/agents/keys",
      timestamp: "42",
      nonce: "n1",
      rawBody: JSON.stringify(body),
    });
    expect(canonical.split("\n")[2]).toBe("POST");
    expect(canonical.split("\n")[6]).toBe(sha256Hex(JSON.stringify(body)));
    expect(canonical.split("\n")[6]).not.toBe(SHA256_EMPTY);
  });

  it("honors an audience override", () => {
    const canonical = buildCanonicalString({
      method: "GET",
      path: "/x",
      timestamp: "1",
      nonce: "n",
      rawBody: "",
      audience: "staging.example.com",
    });
    expect(canonical.split("\n")[1]).toBe("staging.example.com");
  });
});

describe("signAgentRequest", () => {
  it("emits the four X-Agent-* headers, deterministic under fixed nonce+clock", () => {
    const kp = generateAgentKeypair();
    const signed = signAgentRequest({
      keypair: kp,
      method: "GET",
      path: "/api/agents/status",
      nowMs: 1_700_000_000_000,
      nonce: "fixed-nonce",
    });
    expect(signed.rawBody).toBe("");
    expect(signed.headers["X-Agent-Public-Key"]).toBe(kp.publicKeyHex);
    expect(signed.headers["X-Agent-Timestamp"]).toBe("1700000000"); // ms → seconds
    expect(signed.headers["X-Agent-Nonce"]).toBe("fixed-nonce");
    expect(signed.headers["X-Agent-Signature"]).toMatch(/^[0-9a-f]{128}$/);

    // The signature must verify against the exact canonical string.
    const canonical = buildCanonicalString({
      method: "GET",
      path: "/api/agents/status",
      timestamp: "1700000000",
      nonce: "fixed-nonce",
      rawBody: "",
    });
    expect(verifyAgentSignature(kp.publicKeyHex, signed.headers["X-Agent-Signature"]!, canonical)).toBe(true);
  });

  it("signs the JSON body it will send, and each call uses a fresh nonce", () => {
    const kp = generateAgentKeypair();
    const body = { live: true, scopes: ["wallet_read"] };
    const a = signAgentRequest({ keypair: kp, method: "POST", path: "/api/agents/keys", body });
    const b = signAgentRequest({ keypair: kp, method: "POST", path: "/api/agents/keys", body });
    expect(a.rawBody).toBe(JSON.stringify(body));
    expect(a.headers["X-Agent-Nonce"]).not.toBe(b.headers["X-Agent-Nonce"]); // fresh per call
    const canonical = buildCanonicalString({
      method: "POST",
      path: "/api/agents/keys",
      timestamp: a.headers["X-Agent-Timestamp"]!,
      nonce: a.headers["X-Agent-Nonce"]!,
      rawBody: a.rawBody,
    });
    expect(verifyAgentSignature(kp.publicKeyHex, a.headers["X-Agent-Signature"]!, canonical)).toBe(true);
  });

  it("verify rejects a tampered signature / message", () => {
    const kp = generateAgentKeypair();
    const signed = signAgentRequest({ keypair: kp, method: "GET", path: "/x", nonce: "n", nowMs: 1000 });
    expect(verifyAgentSignature(kp.publicKeyHex, signed.headers["X-Agent-Signature"]!, "different message")).toBe(false);
    expect(verifyAgentSignature(kp.publicKeyHex, "00".repeat(64), "anything")).toBe(false);
  });
});
