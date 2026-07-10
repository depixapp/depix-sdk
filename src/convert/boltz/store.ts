// Boltz in-flight swap store — durable, authenticated (spec §5.3 / §2.4).
//
// Holds every in-flight submarine (send) and reverse (receive) swap so a crashed
// agent can resume claim/refund on next open(). Each record carries SWAP-SCOPED
// private key material (the submarine refund key; the reverse claim key +
// preimage) — sensitive (they authorize moving that swap's L-BTC), though NOT the
// wallet seed. So records are AES-256-GCM authenticated with the SAME key derived
// from the seed store (passphrase + wallet salt), AAD = swapId, one independent
// encrypted envelope per record (mirrors pending-withdrawals.ts). An injected
// agent that rewrites the file cannot forge the GCM tag → the record is discarded
// (the swap expires / can still be refunded via its own persisted key elsewhere)
// and nothing is claimed/refunded from tampered data.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { base64 } from "@scure/base";
import { ConversionError } from "../../errors.js";
import { defaultLogger, type Logger } from "../../logger.js";
import { Mutex } from "../../mutex.js";
import { aesGcmDecrypt, aesGcmEncrypt, deriveKey, randomIv } from "../../store/crypto.js";
import { ensureDir, writeFileDurable } from "../../store/fs-util.js";
import type { ReverseSwapRecord } from "./reverse.js";

export const BOLTZ_SWAPS_FILE = "boltz-swaps.json";

export type SubmarineState =
  | "prepared" // verified, lockup NOT yet broadcast
  | "locked_up" // lockup broadcast — watching for payment
  | "paid" // Boltz claimed the lockup (invoice paid)
  | "refunded" // refunded on-chain
  | "refund_pending"; // cooperative refund failed, timeout not reached

export interface StoredSubmarineSwap {
  type: "submarine";
  swapId: string;
  invoice: string;
  lockupAddress: string;
  expectedAmountSats: number;
  invoiceSats: number;
  swapTree: unknown;
  claimPublicKey: string;
  blindingKey?: string;
  timeoutBlockHeight: number;
  refundPrivateKeyHex: string;
  refundPublicKeyHex: string;
  lockupTxid?: string;
  state: SubmarineState;
  createdAt: number;
}

export type ReverseState = "awaiting_payment" | "claimed" | "failed";

export interface StoredReverseSwap extends ReverseSwapRecord {
  type: "reverse";
  state: ReverseState;
  createdAt: number;
}

export type StoredBoltzSwap = StoredSubmarineSwap | StoredReverseSwap;

interface Envelope {
  /** swapId — stable record locator (plaintext; not secret). */
  id: string;
  iv: string; // base64
  ct: string; // base64
}

interface BoltzSwapsFileV1 {
  format: "depix-boltz-swaps";
  version: 1;
  records: Envelope[];
}

export interface BoltzSwapStoreReadAll {
  records: StoredBoltzSwap[];
  /** swapIds of records that FAILED GCM authentication (tampered/corrupt). */
  tamperedIds: string[];
}

export interface BoltzSwapStoreOptions {
  dataDir: string;
  passphrase: string;
  /** Wallet salt (base64) — same salt the seed store derived from. */
  saltB64: string;
  logger?: Logger;
  now?: () => number;
}

export class BoltzSwapStore {
  private readonly dataDir: string;
  private readonly filePath: string;
  private readonly passphrase: string;
  private readonly salt: Uint8Array;
  private readonly logger: Logger;
  private readonly now: () => number;
  private keyPromise: Promise<CryptoKey> | null = null;
  private readonly mutex = new Mutex();

  constructor(options: BoltzSwapStoreOptions) {
    this.dataDir = options.dataDir;
    this.filePath = join(options.dataDir, BOLTZ_SWAPS_FILE);
    this.passphrase = options.passphrase;
    this.salt = base64.decode(options.saltB64);
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? Date.now;
  }

  private key(): Promise<CryptoKey> {
    if (!this.keyPromise) this.keyPromise = deriveKey(this.passphrase, this.salt);
    return this.keyPromise;
  }

  private async encrypt(record: StoredBoltzSwap): Promise<Envelope> {
    const iv = randomIv();
    const plaintext = new TextEncoder().encode(JSON.stringify(record));
    const ct = await aesGcmEncrypt(plaintext, await this.key(), iv, new TextEncoder().encode(record.swapId));
    return { id: record.swapId, iv: base64.encode(iv), ct: base64.encode(ct) };
  }

  private async decrypt(env: Envelope): Promise<StoredBoltzSwap> {
    const plaintext = await aesGcmDecrypt(
      base64.decode(env.ct),
      await this.key(),
      base64.decode(env.iv),
      new TextEncoder().encode(env.id)
    );
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as StoredBoltzSwap;
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
      const parsed = JSON.parse(raw) as BoltzSwapsFileV1;
      if (parsed.format !== "depix-boltz-swaps" || parsed.version !== 1) {
        throw new Error("unknown format/version");
      }
      return Array.isArray(parsed.records) ? parsed.records : [];
    } catch (err) {
      this.logger.error("boltz-swaps.json is corrupt — discarding (in-flight swaps may expire)", {
        error: String((err as Error)?.message ?? err)
      });
      return [];
    }
  }

  private async writeEnvelopes(envelopes: Envelope[]): Promise<void> {
    await ensureDir(this.dataDir);
    const file: BoltzSwapsFileV1 = { format: "depix-boltz-swaps", version: 1, records: envelopes };
    // Durable (fsync file + dir) — losing a refund/claim key material strands
    // the lockup (§2.4).
    await writeFileDurable(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
  }

  /** Insert or replace a record (located by swapId). */
  async put(record: StoredBoltzSwap): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const rec = { ...record, createdAt: record.createdAt || this.now() } as StoredBoltzSwap;
      const envelopes = (await this.readEnvelopes()).filter((e) => e.id !== record.swapId);
      envelopes.push(await this.encrypt(rec));
      await this.writeEnvelopes(envelopes);
    });
  }

  /** Read-modify-write ONE record. */
  async patch(swapId: string, mutate: (record: StoredBoltzSwap) => void): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const envelopes = await this.readEnvelopes();
      const idx = envelopes.findIndex((e) => e.id === swapId);
      if (idx === -1) return;
      const record = await this.decrypt(envelopes[idx]!);
      mutate(record);
      envelopes[idx] = await this.encrypt(record);
      await this.writeEnvelopes(envelopes);
    });
  }

  async remove(swapId: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const envelopes = await this.readEnvelopes();
      const next = envelopes.filter((e) => e.id !== swapId);
      if (next.length !== envelopes.length) await this.writeEnvelopes(next);
    });
  }

  /** Decrypt one record by swapId. Throws PENDING_RECORD_TAMPERED-analog on auth failure. */
  async get(swapId: string): Promise<StoredBoltzSwap | null> {
    const envelopes = await this.readEnvelopes();
    const env = envelopes.find((e) => e.id === swapId);
    if (!env) return null;
    try {
      return await this.decrypt(env);
    } catch (err) {
      throw new ConversionError(
        "SWAP_VALIDATION_FAILED",
        `boltz swap ${swapId} failed authentication — discarded, not acted upon`,
        { cause: err }
      );
    }
  }

  /** Decrypt every record; tampered ones are collected rather than aborting. */
  async readAll(): Promise<BoltzSwapStoreReadAll> {
    const envelopes = await this.readEnvelopes();
    const records: StoredBoltzSwap[] = [];
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
