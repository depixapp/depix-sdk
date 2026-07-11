// wallet.advanced.{listUtxos,selectCoins,sendMany} (PR-E) — LOW-LEVEL wallet
// primitives, done safe:
//   listUtxos()   — READ-ONLY view of the wallet's UTXOs. Moves nothing.
//   selectCoins() — READ-ONLY greedy coin-selection helper. Moves nothing.
//   sendMany()    — multi-output send that crosses the SAME §4.3 guardrail
//                   choke point as send(), on the TOTAL BRL value of ALL
//                   outputs (summed per asset), with EVERY destination checked
//                   against the allowlist, under the same opMutex, with the
//                   same recordSpend. There is NO path around the guardrail.
// buildPset/signPset are deliberately NOT exposed (footgun: a signed PSET is
// broadcastable anywhere, bypassing the choke point) — asserted below.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DepixWallet, planSendMany, selectCoinsGreedy, type WalletUtxo } from "../src/wallet.js";
import { GUARDRAILS_STATE_FILE } from "../src/guardrails/guardrails.js";
import type { QuotesSource } from "../src/guardrails/quotes.js";
import type { EsploraClientLike } from "../src/sync/sync.js";
import { isDepixSdkError, type GuardrailError } from "../src/errors.js";

const PASSPHRASE = "correct-horse-battery-staple";
const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// Golden addr[1] / addr[0] of the known mnemonic (same as send.test.ts).
const VALID_ADDRESS =
  "lq1qqfk0uw9vlmqlggzs7cxmw49x8ks37l87udspmpt3ssgxjrkqqlww63xvus3c5gaz89r2kd393c4fvurwxf06qj87y2kd3vsln";
const OTHER_ADDRESS =
  "lq1qqvxk052kf3qtkxmrakx50a9gc3smqad2ync54hzntjt980kfej9kkfe0247rp5h4yzmdftsahhw64uy8pzfe7cpg4fgykm7cv";

// 1 BRL cent = 10^6 DePix sats (8 decimals, 1:1 peg).
const SATS_PER_CENT = 1_000_000n;
const NO_QUOTES: QuotesSource = { get: async () => null };

/** Fake Esplora client that counts (and refuses) broadcasts — the "zero
 *  broadcast" observable for guardrail-block tests. */
function spyEsplora(): { client: EsploraClientLike; calls: { broadcast: number } } {
  const calls = { broadcast: 0 };
  const client: EsploraClientLike = {
    fullScan: async () => undefined,
    broadcast: async () => {
      calls.broadcast++;
      throw new Error("broadcast must never be reached in these offline tests");
    }
  };
  return { client, calls };
}

/** Assert a synchronous call throws the given typed SDK error code. */
function expectThrowsCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(isDepixSdkError(err, code)).toBe(true);
    return;
  }
  expect.unreachable(`expected a ${code} error`);
}

let dataDir: string;
let wallet: DepixWallet;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-adv-prim-"));
});
afterEach(async () => {
  await wallet?.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
});

interface RestoreExtras {
  quotes?: QuotesSource;
  guardrails?: Parameters<typeof DepixWallet.restore>[0]["guardrails"];
  client?: EsploraClientLike;
}

async function restore(extras: RestoreExtras = {}): Promise<DepixWallet> {
  return DepixWallet.restore({
    dataDir,
    passphrase: PASSPHRASE,
    mnemonic: KNOWN_MNEMONIC,
    quotes: extras.quotes ?? NO_QUOTES,
    ...(extras.guardrails ? { guardrails: extras.guardrails } : {}),
    ...(extras.client ? { sync: { clientFactory: () => extras.client! } } : {})
  });
}

// ─── namespace shape ─────────────────────────────────────────────────────────

describe("wallet.advanced primitive surface (PR-E)", () => {
  it("exposes listUtxos/selectCoins/sendMany as functions", async () => {
    wallet = await restore();
    expect(typeof wallet.advanced.listUtxos).toBe("function");
    expect(typeof wallet.advanced.selectCoins).toBe("function");
    expect(typeof wallet.advanced.sendMany).toBe("function");
  });

  it("keeps the namespace non-enumerable (spread/serialize never trips the boltz gate)", async () => {
    wallet = await restore();
    expect(Object.keys(wallet.advanced)).toEqual([]);
    expect(() => ({ ...wallet.advanced })).not.toThrow();
  });

  it("does NOT expose raw PSET primitives (buildPset/signPset/broadcastPset) — footgun cut", async () => {
    wallet = await restore();
    const ns = wallet.advanced as unknown as Record<string, unknown>;
    expect(ns.buildPset).toBeUndefined();
    expect(ns.signPset).toBeUndefined();
    expect(ns.broadcastPset).toBeUndefined();
    expect(ns.broadcast).toBeUndefined();
  });
});

// ─── listUtxos (read-only) ───────────────────────────────────────────────────

describe("advanced.listUtxos() — read-only", () => {
  it("returns [] on an empty wallet and creates no guardrail state (nothing recorded)", async () => {
    const { client, calls } = spyEsplora();
    wallet = await restore({ client });
    await expect(wallet.advanced.listUtxos()).resolves.toEqual([]);
    // Read-only proof: no broadcast, no guardrail accounting.
    expect(calls.broadcast).toBe(0);
    await expect(readFile(join(dataDir, GUARDRAILS_STATE_FILE))).rejects.toThrow();
  });

  it("fails fast on a closed wallet with WALLET_NOT_FOUND", async () => {
    wallet = await restore();
    await wallet.close();
    await expect(wallet.advanced.listUtxos()).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "WALLET_NOT_FOUND")
    );
  });
});

// ─── selectCoins (read-only) ─────────────────────────────────────────────────

function utxo(amountSats: bigint, height: number | null, txid: string): WalletUtxo {
  return {
    asset: "DEPIX",
    amountSats,
    outpoint: { txid, vout: 0 },
    address: VALID_ADDRESS,
    height,
    confirmations: height === null ? 0 : 1
  };
}

describe("selectCoinsGreedy — pure selection logic", () => {
  it("picks confirmed UTXOs first, largest-first, stopping once the target is covered", () => {
    const utxos = [
      utxo(100n, null, "unconfirmed-big"),
      utxo(10n, 100, "conf-small"),
      utxo(80n, 90, "conf-big"),
      utxo(30n, 95, "conf-mid")
    ];
    const { selected, totalSats } = selectCoinsGreedy(utxos, 100n);
    // Confirmed 80 + 30 covers 100 — the bigger unconfirmed 100 is NOT preferred.
    expect(selected.map((u) => u.outpoint.txid)).toEqual(["conf-big", "conf-mid"]);
    expect(totalSats).toBe(110n);
  });

  it("falls back to unconfirmed UTXOs only when confirmed coins cannot cover", () => {
    const utxos = [utxo(100n, null, "unconf"), utxo(80n, 90, "conf")];
    const { selected, totalSats } = selectCoinsGreedy(utxos, 150n);
    expect(selected.map((u) => u.outpoint.txid)).toEqual(["conf", "unconf"]);
    expect(totalSats).toBe(180n);
  });

  it("covers an exact-match target with zero change", () => {
    const { selected, totalSats } = selectCoinsGreedy([utxo(60n, 1, "a"), utxo(40n, 2, "b")], 100n);
    expect(totalSats).toBe(100n);
    expect(selected).toHaveLength(2);
  });

  it("returns everything (short of the target) when the coins cannot cover", () => {
    const { selected, totalSats } = selectCoinsGreedy([utxo(5n, 1, "a"), utxo(3n, 2, "b")], 100n);
    expect(selected).toHaveLength(2);
    expect(totalSats).toBe(8n);
  });
});

describe("advanced.selectCoins() — read-only wallet helper", () => {
  it("rejects unknown assets with UNSUPPORTED_ASSET", async () => {
    wallet = await restore();
    await expect(
      wallet.advanced.selectCoins({ asset: "DOGE" as never, targetSats: 1n })
    ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "UNSUPPORTED_ASSET"));
  });

  it("rejects non-positive / non-bigint targets with INVALID_AMOUNT", async () => {
    wallet = await restore();
    for (const target of [0n, -5n, 100 as unknown as bigint]) {
      await expect(
        wallet.advanced.selectCoins({ asset: "DEPIX", targetSats: target })
      ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "INVALID_AMOUNT"));
    }
  });

  it("throws INSUFFICIENT_FUNDS on an empty wallet — and never touches the network", async () => {
    const { client, calls } = spyEsplora();
    wallet = await restore({ client });
    await expect(
      wallet.advanced.selectCoins({ asset: "DEPIX", targetSats: 1_000n })
    ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "INSUFFICIENT_FUNDS"));
    expect(calls.broadcast).toBe(0);
    await expect(readFile(join(dataDir, GUARDRAILS_STATE_FILE))).rejects.toThrow();
  });
});

// ─── planSendMany (pure output planning) ─────────────────────────────────────

describe("planSendMany — builds the N outputs and the per-asset totals", () => {
  it("preserves recipient order, flags the L-BTC outputs, sums totals per asset", () => {
    const plan = planSendMany([
      { asset: "DEPIX", amountSats: 1n, address: VALID_ADDRESS },
      { asset: "LBTC", amountSats: 2n, address: OTHER_ADDRESS },
      { asset: "USDT", amountSats: 3n, address: VALID_ADDRESS },
      { asset: "DEPIX", amountSats: 4n, address: OTHER_ADDRESS }
    ]);
    expect(plan.outputs).toHaveLength(4);
    expect(plan.outputs.map((o) => o.assetKey)).toEqual(["DEPIX", "LBTC", "USDT", "DEPIX"]);
    expect(plan.outputs.map((o) => o.lbtc)).toEqual([false, true, false, false]);
    expect(plan.outputs.map((o) => o.amountSats)).toEqual([1n, 2n, 3n, 4n]);
    expect(plan.outputs.map((o) => o.address)).toEqual([
      VALID_ADDRESS,
      OTHER_ADDRESS,
      VALID_ADDRESS,
      OTHER_ADDRESS
    ]);
    // Per-asset totals — what the guardrail values in BRL (the invariant).
    expect(plan.totalsByAsset.get("DEPIX")).toBe(5n);
    expect(plan.totalsByAsset.get("LBTC")).toBe(2n);
    expect(plan.totalsByAsset.get("USDT")).toBe(3n);
  });

  it("rejects an empty / non-array recipients list with INVALID_ARGUMENT", () => {
    for (const bad of [[], undefined, null, "x"]) {
      expectThrowsCode(() => planSendMany(bad as never), "INVALID_ARGUMENT");
    }
  });

  it("rejects unknown assets with UNSUPPORTED_ASSET", () => {
    expectThrowsCode(
      () => planSendMany([{ asset: "DOGE" as never, amountSats: 1n, address: VALID_ADDRESS }]),
      "UNSUPPORTED_ASSET"
    );
  });

  it("rejects non-positive / non-bigint amounts with INVALID_AMOUNT", () => {
    for (const amount of [0n, -1n, 7 as unknown as bigint]) {
      expectThrowsCode(
        () => planSendMany([{ asset: "DEPIX", amountSats: amount, address: VALID_ADDRESS }]),
        "INVALID_AMOUNT"
      );
    }
  });

  it("rejects a missing/empty address with INVALID_ADDRESS", () => {
    for (const address of ["", "   ", 42 as unknown as string]) {
      expectThrowsCode(
        () => planSendMany([{ asset: "DEPIX", amountSats: 1n, address }]),
        "INVALID_ADDRESS"
      );
    }
  });
});

// ─── sendMany — the guardrail invariant (§4.3 on the TOTAL) ──────────────────

describe("advanced.sendMany() — guardrail choke point on the TOTAL, before signing", () => {
  it("blocks two R$60 outputs (each under the R$100 per-tx cap) because the TOTAL is R$120 — zero broadcast, nothing recorded", async () => {
    const { client, calls } = spyEsplora();
    wallet = await restore({ client });
    await expect(
      wallet.advanced.sendMany({
        recipients: [
          { asset: "DEPIX", amountSats: 6_000n * SATS_PER_CENT, address: VALID_ADDRESS },
          { asset: "DEPIX", amountSats: 6_000n * SATS_PER_CENT, address: OTHER_ADDRESS }
        ]
      })
    ).rejects.toSatisfy((err: unknown) => {
      if (!isDepixSdkError(err, "GUARDRAIL_PER_TX_LIMIT")) return false;
      // The blocked amount is the aggregated TOTAL (12_000 cents), not a
      // single output — proving sendMany cannot slice under the cap.
      return (err as GuardrailError).details?.attemptedCents === 12_000;
    });
    // Blocked BEFORE signing: no broadcast reached the client, and nothing was
    // accounted (recordSpend runs only after a signature).
    expect(calls.broadcast).toBe(0);
    await expect(readFile(join(dataDir, GUARDRAILS_STATE_FILE))).rejects.toThrow();
  });

  it("aggregates ACROSS assets: DePix R$50 + L-BTC R$50,50 = R$100,50 total is blocked per-tx", async () => {
    const { client, calls } = spyEsplora();
    wallet = await restore({
      client,
      quotes: { get: async () => ({ btcUsd: 100_000, usdBrl: 5 }) }
    });
    await expect(
      wallet.advanced.sendMany({
        recipients: [
          { asset: "DEPIX", amountSats: 5_000n * SATS_PER_CENT, address: VALID_ADDRESS },
          // 10_100 sats × 100_000 × 5 = R$50,50
          { asset: "LBTC", amountSats: 10_100n, address: OTHER_ADDRESS }
        ]
      })
    ).rejects.toSatisfy((err: unknown) => {
      if (!isDepixSdkError(err, "GUARDRAIL_PER_TX_LIMIT")) return false;
      return (err as GuardrailError).details?.attemptedCents === 10_050;
    });
    expect(calls.broadcast).toBe(0);
    await expect(readFile(join(dataDir, GUARDRAILS_STATE_FILE))).rejects.toThrow();
  });

  it("a cross-asset total EXACTLY at the cap passes the guardrail (then INSUFFICIENT_FUNDS on the empty wallet)", async () => {
    wallet = await restore({ quotes: { get: async () => ({ btcUsd: 100_000, usdBrl: 5 }) } });
    await expect(
      wallet.advanced.sendMany({
        recipients: [
          { asset: "DEPIX", amountSats: 5_000n * SATS_PER_CENT, address: VALID_ADDRESS },
          // 10_000 sats × 100_000 × 5 = R$50,00 → total R$100,00 == cap.
          { asset: "LBTC", amountSats: 10_000n, address: OTHER_ADDRESS }
        ]
      })
    ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "INSUFFICIENT_FUNDS"));
  });

  it("enforces the DAILY cap on the total (per-tx raised via config)", async () => {
    const { client, calls } = spyEsplora();
    wallet = await restore({
      client,
      guardrails: { perTxLimitBrlCents: 1_000_000, dailyLimitBrlCents: 20_000 }
    });
    await expect(
      wallet.advanced.sendMany({
        recipients: [
          { asset: "DEPIX", amountSats: 7_000n * SATS_PER_CENT, address: VALID_ADDRESS },
          { asset: "DEPIX", amountSats: 7_000n * SATS_PER_CENT, address: OTHER_ADDRESS },
          { asset: "DEPIX", amountSats: 7_000n * SATS_PER_CENT, address: VALID_ADDRESS }
        ]
      })
    ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "GUARDRAIL_DAILY_LIMIT"));
    expect(calls.broadcast).toBe(0);
    await expect(readFile(join(dataDir, GUARDRAILS_STATE_FILE))).rejects.toThrow();
  });

  it("fails CLOSED with QUOTES_UNAVAILABLE when a non-DePix output cannot be valued", async () => {
    const { client, calls } = spyEsplora();
    wallet = await restore({ client }); // NO_QUOTES
    await expect(
      wallet.advanced.sendMany({
        recipients: [
          { asset: "DEPIX", amountSats: 1_000n * SATS_PER_CENT, address: VALID_ADDRESS },
          { asset: "LBTC", amountSats: 1_000n, address: OTHER_ADDRESS }
        ]
      })
    ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "QUOTES_UNAVAILABLE"));
    expect(calls.broadcast).toBe(0);
  });

  it("checks EVERY destination against the allowlist — one bad recipient blocks the whole tx", async () => {
    const { client, calls } = spyEsplora();
    wallet = await restore({
      client,
      guardrails: { allowlist: { enabled: true, liquidAddresses: [VALID_ADDRESS] } }
    });
    await expect(
      wallet.advanced.sendMany({
        recipients: [
          { asset: "DEPIX", amountSats: 1_000n * SATS_PER_CENT, address: VALID_ADDRESS },
          { asset: "DEPIX", amountSats: 1_000n * SATS_PER_CENT, address: OTHER_ADDRESS }
        ]
      })
    ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "GUARDRAIL_ALLOWLIST_BLOCKED"));
    expect(calls.broadcast).toBe(0);
    await expect(readFile(join(dataDir, GUARDRAILS_STATE_FILE))).rejects.toThrow();
  });

  it("passes the allowlist when ALL destinations are listed (then INSUFFICIENT_FUNDS)", async () => {
    wallet = await restore({
      guardrails: { allowlist: { enabled: true, liquidAddresses: [VALID_ADDRESS] } }
    });
    await expect(
      wallet.advanced.sendMany({
        recipients: [
          { asset: "DEPIX", amountSats: 1_000n * SATS_PER_CENT, address: VALID_ADDRESS },
          { asset: "DEPIX", amountSats: 1_000n * SATS_PER_CENT, address: VALID_ADDRESS }
        ]
      })
    ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "INSUFFICIENT_FUNDS"));
  });
});

// ─── sendMany — validation + funds + serialization ───────────────────────────

describe("advanced.sendMany() — validation and funds", () => {
  it("rejects an empty recipients list with INVALID_ARGUMENT", async () => {
    wallet = await restore();
    await expect(wallet.advanced.sendMany({ recipients: [] })).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "INVALID_ARGUMENT")
    );
  });

  it("rejects an unparseable address with INVALID_ADDRESS (before any network/signing)", async () => {
    const { client, calls } = spyEsplora();
    wallet = await restore({ client });
    await expect(
      wallet.advanced.sendMany({
        recipients: [
          { asset: "DEPIX", amountSats: 1_000n * SATS_PER_CENT, address: VALID_ADDRESS },
          { asset: "DEPIX", amountSats: 1_000n * SATS_PER_CENT, address: "not-an-address" }
        ]
      })
    ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "INVALID_ADDRESS"));
    expect(calls.broadcast).toBe(0);
  });

  it("multi-output within the caps on an EMPTY wallet → INSUFFICIENT_FUNDS after the guardrail, zero broadcast", async () => {
    const { client, calls } = spyEsplora();
    wallet = await restore({ client });
    await expect(
      wallet.advanced.sendMany({
        recipients: [
          { asset: "DEPIX", amountSats: 2_000n * SATS_PER_CENT, address: VALID_ADDRESS },
          { asset: "DEPIX", amountSats: 2_000n * SATS_PER_CENT, address: OTHER_ADDRESS },
          { asset: "DEPIX", amountSats: 2_000n * SATS_PER_CENT, address: VALID_ADDRESS }
        ]
      })
    ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "INSUFFICIENT_FUNDS"));
    expect(calls.broadcast).toBe(0);
    // Failed at BUILD (pre-sign) → nothing was accounted either.
    await expect(readFile(join(dataDir, GUARDRAILS_STATE_FILE))).rejects.toThrow();
  });

  it("fails fast on a closed wallet with WALLET_NOT_FOUND", async () => {
    wallet = await restore();
    await wallet.close();
    await expect(
      wallet.advanced.sendMany({
        recipients: [{ asset: "DEPIX", amountSats: 1n, address: VALID_ADDRESS }]
      })
    ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "WALLET_NOT_FOUND"));
  });

  it("parallel sendMany calls are serialized under the op mutex and each releases on error", async () => {
    wallet = await restore();
    const recipients = [
      { asset: "DEPIX" as const, amountSats: 2_000n * SATS_PER_CENT, address: VALID_ADDRESS },
      { asset: "DEPIX" as const, amountSats: 2_000n * SATS_PER_CENT, address: OTHER_ADDRESS }
    ];
    const results = await Promise.allSettled([
      wallet.advanced.sendMany({ recipients }),
      wallet.advanced.sendMany({ recipients }),
      wallet.advanced.sendMany({ recipients })
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    for (const r of results) {
      expect(
        isDepixSdkError((r as PromiseRejectedResult).reason, "INSUFFICIENT_FUNDS")
      ).toBe(true);
    }
  });
});
