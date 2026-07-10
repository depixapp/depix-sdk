// The local wallet MCP facade registers EXACTLY the MVP catalog (§6.2), every
// name prefixed `wallet_` (G10) and disjoint from the 16 remote tools, with
// unit-explicit money fields and ceiling-bound wait tools.

import { describe, expect, it } from "vitest";
import { WALLET_TOOL_NAMES } from "../src/mcp/server.js";
import { MAX_WAIT_SECONDS_CEILING } from "../src/mcp/schemas.js";
import { connectWallet, FakeWallet } from "./support/mcp.js";

// The 16 tools of the remote @depixapp/mcp (F2) — the set we must NOT collide with.
const REMOTE_TOOLS = [
  "create_checkout",
  "get_checkout",
  "list_checkouts",
  "simulate_checkout_payment",
  "wait_for_checkout",
  "create_product",
  "list_products",
  "get_product",
  "update_product",
  "activate_product",
  "deactivate_product",
  "set_featured_products",
  "list_product_checkouts",
  "get_account",
  "get_deposit_status",
  "get_withdrawal_status",
];

const MVP = [
  "wallet_status",
  "wallet_get_address",
  "wallet_get_balances",
  "wallet_list_transactions",
  "wallet_send",
  "wallet_create_deposit",
  "wallet_wait_deposit",
  "wallet_create_withdrawal",
  "wallet_wait_withdrawal",
  "wallet_get_guardrails",
];

// PR8b/PR5c fast-follow (§6.2): SideSwap + Boltz Lightning/stablecoin +
// CryptoRefills + SideShift (wallet_shift_usdt — the ONE custodial tool, §5.4/G4).
const FAST_FOLLOW = [
  "wallet_swap_quote",
  "wallet_swap_execute",
  "wallet_pay_lightning_invoice",
  "wallet_receive_lightning",
  "wallet_to_stablecoin",
  "wallet_buy_giftcard",
  "wallet_list_giftcard_orders",
  "wallet_shift_usdt",
];

const EXPECTED = [...MVP, ...FAST_FOLLOW].sort();

describe("wallet MCP catalog (§6.2 — 10 MVP + 8 fast-follow wallet_* tools)", () => {
  it("initialize handshake succeeds and lists the MVP catalog PLUS the fast-follows", async () => {
    const { client } = await connectWallet({ wallet: new FakeWallet() });
    // The connect above already ran initialize; capability read confirms the handshake.
    expect(client.getServerVersion()?.name).toBe("com.depixapp/wallet");
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(EXPECTED);
    expect(names.length).toBe(18);
    // All 10 MVP tools survive; every fast-follow is present.
    for (const n of [...MVP, ...FAST_FOLLOW]) expect(names).toContain(n);
  });

  it("exposes wallet_shift_usdt and marks it CUSTODIAL in the description (§5.4/G4)", async () => {
    const { client } = await connectWallet({ wallet: new FakeWallet() });
    const { tools } = await client.listTools();
    const shift = tools.find((t) => t.name === "wallet_shift_usdt");
    expect(shift).toBeDefined();
    expect(shift!.description?.toUpperCase()).toContain("CUSTODIAL");
    // Unit-explicit input + the custodial marker in the output schema.
    const input = shift!.inputSchema as { properties?: Record<string, unknown> };
    expect(input.properties).toHaveProperty("amount_sats");
    expect(input.properties).not.toHaveProperty("amount");
    const output = shift!.outputSchema as { properties?: Record<string, unknown> };
    expect(output.properties).toHaveProperty("custodial");
  });

  it("WALLET_TOOL_NAMES matches the registered catalog", async () => {
    const { client } = await connectWallet({ wallet: new FakeWallet() });
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect([...WALLET_TOOL_NAMES].sort()).toEqual(names);
  });

  it("every tool is prefixed `wallet_`", async () => {
    const { client } = await connectWallet({ wallet: new FakeWallet() });
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of names) expect(n.startsWith("wallet_")).toBe(true);
  });

  it("has ZERO collision with the 16 remote (@depixapp/mcp) tools", async () => {
    const { client } = await connectWallet({ wallet: new FakeWallet() });
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const remote of REMOTE_TOOLS) expect(names.has(remote)).toBe(false);
    // And symmetrically: no wallet_ name appears in the remote set.
    for (const n of names) expect(REMOTE_TOOLS).not.toContain(n);
  });

  it("every tool advertises input AND output schemas, with no $ref", async () => {
    const { client } = await connectWallet({ wallet: new FakeWallet() });
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.inputSchema, `${t.name} inputSchema`).toBeDefined();
      expect(t.outputSchema, `${t.name} outputSchema`).toBeDefined();
    }
    // Hosts may not resolve $ref — the schema must be fully inline.
    expect(JSON.stringify(tools)).not.toContain('"$ref"');
  });

  it("money fields carry their UNIT in the name — never a bare `amount`", async () => {
    const { client } = await connectWallet({ wallet: new FakeWallet() });
    const { tools } = await client.listTools();
    const props = (name: string) =>
      (tools.find((t) => t.name === name)!.inputSchema as { properties?: Record<string, unknown> })
        .properties ?? {};

    // send → base units (amount_sats), never amount / amount_cents
    const send = props("wallet_send");
    expect(send).toHaveProperty("amount_sats");
    expect(send).not.toHaveProperty("amount");
    expect(send).not.toHaveProperty("amount_cents");

    // deposit → BRL cents + disambiguated payer document
    const dep = props("wallet_create_deposit");
    expect(dep).toHaveProperty("amount_cents");
    expect(dep).toHaveProperty("payer_tax_number");
    expect(dep).not.toHaveProperty("amount");

    // withdrawal → BRL cents + recipient document (a DIFFERENT person, §2.3)
    const wd = props("wallet_create_withdrawal");
    expect(wd).toHaveProperty("amount_cents");
    expect(wd).toHaveProperty("recipient_tax_number");
    expect(wd).not.toHaveProperty("payer_tax_number");
    expect(wd).not.toHaveProperty("amount");
  });

  it("wait tools cap timeout_seconds at the 900s ceiling (§6.2d)", async () => {
    const { client } = await connectWallet({ wallet: new FakeWallet() });
    const { tools } = await client.listTools();
    for (const name of ["wallet_wait_deposit", "wallet_wait_withdrawal"]) {
      const schema = tools.find((t) => t.name === name)!.inputSchema as unknown as {
        properties: { timeout_seconds: { maximum?: number } };
      };
      expect(schema.properties.timeout_seconds.maximum).toBe(MAX_WAIT_SECONDS_CEILING);
    }
  });

  it("has NO tool that exports the seed, mutates guardrails, or pays a checkout (§6.2)", () => {
    const forbidden = /mnemonic|seed|descriptor|export|set_guardrail|liquid_address|split_address|checkout/i;
    for (const n of WALLET_TOOL_NAMES) expect(n).not.toMatch(forbidden);
  });

  it("fast-follow money fields carry their UNIT and the swap tools are unit-explicit", async () => {
    const { client } = await connectWallet({ wallet: new FakeWallet() });
    const { tools } = await client.listTools();
    const props = (name: string) =>
      (tools.find((t) => t.name === name)!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};

    // swap / stablecoin move on-chain base units — amount_sats, never a bare amount.
    for (const name of ["wallet_swap_quote", "wallet_receive_lightning", "wallet_to_stablecoin"]) {
      expect(props(name), name).toHaveProperty("amount_sats");
      expect(props(name), name).not.toHaveProperty("amount");
      expect(props(name), name).not.toHaveProperty("amount_cents");
    }
  });
});

describe("stablecoin schema enums mirror the source of truth (no drift)", () => {
  it("STABLECOIN_ASSETS matches StablecoinAsset and STABLECOIN_NETWORK_IDS matches BOLTZ_STABLECOIN_NETWORKS", async () => {
    const { STABLECOIN_ASSETS, STABLECOIN_NETWORK_IDS } = await import("../src/mcp/schemas.js");
    const { BOLTZ_STABLECOIN_NETWORKS } = await import("../src/convert/boltz/stablecoin.js");
    expect([...STABLECOIN_ASSETS].sort()).toEqual(["USDC", "USDT"]);
    expect([...STABLECOIN_NETWORK_IDS].sort()).toEqual(BOLTZ_STABLECOIN_NETWORKS.map((n) => n.id).sort());
  });
});
