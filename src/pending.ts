// Pending-withdrawals store — crash-safe, anti-double-pay (spec §3.2.9).
//
// The load-bearing invariant: the signedTxHex is persisted BEFORE the first
// broadcast, so a crash in the broadcast→persist window is recovered by
// RE-BROADCASTING THE SAME BYTES, never by re-building/re-signing (which would
// select other UTXOs → 2× NET + 2× fee). Resume of a pre-signature record
// re-POSTs with the SAME Idempotency-Key (authenticated replay) and re-runs the
// full validation — it never trusts addresses from this local file.
//
// Integrity: each record is AES-256-GCM authenticated with the SAME key derived
// from the seed store (passphrase + wallet salt), AAD = withdrawalId (or the
// idempotencyKey before the withdrawalId is known). An injected agent that
// rewrites the file cannot swap signedTxHex/addresses without breaking the GCM
// tag → the record is discarded, logged loudly, and nothing is signed from
// tampered data (the withdrawal expires at the provider). Records are stored as
// independent encrypted envelopes so one update never re-encrypts the others.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { base64 } from "@scure/base";
import type { WithdrawRequestBody } from "./api/client.js";
import { WithdrawContractError } from "./errors.js";
import { defaultLogger, type Logger } from "./logger.js";
import { aesGcmDecrypt, aesGcmEncrypt, deriveKey, randomIv } from "./store/crypto.js";
import { Mutex } from "./mutex.js";
import { ensureDir, writeFileDurable } from "./store/fs-util.js";

export const PENDING_WITHDRAWALS_FILE = "pending-withdrawals.json";

export type PendingWithdrawalState = "requested" | "signed" | "broadcast";

export interface PendingWithdrawalRecord {
  idempotencyKey: string;
  withdrawalId?: string;
  createdAt: number;
  state: PendingWithdrawalState;
  /** Present from state "signed" — the EXACT bytes re-broadcast on resume. */
  signedTxHex?: string;
  txid?: string;
  /** The wire body, so resume-of-"requested" re-POSTs with the same key. */
  request: WithdrawRequestBody;
}

interface Envelope {
  /** idempotencyKey — stable record locator (plaintext; a random UUID, not secret). */
  id: string;
  /** AAD = withdrawalId ?? idempotencyKey (plaintext; not secret — binds the ciphertext to a slot). */
  aad: string;
  iv: string; // base64
  ct: string; // base64
}

interface PendingFileV1 {
  format: "depix-pending-withdrawals";
  version: 1;
  records: Envelope[];
}

export interface ReadAllResult {
  records: PendingWithdrawalRecord[];
  /** idempotencyKeys of records that FAILED GCM authentication (tampered/corrupt). */
  tamperedIds: string[];
}

export interface PendingWithdrawalsOptions {
  dataDir: string;
  passphrase: string;
  /** Wallet salt (base64) from wallet.json — same salt the seed store derived from. */
  saltB64: string;
  logger?: Logger;
  now?: () => number;
}

export class PendingWithdrawals {
  private readonly dataDir: string;
  private readonly filePath: string;
  private readonly passphrase: string;
  private readonly salt: Uint8Array;
  private readonly logger: Logger;
  private readonly now: () => number;
  private keyPromise: Promise<CryptoKey> | null = null;
  // Serialize every read-modify-write of the file (append/update/remove) so
  // two concurrent transitions never clobber each other's envelope set.
  private readonly mutex = new Mutex();

  constructor(options: PendingWithdrawalsOptions) {
    this.dataDir = options.dataDir;
    this.filePath = join(options.dataDir, PENDING_WITHDRAWALS_FILE);
    this.passphrase = options.passphrase;
    this.salt = base64.decode(options.saltB64);
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? Date.now;
  }

  private key(): Promise<CryptoKey> {
    // Argon2id (19 MiB) is expensive — derive once per instance.
    if (!this.keyPromise) this.keyPromise = deriveKey(this.passphrase, this.salt);
    return this.keyPromise;
  }

  private async encrypt(record: PendingWithdrawalRecord): Promise<Envelope> {
    const aad = record.withdrawalId ?? record.idempotencyKey;
    const iv = randomIv();
    const plaintext = new TextEncoder().encode(JSON.stringify(record));
    const ct = await aesGcmEncrypt(plaintext, await this.key(), iv, new TextEncoder().encode(aad));
    return { id: record.idempotencyKey, aad, iv: base64.encode(iv), ct: base64.encode(ct) };
  }

  private async decrypt(env: Envelope): Promise<PendingWithdrawalRecord> {
    const plaintext = await aesGcmDecrypt(
      base64.decode(env.ct),
      await this.key(),
      base64.decode(env.iv),
      new TextEncoder().encode(env.aad)
    );
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as PendingWithdrawalRecord;
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
      const parsed = JSON.parse(raw) as PendingFileV1;
      if (parsed.format !== "depix-pending-withdrawals" || parsed.version !== 1) {
        throw new Error("unknown format/version");
      }
      return Array.isArray(parsed.records) ? parsed.records : [];
    } catch (err) {
      // A corrupt outer file is unrecoverable — the enclosed signed txs are
      // lost, so those withdrawals simply expire at the provider (funds stay in
      // the wallet, never double-paid). Loud log, empty set.
      this.logger.error("pending-withdrawals.json is corrupt — discarding (withdrawals will expire)", {
        error: String((err as Error)?.message ?? err)
      });
      return [];
    }
  }

  private async writeEnvelopes(envelopes: Envelope[]): Promise<void> {
    await ensureDir(this.dataDir);
    const file: PendingFileV1 = {
      format: "depix-pending-withdrawals",
      version: 1,
      records: envelopes
    };
    // Durable (fsync file + dir) — losing a signed tx costs a stuck withdrawal
    // and re-signing it would double-pay (§2.4).
    await writeFileDurable(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
  }

  /** Write the pre-request record (state "requested") BEFORE the POST (§3.2.9). */
  async putRequested(input: { idempotencyKey: string; request: WithdrawRequestBody }): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const record: PendingWithdrawalRecord = {
        idempotencyKey: input.idempotencyKey,
        createdAt: this.now(),
        state: "requested",
        request: input.request
      };
      const envelopes = (await this.readEnvelopes()).filter((e) => e.id !== input.idempotencyKey);
      envelopes.push(await this.encrypt(record));
      await this.writeEnvelopes(envelopes);
    });
  }

  /** Read-modify-write ONE record (locating by idempotencyKey). */
  private async patch(
    idempotencyKey: string,
    mutate: (record: PendingWithdrawalRecord) => void
  ): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const envelopes = await this.readEnvelopes();
      const idx = envelopes.findIndex((e) => e.id === idempotencyKey);
      if (idx === -1) return;
      const record = await this.decrypt(envelopes[idx]!);
      mutate(record);
      envelopes[idx] = await this.encrypt(record);
      await this.writeEnvelopes(envelopes);
    });
  }

  /**
   * Persist the signed tx (state "signed") BEFORE the first broadcast — the
   * anti-double-pay checkpoint. Resume from here NEVER re-signs.
   */
  async markSigned(
    idempotencyKey: string,
    fields: { withdrawalId: string; signedTxHex: string; txid: string }
  ): Promise<void> {
    await this.patch(idempotencyKey, (record) => {
      record.withdrawalId = fields.withdrawalId;
      record.signedTxHex = fields.signedTxHex;
      record.txid = fields.txid;
      record.state = "signed";
    });
  }

  /** Transition to "broadcast" after the broadcast succeeds. */
  async markBroadcast(idempotencyKey: string): Promise<void> {
    await this.patch(idempotencyKey, (record) => {
      record.state = "broadcast";
    });
  }

  async remove(idempotencyKey: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const envelopes = await this.readEnvelopes();
      const next = envelopes.filter((e) => e.id !== idempotencyKey);
      if (next.length !== envelopes.length) await this.writeEnvelopes(next);
    });
  }

  /**
   * Decrypt one record by idempotencyKey. Throws PENDING_RECORD_TAMPERED on GCM
   * authentication failure (tampered ciphertext / AAD / wrong key).
   */
  async get(idempotencyKey: string): Promise<PendingWithdrawalRecord | null> {
    const envelopes = await this.readEnvelopes();
    const env = envelopes.find((e) => e.id === idempotencyKey);
    if (!env) return null;
    try {
      return await this.decrypt(env);
    } catch (err) {
      throw new WithdrawContractError(
        "PENDING_RECORD_TAMPERED",
        `pending withdrawal ${idempotencyKey} failed authentication — discarded, not signed from`,
        { cause: err }
      );
    }
  }

  /**
   * Decrypt every record. Records failing GCM authentication are collected in
   * `tamperedIds` (discard + loud log is the caller's job) rather than aborting
   * the whole resume.
   */
  async readAll(): Promise<ReadAllResult> {
    const envelopes = await this.readEnvelopes();
    const records: PendingWithdrawalRecord[] = [];
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
