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

/** Current on-disk format version. v1 = PR1 (no seed AAD); v2 = §4.5 seed-bound guardrail anchor. */
export const WALLET_FILE_VERSION = 2 as const;

/**
 * AAD prefix that binds the guardrail anchor (marker + monotonic epoch) to the
 * seed's AES-256-GCM tag (spec §4.5). The anchor fields live in PLAINTEXT in
 * wallet.json but are authenticated by the seed: editing `guardrailsStateInitialized`
 * or `guardrailEpoch` changes the AAD, so the seed no longer decrypts (an
 * attacker without the passphrase cannot recompute the tag). This is what makes
 * the "stripped marker → empty window" reset attack self-defeating: stripping
 * the marker bricks signing, and a replayed old state carries a stale epoch that
 * no longer matches the (monotonic, seed-bound) anchor.
 */
const SEED_ANCHOR_AAD_PREFIX = "depix-sdk-seed-anchor-v1";

/**
 * Canonical AAD for a v2 seed given its anchor values. Deterministic so encrypt
 * (initialize / advanceGuardrailAnchor) and decrypt (decryptMnemonic) agree.
 * v1 seeds were written without an AAD → `undefined` (tolerant read, §2.4).
 */
function seedAadFor(version: 1 | 2, initialized: boolean, epoch: number): Uint8Array | undefined {
  if (version !== 2) return undefined;
  return new TextEncoder().encode(`${SEED_ANCHOR_AAD_PREFIX}|init=${initialized ? 1 : 0}|epoch=${epoch}`);
}

function seedAad(file: WalletFileV1): Uint8Array | undefined {
  return seedAadFor(file.version, file.guardrailsStateInitialized === true, file.guardrailEpoch ?? 0);
}

/** The seed-bound guardrail anchor (spec §4.5): whether the wallet has ever recorded a spend, and the monotonic epoch. */
export interface GuardrailAnchor {
  initialized: boolean;
  epoch: number;
}

export interface WalletFileV1 {
  format: "depix-sdk-wallet";
  version: 1 | 2;
  network: "mainnet";
  encryptedSeed: string | null; // base64 — AES-256-GCM of the UTF-8 mnemonic (GCM tag appended)
  salt: string | null; // base64, 16 bytes — Argon2id salt, random per wallet
  iv: string | null; // base64, 12 bytes — AES-GCM IV, random
  descriptor: string | null; // PLAINTEXT — view-only + restore comparison (frontend parity)
  createdAt: number; // epoch ms
  backupConfirmed: boolean; // §2.9 backup gate
  nextReceiveIndex: number; // §3.1 fresh-address monotonic counter
  // §4.5 guardrail anchor — BOTH fields are covered by the seed's GCM AAD (v2),
  // so they are tamper-evident: an injected agent that strips/edits them cannot
  // recompute the seed tag (no passphrase) → the seed stops decrypting.
  //   guardrailsStateInitialized: set true on the FIRST guardrail state write; its
  //     presence turns a later missing/corrupt state file into fail-closed.
  //   guardrailEpoch: monotonic counter bumped on every state write; the state
  //     file must carry the SAME epoch. A replayed older state has a smaller
  //     epoch → rejected (anti-replay). Absent on v1 / never-signed → 0/false.
  guardrailsStateInitialized?: boolean;
  guardrailEpoch?: number;
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
      // corrupted wallet.json is surfaced loudly with its OWN code — not
      // WALLET_NOT_FOUND, whose natural "not found → create one" reaction is
      // exactly wrong here (the data is present, just unreadable, and creating
      // over it would clobber a recoverable file).
      throw new WalletError(
        "WALLET_CORRUPTED",
        `wallet.json at ${this.filePath} is corrupted (invalid JSON). ` +
          "Restore from the mnemonic backup into a fresh dataDir.",
        { cause: err }
      );
    }
    const file = parsed as WalletFileV1;
    // Tolerant of both v1 (PR1, no seed AAD) and v2 (§4.5 seed-bound anchor).
    if (file.format !== "depix-sdk-wallet" || (file.version !== 1 && file.version !== 2)) {
      throw new WalletError(
        "WALLET_CORRUPTED",
        `wallet.json at ${this.filePath} has an unknown format/version — ` +
          "the file is damaged or written by an incompatible version."
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
    // Fresh seed → fresh anchor (initialized=false, epoch=0). A restore over a
    // wiped record starts a NEW guardrail history: the old rolling window is
    // meaningless once the seed is re-encrypted (§4.5).
    const ciphertext = await encryptSeed(options.mnemonic, key, iv, seedAadFor(2, false, 0));
    const file: WalletFileV1 = {
      format: "depix-sdk-wallet",
      version: WALLET_FILE_VERSION,
      network: "mainnet",
      encryptedSeed: base64.encode(ciphertext),
      salt: base64.encode(salt),
      iv: base64.encode(iv),
      descriptor: options.descriptor,
      createdAt: existing?.createdAt ?? Date.now(),
      backupConfirmed: options.backupConfirmed ?? false,
      nextReceiveIndex: existing?.nextReceiveIndex ?? 0,
      guardrailsStateInitialized: false,
      guardrailEpoch: 0
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
    // Decrypt with the seed-bound anchor AAD (§4.5). A tampered/stripped
    // guardrailsStateInitialized / guardrailEpoch changes the AAD → GCM auth
    // fails → WRONG_PASSPHRASE. This is what makes the marker un-strippable: you
    // cannot reset the guardrail marker without destroying seed access.
    return decryptSeed(
      base64.decode(file.encryptedSeed),
      key,
      base64.decode(file.iv),
      seedAad(file)
    );
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

  /** Read the seed-bound guardrail anchor (§4.5). Absent fields → {initialized:false, epoch:0}. */
  async readGuardrailAnchor(): Promise<GuardrailAnchor> {
    const file = await this.read();
    return {
      initialized: file?.guardrailsStateInitialized === true,
      epoch: file?.guardrailEpoch ?? 0
    };
  }

  /**
   * Advance the seed-bound guardrail anchor (§4.5): set `initialized=true` and
   * bump `guardrailEpoch`, RE-ENCRYPTING the seed under the new anchor AAD with a
   * fresh IV, then durably rewriting wallet.json (§2.4). Returns the new epoch.
   *
   * `key` is the SEED root AES-256-GCM key (deriveKey(passphrase, salt)) — the
   * same key that encrypted the seed — passed in so the caller's memoized key is
   * reused (no extra Argon2 per spend). Because the epoch lives inside the seed's
   * authenticated envelope, it cannot be rolled back without the passphrase, so a
   * replayed older guardrails-state.json is rejected by the epoch mismatch. Also
   * upgrades a legacy v1 record to v2 in place.
   *
   * The wallet file is small and this runs only ~a few times/day (one per signed
   * spend), so the rewrite cost is acceptable (spec §4.5).
   */
  async advanceGuardrailAnchor(key: CryptoKey): Promise<number> {
    const file = await this.read();
    if (!file) {
      throw new WalletError("WALLET_NOT_FOUND", `No wallet.json in ${this.dataDir}`);
    }
    if (!file.encryptedSeed || !file.iv) {
      throw new WalletError(
        "WALLET_NOT_FOUND",
        "Cannot advance the guardrail anchor: this wallet has no seed (wiped or view-only)."
      );
    }
    // Re-decrypt under the CURRENT anchor AAD, then re-encrypt under the NEXT one.
    const mnemonic = await decryptSeed(
      base64.decode(file.encryptedSeed),
      key,
      base64.decode(file.iv),
      seedAad(file)
    );
    const newEpoch = (file.guardrailEpoch ?? 0) + 1;
    const newIv = randomIv();
    const newCiphertext = await encryptSeed(mnemonic, key, newIv, seedAadFor(2, true, newEpoch));
    const next: WalletFileV1 = {
      ...file,
      version: WALLET_FILE_VERSION,
      encryptedSeed: base64.encode(newCiphertext),
      iv: base64.encode(newIv),
      guardrailsStateInitialized: true,
      guardrailEpoch: newEpoch
    };
    await this.write(next);
    return newEpoch;
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
