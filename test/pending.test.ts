// Pending-withdrawals store + crash-safe resume (spec §3.2.9) — the
// anti-double-pay invariant. Offline: a real signed-tx hex fixture is
// re-broadcast through an injected Esplora client; nothing is ever re-signed.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64 } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PendingWithdrawals, PENDING_WITHDRAWALS_FILE } from "../src/pending.js";
import { DepixWallet } from "../src/wallet.js";
import { isDepixSdkError } from "../src/errors.js";
import { mockFetch } from "./support/mock.js";

const PASSPHRASE = "correct-horse-battery-staple";
const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// A real, small Liquid mainnet transaction hex (public) — parseable by LWK's
// Transaction.fromString. Used ONLY as opaque signed bytes to re-broadcast.
const FIXTURE_TXID = "21cb9e1fd71f5d9e9d9f5843f14f912ffd2f023b089fd0b78f2718fcdde52f33";
const FIXTURE_HEX =
  "0200000001010000000000000000000000000000000000000000000000000000000000000000ffffffff060365843c0101ffffffff03016d521c38ec1ea15734ae22b7c46064412829c0d0579f0a713d1c04ede979026f01000000000000000000266a240a8ce26f7f113667dccb98522fb9c292911d81ec200d31adc94501000000000000000000016d521c38ec1ea15734ae22b7c46064412829c0d0579f0a713d1c04ede979026f01000000000000010d001976a914fc26751a5025129a2fd006c6fbfa598ddd67f7e188ac016d521c38ec1ea15734ae22b7c46064412829c0d0579f0a713d1c04ede979026f01000000000000000000266a24aa21a9ed8fbc0adfe56fb749b2640b7b9131e42c6043588725c997c70c3658eea333f1510000000000000120000000000000000000000000000000000000000000000000000000000000000000000000000000";

const SALT_B64 = base64.encode(new Uint8Array(16).fill(7));

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-pending-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// ─── store unit: crypto roundtrip + tamper detection ─────────────────────────

describe("PendingWithdrawals store (§3.2.9 integrity)", () => {
  function makeStore(): PendingWithdrawals {
    return new PendingWithdrawals({ dataDir, passphrase: PASSPHRASE, saltB64: SALT_B64 });
  }

  it("roundtrips a requested → signed record", async () => {
    const store = makeStore();
    await store.putRequested({ idempotencyKey: "idem-1", request: { pixKey: "k", taxNumber: "t", depositAmountInCents: 500 } });
    let rec = await store.get("idem-1");
    expect(rec?.state).toBe("requested");
    expect(rec?.request.depositAmountInCents).toBe(500);

    await store.markSigned("idem-1", { withdrawalId: "w1", signedTxHex: FIXTURE_HEX, txid: FIXTURE_TXID });
    rec = await store.get("idem-1");
    expect(rec?.state).toBe("signed");
    expect(rec?.signedTxHex).toBe(FIXTURE_HEX);
    expect(rec?.withdrawalId).toBe("w1");
  });

  it("throws PENDING_RECORD_TAMPERED when the ciphertext is altered", async () => {
    const store = makeStore();
    await store.putRequested({ idempotencyKey: "idem-1", request: { pixKey: "k", taxNumber: "t", depositAmountInCents: 500 } });
    // Flip a byte in the stored ciphertext.
    const file = JSON.parse(await readFile(join(dataDir, PENDING_WITHDRAWALS_FILE), "utf8"));
    const ct = file.records[0].ct;
    file.records[0].ct = ct.slice(0, -2) + (ct.endsWith("A") ? "B" : "A") + "=";
    await writeFile(join(dataDir, PENDING_WITHDRAWALS_FILE), JSON.stringify(file), "utf8");

    await expect(store.get("idem-1")).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "PENDING_RECORD_TAMPERED")
    );
    const { records, tamperedIds } = await store.readAll();
    expect(records).toHaveLength(0);
    expect(tamperedIds).toEqual(["idem-1"]);
  });

  it("detects an AAD swap (auth binds the record to its withdrawalId)", async () => {
    const store = makeStore();
    await store.putRequested({ idempotencyKey: "idem-1", request: { pixKey: "k", taxNumber: "t", depositAmountInCents: 500 } });
    await store.markSigned("idem-1", { withdrawalId: "w1", signedTxHex: FIXTURE_HEX, txid: FIXTURE_TXID });
    const file = JSON.parse(await readFile(join(dataDir, PENDING_WITHDRAWALS_FILE), "utf8"));
    file.records[0].aad = "attacker-controlled"; // was withdrawalId "w1"
    await writeFile(join(dataDir, PENDING_WITHDRAWALS_FILE), JSON.stringify(file), "utf8");
    await expect(store.get("idem-1")).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "PENDING_RECORD_TAMPERED")
    );
  });
});

// ─── resume through the wallet: re-broadcast SAME bytes, never re-sign ────────

async function saltOf(dir: string): Promise<string> {
  return JSON.parse(await readFile(join(dir, "wallet.json"), "utf8")).salt as string;
}

async function pendingCount(dir: string): Promise<number> {
  try {
    return JSON.parse(await readFile(join(dir, PENDING_WITHDRAWALS_FILE), "utf8")).records.length as number;
  } catch {
    return 0;
  }
}

interface Harness {
  wallet: DepixWallet;
  broadcasts: string[];
  fetchCalls: () => number;
}

async function openWithSignedRecord(seedSignedHex: string | null, tamper = false): Promise<Harness> {
  // Restore first so wallet.json (and its salt) exists, and the dataDir lock is
  // held by the wallet. restore() does NOT auto-resume, so we control timing.
  const broadcasts: string[] = [];
  const { fetch, calls } = mockFetch(() => ({ status: 200, json: { async: false, response: { qrCopyPaste: "x", qrImageUrl: null, id: "x" } } }));
  const wallet = await DepixWallet.restore({
    dataDir,
    passphrase: PASSPHRASE,
    mnemonic: KNOWN_MNEMONIC,
    apiKey: "sk_live_x",
    fetch,
    sync: {
      worker: false,
      clientFactory: () => ({
        fullScan: async () => undefined,
        broadcast: async () => {
          throw new Error("resume must not use the PSET broadcast path");
        },
        broadcastTx: async (tx) => {
          broadcasts.push(tx.toString());
          return FIXTURE_TXID;
        },
        free: () => {}
      })
    }
  });

  if (seedSignedHex) {
    // Seed a "signed" record into the SAME store the wallet reads (same salt).
    const store = new PendingWithdrawals({ dataDir, passphrase: PASSPHRASE, saltB64: await saltOf(dataDir) });
    await store.putRequested({ idempotencyKey: "idem-resume", request: { pixKey: "k", taxNumber: "t", depositAmountInCents: 500 } });
    await store.markSigned("idem-resume", { withdrawalId: "w1", signedTxHex: seedSignedHex, txid: FIXTURE_TXID });
    if (tamper) {
      const file = JSON.parse(await readFile(join(dataDir, PENDING_WITHDRAWALS_FILE), "utf8"));
      const ct = file.records[0].ct;
      file.records[0].ct = ct.slice(0, -2) + (ct.endsWith("A") ? "B" : "A") + "=";
      await writeFile(join(dataDir, PENDING_WITHDRAWALS_FILE), JSON.stringify(file), "utf8");
    }
  }

  return { wallet, broadcasts, fetchCalls: () => calls.length };
}

describe("resumePendingWithdrawals — anti-double-pay (§3.2.9)", () => {
  it("re-broadcasts the SAME signed bytes and NEVER re-signs (no re-POST, no rebuild)", async () => {
    const h = await openWithSignedRecord(FIXTURE_HEX);
    try {
      const summary = await h.wallet.resumePendingWithdrawals();
      expect(summary.rebroadcast).toBe(1);
      expect(summary.resumed).toBe(1);
      expect(summary.discarded).toBe(0);
      // The EXACT persisted bytes were re-broadcast — not a freshly built tx.
      expect(h.broadcasts).toEqual([FIXTURE_HEX]);
      // No re-signing: the withdraw POST was never re-issued.
      expect(h.fetchCalls()).toBe(0);
      // Terminal → record removed.
      expect(await pendingCount(dataDir)).toBe(0);
    } finally {
      await h.wallet.close().catch(() => {});
    }
  });

  it("discards a tampered signed record and broadcasts NOTHING", async () => {
    const h = await openWithSignedRecord(FIXTURE_HEX, true);
    try {
      const summary = await h.wallet.resumePendingWithdrawals();
      expect(summary.discarded).toBe(1);
      expect(summary.rebroadcast).toBe(0);
      expect(h.broadcasts).toEqual([]); // nothing signed/broadcast from tampered data
      expect(await pendingCount(dataDir)).toBe(0); // discarded record removed
    } finally {
      await h.wallet.close().catch(() => {});
    }
  });

  it("auto-runs on open() — a leftover signed record is re-broadcast without a manual call", async () => {
    // Seed a signed record, then OPEN (not restore) with the same injected client.
    const salt = (async () => {
      // Create the wallet.json + salt first via a throwaway restore, then close.
      const w0 = await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC });
      const s = await saltOf(dataDir);
      await w0.close();
      return s;
    });
    const saltB64 = await salt();
    const store = new PendingWithdrawals({ dataDir, passphrase: PASSPHRASE, saltB64 });
    await store.putRequested({ idempotencyKey: "idem-open", request: { pixKey: "k", taxNumber: "t", depositAmountInCents: 500 } });
    await store.markSigned("idem-open", { withdrawalId: "w1", signedTxHex: FIXTURE_HEX, txid: FIXTURE_TXID });

    const broadcasts: string[] = [];
    const { fetch } = mockFetch(() => ({ status: 200, json: {} }));
    const wallet = await DepixWallet.open({
      dataDir,
      passphrase: PASSPHRASE,
      apiKey: "sk_live_x",
      fetch,
      sync: {
        worker: false,
        clientFactory: () => ({
          fullScan: async () => undefined,
          broadcast: async () => {
            throw new Error("no PSET broadcast");
          },
          broadcastTx: async (tx) => {
            broadcasts.push(tx.toString());
            return FIXTURE_TXID;
          },
          free: () => {}
        })
      }
    });
    try {
      // open() auto-ran resume → the leftover was already re-broadcast.
      expect(broadcasts).toEqual([FIXTURE_HEX]);
      expect(await pendingCount(dataDir)).toBe(0);
    } finally {
      await wallet.close().catch(() => {});
    }
  });
});
