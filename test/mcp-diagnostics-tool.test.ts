// wallet_diagnostics MCP tool (PR-D, §6.2 pattern): maps ONE wallet method
// (wallet.diagnostics()), reshapes camelCase → snake_case, is registered
// read-only, and routes failures through mapToolError. The wallet layer
// already guarantees the snapshot carries no key material.

import { describe, expect, it } from "vitest";
import { connectWallet, FakeWallet } from "./support/mcp.js";

type SC = Record<string, unknown>;
function sc(result: unknown): SC {
  return (result as { structuredContent?: unknown }).structuredContent as SC;
}

describe("wallet_diagnostics", () => {
  it("calls wallet.diagnostics() and reshapes the snapshot to snake_case", async () => {
    const wallet = new FakeWallet();
    const { client } = await connectWallet({ wallet });
    const out = sc(await client.callTool({ name: "wallet_diagnostics", arguments: {} }));
    expect(wallet.lastArgs("diagnostics")).toEqual([]);
    expect(out).toEqual({
      sdk_version: "1.0.0",
      lwk_version: "0.18.0",
      data_dir: "/home/agent/.depix-wallet",
      backup_confirmed: true,
      has_seed: true,
      api_key_configured: true,
      sync: {
        last_scan_at: 1_720_000_100_000,
        last_success_at: 1_720_000_100_000,
        last_persist_failed_at: null,
        last_persist_error_name: null,
        persisted_updates: 3,
        wallet_loaded: true,
      },
      pending: {
        withdrawals: 1,
        boltz_swaps: 2,
        pegins: 0,
        sideshift_shifts: 1,
        plans: 0,
      },
      guardrails: {
        used_cents: 12_000,
        daily_limit_cents: 50_000,
        per_tx_limit_cents: 10_000,
        remaining_cents: 38_000,
        allowlist_enabled: false,
      },
    });
  });

  it("surfaces guardrails: null (unavailable readout) verbatim", async () => {
    const wallet = new FakeWallet();
    wallet.diagnosticsResult = { ...wallet.diagnosticsResult, guardrails: null };
    const { client } = await connectWallet({ wallet });
    const out = sc(await client.callTool({ name: "wallet_diagnostics", arguments: {} }));
    expect(out.guardrails).toBeNull();
  });

  it("is registered READ-ONLY and says it never exposes key material", async () => {
    const { client } = await connectWallet({ wallet: new FakeWallet() });
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "wallet_diagnostics");
    expect(tool).toBeDefined();
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    expect(tool!.description?.toLowerCase()).toContain("key material");
  });

  it("maps a wallet failure through mapToolError (isError result)", async () => {
    const wallet = new FakeWallet();
    wallet.throws.diagnostics = new Error("kaboom");
    const { client } = await connectWallet({ wallet });
    const result = await client.callTool({ name: "wallet_diagnostics", arguments: {} });
    expect(result.isError).toBe(true);
  });
});
