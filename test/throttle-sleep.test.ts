// defaultSleep must HOLD the event loop (mainnet e2e P3, 2026-07-11).
//
// Every consumer is an actively-awaiting caller (throttle acquire(), the
// waitForDeposit/waitForWithdrawal poll loop, retry backoff). An earlier
// .unref() on the timer let Node drain the event loop mid-await whenever the
// sleep was the only live handle — `node -e` one-liners running
// waitForDeposit() died with exit code 13 ("unsettled top-level await") between
// polls. The regression check inspects the timer's ref-ness the instant the
// sleep is armed.
import { describe, expect, it } from "vitest";
import { defaultSleep } from "../src/api/throttle.js";

describe("defaultSleep (throttle/poll sleep)", () => {
  it("REGRESSION: arms a ref'd timer — the event loop must stay alive through the sleep", async () => {
    const armed: Array<{ hasRef: boolean }> = [];
    const original = globalThis.setTimeout;
    // Capture ref-ness synchronously at arm time (unref() happens inline in the
    // faulty version, before the promise is ever awaited).
    globalThis.setTimeout = ((fn: Parameters<typeof setTimeout>[0], ms?: number) => {
      const timer = original(fn, ms);
      queueMicrotask(() => {
        armed.push({ hasRef: typeof timer.hasRef === "function" ? timer.hasRef() : true });
      });
      return timer;
    }) as typeof setTimeout;
    try {
      await defaultSleep(5);
    } finally {
      globalThis.setTimeout = original;
    }
    expect(armed).toHaveLength(1);
    expect(armed[0]!.hasRef).toBe(true);
  });

  it("resolves after roughly the requested delay", async () => {
    const start = Date.now();
    await defaultSleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});
