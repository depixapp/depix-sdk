// verifyWebhookSignature (spec §3.4) — mirrors webhook-dispatch.js:308-321.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "../src/webhooks.js";

const SECRET = "whsec_test_secret_value";
const BODY = JSON.stringify({ event: "withdraw.sent", data: { withdrawalId: "w_1" } });

function sign(body: string, secret: string, timestamp: number): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

describe("verifyWebhookSignature", () => {
  it("accepts a valid signature (backend dispatcher scheme)", () => {
    const header = sign(BODY, SECRET, 1_720_000_000);
    expect(verifyWebhookSignature(BODY, header, SECRET)).toBe(true);
  });

  it("accepts a Buffer body identical to the signed string", () => {
    const header = sign(BODY, SECRET, 1_720_000_000);
    expect(verifyWebhookSignature(Buffer.from(BODY, "utf8"), header, SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const header = sign(BODY, SECRET, 1_720_000_000);
    expect(verifyWebhookSignature(BODY + " ", header, SECRET)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const header = sign(BODY, SECRET, 1_720_000_000);
    expect(verifyWebhookSignature(BODY, header, "whsec_wrong")).toBe(false);
  });

  it("rejects a signature bound to a different timestamp (t is part of the message)", () => {
    const header = sign(BODY, SECRET, 1_720_000_000);
    const forged = header.replace("t=1720000000", "t=1720000001");
    expect(verifyWebhookSignature(BODY, forged, SECRET)).toBe(false);
  });

  it("rejects malformed / empty headers and empty secret", () => {
    expect(verifyWebhookSignature(BODY, "", SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, "v1=deadbeef", SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, "t=1,x=y", SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, sign(BODY, SECRET, 1), "")).toBe(false);
  });

  it("enforces an optional freshness tolerance", () => {
    const now = 1_720_000_100_000; // ms
    const fresh = sign(BODY, SECRET, 1_720_000_090); // 10s ago
    const stale = sign(BODY, SECRET, 1_720_000_000); // 100s ago
    expect(verifyWebhookSignature(BODY, fresh, SECRET, { toleranceSeconds: 30, now: () => now })).toBe(true);
    expect(verifyWebhookSignature(BODY, stale, SECRET, { toleranceSeconds: 30, now: () => now })).toBe(false);
  });
});
