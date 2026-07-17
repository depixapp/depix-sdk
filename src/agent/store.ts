// Encrypted at-rest store for the agent Ed25519 identity key. Mirrors the
// seed-store/pending envelope pattern: the 32-byte secret key is sealed with
// AES-256-GCM under a key derived (Argon2id) from a passphrase + a per-store
// salt, with the public key hex as AAD so a tampered file fails the GCM tag
// instead of loading a swapped key. Written with writeFileDurable (fsync).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { base64 } from "@scure/base";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { AgentError } from "../errors.js";
import { defaultLogger, type Logger } from "../logger.js";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  assertStrongPassphrase,
  deriveKey,
  randomIv,
  randomSalt,
} from "../store/crypto.js";
import { ensureDir, writeFileDurable } from "../store/fs-util.js";
import { keypairFromSecret, type AgentKeypair } from "./keypair.js";

export const AGENT_IDENTITY_FILE = "agent-identity.json";

/** Persisted metadata about the registered agent (never secret). */
export interface AgentIdentityMeta {
  username?: string;
  merchantId?: string;
  registeredAt?: string;
  apiBase?: string;
}

interface AgentIdentityFileV1 {
  format: "depix-agent-identity";
  version: 1;
  /** Argon2id salt (base64) — per store. */
  salt: string;
  /** Ed25519 public key, 64 hex — plaintext locator + GCM AAD. */
  publicKeyHex: string;
  /** Sealed secret key. */
  secret: { iv: string; ct: string };
  meta: AgentIdentityMeta;
}

export interface AgentKeyStoreOptions {
  dataDir: string;
  passphrase: string;
  logger?: Logger;
}

export interface LoadedIdentity {
  keypair: AgentKeypair;
  meta: AgentIdentityMeta;
}

export class AgentKeyStore {
  private readonly dataDir: string;
  private readonly passphrase: string;
  private readonly logger: Logger;
  private readonly path: string;

  constructor(options: AgentKeyStoreOptions) {
    this.dataDir = options.dataDir;
    this.passphrase = options.passphrase;
    this.logger = options.logger ?? defaultLogger;
    this.path = join(this.dataDir, AGENT_IDENTITY_FILE);
  }

  /** Read the raw file, or null when it does not exist yet. */
  private async readFileV1(): Promise<AgentIdentityFileV1 | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new AgentError("agent_store_corrupted", `Agent identity file is not valid JSON: ${this.path}`, {
        cause: err,
      });
    }
    const file = parsed as AgentIdentityFileV1;
    if (file?.format !== "depix-agent-identity" || file.version !== 1 || !file.secret?.ct) {
      throw new AgentError("agent_store_corrupted", `Agent identity file has an unexpected shape: ${this.path}`);
    }
    return file;
  }

  /** True when an identity is already stored. */
  async exists(): Promise<boolean> {
    return (await this.readFileV1()) !== null;
  }

  /** Load and decrypt the keypair + meta, or null when uninitialized. */
  async load(): Promise<LoadedIdentity | null> {
    const file = await this.readFileV1();
    if (!file) return null;
    const salt = base64.decode(file.salt);
    const key = await deriveKey(this.passphrase, salt);
    let secretKey: Uint8Array;
    try {
      secretKey = await aesGcmDecrypt(
        base64.decode(file.secret.ct),
        key,
        base64.decode(file.secret.iv),
        utf8ToBytes(file.publicKeyHex)
      );
    } catch (err) {
      // Wrong passphrase OR tampered file — GCM can't tell us which.
      throw new AgentError(
        "agent_key_unreadable",
        "Could not decrypt the agent identity key: wrong passphrase or the file was tampered with.",
        { cause: err }
      );
    }
    const keypair = keypairFromSecret(secretKey);
    if (keypair.publicKeyHex !== file.publicKeyHex) {
      throw new AgentError("agent_store_corrupted", "Stored public key does not match the decrypted secret key.");
    }
    return { keypair, meta: file.meta ?? {} };
  }

  /** Persist a keypair (fresh salt) with initial meta. Overwrites any existing file. */
  async save(keypair: AgentKeypair, meta: AgentIdentityMeta = {}): Promise<void> {
    assertStrongPassphrase(this.passphrase);
    await ensureDir(this.dataDir);
    const salt = randomSalt();
    const iv = randomIv();
    const key = await deriveKey(this.passphrase, salt);
    const ct = await aesGcmEncrypt(keypair.secretKey, key, iv, utf8ToBytes(keypair.publicKeyHex));
    const file: AgentIdentityFileV1 = {
      format: "depix-agent-identity",
      version: 1,
      salt: base64.encode(salt),
      publicKeyHex: keypair.publicKeyHex,
      secret: { iv: base64.encode(iv), ct: base64.encode(ct) },
      meta,
    };
    await writeFileDurable(this.path, JSON.stringify(file));
    this.logger.debug("agent.identity.saved", { publicKeyHex: keypair.publicKeyHex });
  }

  /** Merge a metadata patch, preserving the sealed secret + salt. No-op if uninitialized. */
  async updateMeta(patch: AgentIdentityMeta): Promise<void> {
    const file = await this.readFileV1();
    if (!file) return;
    file.meta = { ...file.meta, ...patch };
    await writeFileDurable(this.path, JSON.stringify(file));
  }
}
