// DepixWallet lifecycle (spec §2.3/§2.4/§2.9/§3.1):
// create/restore/open, the backup gate, fresh receive addresses, wipe.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DepixWallet } from "../src/wallet.js";
import { UpdateStore } from "../src/store/update-store.js";
import { isDepixSdkError } from "../src/errors.js";

const PASSPHRASE = "correct-horse-battery-staple";
const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const GOLDEN_ADDR_0 =
  "lq1qqvxk052kf3qtkxmrakx50a9gc3smqad2ync54hzntjt980kfej9kkfe0247rp5h4yzmdftsahhw64uy8pzfe7cpg4fgykm7cv";
const GOLDEN_ADDR_1 =
  "lq1qqfk0uw9vlmqlggzs7cxmw49x8ks37l87udspmpt3ssgxjrkqqlww63xvus3c5gaz89r2kd393c4fvurwxf06qj87y2kd3vsln";

let dataDir: string;
const openedWallets: DepixWallet[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-wallet-"));
});

afterEach(async () => {
  for (const w of openedWallets.splice(0)) {
    await w.close().catch(() => {});
  }
  await rm(dataDir, { recursive: true, force: true });
});

function track<T extends DepixWallet>(wallet: T): T {
  openedWallets.push(wallet);
  return wallet;
}

describe("create() — non-interactive (spec §2.9)", () => {
  it("returns the mnemonic in the foreground and is NOT backup-confirmed by default", async () => {
    const created = await DepixWallet.create({ dataDir, passphrase: PASSPHRASE });
    track(created.wallet);
    expect(created.mnemonic.split(" ")).toHaveLength(12);
    expect(created.descriptor.startsWith("ct(slip77(")).toBe(true);
    expect(created.backupConfirmed).toBe(false);
    expect(created.wallet.isBackupConfirmed()).toBe(false);
  });

  it("blocks getReceiveAddress with BACKUP_REQUIRED until confirmBackup()", async () => {
    const { wallet } = await DepixWallet.create({ dataDir, passphrase: PASSPHRASE });
    track(wallet);
    await expect(wallet.getReceiveAddress()).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "BACKUP_REQUIRED")
    );
    // Explicit-index derivation is gated too — the invariant is "no receive
    // address before a confirmed backup", not "no counter bump".
    await expect(wallet.getReceiveAddress({ index: 0 })).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "BACKUP_REQUIRED")
    );
    await wallet.confirmBackup();
    const addr = await wallet.getReceiveAddress();
    expect(addr.startsWith("lq1")).toBe(true);
  });

  it("mnemonicSecured: true is an explicit, conscious opt-in that skips the gate", async () => {
    const created = await DepixWallet.create({
      dataDir,
      passphrase: PASSPHRASE,
      mnemonicSecured: true
    });
    track(created.wallet);
    expect(created.backupConfirmed).toBe(true);
    const addr = await created.wallet.getReceiveAddress();
    expect(addr.startsWith("lq1")).toBe(true);
  });

  it("rejects weak passphrases with WEAK_PASSPHRASE", async () => {
    await expect(DepixWallet.create({ dataDir, passphrase: "short" })).rejects.toSatisfy(
      (err: unknown) => isDepixSdkError(err, "WEAK_PASSPHRASE")
    );
  });

  it("refuses to overwrite an existing wallet (WALLET_ALREADY_EXISTS)", async () => {
    const { wallet } = await DepixWallet.create({ dataDir, passphrase: PASSPHRASE });
    track(wallet);
    await wallet.close();
    await expect(DepixWallet.create({ dataDir, passphrase: PASSPHRASE })).rejects.toSatisfy(
      (err: unknown) => isDepixSdkError(err, "WALLET_ALREADY_EXISTS")
    );
  });

  it("imports a provided mnemonic (INVALID_MNEMONIC on checksum failure)", async () => {
    await expect(
      DepixWallet.create({
        dataDir,
        passphrase: PASSPHRASE,
        mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon"
      })
    ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "INVALID_MNEMONIC"));
    const created = await DepixWallet.create({
      dataDir,
      passphrase: PASSPHRASE,
      mnemonic: KNOWN_MNEMONIC,
      mnemonicSecured: true
    });
    track(created.wallet);
    expect(created.mnemonic).toBe(KNOWN_MNEMONIC);
  });
});

describe("restore() (spec §2.9 — proof of possession)", () => {
  it("is born backup-confirmed and derives the known address", async () => {
    const wallet = track(
      await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC })
    );
    expect(wallet.isBackupConfirmed()).toBe(true);
    expect(await wallet.getReceiveAddress({ index: 0 })).toBe(GOLDEN_ADDR_0);
  });

  it("detects DESCRIPTOR_MISMATCH when restoring a different mnemonic over a wiped wallet", async () => {
    const created = await DepixWallet.create({
      dataDir,
      passphrase: PASSPHRASE,
      mnemonicSecured: true
    });
    track(created.wallet);
    await created.wallet.wipe();
    await created.wallet.close();
    await expect(
      DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC })
    ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "DESCRIPTOR_MISMATCH"));
    // Restoring the ORIGINAL mnemonic over the wiped wallet works.
    const restored = track(
      await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: created.mnemonic })
    );
    expect(await restored.exportMnemonic()).toBe(created.mnemonic);
  });
});

describe("open() (spec §2.4)", () => {
  it("open() on a dataDir without a wallet → WALLET_NOT_FOUND (never auto-creates)", async () => {
    await expect(DepixWallet.open({ dataDir, passphrase: PASSPHRASE })).rejects.toSatisfy(
      (err: unknown) => isDepixSdkError(err, "WALLET_NOT_FOUND")
    );
  });

  it("open() with the wrong passphrase → WRONG_PASSPHRASE, and the wallet survives", async () => {
    const { wallet } = await DepixWallet.create({
      dataDir,
      passphrase: PASSPHRASE,
      mnemonicSecured: true
    });
    track(wallet);
    await wallet.close();
    for (let i = 0; i < 3; i++) {
      await expect(
        DepixWallet.open({ dataDir, passphrase: "totally-wrong-passphrase" })
      ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "WRONG_PASSPHRASE"));
    }
    const reopened = track(await DepixWallet.open({ dataDir, passphrase: PASSPHRASE }));
    expect(reopened.isBackupConfirmed()).toBe(true);
  });

  it("enforces the exclusive dataDir lock (WALLET_DIR_LOCKED) and releases it on close", async () => {
    const { wallet } = await DepixWallet.create({
      dataDir,
      passphrase: PASSPHRASE,
      mnemonicSecured: true
    });
    track(wallet);
    await expect(DepixWallet.open({ dataDir, passphrase: PASSPHRASE })).rejects.toSatisfy(
      (err: unknown) => isDepixSdkError(err, "WALLET_DIR_LOCKED")
    );
    await wallet.close();
    const reopened = track(await DepixWallet.open({ dataDir, passphrase: PASSPHRASE }));
    expect(reopened.getDescriptor()).toBe(wallet.getDescriptor());
  });

  it("reads passphrase and dataDir from the environment", async () => {
    const { wallet } = await DepixWallet.create({
      dataDir,
      passphrase: PASSPHRASE,
      mnemonicSecured: true
    });
    track(wallet);
    await wallet.close();
    process.env.DEPIX_WALLET_DIR = dataDir;
    process.env.DEPIX_WALLET_PASSPHRASE = PASSPHRASE;
    try {
      const opened = track(await DepixWallet.open());
      expect(opened.getDescriptor()).toBe(wallet.getDescriptor());
    } finally {
      delete process.env.DEPIX_WALLET_DIR;
      delete process.env.DEPIX_WALLET_PASSPHRASE;
    }
  });
});

describe("backup export (spec §2.9)", () => {
  it("exportBackup defaults to the mnemonic target; exportMnemonic is sugar", async () => {
    const wallet = track(
      await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC })
    );
    const backup = await wallet.exportBackup();
    expect(backup).toEqual({ kind: "mnemonic", mnemonic: KNOWN_MNEMONIC });
    expect(await wallet.exportMnemonic()).toBe(KNOWN_MNEMONIC);
  });

  it("export → confirm unlocks the gate", async () => {
    const { wallet } = await DepixWallet.create({ dataDir, passphrase: PASSPHRASE });
    track(wallet);
    const backup = await wallet.exportBackup({ kind: "mnemonic" });
    expect(backup.mnemonic.split(" ")).toHaveLength(12);
    await wallet.confirmBackup();
    expect(wallet.isBackupConfirmed()).toBe(true);
    expect((await wallet.getReceiveAddress()).startsWith("lq1")).toBe(true);
  });
});

describe("fresh receive address per call (spec §3.1, decision 2026-07-10)", () => {
  it("consecutive calls return different addresses (monotonic index), unlike raw LWK last-unused", async () => {
    const wallet = track(
      await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC })
    );
    const first = await wallet.getReceiveAddress();
    const second = await wallet.getReceiveAddress();
    expect(first).toBe(GOLDEN_ADDR_0); // max(lwk_last_unused=0, next=0) → 0
    expect(second).toBe(GOLDEN_ADDR_1); // counter bumped → 1
    expect(first).not.toBe(second);
  });

  it("the counter survives a restart (persisted BEFORE the address is returned)", async () => {
    const wallet = track(
      await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC })
    );
    await wallet.getReceiveAddress(); // index 0
    await wallet.getReceiveAddress(); // index 1
    await wallet.close();
    const reopened = track(await DepixWallet.open({ dataDir, passphrase: PASSPHRASE }));
    const third = await reopened.getReceiveAddress();
    expect(third).not.toBe(GOLDEN_ADDR_0);
    expect(third).not.toBe(GOLDEN_ADDR_1);
  });

  it("explicit-index derivation does not consume the monotonic counter", async () => {
    const wallet = track(
      await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC })
    );
    expect(await wallet.getReceiveAddress({ index: 0 })).toBe(GOLDEN_ADDR_0);
    expect(await wallet.getReceiveAddress({ index: 0 })).toBe(GOLDEN_ADDR_0);
    // Default path still starts at 0 — explicit lookups didn't burn indexes.
    expect(await wallet.getReceiveAddress()).toBe(GOLDEN_ADDR_0);
    expect(await wallet.getReceiveAddress()).toBe(GOLDEN_ADDR_1);
  });

  it("handing out an address raises the degraded-scan coverage floor (cba130f follow-up)", async () => {
    // The SDK's nextReceiveIndex runs AHEAD of lwk's last-used view — a payer
    // may hold an address no scan has proven used yet. A payment to it during
    // a waterfalls outage must not be invisible to the truncated vanilla
    // fallback, so issuing the address bumps meta.scanToIndexHint too.
    const wallet = track(
      await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC })
    );
    const store = new UpdateStore(dataDir);
    await wallet.getReceiveAddress(); // index 0 → floor 1
    await wallet.getReceiveAddress(); // index 1 → floor 2
    expect(await store.readScanHint()).toBe(2);
    // Explicit-index derivation deliberately does NOT move the floor — a
    // typoed huge index would poison every degraded scan up to the clamp.
    await wallet.getReceiveAddress({ index: 7 });
    expect(await store.readScanHint()).toBe(2);
  });

  it("concurrent getReceiveAddress() calls never collide (per-instance mutex)", async () => {
    const wallet = track(
      await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC })
    );
    // Without serialization these read the SAME counter and derive the SAME
    // address (the counter advances by 1 instead of N) — the exact regression
    // the fresh-address decision (§3.1) exists to prevent.
    const N = 8;
    const addrs = await Promise.all(
      Array.from({ length: N }, () => wallet.getReceiveAddress())
    );
    expect(new Set(addrs).size).toBe(N); // all distinct — no shared index
    // The counter advanced by exactly N: the next call is a brand-new address.
    const next = await wallet.getReceiveAddress();
    expect(addrs).not.toContain(next);
    expect(new Set([...addrs, next]).size).toBe(N + 1);
  });
});

describe("wipe() (spec §2.4 — selective)", () => {
  it("wipes the seed but keeps the descriptor (view-only survives)", async () => {
    const wallet = track(
      await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC })
    );
    const descriptor = wallet.getDescriptor();
    await wallet.wipe();
    expect(wallet.getDescriptor()).toBe(descriptor);
    await expect(wallet.exportMnemonic()).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "WALLET_NOT_FOUND")
    );
  });

  it("a wiped wallet reopens view-only WITHOUT a passphrase", async () => {
    const wallet = track(
      await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC })
    );
    const descriptor = wallet.getDescriptor();
    await wallet.wipe();
    await wallet.close();
    const viewOnly = track(await DepixWallet.open({ dataDir })); // no passphrase
    expect(viewOnly.getDescriptor()).toBe(descriptor);
    const { balances } = await viewOnly.getBalances();
    expect(balances.DEPIX).toBe(0n);
    await expect(viewOnly.exportMnemonic()).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "WALLET_NOT_FOUND")
    );
  });
});

describe("backup gate persistence", () => {
  it("backupConfirmed: false survives a restart — the gate holds after reopen", async () => {
    const { wallet } = await DepixWallet.create({ dataDir, passphrase: PASSPHRASE });
    track(wallet);
    await wallet.close();
    const reopened = track(await DepixWallet.open({ dataDir, passphrase: PASSPHRASE }));
    expect(reopened.isBackupConfirmed()).toBe(false);
    await expect(reopened.getReceiveAddress()).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "BACKUP_REQUIRED")
    );
    await reopened.confirmBackup();
    await reopened.close();
    const third = track(await DepixWallet.open({ dataDir, passphrase: PASSPHRASE }));
    expect(third.isBackupConfirmed()).toBe(true);
  });
});

describe("read surface", () => {
  it("getBalances returns the three assets as bigints; an empty wallet estimates R$0 with no quote (§4.4)", async () => {
    const wallet = track(
      await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC })
    );
    const { balances, brlEstimate } = await wallet.getBalances();
    expect(balances.DEPIX).toBe(0n);
    expect(balances.USDT).toBe(0n);
    expect(balances.LBTC).toBe(0n);
    // All balances zero → no quote is needed → an honest R$0 (null is reserved
    // for a genuinely unavailable quote on a non-zero non-DePix balance).
    expect(brlEstimate).toBe(0);
  });

  it("listTransactions returns a typed empty list for a fresh wallet", async () => {
    const wallet = track(
      await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC })
    );
    expect(await wallet.listTransactions()).toEqual([]);
  });
});
