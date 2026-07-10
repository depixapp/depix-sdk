// Guardrail choke point — skeleton (spec §4, PR1 scope).
//
// Layer 1 of the two-layer defense (roadmap decision 13): protects against
// prompt injection / agent hallucination — not against a malicious owner (who
// controls the process) nor a leaked key (layer 2, server-side per key). For
// sends, swaps and gift cards this is the ONLY layer (§4.6): pure Liquid
// sends never touch the DePix API.
//
// PR1 ships the choke point with HARDCODED defaults (R$100/tx, R$500/day
// rolling 24h) so main never has a signing path without a ceiling. Every
// operation that signs or irrevocably commits funds calls enforce() BEFORE
// signing and recordSpend() AT signing time (not settlement — §4.5).
//
// TODO(PR3) — the rest of §4 on top of this skeleton:
//   - GuardrailConfig via open() option / DEPIX_GUARDRAIL_* env (option > env
//     > default; 0/negative = config error, disabling requires an explicit
//     Number.MAX_SAFE_INTEGER) — §4.2;
//   - allowlist + destination classes, fail-closed for non-opt-in classes →
//     GUARDRAIL_ALLOWLIST_BLOCKED — §4.3;
//   - BRL valuation of L-BTC/USDt via GET /api/quotes (fresh 30s / stale
//     5min), QUOTES_UNAVAILABLE fail-closed stays — §4.4;
//   - state AUTHENTICATION: AES-256-GCM with the seed-store key +
//     `guardrailsStateInitialized` marker in wallet.json; missing/corrupt
//     state WITH the marker present → fail-closed (window treated as FULL)
//     until explicit owner reset — §4.5. Until then a corrupt/missing state
//     falls back to an empty window with a loud log (wallet-new semantics).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GuardrailError } from "../errors.js";
import { defaultLogger, type Logger } from "../logger.js";
import { Mutex } from "../mutex.js";
import { ensureDir, writeFileDurable } from "../store/fs-util.js";

/** R$ 100,00 per transaction (roadmap decision 6). */
export const DEFAULT_PER_TX_LIMIT_BRL_CENTS = 10_000;
/** R$ 500,00 per rolling 24h window (roadmap decision 6, G7). */
export const DEFAULT_DAILY_LIMIT_BRL_CENTS = 50_000;

const WINDOW_MS = 24 * 60 * 60 * 1000;
export const GUARDRAILS_STATE_FILE = "guardrails-state.json";

export interface GuardrailIntent {
  /** Operation kind — "send" in PR1; withdraw/swaps/gift cards join in PR2+. */
  kind: string;
  /** BRL value of the intent in integer cents (valuation happens upstream). */
  brlCents: number;
}

export interface GuardrailUsage {
  usedCents: number;
  dailyLimitCents: number;
  perTxLimitCents: number;
  remainingCents: number;
}

interface StateEntry {
  ts: number;
  brlCents: number;
  kind: string;
}

interface StateFileV1 {
  version: 1;
  entries: StateEntry[];
}

export interface GuardrailsOptions {
  dataDir: string;
  logger?: Logger;
  /** Clock injection for tests. */
  now?: () => number;
}

export class Guardrails {
  private readonly dataDir: string;
  private readonly statePath: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  // Serializes the state read-modify-write so concurrent recordSpend() calls
  // never lose entries (read→push→write is not atomic on its own — last writer
  // would clobber the other's entry, under-counting the window). Defense in
  // depth beyond the wallet-level opMutex, so the accumulator is correct for
  // ANY caller (withdraw/swaps/gift cards join in PR2+).
  private readonly writeMutex = new Mutex();
  // Immutable in runtime (G9) — no method mutates these; config plumbing is PR3.
  readonly perTxLimitBrlCents = DEFAULT_PER_TX_LIMIT_BRL_CENTS;
  readonly dailyLimitBrlCents = DEFAULT_DAILY_LIMIT_BRL_CENTS;

  constructor(options: GuardrailsOptions) {
    this.dataDir = options.dataDir;
    this.statePath = join(options.dataDir, GUARDRAILS_STATE_FILE);
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? Date.now;
  }

  /**
   * The choke point (§4.3): called immediately before ANY operation that
   * signs or irrevocably commits funds. Throws typed GuardrailError —
   * nothing partial happens.
   */
  async enforce(intent: GuardrailIntent): Promise<void> {
    const attempted = intent.brlCents;
    // Arithmetic fail-closed (§4.4): undefined/NaN/Infinity/float/≤0 never
    // reach a comparison — `NaN > limit === false` would silently pass BOTH
    // ceilings.
    if (
      typeof attempted !== "number" ||
      !Number.isSafeInteger(attempted) ||
      attempted <= 0
    ) {
      throw new GuardrailError(
        "GUARDRAIL_INVALID_AMOUNT",
        `Guardrail intent has a non-positive-integer BRL value: ${String(attempted)}`
      );
    }

    const usedCents = await this.usedInWindow();

    if (attempted > this.perTxLimitBrlCents) {
      throw new GuardrailError(
        "GUARDRAIL_PER_TX_LIMIT",
        `Per-transaction guardrail: R$ ${(attempted / 100).toFixed(2)} exceeds the ` +
          `R$ ${(this.perTxLimitBrlCents / 100).toFixed(2)} cap`,
        { details: { limitCents: this.perTxLimitBrlCents, attemptedCents: attempted, usedCents } }
      );
    }

    if (usedCents + attempted > this.dailyLimitBrlCents) {
      throw new GuardrailError(
        "GUARDRAIL_DAILY_LIMIT",
        `Daily guardrail: R$ ${((usedCents + attempted) / 100).toFixed(2)} would exceed the ` +
          `R$ ${(this.dailyLimitBrlCents / 100).toFixed(2)} rolling-24h cap`,
        { details: { limitCents: this.dailyLimitBrlCents, attemptedCents: attempted, usedCents } }
      );
    }

    // TODO(PR3): allowlist destination classes (§4.3) — fail-closed for
    // classes that are not representable/opted-in when the allowlist is ON.
  }

  /**
   * Account a signed operation into the rolling window (§4.5 — at SIGNING
   * time, not settlement). Prunes entries older than 24h on write; durable
   * write recipe (§2.4).
   */
  async recordSpend(brlCents: number, kind: string): Promise<void> {
    if (!Number.isSafeInteger(brlCents) || brlCents <= 0) {
      throw new GuardrailError(
        "GUARDRAIL_INVALID_AMOUNT",
        `recordSpend called with a non-positive-integer value: ${String(brlCents)}`
      );
    }
    await this.writeMutex.runExclusive(async () => {
      const now = this.now();
      const entries = (await this.readState()).filter((e) => now - e.ts <= WINDOW_MS);
      entries.push({ ts: now, brlCents, kind });
      const state: StateFileV1 = { version: 1, entries };
      await ensureDir(this.dataDir);
      // TODO(PR3): authenticate this file with AES-256-GCM using the key
      // derived from the passphrase (same as the seed store) + write the
      // `guardrailsStateInitialized` marker into wallet.json (§4.5).
      await writeFileDurable(this.statePath, `${JSON.stringify(state)}\n`);
    });
  }

  /** Current window usage (read-only — feeds wallet_status/wallet_get_guardrails). */
  async usage(): Promise<GuardrailUsage> {
    const usedCents = await this.usedInWindow();
    return {
      usedCents,
      dailyLimitCents: this.dailyLimitBrlCents,
      perTxLimitCents: this.perTxLimitBrlCents,
      remainingCents: Math.max(0, this.dailyLimitBrlCents - usedCents)
    };
  }

  private async usedInWindow(): Promise<number> {
    const now = this.now();
    return (await this.readState())
      .filter((e) => now - e.ts <= WINDOW_MS)
      .reduce((sum, e) => sum + e.brlCents, 0);
  }

  private async readState(): Promise<StateEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, "utf8");
    } catch {
      // No state yet — fresh wallet semantics (no marker exists in PR1).
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as StateFileV1;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error("bad shape");
      return parsed.entries.filter(
        (e) =>
          typeof e?.ts === "number" &&
          Number.isSafeInteger(e.brlCents) &&
          e.brlCents > 0
      );
    } catch (err) {
      // PR1: loud log + empty window. PR3 turns this into fail-closed (window
      // FULL) whenever the wallet.json marker says state should exist (§4.5).
      this.logger.error(
        "guardrails-state.json is corrupted — treating window as empty (PR3 will fail closed)",
        { error: String((err as Error)?.message ?? err) }
      );
      return [];
    }
  }
}
