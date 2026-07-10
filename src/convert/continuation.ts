// Multi-hop plan-continuation context (PR-C, §4.3 count-once).
//
// A multi-hop conversion moves the SAME money through 2+ hops, but each
// money-moving provider method runs the full §4.3 choke point internally — so
// without coordination a R$50 DEPIX→USDT-EVM intent would count R$100 against
// the rolling-24h cap (leg 1 DEPIX out + leg 2 L-BTC out). The plan is the
// authorization: the intent's value is counted ONCE, at the plan's FIRST
// outflow leg; every later leg is a continuation of that already-authorized
// intent and skips only the VALUE ceilings (per-tx + daily). The allowlist
// still applies to every leg's destinations.
//
// The continuation is signalled through an AsyncLocalStorage context that ONLY
// the multi-hop executor (src/convert/multihop.ts) can enter — this module is
// deliberately NOT exported from the package index, so an agent driving the
// public API/MCP surface has no way to mark its own calls as continuations.
// The wallet's guardrail hooks additionally verify the claimed plan against
// the ENCRYPTED plan store (AES-256-GCM, AAD = planId, key derived from the
// seed) before honoring the skip — a forged/tampered planId falls back to full
// enforcement (fail closed).

import { AsyncLocalStorage } from "node:async_hooks";

export interface PlanContinuationContext {
  /** The persisted conversion plan this leg continues. */
  planId: string;
}

const storage = new AsyncLocalStorage<PlanContinuationContext>();

/** Run `fn` marked as a continuation leg of the persisted plan `planId`. */
export function runAsPlanContinuation<T>(planId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ planId }, fn);
}

/** The active plan-continuation context, or null outside one. */
export function activePlanContinuation(): PlanContinuationContext | null {
  return storage.getStore() ?? null;
}
