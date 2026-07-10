// Poll helpers for waitForDeposit / waitForWithdrawal (spec §3.4).
//
// Terminal enums are the canonical backend ones (delay-policy.js
// DEPOSIT_STATUSES / WITHDRAWAL_STATUSES + pay-webhooks.js transition maps):
//   deposit terminal: depix_sent (success) | refunded | canceled | error | expired
//   withdraw terminal: sent (success) | refunded | cancelled | error | expired
// The withdraw SANDBOX status read returns `confirmed` — a value that does NOT
// exist in the live enum — so it is terminal-success ONLY when sandbox:true;
// otherwise waitForWithdrawal would never finish a sandbox rehearsal (§3.2.10).
//
// The GET goes through the api client's per-(endpoint, key) read throttle, so
// concurrent waiters of the same resource share one 30/min budget (§3.4).

import type { DepixApiClient, StatusReadResponse } from "../api/client.js";
import { DepixSdkError } from "../errors.js";
import { defaultSleep, type SleepFn } from "../api/throttle.js";

const DEPOSIT_TERMINAL = new Set(["depix_sent", "refunded", "canceled", "error", "expired"]);
const WITHDRAW_TERMINAL = new Set(["sent", "refunded", "cancelled", "error", "expired"]);

export function isDepositTerminal(status: StatusReadResponse): boolean {
  return DEPOSIT_TERMINAL.has(status.status);
}

export function isWithdrawTerminal(status: StatusReadResponse): boolean {
  // Sandbox-only synthetic success (§3.2.10) — never in the live enum.
  if (status.sandbox === true && status.status === "confirmed") return true;
  return WITHDRAW_TERMINAL.has(status.status);
}

export interface WaitOptions {
  /** Poll spacing, default 5000ms (guidance 5–15s, §3.4). */
  intervalMs?: number;
  /** Give up after this long — POLL_TIMEOUT. Unbounded when omitted. */
  timeoutMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** Sleep injection for tests. */
  sleep?: SleepFn;
}

const DEFAULT_INTERVAL_MS = 5000;

async function pollUntilTerminal(
  fetchStatus: () => Promise<StatusReadResponse>,
  isTerminal: (s: StatusReadResponse) => boolean,
  what: string,
  options: WaitOptions
): Promise<StatusReadResponse> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const start = now();
  for (;;) {
    const status = await fetchStatus();
    if (isTerminal(status)) return status;
    if (options.timeoutMs !== undefined && now() - start >= options.timeoutMs) {
      throw new DepixSdkError(
        "POLL_TIMEOUT",
        `${what} did not reach a terminal status within ${options.timeoutMs}ms ` +
          `(last status: ${status.status})`
      );
    }
    await sleep(intervalMs);
  }
}

export function waitForDeposit(
  api: DepixApiClient,
  id: string,
  options: WaitOptions = {}
): Promise<StatusReadResponse> {
  return pollUntilTerminal(() => api.getDeposit(id), isDepositTerminal, `deposit ${id}`, options);
}

export function waitForWithdrawal(
  api: DepixApiClient,
  id: string,
  options: WaitOptions = {}
): Promise<StatusReadResponse> {
  return pollUntilTerminal(
    () => api.getWithdrawal(id),
    isWithdrawTerminal,
    `withdrawal ${id}`,
    options
  );
}
