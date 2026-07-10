// Durable SideShift shift log — <dataDir>/sideshift-shifts.json (spec §5.4/§2.5).
//
// Mirrors the frontend's per-wallet IndexedDB shift store (wallet/sideshift.js
// buildSendShiftRecord / buildReceiveShiftRecord): it tracks each shift so a
// crashed/restarted agent can re-poll status (getStatus) and reconcile. Newest
// first, capped.
//
// NOT encrypted — unlike boltz-swaps.json (which holds swap refund keys), a shift
// record carries only metadata: the SideShift id, the deposit address (theirs), the
// settle/refund addresses, amounts, status and the Liquid txid of our SEND. NO
// private keys, so a durable plaintext JSON is enough (parity with
// giftcard-orders.json). SideShift is CUSTODIAL: once the USDt is sent to their
// deposit address the funds are in their custody — there is nothing key-shaped to
// protect here.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultLogger, type Logger } from "../logger.js";
import { Mutex } from "../mutex.js";
import { ensureDir, writeFileDurable } from "../store/fs-util.js";

export const SIDESHIFT_SHIFTS_FILE = "sideshift-shifts.json";
export const MAX_STORED_SHIFTS = 200;

export type ShiftType = "send" | "receive";

export interface StoredSideShift {
  /** SideShift shift id. */
  id: string;
  type: ShiftType;
  /** USDt only (§5.4). */
  asset: "USDT";
  /** The non-Liquid network: for SEND the settle (target) network; for RECEIVE the deposit (source) network. */
  network: string;
  /** The SideShift deposit address funds are sent to (SEND) / the sender pays to (RECEIVE). */
  depositAddress: string;
  /** The final settle address (SEND: on `network`; RECEIVE: OUR Liquid receive address). */
  settleAddress: string;
  /** Refund address, or null when none was set at creation (RECEIVE variable shifts). */
  refundAddress: string | null;
  /** Last-known SideShift status (SHIFT_STATUS taxonomy). */
  status: string;
  /** SEND: the USDt deposit amount (decimal string, SideShift wire form). */
  depositAmount?: string;
  /** The settle amount SideShift quoted (decimal string). */
  settleAmount?: string | null;
  /** The Liquid txid of OUR on-chain USDt send (SEND only; null until broadcast). */
  liquidTxid?: string | null;
  /** SideShift expiry epoch-ms, when known. */
  expiresAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

interface SideShiftFileV1 {
  format: "depix-sideshift-shifts";
  version: 1;
  shifts: StoredSideShift[];
}

export interface SideShiftStoreOptions {
  dataDir: string;
  logger?: Logger;
  now?: () => number;
}

export class SideShiftStore {
  private readonly dataDir: string;
  private readonly filePath: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly mutex = new Mutex();

  constructor(options: SideShiftStoreOptions) {
    this.dataDir = options.dataDir;
    this.filePath = join(options.dataDir, SIDESHIFT_SHIFTS_FILE);
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? Date.now;
  }

  private async readShifts(): Promise<StoredSideShift[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as SideShiftFileV1;
      if (parsed.format !== "depix-sideshift-shifts" || parsed.version !== 1 || !Array.isArray(parsed.shifts)) {
        throw new Error("unknown format/version");
      }
      return parsed.shifts.filter((s) => s && typeof s.id === "string" && s.id.length > 0);
    } catch (err) {
      // A corrupt log strands nothing (no funds/keys live here) — discard + log.
      this.logger.error("sideshift-shifts.json is corrupt — discarding the shift log", {
        error: String((err as Error)?.message ?? err)
      });
      return [];
    }
  }

  private async writeShifts(shifts: StoredSideShift[]): Promise<void> {
    await ensureDir(this.dataDir);
    const file: SideShiftFileV1 = {
      format: "depix-sideshift-shifts",
      version: 1,
      shifts: shifts.slice(0, MAX_STORED_SHIFTS)
    };
    await writeFileDurable(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
  }

  /** Every stored shift, newest first. */
  list(): Promise<StoredSideShift[]> {
    return this.readShifts();
  }

  /** Upsert by id, moving it to the front (newest first). Returns the list. */
  async save(shift: StoredSideShift): Promise<StoredSideShift[]> {
    return this.mutex.runExclusive(async () => {
      const now = this.now();
      const rec: StoredSideShift = {
        ...shift,
        createdAt: shift.createdAt || now,
        updatedAt: shift.updatedAt || now
      };
      const rest = (await this.readShifts()).filter((s) => s.id !== shift.id);
      const next = [rec, ...rest].slice(0, MAX_STORED_SHIFTS);
      await this.writeShifts(next);
      return next;
    });
  }

  /** Merge a patch into a stored shift (no-op if absent). Returns the list. */
  async update(id: string, patch: Partial<StoredSideShift>): Promise<StoredSideShift[]> {
    return this.mutex.runExclusive(async () => {
      const shifts = await this.readShifts();
      let touched = false;
      const next = shifts.map((s) => {
        if (s.id !== id) return s;
        touched = true;
        return { ...s, ...patch, id: s.id, updatedAt: this.now() };
      });
      if (touched) await this.writeShifts(next);
      return next;
    });
  }

  async get(id: string): Promise<StoredSideShift | null> {
    return (await this.readShifts()).find((s) => s.id === id) ?? null;
  }

  async remove(id: string): Promise<StoredSideShift[]> {
    return this.mutex.runExclusive(async () => {
      const shifts = await this.readShifts();
      const next = shifts.filter((s) => s.id !== id);
      if (next.length !== shifts.length) await this.writeShifts(next);
      return next;
    });
  }
}
