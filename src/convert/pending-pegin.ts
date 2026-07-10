// In-flight peg-in persistence (spec §5.2, parity with pending-pegin.js).
//
// SideSwap peg-in (BTC on-chain → L-BTC) is slow (~102 BTC confirmations). Only
// ONE peg-in may be in flight at a time: generating a second peg-in address
// while one is pending makes the original un-trackable (BTC sent there still
// credits server-side, but the SDK loses local visibility). SideSwapPeg.pegIn()
// enforces this via load() before issuing the RPC → PEG_IN_ALREADY_PENDING.
//
// Plaintext JSON (unlike the seed / pending-withdrawals, no funds or double-pay
// risk — it is an order id + a BTC deposit address for TRACKING; the funding is
// external and the L-BTC lands on our own descriptor address regardless). Atomic
// durable write via the shared fs-util. Entries older than 7 days are pruned on
// read (stale: user abandoned the flow, or the BTC tx never landed).

import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { defaultLogger, type Logger } from "../logger.js";
import { ensureDir, writeFileDurable } from "../store/fs-util.js";

export const PENDING_PEGIN_FILE = "pending-pegin.json";
export const PENDING_PEGIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PegInRecord {
  orderId: string;
  /** BTC address the owner funds externally. */
  pegAddr: string;
  /** OUR Liquid receive address that SideSwap pays L-BTC to. */
  recvAddr: string;
  createdAt: number;
}

export interface PendingPegInOptions {
  now?: () => number;
  logger?: Logger;
}

export class PendingPegIn {
  private readonly path: string;
  private readonly dataDir: string;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(dataDir: string, options: PendingPegInOptions = {}) {
    this.dataDir = dataDir;
    this.path = join(dataDir, PENDING_PEGIN_FILE);
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? defaultLogger;
  }

  /**
   * Load the pending peg-in, or null. A malformed entry, a missing/NaN
   * createdAt, or an entry older than the 7-day TTL is treated as absent (and
   * cleared, so the next put() is not blocked by junk).
   */
  async load(): Promise<PegInRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    if (raw.trim().length === 0) return null;
    let parsed: Partial<PegInRecord> | null;
    try {
      parsed = JSON.parse(raw) as Partial<PegInRecord>;
    } catch {
      await this.clear();
      return null;
    }
    if (!parsed || typeof parsed !== "object" || !parsed.orderId || !parsed.pegAddr) {
      await this.clear();
      return null;
    }
    if (typeof parsed.createdAt !== "number" || !Number.isFinite(parsed.createdAt)) {
      await this.clear();
      return null;
    }
    if (this.now() - parsed.createdAt > PENDING_PEGIN_TTL_MS) {
      await this.clear();
      return null;
    }
    return {
      orderId: parsed.orderId,
      pegAddr: parsed.pegAddr,
      recvAddr: parsed.recvAddr ?? "",
      createdAt: parsed.createdAt
    };
  }

  /** Persist the in-flight peg-in (atomic + durable §2.4). */
  async put(record: Omit<PegInRecord, "createdAt"> & { createdAt?: number }): Promise<void> {
    await ensureDir(this.dataDir);
    const payload: PegInRecord = {
      orderId: record.orderId,
      pegAddr: record.pegAddr,
      recvAddr: record.recvAddr,
      createdAt: record.createdAt ?? this.now()
    };
    await writeFileDurable(this.path, `${JSON.stringify(payload)}\n`);
  }

  /** Remove the pending peg-in (best effort). */
  async clear(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      this.logger.warn("could not clear pending peg-in", { error: String(err) });
    }
  }
}
