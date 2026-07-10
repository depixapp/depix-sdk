// withdraw() contract (spec §3.2) — pure helpers + end-to-end through the
// wallet with a mocked API and a real (empty) LWK wallet. No real broadcast.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASSETS } from "../src/assets.js";
import { Address } from "../src/engine/lwk.js";
import { DepixWallet } from "../src/wallet.js";
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
});
