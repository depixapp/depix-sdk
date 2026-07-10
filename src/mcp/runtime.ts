// Pure, side-effect-free runtime helpers for the stdio bin (spec §6.1). Kept
// separate from stdio.ts so importing them (barrel / tests) NEVER triggers the
// bin's top-level main() — the bin only executes when run directly.

import type { Logger } from "../logger.js";
import { MAX_WAIT_SECONDS_CEILING } from "./schemas.js";

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
 */
export function createShutdownHandler(deps: {
  close: () => Promise<void>;
  exit: (code: number) => void;
  logger: Logger;
}): (code?: number) => void {
  let started = false;
  return (code = 0) => {
    if (started) return;
    started = true;
    void (async () => {
      try {
        await deps.close();
      } catch (err) {
        deps.logger.error("shutdown_close_failed", {
          name: err instanceof Error ? err.name : "unknown",
        });
      } finally {
        deps.exit(code);
      }
    })();
  };
}
