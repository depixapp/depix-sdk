// Webhook signature verification (spec §3.4) — pure util, no HTTP surface.
//
// Mirrors the backend dispatcher (webhook-dispatch.js:308-321): the header is
//   X-DePix-Signature: t=<unix-seconds>,v1=<hex hmac-sha256>
// and the signed message is `${t}.${rawBody}` keyed by the merchant's webhook
// secret. Comparison is constant-time. An optional tolerance rejects stale
// timestamps (replay protection) — off by default so a caller that does not
// pass a clock keeps the plain signature check.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyWebhookOptions {
  /**
   * Max allowed age (seconds) between the header timestamp and now. When set,
   * a timestamp outside ±tolerance fails verification (replay protection).
   */
  toleranceSeconds?: number;
  /** Clock injection (ms). Default Date.now. */
  now?: () => number;
}

interface ParsedSignatureHeader {
  timestamp: number;
  v1: string;
}

function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  if (typeof header !== "string" || header.length === 0) return null;
  let timestamp: number | undefined;
  let v1: string | undefined;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === "v1") {
      v1 = value;
    }
  }
  if (timestamp === undefined || v1 === undefined || v1.length === 0) return null;
  return { timestamp, v1 };
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, "hex");
    bufB = Buffer.from(b, "hex");
  } catch {
    return false;
  }
  // Non-hex chars decode to a shorter buffer — length guards the compare.
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify the `X-DePix-Signature` header for a raw webhook body.
 *
 * @param rawBody the EXACT bytes/string the server signed (never re-serialized)
 * @param signatureHeader the `X-DePix-Signature` header value
 * @param secret the merchant webhook secret
 * @returns true when the signature is valid (and, if a tolerance was given, fresh)
 */
export function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string,
  secret: string,
  options: VerifyWebhookOptions = {}
): boolean {
  if (typeof secret !== "string" || secret.length === 0) return false;
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;

  if (options.toleranceSeconds !== undefined) {
    const nowSeconds = Math.floor((options.now ?? Date.now)() / 1000);
    if (Math.abs(nowSeconds - parsed.timestamp) > options.toleranceSeconds) return false;
  }

  // Build `${t}.${rawBody}` incrementally so a Buffer body is not stringified.
  const hmac = createHmac("sha256", secret);
  hmac.update(`${parsed.timestamp}.`);
  hmac.update(rawBody);
  const expected = hmac.digest("hex");

  return constantTimeHexEqual(parsed.v1, expected);
}
