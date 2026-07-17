// Seed store (spec §2.4): versioned encrypted wallet.json, durable writes,
// 0700/0600 permissions, exclusive dataDir lock, selective wipe.
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { base64 } from "@scure/base";
import { acquireDirLock } from "../src/store/dir-lock.js";
import { SeedStore } from "../src/store/seed-store.js";
import { deriveKey } from "../src/store/crypto.js";
import { isDepixSdkError } from "../src/errors.js";

const PASSPHRASE = "correct-horse-battery-staple";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DESCRIPTOR =
  "ct(slip77(9c8e4f05c7711a98c838be228bcb84924d4570ca53f35fa1c793e58841d47023),elwpkh([73c5da0a/84'/1776'/0']xpub6CRFzUgHFDaiDAQFNX7VeV9JNPDRabq6NYSpzVZ8zW8ANUCiDdenkb1gBoEZuXNZb3wPc1SVcDXgD2ww5UBtTb8s8ArAbTkoRQ8qn34KgcY/<0;1>/*))#87kykuta";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-seedstore-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function seededStore(): Promise<SeedStore> {
  const store = new SeedStore(dataDir);
  await store.initialize({
    passphrase: PASSPHRASE,
    mnemonic: MNEMONIC,
    descriptor: DESCRIPTOR
  });
  return store;
}

describe("SeedStore roundtrip", () => {
  it("initialize writes a versioned wallet.json and decrypts back", async () => {
    const store = await seededStore();
    const file = await store.read();
    expect(file).not.toBeNull();
    expect(file!.format).toBe("depix-sdk-wallet");
    expect(file!.version).toBe(2);
    expect(file!.network).toBe("mainnet");
    expect(file!.descriptor).toBe(DESCRIPTOR); // plaintext — view-only survives
    expect(file!.backupConfirmed).toBe(false);
    expect(file!.nextReceiveIndex).toBe(0);
    expect(typeof file!.createdAt).toBe("number");
    // Ciphertext, not plaintext, on disk.
    const rawOnDisk = await readFile(join(dataDir, "wallet.json"), "utf8");
    expect(rawOnDisk).not.toContain("abandon");
    const decrypted = await store.decryptMnemonic(PASSPHRASE);
    expect(decrypted).toBe(MNEMONIC);
  });

  it("wrong passphrase → WRONG_PASSPHRASE, wallet file untouched (no auto-wipe — G8)", async () => {
    const store = await seededStore();
    for (let i = 0; i < 6; i++) {
      await expect(store.decryptMnemonic("wrong-passphrase-123")).rejects.toSatisfy(
        (err: unknown) => isDepixSdkError(err, "WRONG_PASSPHRASE")
      );
    }
    // Still decryptable after 6 wrong attempts — no counter, no wipe.
    expect(await store.decryptMnemonic(PASSPHRASE)).toBe(MNEMONIC);
    const file = await store.read();
    expect(file!.encryptedSeed).not.toBeNull();
  });

  it("read() returns null when no wallet.json exists", async () => {
    const store = new SeedStore(dataDir);
    expect(await store.read()).toBeNull();
  });

  it("decryptMnemonic without a seed → WALLET_NOT_FOUND", async () => {
    const store = new SeedStore(dataDir);
    await expect(store.decryptMnemonic(PASSPHRASE)).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "WALLET_NOT_FOUND")
    );
  });

  it("guardrail anchor defaults to {false,0}, advances monotonically, and stays seed-bound (§4.5)", async () => {
    const store = await seededStore();
    expect(await store.readGuardrailAnchor()).toEqual({ initialized: false, epoch: 0 });
    // Advancing requires the seed root key (same key that encrypted the seed).
    const file = (await store.read())!;
    const key = await deriveKey(PASSPHRASE, base64.decode(file.salt!));

    expect(await store.advanceGuardrailAnchor(key)).toBe(1);
    expect(await store.advanceGuardrailAnchor(key)).toBe(2);
    expect(await store.readGuardrailAnchor()).toEqual({ initialized: true, epoch: 2 });
    // Persisted durably; a fresh handle still sees it.
    expect((await new SeedStore(dataDir).read())!.guardrailEpoch).toBe(2);
    // The seed still decrypts under the bumped anchor AAD (re-encryption worked).
    expect(await store.decryptMnemonic(PASSPHRASE)).toBe(MNEMONIC);
  });

  it("tampering the plaintext anchor fields makes the seed un-decryptable (§4.5)", async () => {
    const store = await seededStore();
    const file = (await store.read())!;
    const key = await deriveKey(PASSPHRASE, base64.decode(file.salt!));
    await store.advanceGuardrailAnchor(key); // epoch=1, marker=true
    // Strip the marker on disk (attacker with FS write, no passphrase).
    const wallet = JSON.parse(await readFile(join(dataDir, "wallet.json"), "utf8"));
    delete wallet.guardrailsStateInitialized;
    await writeFile(join(dataDir, "wallet.json"), JSON.stringify(wallet), { mode: 0o600 });
    await expect(store.decryptMnemonic(PASSPHRASE)).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "WRONG_PASSPHRASE")
    );
  });
});

describe("corrupt wallet.json is distinct from missing (WALLET_CORRUPTED)", () => {
  it("present-but-invalid JSON → WALLET_CORRUPTED (not WALLET_NOT_FOUND)", async () => {
    await writeFile(join(dataDir, "wallet.json"), "{ not valid json", { mode: 0o600 });
    const store = new SeedStore(dataDir);
    await expect(store.read()).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "WALLET_CORRUPTED")
    );
    // Crucially NOT WALLET_NOT_FOUND — a caller must not react by creating over it.
    await expect(store.read()).rejects.not.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "WALLET_NOT_FOUND")
    );
  });

  it("unknown format/version → WALLET_CORRUPTED", async () => {
    await writeFile(
      join(dataDir, "wallet.json"),
      JSON.stringify({ format: "something-else", version: 99 }),
      { mode: 0o600 }
    );
    const store = new SeedStore(dataDir);
    await expect(store.read()).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "WALLET_CORRUPTED")
    );
  });
});

describe("durability and permissions (spec §2.4)", () => {
  it("dataDir is 0700 and wallet.json is 0600", async () => {
    await seededStore();
    const dirMode = (await stat(dataDir)).mode & 0o777;
    const fileMode = (await stat(join(dataDir, "wallet.json"))).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it("rewrites leave no tmp residue and preserve a readable file", async () => {
    const store = await seededStore();
    await store.setBackupConfirmed(true);
    await store.setNextReceiveIndex(7);
    const entries = await readdir(dataDir);
    expect(entries.filter((e) => e.includes(".tmp"))).toEqual([]);
    const file = await store.read();
    expect(file!.backupConfirmed).toBe(true);
    expect(file!.nextReceiveIndex).toBe(7);
    // Seed still decryptable after in-place updates.
    expect(await store.decryptMnemonic(PASSPHRASE)).toBe(MNEMONIC);
  });

  it("a leftover tmp file from a crashed write is ignored and overwritten", async () => {
    const store = await seededStore();
    await writeFile(join(dataDir, "wallet.json.tmp"), "garbage{{{", { mode: 0o600 });
    const file = await store.read();
    expect(file!.descriptor).toBe(DESCRIPTOR);
    await store.setBackupConfirmed(true);
    expect((await store.read())!.backupConfirmed).toBe(true);
  });

  it("concurrent writes to wallet.json never tear the file (unique temp per write)", async () => {
    const store = await seededStore();
    // With a FIXED `.tmp` name, two in-flight writers open/truncate the same
    // temp and their renames interleave — leaving a half-written file that
    // reads back as WALLET_CORRUPTED. Unique temps keep every read well-formed.
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0 ? store.setNextReceiveIndex(i) : store.setBackupConfirmed(true)
      )
    );
    // Must still parse (never throws WALLET_CORRUPTED) and the seed must decrypt.
    const file = await store.read();
    expect(file).not.toBeNull();
    expect(file!.descriptor).toBe(DESCRIPTOR);
    expect(await store.decryptMnemonic(PASSPHRASE)).toBe(MNEMONIC);
    // No orphan temp files accumulate from the unique names.
    const entries = await readdir(dataDir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });
});

describe("selective wipe (spec §2.4 — parity with wipeSensitiveCredentials)", () => {
  it("zeroes seed material, preserves descriptor and createdAt", async () => {
    const store = await seededStore();
    const before = await store.read();
    await store.wipeSeed();
    const after = await store.read();
    expect(after!.encryptedSeed).toBeNull();
    expect(after!.salt).toBeNull();
    expect(after!.iv).toBeNull();
    expect(after!.descriptor).toBe(DESCRIPTOR);
    expect(after!.createdAt).toBe(before!.createdAt);
    await expect(store.decryptMnemonic(PASSPHRASE)).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "WALLET_NOT_FOUND")
    );
  });
});

describe("dataDir exclusive lock (spec §2.4 — WALLET_DIR_LOCKED)", () => {
  it("second acquire on the same dataDir fails with WALLET_DIR_LOCKED", async () => {
    const lock = await acquireDirLock(dataDir);
    try {
      await expect(acquireDirLock(dataDir)).rejects.toSatisfy((err: unknown) =>
        isDepixSdkError(err, "WALLET_DIR_LOCKED")
      );
    } finally {
      await lock.release();
    }
  });

  it("releasing the lock allows re-acquisition", async () => {
    const lock = await acquireDirLock(dataDir);
    await lock.release();
    const again = await acquireDirLock(dataDir);
    await again.release();
  });

  it("stale lock (dead PID) is broken and taken over", async () => {
    // PID 999999999 cannot exist (pid_max is far lower on macOS/Linux).
    await writeFile(join(dataDir, ".lock"), "999999999\n0\n", { mode: 0o600 });
    const lock = await acquireDirLock(dataDir);
    const content = await readFile(join(dataDir, ".lock"), "utf8");
    expect(content).toContain(String(process.pid));
    await lock.release();
  });

  it("live PID in the lock file blocks acquisition", async () => {
    // Our own PID is definitely alive.
    await writeFile(join(dataDir, ".lock"), `${process.pid}\n${Date.now()}\n`, { mode: 0o600 });
    await expect(acquireDirLock(dataDir)).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "WALLET_DIR_LOCKED")
    );
  });

  it("a live PID recorded under a DIFFERENT boot is stale (PID reuse hardening)", async () => {
    // Our own (alive) PID, but the lock records a boot id DECISIVELY different
    // from this boot: the original holder must be dead and the PID recycled —
    // take the lock over instead of staying permanently WALLET_DIR_LOCKED on a
    // false liveness match. "Decisively" means same id scheme as the current
    // host derives (mixed schemes never justify a steal — sameBoot()): a
    // different uuid where /proc exposes one, a far-off boot epoch elsewhere.
    const otherBoot = existsSync("/proc/sys/kernel/random/boot_id")
      ? "linux:00000000-0000-0000-0000-000000000000"
      : "time:some-host:1000";
    await writeFile(join(dataDir, ".lock"), `${process.pid}\n${Date.now()}\n${otherBoot}\n`, {
      mode: 0o600
    });
    const lock = await acquireDirLock(dataDir);
    const content = await readFile(join(dataDir, ".lock"), "utf8");
    expect(content.split("\n")[0]).toBe(String(process.pid));
    await lock.release();
  });
});
