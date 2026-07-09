// Seed store (spec §2.4): versioned encrypted wallet.json, durable writes,
// 0700/0600 permissions, exclusive dataDir lock, selective wipe.
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireDirLock } from "../src/store/dir-lock.js";
import { SeedStore } from "../src/store/seed-store.js";
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
    expect(file!.version).toBe(1);
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
});
