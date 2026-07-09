// Encrypted seed store — versioned wallet.json (spec §2.4).
//
// 1:1 headless mirror of the frontend's IndexedDB `credentials` record
// (wallet-store.js:21-33) minus the WebAuthn fields (browser-only) and minus
// the PIN rate-limit fields (no auto-wipe / no counter in headless — G8).
// Same crypto (Argon2id + AES-256-GCM), same selective-wipe semantics.
//
// PR1 additions to the record (both spec-mandated):
//   - backupConfirmed (§2.9): the backup gate flag. No receive address is
//     derived before backup is exported AND confirmed.
//   - nextReceiveIndex (§3.1, decision 2026-07-10): persisted monotonic
//     counter so every getReceiveAddress() call returns a FRESH address even
//     while earlier QRs are still unpaid (LWK's last-unused semantics alone
//     would reuse the same index).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { base64 } from "@scure/base";
import { WalletError } from "../errors.js";
import {
  assertStrongPassphrase,
  decryptSeed,
  deriveKey,
  encryptSeed,
  randomIv,
  randomSalt
} from "./crypto.js";
import { ensureDir, writeFileDurable } from "./fs-util.js";

export const WALLET_FILE_NAME = "wallet.json";

export interface WalletFileV1 {
  format: "depix-sdk-wallet";
  version: 1;
  network: "mainnet";
  encryptedSeed: string | null; // base64 — AES-256-GCM of the UTF-8 mnemonic (GCM tag appended)
  salt: string | null; // base64, 16 bytes — Argon2id salt, random per wallet
  iv: string | null; // base64, 12 bytes — AES-GCM IV, random
  descriptor: string | null; // PLAINTEXT — view-only + restore comparison (frontend parity)
  createdAt: number; // epoch ms
  backupConfirmed: boolean; // §2.9 backup gate
  nextReceiveIndex: number; // §3.1 fresh-address monotonic counter
}

export class SeedStore {
  readonly dataDir: string;
  readonly filePath: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.filePath = join(dataDir, WALLET_FILE_NAME);
  }

  /** Read wallet.json. Returns null when missing; throws on malformed JSON. */
  async read(): Promise<WalletFileV1 | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // The seed file is the one artifact we never silently discard: a
      // corrupted wallet.json is surfaced loudly instead of being treated as
      // "no wallet" (which could lead to accidental re-creation over it).
      throw new WalletError(
        "WALLET_NOT_FOUND",
        `wallet.json at ${this.filePath} is corrupted (invalid JSON). ` +
          "Restore from the mnemonic backup into a fresh dataDir.",
        { cause: err }
      );
    }
    const file = parsed as WalletFileV1;
    if (file.format !== "depix-sdk-wallet" || file.version !== 1) {
      throw new WalletError(
        "WALLET_NOT_FOUND",
        `wallet.json at ${this.filePath} has an unknown format/version`
      );
    }
    return file;
  }

  /** Durable write of the full record (spec §2.4 recipe, 0600). */
  async write(file: WalletFileV1): Promise<void> {
    await ensureDir(this.dataDir);
    await writeFileDurable(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
  }

  /**
   * Create the encrypted record for a (new or imported) mnemonic.
   * Preserves createdAt/nextReceiveIndex when overwriting an existing record
   * (restore-over-wiped path).
   */
  async initialize(options: {
    passphrase: string;
    mnemonic: string;
    descriptor: string;
    backupConfirmed?: boolean;
  }): Promise<WalletFileV1> {
    assertStrongPassphrase(options.passphrase);
    const existing = await this.read();
    const salt = randomSalt();
    const iv = randomIv();
    const key = await deriveKey(options.passphrase, salt);
    const ciphertext = await encryptSeed(options.mnemonic, key, iv);
    const file: WalletFileV1 = {
      format: "depix-sdk-wallet",
      version: 1,
      network: "mainnet",
      encryptedSeed: base64.encode(ciphertext),
      salt: base64.encode(salt),
      iv: base64.encode(iv),
      descriptor: options.descriptor,
      createdAt: existing?.createdAt ?? Date.now(),
      backupConfirmed: options.backupConfirmed ?? false,
      nextReceiveIndex: existing?.nextReceiveIndex ?? 0
    };
    await this.write(file);
    return file;
  }

  /**
   * Decrypt the mnemonic. WRONG_PASSPHRASE on bad passphrase/corrupt data —
   * never wipes, never counts attempts (G8). WALLET_NOT_FOUND when no seed.
   */
  async decryptMnemonic(passphrase: string): Promise<string> {
    const file = await this.read();
    if (!file?.encryptedSeed || !file.salt || !file.iv) {
      throw new WalletError(
        "WALLET_NOT_FOUND",
        `No wallet seed in ${this.dataDir}. Run DepixWallet.create() or DepixWallet.restore() — ` +
          "the SDK never creates a seed automatically."
      );
    }
    const key = await deriveKey(passphrase, base64.decode(file.salt));
    return decryptSeed(base64.decode(file.encryptedSeed), key, base64.decode(file.iv));
  }

  private async patch(mutate: (file: WalletFileV1) => void): Promise<WalletFileV1> {
    const file = await this.read();
    if (!file) {
      throw new WalletError("WALLET_NOT_FOUND", `No wallet.json in ${this.dataDir}`);
    }
    mutate(file);
    await this.write(file);
    return file;
  }

  /** Persist backupConfirmed (§2.9) with the durable recipe. */
  async setBackupConfirmed(confirmed: boolean): Promise<void> {
    await this.patch((file) => {
      file.backupConfirmed = confirmed;
    });
  }

  /** Persist the fresh-address monotonic counter (§3.1). */
  async setNextReceiveIndex(next: number): Promise<void> {
    if (!Number.isSafeInteger(next) || next < 0) {
      throw new TypeError(`nextReceiveIndex must be a non-negative integer, got ${next}`);
    }
    await this.patch((file) => {
      // Monotonic: never move the counter backwards.
      file.nextReceiveIndex = Math.max(file.nextReceiveIndex ?? 0, next);
    });
  }

  /**
   * Selective wipe (§2.4): zeroes encryptedSeed/salt/iv, PRESERVES descriptor
   * and createdAt — view-only survives and a future restore can detect
   * DESCRIPTOR_MISMATCH (parity with wipeSensitiveCredentials).
   */
  async wipeSeed(): Promise<void> {
    await this.patch((file) => {
      file.encryptedSeed = null;
      file.salt = null;
      file.iv = null;
    });
  }
}
