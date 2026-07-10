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
import { base64 } from "@scure/base";
import type { Wollet } from "lwk_node";
import { ASSETS, MAINNET_ASSET_ID_TO_KEY, type AssetKey } from "./assets.js";
import { runBackupRitual, type RitualIo } from "./backup-ritual.js";
import {
  Address,
  AssetId,
  Mnemonic,
  Pset,
  Signer,
  TxBuilder,
  buildWollet,
  descriptorFromMnemonic,
  generateMnemonic,
  mainnetNetwork,
  validateMnemonic
} from "./engine/lwk.js";
import {
  DepixApiClient,
  type FetchLike,
  type StatusReadResponse,
  type WithdrawRequestBody,
  type WithdrawWireResponse
} from "./api/client.js";
import { DepixApiError, WalletError } from "./errors.js";
import {
  assertFeeAddressExplicit,
  assertSplitConsistent,
  assertWithdrawPsetOutputs,
  centsToDepixSats,
  normalizeWithdrawResponse,
  type NormalizedWithdraw,
  type WithdrawMode
} from "./flows/withdraw.js";
import { waitForDeposit as pollDeposit, waitForWithdrawal as pollWithdrawal, type WaitOptions } from "./flows/status.js";
import { PendingWithdrawals } from "./pending.js";
import {
  Guardrails,
  resolveGuardrailConfig,
  type GuardrailAnchorStore,
  type GuardrailConfig,
  type ResolvedGuardrailConfig
} from "./guardrails/guardrails.js";
import { QuotesClient, resolveApiBase as resolveQuotesApiBase, type QuotesSource } from "./guardrails/quotes.js";
import { BrlValuator } from "./guardrails/valuation.js";
import { createLogger, registerSecret, type Logger } from "./logger.js";
import { Mutex } from "./mutex.js";
import {
  assertStrongPassphrase,
  deriveKeyBytes,
  deriveStateSubkey,
  importAesKey
} from "./store/crypto.js";
import { acquireDirLock, type DirLock } from "./store/dir-lock.js";
import { ensureDir } from "./store/fs-util.js";
import { SeedStore, type WalletFileV1 } from "./store/seed-store.js";
import { UpdateStore } from "./store/update-store.js";
import { SyncEngine, type EsploraClientLike, type EsploraProvider } from "./sync/sync.js";
import { ConvertNamespace, type ConvertNamespaceOptions } from "./convert/namespace.js";
import type { ConvertWalletHooks } from "./convert/hooks.js";
import type { GuardrailDestination } from "./guardrails/allowlist.js";
import { BoltzConvert, type BoltzConvertDeps } from "./convert/boltz/convert.js";
import { BoltzSwapStore } from "./convert/boltz/store.js";

export interface WalletSyncOptions {
  /** Override the Esplora provider chain (default: waterfalls→vanilla §2.6). */
  providers?: EsploraProvider[];
  /** Run fullScan in a worker_thread (§2.7). Default ON. */
  worker?: boolean;
  /** Advanced/testing: inject fake Esplora clients (broadcast seam). */
  clientFactory?: (provider: EsploraProvider) => EsploraClientLike;
}

export interface OpenOptions {
  /** Default: $DEPIX_WALLET_DIR ?? ~/.depix-wallet */
  dataDir?: string;
  /** Default: $DEPIX_WALLET_PASSPHRASE (required when a seed exists) */
  passphrase?: string;
  sync?: WalletSyncOptions;
  /**
   * Guardrail config (§4.2). Option > env (DEPIX_GUARDRAIL_*) > default
   * (R$100/tx + R$500/day). IMMUTABLE at runtime (G9): set only here (or via
   * env) + restart — there is no update method an injected LLM could reach.
   */
  guardrails?: GuardrailConfig;
  /**
   * Advanced/testing: inject the /api/quotes source used for L-BTC/USDt BRL
   * valuation (§4.4). Default: a QuotesClient against apiBase (env DEPIX_API_BASE
   * ?? https://api.depixapp.com), fresh 30s / stale 5min.
   */
  quotes?: QuotesSource;
  /** Default: $DEPIX_API_KEY (sk_test_/sk_live_) — required for deposit/withdraw/waitFor. */
  apiKey?: string;
  /** Default: $DEPIX_API_BASE ?? https://api.depixapp.com. */
  apiBase?: string;
  /** Advanced/testing: inject the fetch implementation of the API client. */
  fetch?: FetchLike;
  /**
   * Auto-run resumePendingWithdrawals() on open() (§3.2.9). Default true — an
   * MCP-only agent has no other path to recover after a crash. Opt out here.
   */
  resumePendingWithdrawalsOnOpen?: boolean;
  /**
   * Advanced/testing: inject the SideSwap client factory / foreign-PSET signer /
   * clock used by wallet.convert.sideswap.* (§5). Default: the real WS client
   * and lwk signer.
   */
  convert?: ConvertNamespaceOptions;
  /**
   * Advanced/testing: inject the Boltz conversion deps (fake REST/WS client,
   * verify-lockup / refund / reverse overrides) so the wallet.convert.boltz
   * flows never touch real Boltz or WASM (§5.3).
   */
  boltz?: BoltzConvertDeps;
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
  /** Total BRL estimate in integer cents (§4.4); null if any needed quote is unavailable. */
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

export interface DepositParams {
  /** Deposit amount in BRL cents (R$ 5,00–R$ 3.000,00 server-side). */
  amountCents: number;
  /** CPF/CNPJ of the OWNER who will pay the QR (wire: payer_tax_number, §2.3). */
  payerTaxNumber: string;
}

export interface DepositResult {
  id: string;
  qrCopyPaste: string;
  sandbox?: true;
}

export interface WithdrawParams {
  pixKey: string;
  /** CPF/CNPJ of the destination Pix key HOLDER (wire: taxNumber, §2.3). */
  recipientTaxNumber: string;
  amountCents: number;
  /** "send" → depositAmountInCents (você envia); "payout" → payoutAmountInCents (você recebe). */
  mode: WithdrawMode;
}

/** Normative return of withdraw() (§2.3). txid is null only in sandbox. */
export interface WithdrawResult {
  withdrawalId: string;
  txid: string | null;
  feeCents: number | null;
  feeAddress: string | null;
  netCents: number;
  grossCents: number;
  payoutCents: number;
  sandbox?: true;
}

export interface ResumeSummary {
  /** rebroadcast + reposted. */
  resumed: number;
  /** "signed" records re-broadcast with the SAME bytes. */
  rebroadcast: number;
  /** "requested" records re-POSTed with the same Idempotency-Key + re-validated. */
  reposted: number;
  /** records that failed GCM authentication and were discarded (§3.2.9). */
  discarded: number;
  /** records that could not be resumed this pass. */
  failed: number;
}

function resolveDataDir(explicit?: string): string {
  return explicit ?? process.env.DEPIX_WALLET_DIR ?? join(homedir(), ".depix-wallet");
}

function resolvePassphrase(explicit?: string): string | undefined {
  return explicit ?? process.env.DEPIX_WALLET_PASSPHRASE;
}

function resolveApiKey(explicit?: string): string | undefined {
  return explicit ?? process.env.DEPIX_API_KEY;
}

function resolveApiBase(explicit?: string): string | undefined {
  return explicit ?? process.env.DEPIX_API_BASE;
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
  /** Resolved guardrail config (§4.2) — immutable, plumbed from open()/env. */
  guardrailConfig: ResolvedGuardrailConfig;
  /** Injected quotes source, or undefined for the default QuotesClient (§4.4). */
  quotes?: QuotesSource;
  apiKey?: string;
  apiBase?: string;
  apiFetch?: FetchLike;
  /** SideSwap client/signer/clock injection for wallet.convert.* (§5). */
  convert?: ConvertNamespaceOptions;
  /** Injected Boltz conversion deps (§5.3) — advanced/testing. */
  boltz?: BoltzConvertDeps;
}

export class DepixWallet {
  private readonly dataDir: string;
  private readonly seedStore: SeedStore;
  private readonly updateStore: UpdateStore;
  private readonly syncEngine: SyncEngine;
  private readonly guardrails: Guardrails;
  private readonly valuator: BrlValuator;
  /** Conversions (§5): wallet.convert.sideswap.* (PR4); PR5 adds .boltz. */
  readonly convert: ConvertNamespace;
  private readonly logger: Logger;
  private readonly passphrase: string | undefined;
  // Pix flows (PR2) — null when no apiKey / no seed. deposit/withdraw/waitFor
  // surface a clear error rather than a confusing crash when they are missing.
  private readonly api: DepixApiClient | null;
  private readonly pending: PendingWithdrawals | null;
  // Boltz conversion holder (§2.3, §5.3). null on a view-only/wiped wallet (no
  // seed to sign the L-BTC lockup / no key to authenticate the swap store). The
  // same BoltzConvert instance is exposed as wallet.convert.boltz; this private
  // handle lets close() dispose its in-flight watches (.sideswap lives on the
  // ConvertNamespace `convert` field).
  private readonly convertNamespace: { boltz: BoltzConvert } | null;
  private file: WalletFileV1;
  private lock: DirLock | null;
  private wollet: Wollet | null = null;
  private wolletReady = false;
  private wolletPromise: Promise<Wollet> | null = null;
  // Memoized key material for the seed store + guardrails-state (§4.5). Argon2id
  // over passphrase+salt is deliberately expensive, so it runs at most once per
  // process; the raw bytes feed BOTH the seed AES key (seed encrypt/decrypt +
  // anchor re-encryption) AND the HKDF-derived state subkey (state file), which
  // domain-separates the two keystreams (review low, state-crypto.ts:14).
  private rootKeyBytesPromise: Promise<Uint8Array> | null = null;
  private seedKeyPromise: Promise<CryptoKey> | null = null;
  private guardrailKeyPromise: Promise<CryptoKey> | null = null;
  // Serializes the guardrail choke point (enforce→sign→record) and the
  // nextReceiveIndex read-modify-write against concurrent in-process calls
  // (§4.3 TOCTOU fix; the dataDir lock only guards across processes).
  private readonly opMutex = new Mutex();

  private constructor(parts: WalletParts) {
    this.dataDir = parts.dataDir;
    this.seedStore = parts.seedStore;
    this.file = parts.file;
    this.lock = parts.lock;
    this.passphrase = parts.passphrase;
    this.logger = createLogger();
    this.updateStore = new UpdateStore(parts.dataDir);
    this.valuator = new BrlValuator(parts.quotes ?? new QuotesClient({ apiBase: resolveQuotesApiBase() }));
    // Seed-bound anchor backed by wallet.json's authenticated envelope (§4.5).
    // The marker + monotonic epoch are covered by the seed's GCM AAD, so an
    // injected agent cannot strip the marker (it bricks seed decryption) nor roll
    // the epoch back (no passphrase); advance() re-encrypts the seed under the
    // bumped anchor and durably rewrites wallet.json.
    const anchor: GuardrailAnchorStore = {
      read: () => this.seedStore.readGuardrailAnchor(),
      advance: async () => {
        const epoch = await this.seedStore.advanceGuardrailAnchor(await this.seedKey());
        // wallet.json's iv + anchor fields changed on disk — refresh the cache so
        // a subsequent decrypt uses the current AAD.
        await this.refreshFile();
        return epoch;
      }
    };
    this.guardrails = new Guardrails({
      dataDir: parts.dataDir,
      config: parts.guardrailConfig,
      stateKey: () => this.guardrailStateKey(),
      anchor,
      logger: this.logger
    });
    this.syncEngine = new SyncEngine({
      descriptor: this.requireDescriptor(),
      dataDir: parts.dataDir,
      updateStore: this.updateStore,
      providers: parts.sync?.providers,
      worker: parts.sync?.worker,
      clientFactory: parts.sync?.clientFactory,
      logger: this.logger
    });
    // API client — only when an apiKey is configured. Its base defaults to the
    // canonical host inside the client.
    this.api = parts.apiKey
      ? new DepixApiClient({
          apiKey: parts.apiKey,
          apiBase: parts.apiBase,
          fetch: parts.apiFetch,
          logger: this.logger
        })
      : null;
    // Pending-withdrawals store — needs the seed-store key material (passphrase
    // + wallet salt). A view-only/wiped wallet cannot withdraw, so it has none.
    this.pending =
      parts.passphrase && parts.file.salt
        ? new PendingWithdrawals({
            dataDir: parts.dataDir,
            passphrase: parts.passphrase,
            saltB64: parts.file.salt,
            logger: this.logger
          })
        : null;
    // Boltz conversion namespace (§5.3). Needs the seed key material (durable
    // authenticated boltz-swaps.json) + the ability to sign the L-BTC lockup, so
    // it only exists for a wallet with a seed — a view-only/wiped wallet has none.
    // Held as a private field (not just inside .convert) so close() can dispose
    // its in-flight watches (§5.3 resource hygiene) — the SAME instance is wired
    // into the convert namespace below as wallet.convert.boltz.
    this.convertNamespace =
      parts.passphrase && parts.file.salt
        ? {
            boltz: new BoltzConvert(
              {
                store: new BoltzSwapStore({
                  dataDir: parts.dataDir,
                  passphrase: parts.passphrase,
                  saltB64: parts.file.salt,
                  logger: this.logger
                }),
                logger: this.logger,
                lockupLbtc: (p) => this.lockupLbtc(p),
                getReceiveAddress: () => this.getReceiveAddress()
              },
              parts.boltz ?? {}
            )
          }
        : null;
    // Conversions (§5) — a narrow seam onto the same choke point (§4.3), BRL
    // valuator (§4.4), op mutex (§4.3 TOCTOU) and encrypted seed used by
    // send()/withdraw(). Everything forwarded here already exists on this
    // instance; the convert flows live under src/convert/. wallet.convert exposes
    // BOTH .sideswap (§5.1/§5.2, always available) and .boltz (§5.3, the same
    // BoltzConvert instance held above — absent on a seedless/view-only wallet).
    const convertHooks: ConvertWalletHooks = {
      dataDir: this.dataDir,
      logger: this.logger,
      ensureWollet: () => this.ensureWollet(),
      getReceiveAddress: () => this.getReceiveAddress(),
      decryptMnemonic: () => this.decryptMnemonic(),
      valuate: (asset, amountSats) => this.valuator.valuate(asset, amountSats),
      enforceGuardrails: (intent) => this.guardrails.enforce(intent),
      recordSpend: (brlCents, kind) => this.guardrails.recordSpend(brlCents, kind),
      runExclusive: (fn) => this.opMutex.runExclusive(fn),
      broadcast: (finalized) => this.syncEngine.broadcast(finalized),
      assertOpen: () => this.assertOpen(),
      now: () => Date.now()
    };
    this.convert = new ConvertNamespace(
      convertHooks,
      parts.convert,
      this.convertNamespace?.boltz ?? null
    );
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────

  /**
   * Open an existing wallet. NEVER auto-creates a seed — a dataDir without a
   * wallet fails with WALLET_NOT_FOUND instructing the create quickstart.
   */
  static async open(options: OpenOptions = {}): Promise<DepixWallet> {
    const dataDir = resolveDataDir(options.dataDir);
    const passphrase = resolvePassphrase(options.passphrase);
    // Resolve the (immutable) guardrail config up front so a bad option/env
    // fails fast with GUARDRAIL_CONFIG_INVALID before any lock is taken (§4.2).
    const guardrailConfig = resolveGuardrailConfig(options.guardrails);
    const apiKey = resolveApiKey(options.apiKey);
    const apiBase = resolveApiBase(options.apiBase);
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
    let wallet: DepixWallet;
    try {
      if (file.encryptedSeed) {
        // Validate the passphrase eagerly (fail fast with WRONG_PASSPHRASE).
        // The decrypted plaintext is NOT retained: it goes out of scope here
        // and signing re-materializes it per operation (§2.3). Log redaction is
        // pattern-based (logger.ts), never by keeping the live seed resident.
        await seedStore.decryptMnemonic(passphrase as string);
      }
      wallet = new DepixWallet({
        dataDir,
        passphrase,
        seedStore,
        file,
        lock,
        sync: options.sync,
        guardrailConfig,
        quotes: options.quotes,
        apiKey,
        apiBase,
        apiFetch: options.fetch,
        convert: options.convert,
        boltz: options.boltz
      });
    } catch (err) {
      await lock.release();
      throw err;
    }
    // Auto-resume any crashed withdrawals (§3.2.9), opt-out via option. Best
    // effort: resumePendingWithdrawals() never throws (it logs per-record
    // failures), so a stuck resume can never block opening the wallet.
    if (options.resumePendingWithdrawalsOnOpen !== false) {
      await wallet.resumePendingWithdrawals().catch(() => {
        /* resume already logs; never fail open() on it */
      });
    }
    return wallet;
  }

  /**
   * Create a wallet (§2.9). Interactive TTY runs the backup ritual; in
   * non-interactive mode the mnemonic is returned in the foreground and the
   * wallet is only born confirmed with an explicit `mnemonicSecured: true`.
   */
  static async create(options: CreateOptions = {}): Promise<CreateResult> {
    const dataDir = resolveDataDir(options.dataDir);
    const passphrase = resolvePassphrase(options.passphrase);
    const guardrailConfig = resolveGuardrailConfig(options.guardrails);
    assertStrongPassphrase(passphrase as string);
    registerSecret(passphrase);
    const mnemonic =
      options.mnemonic !== undefined ? validateMnemonic(options.mnemonic) : generateMnemonic();
    // The mnemonic is NOT registered for redaction (that would keep the seed
    // resident for the whole process — §2.3 requires per-op ephemerality). It
    // is returned to the caller in the foreground; logs redact it by pattern.
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
        sync: options.sync,
        guardrailConfig,
        quotes: options.quotes,
        apiKey: resolveApiKey(options.apiKey),
        apiBase: resolveApiBase(options.apiBase),
        apiFetch: options.fetch,
        convert: options.convert,
        boltz: options.boltz
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
    const guardrailConfig = resolveGuardrailConfig(options.guardrails);
    assertStrongPassphrase(passphrase as string);
    registerSecret(passphrase);
    const mnemonic = validateMnemonic(options.mnemonic);
    // Not registered for redaction — see create(): retaining the plaintext for
    // log redaction would defeat the per-op zeroing (§2.3). Redaction is by
    // pattern (logger.ts).
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
      return new DepixWallet({
        dataDir,
        passphrase,
        seedStore,
        file,
        lock,
        sync: options.sync,
        guardrailConfig,
        quotes: options.quotes,
        apiKey: resolveApiKey(options.apiKey),
        apiBase: resolveApiBase(options.apiBase),
        apiFetch: options.fetch,
        convert: options.convert,
        boltz: options.boltz
      });
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
    // Serialize the read-modify-write of nextReceiveIndex under the same
    // per-instance mutex as send() (§3.1 fresh-address guarantee): concurrent
    // getReceiveAddress() calls must not both read the same counter value and
    // derive the SAME address, which would regress the on-chain-reuse property
    // the fresh-address decision exists to protect.
    return this.opMutex.runExclusive(async () => {
      const lastUnused = wollet.address(null).index();
      const next = this.file.nextReceiveIndex ?? 0;
      const idx = Math.max(lastUnused, next);
      await this.seedStore.setNextReceiveIndex(idx + 1);
      await this.refreshFile();
      return wollet.address(idx).address().toString();
    });
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
    // brlEstimate (§2.3/§4.4): DePix is 1:1; L-BTC/USDt need /api/quotes. A read
    // surface fails soft — a single unavailable quote makes the whole estimate
    // null (never a misleading partial). Zero-balance assets need no quote, so
    // an all-DePix (or empty) wallet estimates without any network call.
    const brlEstimate = await this.estimateBalancesBrlCents(balances);
    return { balances, brlEstimate };
  }

  /** Sum the BRL-cent estimate of all balances, or null if any needed quote is unavailable. */
  private async estimateBalancesBrlCents(balances: Record<AssetKey, bigint>): Promise<number | null> {
    let total = 0;
    for (const key of Object.keys(balances) as AssetKey[]) {
      const cents = await this.valuator.estimateBrlCents(key, balances[key]);
      if (cents === null) return null; // a needed quote is unavailable
      total += cents;
    }
    return total;
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
   * per-tx and rolling-24h daily BRL caps (config §4.2). DePix values 1:1 to
   * BRL; L-BTC/USDt are valued via GET /api/quotes and fail CLOSED with
   * QUOTES_UNAVAILABLE when no fresh/stale quote is available (§4.4/G6). When
   * the allowlist is ON, the destination address is checked against
   * `allowlist.liquidAddresses` (matched by scriptPubkey — §4.3).
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

    // Serialize the whole enforce→sign→record→broadcast section per wallet
    // instance (§4.3 TOCTOU fix). Without this, two concurrent send() calls —
    // Promise.all([send(a), send(b)]) or parallel injected wallet_send tool
    // calls — both read used=0, both pass the daily cap, both sign, defeating
    // the R$500/day ceiling (the ONLY layer for pure Liquid sends, §4.6).
    // Serializing also prevents both from selecting the same UTXOs. The lock is
    // released on the throw paths too (Mutex keeps the queue alive on error).
    return this.opMutex.runExclusive(async () => {
      // Choke point (§4.3) — BEFORE anything is built or signed. Valuation may
      // hit /api/quotes for non-DePix assets and fail CLOSED (§4.4/G6).
      const brlCents = await this.valuator.valuate(asset.key, params.amountSats);
      await this.guardrails.enforce({
        kind: "send",
        brlCents,
        destinations: [{ kind: "liquidAddress", address: params.address }]
      });

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
    });
  }

  /**
   * Guardrail choke point + L-BTC lockup signing for a conversion (§4.3/§5.3).
   * Same proven path as send()'s L-BTC branch — enforce (value L-BTC in BRL with
   * the caller's FINAL destinations) → build → ephemeral-sign → recordSpend →
   * broadcast, all under opMutex — but the destination CLASS is the caller's
   * (e.g. `lightning` for a Boltz submarine payee), NOT `liquidAddress`: the
   * lockup being protocol-bound does NOT exempt the final destination (§4.3).
   * The internal seam wallet.convert.boltz uses to fund a lockup.
   */
  private async lockupLbtc(params: {
    address: string;
    amountSats: bigint;
    destinations: readonly GuardrailDestination[];
  }): Promise<{ txid: string }> {
    this.assertOpen();
    if (typeof params.amountSats !== "bigint" || params.amountSats <= 0n) {
      throw new WalletError("INVALID_AMOUNT", "lockup amountSats must be a positive bigint");
    }
    let address: InstanceType<typeof Address>;
    try {
      address = new Address(params.address);
    } catch (err) {
      throw new WalletError("INVALID_ADDRESS", `Not a valid Liquid address: ${params.address}`, {
        cause: err
      });
    }

    return this.opMutex.runExclusive(async () => {
      // Choke point BEFORE anything is built/signed. L-BTC is valued via
      // /api/quotes and fails CLOSED with QUOTES_UNAVAILABLE (§4.4/G6).
      const brlCents = await this.valuator.valuate("LBTC", params.amountSats);
      await this.guardrails.enforce({
        kind: "boltz-submarine",
        brlCents,
        destinations: params.destinations
      });

      const wollet = await this.ensureWollet();
      const network = mainnetNetwork();
      let builder = new TxBuilder(network);
      try {
        builder = builder.addLbtcRecipient(address, params.amountSats);
      } catch (err) {
        throw new WalletError("INVALID_ADDRESS", "Recipient rejected by the transaction builder", {
          cause: err
        });
      }

      let pset;
      try {
        pset = builder.finish(wollet);
      } catch (err) {
        throw await this.classifyFinishError(err, "LBTC", params.amountSats);
      }

      // Ephemeral signer, zeroed in finally (per-op auth §2.3).
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

      // Accounted at SIGNING time, not settlement (§4.5).
      await this.guardrails.recordSpend(brlCents, "boltz-submarine");

      const finalized = wollet.finalize(signed);
      const txid = await this.syncEngine.broadcast(finalized);
      return { txid };
    });
  }

  // ─── Pix flows (§3) ────────────────────────────────────────────────────

  /**
   * On-ramp (§3.1): create a Pix deposit QR. Fills depixAddress with a FRESH
   * receive address of THIS wallet (subject to the backup gate §2.9 —
   * BACKUP_REQUIRED before the backup is confirmed): the only point the AX
   * layer touches the immutable Eulen flow. deposit() does NOT pass through the
   * guardrail — it is an INFLOW (§4.3). The QR is paid by the human OWNER; the
   * DePix lands here and appears on the next sync().
   */
  async deposit(params: DepositParams): Promise<DepositResult> {
    this.assertOpen();
    const api = this.requireApi();
    if (!Number.isSafeInteger(params.amountCents) || params.amountCents <= 0) {
      throw new WalletError(
        "INVALID_AMOUNT",
        "deposit amountCents must be a positive integer (BRL cents)"
      );
    }
    if (typeof params.payerTaxNumber !== "string" || params.payerTaxNumber.trim().length === 0) {
      throw new WalletError("INVALID_ARGUMENT", "payerTaxNumber (payer CPF/CNPJ) is required");
    }
    // Fresh receive address (§3.1) — throws BACKUP_REQUIRED until backup done.
    const depixAddress = await this.getReceiveAddress();
    const wire = await api.createDeposit(
      { amountInCents: params.amountCents, depixAddress, payer_tax_number: params.payerTaxNumber },
      { idempotencyKey: DepixApiClient.newIdempotencyKey() }
    );
    const result: DepositResult = { id: wire.id, qrCopyPaste: wire.qrCopyPaste };
    if (wire.sandbox === true) result.sandbox = true;
    return result;
  }

  /**
   * Off-ramp (§3.2 — CRITICAL contract). Persists the request BEFORE the POST
   * (crash-safe §3.2.9), then processes the AUTHENTICATED response:
   * fee-address fail-closed (FEE_ADDRESS_NOT_EXPLICIT), split consistency
   * (NET+fee=GROSS), guardrail on the GROSS, ONE Liquid tx with the Eulen
   * output + an EXPLICIT fee output, sign, persist-before-broadcast, broadcast.
   * There is NO txid-archival step — Eulen reports settlement via webhook and
   * the F0.9 cron verifies the fee output on-chain.
   */
  async withdraw(params: WithdrawParams): Promise<WithdrawResult> {
    this.assertOpen();
    const api = this.requireApi();
    const pending = this.requirePending();
    if (params.mode !== "send" && params.mode !== "payout") {
      throw new WalletError(
        "INVALID_ARGUMENT",
        `withdraw mode must be "send" or "payout", got ${String(params.mode)}`
      );
    }
    if (!Number.isSafeInteger(params.amountCents) || params.amountCents <= 0) {
      throw new WalletError(
        "INVALID_AMOUNT",
        "withdraw amountCents must be a positive integer (BRL cents)"
      );
    }
    if (typeof params.pixKey !== "string" || params.pixKey.trim().length === 0) {
      throw new WalletError("INVALID_ARGUMENT", "pixKey is required");
    }
    if (
      typeof params.recipientTaxNumber !== "string" ||
      params.recipientTaxNumber.trim().length === 0
    ) {
      throw new WalletError(
        "INVALID_ARGUMENT",
        "recipientTaxNumber (destination Pix-key holder CPF/CNPJ) is required"
      );
    }

    const request: WithdrawRequestBody = {
      pixKey: params.pixKey,
      taxNumber: params.recipientTaxNumber
    };
    if (params.mode === "send") request.depositAmountInCents = params.amountCents;
    else request.payoutAmountInCents = params.amountCents;

    const idempotencyKey = DepixApiClient.newIdempotencyKey();
    // Persist BEFORE the POST so a crash mid-request resumes with the SAME
    // Idempotency-Key (§3.2.9). Nothing is signed yet — no double-pay window.
    await pending.putRequested({ idempotencyKey, request });
    let wire;
    try {
      wire = await api.createWithdraw(request, { idempotencyKey });
    } catch (err) {
      // Only a DEFINITIVE rejection (4xx other than 409) means the server did
      // NOT create the withdrawal — drop the still-unsigned record. A TRANSIENT
      // failure (network / 5xx / 409 in-flight) may have created it server-side
      // with the response lost, so KEEP the "requested" record: a later open()
      // re-POSTs the SAME Idempotency-Key (authenticated replay, §3.2.9) instead
      // of orphaning the provider-side withdrawal. Nothing is signed here, so
      // keeping the record can never double-pay.
      if (this.isPermanentApiRejection(err)) {
        await this.discardIfUnsigned(idempotencyKey);
      }
      throw err;
    }
    return this.processWithdrawResponse(wire, idempotencyKey);
  }

  /** Poll GET /api/deposits/:id until terminal (§3.4, shared read throttle). */
  async waitForDeposit(id: string, options: WaitOptions = {}): Promise<StatusReadResponse> {
    this.assertOpen();
    return pollDeposit(this.requireApi(), id, options);
  }

  /** Poll GET /api/withdrawals/:id until terminal (§3.4; sandbox `confirmed`). */
  async waitForWithdrawal(id: string, options: WaitOptions = {}): Promise<StatusReadResponse> {
    this.assertOpen();
    return pollWithdrawal(this.requireApi(), id, options);
  }

  /**
   * Recover crashed withdrawals (§3.2.9). Auto-run by open() (opt-out). NEVER
   * throws — per-record failures are logged. "signed" records are re-broadcast
   * with the SAME bytes (never re-signed — the anti-double-pay invariant);
   * "requested" records re-POST with the same Idempotency-Key
   * (authenticated replay) and re-run the full validation cadence. A record
   * failing GCM authentication is discarded and never signed from.
   */
  async resumePendingWithdrawals(): Promise<ResumeSummary> {
    const summary: ResumeSummary = {
      resumed: 0,
      rebroadcast: 0,
      reposted: 0,
      discarded: 0,
      failed: 0
    };
    if (!this.lock || !this.pending) return summary;

    let readResult;
    try {
      readResult = await this.pending.readAll();
    } catch (err) {
      this.logger.error("could not read pending withdrawals — skipping resume", {
        error: String((err as Error)?.message ?? err)
      });
      return summary;
    }

    for (const id of readResult.tamperedIds) {
      summary.discarded++;
      this.logger.error(
        "pending withdrawal failed authentication (tampered) — discarding, not signed from",
        { idempotencyKey: id }
      );
      await this.pending.remove(id).catch(() => {});
    }

    for (const record of readResult.records) {
      try {
        if (record.state === "signed") {
          if (!record.signedTxHex) {
            summary.failed++;
            continue;
          }
          // Re-broadcast the EXACT signed bytes — NEVER re-sign (§3.2.9).
          await this.syncEngine.broadcastRawTx(record.signedTxHex);
          summary.rebroadcast++;
          await this.pending.remove(record.idempotencyKey).catch(() => {});
        } else {
          // "requested": re-POST same key (authenticated replay) + re-validate.
          if (!this.api) {
            summary.failed++;
            continue;
          }
          const wire = await this.api.createWithdraw(record.request, {
            idempotencyKey: record.idempotencyKey
          });
          await this.processWithdrawResponse(wire, record.idempotencyKey);
          summary.reposted++;
        }
      } catch (err) {
        summary.failed++;
        this.logger.error("failed to resume a pending withdrawal", {
          idempotencyKey: record.idempotencyKey,
          state: record.state,
          error: String((err as Error)?.message ?? err)
        });
        // A permanent 4xx (not_found/expired/validation — not 409) means the
        // provider will never complete this withdrawal → drop the record.
        if (this.isPermanentApiRejection(err)) {
          await this.pending.remove(record.idempotencyKey).catch(() => {});
        }
      }
    }

    summary.resumed = summary.rebroadcast + summary.reposted;
    return summary;
  }

  /**
   * Run the withdraw contract on an AUTHENTICATED response (shared by the
   * initial call and resume-of-"requested"). Sandbox short-circuits BEFORE any
   * on-chain validation (§3.2 step 0). The guardrail→build→sign→broadcast
   * section is serialized with send()/other withdraws (§4.3 TOCTOU).
   */
  private async processWithdrawResponse(
    wire: WithdrawWireResponse,
    idempotencyKey: string
  ): Promise<WithdrawResult> {
    try {
      const norm = normalizeWithdrawResponse(wire);

      // Step 0 (§3.2): sandbox short-circuit BEFORE any address/fee validation —
      // the placeholders do not parse and the SDK runs NO on-chain leg.
      if (norm.sandbox) {
        await this.pending?.remove(idempotencyKey).catch(() => {});
        return {
          withdrawalId: norm.withdrawalId,
          txid: null,
          feeCents: norm.feeCents,
          feeAddress: norm.feeAddress,
          netCents: norm.netCents,
          grossCents: norm.grossCents,
          payoutCents: norm.payoutCents,
          sandbox: true
        };
      }

      // Steps 3–4 fail-closed validations (pure — nothing is signed if they trip):
      if (norm.hasFee) {
        // fee_address MUST be explicit (ex1) or the fee output is unverifiable →
        // account block. Abort BEFORE signing (§3.2.3).
        const feeAddr = assertFeeAddressExplicit(norm.feeAddress as string);
        try {
          feeAddr.free();
        } catch {
          // best effort
        }
        assertSplitConsistent(norm.netCents, norm.feeCents as number, norm.grossCents);
      }
      this.assertParseableLiquidAddress(norm.depositAddress);

      return await this.opMutex.runExclusive(async () => {
        // Guardrail on the GROSS (§3.2.4) — BEFORE anything is built or signed.
        await this.guardrails.enforce({ kind: "withdraw", brlCents: norm.grossCents });
        const signedTxHex = await this.buildSignPersistWithdraw(norm, idempotencyKey);
        // Broadcast the SAME persisted bytes (identical path to resume).
        const txid = await this.syncEngine.broadcastRawTx(signedTxHex);
        // Broadcast succeeded → tx is public; drop the record. A crash in the
        // broadcast→remove window leaves a "signed" record that resume simply
        // re-broadcasts (idempotent), never re-signs — so the anti-double-pay
        // invariant holds without keeping the file unbounded.
        await this.pending?.remove(idempotencyKey).catch(() => {});
        return {
          withdrawalId: norm.withdrawalId,
          txid,
          feeCents: norm.feeCents,
          feeAddress: norm.feeAddress,
          netCents: norm.netCents,
          grossCents: norm.grossCents,
          payoutCents: norm.payoutCents
        };
      });
    } catch (err) {
      // A failure BEFORE signing (contract/guardrail/insufficient) is a
      // deliberate refusal, not a crash — drop the still-"requested" record so
      // resume never re-drives it. A failure AFTER signing (broadcast) leaves a
      // "signed" record UNTOUCHED for resume to re-broadcast (same bytes).
      await this.discardIfUnsigned(idempotencyKey);
      throw err;
    }
  }

  /**
   * A withdraw POST failure is DEFINITIVE only when it is a 4xx other than 409:
   * the server rejected the request and created nothing, so the still-unsigned
   * record can be dropped. Network errors (DepixApiError status 0), any 5xx and
   * a 409 (idempotency in-flight) are TRANSIENT — the withdrawal may exist
   * server-side with the response lost, so the record is KEPT for an idempotent
   * resume re-POST (§3.2.9). Single source of truth for both withdraw() and
   * resumePendingWithdrawals().
   */
  private isPermanentApiRejection(err: unknown): boolean {
    return (
      err instanceof DepixApiError &&
      err.status >= 400 &&
      err.status < 500 &&
      err.status !== 409
    );
  }

  /** Remove a pending record only while it is still "requested" (unsigned). */
  private async discardIfUnsigned(idempotencyKey: string): Promise<void> {
    if (!this.pending) return;
    try {
      const record = await this.pending.get(idempotencyKey);
      if (record && record.state === "requested") {
        await this.pending.remove(idempotencyKey);
      }
    } catch {
      // get() can throw PENDING_RECORD_TAMPERED — leave it for resume to discard.
    }
  }

  /**
   * Build ONE Liquid tx (Eulen output A + explicit fee output B when fee'd),
   * re-pin its outputs (§3.2.5), sign with an ephemeral signer, account the
   * GROSS at signing time and persist the signed bytes BEFORE the first
   * broadcast (§3.2.9). Returns the signed tx hex. Callers hold opMutex.
   */
  private async buildSignPersistWithdraw(
    norm: NormalizedWithdraw,
    idempotencyKey: string
  ): Promise<string> {
    const wollet = await this.ensureWollet();
    const network = mainnetNetwork();
    const netSats = centsToDepixSats(norm.netCents);
    const grossSats = centsToDepixSats(norm.grossCents);
    const feeSats = norm.hasFee ? centsToDepixSats(norm.feeCents as number) : undefined;

    // Capture the output scripts BEFORE building (frontend parity: addresses are
    // not reused after addRecipient; not freed, matching send()).
    const depositAddr = new Address(norm.depositAddress);
    const depositScriptHex = depositAddr.scriptPubkey().toString();
    let builder = new TxBuilder(network);
    builder = builder.addRecipient(depositAddr, netSats, new AssetId(ASSETS.DEPIX.id));
    let feeScriptHex: string | undefined;
    if (norm.hasFee) {
      const feeAddr = new Address(norm.feeAddress as string);
      feeScriptHex = feeAddr.scriptPubkey().toString();
      builder = builder.addRecipient(feeAddr, feeSats as bigint, new AssetId(ASSETS.DEPIX.id));
    }

    const pset = await this.finishWithdrawPset(builder, wollet, grossSats);

    // Re-pin the built PSET (§3.2.5): Eulen output present; fee output EXPLICIT
    // (readable asset+value) paying the fee script exactly.
    assertWithdrawPsetOutputs(pset, { depositScriptHex, netSats, feeScriptHex, feeSats });

    // Ephemeral signer, zeroed in finally (per-op auth §2.3).
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

    const finalized = wollet.finalize(signed);
    const tx = finalized.extractTx();
    const signedTxHex = tx.toString();
    const txid = tx.txid().toString();

    // Account the GROSS at SIGNING time (§4.5), in the fail-closed direction: if
    // a crash regresses to "requested", resume re-signs a FRESH tx (the original
    // was never broadcast) and records again — over-counting blocks more, never
    // a double-pay.
    await this.guardrails.recordSpend(norm.grossCents, "withdraw");
    // Persist the signed bytes BEFORE the first broadcast — the anti-double-pay
    // checkpoint. Resume from "signed" re-broadcasts THESE bytes, never re-signs.
    await this.requirePending().markSigned(idempotencyKey, {
      withdrawalId: norm.withdrawalId,
      signedTxHex,
      txid
    });
    return signedTxHex;
  }

  private async finishWithdrawPset(
    builder: InstanceType<typeof TxBuilder>,
    wollet: Wollet,
    grossSats: bigint
  ): Promise<InstanceType<typeof Pset>> {
    try {
      return builder.finish(wollet);
    } catch (err) {
      // Reuse the send() classifier: INSUFFICIENT_FUNDS / INSUFFICIENT_LBTC_FOR_FEE.
      throw await this.classifyFinishError(err, "DEPIX", grossSats);
    }
  }

  private requireApi(): DepixApiClient {
    if (!this.api) {
      throw new WalletError(
        "API_KEY_REQUIRED",
        "Set apiKey (or $DEPIX_API_KEY) on open()/create() to use deposit(), withdraw() and the waiters."
      );
    }
    return this.api;
  }

  private requirePending(): PendingWithdrawals {
    if (!this.pending) {
      throw new WalletError(
        "WALLET_NOT_FOUND",
        "This wallet has no seed material (view-only/wiped) — withdraw() is unavailable."
      );
    }
    return this.pending;
  }

  private assertParseableLiquidAddress(address: string): void {
    try {
      const parsed = new Address(address);
      try {
        parsed.free();
      } catch {
        // best effort
      }
    } catch (err) {
      throw new WalletError(
        "INVALID_ADDRESS",
        `withdraw response depositAddress is not a valid Liquid address: ${address}`,
        { cause: err }
      );
    }
  }

  /** Selective wipe (§2.4): view-only survives, restore detects mismatch. */
  async wipe(): Promise<void> {
    this.assertOpen();
    await this.seedStore.wipeSeed();
    await this.refreshFile();
  }

  // ─── internals ─────────────────────────────────────────────────────────

  /**
   * Argon2id(passphrase, salt) → raw 32-byte key material, derived at most once
   * per process (§4.5). The salt never changes across anchor advances, so this is
   * safely memoized. Argon2id is deliberately expensive — it must never run per
   * enforce()/recordSpend().
   */
  private rootKeyBytes(): Promise<Uint8Array> {
    if (!this.rootKeyBytesPromise) {
      this.rootKeyBytesPromise = (async () => {
        const salt = this.file.salt;
        if (!salt) {
          // No seed → no key. A view-only/wiped wallet cannot have written any
          // authenticated state, so this path is only reached on misuse.
          throw new WalletError(
            "WALLET_NOT_FOUND",
            "Cannot derive the guardrail state key: this wallet has no seed (wiped or view-only)."
          );
        }
        return deriveKeyBytes(this.requirePassphrase(), base64.decode(salt));
      })();
    }
    return this.rootKeyBytesPromise;
  }

  /**
   * The SEED root AES-256-GCM key — encrypts/decrypts the seed and re-encrypts it
   * on each guardrail anchor advance (§4.5). Same raw bytes as the state subkey's
   * HKDF input, so a single Argon2id derivation backs both.
   */
  private seedKey(): Promise<CryptoKey> {
    if (!this.seedKeyPromise) {
      this.seedKeyPromise = this.rootKeyBytes().then(importAesKey);
    }
    return this.seedKeyPromise;
  }

  /**
   * The guardrails-state authentication key (§4.5) — an HKDF subkey of the seed
   * root material (info='depix-sdk-guardrails-state-v1'), so the state file never
   * shares raw AES-GCM keystream with the seed blob (review low, state-crypto.ts:14)
   * while keeping a single passphrase / single Argon2id derivation ("mesma chave
   * do seed-store" in spirit).
   */
  private guardrailStateKey(): Promise<CryptoKey> {
    if (!this.guardrailKeyPromise) {
      this.guardrailKeyPromise = this.rootKeyBytes().then(deriveStateSubkey);
    }
    return this.guardrailKeyPromise;
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
    // Do NOT registerSecret() the plaintext: that Set is module-level and never
    // cleared, so it would pin the seed on the heap for the whole process —
    // exactly what §2.3's per-op zeroing forbids. Callers use the return value
    // within a tight scope and drop it; logs redact mnemonics by pattern.
    return this.seedStore.decryptMnemonic(this.requirePassphrase());
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
    // Dedup concurrent initialization (concurrent getReceiveAddress()/send()/
    // getBalances() must not each build a Wollet and replay the chain in
    // parallel) — join the single in-flight build, like the sync engine does.
    if (!this.wolletPromise) {
      this.wolletPromise = (async () => {
        if (!this.wollet) {
          this.wollet = buildWollet(this.requireDescriptor());
        }
        await this.syncEngine.loadPersisted(this.wollet);
        this.wolletReady = true;
        return this.wollet;
      })().finally(() => {
        this.wolletPromise = null;
      });
    }
    return this.wolletPromise;
  }
}
