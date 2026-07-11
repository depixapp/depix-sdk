// Sync orchestration (spec §2.6/§2.7).
//
// Provider chain waterfalls→vanilla against the canonical api.depixapp.com
// proxy (never the legacy vercel alias the frontend still uses). The fallback
// is LOAD-BEARING: during the F3 spike the waterfalls path went into a
// deterministic 404 on a fresh tip's block header while vanilla synced
// normally (SPIKE risk 1). Rotation starts at lastGoodProviderIndex and
// ESPLORA_UNAVAILABLE is only thrown when ALL providers fail (parity with
// the frontend's syncWalletInner/broadcastFinalized).
//
// One single fullScan for cold and warm (fullScanToIndex deliberately absent
// — wallet.js:1024-1031); timeouts 600s cold (neverScanned) / 60s warm;
// concurrent sync() calls join the single in-flight scan.
//
// fullScan runs in a worker_thread by default (§2.7, opt-out via
// sync.worker=false): the worker owns an isolated wasm, replays the same
// persisted chain, scans, and returns the pruned Update bytes; the main
// thread applies + persists. If the worker path fails to apply (e.g. drift
// after a failed persist), it falls back to an inline scan.

import { Worker } from "node:worker_threads";
import type { Pset, Transaction as LwkTransaction, Update as LwkUpdate, Wollet } from "lwk_node";
import { EsploraClient, Transaction, Update, mainnetNetwork } from "../engine/lwk.js";
import { WalletError } from "../errors.js";
import { defaultLogger, type Logger } from "../logger.js";
import type { UpdateStore } from "../store/update-store.js";

export interface EsploraProvider {
  name: string;
  url: string;
  waterfalls: boolean;
  concurrency?: number;
}

/**
 * Default chain (spec §2.6). Same proxy, `waterfalls` flag flips the
 * protocol. Public proxy, per-IP 600 GET / 30 POST.
 */
export const DEFAULT_ESPLORA_PROVIDERS: readonly EsploraProvider[] = Object.freeze([
  Object.freeze({
    name: "depix-proxy-waterfalls",
    url: "https://api.depixapp.com/api/esplora",
    waterfalls: true
  }),
  Object.freeze({
    name: "depix-proxy-esplora",
    url: "https://api.depixapp.com/api/esplora",
    waterfalls: false
  })
]);

const COLD_START_TIMEOUT_MS = 600_000;
const WARM_SYNC_TIMEOUT_MS = 60_000;

/** Test seam — minimal client surface the engine drives. */
export interface EsploraClientLike {
  fullScan(wollet: Wollet): Promise<LwkUpdate | undefined>;
  broadcast(pset: Pset): Promise<unknown>;
  /** Re-broadcast of a raw signed tx (§3.2.9 resume); optional on test fakes. */
  broadcastTx?(tx: LwkTransaction): Promise<unknown>;
  free?(): void;
}

// A re-broadcast of a tx already known to the network is SUCCESS, not failure
// (§7.3) — the resume path stores signedTxHex and re-broadcasts the SAME bytes,
// so "already in mempool/chain" means the earlier broadcast propagated.
const ALREADY_KNOWN_RE = /already|duplicate|txn-already-known|transaction already/i;

export interface SyncEngineOptions {
  descriptor: string;
  dataDir: string;
  updateStore: UpdateStore;
  providers?: readonly EsploraProvider[];
  /** fullScan in a worker_thread (spec §2.7). Default ON. */
  worker?: boolean;
  logger?: Logger;
  /** Tests inject fake clients here (worker path not used with a factory). */
  clientFactory?: (provider: EsploraProvider) => EsploraClientLike;
  syncTimeoutMs?: number;
  coldStartTimeoutMs?: number;
}

export interface SyncResult {
  updated: boolean;
}

function providerConcurrency(provider: EsploraProvider): number {
  if (typeof provider.concurrency === "number") return provider.concurrency;
  // The depix proxy absorbs bursts (edge cache); anything else stays at 1 to
  // avoid tripping public per-IP limits (frontend parity).
  return provider.name.startsWith("depix-proxy") ? 4 : 1;
}

/**
 * Reject after `ms`, but note: this CANNOT cancel `promise` — a wasm fullScan
 * keeps running in the background. Callers must not apply a late result. The
 * worker path terminates the worker on timeout; the inline path (scanInline)
 * relies on the timeout rejection short-circuiting before applyUpdate and pins
 * a no-op handler on the underlying scan so a late settle is neither applied
 * nor surfaced as an unhandledRejection.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class SyncEngine {
  private readonly descriptor: string;
  private readonly dataDir: string;
  private readonly updateStore: UpdateStore;
  private readonly providers: readonly EsploraProvider[];
  private readonly useWorker: boolean;
  private readonly logger: Logger;
  private readonly clientFactory?: (provider: EsploraProvider) => EsploraClientLike;
  private readonly syncTimeoutMs: number;
  private readonly coldStartTimeoutMs: number;

  private lastGoodProviderIndex = 0;
  private syncPromise: Promise<SyncResult> | null = null;

  constructor(options: SyncEngineOptions) {
    this.descriptor = options.descriptor;
    this.dataDir = options.dataDir;
    this.updateStore = options.updateStore;
    this.providers = options.providers ?? DEFAULT_ESPLORA_PROVIDERS;
    this.useWorker = options.worker ?? true;
    this.logger = options.logger ?? defaultLogger;
    this.clientFactory = options.clientFactory;
    this.syncTimeoutMs = options.syncTimeoutMs ?? WARM_SYNC_TIMEOUT_MS;
    this.coldStartTimeoutMs = options.coldStartTimeoutMs ?? COLD_START_TIMEOUT_MS;
  }

  private buildClient(provider: EsploraProvider): EsploraClientLike {
    if (this.clientFactory) return this.clientFactory(provider);
    return new EsploraClient(
      mainnetNetwork(),
      provider.url,
      provider.waterfalls,
      providerConcurrency(provider),
      false
    );
  }

  /**
   * Replay the persisted chain into a Wollet (cold start). Tolerant: a
   * missing/corrupt link stops the walk; the next fullScan rebuilds the tail.
   */
  async loadPersisted(wollet: Wollet): Promise<void> {
    const visited = new Set<string>();
    for (;;) {
      const status = wollet.status().toString();
      if (visited.has(status)) break;
      visited.add(status);
      const bytes = await this.updateStore.getUpdate(status);
      if (!bytes) break;
      try {
        wollet.applyUpdate(new Update(bytes));
      } catch (err) {
        this.logger.warn(
          "persisted update chain broken — discarding tail, next sync re-scans",
          { status, error: String((err as Error)?.message ?? err) }
        );
        break;
      }
    }
  }

  /** Sync with dedup: concurrent callers join the in-flight scan. */
  sync(wollet: Wollet): Promise<SyncResult> {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.syncInner(wollet).finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  /**
   * Deep re-scan for wallet.sync({ rescan: true }) (PR-D). The caller passes a
   * VIRGIN wollet (neverScanned() → the cold-start timeout applies), so LWK
   * re-derives the whole history from zero instead of the incremental delta.
   * Unlike sync(), this must NOT join an in-flight scan — that scan targets a
   * DIFFERENT (the stale) wollet and joining it would return without ever
   * scanning the fresh one. Any in-flight pass is awaited out first; failures
   * of that pass are its own caller's to observe.
   */
  async rescan(wollet: Wollet): Promise<SyncResult> {
    while (this.syncPromise) {
      await this.syncPromise.catch(() => {});
    }
    const scan = this.syncInner(wollet).finally(() => {
      this.syncPromise = null;
    });
    this.syncPromise = scan;
    return scan;
  }

  private async syncInner(wollet: Wollet): Promise<SyncResult> {
    const timeoutMs = wollet.neverScanned() ? this.coldStartTimeoutMs : this.syncTimeoutMs;
    const startIndex = Math.min(this.lastGoodProviderIndex, this.providers.length - 1);
    const failures: string[] = [];

    for (let step = 0; step < this.providers.length; step++) {
      const idx = (startIndex + step) % this.providers.length;
      const provider = this.providers[idx]!;
      try {
        const result = await this.scanWithProvider(wollet, provider, timeoutMs);
        this.lastGoodProviderIndex = idx;
        return result;
      } catch (err) {
        const message = String((err as Error)?.message ?? err);
        failures.push(`${provider.name}: ${message}`);
        this.logger.warn("esplora provider failed, rotating", { provider: provider.name, message });
      }
    }

    throw new WalletError(
      "ESPLORA_UNAVAILABLE",
      `All Esplora providers failed (${failures.join(" | ")})`
    );
  }

  private async scanWithProvider(
    wollet: Wollet,
    provider: EsploraProvider,
    timeoutMs: number
  ): Promise<SyncResult> {
    // Worker path only makes sense with real clients — a test factory cannot
    // cross the thread boundary.
    if (this.useWorker && !this.clientFactory) {
      try {
        return await this.scanInWorker(wollet, provider, timeoutMs);
      } catch (err) {
        if (err instanceof ApplyDriftError) {
          this.logger.warn("worker update did not apply (state drift) — falling back inline");
        } else {
          throw err;
        }
      }
    }
    return this.scanInline(wollet, provider, timeoutMs);
  }

  private async scanInline(
    wollet: Wollet,
    provider: EsploraProvider,
    timeoutMs: number
  ): Promise<SyncResult> {
    const client = this.buildClient(provider);
    try {
      // withTimeout cannot cancel the wasm scan. On timeout the await below
      // rejects and we bail BEFORE applyUpdate, so a late-resolving scan is
      // never applied to a Wollet the caller now believes idle; pin a no-op
      // handler so its late settle is not an unhandledRejection either.
      const scan = client.fullScan(wollet);
      void scan.catch(() => {});
      const update = await withTimeout(scan, timeoutMs, "fullScan");
      if (!update) {
        await this.updateStore.writeMeta({ lastScanAt: Date.now(), lastSuccessAt: Date.now() });
        return { updated: false };
      }
      const statusBefore = wollet.status().toString();
      wollet.applyUpdate(update);
      try {
        update.prune(wollet);
      } catch {
        // best effort — un-pruned updates remain valid chain links
      }
      await this.persistUpdate(statusBefore, update.serialize());
      return { updated: true };
    } finally {
      client.free?.();
    }
  }

  private async scanInWorker(
    wollet: Wollet,
    provider: EsploraProvider,
    timeoutMs: number
  ): Promise<SyncResult> {
    const bytes = await this.runWorkerScan(provider, timeoutMs);
    if (!bytes) {
      await this.updateStore.writeMeta({ lastScanAt: Date.now(), lastSuccessAt: Date.now() });
      return { updated: false };
    }
    const statusBefore = wollet.status().toString();
    try {
      wollet.applyUpdate(new Update(bytes));
    } catch (err) {
      throw new ApplyDriftError(String((err as Error)?.message ?? err));
    }
    await this.persistUpdate(statusBefore, bytes);
    return { updated: true };
  }

  private runWorkerScan(provider: EsploraProvider, timeoutMs: number): Promise<Uint8Array | null> {
    return new Promise<Uint8Array | null>((resolve, reject) => {
      const worker = new Worker(new URL("./worker.js", import.meta.url), {
        // Do NOT inherit the parent's execArgv: flags like --input-type or
        // REPL/eval artifacts break worker bootstrap, and the self-contained
        // worker needs no CLI options.
        execArgv: [],
        workerData: {
          descriptor: this.descriptor,
          dataDir: this.dataDir,
          provider: {
            url: provider.url,
            waterfalls: provider.waterfalls,
            concurrency: providerConcurrency(provider)
          }
        }
      });
      let settled = false;
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`worker fullScan timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        outcome();
      };
      worker.on("message", (msg: { ok: boolean; bytes?: Uint8Array | null; error?: string }) => {
        if (msg.ok) {
          finish(() => resolve(msg.bytes ? new Uint8Array(msg.bytes) : null));
        } else {
          finish(() => reject(new Error(msg.error ?? "worker scan failed")));
        }
      });
      worker.on("error", (err) => finish(() => reject(err)));
      worker.on("exit", (code) => {
        finish(() => reject(new Error(`worker exited before result (code ${code})`)));
      });
    });
  }

  private async persistUpdate(statusBefore: string, bytes: Uint8Array): Promise<void> {
    const now = Date.now();
    try {
      await this.updateStore.putUpdate(statusBefore, bytes);
      await this.updateStore.writeMeta({ lastScanAt: now, lastSuccessAt: now });
    } catch (err) {
      // The scan still applied in memory; record why persistence failed so
      // diagnostics can distinguish disk errors (§2.5 — lastPersistErrorName).
      const errName = (err as Error)?.name ?? null;
      this.logger.warn("failed to persist update chain link", { error: String(err) });
      try {
        await this.updateStore.writeMeta({
          lastScanAt: now,
          lastPersistFailedAt: now,
          lastPersistErrorName: errName
        });
      } catch {
        // best effort
      }
    }
  }

  /**
   * Broadcast a finalized PSET through the provider chain (rotation from
   * lastGoodProviderIndex; BROADCAST_FAILED only when ALL providers refuse —
   * parity with wallet.js broadcastFinalized).
   */
  async broadcast(pset: Pset): Promise<string> {
    const startIndex = Math.min(this.lastGoodProviderIndex, this.providers.length - 1);
    const failures: string[] = [];
    for (let step = 0; step < this.providers.length; step++) {
      const idx = (startIndex + step) % this.providers.length;
      const provider = this.providers[idx]!;
      const client = this.buildClient(provider);
      try {
        const txid = await client.broadcast(pset);
        this.lastGoodProviderIndex = idx;
        return typeof txid === "string" ? txid : String(txid);
      } catch (err) {
        failures.push(`${provider.name}: ${String((err as Error)?.message ?? err)}`);
      } finally {
        client.free?.();
      }
    }
    throw new WalletError(
      "BROADCAST_FAILED",
      `Broadcast rejected by all providers (${failures.join(" | ")})`
    );
  }

  /**
   * Re-broadcast a raw signed tx by its consensus hex (spec §3.2.9 resume).
   * The bytes are NEVER re-derived — the caller re-broadcasts exactly what it
   * signed and persisted, so this can never double-pay. A provider reporting
   * the tx as already known/duplicate is treated as SUCCESS (the earlier
   * broadcast propagated); BROADCAST_FAILED only when ALL providers hard-fail.
   * A fresh Transaction is parsed per attempt (wasm objects are consumed).
   */
  async broadcastRawTx(txHex: string): Promise<string> {
    const localTxid = Transaction.fromString(txHex).txid().toString();
    const startIndex = Math.min(this.lastGoodProviderIndex, this.providers.length - 1);
    const failures: string[] = [];
    for (let step = 0; step < this.providers.length; step++) {
      const idx = (startIndex + step) % this.providers.length;
      const provider = this.providers[idx]!;
      const client = this.buildClient(provider);
      try {
        if (!client.broadcastTx) {
          throw new WalletError("BROADCAST_FAILED", "Esplora client has no broadcastTx");
        }
        await client.broadcastTx(Transaction.fromString(txHex));
        this.lastGoodProviderIndex = idx;
        // The provider's returned Txid is telemetry-only (§3.2.7); return the
        // locally-derived txid (same value, already a string) so the result
        // never depends on the wasm Txid.toString() shape — identical to the
        // already-known branch below.
        return localTxid;
      } catch (err) {
        const message = String((err as Error)?.message ?? err);
        if (ALREADY_KNOWN_RE.test(message)) {
          this.lastGoodProviderIndex = idx;
          this.logger.info("re-broadcast: tx already known — treating as success", {
            provider: provider.name,
            txid: localTxid
          });
          return localTxid;
        }
        failures.push(`${provider.name}: ${message}`);
      } finally {
        client.free?.();
      }
    }
    throw new WalletError(
      "BROADCAST_FAILED",
      `Re-broadcast rejected by all providers (${failures.join(" | ")})`
    );
  }
}

/** Internal: worker-produced update did not apply to the main-thread wollet. */
class ApplyDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyDriftError";
  }
}
