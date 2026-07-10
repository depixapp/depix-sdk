// Automated multi-hop conversion (PR-C): sequential leg execution behind a
// durable, encrypted plan + crash recovery.
//
// EXECUTION — convert({route}) with hops > 1 runs the legs IN SEQUENCE:
//   leg 1 → wait for it to settle → leg 2 (…), returning one ConvertResult
//   carrying every txid. The intermediate asset LANDS in this wallet between
//   legs (every route pivots through the wallet's own Liquid holdings), and the
//   next leg consumes the amount the previous leg REALLY settled — never the
//   estimate (fees vary; under-funding leg 2 with a stale estimate would fail
//   or silently strand dust).
//
// PLAN — the encrypted plan record (plan-store.ts) is written BEFORE leg 1 and
//   patched as each leg starts/settles; it is removed ONLY on a terminal
//   outcome. A crash at ANY point leaves the plan on disk with enough state to
//   resume: which leg, its real settled output, the provider tracking id.
//
// RECOVERY — resumeConversionPlans() (wired into wallet.recover()/open()):
//   * leg settled, next leg never started → execute the next leg with the
//     settled output (the crash-between-legs case);
//   * leg in flight at a provider → the provider's own recovery (boltz.resume,
//     shift/peg status) drives the leg; the plan PROBES its terminal state and
//     advances/closes accordingly — a started leg is NEVER re-executed;
//   * not safely automatable (crash mid-market-swap: no tracking id, cannot
//     know whether the swap broadcast; a peg-in that does not report the landed
//     amount) → the plan is parked `needs_review` with an exact manual
//     instruction — conservative by design: this code path moves money, so it
//     never guesses.
//
// GUARDRAIL COUNT-ONCE (§4.3) — a multi-hop moves the SAME money through every
//   hop, so the intent's value is counted exactly once, at the plan's FIRST
//   outflow leg (full choke point). Later legs run inside the plan-continuation
//   context (continuation.ts): the wallet's hooks skip only the VALUE ceilings
//   for a leg whose plan authenticates in the encrypted store — the allowlist
//   still gates every leg's destinations, and a forged planId falls back to
//   full enforcement.

import { randomUUID } from "node:crypto";
import { GuardrailError, WalletError } from "../errors.js";
import { defaultLogger, type Logger } from "../logger.js";
import { runAsPlanContinuation } from "./continuation.js";
import {
  executeLeg,
  legAsConvertCall,
  requireConvertAddress,
  requireConvertInvoice,
  type ConvertParams,
  type ConvertResult,
  type ExecuteContext,
  type IntentDeps
} from "./intent.js";
import {
  type ConversionPlanState,
  type StoredConversionPlan,
  type StoredPlanLegResult
} from "./plan-store.js";
import type { Route, RouteLeg, RouteMethod } from "./routes.js";
import { usdtDecimalToSats } from "./sideshift.js";

// ─── continuation authorization (count-once gate) ─────────────────────────────

/** Entry (inflow) methods — they bring external funds in and never hit the value choke point. */
const INFLOW_METHODS: ReadonlySet<RouteMethod> = new Set(["pegIn", "receiveLightning", "receive"]);

/**
 * Index of the FIRST leg that moves this wallet's own funds — where the plan's
 * value is counted (§4.3). Inflow entry legs are skipped: they never enforce.
 */
export function firstValueLegIndex(route: Route): number {
  const idx = route.legs.findIndex((leg) => !INFLOW_METHODS.has(leg.method));
  return idx === -1 ? route.legs.length : idx;
}

/**
 * Whether a stored plan authorizes the CURRENT leg to skip the value ceilings:
 * only a leg strictly PAST the plan's first outflow leg is a continuation of an
 * already-counted intent. The wallet's hooks call this with the record freshly
 * authenticated from the encrypted store — null (absent/tampered) is never
 * authorized (fail closed to full enforcement).
 */
export function isPlanContinuationAuthorized(plan: StoredConversionPlan | null): boolean {
  if (!plan) return false;
  return plan.currentLegIndex > firstValueLegIndex(plan.route);
}

// ─── helpers ───────────────────────────────────────────────────────────────────

function requirePlanStore(deps: IntentDeps): NonNullable<IntentDeps["planStore"]> {
  if (!deps.planStore) {
    throw new WalletError(
      "WALLET_NOT_FOUND",
      "Multi-hop conversions need the encrypted conversion-plan store, which requires the wallet's seed " +
        "material (view-only/wiped wallets cannot persist a crash-safe plan). Run each leg as its own " +
        "single-hop convert() instead."
    );
  }
  return deps.planStore;
}

/** Validate every leg's caller-provided params BEFORE any money moves. */
function preflightLegParams(route: Route, params: ConvertParams): void {
  for (const leg of route.legs) {
    switch (leg.method) {
      case "pegOut":
        requireConvertAddress(params, leg, "the BTC address the peg-out pays");
        break;
      case "toStablecoin":
        requireConvertAddress(params, leg, `the ${leg.network} address the ${leg.to} is delivered to`);
        break;
      case "send":
        requireConvertAddress(params, leg, `the ${leg.network} address the USDT is delivered to`);
        break;
      case "payLightningInvoice":
        requireConvertInvoice(params);
        break;
      default:
        break;
    }
  }
}

/** The remaining legs as explicit single-hop convert() calls — the manual fallback. */
function manualRemainingLegs(route: Route, fromLegIndex: number): string {
  return route.legs
    .slice(fromLegIndex)
    .map((leg, i) => `${i + 1}) ${legAsConvertCall(leg)}`)
    .join("; ");
}

function legLabel(route: Route, index: number): string {
  const leg = route.legs[index]!;
  return `leg ${index + 1}/${route.hops} (${leg.provider}.${leg.method})`;
}

/** Collect every txid the plan produced so far, in leg order. */
function txidsSoFar(plan: StoredConversionPlan): string[] {
  const txids: string[] = [];
  for (const result of plan.legResults) {
    if (result) txids.push(...result.txids);
  }
  return txids;
}

function legResultFromOutcome(outcome: ConvertResult): StoredPlanLegResult {
  const state: StoredPlanLegResult["state"] =
    outcome.status === "settled"
      ? "settled"
      : outcome.status === "awaiting_funding"
        ? "awaiting_funding"
        : "pending";
  return {
    state,
    txids: [...outcome.txids],
    receivedSats: outcome.status === "settled" ? outcome.receivedSats : null,
    trackingId: outcome.trackingId ?? null
  };
}

/**
 * A thrown leg error is safe to retry only when we can PROVE nothing moved:
 * the guardrail refused before anything signed (GuardrailError), or the
 * provider tagged the failure pre-broadcast (`nothingLocked`, §5.3). Anything
 * else is ambiguous — never re-execute over an ambiguous failure.
 */
function isRetrySafeLegError(err: unknown): boolean {
  if (err instanceof GuardrailError) return true;
  return (err as { nothingLocked?: boolean } | null)?.nothingLocked === true;
}

// ─── execution ─────────────────────────────────────────────────────────────────

interface DriveArgs {
  plan: StoredConversionPlan;
  /** The leg to start driving at. */
  startLegIndex: number;
  /** Input amount of the starting leg (8-decimal base units of its `from`). */
  carry: bigint;
  deps: IntentDeps;
  ctx: ExecuteContext;
  /** true when called from recovery — a throw parks the plan instead of propagating. */
  resumed: boolean;
  logger: Logger;
}

/**
 * Execute a multi-hop route end to end. The plan is persisted BEFORE the first
 * leg runs; on any non-terminal stop (pending / awaiting_funding / a parked
 * failure) the plan STAYS on disk for resumeConversionPlans().
 */
export async function executeMultiHopRoute(
  route: Route,
  params: ConvertParams,
  deps: IntentDeps,
  ctx: ExecuteContext
): Promise<ConvertResult> {
  const store = requirePlanStore(deps);
  // Fail on missing exit params BEFORE any money moves — leg 2 discovering a
  // missing address AFTER leg 1 swapped would strand the intent mid-route.
  preflightLegParams(route, params);

  const now = deps.now ?? Date.now;
  const plan: StoredConversionPlan = {
    planId: (deps.newPlanId ?? randomUUID)(),
    intent: {
      from: String(params.from),
      to: String(params.to),
      network: String(params.network ?? "liquid"),
      ...(params.fromNetwork !== undefined ? { fromNetwork: String(params.fromNetwork) } : {}),
      amountSats: params.amount
    },
    route,
    params: {
      ...(typeof params.address === "string" ? { address: params.address } : {}),
      ...(typeof params.invoice === "string" ? { invoice: params.invoice } : {}),
      ...(typeof params.refundAddress === "string" ? { refundAddress: params.refundAddress } : {})
    },
    currentLegIndex: 0,
    legResults: [],
    state: "executing",
    createdAt: now()
  };
  // Persisted BEFORE leg 1 — a crash from here on always leaves a resumable plan.
  await store.put(plan);
  return drivePlan({
    plan,
    startLegIndex: 0,
    carry: params.amount,
    deps,
    ctx,
    resumed: false,
    logger: deps.logger ?? defaultLogger
  });
}

/** Drive the plan's legs sequentially from `startLegIndex`. */
async function drivePlan(args: DriveArgs): Promise<ConvertResult> {
  const { plan, deps, ctx, logger } = args;
  const store = requirePlanStore(deps);
  const route = plan.route;
  const legs = route.legs;
  const valueLegIndex = firstValueLegIndex(route);
  const txids = txidsSoFar(plan);
  let carry = args.carry;

  for (let i = args.startLegIndex; i < legs.length; i++) {
    const leg = legs[i]!;
    const isFinal = i === legs.length - 1;

    // Mark the leg started BEFORE executing it, so a crash mid-leg is visible
    // to recovery (in_flight + no result = do not blindly re-execute).
    await store.patch(plan.planId, (r) => {
      r.currentLegIndex = i;
      r.legResults[i] = { state: "in_flight", txids: [], receivedSats: null, trackingId: null };
      r.state = "executing";
    });
    plan.currentLegIndex = i;

    const legParams: ConvertParams = {
      from: leg.from,
      to: leg.to,
      network: leg.network,
      fromNetwork: leg.fromNetwork,
      amount: carry,
      ...(plan.params.address !== undefined ? { address: plan.params.address } : {}),
      ...(plan.params.invoice !== undefined ? { invoice: plan.params.invoice } : {}),
      ...(plan.params.refundAddress !== undefined ? { refundAddress: plan.params.refundAddress } : {})
    };
    // The executors read wait/timeout from the ctx. Intermediate legs MUST
    // settle before the next leg can size itself; only the final leg honors
    // the caller's wait preference (recovery passes wait:false throughout —
    // it starts legs and lets the providers' durable machinery finish them).
    const legCtx: ExecuteContext = { ...ctx, wait: isFinal ? ctx.wait : true };

    let outcome: ConvertResult;
    try {
      const run = () => executeLeg(leg, legParams, deps, legCtx);
      // Count-once (§4.3): legs past the plan's first outflow leg continue an
      // already-authorized intent — they run inside the continuation context.
      outcome = i > valueLegIndex ? await runAsPlanContinuation(plan.planId, run) : await run();
    } catch (err) {
      if (i === 0 && !args.resumed) {
        // Leg 1 refused/failed on the direct path: nothing of this plan moved
        // (executors throw before any settlement) — single-hop parity: drop the
        // plan and rethrow.
        await store.remove(plan.planId).catch(() => {});
        throw err;
      }
      // Money already moved in earlier legs — the plan must survive.
      if (isRetrySafeLegError(err)) {
        // Provably nothing moved in THIS leg — reset it so the next
        // recover()/open() re-executes it.
        await store.patch(plan.planId, (r) => {
          r.legResults[i] = null;
          r.state = "pending";
        });
        const nextStep =
          `${legLabel(route, i)} failed before moving anything (${String((err as Error)?.message ?? err)}). ` +
          `Conversion plan ${plan.planId} is saved — wallet.recover() retries it; wallet.getPending() tracks it.`;
        logger.error("multi-hop leg failed pre-move — plan kept for retry", {
          planId: plan.planId,
          leg: i + 1,
          error: String((err as Error)?.message ?? err)
        });
        return pendingResult(route, txids, nextStep);
      }
      const note =
        `${legLabel(route, i)} threw: ${String((err as Error)?.message ?? err)}. The wallet holds the previous ` +
        `leg's output; verify what settled (listTransactions()/provider status), then run the remaining legs ` +
        `manually: ${manualRemainingLegs(route, i)} — use the actually-received amount as each leg's amount.`;
      await store.patch(plan.planId, (r) => {
        r.state = "needs_review";
        r.note = note;
      });
      logger.error("multi-hop leg threw ambiguously — plan parked for review, NOT retried automatically", {
        planId: plan.planId,
        leg: i + 1,
        error: String((err as Error)?.message ?? err)
      });
      return pendingResult(route, txids, note);
    }

    txids.push(...outcome.txids);
    const legResult = legResultFromOutcome(outcome);
    const planState: ConversionPlanState =
      outcome.status === "awaiting_funding" ? "awaiting_funding" : outcome.status === "settled" ? "executing" : "pending";
    await store.patch(plan.planId, (r) => {
      r.legResults[i] = legResult;
      r.state = planState;
    });
    plan.legResults[i] = legResult;

    if (outcome.status === "awaiting_funding") {
      return {
        route,
        status: "awaiting_funding",
        txids,
        receivedSats: null,
        custodial: route.custodial,
        ...(outcome.trackingId !== undefined ? { trackingId: outcome.trackingId } : {}),
        ...(outcome.funding !== undefined ? { funding: outcome.funding } : {}),
        nextStep:
          `${outcome.nextStep ?? "fund the entry leg."} Conversion plan ${plan.planId} is saved — once the ` +
          `funds land, wallet.recover() (or the next open()) continues the remaining legs; wallet.getPending() tracks it.`
      };
    }

    if (outcome.status === "pending" || outcome.status === "refund_pending") {
      // In flight at the provider (or wait timed out). The provider's own
      // durable store drives it to terminal; the plan stays for the probe.
      return {
        route,
        status: outcome.status,
        txids,
        receivedSats: null,
        custodial: route.custodial,
        ...(outcome.trackingId !== undefined ? { trackingId: outcome.trackingId } : {}),
        nextStep:
          `${outcome.nextStep ?? `${legLabel(route, i)} has not settled yet.`} Conversion plan ${plan.planId} is ` +
          `saved — wallet.recover() resumes it from ${legLabel(route, i)}; wallet.getPending() tracks it.`
      };
    }

    if (outcome.status === "refunded" || outcome.status === "failed") {
      // Terminal without delivery. Exit legs are always last, so nothing is
      // parked BETWEEN legs: the leg's input either returned to this wallet
      // (refunded) or never left (failed). The plan is done.
      await store.remove(plan.planId).catch(() => {});
      const held = leg.from === "LBTC" || leg.from === "DEPIX" || leg.from === "USDT" ? leg.from : "the intermediate asset";
      return {
        route,
        status: outcome.status,
        txids,
        receivedSats: null,
        custodial: route.custodial,
        ...(outcome.trackingId !== undefined ? { trackingId: outcome.trackingId } : {}),
        nextStep:
          outcome.nextStep ??
          (i > 0
            ? `${legLabel(route, i)} ${outcome.status} — this wallet now holds ${held}; re-run the remaining ` +
              `conversion when ready: ${manualRemainingLegs(route, i)}.`
            : `${legLabel(route, i)} ${outcome.status} — nothing was delivered.`)
      };
    }

    // settled
    if (isFinal) {
      await store.remove(plan.planId).catch(() => {});
      return {
        route,
        status: "settled",
        txids,
        receivedSats: outcome.receivedSats,
        custodial: route.custodial,
        ...(outcome.trackingId !== undefined ? { trackingId: outcome.trackingId } : {})
      };
    }
    if (outcome.receivedSats === null || outcome.receivedSats <= 0n) {
      // Cannot size the next leg without the real landed amount — park, never guess.
      const note =
        `${legLabel(route, i)} settled but did not report the received amount; run the remaining legs ` +
        `manually with the actually-received amount: ${manualRemainingLegs(route, i + 1)}.`;
      await store.patch(plan.planId, (r) => {
        r.state = "needs_review";
        r.note = note;
      });
      return pendingResult(route, txids, note);
    }
    carry = outcome.receivedSats;
  }

  // Unreachable: every route has ≥1 leg and each iteration returns or continues.
  throw new WalletError("INVALID_AMOUNT", "multi-hop route has no legs");
}

function pendingResult(route: Route, txids: string[], nextStep: string): ConvertResult {
  return {
    route,
    status: "pending",
    txids,
    receivedSats: null,
    custodial: route.custodial,
    nextStep
  };
}

// ─── recovery ──────────────────────────────────────────────────────────────────

export interface PlanResumeSummary {
  /** Plans found in the store (all non-terminal by construction). */
  checked: number;
  /** Plans advanced by executing at least one leg this pass. */
  advanced: number;
  /** Plans that reached a terminal outcome and were removed. */
  completed: number;
  /** Plans parked (or already parked) needs_review — manual completion. */
  needsReview: number;
  /** Tampered records discarded (GCM auth failure) — never acted upon. */
  discarded: number;
  /** Probe/execution failures — plan kept for the next resume. */
  failed: number;
}

type LegProbe =
  | { kind: "settled"; receivedSats: bigint | null }
  | { kind: "still_pending" }
  /** Terminal at the provider without a deliverable follow-up (refunded/expired/record gone). */
  | { kind: "concluded"; detail: string }
  | { kind: "unknowable"; detail: string };

/** Probe whether an in-flight/awaiting leg settled, via its provider's durable state. */
async function probeLeg(leg: RouteLeg, result: StoredPlanLegResult, deps: IntentDeps): Promise<LegProbe> {
  switch (leg.method) {
    case "swap":
      // A market swap settles inline and records no tracking id — an in_flight
      // record means we crashed mid-execute and CANNOT know whether the swap
      // broadcast. Never re-execute blindly.
      return {
        kind: "unknowable",
        detail:
          "crashed during a market swap — cannot verify whether it broadcast; check listTransactions()/balances"
      };
    case "send":
    case "receive": {
      if (!result.trackingId) return { kind: "unknowable", detail: "no shift id was recorded" };
      const status = await deps.sideshift.getStatus(result.trackingId);
      if (!status.terminal) return { kind: "still_pending" };
      if (status.status === "settled") {
        return {
          kind: "settled",
          receivedSats: status.settleAmount !== null ? usdtDecimalToSats(status.settleAmount) : null
        };
      }
      return { kind: "concluded", detail: `shift ${result.trackingId} ended ${status.status}` };
    }
    case "pegOut": {
      if (!result.trackingId) return { kind: "unknowable", detail: "no peg order id was recorded" };
      const status = await deps.sideswap.pegStatus({ orderId: result.trackingId, pegIn: false });
      return status.status.toLowerCase() === "done"
        ? { kind: "settled", receivedSats: null }
        : { kind: "still_pending" };
    }
    case "pegIn": {
      if (!result.trackingId) return { kind: "unknowable", detail: "no peg order id was recorded" };
      const status = await deps.sideswap.pegStatus({ orderId: result.trackingId, pegIn: true });
      if (status.status.toLowerCase() !== "done") return { kind: "still_pending" };
      // The L-BTC landed on our descriptor, but SideSwap's status does not
      // reliably report the landed amount — never guess an input for the next leg.
      return {
        kind: "unknowable",
        detail: "the peg-in completed but the landed L-BTC amount is not reported — sync() and check balances"
      };
    }
    case "payLightningInvoice":
    case "toStablecoin": {
      if (!result.trackingId) return { kind: "unknowable", detail: "no swap id was recorded" };
      if (!deps.probeBoltzSwap) return { kind: "still_pending" };
      const swap = await deps.probeBoltzSwap(result.trackingId);
      if (swap === null) {
        // Boltz removes terminal records — the rail concluded this swap
        // (delivered or refunded to this wallet). Exit legs are final, so the
        // plan has nothing left to chain.
        return { kind: "concluded", detail: `boltz swap ${result.trackingId} concluded (record cleared)` };
      }
      if (swap.state === "settled" || swap.state === "paid") return { kind: "settled", receivedSats: null };
      if (swap.state === "refunded" || swap.state === "failed") {
        return { kind: "concluded", detail: `boltz swap ${result.trackingId} ended ${swap.state}` };
      }
      return { kind: "still_pending" };
    }
    case "receiveLightning": {
      if (!result.trackingId || !deps.probeBoltzSwap) return { kind: "still_pending" };
      const swap = await deps.probeBoltzSwap(result.trackingId);
      if (swap && swap.state === "awaiting_payment") return { kind: "still_pending" };
      // Claimed (or record cleared): the L-BTC landed, but the claimed amount
      // net of fees is not tracked — never guess the next leg's input.
      return {
        kind: "unknowable",
        detail: "the lightning receive concluded but the claimed L-BTC amount is not tracked — sync() and check balances"
      };
    }
    default:
      return { kind: "unknowable", detail: `unknown leg method ${String(leg.method)}` };
  }
}

/**
 * Resume every pending multi-hop plan — from the last completed leg, never
 * re-executing one. Idempotent: safe on every open() and mid-session
 * recover(); a pass that cannot advance a plan leaves it untouched. NEVER
 * throws — per-plan failures are logged and retried on the next resume.
 */
export async function resumeConversionPlans(deps: IntentDeps, logger: Logger = defaultLogger): Promise<PlanResumeSummary> {
  const summary: PlanResumeSummary = { checked: 0, advanced: 0, completed: 0, needsReview: 0, discarded: 0, failed: 0 };
  const store = deps.planStore;
  if (!store) return summary;

  let readResult;
  try {
    readResult = await store.readAll();
  } catch (err) {
    summary.failed++;
    logger.error("could not read conversion plans — skipping their resume", {
      error: String((err as Error)?.message ?? err)
    });
    return summary;
  }

  for (const planId of readResult.tamperedIds) {
    summary.discarded++;
    logger.error("conversion plan failed authentication (tampered) — discarding, not acted upon", { planId });
    await store.remove(planId).catch(() => {});
  }

  for (const plan of readResult.records) {
    summary.checked++;
    try {
      await resumeOnePlan(plan, deps, logger, summary);
    } catch (err) {
      summary.failed++;
      logger.error("failed to resume a conversion plan — kept for the next resume", {
        planId: plan.planId,
        error: String((err as Error)?.message ?? err)
      });
    }
  }
  return summary;
}

async function resumeOnePlan(
  plan: StoredConversionPlan,
  deps: IntentDeps,
  logger: Logger,
  summary: PlanResumeSummary
): Promise<void> {
  const store = requirePlanStore(deps);
  if (plan.state === "needs_review") {
    // Parked for manual completion — surfaced via getPending(); never auto-driven.
    summary.needsReview++;
    return;
  }

  const i = plan.currentLegIndex;
  const legs = plan.route.legs;
  const leg = legs[i];
  if (!leg) {
    // Malformed index — park rather than guess.
    await parkForReview(store, plan, `plan points at leg ${i + 1} but the route has ${legs.length}`, logger, summary);
    return;
  }
  const current = plan.legResults[i] ?? null;

  // Recovery never blocks on settlement waits: it starts/advances legs and
  // lets the providers' own durable machinery finish them; the next resume
  // probes. wait:false keeps open()/recover() prompt.
  const ctx: ExecuteContext = {
    route: plan.route,
    wait: false,
    timeoutMs: deps.settleTimeoutMs ?? 15 * 60_000,
    intervalMs: deps.pollIntervalMs ?? 5_000
  };

  if (current === null) {
    // The leg never started (crash between the plan write/patch and execution).
    const carry = i === 0 ? plan.intent.amountSats : (plan.legResults[i - 1]?.receivedSats ?? null);
    if (carry === null || carry <= 0n) {
      await parkForReview(
        store,
        plan,
        `leg ${i}'s settled amount is unknown — run the remaining legs manually: ${manualRemainingLegs(plan.route, i)}`,
        logger,
        summary
      );
      return;
    }
    await driveResumedLegs(plan, i, carry, deps, ctx, logger, summary);
    return;
  }

  if (current.state === "settled") {
    if (i === legs.length - 1) {
      // Crash between the final settle and the plan removal — just finish.
      await store.remove(plan.planId).catch(() => {});
      summary.completed++;
      return;
    }
    if (current.receivedSats === null || current.receivedSats <= 0n) {
      await parkForReview(
        store,
        plan,
        `${legLabel(plan.route, i)} settled without a reported amount — run the remaining legs manually: ` +
          manualRemainingLegs(plan.route, i + 1),
        logger,
        summary
      );
      return;
    }
    await driveResumedLegs(plan, i + 1, current.receivedSats, deps, ctx, logger, summary);
    return;
  }

  // in_flight / pending / awaiting_funding — probe the provider's durable state.
  const probe = await probeLeg(leg, current, deps);
  switch (probe.kind) {
    case "still_pending":
      return; // nothing to do this pass — the provider is still working
    case "concluded":
      // Terminal at the provider without a chainable delivery (refunded /
      // expired / record cleared). Exit legs are final and entry refunds mean
      // the inflow never landed — either way the plan has nothing left to drive.
      logger.info("conversion plan concluded at the provider — closing the plan", {
        planId: plan.planId,
        detail: probe.detail
      });
      await store.remove(plan.planId).catch(() => {});
      summary.completed++;
      return;
    case "unknowable":
      await parkForReview(
        store,
        plan,
        `${legLabel(plan.route, i)}: ${probe.detail}; then run the remaining legs manually: ` +
          manualRemainingLegs(plan.route, i + (leg.method === "swap" ? 0 : 1)),
        logger,
        summary
      );
      return;
    case "settled": {
      const settled: StoredPlanLegResult = { ...current, state: "settled", receivedSats: probe.receivedSats };
      await store.patch(plan.planId, (r) => {
        r.legResults[i] = settled;
      });
      plan.legResults[i] = settled;
      if (i === legs.length - 1) {
        await store.remove(plan.planId).catch(() => {});
        summary.completed++;
        return;
      }
      if (probe.receivedSats === null || probe.receivedSats <= 0n) {
        await parkForReview(
          store,
          plan,
          `${legLabel(plan.route, i)} settled without a reported amount — run the remaining legs manually: ` +
            manualRemainingLegs(plan.route, i + 1),
          logger,
          summary
        );
        return;
      }
      await driveResumedLegs(plan, i + 1, probe.receivedSats, deps, ctx, logger, summary);
      return;
    }
  }
}

/** Execute the plan's remaining legs (recovery path) and account the outcome. */
async function driveResumedLegs(
  plan: StoredConversionPlan,
  startLegIndex: number,
  carry: bigint,
  deps: IntentDeps,
  ctx: ExecuteContext,
  logger: Logger,
  summary: PlanResumeSummary
): Promise<void> {
  const result = await drivePlan({ plan, startLegIndex, carry, deps, ctx, resumed: true, logger });
  if ((await deps.planStore?.get(plan.planId).catch(() => null))?.state === "needs_review") {
    summary.needsReview++;
    return;
  }
  summary.advanced++;
  if (result.status === "settled" || result.status === "refunded" || result.status === "failed") {
    summary.completed++;
  }
}

async function parkForReview(
  store: NonNullable<IntentDeps["planStore"]>,
  plan: StoredConversionPlan,
  note: string,
  logger: Logger,
  summary: PlanResumeSummary
): Promise<void> {
  summary.needsReview++;
  logger.error("conversion plan parked for manual review — automatic resume would have to guess", {
    planId: plan.planId,
    note
  });
  await store.patch(plan.planId, (r) => {
    r.state = "needs_review";
    r.note = note;
  });
}

// ─── pending view ──────────────────────────────────────────────────────────────

/** Metadata-only descriptor of an in-flight plan (feeds wallet.getPending()). */
export interface PendingPlanDescriptor {
  planId: string;
  routeId: string;
  hops: number;
  state: ConversionPlanState;
  /** 0-based index of the leg currently being driven. */
  currentLegIndex: number;
  note?: string;
  createdAt: number | null;
}

/** List every in-flight multi-hop plan — read-only, metadata only. */
export async function listPendingPlans(deps: IntentDeps): Promise<PendingPlanDescriptor[]> {
  const store = deps.planStore;
  if (!store) return [];
  const { records } = await store.readAll();
  return records.map((plan) => ({
    planId: plan.planId,
    routeId: plan.route.id,
    hops: plan.route.hops,
    state: plan.state,
    currentLegIndex: plan.currentLegIndex,
    ...(plan.note !== undefined ? { note: plan.note } : {}),
    createdAt: plan.createdAt ?? null
  }));
}
