// Persisted LWK Update chain (spec §2.5) — headless mirror of the frontend's
// `wallet-updates-v1` IndexedDB store (GT §1.6).
//
// Each Update is a delta keyed by the DECIMAL string of `wollet.status()`
// captured BEFORE the apply; a cold start replays the chain from the empty
// Wollet. ALL updates are persisted, including tip-only ones (the frontend's
// UTXO-drift fix — wallet.js:1272-1317). Layout:
//   <dataDir>/updates/<status>.bin   Update.serialize() bytes, post-prune
//   <dataDir>/meta.json              { lastScanAt, lastSuccessAt,
//                                      lastPersistFailedAt, lastPersistErrorName }
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

  /** Wipe the whole scan cache (chain + meta). Never touches wallet.json. */
  async clearAll(): Promise<void> {
    await rm(this.updatesDir, { recursive: true, force: true });
    await rm(this.metaPath, { force: true });
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
