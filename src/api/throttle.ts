// Client-side pacing (spec §3.4 / §3.1).
//
// The DePix proxy rate-limits per key: creation POSTs (deposit/withdraw) at
// perUser 2/min and status GETs at perUser 30/min PER ENDPOINT (router.js:74-80).
// A naive poller trips its own 429s: two waiters of the same resource share the
// 30/min bucket, so 2×20/min = 40 > 30. This throttle keeps every caller under
// the server budget by SPACING — it delays the acquire() until a slot frees,
// rather than rejecting, so concurrent waiters of the same (endpoint, key)
// multiplex through one shared budget with automatic spacing.
//
// A bucket is any string; callers key it by `${scope}:${apiKey}` so two keys
// never share a budget and deposit/withdraw creation stay in separate buckets
// (mirroring the server's separate buckets). The retries of §7.3 go through the
// same acquire(), so a retry storm is paced too.

export type SleepFn = (ms: number) => Promise<void>;

export const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => {
    // The timer MUST hold the event loop: every consumer of this sleep is an
    // actively-awaiting caller (throttle acquire(), waitForDeposit/Withdrawal
    // polls, retry backoff) — there is no fire-and-forget path. An earlier
    // .unref() here let Node drain the loop mid-await when the sleep was the
    // only live handle, killing `node -e` one-liners with exit 13
    // ("unsettled top-level await") in the middle of waitForDeposit()
    // (mainnet e2e P3, 2026-07-11).
    setTimeout(resolve, ms);
  });

export interface ThrottleOptions {
  /** Max acquisitions allowed inside `windowMs`. */
  limit: number;
  /** Rolling window length in ms (default 60_000 — the server's minute bucket). */
  windowMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** Sleep injection for tests. */
  sleep?: SleepFn;
}

export class Throttle {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: SleepFn;
  // bucket → ascending timestamps of the acquisitions still inside the window.
  private readonly buckets = new Map<string, number[]>();

  constructor(options: ThrottleOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new TypeError(`Throttle limit must be a positive integer, got ${options.limit}`);
    }
    this.limit = options.limit;
    this.windowMs = options.windowMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Acquire a slot for `bucket`, waiting (spacing) until one is free. The
   * synchronous check-and-record below is atomic on a single-threaded event
   * loop: no `await` sits between filtering the window and pushing the new
   * timestamp, so two concurrent callers can never both observe a free slot
   * and both record — the loser re-loops after its sleep and re-evaluates.
   */
  async acquire(bucket: string): Promise<void> {
    for (;;) {
      const nowMs = this.now();
      const fresh = (this.buckets.get(bucket) ?? []).filter((t) => nowMs - t < this.windowMs);
      if (fresh.length < this.limit) {
        fresh.push(nowMs);
        this.buckets.set(bucket, fresh);
        return;
      }
      this.buckets.set(bucket, fresh);
      // Wait until the oldest in-window acquisition ages out (+1ms slack).
      const waitMs = this.windowMs - (nowMs - fresh[0]!) + 1;
      await this.sleep(waitMs);
    }
  }
}
