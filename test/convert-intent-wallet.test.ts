// wallet.convert()/wallet.quote() wired through the REAL DepixWallet (PR-B):
// the callable facade coexists with the advanced sub-namespaces, and a
// single-hop convert() goes through the SAME guardrail choke point (§4.3) as
// the provider methods it delegates to — the intent layer adds no signing
// path of its own. Offline: guardrails reject before any WebSocket, and
// estimates fail soft (null) on an empty wallet.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DepixWallet } from "../src/wallet.js";
import type { QuotesSource } from "../src/guardrails/quotes.js";
import { isDepixSdkError } from "../src/errors.js";
import { FakeSideSwapClient } from "./support/sideswap-mock.js";

const PASSPHRASE = "correct-horse-battery-staple";
const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const QUOTES: QuotesSource = { get: async () => ({ btcUsd: 100_000, usdBrl: 5 }) };
const BTC_DEST = "bc1qdestination000000000000000000000000000";

let dataDir: string;
let wallet: DepixWallet;

async function open(opts: Parameters<typeof DepixWallet.restore>[0]) {
  return DepixWallet.restore(opts);
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-intent-"));
});
afterEach(async () => {
  await wallet?.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
});

describe("wallet.convert is callable AND keeps the advanced sub-namespaces", () => {
  it("exposes convert() as a function with .sideswap/.sideshift/.boltz intact, plus wallet.quote()", async () => {
    wallet = await open({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC, quotes: QUOTES });
    expect(typeof wallet.convert).toBe("function");
    expect(typeof wallet.convert.sideswap.quote).toBe("function");
    expect(typeof wallet.convert.sideswap.pegOut).toBe("function");
    expect(typeof wallet.convert.sideshift.send).toBe("function");
    expect(typeof wallet.convert.boltz.payLightningInvoice).toBe("function");
    expect(typeof wallet.quote).toBe("function");
  });
});

describe("wallet.convert() asserts the wallet is open at the facade boundary (parity with quote())", () => {
  it("convert() on a closed wallet rejects WALLET_NOT_FOUND, like quote()", async () => {
    wallet = await open({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC, quotes: QUOTES });
    await wallet.close();
    await expect(
      wallet.convert({ from: "DEPIX", to: "LBTC", network: "liquid", amount: 1_000n })
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "WALLET_NOT_FOUND"));
    await expect(
      wallet.quote({ from: "DEPIX", to: "LBTC", network: "liquid", amount: 1_000n })
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "WALLET_NOT_FOUND"));
  });
});

describe("wallet.convert() respects the guardrail choke point (§4.3) — never bypassed", () => {
  it("a peg-out route is blocked by the allowlist BEFORE any WebSocket", async () => {
    const client = new FakeSideSwapClient();
    wallet = await open({
      dataDir,
      passphrase: PASSPHRASE,
      mnemonic: KNOWN_MNEMONIC,
      quotes: QUOTES,
      guardrails: { allowlist: { enabled: true, btcAddresses: [] } },
      convert: { clientFactory: () => client }
    });
    await expect(
      wallet.convert({ from: "LBTC", to: "BTC", network: "bitcoin", amount: 10_000n, address: BTC_DEST })
    ).rejects.toSatisfy(
      (e) =>
        isDepixSdkError(e, "GUARDRAIL_ALLOWLIST_BLOCKED") &&
        (e as { details?: { class?: string } }).details?.class === "btcAddress"
    );
    expect(client.pegOutCalls).toHaveLength(0);
    expect(client.connectCount).toBe(0);
  });

  it("a peg-out route over the per-tx BRL ceiling is blocked BEFORE any WebSocket", async () => {
    const client = new FakeSideSwapClient();
    wallet = await open({
      dataDir,
      passphrase: PASSPHRASE,
      mnemonic: KNOWN_MNEMONIC,
      quotes: QUOTES,
      convert: { clientFactory: () => client }
    });
    // 0.1 BTC × $100k × R$5 = R$50_000 — far over the default per-tx cap.
    await expect(
      wallet.convert({ from: "LBTC", to: "BTC", network: "bitcoin", amount: 10_000_000n, address: BTC_DEST })
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "GUARDRAIL_PER_TX_LIMIT"));
    expect(client.connectCount).toBe(0);
  });
});

describe("wallet.quote() — full enumeration on a real wallet", () => {
  it("DEPIX → USDT @ethereum returns both candidate routes; estimates fail SOFT on an empty wallet", async () => {
    const client = new FakeSideSwapClient();
    wallet = await open({
      dataDir,
      passphrase: PASSPHRASE,
      mnemonic: KNOWN_MNEMONIC,
      quotes: QUOTES,
      convert: { clientFactory: () => client }
    });
    const routes = await wallet.quote({ from: "DEPIX", to: "USDT", network: "ethereum", amount: 100_000_000n });
    expect(routes.map((r) => r.id)).toEqual([
      "sideswap.swap:DEPIX@liquid>LBTC@liquid+boltz.toStablecoin:LBTC@liquid>USDT@ethereum",
      "sideswap.swap:DEPIX@liquid>USDT@liquid+sideshift.send:USDT@liquid>USDT@ethereum"
    ]);
    expect(routes[0]!.custodial).toBe(false);
    expect(routes[1]!.custodial).toBe(true);
    // Empty wallet → the market leg cannot be estimated (INSUFFICIENT_FUNDS is
    // caught) → estimates are null and flagged, but enumeration still works.
    for (const route of routes) {
      expect(route.estimatedReceivedSats).toBe(null);
      expect(route.estimateComplete).toBe(false);
      expect(route.notes.length).toBeGreaterThan(0);
    }
    // The failed estimate never opened a socket (the UTXO check fails first).
    expect(client.connectCount).toBe(0);
  });

  it("wallet.convert() on an ambiguous intent throws MULTIPLE_ROUTES_AVAILABLE with the candidates", async () => {
    wallet = await open({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC, quotes: QUOTES });
    await expect(
      wallet.convert({ from: "DEPIX", to: "USDT", network: "ethereum", amount: 100_000_000n })
    ).rejects.toSatisfy((e) => {
      if (!isDepixSdkError(e, "MULTIPLE_ROUTES_AVAILABLE")) return false;
      const details = (e as { details?: { routes?: unknown[]; nextStep?: string } }).details;
      return Array.isArray(details?.routes) && details.routes.length === 2 && typeof details.nextStep === "string";
    });
  });
});

// ─── PR-C: multi-hop count-once through the REAL wallet hooks ─────────────────
//
// The value ceilings are skipped ONLY for a leg running inside the
// plan-continuation context whose plan AUTHENTICATES in the wallet's encrypted
// plan store. Everything else — a direct call, a forged planId — gets the full
// choke point; the allowlist applies even to legitimate continuations.

import { readFile, writeFile } from "node:fs/promises";
import { base64 } from "@scure/base";
import { runAsPlanContinuation } from "../src/convert/continuation.js";
import { ConversionPlanStore, type StoredConversionPlan } from "../src/convert/plan-store.js";
import { enumerateRoutes } from "../src/convert/routes.js";
import type { FetchLike, FetchResponseLike } from "../src/api/client.js";

const EVM_ADDR = "0x" + "a".repeat(40);
const SIDESHIFT_ROUTE = enumerateRoutes({ from: "DEPIX", to: "USDT", network: "ethereum" }).find((r) =>
  r.id.includes("sideshift.send")
)!;

/** Fake SideShift REST routed by path (mirrors sideshift-namespace.test.ts). */
function fakeSideshiftFetch(): { fetchImpl: FetchLike } {
  const fetchImpl: FetchLike = async (url) => {
    let body: Record<string, unknown> = {};
    if (url.endsWith("/quotes")) body = { id: "q1", rate: "0.99", settleAmount: "19.8" };
    else if (url.endsWith("/shifts/fixed"))
      body = { id: "SHIFT_W1", depositAddress: "lq1qdeposit", depositAmount: "20", settleAmount: "19.8", status: "waiting" };
    else if (url.includes("/shifts/")) body = { id: "SHIFT_W1", status: "settled", settleAmount: "19.8", depositAmount: "20" };
    const res: FetchResponseLike = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body)
    };
    return res;
  };
  return { fetchImpl };
}

/** Open the wallet's OWN plan store from disk (same dataDir/passphrase/salt). */
async function planStoreOf(dir: string): Promise<ConversionPlanStore> {
  const walletFile = JSON.parse(await readFile(join(dir, "wallet.json"), "utf8")) as { salt: string };
  return new ConversionPlanStore({ dataDir: dir, passphrase: PASSPHRASE, saltB64: walletFile.salt });
}

async function seedWalletPlan(dir: string, over: Partial<StoredConversionPlan> = {}): Promise<ConversionPlanStore> {
  const store = await planStoreOf(dir);
  await store.put({
    planId: "plan-wallet-1",
    intent: { from: "DEPIX", to: "USDT", network: "ethereum", amountSats: 100_000_000n },
    route: SIDESHIFT_ROUTE,
    params: { address: EVM_ADDR },
    currentLegIndex: 1, // the continuation leg — leg 1 (index 0) already counted the value
    legResults: [{ state: "settled", txids: ["swap_txid"], receivedSats: 2_000_000_000n, trackingId: null }],
    state: "pending",
    createdAt: 1,
    ...over
  });
  return store;
}

describe("multi-hop count-once (§4.3) — the wallet's guardrail hooks", () => {
  const SEND = {
    network: "ethereum",
    amountSats: 2_000_000_000n, // 20 USDt ≈ R$100 under the fixed quotes
    settleAddress: EVM_ADDR
  };

  function walletOpts(extra: Record<string, unknown> = {}) {
    const { fetchImpl } = fakeSideshiftFetch();
    const sendUsdtCalls: Array<{ depositAddress: string; amountSats: bigint; brlCents: number }> = [];
    const opts = {
      dataDir,
      passphrase: PASSPHRASE,
      mnemonic: KNOWN_MNEMONIC,
      quotes: QUOTES,
      guardrails: { perTxLimitBrlCents: 5_000, dailyLimitBrlCents: 5_000 }, // R$50 — the R$100 send busts it
      convert: {
        sideshift: {
          fetchImpl,
          affiliateId: "test-affiliate",
          sendUsdt: async (p: { depositAddress: string; amountSats: bigint; brlCents: number }) => {
            sendUsdtCalls.push(p);
            return { txid: "usdt_send_txid" };
          }
        }
      },
      ...extra
    };
    return { opts, sendUsdtCalls };
  }

  it("a DIRECT send over the caps is blocked (GUARDRAIL_PER_TX_LIMIT) — no bypass without a plan", async () => {
    const { opts, sendUsdtCalls } = walletOpts();
    wallet = await open(opts as Parameters<typeof open>[0]);
    await expect(wallet.convert.sideshift.send(SEND)).rejects.toSatisfy((e) =>
      isDepixSdkError(e, "GUARDRAIL_PER_TX_LIMIT")
    );
    expect(sendUsdtCalls).toHaveLength(0);
  });

  it("the SAME send as an authenticated plan continuation skips ONLY the value ceilings and executes", async () => {
    const { opts, sendUsdtCalls } = walletOpts();
    wallet = await open(opts as Parameters<typeof open>[0]);
    await seedWalletPlan(dataDir);
    const result = await runAsPlanContinuation("plan-wallet-1", () => wallet.convert.sideshift.send(SEND));
    expect(result.shiftId).toBe("SHIFT_W1");
    expect(sendUsdtCalls).toHaveLength(1);
    // The continuation recorded NOTHING extra: the window still has room —
    // count-once means the R$100 leg-2 value never re-entered the accounting.
    const usage = await wallet.getGuardrails();
    expect(usage.usedCents).toBe(0);
  });

  it("a FORGED planId does not bypass anything (fail closed to full enforcement)", async () => {
    const { opts, sendUsdtCalls } = walletOpts();
    wallet = await open(opts as Parameters<typeof open>[0]);
    // No such plan in the store.
    await expect(
      runAsPlanContinuation("plan-forged", () => wallet.convert.sideshift.send(SEND))
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "GUARDRAIL_PER_TX_LIMIT"));
    expect(sendUsdtCalls).toHaveLength(0);
  });

  it("an EXISTING plan whose record fails GCM authentication (forged ciphertext) never authorizes the skip", async () => {
    // Distinct from the forged-planId case (get() returns null): here the record
    // EXISTS but decryption throws PLAN_VALIDATION_FAILED — the catch{} inside
    // the wallet's isAuthorizedPlanContinuation must map that to "not
    // authorized" (fail closed to the FULL choke point), never rethrow into the
    // money path and never skip the ceilings over tampered data.
    const { opts, sendUsdtCalls } = walletOpts();
    wallet = await open(opts as Parameters<typeof open>[0]);
    await seedWalletPlan(dataDir); // a VALID continuation-authorizing plan…
    const path = join(dataDir, "conversion-plans.json");
    const file = JSON.parse(await readFile(path, "utf8")) as { records: Array<{ id: string; ct: string }> };
    expect(file.records.map((r) => r.id)).toEqual(["plan-wallet-1"]); // …that we now corrupt in place
    const ct = Uint8Array.from(base64.decode(file.records[0]!.ct));
    ct[0] = ct[0]! ^ 0xff;
    file.records[0]!.ct = base64.encode(ct);
    await writeFile(path, JSON.stringify(file));

    await expect(
      runAsPlanContinuation("plan-wallet-1", () => wallet.convert.sideshift.send(SEND))
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "GUARDRAIL_PER_TX_LIMIT"));
    expect(sendUsdtCalls).toHaveLength(0);
  });

  it("a plan still ON its value leg does not authorize a skip (only legs PAST the first outflow leg)", async () => {
    const { opts, sendUsdtCalls } = walletOpts();
    wallet = await open(opts as Parameters<typeof open>[0]);
    await seedWalletPlan(dataDir, { currentLegIndex: 0, legResults: [] });
    await expect(
      runAsPlanContinuation("plan-wallet-1", () => wallet.convert.sideshift.send(SEND))
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "GUARDRAIL_PER_TX_LIMIT"));
    expect(sendUsdtCalls).toHaveLength(0);
  });

  it("the allowlist still gates a legitimate continuation leg's destination", async () => {
    const { opts, sendUsdtCalls } = walletOpts({
      guardrails: {
        perTxLimitBrlCents: 100_000,
        dailyLimitBrlCents: 100_000,
        allowlist: { enabled: true, evmAddresses: [] } // nothing allowed on EVM
      }
    });
    wallet = await open(opts as Parameters<typeof open>[0]);
    await seedWalletPlan(dataDir);
    await expect(
      runAsPlanContinuation("plan-wallet-1", () => wallet.convert.sideshift.send(SEND))
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "GUARDRAIL_ALLOWLIST_BLOCKED"));
    expect(sendUsdtCalls).toHaveLength(0);
  });
});

describe("multi-hop plans in wallet.getPending() and wallet.recover()", () => {
  it("getPending() lists an in-flight plan; recover() finalizes a settled exit leg and removes it", async () => {
    const { fetchImpl } = fakeSideshiftFetch();
    wallet = await open({
      dataDir,
      passphrase: PASSPHRASE,
      mnemonic: KNOWN_MNEMONIC,
      quotes: QUOTES,
      convert: { sideshift: { fetchImpl, affiliateId: "test-affiliate" } }
    });
    const store = await seedWalletPlan(dataDir, {
      currentLegIndex: 1,
      legResults: [
        { state: "settled", txids: ["swap_txid"], receivedSats: 2_000_000_000n, trackingId: null },
        { state: "pending", txids: ["usdt_send_txid"], receivedSats: null, trackingId: "SHIFT_W1" }
      ]
    });

    const pending = await wallet.getPending();
    const planItem = pending.find((i) => i.rail === "plan");
    expect(planItem).toMatchObject({
      rail: "plan",
      id: "plan-wallet-1",
      state: "pending",
      routeId: SIDESHIFT_ROUTE.id,
      hops: 2,
      currentLeg: 2
    });

    // recover(): the shift probes "settled" (fake REST) → the plan completes.
    const summary = await wallet.recover();
    expect(summary.plans.checked).toBe(1);
    expect(summary.plans.completed).toBe(1);
    expect(await store.count()).toBe(0);
    expect((await wallet.getPending()).filter((i) => i.rail === "plan")).toHaveLength(0);
  });

  it("TWO concurrent recover() calls drive a crash-between-legs plan's next leg EXACTLY ONCE (no double-spend, §4.1)", async () => {
    const { fetchImpl } = fakeSideshiftFetch();
    const sendUsdtCalls: Array<{ depositAddress: string; amountSats: bigint; brlCents: number }> = [];
    wallet = await open({
      dataDir,
      passphrase: PASSPHRASE,
      mnemonic: KNOWN_MNEMONIC,
      quotes: QUOTES,
      // R$50 caps — a NON-continuation R$100 send would bust them; the exit leg
      // executes only because it authenticates as a plan continuation.
      guardrails: { perTxLimitBrlCents: 5_000, dailyLimitBrlCents: 5_000 },
      convert: {
        sideshift: {
          fetchImpl,
          affiliateId: "test-affiliate",
          sendUsdt: async (p: { depositAddress: string; amountSats: bigint; brlCents: number }) => {
            sendUsdtCalls.push(p);
            return { txid: "usdt_send_txid" };
          }
        }
      }
    });
    // Crash BETWEEN legs: the market swap (leg 1) settled; the sideshift.send
    // exit leg (leg 2) never started — recover() must drive leg 2.
    const store = await seedWalletPlan(dataDir, {
      currentLegIndex: 0,
      legResults: [{ state: "settled", txids: ["swap_txid"], receivedSats: 2_000_000_000n, trackingId: null }]
    });

    // The parallel-call adversary the mutex targets (mutex.ts:5-10): two
    // recover() passes at once, each driving from its own readAll() snapshot.
    const [a, b] = await Promise.all([wallet.recover(), wallet.recover()]);

    // THE proof: the exit leg's provider (SideShift sendUsdt) is dispatched
    // ONCE — never twice. One pass claims and executes the send; the other,
    // serialized behind the recovery mutex, finds it in flight and PROBES it to
    // settled (fake REST) instead of re-broadcasting.
    expect(sendUsdtCalls).toHaveLength(1);
    // Combined, the two passes complete the plan exactly once; it is then gone.
    expect(a.plans.completed + b.plans.completed).toBe(1);
    expect(await store.count()).toBe(0);
    expect((await wallet.getPending()).filter((i) => i.rail === "plan")).toHaveLength(0);
  });
});
