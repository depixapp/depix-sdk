// send() (spec §2.3) — every path goes through the guardrail choke point
// BEFORE signing (§4.3). Offline: an empty wallet exercises validation,
// guardrails and the INSUFFICIENT_FUNDS path without touching the network.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DepixWallet } from "../src/wallet.js";
import { GUARDRAILS_STATE_FILE } from "../src/guardrails/guardrails.js";
import { isDepixSdkError } from "../src/errors.js";

const PASSPHRASE = "correct-horse-battery-staple";
const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// A valid mainnet confidential address (golden addr[1] of the known mnemonic).
const VALID_ADDRESS =
  "lq1qqfk0uw9vlmqlggzs7cxmw49x8ks37l87udspmpt3ssgxjrkqqlww63xvus3c5gaz89r2kd393c4fvurwxf06qj87y2kd3vsln";

let dataDir: string;
let wallet: DepixWallet;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-send-"));
  wallet = await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC });
});

afterEach(async () => {
  await wallet.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
});

describe("input validation", () => {
  it("rejects unknown assets with UNSUPPORTED_ASSET", async () => {
    await expect(
      wallet.send({ asset: "DOGE" as never, amountSats: 1n, address: VALID_ADDRESS })
    ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "UNSUPPORTED_ASSET"));
  });

  it("rejects non-positive or non-bigint amounts with INVALID_AMOUNT", async () => {
    for (const amount of [0n, -5n, 100 as unknown as bigint]) {
      await expect(
        wallet.send({ asset: "DEPIX", amountSats: amount, address: VALID_ADDRESS })
      ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "INVALID_AMOUNT"));
    }
  });

  it("rejects unparseable addresses with INVALID_ADDRESS", async () => {
    await expect(
      wallet.send({ asset: "DEPIX", amountSats: 1_000_000n, address: "not-an-address" })
    ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "INVALID_ADDRESS"));
  });
});

describe("guardrail choke point runs BEFORE signing (§4.3)", () => {
  it("blocks a DePix send above R$100 with GUARDRAIL_PER_TX_LIMIT — no request, no signature", async () => {
    // R$ 100,01 = 10_001 cents = 10_001 × 10^6 sats.
    await expect(
      wallet.send({ asset: "DEPIX", amountSats: 10_001n * 1_000_000n, address: VALID_ADDRESS })
    ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "GUARDRAIL_PER_TX_LIMIT"));
    // Nothing was accounted: blocked intents never reach recordSpend.
    await expect(readFile(join(dataDir, GUARDRAILS_STATE_FILE))).rejects.toThrow();
  });

  it("values DePix 1:1 BRL rounding UP (fractional cents cannot shave the cap)", async () => {
    // 10_000 cents + 1 sat → ceil = 10_001 cents → blocked.
    await expect(
      wallet.send({
        asset: "DEPIX",
        amountSats: 10_000n * 1_000_000n + 1n,
        address: VALID_ADDRESS
      })
    ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "GUARDRAIL_PER_TX_LIMIT"));
  });

  it("fails CLOSED with QUOTES_UNAVAILABLE for L-BTC and USDt (valuation is PR3 — G6)", async () => {
    for (const asset of ["LBTC", "USDT"] as const) {
      await expect(
        wallet.send({ asset, amountSats: 1_000n, address: VALID_ADDRESS })
      ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "QUOTES_UNAVAILABLE"));
    }
  });
});

describe("funds", () => {
  it("an empty wallet fails with INSUFFICIENT_FUNDS after passing the guardrails", async () => {
    // R$ 50 DePix — within both caps, but the wallet has no UTXOs.
    await expect(
      wallet.send({ asset: "DEPIX", amountSats: 5_000n * 1_000_000n, address: VALID_ADDRESS })
    ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "INSUFFICIENT_FUNDS"));
  });
});

describe("concurrent send() is serialized through the choke point (§4.3 TOCTOU)", () => {
  it("parallel sends each run enforce→sign and the mutex releases on every error path", async () => {
    // Three concurrent R$50 sends (within both caps) on an empty wallet: each
    // must pass the guardrail and then fail at build with INSUFFICIENT_FUNDS.
    // If the per-instance opMutex failed to release on the throw path, the 2nd
    // and 3rd would never acquire the lock and this test would hang (timeout) —
    // so completing at all proves release-on-error, and INSUFFICIENT_FUNDS for
    // every call proves each independently reached the signing leg in turn.
    const amount = 5_000n * 1_000_000n;
    const results = await Promise.allSettled([
      wallet.send({ asset: "DEPIX", amountSats: amount, address: VALID_ADDRESS }),
      wallet.send({ asset: "DEPIX", amountSats: amount, address: VALID_ADDRESS }),
      wallet.send({ asset: "DEPIX", amountSats: amount, address: VALID_ADDRESS })
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    for (const r of results) {
      expect(
        isDepixSdkError((r as PromiseRejectedResult).reason, "INSUFFICIENT_FUNDS")
      ).toBe(true);
    }
  });
});
