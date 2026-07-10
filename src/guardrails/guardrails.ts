// Guardrail choke point (spec §4) — the complete §4 on top of the PR1 skeleton.
//
// Layer 1 of the two-layer defense (roadmap decision 13): protects against
// prompt injection / agent hallucination — not against a malicious owner (who
// controls the process) nor a leaked key (layer 2, server-side per key). For
// sends, swaps and gift cards this is the ONLY layer (§4.6): pure Liquid sends
// never touch the DePix API.
//
// What PR1 shipped (and this file KEEPS, building on top, not rewriting):
//   - the Mutex serialization of the state read-modify-write (writeMutex),
//   - the typed GuardrailError codes,
//   - the arithmetic fail-closed in enforce()/recordSpend()
//     (undefined/NaN/Infinity/float/≤0 never reach a comparison — §4.4),
//   - accounting AT signing time (not settlement), rolling-24h pruning on write.
//
// What PR3 adds (the rest of §4):
//   - config-driven ceilings (option/env, immutable in runtime — §4.2/G9),
//   - allowlist destination classes (§4.3),
//   - state AUTHENTICATION with AES-256-GCM on the seed-store key + a SEED-BOUND
//     anchor (marker + monotonic epoch) in wallet.json's authenticated envelope
//     (§4.5). Missing/corrupt state WITH the marker present → fail-closed, window
//     treated as FULL. The marker/epoch cannot be stripped or rolled back without
//     the passphrase (they are covered by the seed's GCM AAD — seed-store.ts), so:
//       * stripping the marker to fake a fresh wallet bricks signing, not resets;
//       * replaying an older state ciphertext fails the epoch match → fail-closed.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GuardrailError } from "../errors.js";
import { defaultLogger, type Logger } from "../logger.js";
import { Mutex } from "../mutex.js";
import { ensureDir, writeFileDurable } from "../store/fs-util.js";
import { AllowlistMatcher, type GuardrailDestination } from "./allowlist.js";
import { type ResolvedGuardrailConfig } from "./config.js";
import { decryptState, encryptState } from "./state-crypto.js";

// Re-exported for callers that imported these from here in PR1 (index.ts, tests).
export {
  DEFAULT_DAILY_LIMIT_BRL_CENTS,
  DEFAULT_PER_TX_LIMIT_BRL_CENTS,
  resolveGuardrailConfig
} from "./config.js";
export type { GuardrailConfig, GuardrailAllowlist, ResolvedGuardrailConfig } from "./config.js";
export type { GuardrailDestination } from "./allowlist.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;
export const GUARDRAILS_STATE_FILE = "guardrails-state.json";

export interface GuardrailIntent {
  /** Operation kind — "send"/"withdraw"/"swap"/"giftcard"/… (telemetry only). */
  kind: string;
  /** BRL value of the intent in integer cents (valuation happens upstream, §4.4). */
  brlCents: number;
  /**
   * FINAL destination(s) of the operation, for the allowlist (§4.3). Ignored
   * when the allowlist is OFF. When ON, an empty list is fail-closed.
   */
  destinations?: readonly GuardrailDestination[];
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

/** State-file format version — v2 carries the monotonic anti-replay epoch (§4.5). */
const STATE_VERSION = 2 as const;

interface StateFileV2 {
  version: 2;
  /** Monotonic epoch that MUST equal the seed-bound anchor epoch (anti-replay §4.5). */
  epoch: number;
  entries: StateEntry[];
}

/**
 * The seed-bound guardrail anchor store (§4.5), backed by wallet.json's
 * authenticated (GCM-AAD) envelope. `read()` returns the current marker + the
 * monotonic epoch; `advance()` bumps the epoch (and sets the marker) INSIDE the
 * seed's authenticated envelope, returning the new epoch. Because the anchor is
 * covered by the seed's GCM tag, an injected agent cannot strip the marker (it
 * bricks seed decryption) nor roll the epoch back (it has no passphrase), so an
 * old replayed state carries a stale epoch and is rejected.
 */
export interface GuardrailAnchorStore {
  read(): Promise<{ initialized: boolean; epoch: number }>;
  advance(): Promise<number>;
}

export interface GuardrailsOptions {
  dataDir: string;
  /** Immutable resolved config (option > env > default, §4.2/G9). */
  config: ResolvedGuardrailConfig;
  /**
   * Derives (and should memoize) the AES-256-GCM key used to authenticate the
   * state file — the SAME key as the seed store (§2.4/§4.5). Only invoked when a
   * state file actually exists (a view-only wallet without a seed never has one).
   */
  stateKey: () => Promise<CryptoKey>;
  anchor: GuardrailAnchorStore;
  logger?: Logger;
  /** Clock injection for tests. */
  now?: () => number;
}

interface WindowLoad {
  entries: StateEntry[];
  /**
   * Fail-closed = treat the rolling window as FULL (§4.5). Triggered by: missing
   * state WITH the marker set, corrupt/wrong-key state WITH the marker set, or a
   * state whose epoch does not match the seed-bound anchor (replay/rollback).
   */
  failClosed: boolean;
  /** Whether the wallet has ever recorded a spend (seed-bound marker). */
  initialized: boolean;
}

export class Guardrails {
  private readonly dataDir: string;
  private readonly statePath: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly stateKey: () => Promise<CryptoKey>;
  private readonly anchor: GuardrailAnchorStore;
  private readonly allowlist: AllowlistMatcher;
  // Serializes the state read-modify-write so concurrent recordSpend() calls
  // never lose entries (PR1 — kept verbatim). Defense in depth beyond the
  // wallet-level opMutex, so the accumulator is correct for ANY caller.
  private readonly writeMutex = new Mutex();
  // Immutable in runtime (G9) — set once from the resolved config; no method
  // mutates them, there is no update path an injected LLM could reach.
  readonly perTxLimitBrlCents: number;
  readonly dailyLimitBrlCents: number;

  constructor(options: GuardrailsOptions) {
    this.dataDir = options.dataDir;
    this.statePath = join(options.dataDir, GUARDRAILS_STATE_FILE);
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? Date.now;
    this.stateKey = options.stateKey;
    this.anchor = options.anchor;
    this.perTxLimitBrlCents = options.config.perTxLimitBrlCents;
    this.dailyLimitBrlCents = options.config.dailyLimitBrlCents;
    // Built once; an invalid liquidAddresses entry fails fast at open() with
    // GUARDRAIL_CONFIG_INVALID (§4.3).
    this.allowlist = new AllowlistMatcher(options.config.allowlist);
  }

  /**
   * The choke point (§4.3): called immediately before ANY operation that signs
   * or irrevocably commits funds. Throws typed GuardrailError — nothing partial
   * happens. Order: arithmetic fail-closed → per-tx → daily (incl. state
   * fail-closed) → allowlist.
   *
   * CALLER CONTRACT (INVARIANT — review low, guardrails.ts:158): `enforce()`
   * reads the rolling window OUTSIDE the internal `writeMutex` (which only
   * serializes recordSpend-vs-recordSpend). So the enforce→sign→recordSpend
   * sequence is NOT atomic within Guardrails. Every signing caller MUST route its
   * whole enforce→sign→record through a SINGLE per-wallet op mutex (the wallet's
   * `opMutex`, which `send()` holds). Two concurrent ops that skip it can both
   * pass the daily check and jointly exceed the cap (check-then-act TOCTOU) — and
   * for pure Liquid sends/swaps/gift cards this is the ONLY limit layer (§4.6).
   * A future conversion path (PR4+: withdraw/SideSwap/Boltz/gift-card) that adds
   * a new signing caller inherits this obligation: record MUST follow the enforce
   * that authorized it, under the same lock.
   */
  async enforce(intent: GuardrailIntent): Promise<void> {
    const attempted = intent.brlCents;
    // Arithmetic fail-closed (§4.4, PR1 — kept): undefined/NaN/Infinity/float/≤0
    // never reach a comparison — `NaN > limit === false` would silently pass
    // BOTH ceilings.
    if (typeof attempted !== "number" || !Number.isSafeInteger(attempted) || attempted <= 0) {
      throw new GuardrailError(
        "GUARDRAIL_INVALID_AMOUNT",
        `Guardrail intent has a non-positive-integer BRL value: ${String(attempted)}`
      );
    }

    const { usedCents, failClosed } = await this.usedInWindow();

    if (attempted > this.perTxLimitBrlCents) {
      throw new GuardrailError(
        "GUARDRAIL_PER_TX_LIMIT",
        `Per-transaction guardrail: R$ ${(attempted / 100).toFixed(2)} exceeds the ` +
          `R$ ${(this.perTxLimitBrlCents / 100).toFixed(2)} cap`,
        { details: { limitCents: this.perTxLimitBrlCents, attemptedCents: attempted, usedCents } }
      );
    }

    if (failClosed) {
      // Missing/tampered state while the marker is set (§4.5): treat the window
      // as FULL until the owner resets it. Deleting the state file cannot zero
      // the counter.
      throw new GuardrailError(
        "GUARDRAIL_DAILY_LIMIT",
        "Guardrail state is missing or tampered while the initialized marker is set — failing " +
          "closed: the rolling-24h window is treated as FULL until the owner resets it (spec §4.5).",
        {
          details: {
            limitCents: this.dailyLimitBrlCents,
            attemptedCents: attempted,
            usedCents: this.dailyLimitBrlCents
          }
        }
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

    // Allowlist (§4.3) — after the value ceilings. No-op when disabled; when
    // enabled, a non-opt-in / unrepresentable destination class is fail-closed.
    this.allowlist.check(intent.destinations ?? []);
  }

  /**
   * Account a signed operation into the rolling window (§4.5 — at SIGNING time,
   * not settlement). Prunes entries older than 24h; authenticated + durable
   * write; sets the marker on first write.
   */
  async recordSpend(brlCents: number, kind: string): Promise<void> {
    if (!Number.isSafeInteger(brlCents) || brlCents <= 0) {
      throw new GuardrailError(
        "GUARDRAIL_INVALID_AMOUNT",
        `recordSpend called with a non-positive-integer value: ${String(brlCents)}`
      );
    }
    await this.writeMutex.runExclusive(async () => {
      const load = await this.loadWindow();
      if (load.failClosed) {
        // Never overwrite a missing/tampered/replayed state with a fresh
        // single-entry window — that is exactly the reset attack (§4.5). Refuse;
        // the caller's signing path aborts before broadcast (send() records
        // BEFORE broadcast).
        throw new GuardrailError(
          "GUARDRAIL_DAILY_LIMIT",
          "Refusing to record a spend over a missing/tampered/replayed guardrails state (fail-closed, §4.5)."
        );
      }
      const now = this.now();
      const entries = load.entries.filter((e) => now - e.ts <= WINDOW_MS);
      entries.push({ ts: now, brlCents, kind });
      // Advance the seed-bound monotonic anchor FIRST (durable), THEN stamp the
      // state with the new epoch (§4.5 anti-replay). Ordering is deliberate:
      //   * the anchor (marker + epoch) becomes durable BEFORE the state, so
      //     there is never a "state present / marker absent" window an attacker
      //     could exploit by deleting the state (closes the crash-window low,
      //     guardrails.ts:233);
      //   * a crash BETWEEN the two writes leaves anchor.epoch > state.epoch →
      //     the next read fails CLOSED (safe), never a bypass.
      const epoch = await this.anchor.advance();
      const plaintext = JSON.stringify({ version: STATE_VERSION, epoch, entries } satisfies StateFileV2);
      const envelope = await encryptState(plaintext, await this.stateKey());
      await ensureDir(this.dataDir);
      await writeFileDurable(this.statePath, `${JSON.stringify(envelope)}\n`);
    });
  }

  /** Current window usage (read-only — feeds wallet_status/wallet_get_guardrails). */
  async usage(): Promise<GuardrailUsage> {
    const { usedCents } = await this.usedInWindow();
    return {
      usedCents,
      dailyLimitCents: this.dailyLimitBrlCents,
      perTxLimitCents: this.perTxLimitBrlCents,
      remainingCents: Math.max(0, this.dailyLimitBrlCents - usedCents)
    };
  }

  private async usedInWindow(): Promise<{ usedCents: number; failClosed: boolean }> {
    const load = await this.loadWindow();
    if (load.failClosed) {
      // Report the window as full — honest for wallet_status, and enforce()
      // turns it into GUARDRAIL_DAILY_LIMIT.
      return { usedCents: this.dailyLimitBrlCents, failClosed: true };
    }
    const usedCents = load.entries.reduce((sum, e) => sum + e.brlCents, 0);
    return { usedCents, failClosed: false };
  }

  private async loadWindow(): Promise<WindowLoad> {
    const { initialized, epoch: anchorEpoch } = await this.anchor.read();
    let raw: string | null;
    try {
      raw = await readFile(this.statePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") raw = null;
      else throw err;
    }

    if (raw === null) {
      if (initialized) {
        this.logger.error(
          "guardrails-state.json is MISSING while the initialized marker is set — " +
            "failing closed, rolling-24h window treated as FULL (spec §4.5)."
        );
        return { entries: [], failClosed: true, initialized };
      }
      // Fresh wallet, never signed — empty window (§4.5).
      return { entries: [], failClosed: false, initialized };
    }

    // A state file exists — it MUST decrypt and authenticate.
    const result = await decryptState(raw, await this.stateKey());
    if (!result.ok) {
      this.logger.error(
        `guardrails-state.json failed authentication (${result.reason}) — ${
          initialized
            ? "failing closed, window treated as FULL (marker set)"
            : "empty window (no marker; fresh wallet)"
        } (spec §4.5).`
      );
      return { entries: [], failClosed: initialized, initialized };
    }

    const parsed = this.parseState(result.plaintext);
    if (parsed === null) {
      this.logger.error(
        `guardrails-state.json authenticated but its payload is malformed — ${
          initialized ? "failing closed (marker set)" : "empty window (no marker)"
        } (spec §4.5).`
      );
      return { entries: [], failClosed: initialized, initialized };
    }

    // Anti-replay (§4.5): the state's epoch MUST equal the seed-bound anchor
    // epoch. An old state ciphertext replayed onto disk authenticates (same key,
    // fixed AAD) but carries a STALE epoch < anchorEpoch → reject → fail-closed.
    // The anchor epoch is monotonic and cannot be rolled back without the
    // passphrase (it is covered by the seed's GCM tag), so this closes the
    // rollback hole. A fresh wallet (initialized=false, anchorEpoch=0) that
    // somehow has a state file is treated as empty rather than bricked.
    if (parsed.epoch !== anchorEpoch) {
      this.logger.error(
        `guardrails-state.json epoch ${parsed.epoch} does not match the seed-bound anchor ` +
          `epoch ${anchorEpoch} — replay/rollback detected, ${
            initialized ? "failing closed" : "empty window (no marker)"
          } (spec §4.5).`
      );
      return { entries: [], failClosed: initialized, initialized };
    }

    const now = this.now();
    return {
      entries: parsed.entries.filter((e) => now - e.ts <= WINDOW_MS),
      failClosed: false,
      initialized
    };
  }

  private parseState(plaintext: string): { epoch: number; entries: StateEntry[] } | null {
    try {
      const parsed = JSON.parse(plaintext) as StateFileV2;
      if (
        parsed.version !== STATE_VERSION ||
        !Number.isSafeInteger(parsed.epoch) ||
        parsed.epoch < 0 ||
        !Array.isArray(parsed.entries)
      ) {
        return null;
      }
      const entries = parsed.entries.filter(
        (e) => typeof e?.ts === "number" && Number.isSafeInteger(e.brlCents) && e.brlCents > 0
      );
      return { epoch: parsed.epoch, entries };
    } catch {
      return null;
    }
  }
}
