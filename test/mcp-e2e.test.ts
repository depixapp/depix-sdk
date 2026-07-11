// End-to-end over the MCP facade with a REAL DepixWallet (empty LWK wallet +
// injected sandbox fetch, offline): initialize → tools/list → wallet_create_deposit
// and wallet_create_withdrawal + wallet_wait_withdrawal sandbox of one piece
// (§8.3). Proves the key never leaks and the protocol survives a corrupted
// guardrails-state.json.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DepixWallet } from "../src/wallet.js";
import { mockFetch, type MockResponseSpec, type RecordedRequest } from "./support/mock.js";
import { connectWallet } from "./support/mcp.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const PASSPHRASE = "correct-horse-battery-staple";
const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const KEY = "sk_test_ABCDEF1234567890";

function sandboxFetch(req: RecordedRequest): MockResponseSpec {
  if (req.method === "POST" && req.url.endsWith("/api/deposit")) {
    return {
      json: {
        async: false,
        response: {
          qrCopyPaste: "SANDBOX-DEPIX-TEST-MODE-DO-NOT-PAY-0000",
          qrImageUrl: null,
          id: "sandbox_dep_1",
          sandbox: true,
        },
      },
    };
  }
  if (req.method === "POST" && req.url.endsWith("/api/withdraw")) {
    return {
      json: {
        response: {
          withdrawalId: "sandbox_wd_1",
          depositAddress: "SANDBOX-LIQUID-ADDRESS-DO-NOT-PAY",
          depositAmountInCents: 9_900,
          payoutAmountInCents: 9_800,
          totalDepositAmountInCents: 10_000,
          fee_cents: 100,
          fee_address: "SANDBOX-LIQUID-FEE-ADDRESS-DO-NOT-PAY",
          sandbox: true,
        },
      },
    };
  }
  if (req.method === "GET" && req.url.includes("/api/withdrawals/")) {
    return {
      json: {
        id: "sandbox_wd_1",
        type: "withdraw",
        amount_cents: 10_000,
        status: "confirmed", // sandbox-only synthetic terminal (§3.2.10)
        created_at: "2026-07-10 12:00:00",
        updated_at: "2026-07-10 12:00:05",
        sandbox: true,
      },
    };
  }
  return { status: 404, json: { error: { code: "not_found", message: "nope" } } };
}

let dataDir: string;
let wallet: DepixWallet;
let client: Client;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-mcp-e2e-"));
});
afterEach(async () => {
  await client?.close().catch(() => {});
  await wallet?.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
});

async function openReal(): Promise<void> {
  const { fetch } = mockFetch(sandboxFetch);
  wallet = await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC, apiKey: KEY, fetch });
  ({ client } = await connectWallet({ wallet, keyMode: "test", apiKeyConfigured: true }));
}

describe("MCP facade e2e over a real wallet (sandbox, offline)", () => {
  it("handshakes and lists the 10 MVP + 8 fast-follow + 2 recovery + 1 maintenance tools over a REAL wallet", async () => {
    await openReal();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(21);
    expect(names).toContain("wallet_create_deposit");
    expect(names).toContain("wallet_create_withdrawal");
    // The real DepixWallet satisfies the extended facade → fast-follows registered.
    expect(names).toContain("wallet_swap_quote");
    expect(names).toContain("wallet_pay_lightning_invoice");
    expect(names).toContain("wallet_buy_giftcard");
    expect(names).toContain("wallet_shift_usdt");
    // Recovery wiring (fund-safety): re-drive every rail + the unified pending view.
    expect(names).toContain("wallet_recover");
    expect(names).toContain("wallet_pending");
    // Maintenance/support (PR-D): read-only health snapshot, never key material.
    expect(names).toContain("wallet_diagnostics");
  });

  it("wallet_create_deposit returns the sandbox QR", async () => {
    await openReal();
    const res = await client.callTool({
      name: "wallet_create_deposit",
      arguments: { amount_cents: 1_000, payer_tax_number: "11144477735" },
    });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as Record<string, unknown>;
    expect(out.id).toBe("sandbox_dep_1");
    expect(out.sandbox).toBe(true);
    expect(String(out.qr_copy_paste)).toMatch(/^SANDBOX-DEPIX/);
  });

  it("wallet_create_withdrawal + wallet_wait_withdrawal sandbox of one piece", async () => {
    await openReal();
    const created = await client.callTool({
      name: "wallet_create_withdrawal",
      arguments: {
        pix_key: "recipient@pix.com",
        recipient_tax_number: "11144477735",
        amount_cents: 10_000,
        mode: "send",
      },
    });
    expect(created.isError).toBeFalsy();
    const wd = created.structuredContent as Record<string, unknown>;
    expect(wd.withdrawal_id).toBe("sandbox_wd_1");
    expect(wd.sandbox).toBe(true);
    expect(wd.txid).toBeNull(); // no on-chain leg in sandbox (§3.2.11)

    const waited = await client.callTool({
      name: "wallet_wait_withdrawal",
      arguments: { id: "sandbox_wd_1", timeout_seconds: 30 },
    });
    expect(waited.isError).toBeFalsy();
    const status = waited.structuredContent as Record<string, unknown>;
    expect(status.status).toBe("confirmed"); // sandbox terminal success
    expect(status.sandbox).toBe(true);
  });

  it("wallet_diagnostics returns the REAL wallet's snapshot with no key material", async () => {
    await openReal();
    const res = await client.callTool({ name: "wallet_diagnostics", arguments: {} });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as Record<string, unknown>;
    expect(out.data_dir).toBe(dataDir);
    expect(out.backup_confirmed).toBe(true);
    expect(out.has_seed).toBe(true);
    expect(out.api_key_configured).toBe(true);
    expect(typeof out.sdk_version).toBe("string");
    expect(typeof out.lwk_version).toBe("string");
    // The fund-safety invariant end to end: no mnemonic word, no passphrase.
    const flat = JSON.stringify(out);
    expect(flat).not.toContain("abandon");
    expect(flat).not.toContain(PASSPHRASE);
  });

  it("never leaks the API key to stderr across a tool call", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      writes.push(String(c));
      return true;
    });
    await openReal();
    await client.callTool({
      name: "wallet_create_deposit",
      arguments: { amount_cents: 1_000, payer_tax_number: "1" },
    });
    spy.mockRestore();
    expect(writes.join("")).not.toContain(KEY);
  });

  it("survives a corrupted guardrails-state.json — protocol intact", async () => {
    await openReal();
    await writeFile(join(dataDir, "guardrails-state.json"), "{not-json-at-all", "utf8");
    // The read tool still returns a valid structured result (the corruption is
    // logged to stderr; stdout/JSON-RPC framing is untouched — §6.1).
    const res = await client.callTool({ name: "wallet_get_guardrails", arguments: {} });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as Record<string, unknown>;
    expect(out).toHaveProperty("daily_limit_cents", 50_000);
  });
});
