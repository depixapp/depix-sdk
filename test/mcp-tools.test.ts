// Each wallet_* tool maps to the right DepixWallet method with correct argument
// translation (snake_case → camelCase, unit parsing) and JSON-safe reshaping
// (bigint sats → strings). Wait tools convert seconds→ms and clamp to the ceiling.

import { describe, expect, it } from "vitest";
import { connectWallet, FakeWallet } from "./support/mcp.js";
import { waitDepositTool, waitWithdrawalTool } from "../src/mcp/tools.js";

type SC = Record<string, unknown>;
function sc(result: unknown): SC {
  return (result as { structuredContent?: unknown }).structuredContent as SC;
}

describe("wallet_status", () => {
  it("reports mode from ctx, backup, guardrail budget and boot resume", async () => {
    const wallet = new FakeWallet();
    const { client } = await connectWallet({
      wallet,
      keyMode: "live",
      apiKeyConfigured: true,
      bootResume: { resumed: 2, rebroadcast: 1, reposted: 1, discarded: 0, failed: 0 },
    });
    const out = sc(await client.callTool({ name: "wallet_status", arguments: {} }));
    expect(out.mode).toBe("live");
    expect(out.api_key_configured).toBe(true);
    expect(out.backup_confirmed).toBe(true);
    expect(out.guardrails).toMatchObject({
      used_cents: 12_000,
      daily_limit_cents: 50_000,
      per_tx_limit_cents: 10_000,
      remaining_cents: 38_000,
      allowlist_enabled: false,
    });
    expect(out.pending_withdrawals).toMatchObject({ resumed: 2, rebroadcast: 1, reposted: 1 });
  });
});

describe("wallet_get_address", () => {
  it("returns a fresh address and calls getReceiveAddress()", async () => {
    const wallet = new FakeWallet();
    const { client } = await connectWallet({ wallet });
    const out = sc(await client.callTool({ name: "wallet_get_address", arguments: {} }));
    expect(out.address).toBe(wallet.address);
    expect(wallet.lastArgs("getReceiveAddress")).toEqual([undefined]);
  });

  it("forwards an explicit index", async () => {
    const wallet = new FakeWallet();
    const { client } = await connectWallet({ wallet });
    await client.callTool({ name: "wallet_get_address", arguments: { index: 7 } });
    expect(wallet.lastArgs("getReceiveAddress")).toEqual([{ index: 7 }]);
  });
});

describe("wallet_get_balances", () => {
  it("converts bigint sats to strings and surfaces the BRL estimate", async () => {
    const wallet = new FakeWallet();
    const { client } = await connectWallet({ wallet });
    const out = sc(await client.callTool({ name: "wallet_get_balances", arguments: {} }));
    expect(out.balances).toEqual({ depix_sats: "1500000", lbtc_sats: "4200", usdt_sats: "0" });
    expect(out.brl_estimate_cents).toBe(15_042);
  });
});

describe("wallet_list_transactions", () => {
  it("reshapes with bigints as signed strings", async () => {
    const wallet = new FakeWallet();
    const { client } = await connectWallet({ wallet });
    const out = sc(await client.callTool({ name: "wallet_list_transactions", arguments: {} }));
    const tx = (out.transactions as SC[])[0]!;
    expect(tx.txid).toBe("aa".repeat(32));
    expect(tx.fee_sats).toBe("26");
    expect(tx.balance).toEqual({ DEPIX: "1500000", LBTC: "-26" });
    expect(tx.height).toBe(3_000_000);
  });
});

describe("wallet_send", () => {
  it("parses amount_sats → bigint and forwards asset/address", async () => {
    const wallet = new FakeWallet();
    const { client } = await connectWallet({ wallet });
    const out = sc(
      await client.callTool({
        name: "wallet_send",
        arguments: { asset: "LBTC", amount_sats: "4200", address: "lq1qdest" },
      }),
    );
    expect(out.txid).toBe(wallet.sendResult.txid);
    expect(wallet.lastArgs("send")).toEqual([{ asset: "LBTC", amountSats: 4200n, address: "lq1qdest" }]);
  });
});

describe("wallet_create_deposit", () => {
  it("maps amount_cents/payer_tax_number and returns the QR", async () => {
    const wallet = new FakeWallet();
    const { client } = await connectWallet({ wallet });
    const out = sc(
      await client.callTool({
        name: "wallet_create_deposit",
        arguments: { amount_cents: 1_000, payer_tax_number: "12345678909" },
      }),
    );
    expect(out).toEqual({ id: "dep_1", qr_copy_paste: "00020126-QR" });
    expect(wallet.lastArgs("deposit")).toEqual([{ amountCents: 1_000, payerTaxNumber: "12345678909" }]);
  });

  it("surfaces the sandbox flag", async () => {
    const wallet = new FakeWallet();
    wallet.depositResult = { id: "sandbox_1", qrCopyPaste: "SANDBOX-DO-NOT-PAY", sandbox: true };
    const { client } = await connectWallet({ wallet });
    const out = sc(
      await client.callTool({
        name: "wallet_create_deposit",
        arguments: { amount_cents: 1_000, payer_tax_number: "1" },
      }),
    );
    expect(out.sandbox).toBe(true);
  });
});

describe("wallet_create_withdrawal", () => {
  it("maps pix_key/recipient_tax_number/amount_cents/mode and reshapes the result", async () => {
    const wallet = new FakeWallet();
    const { client } = await connectWallet({ wallet });
    const out = sc(
      await client.callTool({
        name: "wallet_create_withdrawal",
        arguments: {
          pix_key: "a@b.com",
          recipient_tax_number: "11144477735",
          amount_cents: 10_000,
          mode: "send",
        },
      }),
    );
    expect(out).toMatchObject({
      withdrawal_id: "wd_1",
      fee_cents: 100,
      fee_address: "ex1qfee",
      net_cents: 9_900,
      gross_cents: 10_000,
      payout_cents: 9_800,
    });
    expect(wallet.lastArgs("withdraw")).toEqual([
      { pixKey: "a@b.com", recipientTaxNumber: "11144477735", amountCents: 10_000, mode: "send" },
    ]);
  });
});

describe("wallet_wait_deposit / wallet_wait_withdrawal", () => {
  it("converts seconds → ms with the documented defaults", async () => {
    const wallet = new FakeWallet();
    const { client } = await connectWallet({ wallet });
    await client.callTool({ name: "wallet_wait_deposit", arguments: { id: "dep_1" } });
    expect(wallet.lastWaitOptions).toEqual({ intervalMs: 5_000, timeoutMs: 300_000 });
  });

  it("forwards explicit interval/timeout and returns the status shape", async () => {
    const wallet = new FakeWallet();
    const { client } = await connectWallet({ wallet });
    const out = sc(
      await client.callTool({
        name: "wallet_wait_withdrawal",
        arguments: { id: "wd_1", interval_seconds: 10, timeout_seconds: 120 },
      }),
    );
    expect(out.status).toBe("sent");
    expect(out.liquid_txid).toBe("cc".repeat(32));
    expect(wallet.lastWaitOptions).toEqual({ intervalMs: 10_000, timeoutMs: 120_000 });
  });

  it("clamps timeout_seconds to the server ceiling (handler defense-in-depth)", async () => {
    const wallet = new FakeWallet();
    // Directly exercise the handler with a low ceiling and an over-ceiling request.
    await waitDepositTool(wallet, { id: "dep_1", timeout_seconds: 5_000 }, 60);
    expect(wallet.lastWaitOptions).toEqual({ intervalMs: 5_000, timeoutMs: 60_000 });
    await waitWithdrawalTool(wallet, { id: "wd_1", timeout_seconds: 5_000 }, 60);
    expect(wallet.lastWaitOptions).toEqual({ intervalMs: 5_000, timeoutMs: 60_000 });
  });
});

describe("wallet_get_guardrails", () => {
  it("returns the read-only budget", async () => {
    const wallet = new FakeWallet();
    const { client } = await connectWallet({ wallet });
    const out = sc(await client.callTool({ name: "wallet_get_guardrails", arguments: {} }));
    expect(out).toEqual({
      used_cents: 12_000,
      daily_limit_cents: 50_000,
      per_tx_limit_cents: 10_000,
      remaining_cents: 38_000,
      allowlist_enabled: false,
    });
  });
});
