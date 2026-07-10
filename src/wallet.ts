// DepixWallet — the public facade (spec §2.3, mirroring wallet.js:2875-2918
// adapted to headless Node).
//
// Lifecycle: open() / create() / restore() acquire the exclusive dataDir lock
// (§2.4) and hold it until close(). open() NEVER auto-creates a seed
// (WALLET_NOT_FOUND). The passphrase stays in process memory; the decrypted
// mnemonic/signer only materialize inside each signing operation and are
// zeroed in a finally block (per-op auth, frontend parity).
//
// Backup gate (§2.9/G12): no receive address is derived before a backup was
// exported AND confirmed — since every inflow needs an address, no funds can
// enter an unbacked wallet. restore() is proof of possession and is born
// confirmed; non-interactive create() only skips the gate with an explicit
// `mnemonicSecured: true`.

import { homedir } from "node:os";
import { join } from "node:path";
import type { Wollet } from "lwk_node";
import { ASSETS, DEPIX_SATS_PER_BRL_CENT, MAINNET_ASSET_ID_TO_KEY, type AssetKey } from "./assets.js";
import { runBackupRitual, type RitualIo } from "./backup-ritual.js";
import {
  Address,
  AssetId,
  Mnemonic,
  Signer,
  TxBuilder,
  buildWollet,
  descriptorFromMnemonic,
  generateMnemonic,
  mainnetNetwork,
  validateMnemonic
} from "./engine/lwk.js";
import { GuardrailError, WalletError } from "./errors.js";
import { Guardrails } from "./guardrails/guardrails.js";
import { createLogger, registerSecret, type Logger } from "./logger.js";
import { assertStrongPassphrase } from "./store/crypto.js";
import { acquireDirLock, type DirLock } from "./store/dir-lock.js";
import { ensureDir } from "./store/fs-util.js";
import { SeedStore, type WalletFileV1 } from "./store/seed-store.js";
import { UpdateStore } from "./store/update-store.js";
import { SyncEngine, type EsploraProvider } from "./sync/sync.js";

export interface WalletSyncOptions {
  /** Override the Esplora provider chain (default: waterfalls→vanilla §2.6). */
  providers?: EsploraProvider[];
  /** Run fullScan in a worker_thread (§2.7). Default ON. */
  worker?: boolean;
}

export interface OpenOptions {
  /** Default: $DEPIX_WALLET_DIR ?? ~/.depix-wallet */
  dataDir?: string;
  /** Default: $DEPIX_WALLET_PASSPHRASE (required when a seed exists) */
  passphrase?: string;
  sync?: WalletSyncOptions;
  // TODO(PR2): apiKey/apiBase (api/client.ts — Bearer sk_, Idempotency-Key).
  // TODO(PR3): guardrails?: GuardrailConfig (§4.2 — option > env > default;
  // PR1 runs the hardcoded R$100/tx + R$500/day defaults, not configurable).
}

export interface CreateOptions extends OpenOptions {
  /** Import this mnemonic instead of generating one (12 words, English). */
  mnemonic?: string;
  /**
   * Non-interactive escape hatch (§2.9): the mnemonic is returned in the
   * foreground; only an EXPLICIT true makes the wallet be born
   * backup-confirmed. Skipping the backup is a conscious, logged decision —
   * never a silent default.
   */
  mnemonicSecured?: boolean;
  /** Override TTY detection (tests/advanced). */
  interactive?: boolean;
  /** Inject ritual I/O (tests). */
  ritualIo?: RitualIo;
}

export interface RestoreOptions extends OpenOptions {
  mnemonic: string;
}

export interface CreateResult {
  /** The 12 words, in the foreground — impossible not to receive (§2.9). */
  mnemonic: string;
  descriptor: string;
  backupConfirmed: boolean;
  wallet: DepixWallet;
}

export interface BackupTarget {
  kind: "mnemonic";
}

export interface MnemonicBackup {
  kind: "mnemonic";
  mnemonic: string;
}

export interface WalletBalances {
  balances: Record<AssetKey, bigint>;
  /** BRL estimate arrives with /api/quotes valuation in PR3 (§4.4). */
  brlEstimate: number | null;
}

export interface WalletTransaction {
  txid: string;
  height: number | null;
  timestamp: number | null;
  type: string;
  feeSats: bigint;
  /** Net balance deltas keyed by asset (AssetKey when known, raw hex id otherwise). */
  balance: Record<string, bigint>;
}

export interface SendParams {
  asset: AssetKey;
  amountSats: bigint;
  address: string;
}

export interface SendResult {
  txid: string;
}

function resolveDataDir(explicit?: string): string {
  return explicit ?? process.env.DEPIX_WALLET_DIR ?? join(homedir(), ".depix-wallet");
}

function resolvePassphrase(explicit?: string): string | undefined {
  return explicit ?? process.env.DEPIX_WALLET_PASSPHRASE;
}

async function runRitual(mnemonic: string, io?: RitualIo): Promise<boolean> {
  if (io) return runBackupRitual(mnemonic, io);
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await runBackupRitual(mnemonic, {
      // The ritual only runs on a real TTY (checked by the caller): stdout is
      // the interactive terminal here, not an MCP JSON-RPC channel.
      write: (text) => void process.stdout.write(`${text}\n`),
      question: (prompt) => rl.question(prompt)
    });
  } finally {
    rl.close();
  }
}

interface WalletParts {
  dataDir: string;
  passphrase: string | undefined;
  seedStore: SeedStore;
  file: WalletFileV1;
  lock: DirLock;
  sync?: WalletSyncOptions;
}

export class DepixWallet {
  private readonly dataDir: string;
  private readonly seedStore: SeedStore;
  private readonly updateStore: UpdateStore;
  private readonly syncEngine: SyncEngine;
  private readonly guardrails: Guardrails;
  private readonly logger: Logger;
  private readonly passphrase: string | undefined;
  private file: WalletFileV1;
  private lock: DirLock | null;
  private wollet: Wollet | null = null;
  private wolletReady = false;

  private constructor(parts: WalletParts) {
    this.dataDir = parts.dataDir;
    this.seedStore = parts.seedStore;
    this.file = parts.file;
    this.lock = parts.lock;
    this.passphrase = parts.passphrase;
    this.logger = createLogger();
    this.updateStore = new UpdateStore(parts.dataDir);
    this.guardrails = new Guardrails({ dataDir: parts.dataDir, logger: this.logger });
    this.syncEngine = new SyncEngine({
      descriptor: this.requireDescriptor(),
      dataDir: parts.dataDir,
      updateStore: this.updateStore,
      providers: parts.sync?.providers,
      worker: parts.sync?.worker,
      logger: this.logger
    });
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────

  /**
   * Open an existing wallet. NEVER auto-creates a seed — a dataDir without a
   * wallet fails with WALLET_NOT_FOUND instructing the create quickstart.
   */
  static async open(options: OpenOptions = {}): Promise<DepixWallet> {
    const dataDir = resolveDataDir(options.dataDir);
    const passphrase = resolvePassphrase(options.passphrase);
    const seedStore = new SeedStore(dataDir);
    const file = await seedStore.read();
    if (!file) {
      throw new WalletError(
        "WALLET_NOT_FOUND",
        `No wallet in ${dataDir}. Run DepixWallet.create() (see the quickstart) — ` +
          "the SDK never creates a seed automatically."
      );
    }
    if (file.encryptedSeed) {
      assertStrongPassphrase(passphrase as string);
      registerSecret(passphrase);
    }
    await ensureDir(dataDir);
    const lock = await acquireDirLock(dataDir);
    try {
      if (file.encryptedSeed) {
        // Validate the passphrase eagerly (fail fast with WRONG_PASSPHRASE);
        // the plaintext is registered for log redaction and dropped here —
        // signing re-materializes it per operation.
        const mnemonic = await seedStore.decryptMnemonic(passphrase as string);
        registerSecret(mnemonic);
      }
      return new DepixWallet({ dataDir, passphrase, seedStore, file, lock, sync: options.sync });
    } catch (err) {
      await lock.release();
      throw err;
    }
    // TODO(PR2): auto-run resumePendingWithdrawals() here (§3.2.9, opt-out
    // via option) once the withdraw flow and its pending store exist.
  }

  /**
   * Create a wallet (§2.9). Interactive TTY runs the backup ritual; in
   * non-interactive mode the mnemonic is returned in the foreground and the
   * wallet is only born confirmed with an explicit `mnemonicSecured: true`.
   */
  static async create(options: CreateOptions = {}): Promise<CreateResult> {
    const dataDir = resolveDataDir(options.dataDir);
    const passphrase = resolvePassphrase(options.passphrase);
    assertStrongPassphrase(passphrase as string);
    registerSecret(passphrase);
    const mnemonic =
      options.mnemonic !== undefined ? validateMnemonic(options.mnemonic) : generateMnemonic();
    registerSecret(mnemonic);
    const descriptor = descriptorFromMnemonic(mnemonic);

    await ensureDir(dataDir);
    const lock = await acquireDirLock(dataDir);
    try {
      const seedStore = new SeedStore(dataDir);
      if ((await seedStore.read()) !== null) {
        throw new WalletError(
          "WALLET_ALREADY_EXISTS",
          `A wallet already exists in ${dataDir}. Open it, restore over it, or use another dataDir.`
        );
      }
      await seedStore.initialize({
        passphrase: passphrase as string,
        mnemonic,
        descriptor,
        backupConfirmed: false
      });

      let backupConfirmed = false;
      if (options.mnemonicSecured === true) {
        backupConfirmed = true;
      } else {
        const interactive =
          options.interactive ??
          (process.stdin.isTTY === true && process.stdout.isTTY === true);
        if (interactive) {
          backupConfirmed = await runRitual(mnemonic, options.ritualIo);
        }
      }
      if (backupConfirmed) {
        await seedStore.setBackupConfirmed(true);
      }
      const file = (await seedStore.read())!;
      const wallet = new DepixWallet({
        dataDir,
        passphrase,
        seedStore,
        file,
        lock,
        sync: options.sync
      });
      return { mnemonic, descriptor, backupConfirmed, wallet };
    } catch (err) {
      await lock.release();
      throw err;
    }
  }

  /**
   * Restore from a mnemonic. Providing the mnemonic IS proof of possession —
   * the wallet is born backupConfirmed (§2.9). DESCRIPTOR_MISMATCH when the
   * dataDir holds a different wallet's descriptor.
   */
  static async restore(options: RestoreOptions): Promise<DepixWallet> {
    const dataDir = resolveDataDir(options.dataDir);
    const passphrase = resolvePassphrase(options.passphrase);
    assertStrongPassphrase(passphrase as string);
    registerSecret(passphrase);
    const mnemonic = validateMnemonic(options.mnemonic);
    registerSecret(mnemonic);
    const descriptor = descriptorFromMnemonic(mnemonic);

    await ensureDir(dataDir);
    const lock = await acquireDirLock(dataDir);
    try {
      const seedStore = new SeedStore(dataDir);
      const existing = await seedStore.read();
      if (existing?.descriptor && existing.descriptor !== descriptor) {
        throw new WalletError(
          "DESCRIPTOR_MISMATCH",
          "This mnemonic derives a different wallet than the one in this dataDir."
        );
      }
      await seedStore.initialize({
        passphrase: passphrase as string,
        mnemonic,
        descriptor,
        backupConfirmed: true
      });
      const file = (await seedStore.read())!;
      return new DepixWallet({ dataDir, passphrase, seedStore, file, lock, sync: options.sync });
    } catch (err) {
      await lock.release();
      throw err;
    }
  }

  /** Release the dataDir lock and free wasm resources. */
  async close(): Promise<void> {
    if (this.wollet) {
      try {
        this.wollet.free();
      } catch {
        // best effort
      }
      this.wollet = null;
      this.wolletReady = false;
    }
    if (this.lock) {
      await this.lock.release();
      this.lock = null;
    }
  }

  // ─── backup gate (§2.9) ────────────────────────────────────────────────

  isBackupConfirmed(): boolean {
    return this.file.backupConfirmed === true;
  }

  /** Export the seed backup. Default target: the 12-word mnemonic. */
  async exportBackup(target: BackupTarget = { kind: "mnemonic" }): Promise<MnemonicBackup> {
    if (target.kind !== "mnemonic") {
      throw new TypeError(`Unknown backup target kind: ${String(target.kind)}`);
    }
    const mnemonic = await this.decryptMnemonic();
    return { kind: "mnemonic", mnemonic };
  }

  /** Sugar for exportBackup({ kind: "mnemonic" }).mnemonic. */
  async exportMnemonic(): Promise<string> {
    return (await this.exportBackup()).mnemonic;
  }

  /** Persist backupConfirmed: true (durable §2.4 recipe). */
  async confirmBackup(): Promise<void> {
    this.assertOpen();
    await this.seedStore.setBackupConfirmed(true);
    await this.refreshFile();
  }

  private assertBackupConfirmed(): void {
    if (!this.isBackupConfirmed()) {
      throw new WalletError(
        "BACKUP_REQUIRED",
        "Receive addresses are blocked until the seed backup is exported and confirmed. " +
          "Call exportBackup() (default: the 12-word mnemonic), store it with the guardian, " +
          "then confirmBackup(). restore() from an existing mnemonic is always born confirmed."
      );
    }
  }

  // ─── read surface ──────────────────────────────────────────────────────

  getDescriptor(): string {
    return this.requireDescriptor();
  }

  /**
   * Fresh receive address per call (§3.1, decision 2026-07-10): LWK's
   * address(null) returns the last UNUSED index — two deposits before the
   * first QR is paid would reuse the same address. The SDK keeps a persisted
   * monotonic nextReceiveIndex and derives max(lwk_last_unused, next),
   * bumping and persisting the counter BEFORE returning. All addresses come
   * from the same descriptor, so one sync sees them all; zero on-chain reuse.
   */
  async getReceiveAddress(options: { index?: number } = {}): Promise<string> {
    this.assertOpen();
    this.assertBackupConfirmed();
    const wollet = await this.ensureWollet();
    if (typeof options.index === "number") {
      return wollet.address(options.index).address().toString();
    }
    const lastUnused = wollet.address(null).index();
    const next = this.file.nextReceiveIndex ?? 0;
    const idx = Math.max(lastUnused, next);
    await this.seedStore.setNextReceiveIndex(idx + 1);
    await this.refreshFile();
    return wollet.address(idx).address().toString();
  }

  async getBalances(): Promise<WalletBalances> {
    this.assertOpen();
    const wollet = await this.ensureWollet();
    const balances: Record<AssetKey, bigint> = { DEPIX: 0n, USDT: 0n, LBTC: 0n };
    const entries = wollet.balance().entries() as Iterable<[unknown, unknown]>;
    for (const [assetId, amount] of entries) {
      const key = MAINNET_ASSET_ID_TO_KEY[String(assetId)];
      if (key) balances[key] = BigInt(amount as bigint);
    }
    // TODO(PR3): brlEstimate via GET /api/quotes (§4.4 — fresh 30s/stale 5min).
    return { balances, brlEstimate: null };
  }

  async listTransactions(): Promise<WalletTransaction[]> {
    this.assertOpen();
    const wollet = await this.ensureWollet();
    return wollet.transactions().map((tx) => {
      const balance: Record<string, bigint> = {};
      const entries = tx.balance().entries() as Iterable<[unknown, unknown]>;
      for (const [assetId, amount] of entries) {
        const key = MAINNET_ASSET_ID_TO_KEY[String(assetId)] ?? String(assetId);
        balance[key] = BigInt(amount as bigint);
      }
      return {
        txid: tx.txid().toString(),
        height: tx.height() ?? null,
        timestamp: tx.timestamp() ?? null,
        type: tx.txType(),
        feeSats: tx.fee(),
        balance
      };
    });
  }

  /** Sync against the provider chain (§2.6), worker fullScan by default (§2.7). */
  async sync(): Promise<{ updated: boolean }> {
    this.assertOpen();
    const wollet = await this.ensureWollet();
    return this.syncEngine.sync(wollet);
  }

  // ─── money ─────────────────────────────────────────────────────────────

  /**
   * Send an asset to a Liquid address, signed locally (§2.3).
   * EVERY send goes through the guardrail choke point BEFORE signing (§4.3):
   * per-tx and rolling-24h daily BRL caps with hardcoded defaults — main
   * never has a signing path without a ceiling. DePix values 1:1 to BRL;
   * L-BTC/USDt valuation needs /api/quotes (PR3) and fails CLOSED with
   * QUOTES_UNAVAILABLE until then (§4.4/G6).
   */
  async send(params: SendParams): Promise<SendResult> {
    this.assertOpen();
    const asset = ASSETS[params.asset];
    if (!asset) {
      throw new WalletError("UNSUPPORTED_ASSET", `Unknown asset: ${String(params.asset)}`);
    }
    if (typeof params.amountSats !== "bigint" || params.amountSats <= 0n) {
      throw new WalletError("INVALID_AMOUNT", "amountSats must be a positive bigint");
    }
    let address: InstanceType<typeof Address>;
    try {
      address = new Address(params.address);
    } catch (err) {
      throw new WalletError("INVALID_ADDRESS", `Not a valid Liquid address: ${params.address}`, {
        cause: err
      });
    }

    // Choke point (§4.3) — BEFORE anything is built or signed.
    const brlCents = this.valuateBrlCents(asset.key, params.amountSats);
    await this.guardrails.enforce({ kind: "send", brlCents });

    const wollet = await this.ensureWollet();
    const network = mainnetNetwork();
    let builder = new TxBuilder(network);
    try {
      if (asset.key === "LBTC") {
        builder = builder.addLbtcRecipient(address, params.amountSats);
      } else {
        builder = builder.addRecipient(address, params.amountSats, new AssetId(asset.id));
      }
    } catch (err) {
      throw new WalletError("INVALID_ADDRESS", "Recipient rejected by the transaction builder", {
        cause: err
      });
    }

    let pset;
    try {
      pset = builder.finish(wollet);
    } catch (err) {
      throw await this.classifyFinishError(err, asset.key, params.amountSats);
    }

    // Materialize the signer for this operation only and zero it in finally
    // (per-op auth — wallet.js:2601-2607 parity). JS strings are immutable,
    // so the best available "zeroing" for the decrypted mnemonic is freeing
    // the wasm-side objects and dropping every reference on scope exit.
    let signed;
    {
      let mnemonic: InstanceType<typeof Mnemonic> | null = null;
      let signer: InstanceType<typeof Signer> | null = null;
      try {
        mnemonic = new Mnemonic(await this.decryptMnemonic());
        signer = new Signer(mnemonic, network);
        signed = signer.sign(pset);
      } finally {
        try {
          signer?.free();
          mnemonic?.free();
        } catch {
          // best effort
        }
      }
    }

    // Accounted at SIGNING time, not settlement (§4.5) — a failed broadcast
    // still counts against the window (the tx may propagate later).
    await this.guardrails.recordSpend(brlCents, "send");

    const finalized = wollet.finalize(signed);
    const txid = await this.syncEngine.broadcast(finalized);
    return { txid };
  }

  /** Selective wipe (§2.4): view-only survives, restore detects mismatch. */
  async wipe(): Promise<void> {
    this.assertOpen();
    await this.seedStore.wipeSeed();
    await this.refreshFile();
  }

  // ─── internals ─────────────────────────────────────────────────────────

  /**
   * BRL valuation (§4.4). DePix: 1:1 peg — ceil(amountSats / 10^6) cents
   * (rounding UP so limits cannot be shaved). L-BTC/USDt: needs /api/quotes
   * (PR3) → fail CLOSED with QUOTES_UNAVAILABLE (G6): failing open would make
   * the cap bypassable by taking down a public endpoint.
   */
  private valuateBrlCents(asset: AssetKey, amountSats: bigint): number {
    if (asset === "DEPIX") {
      const cents = (amountSats + DEPIX_SATS_PER_BRL_CENT - 1n) / DEPIX_SATS_PER_BRL_CENT;
      return Number(cents);
    }
    // TODO(PR3): usdBrl / btcUsd×usdBrl valuation via GET /api/quotes with
    // fresh-30s/stale-5min cache (§4.4) — until then, fail closed.
    throw new GuardrailError(
      "QUOTES_UNAVAILABLE",
      `BRL valuation for ${asset} requires quotes (not available in this build) — ` +
        "signing is blocked for non-DePix assets (fail-closed, spec §4.4)."
    );
  }

  private async classifyFinishError(
    err: unknown,
    asset: AssetKey,
    amountSats: bigint
  ): Promise<WalletError> {
    const message = String((err as Error)?.message ?? err ?? "").toLowerCase();
    const insufficient = message.includes("insufficient") || message.includes("not enough");
    if (!insufficient) {
      return new WalletError("INVALID_AMOUNT", "Transaction build failed", { cause: err });
    }
    // Distinguish "not enough of the asset" from "enough asset, no L-BTC for
    // the network fee" (frontend parity, wallet.js:1985-2040).
    if (asset !== "LBTC") {
      try {
        const { balances } = await this.getBalances();
        if (balances[asset] >= amountSats) {
          return new WalletError(
            "INSUFFICIENT_LBTC_FOR_FEE",
            "Not enough L-BTC to pay the network fee — convert a little to L-BTC and retry",
            { cause: err }
          );
        }
      } catch {
        // fall through to INSUFFICIENT_FUNDS
      }
    }
    return new WalletError("INSUFFICIENT_FUNDS", "Insufficient funds for this send", {
      cause: err
    });
  }

  private async decryptMnemonic(): Promise<string> {
    // Seed presence first: a wiped (view-only) wallet reports the truthful
    // WALLET_NOT_FOUND instead of demanding a passphrase it cannot use.
    if (!this.file.encryptedSeed) {
      throw new WalletError(
        "WALLET_NOT_FOUND",
        `No wallet seed in ${this.dataDir} (wiped or view-only). Use DepixWallet.restore().`
      );
    }
    const mnemonic = await this.seedStore.decryptMnemonic(this.requirePassphrase());
    registerSecret(mnemonic);
    return mnemonic;
  }

  private requirePassphrase(): string {
    if (typeof this.passphrase !== "string") {
      throw new WalletError(
        "WEAK_PASSPHRASE",
        "A passphrase is required for this operation (set DEPIX_WALLET_PASSPHRASE)"
      );
    }
    return this.passphrase;
  }

  private requireDescriptor(): string {
    const descriptor = this.file.descriptor;
    if (!descriptor) {
      throw new WalletError("WALLET_NOT_FOUND", "Wallet record has no descriptor");
    }
    return descriptor;
  }

  private assertOpen(): void {
    if (!this.lock) {
      throw new WalletError("WALLET_NOT_FOUND", "Wallet is closed — open() it again");
    }
  }

  private async refreshFile(): Promise<void> {
    const file = await this.seedStore.read();
    if (file) this.file = file;
  }

  private async ensureWollet(): Promise<Wollet> {
    if (this.wollet && this.wolletReady) return this.wollet;
    if (!this.wollet) {
      this.wollet = buildWollet(this.requireDescriptor());
    }
    await this.syncEngine.loadPersisted(this.wollet);
    this.wolletReady = true;
    return this.wollet;
  }
}
