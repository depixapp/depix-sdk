// Automated multi-hop conversion (PR-C): convert({route}) with hops > 1
// executes the legs IN SEQUENCE — leg 2 consumes the amount leg 1 REALLY
// settled (never the estimate) — behind a durable, encrypted conversion plan
// (conversion-plans.json) written BEFORE leg 1 and removed only on terminal
// completion. A crash between legs leaves the plan on disk;
// resumeConversionPlans() picks it up from the last completed leg without ever
// re-executing one. Continuation legs run inside the plan-continuation context
// so the guardrail counts the intent's value ONCE (at the first outflow leg).
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64 } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDepixSdkError } from "../src/errors.js";
import { convertIntent, type IntentDeps } from "../src/convert/intent.js";
import { activePlanContinuation } from "../src/convert/continuation.js";
import {
  firstValueLegIndex,
  isPlanContinuationAuthorized,
  listPendingPlans,
  resumeConversionPlans,
  type PlanResumeSummary
} from "../src/convert/multihop.js";
import { ConversionPlanStore, type StoredConversionPlan } from "../src/convert/plan-store.js";
import { enumerateRoutes } from "../src/convert/routes.js";
import type { SideSwapQuote, SwapExecuteResult } from "../src/convert/sideswap.js";

const ROUTE_DEPIX_BOLTZ =
  "sideswap.swap:DEPIX@liquid>LBTC@liquid+boltz.toStablecoin:LBTC@liquid>USDT@ethereum";
const ROUTE_DEPIX_SIDESHIFT =
  "sideswap.swap:DEPIX@liquid>USDT@liquid+sideshift.send:USDT@liquid>USDT@ethereum";
const EVM_DEST = "0x" + "a".repeat(40);

// ── fakes (mirroring convert-intent.test.ts, plus continuation spies and a
//    REAL executed amount distinct from the quote estimate) ──────────────────

interface FakeSwapBehaviour {
  /** What the quote stream ESTIMATES. */
  estimateRecvSats?: bigint;
  /** What execute() REALLY settles (differs from the estimate — fees vary). */
  executedRecvSats?: bigint;
  executeError?: Error;
}

function makeFakeSideswap(byTo: Record<string, FakeSwapBehaviour> = {}) {
  const executed: Array<{ from: string; to: string; sendAmountSats: bigint; continuation: string | null }> = [];
  const closed: string[] = [];
  const pegStatusCalls: Array<{ orderId: string; pegIn: boolean }> = [];
  let pegStatusQueue: Array<{ status: string; txid: string | null }> = [];
  const sideswap = {
    quote: async (params: { from: string; to: string; amountSats: bigint }) => {
      const b = byTo[params.to] ?? {};
      const quote: SideSwapQuote = {
        quoteId: "Q1",
        from: params.from as SideSwapQuote["from"],
        to: params.to as SideSwapQuote["to"],
        sendAmountSats: params.amountSats,
        recvAmountSats: b.estimateRecvSats ?? 42n,
        serverFeeSats: 0n,
        fixedFeeSats: 0n,
        feeAsset: null,
        ttlMs: 30_000,
        expiresAt: Date.now() + 30_000,
        receiveAddress: "lq1our-receive"
      };
      return {
        next: async () => quote,
        execute: async (q: SideSwapQuote): Promise<SwapExecuteResult> => {
          if (b.executeError) throw b.executeError;
          executed.push({
            from: q.from,
            to: q.to,
            sendAmountSats: q.sendAmountSats,
            continuation: activePlanContinuation()?.planId ?? null
          });
          return {
            txid: "swap_txid",
            from: q.from,
            to: q.to,
            sendAmountSats: q.sendAmountSats,
            recvAmountSats: b.executedRecvSats ?? q.recvAmountSats,
            brlCents: 100
          };
        },
        close: () => {
          closed.push(`${params.from}>${params.to}`);
        }
      };
    },
    pegIn: async () => ({
      orderId: "PEG_IN_1",
      pegAddr: "bc1qpeg-in-funding-address",
      recvAddr: "lq1our-receive",
      expiresAt: null
    }),
    pegOut: async (params: { recvAddr: string; amountSats: bigint }) => ({
      orderId: "PEG_OUT_1",
      pegAddr: "lq1sideswap-peg-address",
      recvAddr: params.recvAddr,
      txid: "lbtc_send_txid",
      amountSats: params.amountSats,
      recvAmount: 9_900,
      brlCents: 50
    }),
    pegStatus: async (args: { orderId: string; pegIn: boolean }) => {
      pegStatusCalls.push(args);
      const next = pegStatusQueue.shift() ?? { status: "Processing", txid: null };
      return { orderId: args.orderId, status: next.status, confirmations: 0, txid: next.txid, deposits: [] };
    }
  };
  return {
    sideswap,
    executed,
    closed,
    pegStatusCalls,
    setPegStatusQueue: (q: Array<{ status: string; txid: string | null }>) => {
      pegStatusQueue = q;
    }
  };
}

function makeFakeSideshift() {
  const sendCalls: Array<{ network: string; amountSats: bigint; settleAddress: string; continuation: string | null }> =
    [];
  const statusCalls: string[] = [];
  let statusQueue: Array<{ status: string; settleAmount: string | null }> = [];
  const sideshift = {
    quote: async (params: { network: string; amountSats: bigint }) => ({
      quoteId: "SSQ1",
      depositNetwork: "liquid",
      settleNetwork: params.network,
      depositCoin: "usdt",
      settleCoin: "usdt",
      depositAmountSats: params.amountSats,
      settleAmount: "18.5",
      rate: "0.99",
      expiresAt: null,
      custodial: true as const
    }),
    send: async (params: { network: string; amountSats: bigint; settleAddress: string; refundAddress?: string }) => {
      sendCalls.push({
        network: params.network,
        amountSats: params.amountSats,
        settleAddress: params.settleAddress,
        continuation: activePlanContinuation()?.planId ?? null
      });
      return {
        shiftId: "SHIFT_1",
        network: params.network,
        depositAddress: "lq1sideshift-deposit",
        settleAddress: params.settleAddress,
        refundAddress: params.refundAddress ?? null,
        depositAmountSats: params.amountSats,
        settleAmount: "18.5",
        status: "waiting",
        txid: "usdt_send_txid",
        brlCents: 100,
        custodial: true as const
      };
    },
    receive: async (params: { network: string; refundAddress?: string }) => ({
      shiftId: "SHIFT_R1",
      network: params.network,
      depositAddress: "0xsideshift-inbound-deposit",
      settleAddress: "lq1our-receive",
      min: "10",
      max: "5000",
      expiresAt: null,
      custodial: true as const
    }),
    getStatus: async (shiftId: string) => {
      statusCalls.push(shiftId);
      const next = statusQueue.shift() ?? { status: "pending", settleAmount: null };
      const terminal = ["settled", "refunded", "expired"].includes(next.status);
      return {
        shiftId,
        status: next.status,
        pending: !terminal,
        terminal,
        inRefund: ["refund", "refunding", "refunded"].includes(next.status),
        depositAmount: "20",
        settleAmount: next.settleAmount,
        custodial: true as const
      };
    }
  };
  return {
    sideshift,
    sendCalls,
    statusCalls,
    setStatusQueue: (q: Array<{ status: string; settleAmount: string | null }>) => {
      statusQueue = q;
    }
  };
}

function makeFakeBoltz() {
  const stablecoinCalls: Array<{ asset: string; networkId: string; amountSats: number; continuation: string | null }> =
    [];
  const payCalls: Array<{ invoice: string; continuation: string | null }> = [];
  let stablecoinCompletion: Promise<{
    swapId: string;
    status: "settled" | "pending" | "refunded" | "refund_pending" | "failed";
    claimTransactionId?: string;
    refundTxId?: string;
  }> = Promise.resolve({ swapId: "CHAIN_1", status: "settled", claimTransactionId: "0xclaim" });
  const boltz = {
    payLightningInvoice: vi.fn(async (params: { invoice: string }) => {
      payCalls.push({ invoice: params.invoice, continuation: activePlanContinuation()?.planId ?? null });
      return {
        swapId: "SUB_1",
        lockupTxid: "lockup_txid",
        expectedAmountSats: 10_050,
        invoiceSats: 10_000,
        invoice: params.invoice,
        completion: Promise.resolve({ swapId: "SUB_1", status: "paid" as const })
      };
    }),
    receiveLightning: vi.fn(async (params: { amountSats: number }) => ({
      swapId: "REV_1",
      invoice: "lnbc1invoice",
      lockupAddress: "lq1boltz-lockup",
      amountSats: params.amountSats,
      completion: new Promise(() => {}) as Promise<never>
    })),
    toStablecoin: vi.fn(
      async (params: { asset: "USDC" | "USDT"; networkId: string; amountSats: number; claimAddress: string }) => {
        stablecoinCalls.push({
          asset: params.asset,
          networkId: params.networkId,
          amountSats: params.amountSats,
          continuation: activePlanContinuation()?.planId ?? null
        });
        return {
          swapId: "CHAIN_1",
          lockupTxid: "chain_lockup_txid",
          lockAmountSats: params.amountSats,
          asset: params.asset,
          networkId: params.networkId,
          claimAddress: params.claimAddress,
          completion: stablecoinCompletion
        };
      }
    )
  };
  return {
    boltz,
    stablecoinCalls,
    payCalls,
    setStablecoinCompletion: (p: typeof stablecoinCompletion) => {
      stablecoinCompletion = p;
    }
  };
}

let dataDir: string;
let store: ConversionPlanStore;

function makeDeps(over: Partial<IntentDeps> = {}) {
  const ss = makeFakeSideswap({
    LBTC: { estimateRecvSats: 20_000n, executedRecvSats: 19_500n },
    USDT: { estimateRecvSats: 2_000_000_000n, executedRecvSats: 1_900_000_000n }
  });
  const shift = makeFakeSideshift();
  const bz = makeFakeBoltz();
  const deps: IntentDeps = {
    sideswap: ss.sideswap,
    sideshift: shift.sideshift,
    getBoltz: () => bz.boltz,
    pollIntervalMs: 1,
    planStore: store,
    newPlanId: () => "plan-test-1",
    ...over
  };
  return { deps, ss, shift, bz };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-multihop-"));
  store = new ConversionPlanStore({ dataDir, passphrase: "correct-horse-battery-staple", saltB64: base64.encode(randomBytes(16)) });
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// ── direct execution ──────────────────────────────────────────────────────────

describe("multi-hop execution — legs run in sequence on REAL settled amounts", () => {
  it("DEPIX → USDT@ethereum (boltz route): swap settles, then toStablecoin consumes the EXECUTED output (not the estimate)", async () => {
    const { deps, ss, bz } = makeDeps();
    const res = await convertIntent(
      { from: "DEPIX", to: "USDT", network: "ethereum", amount: 100_000_000n, route: ROUTE_DEPIX_BOLTZ, address: EVM_DEST },
      deps
    );
    expect(ss.executed).toHaveLength(1);
    expect(bz.stablecoinCalls).toHaveLength(1);
    // The REAL executed amount (19_500), NOT the stream estimate (20_000).
    expect(bz.stablecoinCalls[0]!.amountSats).toBe(19_500);
    expect(res.status).toBe("settled");
    expect(res.route.id).toBe(ROUTE_DEPIX_BOLTZ);
    expect(res.txids).toEqual(["swap_txid", "chain_lockup_txid", "0xclaim"]);
    expect(res.custodial).toBe(false);
    // Terminal → the plan is gone.
    expect(await store.count()).toBe(0);
  });

  it("DEPIX → USDT@ethereum (sideshift route): swap then send; the final receipt comes from the SETTLED shift", async () => {
    const { deps, shift } = makeDeps();
    shift.setStatusQueue([{ status: "settled", settleAmount: "19.9" }]);
    const res = await convertIntent(
      {
        from: "DEPIX",
        to: "USDT",
        network: "ethereum",
        amount: 100_000_000n,
        route: ROUTE_DEPIX_SIDESHIFT,
        address: EVM_DEST
      },
      deps
    );
    expect(shift.sendCalls).toHaveLength(1);
    // Leg 2 consumes leg 1's REAL swap output (1_900_000_000), not the 2_000_000_000 estimate.
    expect(shift.sendCalls[0]!.amountSats).toBe(1_900_000_000n);
    expect(res.status).toBe("settled");
    expect(res.receivedSats).toBe(1_990_000_000n);
    expect(res.custodial).toBe(true);
    expect(res.txids).toEqual(["swap_txid", "usdt_send_txid"]);
    expect(await store.count()).toBe(0);
  });

  it("the plan is persisted BEFORE leg 1 executes", async () => {
    const { deps, bz } = makeDeps();
    let plansWhenLeg1Ran = -1;
    const baseQuote = deps.sideswap.quote.bind(deps.sideswap);
    deps.sideswap = {
      ...deps.sideswap,
      quote: async (params) => {
        const stream = await baseQuote(params);
        return {
          ...stream,
          execute: async (q: SideSwapQuote) => {
            plansWhenLeg1Ran = await store.count();
            return stream.execute(q);
          }
        };
      }
    };
    await convertIntent(
      { from: "DEPIX", to: "USDT", network: "ethereum", amount: 100_000_000n, route: ROUTE_DEPIX_BOLTZ, address: EVM_DEST },
      deps
    );
    expect(plansWhenLeg1Ran).toBe(1);
    expect(bz.stablecoinCalls).toHaveLength(1);
    expect(await store.count()).toBe(0);
  });

  it("leg 2 runs as a continuation of the plan (count-once); leg 1 does NOT", async () => {
    const { deps, ss, bz } = makeDeps();
    await convertIntent(
      { from: "DEPIX", to: "USDT", network: "ethereum", amount: 100_000_000n, route: ROUTE_DEPIX_BOLTZ, address: EVM_DEST },
      deps
    );
    expect(ss.executed[0]!.continuation).toBe(null); // leg 1: FULL guardrail (the one count)
    expect(bz.stablecoinCalls[0]!.continuation).toBe("plan-test-1"); // leg 2: continuation of the authorized plan
  });

  it("an intent whose ONLY candidate is multi-hop executes without an explicit route (locked rule: 1 route → execute)", async () => {
    const { deps, ss, bz } = makeDeps();
    const res = await convertIntent(
      { from: "DEPIX", to: "BTC", network: "lightning", amount: 100_000_000n, invoice: "lnbc1xyz" },
      deps
    );
    expect(ss.executed).toHaveLength(1);
    expect(bz.payCalls).toEqual([{ invoice: "lnbc1xyz", continuation: "plan-test-1" }]);
    expect(res.status).toBe("settled");
    expect(res.txids).toEqual(["swap_txid", "lockup_txid"]);
    expect(await store.count()).toBe(0);
  });

  it("MULTIPLE_ROUTES_AVAILABLE is still thrown when >1 candidate and no route was chosen", async () => {
    const { deps } = makeDeps();
    await expect(
      convertIntent({ from: "DEPIX", to: "USDT", network: "ethereum", amount: 100_000_000n, address: EVM_DEST }, deps)
    ).rejects.toSatisfy((e) => {
      if (!isDepixSdkError(e, "MULTIPLE_ROUTES_AVAILABLE")) return false;
      const nextStep = String((e as { details?: { nextStep?: string } }).details?.nextStep ?? "");
      // Multi-hop is automated now — the guidance must not claim otherwise.
      return !/not yet automated/i.test(nextStep);
    });
  });

  it("exit-leg params are validated BEFORE any money moves (no address → nothing executed, no plan left)", async () => {
    const { deps, ss } = makeDeps();
    await expect(
      convertIntent({ from: "DEPIX", to: "USDT", network: "ethereum", amount: 100_000_000n, route: ROUTE_DEPIX_BOLTZ }, deps)
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "INVALID_ADDRESS"));
    expect(ss.executed).toHaveLength(0);
    expect(await store.count()).toBe(0);
  });

  it("a mid-route pending leg returns status pending with receivedSats null and LEAVES the plan on disk", async () => {
    const { deps, shift } = makeDeps();
    shift.setStatusQueue([]); // the shift never settles inside the wait window
    const res = await convertIntent(
      {
        from: "DEPIX",
        to: "USDT",
        network: "ethereum",
        amount: 100_000_000n,
        route: ROUTE_DEPIX_SIDESHIFT,
        address: EVM_DEST,
        timeoutMs: 15
      },
      deps
    );
    expect(res.status).toBe("pending");
    expect(res.receivedSats).toBe(null); // never report delivered what did not settle
    expect(res.nextStep).toMatch(/recover|getPending/i);
    const plan = await store.get("plan-test-1");
    expect(plan).not.toBeNull();
    expect(plan!.state).toBe("pending");
    expect(plan!.currentLegIndex).toBe(1);
    expect(plan!.legResults[0]).toMatchObject({ state: "settled", receivedSats: 1_900_000_000n });
    expect(plan!.legResults[1]).toMatchObject({ state: "pending", trackingId: "SHIFT_1" });
  });

  it("an inflow-first multi-hop plan returns awaiting_funding and persists the plan", async () => {
    const { deps, bz } = makeDeps();
    const res = await convertIntent(
      { from: "BTC", to: "DEPIX", network: "liquid", fromNetwork: "lightning", amount: 25_000n },
      deps
    );
    expect(bz.boltz.receiveLightning).toHaveBeenCalledOnce();
    expect(res.status).toBe("awaiting_funding");
    expect(res.funding).toMatchObject({ kind: "lightning-invoice", invoice: "lnbc1invoice" });
    const plan = await store.get("plan-test-1");
    expect(plan).not.toBeNull();
    expect(plan!.state).toBe("awaiting_funding");
    expect(plan!.legResults[0]).toMatchObject({ state: "awaiting_funding", trackingId: "REV_1" });
  });

  it("multi-hop without a plan store is refused (view-only wallet cannot persist the plan)", async () => {
    const { deps } = makeDeps({ planStore: null });
    await expect(
      convertIntent(
        { from: "DEPIX", to: "USDT", network: "ethereum", amount: 100_000_000n, route: ROUTE_DEPIX_BOLTZ, address: EVM_DEST },
        deps
      )
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "WALLET_NOT_FOUND"));
  });

  it("a leg-1 failure removes the plan and rethrows (single-hop parity: nothing happened)", async () => {
    const ss = makeFakeSideswap({ LBTC: { executeError: new Error("boom") } });
    const { deps } = makeDeps({ sideswap: ss.sideswap });
    await expect(
      convertIntent(
        { from: "DEPIX", to: "USDT", network: "ethereum", amount: 100_000_000n, route: ROUTE_DEPIX_BOLTZ, address: EVM_DEST },
        deps
      )
    ).rejects.toThrow("boom");
    expect(await store.count()).toBe(0);
  });

  it("a THROWN continuation leg parks the plan for review and reports pending — never 'delivered', never lost", async () => {
    const { deps, bz } = makeDeps();
    bz.boltz.toStablecoin.mockRejectedValueOnce(Object.assign(new Error("provider exploded"), {}));
    const res = await convertIntent(
      { from: "DEPIX", to: "USDT", network: "ethereum", amount: 100_000_000n, route: ROUTE_DEPIX_BOLTZ, address: EVM_DEST },
      deps
    );
    expect(res.status).toBe("pending");
    expect(res.receivedSats).toBe(null);
    expect(res.nextStep).toMatch(/leg 2/i);
    const plan = await store.get("plan-test-1");
    expect(plan!.state).toBe("needs_review");
    expect(plan!.legResults[0]).toMatchObject({ state: "settled", receivedSats: 19_500n });
  });

  it("a retry-safe continuation-leg failure (nothingLocked) keeps the plan retryable instead of parking it", async () => {
    const { deps, bz } = makeDeps();
    bz.boltz.toStablecoin.mockRejectedValueOnce(Object.assign(new Error("pre-broadcast refusal"), { nothingLocked: true }));
    const res = await convertIntent(
      { from: "DEPIX", to: "USDT", network: "ethereum", amount: 100_000_000n, route: ROUTE_DEPIX_BOLTZ, address: EVM_DEST },
      deps
    );
    expect(res.status).toBe("pending");
    const plan = await store.get("plan-test-1");
    expect(plan!.state).toBe("pending");
    expect(plan!.legResults[1]).toBe(null); // leg 2 reset — the next resume re-executes it
  });
});

// ── recovery ──────────────────────────────────────────────────────────────────

const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

async function seedPlan(over: Partial<StoredConversionPlan> = {}): Promise<StoredConversionPlan> {
  const route = enumerateRoutes({ from: "DEPIX", to: "USDT", network: "ethereum" }).find(
    (r) => r.id === ROUTE_DEPIX_BOLTZ
  )!;
  const plan: StoredConversionPlan = {
    planId: "plan-crash-1",
    intent: { from: "DEPIX", to: "USDT", network: "ethereum", amountSats: 100_000_000n },
    route,
    params: { address: EVM_DEST },
    currentLegIndex: 0,
    legResults: [{ state: "settled", txids: ["swap_txid"], receivedSats: 19_500n, trackingId: null }],
    state: "pending",
    createdAt: 1,
    ...over
  };
  await store.put(plan);
  return plan;
}

describe("resumeConversionPlans — crash recovery from the last completed leg", () => {
  it("plan says leg 1 settled, leg 2 never started (crash between legs) → resume executes leg 2 with the REAL leg-1 output and does NOT re-run leg 1", async () => {
    await seedPlan();
    const { deps, ss, bz } = makeDeps();
    const summary = await resumeConversionPlans(deps, SILENT);
    expect(summary.checked).toBe(1);
    expect(summary.advanced).toBe(1);
    expect(ss.executed).toHaveLength(0); // leg 1 NOT re-executed
    expect(bz.stablecoinCalls).toHaveLength(1);
    expect(bz.stablecoinCalls[0]!.amountSats).toBe(19_500); // the settled leg-1 output
    expect(bz.stablecoinCalls[0]!.continuation).toBe("plan-crash-1"); // still count-once
  });

  it("resume is idempotent — a second pass never re-executes a started leg", async () => {
    await seedPlan();
    const { deps, ss, bz } = makeDeps({
      probeBoltzSwap: async () => ({ type: "stablecoin", state: "locked_up" })
    });
    await resumeConversionPlans(deps, SILENT); // executes leg 2 (in flight now)
    const second = await resumeConversionPlans(deps, SILENT);
    expect(bz.stablecoinCalls).toHaveLength(1); // NOT re-executed
    expect(ss.executed).toHaveLength(0);
    expect(second.advanced).toBe(0);
    expect(await store.count()).toBe(1); // still tracked until the provider settles
  });

  it("an in-flight boltz exit leg whose swap concluded (record gone) closes the plan", async () => {
    await seedPlan({
      currentLegIndex: 1,
      legResults: [
        { state: "settled", txids: ["swap_txid"], receivedSats: 19_500n, trackingId: null },
        { state: "pending", txids: ["chain_lockup_txid"], receivedSats: null, trackingId: "CHAIN_1" }
      ]
    });
    const { deps, bz } = makeDeps({ probeBoltzSwap: async () => null });
    const summary = await resumeConversionPlans(deps, SILENT);
    expect(summary.completed).toBe(1);
    expect(bz.stablecoinCalls).toHaveLength(0);
    expect(await store.count()).toBe(0);
  });

  it("a pending sideshift exit leg is finalized by status probe (settled) and the plan removed — not re-executed", async () => {
    const route = enumerateRoutes({ from: "DEPIX", to: "USDT", network: "ethereum" }).find(
      (r) => r.id === ROUTE_DEPIX_SIDESHIFT
    )!;
    await seedPlan({
      route,
      currentLegIndex: 1,
      legResults: [
        { state: "settled", txids: ["swap_txid"], receivedSats: 1_900_000_000n, trackingId: null },
        { state: "pending", txids: ["usdt_send_txid"], receivedSats: null, trackingId: "SHIFT_1" }
      ]
    });
    const { deps, shift } = makeDeps();
    shift.setStatusQueue([{ status: "settled", settleAmount: "19.9" }]);
    const summary = await resumeConversionPlans(deps, SILENT);
    expect(summary.completed).toBe(1);
    expect(shift.sendCalls).toHaveLength(0); // never re-executed
    expect(await store.count()).toBe(0);
  });

  it("an awaiting_funding sideshift.receive entry that SETTLED continues into the market leg with the LANDED amount (full guardrail — first value leg)", async () => {
    const route = enumerateRoutes({ from: "USDT", to: "DEPIX", network: "liquid", fromNetwork: "ethereum" })[0]!;
    await seedPlan({
      route,
      intent: { from: "USDT", to: "DEPIX", network: "liquid", fromNetwork: "ethereum", amountSats: 2_000_000_000n },
      params: {},
      state: "awaiting_funding",
      currentLegIndex: 0,
      legResults: [{ state: "awaiting_funding", txids: [], receivedSats: null, trackingId: "SHIFT_R1" }]
    });
    const ss = makeFakeSideswap({ DEPIX: { estimateRecvSats: 10n, executedRecvSats: 9n } });
    const shift = makeFakeSideshift();
    shift.setStatusQueue([{ status: "settled", settleAmount: "18.5" }]);
    const { deps } = makeDeps({ sideswap: ss.sideswap, sideshift: shift.sideshift });
    const summary = await resumeConversionPlans(deps, SILENT);
    expect(summary.advanced).toBe(1);
    expect(summary.completed).toBe(1);
    expect(ss.executed).toHaveLength(1);
    expect(ss.executed[0]!.sendAmountSats).toBe(1_850_000_000n); // the LANDED USDt, not the intent amount
    expect(ss.executed[0]!.continuation).toBe(null); // first VALUE leg → full guardrail, the one count
    expect(await store.count()).toBe(0);
  });

  it("a crash mid-market-swap is parked for review — a swap leg is NEVER blindly re-executed", async () => {
    await seedPlan({
      currentLegIndex: 0,
      legResults: [{ state: "in_flight", txids: [], receivedSats: null, trackingId: null }]
    });
    const { deps, ss, bz } = makeDeps();
    const summary = await resumeConversionPlans(deps, SILENT);
    expect(summary.needsReview).toBe(1);
    expect(ss.executed).toHaveLength(0);
    expect(bz.stablecoinCalls).toHaveLength(0);
    const plan = await store.get("plan-crash-1");
    expect(plan!.state).toBe("needs_review");
    expect(plan!.note).toBeTruthy();
    // A later pass keeps it parked without executing anything.
    const second = await resumeConversionPlans(deps, SILENT);
    expect(second.needsReview).toBe(1);
    expect(ss.executed).toHaveLength(0);
  });

  it("tampered plan records are discarded loudly, never acted upon", async () => {
    await seedPlan();
    const { readFile, writeFile } = await import("node:fs/promises");
    const path = join(dataDir, "conversion-plans.json");
    const file = JSON.parse(await readFile(path, "utf8")) as { records: Array<{ ct: string }> };
    const ct = Uint8Array.from(base64.decode(file.records[0]!.ct));
    ct[0] = ct[0]! ^ 0xff;
    file.records[0]!.ct = base64.encode(ct);
    await writeFile(path, JSON.stringify(file));
    const { deps, bz } = makeDeps();
    const summary = await resumeConversionPlans(deps, SILENT);
    expect(summary.discarded).toBe(1);
    expect(bz.stablecoinCalls).toHaveLength(0);
    expect(await store.count()).toBe(0);
  });

  it("no plan store → an empty summary (view-only wallet)", async () => {
    const { deps } = makeDeps({ planStore: null });
    const summary: PlanResumeSummary = await resumeConversionPlans(deps, SILENT);
    expect(summary).toEqual({ checked: 0, advanced: 0, completed: 0, needsReview: 0, discarded: 0, failed: 0 });
  });
});

// ── concurrency: the double-spend guard (§4.1) ─────────────────────────────────
//
// resumeConversionPlans() drives each plan from a readAll() SNAPSHOT. Two
// concurrent passes — Promise.all([recover(), recover()]) or parallel
// wallet_recover MCP calls, the exact parallel-call adversary mutex.ts:5-10
// names — both read the same pre-drive snapshot and would BOTH re-drive the
// same leg, broadcasting a fresh Boltz swap / SideShift shift / Liquid send
// TWICE (double-spend), because executeLeg has no idempotency key. The atomic
// per-leg claim (ConversionPlanStore.claimLeg — a CAS under the store mutex)
// makes exactly ONE pass win the leg; the loser sees it already claimed and
// bails WITHOUT executing. These tests would broadcast twice before the fix.
describe("resumeConversionPlans — concurrent recovery is double-spend-safe (§4.1)", () => {
  it("TWO concurrent resumes over the SAME crash-between-legs plan execute the next leg EXACTLY ONCE (zero double-broadcast)", async () => {
    await seedPlan(); // leg 1 settled (19_500), leg 2 (toStablecoin) never started
    const { deps, ss, bz } = makeDeps(); // ONE shared set of provider spies
    // The parallel-call adversary: both passes drive from their own stale snapshot.
    const [a, b] = await Promise.all([
      resumeConversionPlans(deps, SILENT),
      resumeConversionPlans(deps, SILENT)
    ]);
    // THE proof: the exit-leg provider (Boltz toStablecoin) is dispatched ONCE,
    // not twice — the losing concurrent pass was refused by the leg claim.
    expect(bz.stablecoinCalls).toHaveLength(1);
    expect(bz.stablecoinCalls[0]!.amountSats).toBe(19_500); // the settled leg-1 output
    expect(bz.stablecoinCalls[0]!.continuation).toBe("plan-crash-1"); // still count-once
    expect(ss.executed).toHaveLength(0); // leg 1 (the market swap) is never re-executed either
    // Both passes returned (neither threw); the leg is in flight and still tracked, once.
    expect([a, b].every((s) => s.failed === 0)).toBe(true);
    expect(await store.count()).toBe(1);
    const plan = await store.get("plan-crash-1");
    expect(plan!.legResults[1]).toMatchObject({ state: "pending", trackingId: "CHAIN_1" });
  });

  it("two concurrent resumes over a plan whose next leg is ALREADY in flight both PROBE — neither re-executes", async () => {
    await seedPlan({
      currentLegIndex: 1,
      legResults: [
        { state: "settled", txids: ["swap_txid"], receivedSats: 19_500n, trackingId: null },
        { state: "in_flight", txids: ["chain_lockup_txid"], receivedSats: null, trackingId: "CHAIN_1" }
      ]
    });
    const { deps, ss, bz } = makeDeps({
      probeBoltzSwap: async () => ({ type: "stablecoin", state: "locked_up" }) // still working
    });
    await Promise.all([resumeConversionPlans(deps, SILENT), resumeConversionPlans(deps, SILENT)]);
    expect(bz.stablecoinCalls).toHaveLength(0); // both PROBED — a started leg is never re-executed
    expect(ss.executed).toHaveLength(0);
    expect(await store.count()).toBe(1); // still tracked until the provider settles
  });

  it("the normal SEQUENTIAL resume still drives the next leg exactly once (no regression)", async () => {
    await seedPlan();
    const { deps, ss, bz } = makeDeps();
    const first = await resumeConversionPlans(deps, SILENT);
    const second = await resumeConversionPlans(deps, SILENT); // second pass: leg now in flight
    expect(bz.stablecoinCalls).toHaveLength(1); // executed once across BOTH passes
    expect(ss.executed).toHaveLength(0);
    expect(first.advanced).toBe(1);
    expect(second.advanced).toBe(0); // the second pass advanced nothing (leg already claimed/in flight)
  });
});

describe("listPendingPlans — metadata-only view for getPending()", () => {
  it("lists in-flight plans with route/leg metadata", async () => {
    await seedPlan();
    const { deps } = makeDeps();
    const items = await listPendingPlans(deps);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      planId: "plan-crash-1",
      routeId: ROUTE_DEPIX_BOLTZ,
      hops: 2,
      state: "pending",
      currentLegIndex: 0
    });
  });
});

describe("continuation authorization gate — no general bypass", () => {
  it("firstValueLegIndex skips inflow legs; isPlanContinuationAuthorized only accepts legs past it", async () => {
    const outflowRoute = enumerateRoutes({ from: "DEPIX", to: "USDT", network: "ethereum" })[0]!;
    expect(firstValueLegIndex(outflowRoute)).toBe(0);
    const inflowRoute = enumerateRoutes({ from: "USDT", to: "DEPIX", network: "liquid", fromNetwork: "ethereum" })[0]!;
    expect(firstValueLegIndex(inflowRoute)).toBe(1);

    expect(isPlanContinuationAuthorized(null)).toBe(false);
    const plan = await seedPlan();
    expect(isPlanContinuationAuthorized({ ...plan, currentLegIndex: 0 })).toBe(false); // the value leg itself
    expect(isPlanContinuationAuthorized({ ...plan, currentLegIndex: 1 })).toBe(true); // past the value leg
    expect(
      isPlanContinuationAuthorized({ ...plan, route: inflowRoute, currentLegIndex: 1 })
    ).toBe(false); // inflow-first plan: leg 1 IS the value leg — full guardrail
  });
});
