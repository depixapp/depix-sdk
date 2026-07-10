// Pure, side-effect-free runtime helpers for the stdio bin (spec §6.1). Kept
// separate from stdio.ts so importing them (barrel / tests) NEVER triggers the
// bin's top-level main() — the bin only executes when run directly.

import type { Logger } from "../logger.js";
import { MAX_WAIT_SECONDS_CEILING } from "./schemas.js";

/** Failsafe: if close() never settles, force a hard exit after this long (§6.1). */
const DEFAULT_HARD_EXIT_MS = 5_000;

/** Key mode derived LOCALLY from the sk_ prefix (§6.2) — no /api/me call. */
export function resolveKeyMode(apiKey: string | undefined): "live" | "test" | "unknown" {
  if (!apiKey || !apiKey.startsWith("sk_")) return "unknown";
  return apiKey.startsWith("sk_live_") ? "live" : "test";
}

/** Optional operator override for the wait-tool ceiling, clamped to [1, 900] (§6.2d). */
export function resolveMaxWaitSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DEPIX_MCP_MAX_WAIT_SECONDS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 1) return Math.min(parsed, MAX_WAIT_SECONDS_CEILING);
  return MAX_WAIT_SECONDS_CEILING;
}

/**
 * Build an idempotent shutdown handler. The first invocation closes (server
 * transport + wallet: cancels Boltz watches, frees wasm, releases the dataDir
 * lock) then exits; later invocations — including the transport's own onclose
 * firing while we close it — are no-ops, so there is never a hang or double close.
 *
 * A `.unref()`'d watchdog forces a hard exit if `close()` never SETTLES: today
 * the MVP catalog starts no long-lived watch, but the deferred swap/lightning
 * fast-follows will, and a wedged watch-cancel must never wedge the daemon. The
 * watchdog is cleared the instant close() settles, so a fast, clean shutdown is
 * never delayed by it.
 */
export function createShutdownHandler(deps: {
  close: () => Promise<void>;
  exit: (code: number) => void;
  logger: Logger;
  /** Hard-exit failsafe window; defaults to DEFAULT_HARD_EXIT_MS. */
  hardExitMs?: number;
}): (code?: number) => void {
  const hardExitMs = deps.hardExitMs ?? DEFAULT_HARD_EXIT_MS;
  let started = false;
  return (code = 0) => {
    if (started) return;
    started = true;
    const watchdog = setTimeout(() => {
      deps.logger.error("shutdown_hard_exit", { after_ms: hardExitMs });
      deps.exit(1);
    }, hardExitMs);
    // Never let the failsafe itself keep the event loop alive.
    watchdog.unref();
    void (async () => {
      try {
        await deps.close();
      } catch (err) {
        deps.logger.error("shutdown_close_failed", {
          name: err instanceof Error ? err.name : "unknown",
        });
      } finally {
        clearTimeout(watchdog);
        deps.exit(code);
      }
    })();
  };
}
