// deposit() flow (spec §3.1) — fresh address, backup gate, provider rejection,
// sandbox, no guardrail. Offline: mocked API + a real (empty) LWK wallet.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DepixWallet } from "../src/wallet.js";
import { DepixApiError, isDepixSdkError } from "../src/errors.js";
import { mockFetch, type MockResponseSpec } from "./support/mock.js";

const PASSPHRASE = "correct-horse-battery-staple";
const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function okDeposit(id: string, sandbox = false): MockResponseSpec {
  return {
    json: {
      async: false,
      response: { qrCopyPaste: `QR-${id}`, qrImageUrl: null, id, ...(sandbox ? { sandbox: true } : {}) }
    }
  };
}

let dataDir: string;
let wallet: DepixWallet;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-deposit-"));
});

afterEach(async () => {
  await wallet?.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
});

describe("deposit() flow", () => {
  it("fills depixAddress with a wallet receive address and returns { id, qrCopyPaste }", async () => {
    const { fetch, calls } = mockFetch([okDeposit("dep_1")]);
    wallet = await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC, apiKey: "sk_live_x", fetch });
    const res = await wallet.deposit({ amountCents: 1000, payerTaxNumber: "12345678909" });
    expect(res).toEqual({ id: "dep_1", qrCopyPaste: "QR-dep_1" });
    const body = JSON.parse(calls[0]!.body!);
    expect(body.amountInCents).toBe(1000);
    expect(body.payer_tax_number).toBe("12345678909");
    expect(body.depixAddress).toMatch(/^lq1/); // a real address of this wallet
  });

  it("derives a FRESH address per call (§3.1) — two deposits never reuse an address", async () => {
    const { fetch, calls } = mockFetch([okDeposit("dep_1"), okDeposit("dep_2")]);
    wallet = await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC, apiKey: "sk_live_x", fetch });
    await wallet.deposit({ amountCents: 1000, payerTaxNumber: "1" });
    await wallet.deposit({ amountCents: 1000, payerTaxNumber: "1" });
    const a = JSON.parse(calls[0]!.body!).depixAddress;
    const b = JSON.parse(calls[1]!.body!).depixAddress;
    expect(a).not.toBe(b);
  });

  it("is gated by the backup requirement (§2.9) — BACKUP_REQUIRED before confirmBackup()", async () => {
    const { fetch, calls } = mockFetch([okDeposit("dep_1")]);
    const created = await DepixWallet.create({
      dataDir,
      passphrase: PASSPHRASE,
      apiKey: "sk_live_x",
      fetch,
      interactive: false // non-interactive, no mnemonicSecured → backupConfirmed false
    });
    wallet = created.wallet;
    expect(created.backupConfirmed).toBe(false);
    await expect(wallet.deposit({ amountCents: 1000, payerTaxNumber: "1" })).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "BACKUP_REQUIRED")
    );
    expect(calls).toHaveLength(0); // no POST — blocked before touching the API
  });

  it("does NOT pass through the guardrail — a large amount is not blocked (inflow, §4.3)", async () => {
    // R$3000 > the R$100 per-tx / R$500 daily SIGNING caps; deposit must ignore
    // them (it moves no money out).
    const { fetch } = mockFetch([okDeposit("dep_big")]);
    wallet = await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC, apiKey: "sk_live_x", fetch });
    const res = await wallet.deposit({ amountCents: 300000, payerTaxNumber: "1" });
    expect(res.id).toBe("dep_big");
  });

  it("surfaces a provider rejection preserving response.errorMessage (§3.1.3)", async () => {
    const { fetch } = mockFetch([
      { status: 400, json: { response: { errorMessage: "Pagador bloqueado pela Eulen" }, error: { code: "validation_error", request_id: "r" } } }
    ]);
    wallet = await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC, apiKey: "sk_live_x", fetch });
    await expect(wallet.deposit({ amountCents: 1000, payerTaxNumber: "1" })).rejects.toSatisfy(
      (err: unknown) => err instanceof DepixApiError && err.code === "validation_error" && err.legacyErrorMessage === "Pagador bloqueado pela Eulen"
    );
  });

  it("marks a sandbox result (sk_test_ synthetic response)", async () => {
    const { fetch } = mockFetch([okDeposit("sandbox_3uw_abcd", true)]);
    wallet = await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC, apiKey: "sk_test_x", fetch });
    const res = await wallet.deposit({ amountCents: 1000, payerTaxNumber: "1" });
    expect(res.sandbox).toBe(true);
    expect(res.id).toBe("sandbox_3uw_abcd");
  });

  it("requires an apiKey — API_KEY_REQUIRED without one", async () => {
    wallet = await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC });
    await expect(wallet.deposit({ amountCents: 1000, payerTaxNumber: "1" })).rejects.toSatisfy((err: unknown) =>
      isDepixSdkError(err, "API_KEY_REQUIRED")
    );
  });
});
