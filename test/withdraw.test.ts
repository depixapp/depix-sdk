// withdraw() contract (spec §3.2) — pure helpers + end-to-end through the
// wallet with a mocked API and a real (empty) LWK wallet. No real broadcast.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASSETS } from "../src/assets.js";
import { Address } from "../src/engine/lwk.js";
import { DepixWallet } from "../src/wallet.js";
import { PendingWithdrawals } from "../src/pending.js";
import { isDepixSdkError } from "../src/errors.js";
import {
  assertFeeAddressExplicit,
  assertSplitConsistent,
  assertWithdrawPsetOutputs,
  normalizeWithdrawResponse,
  type PsetLike
} from "../src/flows/withdraw.js";
import { mockFetch, type MockResponseSpec } from "./support/mock.js";

const PASSPHRASE = "correct-horse-battery-staple";
const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// A valid confidential (lq1) mainnet address (golden addr[1] of the mnemonic).
const EULEN_LQ1 =
  "lq1qqfk0uw9vlmqlggzs7cxmw49x8ks37l87udspmpt3ssgxjrkqqlww63xvus3c5gaz89r2kd393c4fvurwxf06qj87y2kd3vsln";
// Its explicit (ex1, unblinded) form — the shape a real fee_address arrives in.
const EX1 = new Address(EULEN_LQ1).toUnconfidential().toString();
// A DISTINCT explicit fee address (its own scriptPubkey — a real fee_address is
// DEPIX_SPLIT_ADDRESS, never the Eulen deposit address).
const FEE_EX1 = "ex1qfu0zk2g5tgrzfr33qqlgsykec6dwj6g9234jr7";
const SATS_PER_CENT = 10n ** 6n;
const DEPIX_ID = ASSETS.DEPIX.id;
// A real, small Liquid mainnet tx hex (public) — parseable by Transaction.fromString,
// used ONLY as opaque signed bytes (same fixture as the resume suite).
const FIXTURE_TXID = "21cb9e1fd71f5d9e9d9f5843f14f912ffd2f023b089fd0b78f2718fcdde52f33";
const FIXTURE_HEX =
  "0200000001010000000000000000000000000000000000000000000000000000000000000000ffffffff060365843c0101ffffffff03016d521c38ec1ea15734ae22b7c46064412829c0d0579f0a713d1c04ede979026f01000000000000000000266a240a8ce26f7f113667dccb98522fb9c292911d81ec200d31adc94501000000000000000000016d521c38ec1ea15734ae22b7c46064412829c0d0579f0a713d1c04ede979026f01000000000000010d001976a914fc26751a5025129a2fd006c6fbfa598ddd67f7e188ac016d521c38ec1ea15734ae22b7c46064412829c0d0579f0a713d1c04ede979026f01000000000000000000266a24aa21a9ed8fbc0adfe56fb749b2640b7b9131e42c6043588725c997c70c3658eea333f1510000000000000120000000000000000000000000000000000000000000000000000000000000000000000000000000";

// ─── pure helpers ───────────────────────────────────────────────────────────

describe("normalizeWithdrawResponse (§3.2.2/§3.2.4)", () => {
  it("GROSS = totalDepositAmountInCents when the split fee is active", () => {
    const n = normalizeWithdrawResponse({
      withdrawalId: "w",
      depositAddress: EULEN_LQ1,
      depositAmountInCents: 9900,
      payoutAmountInCents: 9800,
      totalDepositAmountInCents: 10000,
      fee_cents: 100,
      fee_address: FEE_EX1
    });
    expect(n.netCents).toBe(9900);
    expect(n.grossCents).toBe(10000);
    expect(n.hasFee).toBe(true);
    expect(n.feeCents).toBe(100);
  });

  it("GROSS falls back to depositAmountInCents when there is no split (single-output branch)", () => {
    const n = normalizeWithdrawResponse({
      withdrawalId: "w",
      depositAddress: EULEN_LQ1,
      depositAmountInCents: 5000,
      payoutAmountInCents: 4900
    });
    expect(n.hasFee).toBe(false);
    expect(n.feeCents).toBeNull();
    expect(n.grossCents).toBe(5000); // fallback — not undefined/NaN
  });

  it("rejects a half-present fee pair (only fee_cents) as WITHDRAW_SPLIT_MISMATCH", () => {
    expect(() =>
      normalizeWithdrawResponse({
        withdrawalId: "w",
        depositAddress: EULEN_LQ1,
        depositAmountInCents: 5000,
        payoutAmountInCents: 4900,
        fee_cents: 50
      })
    ).toThrow(/WITHDRAW_SPLIT_MISMATCH|fee_cents/);
  });
});

describe("assertFeeAddressExplicit (§3.2.3 fail-closed)", () => {
  it("rejects a confidential (lq1) fee address with FEE_ADDRESS_NOT_EXPLICIT", () => {
    expect(() => assertFeeAddressExplicit(EULEN_LQ1)).toSatisfy((thrower) => {
      try {
        (thrower as () => unknown)();
        return false;
      } catch (err) {
        return isDepixSdkError(err, "FEE_ADDRESS_NOT_EXPLICIT");
      }
    });
  });

  it("rejects an unparseable fee address with FEE_ADDRESS_NOT_EXPLICIT", () => {
    let code: string | undefined;
    try {
      assertFeeAddressExplicit("not-an-address");
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe("FEE_ADDRESS_NOT_EXPLICIT");
  });

  it("accepts an explicit (ex1) fee address", () => {
    const addr = assertFeeAddressExplicit(EX1);
    expect(addr.isBlinded()).toBe(false);
    addr.free();
  });
});

describe("assertSplitConsistent (§3.2.4)", () => {
  it("passes when NET + fee === GROSS", () => {
    expect(() => assertSplitConsistent(9900, 100, 10000)).not.toThrow();
  });
  it("throws WITHDRAW_SPLIT_MISMATCH otherwise", () => {
    let code: string | undefined;
    try {
      assertSplitConsistent(9900, 100, 12345);
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe("WITHDRAW_SPLIT_MISMATCH");
  });
});

describe("assertWithdrawPsetOutputs (§3.2.5 — output A script + explicit output B)", () => {
  const depositScriptHex = new Address(EULEN_LQ1).scriptPubkey().toString();
  const feeScriptHex = new Address(FEE_EX1).scriptPubkey().toString();

  function out(scriptHex: string, amount?: bigint, assetId?: string) {
    return {
      scriptPubkey: () => ({ toString: () => scriptHex }),
      amount: () => amount,
      asset: () => (assetId ? { toString: () => assetId } : undefined)
    };
  }

  it("accepts the Eulen output (confidential) + an EXPLICIT fee output", () => {
    const pset: PsetLike = { outputs: () => [out(depositScriptHex), out(feeScriptHex, 100n * SATS_PER_CENT, DEPIX_ID)] };
    expect(() =>
      assertWithdrawPsetOutputs(pset, {
        depositScriptHex,
        netSats: 9900n * SATS_PER_CENT,
        feeScriptHex,
        feeSats: 100n * SATS_PER_CENT
      })
    ).not.toThrow();
  });

  it("accepts a single-output tx when there is no fee", () => {
    const pset: PsetLike = { outputs: () => [out(depositScriptHex)] };
    expect(() =>
      assertWithdrawPsetOutputs(pset, { depositScriptHex, netSats: 5000n * SATS_PER_CENT })
    ).not.toThrow();
  });

  it("rejects a BLINDED fee output with FEE_ADDRESS_NOT_EXPLICIT", () => {
    const pset: PsetLike = { outputs: () => [out(depositScriptHex), out(feeScriptHex)] };
    let code: string | undefined;
    try {
      assertWithdrawPsetOutputs(pset, { depositScriptHex, netSats: 1n, feeScriptHex, feeSats: 100n * SATS_PER_CENT });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe("FEE_ADDRESS_NOT_EXPLICIT");
  });

  it("rejects a wrong fee value with WITHDRAW_SPLIT_MISMATCH", () => {
    const pset: PsetLike = { outputs: () => [out(depositScriptHex), out(feeScriptHex, 999n, DEPIX_ID)] };
    let code: string | undefined;
    try {
      assertWithdrawPsetOutputs(pset, { depositScriptHex, netSats: 1n, feeScriptHex, feeSats: 100n * SATS_PER_CENT });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe("WITHDRAW_SPLIT_MISMATCH");
  });

  it("rejects a PSET missing the Eulen output", () => {
    const pset: PsetLike = { outputs: () => [out(feeScriptHex, 100n * SATS_PER_CENT, DEPIX_ID)] };
    let code: string | undefined;
    try {
      assertWithdrawPsetOutputs(pset, { depositScriptHex, netSats: 1n, feeScriptHex, feeSats: 100n * SATS_PER_CENT });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe("WITHDRAW_SPLIT_MISMATCH");
  });
});

// ─── end-to-end through the wallet ───────────────────────────────────────────

let dataDir: string;
let wallet: DepixWallet;

async function makeWallet(response: MockResponseSpec): Promise<DepixWallet> {
  const { fetch } = mockFetch([response]);
  return DepixWallet.restore({
    dataDir,
    passphrase: PASSPHRASE,
    mnemonic: KNOWN_MNEMONIC,
    apiKey: "sk_live_flowtest",
    fetch,
    sync: { worker: false }
  });
}

async function pendingCount(): Promise<number> {
  try {
    const raw = await readFile(join(dataDir, "pending-withdrawals.json"), "utf8");
    return JSON.parse(raw).records.length as number;
  } catch {
    return 0;
  }
}

async function saltOf(dir: string): Promise<string> {
  return JSON.parse(await readFile(join(dir, "wallet.json"), "utf8")).salt as string;
}

const BASE_PARAMS = { pixKey: "user@example.com", recipientTaxNumber: "12345678909", mode: "send" as const };

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-withdraw-"));
});

afterEach(async () => {
  await wallet?.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
});

describe("withdraw() flow", () => {
  it("fails CLOSED with FEE_ADDRESS_NOT_EXPLICIT when fee_address is confidential — before signing", async () => {
    wallet = await makeWallet({
      json: {
        response: {
          withdrawalId: "w1",
          depositAddress: EULEN_LQ1,
          depositAmountInCents: 500,
          payoutAmountInCents: 490,
          totalDepositAmountInCents: 505,
          fee_cents: 5,
          fee_address: EULEN_LQ1 // confidential lq1 — must abort
        }
      }
    });
    await expect(wallet.withdraw({ ...BASE_PARAMS, amountCents: 500 })).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "FEE_ADDRESS_NOT_EXPLICIT")
    );
    expect(await pendingCount()).toBe(0); // requested record discarded (not a crash)
  });

  it("fails with WITHDRAW_SPLIT_MISMATCH when NET + fee !== GROSS", async () => {
    wallet = await makeWallet({
      json: {
        response: {
          withdrawalId: "w1",
          depositAddress: EULEN_LQ1,
          depositAmountInCents: 500,
          payoutAmountInCents: 490,
          totalDepositAmountInCents: 999, // 500 + 5 !== 999
          fee_cents: 5,
          fee_address: FEE_EX1
        }
      }
    });
    await expect(wallet.withdraw({ ...BASE_PARAMS, amountCents: 500 })).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "WITHDRAW_SPLIT_MISMATCH")
    );
  });

  it("passes through the guardrail counting the GROSS — blocks above R$100/tx (fee branch)", async () => {
    wallet = await makeWallet({
      json: {
        response: {
          withdrawalId: "w1",
          depositAddress: EULEN_LQ1,
          depositAmountInCents: 9500,
          payoutAmountInCents: 9300,
          totalDepositAmountInCents: 10100, // GROSS R$101 > R$100 per-tx cap
          fee_cents: 600,
          fee_address: FEE_EX1
        }
      }
    });
    await expect(wallet.withdraw({ ...BASE_PARAMS, amountCents: 9500 })).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "GUARDRAIL_PER_TX_LIMIT")
    );
    expect(await pendingCount()).toBe(0);
  });

  it("counts the GROSS via the total ?? deposit fallback even without a split", async () => {
    // No fee/total fields → GROSS = depositAmountInCents = 10001 (R$100.01) > cap.
    wallet = await makeWallet({
      json: {
        response: {
          withdrawalId: "w1",
          depositAddress: EULEN_LQ1,
          depositAmountInCents: 10001,
          payoutAmountInCents: 9800
        }
      }
    });
    await expect(wallet.withdraw({ ...BASE_PARAMS, amountCents: 10001 })).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "GUARDRAIL_PER_TX_LIMIT")
    );
  });

  it("single-output branch (no fee) passes the guardrail and reaches signing (INSUFFICIENT_FUNDS on empty wallet)", async () => {
    wallet = await makeWallet({
      json: {
        response: {
          withdrawalId: "w1",
          depositAddress: EULEN_LQ1,
          depositAmountInCents: 5000, // R$50, within both caps
          payoutAmountInCents: 4900
        }
      }
    });
    await expect(wallet.withdraw({ ...BASE_PARAMS, amountCents: 5000 })).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "INSUFFICIENT_FUNDS")
    );
    expect(await pendingCount()).toBe(0); // reached build then failed — record discarded
  });

  it("sandbox short-circuits BEFORE the fee/address checks (§3.2.0) — no on-chain leg, no FEE_ADDRESS_NOT_EXPLICIT", async () => {
    wallet = await makeWallet({
      json: {
        response: {
          withdrawalId: "sandbox_3uw_deadbeef",
          depositAddress: "SANDBOX-LIQUID-ADDRESS-DO-NOT-PAY",
          depositAmountInCents: 500,
          payoutAmountInCents: 490,
          fee_cents: 5,
          fee_address: "SANDBOX-LIQUID-FEE-ADDRESS-DO-NOT-PAY", // non-explicit placeholder
          sandbox: true
        }
      }
    });
    const res = await wallet.withdraw({ ...BASE_PARAMS, amountCents: 500 });
    expect(res.sandbox).toBe(true);
    expect(res.txid).toBeNull();
    expect(res.feeCents).toBe(5);
    expect(res.feeAddress).toBe("SANDBOX-LIQUID-FEE-ADDRESS-DO-NOT-PAY");
    expect(res.netCents).toBe(500);
    expect(res.grossCents).toBe(500);
    expect(await pendingCount()).toBe(0);
  });

  it("LIVE path persists 'signed' to disk BEFORE it broadcasts, then removes it (anti-double-pay ordering §3.2.9)", async () => {
    // The one safety-critical ordering the resume suite cannot cover: in the LIVE
    // withdraw path the signed bytes must be persisted (markSigned → state
    // "signed") BEFORE processWithdrawResponse calls broadcastRawTx. Reaching the
    // real LWK build+sign needs on-chain funds, so we seam buildSignPersistWithdraw
    // to run the SAME persist the production code does (store.markSigned) and hand
    // back a known signed hex; the broadcast seam then reads pending-withdrawals.json
    // and asserts the record is already "signed" with those exact bytes at the
    // moment of broadcast.
    // Holder so the broadcast seam (captured by restore() below) can read the
    // store that is only constructible AFTER restore() writes wallet.json's salt.
    const seam: { store?: PendingWithdrawals } = {};
    const broadcasts: string[] = [];
    let atBroadcast: Array<{ state: string; signedTxHex?: string }> | null = null;
    const { fetch } = mockFetch([
      {
        json: {
          response: {
            withdrawalId: "w-live",
            depositAddress: EULEN_LQ1,
            depositAmountInCents: 5000, // R$50 — within both caps, single-output (no split)
            payoutAmountInCents: 4900
          }
        }
      }
    ]);
    wallet = await DepixWallet.restore({
      dataDir,
      passphrase: PASSPHRASE,
      mnemonic: KNOWN_MNEMONIC,
      apiKey: "sk_live_flowtest",
      fetch,
      sync: {
        worker: false,
        clientFactory: () => ({
          fullScan: async () => undefined,
          broadcast: async () => {
            throw new Error("live withdraw must broadcast via broadcastTx, not the PSET path");
          },
          broadcastTx: async (tx) => {
            broadcasts.push(tx.toString());
            // Snapshot the on-disk record AT the moment of broadcast.
            const { records } = await seam.store!.readAll();
            atBroadcast = records.map((r) => ({ state: r.state, signedTxHex: r.signedTxHex }));
            return FIXTURE_TXID;
          },
          free: () => {}
        })
      }
    });
    seam.store = new PendingWithdrawals({
      dataDir,
      passphrase: PASSPHRASE,
      saltB64: await saltOf(dataDir)
    });
    // Seam the funds-dependent build+sign: persist "signed" exactly as the real
    // buildSignPersistWithdraw does (store.markSigned), then return the bytes.
    (
      wallet as unknown as {
        buildSignPersistWithdraw: (norm: unknown, idempotencyKey: string) => Promise<string>;
      }
    ).buildSignPersistWithdraw = async (_norm, idempotencyKey) => {
      await seam.store!.markSigned(idempotencyKey, {
        withdrawalId: "w-live",
        signedTxHex: FIXTURE_HEX,
        txid: FIXTURE_TXID
      });
      return FIXTURE_HEX;
    };

    const res = await wallet.withdraw({ ...BASE_PARAMS, amountCents: 5000 });

    // The persisted bytes were broadcast...
    expect(broadcasts).toEqual([FIXTURE_HEX]);
    // ...and at that instant the on-disk record was ALREADY "signed" with them
    // (persist-before-broadcast proven on the live path, not only on resume).
    expect(atBroadcast).toEqual([{ state: "signed", signedTxHex: FIXTURE_HEX }]);
    // ...then the record is removed after the broadcast returns (persist→broadcast→remove).
    expect(await pendingCount()).toBe(0);
    expect(res.txid).toBe(FIXTURE_TXID);
  });

  it("keeps the 'requested' record when the POST fails transiently (409) — for an idempotent resume re-POST (§3.2.9)", async () => {
    // A non-in-flight 409 is NOT retried by the client and is classified
    // TRANSIENT: the withdrawal may exist server-side, so the record is KEPT so a
    // later open() can replay the SAME Idempotency-Key. Nothing is signed → safe.
    wallet = await makeWallet({
      status: 409,
      json: { error: { code: "withdrawal_conflict", message: "conflict" } }
    });
    await expect(wallet.withdraw({ ...BASE_PARAMS, amountCents: 500 })).rejects.toSatisfy(
      (err: unknown) => isDepixSdkError(err, "withdrawal_conflict")
    );
    expect(await pendingCount()).toBe(1); // KEPT for resume replay
  });

  it("discards the 'requested' record on a DEFINITIVE 4xx POST rejection (nothing was created)", async () => {
    wallet = await makeWallet({
      status: 400,
      json: { error: { code: "validation_error", message: "bad pixKey", details: { field: "pixKey" } } }
    });
    await expect(wallet.withdraw({ ...BASE_PARAMS, amountCents: 500 })).rejects.toSatisfy(
      (err: unknown) => isDepixSdkError(err, "validation_error")
    );
    expect(await pendingCount()).toBe(0); // definitively rejected → dropped
  });
});
