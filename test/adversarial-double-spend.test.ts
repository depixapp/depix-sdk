// ADVERSARIAL verification of the double-spend fix (commit 720df42, §4.1).
//
// Goal: TRY TO BREAK the fix. Each `describe` maps to one attack from the
// verification brief. Tests that would (or DO) double-broadcast are the proof.
//
//   #1 entry points serialize on the recoveryMutex
//   #2 claimLeg CAS is atomic under ONE store's mutex
//   #3 the first (non-recovery) execution also claims each leg
//   #4 TWO instances / TWO processes on the SAME dataDir (the deep one)
//   #5 the claim loser bails clean — no broadcast, no plan corruption
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64 } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertIntent, type IntentDeps } from "../src/convert/intent.js";
import { resumeConversionPlans } from "../src/convert/multihop.js";
import { ConversionPlanStore, type StoredConversionPlan } from "../src/convert/plan-store.js";
import { enumerateRoutes } from "../src/convert/routes.js";
import type { SideSwapQuote, SwapExecuteResult } from "../src/convert/sideswap.js";
import { DepixWallet } from "../src/wallet.js";
import { isDepixSdkError } from "../src/errors.js";

const ROUTE_DEPIX_BOLTZ =
  "sideswap.swap:DEPIX@liquid>LBTC@liquid+boltz.toStablecoin:LBTC@liquid>USDT@ethereum";
const EVM_DEST = "0x" + "a".repeat(40);
const PASSPHRASE = "correct-horse-battery-staple";
const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

// ── shared provider spies (so two "processes" hitting the SAME backend are
//    visible as call counts on ONE spy — a double-broadcast = length 2) ────────

function makeSharedBoltz() {
  const stablecoinCalls: Array<{ amountSats: number }> = [];
  const boltz = {
    toStablecoin: async (p: { asset: "USDC" | "USDT"; networkId: string; amountSats: number; claimAddress: string }) => {
      stablecoinCalls.push({ amountSats: p.amountSats });
      return {
        swapId: "CHAIN_1",
        lockupTxid: "chain_lockup_txid",
        lockAmountSats: p.amountSats,
        asset: p.asset,
        networkId: p.networkId,
        claimAddress: p.claimAddress,
        completion: Promise.resolve({ swapId: "CHAIN_1", status: "settled" as const, claimTransactionId: "0xclaim" })
      };
    },
    payLightningInvoice: async () => {
      throw new Error("unused");
    },
    receiveLightning: async () => {
      throw new Error("unused");
    }
  };
  return { boltz, stablecoinCalls };
}

function makeSharedSideswap() {
  const executed: Array<{ from: string; to: string }> = [];
  const sideswap = {
    quote: async (params: { from: string; to: string; amountSats: bigint }) => {
      const quote: SideSwapQuote = {
        quoteId: "Q1",
        from: params.from as SideSwapQuote["from"],
        to: params.to as SideSwapQuote["to"],
        sendAmountSats: params.amountSats,
        recvAmountSats: 20_000n,
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
          executed.push({ from: q.from, to: q.to });
          return {
            txid: "swap_txid",
            from: q.from,
            to: q.to,
            sendAmountSats: q.sendAmountSats,
            recvAmountSats: 19_500n,
            brlCents: 100
          };
        },
        close: () => {}
      };
    },
    pegIn: async () => ({ orderId: "PEG_IN_1", pegAddr: "x", recvAddr: "y", expiresAt: null }),
    pegOut: async () => {
      throw new Error("unused");
    },
    pegStatus: async (a: { orderId: string; pegIn: boolean }) => ({
      orderId: a.orderId,
      status: "Processing",
      confirmations: 0,
      txid: null,
      deposits: []
    })
  };
  return { sideswap, executed };
}

function makeSharedSideshift() {
  return {
    quote: async () => {
      throw new Error("unused");
    },
    send: async () => {
      throw new Error("unused");
    },
    receive: async () => {
      throw new Error("unused");
    },
    getStatus: async () => {
      throw new Error("unused");
    }
  };
}

/** Deps wired to a SPECIFIC store instance but sharing the given provider spies. */
function depsFor(
  store: ConversionPlanStore,
  spies: { sideswap: ReturnType<typeof makeSharedSideswap>; boltz: ReturnType<typeof makeSharedBoltz> }
): IntentDeps {
  return {
    sideswap: spies.sideswap.sideswap as unknown as IntentDeps["sideswap"],
    sideshift: makeSharedSideshift() as unknown as IntentDeps["sideshift"],
    getBoltz: () => spies.boltz.boltz as unknown as ReturnType<IntentDeps["getBoltz"]>,
    pollIntervalMs: 1,
    planStore: store,
    newPlanId: () => "plan-test-1",
    // stablecoin exit leg concluded record → treated as "concluded" by probe;
    // for these tests the leg executes fresh, so probe is not exercised.
    probeBoltzSwap: async () => ({ type: "stablecoin", state: "locked_up" })
  };
}

function makeStore(dataDir: string, saltB64: string): ConversionPlanStore {
  return new ConversionPlanStore({ dataDir, passphrase: PASSPHRASE, saltB64 });
}

function boltzRoute() {
  return enumerateRoutes({ from: "DEPIX", to: "USDT", network: "ethereum" }).find((r) => r.id === ROUTE_DEPIX_BOLTZ)!;
}

/** A crash-between-legs plan: leg 1 settled (19_500), leg 2 (toStablecoin) UNSTARTED. */
function crashBetweenLegsPlan(planId = "plan-crash-1"): StoredConversionPlan {
  return {
    planId,
    intent: { from: "DEPIX", to: "USDT", network: "ethereum", amountSats: 100_000_000n },
    route: boltzRoute(),
    params: { address: EVM_DEST },
    currentLegIndex: 0,
    legResults: [{ state: "settled", txids: ["swap_txid"], receivedSats: 19_500n, trackingId: null }],
    state: "pending",
    createdAt: 1
  };
}

/** A brand-new plan as executeMultiHopRoute leaves it right after put(): leg 0 UNSTARTED. */
function freshPlanLeg0Unstarted(planId = "plan-fresh-1"): StoredConversionPlan {
  return {
    planId,
    intent: { from: "DEPIX", to: "USDT", network: "ethereum", amountSats: 100_000_000n },
    route: boltzRoute(),
    params: { address: EVM_DEST },
    currentLegIndex: 0,
    legResults: [],
    state: "executing",
    createdAt: 1
  };
}

let dataDir: string;
let saltB64: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-adv-ds-"));
  saltB64 = base64.encode(randomBytes(16));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2 — claimLeg CAS is atomic under ONE store instance's mutex
// ─────────────────────────────────────────────────────────────────────────────
describe("#2 claimLeg CAS atomicity (single store instance)", () => {
  it("N concurrent claimLeg on the SAME instance → EXACTLY ONE 'claimed'", async () => {
    const store = makeStore(dataDir, saltB64);
    await store.put(crashBetweenLegsPlan());
    const results = await Promise.all(
      Array.from({ length: 16 }, () => store.claimLeg("plan-crash-1", 1))
    );
    const claimed = results.filter((r) => r === "claimed");
    const active = results.filter((r) => r === "already_active");
    expect(claimed).toHaveLength(1); // one winner
    expect(active).toHaveLength(15); // everyone else refused
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3 — the FIRST (non-recovery) execution also claims each leg, so a direct
//      convert() racing a recover() cannot both drive leg 0.
// ─────────────────────────────────────────────────────────────────────────────
describe("#3 first execution claims leg 0 (no unclaimed-leg-0 window)", () => {
  it("direct convert() DOES claim leg 0 (it lands in_flight, not null)", async () => {
    const store = makeStore(dataDir, saltB64);
    const spies = { sideswap: makeSharedSideswap(), boltz: makeSharedBoltz() };
    // Make leg 1 (toStablecoin) never resolve so the plan stops mid-route, letting
    // us inspect the persisted leg-0 record the direct path wrote.
    let seen = -1;
    const baseQuote = spies.sideswap.sideswap.quote;
    spies.sideswap.sideswap.quote = async (p: { from: string; to: string; amountSats: bigint }) => {
      const s = await baseQuote(p);
      return {
        ...s,
        execute: async (q: SideSwapQuote) => {
          // At the instant leg 0 executes, the store must already show leg 0 in_flight
          // (claimed), NOT null — proving the direct path claims before executing.
          const plan = await store.get("plan-test-1");
          seen = plan?.legResults[0]?.state === "in_flight" ? 1 : 0;
          return s.execute(q);
        }
      };
    };
    await convertIntent(
      { from: "DEPIX", to: "USDT", network: "ethereum", amount: 100_000_000n, route: ROUTE_DEPIX_BOLTZ, address: EVM_DEST },
      depsFor(store, spies)
    ).catch(() => {});
    expect(seen).toBe(1);
  });

  it("two concurrent resumes over an UNSTARTED-leg-0 plan drive the market swap EXACTLY ONCE", async () => {
    const store = makeStore(dataDir, saltB64);
    await store.put(freshPlanLeg0Unstarted());
    const spies = { sideswap: makeSharedSideswap(), boltz: makeSharedBoltz() };
    const deps = depsFor(store, spies);
    await Promise.all([resumeConversionPlans(deps, SILENT), resumeConversionPlans(deps, SILENT)]);
    // Leg 0 is a market swap; a claim race would broadcast it twice.
    expect(spies.sideswap.executed).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #5 — the claim LOSER bails clean: no broadcast, plan not corrupted.
// ─────────────────────────────────────────────────────────────────────────────
describe("#5 claim loser exits clean", () => {
  it("concurrent resumes: exit provider called once, plan intact, neither pass throws", async () => {
    const store = makeStore(dataDir, saltB64);
    await store.put(crashBetweenLegsPlan());
    const spies = { sideswap: makeSharedSideswap(), boltz: makeSharedBoltz() };
    const deps = depsFor(store, spies);
    const [a, b] = await Promise.all([
      resumeConversionPlans(deps, SILENT),
      resumeConversionPlans(deps, SILENT)
    ]);
    expect(spies.boltz.stablecoinCalls).toHaveLength(1); // exactly one broadcast
    expect(spies.sideswap.executed).toHaveLength(0); // leg 0 never re-run
    expect(a.failed + b.failed).toBe(0); // loser did not throw
    expect(await store.count()).toBe(1); // still tracked, once
    const plan = await store.get("plan-crash-1");
    expect(plan!.legResults[1]).toMatchObject({ state: "pending", trackingId: "CHAIN_1" }); // not corrupted
    expect(plan!.legResults[0]).toMatchObject({ state: "settled", receivedSats: 19_500n }); // untouched
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #4 — THE DEEP ONE. Two SEPARATE store instances (== two processes) on the
//      SAME dataDir do NOT share the in-memory mutex; the ONLY cross-instance
//      guard is the claimLeg record on disk. Is claimLeg atomic at FILE level?
// ─────────────────────────────────────────────────────────────────────────────
describe("#4 two instances / two processes on the SAME dataDir", () => {
  it("(4b) claimLeg is NOT atomic across two store instances — both claim the same leg", async () => {
    // Fire the race repeatedly; count how often BOTH instances win the SAME leg.
    let doubleClaims = 0;
    const trials = 20;
    for (let t = 0; t < trials; t++) {
      const dir = await mkdtemp(join(tmpdir(), "depix-adv-ds-4b-"));
      const salt = base64.encode(randomBytes(16));
      const storeA = makeStore(dir, salt);
      const storeB = makeStore(dir, salt);
      await storeA.put(crashBetweenLegsPlan("plan-race"));
      const [ra, rb] = await Promise.all([
        storeA.claimLeg("plan-race", 1),
        storeB.claimLeg("plan-race", 1)
      ]);
      if (ra === "claimed" && rb === "claimed") doubleClaims++;
      await rm(dir, { recursive: true, force: true });
    }
    // If the CAS were file-atomic this would be 0. It is not: separate instances
    // = separate mutexes = TOCTOU at file level.
    expect(doubleClaims).toBeGreaterThan(0);
  });

  it("(4b-drive) two instances driving the same plan DOUBLE-BROADCAST the exit leg", async () => {
    // Simulate two processes: two stores on one dir, two dep sets, but the SAME
    // Boltz backend (one shared spy). A double broadcast shows as length 2.
    let doubleBroadcasts = 0;
    const trials = 20;
    for (let t = 0; t < trials; t++) {
      const dir = await mkdtemp(join(tmpdir(), "depix-adv-ds-4d-"));
      const salt = base64.encode(randomBytes(16));
      const storeA = makeStore(dir, salt);
      const storeB = makeStore(dir, salt);
      await storeA.put(crashBetweenLegsPlan("plan-race"));
      const sharedBoltz = makeSharedBoltz();
      const depsA = depsFor(storeA, { sideswap: makeSharedSideswap(), boltz: sharedBoltz });
      const depsB = depsFor(storeB, { sideswap: makeSharedSideswap(), boltz: sharedBoltz });
      await Promise.all([resumeConversionPlans(depsA, SILENT), resumeConversionPlans(depsB, SILENT)]);
      if (sharedBoltz.stablecoinCalls.length >= 2) doubleBroadcasts++;
      await rm(dir, { recursive: true, force: true });
    }
    expect(doubleBroadcasts).toBeGreaterThan(0); // PROVES a file-level double-spend is possible
  });

  it("(4a) the dir-lock PREVENTS a second wallet on the same dataDir (the real mitigation)", async () => {
    // Create a real wallet, keep it open (holds the .lock), then a second open()
    // on the SAME dataDir must be refused — so the two-instance race above is
    // NOT reachable through the product's public API.
    const KNOWN_MNEMONIC =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const created = await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC });
    try {
      let threw: unknown = null;
      try {
        const second = await DepixWallet.open({
          dataDir,
          passphrase: PASSPHRASE,
          resumePendingWithdrawalsOnOpen: false,
          resumePendingConversionsOnOpen: false
        });
        await second.close().catch(() => {});
      } catch (err) {
        threw = err;
      }
      expect(threw).not.toBeNull();
      expect(isDepixSdkError(threw, "WALLET_DIR_LOCKED")).toBe(true);
    } finally {
      await created.close().catch(() => {});
    }
  });
});
