// Persisted LWK Update chain (spec §2.5) — headless mirror of the frontend's
// `wallet-updates-v1` IndexedDB store (GT §1.6).
//
// Each Update is a delta keyed by the DECIMAL string of `wollet.status()`
// captured BEFORE the apply; a cold start replays the chain from the empty
// Wollet. ALL updates are persisted, including tip-only ones (the frontend's
// UTXO-drift fix — wallet.js:1272-1317). Layout:
//   <dataDir>/updates/<status>.bin   Update.serialize() bytes, post-prune
//   <dataDir>/meta.json              { lastScanAt, lastSuccessAt,
//                                      lastPersistFailedAt, lastPersistErrorName,
//                                      scanToIndexHint }
//
// Blobs are written with tmp+rename only (recoverable by re-scan) and read
// TOLERANTLY: a missing/corrupt file simply terminates the chain — the next
// fullScan rebuilds the tail. This is why the durable-fsync recipe is not
// needed here (§2.4).

import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, writeFileAtomic } from "./fs-util.js";

export interface SyncMeta {
  lastScanAt?: number;
  lastSuccessAt?: number;
  lastPersistFailedAt?: number;
  lastPersistErrorName?: string | null;
  /**
   * Coverage floor for degraded scans (frontend cba130f parity): the deepest
   * external derivation index a successful scan ever proved used — or that
   * the SDK handed to a payer via getReceiveAddress (nextReceiveIndex runs
   * ahead of lwk's used view). Monotone (bumpScanHint), clamped to
   * SCAN_HINT_MAX on write AND read, and it survives a deep-rescan cache
   * wipe (clearForRescan). Degraded vanilla scans replay it via
   * fullScanToIndex so a gap_limit=20 walk can never miss history below
   * this depth.
   */
  scanToIndexHint?: number;
}

// Upper sanity bound for meta.scanToIndexHint. The hint is monotone by design
// and survives deep rescans, so a corrupt oversized value would be permanent
// and turn every degraded scan into a guaranteed timeout. One million indices
// is far beyond any real wallet and still bounded.
export const SCAN_HINT_MAX = 1_000_000;

function sanitizeScanHint(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, SCAN_HINT_MAX)
    : 0;
}

const STATUS_RE = /^\d+$/;

function assertStatusKey(status: string): void {
  if (!STATUS_RE.test(status)) {
    throw new TypeError(`update status key must be a decimal string, got: ${status}`);
  }
}

export class UpdateStore {
  readonly dataDir: string;
  readonly updatesDir: string;
  readonly metaPath: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.updatesDir = join(dataDir, "updates");
    this.metaPath = join(dataDir, "meta.json");
  }

  /** Read one update blob. Tolerant: any read failure counts as missing. */
  async getUpdate(status: string): Promise<Uint8Array | null> {
    assertStatusKey(status);
    try {
      const buf = await readFile(join(this.updatesDir, `${status}.bin`));
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  }

  /** Persist one update blob (atomic tmp+rename). */
  async putUpdate(status: string, bytes: Uint8Array): Promise<void> {
    assertStatusKey(status);
    await ensureDir(this.dataDir);
    await ensureDir(this.updatesDir);
    await writeFileAtomic(join(this.updatesDir, `${status}.bin`), bytes);
  }

  /** Read meta.json. Tolerant: missing/corrupt → {}. */
  async readMeta(): Promise<SyncMeta> {
    try {
      const raw = await readFile(this.metaPath, "utf8");
      const parsed = JSON.parse(raw) as SyncMeta;
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Merge-write meta.json (atomic). */
  async writeMeta(patch: SyncMeta): Promise<void> {
    await ensureDir(this.dataDir);
    const current = await this.readMeta();
    const next = { ...current, ...patch };
    await writeFileAtomic(this.metaPath, `${JSON.stringify(next)}\n`);
  }

  /** The stored coverage floor, sanitized + clamped on read (0 = none). */
  async readScanHint(): Promise<number> {
    return sanitizeScanHint((await this.readMeta()).scanToIndexHint);
  }

  /**
   * Monotone bump of the coverage floor — a lower (truncated) view can never
   * regress it. Read-compute-write is safe here without a transaction: the
   * dataDir is single-process (dir-lock) and the SyncEngine serializes scans,
   * so unlike the frontend's multi-tab IDB there is no concurrent writer.
   */
  async bumpScanHint(value: number): Promise<void> {
    const bump = sanitizeScanHint(value);
    if (bump <= 0) return;
    if (bump <= (await this.readScanHint())) return;
    await this.writeMeta({ scanToIndexHint: bump });
  }

  /** Wipe the whole scan cache (chain + meta). Never touches wallet.json. */
  async clearAll(): Promise<void> {
    await rm(this.updatesDir, { recursive: true, force: true });
    await rm(this.metaPath, { force: true });
  }

  /**
   * Deep-rescan cache wipe that PRESERVES the coverage floor. The floor is not
   * derived view-state but the deepest index a successful scan ever proved;
   * deleting it is exactly what turned the frontend's 2026-07-18 deep sync
   * during the waterfalls outage into a wrong-balance rebuild (the vanilla
   * fallback re-scanned from zero with gap_limit=20 and missed all high-index
   * history).
   */
  async clearForRescan(): Promise<void> {
    const hint = await this.readScanHint();
    await this.clearAll();
    if (hint > 0) await this.writeMeta({ scanToIndexHint: hint });
  }

  /** List persisted status keys (diagnostics). */
  async listStatuses(): Promise<string[]> {
    try {
      const entries = await readdir(this.updatesDir);
      return entries
        .filter((name) => name.endsWith(".bin"))
        .map((name) => name.slice(0, -".bin".length))
        .filter((status) => STATUS_RE.test(status));
    } catch {
      return [];
    }
  }
}
