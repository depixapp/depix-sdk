// Multi-hop conversion-plan store (PR-C) — durable, authenticated, mirroring
// src/convert/boltz/store.ts (§2.4 anti-tamper recipe).
//
// A multi-hop convert() moves the wallet's money through 2+ sequential legs; a
// crash BETWEEN legs leaves funds parked in the intermediate asset with no
// in-memory driver. The plan record is what recovery resumes from: the chosen
// route, the per-leg results so far (including the REAL settled amount the next
// leg must consume) and the caller's exit params (final address / invoice).
//
// Records are sensitive in the tamper direction, not the secrecy one: a forged
// plan could redirect a continuation leg's destination or fake the guardrail
// count-once authorization. So every record is AES-256-GCM encrypted +
// authenticated with the SAME key material as the seed store (passphrase +
// wallet salt), AAD = planId, one independent envelope per record. A rewritten
// record cannot forge the GCM tag → it is discarded loudly and never acted
// upon (funds stay recoverable manually; nothing signs from tampered data).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { base64 } from "@scure/base";
import { ConversionError } from "../errors.js";
import { defaultLogger, type Logger } from "../logger.js";
import { Mutex } from "../mutex.js";
import { aesGcmDecrypt, aesGcmEncrypt, deriveKey, randomIv } from "../store/crypto.js";
import { ensureDir, writeFileDurable } from "../store/fs-util.js";
import type { Route } from "./routes.js";

export const CONVERSION_PLANS_FILE = "conversion-plans.json";

// Plan records carry bigints (intent amount, per-leg settled amounts) — plain
// JSON.stringify throws on those. Encode as {__bigint:"…"} and revive on read
// (same recipe as the Boltz store).
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { __bigint: value.toString() } : value;
}
function bigintReviver(_key: string, value: unknown): unknown {
  return value !== null &&
    typeof value === "object" &&
    typeof (value as { __bigint?: unknown }).__bigint === "string"
    ? BigInt((value as { __bigint: string }).__bigint)
    : value;
}

/**
 * Plan state while the record exists. Terminal outcomes (settled / refunded /
 * failed) REMOVE the record — a plan on disk is by definition unfinished.
 *   executing        — a leg is being driven right now (or was, when we crashed)
 *   awaiting_funding — the entry leg waits on an external party to fund
 *   pending          — a leg is in flight at its provider / timed out the wait
 *   needs_review     — recovery cannot safely continue automatically (e.g. a
 *                      crash mid-market-swap, or an entry rail that does not
 *                      report the landed amount); `note` says exactly what to do
 */
export type ConversionPlanState = "executing" | "awaiting_funding" | "pending" | "needs_review";

export type PlanLegState = "in_flight" | "awaiting_funding" | "pending" | "settled";

export interface StoredPlanLegResult {
  state: PlanLegState;
  /** Every txid this leg produced so far. */
  txids: string[];
  /** REAL settled output of this leg in 8-decimal base units of its `to` asset. */
  receivedSats: bigint | null;
  /** Provider tracking id (swapId / shiftId / peg orderId) — the resume probe key. */
  trackingId: string | null;
}

/** The original intent trio + amount (amount in 8-decimal base units of `from`). */
export interface StoredPlanIntent {
  from: string;
  to: string;
  network: string;
  fromNetwork?: string;
  amountSats: bigint;
}

/** Caller params later legs need on resume (authenticated at rest — a tampered
 *  final address would redirect the exit leg). */
export interface StoredPlanParams {
  address?: string;
  invoice?: string;
  refundAddress?: string;
}

export interface StoredConversionPlan {
  planId: string;
  intent: StoredPlanIntent;
  route: Route;
  params: StoredPlanParams;
  /** Index of the leg currently being driven (0-based). */
  currentLegIndex: number;
  /** Per-leg results, index-aligned with route.legs; null/absent = never started. */
  legResults: (StoredPlanLegResult | null)[];
  state: ConversionPlanState;
  /** Human/agent-actionable note — set when the plan is parked needs_review. */
  note?: string;
  createdAt: number;
}

interface Envelope {
  /** planId — stable record locator (plaintext; not secret). */
  id: string;
  iv: string; // base64
  ct: string; // base64
}

interface ConversionPlansFileV1 {
  format: "depix-conversion-plans";
  version: 1;
  records: Envelope[];
}

export interface ConversionPlanStoreReadAll {
  records: StoredConversionPlan[];
  /** planIds of records that FAILED GCM authentication (tampered/corrupt). */
  tamperedIds: string[];
}

export interface ConversionPlanStoreOptions {
  dataDir: string;
  passphrase: string;
  /** Wallet salt (base64) — same salt the seed store derived from. */
  saltB64: string;
  logger?: Logger;
  now?: () => number;
}

export class ConversionPlanStore {
  private readonly dataDir: string;
  private readonly filePath: string;
  private readonly passphrase: string;
  private readonly salt: Uint8Array;
  private readonly logger: Logger;
  private readonly now: () => number;
  private keyPromise: Promise<CryptoKey> | null = null;
  private readonly mutex = new Mutex();

  constructor(options: ConversionPlanStoreOptions) {
    this.dataDir = options.dataDir;
    this.filePath = join(options.dataDir, CONVERSION_PLANS_FILE);
    this.passphrase = options.passphrase;
    this.salt = base64.decode(options.saltB64);
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? Date.now;
  }

  private key(): Promise<CryptoKey> {
    if (!this.keyPromise) this.keyPromise = deriveKey(this.passphrase, this.salt);
    return this.keyPromise;
  }

  private async encrypt(record: StoredConversionPlan): Promise<Envelope> {
    const iv = randomIv();
    const plaintext = new TextEncoder().encode(JSON.stringify(record, bigintReplacer));
    const ct = await aesGcmEncrypt(plaintext, await this.key(), iv, new TextEncoder().encode(record.planId));
    return { id: record.planId, iv: base64.encode(iv), ct: base64.encode(ct) };
  }

  private async decrypt(env: Envelope): Promise<StoredConversionPlan> {
    const plaintext = await aesGcmDecrypt(
      base64.decode(env.ct),
      await this.key(),
      base64.decode(env.iv),
      new TextEncoder().encode(env.id)
    );
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
      bigintReviver
    ) as StoredConversionPlan;
  }

  private async readEnvelopes(): Promise<Envelope[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as ConversionPlansFileV1;
      if (parsed.format !== "depix-conversion-plans" || parsed.version !== 1) {
        throw new Error("unknown format/version");
      }
      return Array.isArray(parsed.records) ? parsed.records : [];
    } catch (err) {
      this.logger.error("conversion-plans.json is corrupt — discarding (in-flight plans need manual resume)", {
        error: String((err as Error)?.message ?? err)
      });
      return [];
    }
  }

  private async writeEnvelopes(envelopes: Envelope[]): Promise<void> {
    await ensureDir(this.dataDir);
    const file: ConversionPlansFileV1 = { format: "depix-conversion-plans", version: 1, records: envelopes };
    // Durable (fsync file + dir) — losing the plan between legs strands the
    // continuation (§2.4).
    await writeFileDurable(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
  }

  /** Insert or replace a record (located by planId). */
  async put(record: StoredConversionPlan): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const rec: StoredConversionPlan = { ...record, createdAt: record.createdAt || this.now() };
      const envelopes = (await this.readEnvelopes()).filter((e) => e.id !== record.planId);
      envelopes.push(await this.encrypt(rec));
      await this.writeEnvelopes(envelopes);
    });
  }

  /** Read-modify-write ONE record. */
  async patch(planId: string, mutate: (record: StoredConversionPlan) => void): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const envelopes = await this.readEnvelopes();
      const idx = envelopes.findIndex((e) => e.id === planId);
      if (idx === -1) return;
      const record = await this.decrypt(envelopes[idx]!);
      mutate(record);
      envelopes[idx] = await this.encrypt(record);
      await this.writeEnvelopes(envelopes);
    });
  }

  /**
   * Atomically CLAIM leg `legIndex` for execution — the INTRA-PROCESS concurrency
   * guard against a double provider broadcast. The check-and-set runs under the
   * SAME in-memory store mutex `patch`/`put` take, so it re-reads the ENCRYPTED
   * record fresh and decides on live state, never a caller's stale readAll()
   * snapshot:
   *   - leg UNSET (null/absent — never started) → stamp it `in_flight` (and
   *     advance currentLegIndex/state), return `"claimed"` — the caller executes;
   *   - leg already carries a result (another recover()/resume pass claimed it,
   *     or it settled) → leave the record untouched, return `"already_active"` —
   *     the caller must NOT execute (a second provider broadcast = double-spend);
   *   - plan gone (a concurrent driver reached a terminal outcome and removed it)
   *     → return `"not_found"`.
   * Two concurrent recovery passes WITHIN ONE PROCESS (`Promise.all([recover(),
   * recover()])`, or parallel `wallet_recover` calls on the one MCP wallet — §4.1)
   * therefore can never BOTH drive the same leg: exactly one gets `"claimed"`.
   *
   * SCOPE — this guard is IN-MEMORY and thus INTRA-PROCESS ONLY. The mutex is
   * per-ConversionPlanStore-instance, so two DepixWallet instances over the SAME
   * dataDir (two processes, or two open()s in one) do NOT share it and CAN both
   * claim the same leg (verified: test/adversarial-double-spend.test.ts #4b). The
   * barrier that actually prevents that cross-process double-spend is the
   * exclusive **dir-lock** every constructor acquires (WALLET_DIR_LOCKED on a 2nd
   * open — see acquireDirLock / dir-lock.ts), which stops two wallets from
   * coexisting on one dataDir in the first place. Do NOT relax the dir-lock (e.g.
   * a lock-skipping "observer" resume mode) on the assumption that claimLeg covers
   * cross-process — it does not.
   */
  async claimLeg(planId: string, legIndex: number): Promise<"claimed" | "already_active" | "not_found"> {
    return this.mutex.runExclusive(async () => {
      const envelopes = await this.readEnvelopes();
      const idx = envelopes.findIndex((e) => e.id === planId);
      if (idx === -1) return "not_found";
      const record = await this.decrypt(envelopes[idx]!);
      if ((record.legResults[legIndex] ?? null) !== null) return "already_active";
      record.currentLegIndex = legIndex;
      record.legResults[legIndex] = { state: "in_flight", txids: [], receivedSats: null, trackingId: null };
      record.state = "executing";
      envelopes[idx] = await this.encrypt(record);
      await this.writeEnvelopes(envelopes);
      return "claimed";
    });
  }

  async remove(planId: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const envelopes = await this.readEnvelopes();
      const next = envelopes.filter((e) => e.id !== planId);
      if (next.length !== envelopes.length) await this.writeEnvelopes(next);
    });
  }

  /** Decrypt one record by planId. Throws PLAN_VALIDATION_FAILED on auth failure. */
  async get(planId: string): Promise<StoredConversionPlan | null> {
    const envelopes = await this.readEnvelopes();
    const env = envelopes.find((e) => e.id === planId);
    if (!env) return null;
    try {
      return await this.decrypt(env);
    } catch (err) {
      throw new ConversionError(
        "PLAN_VALIDATION_FAILED",
        `conversion plan ${planId} failed authentication — discarded, not acted upon`,
        { cause: err }
      );
    }
  }

  /** Decrypt every record; tampered ones are collected rather than aborting. */
  async readAll(): Promise<ConversionPlanStoreReadAll> {
    const envelopes = await this.readEnvelopes();
    const records: StoredConversionPlan[] = [];
    const tamperedIds: string[] = [];
    for (const env of envelopes) {
      try {
        records.push(await this.decrypt(env));
      } catch {
        tamperedIds.push(env.id);
      }
    }
    return { records, tamperedIds };
  }

  async count(): Promise<number> {
    return (await this.readEnvelopes()).length;
  }
}
