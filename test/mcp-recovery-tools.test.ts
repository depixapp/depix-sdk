// wallet_recover + wallet_pending MCP tools (§6.2 recovery wiring) and the
// wallet_status pending_conversions fold: each maps ONE wallet method, reshapes
// snake_case/JSON-safe, and routes failures through mapToolError.

import { describe, expect, it } from "vitest";
import { connectWallet, FakeWallet } from "./support/mcp.js";

type SC = Record<string, unknown>;
function sc(result: unknown): SC {
  return (result as { structuredContent?: unknown }).structuredContent as SC;
}

describe("wallet_recover", () => {
  it("calls wallet.recover() and reshapes the per-rail summary to snake_case", async () => {
    const wallet = new FakeWallet();
    const { client } = await connectWallet({ wallet });
    const out = sc(await client.callTool({ name: "wallet_recover", arguments: {} }));
    expect(wallet.lastArgs("recover")).toEqual([]);
    expect(out.withdrawals).toEqual({ resumed: 1, rebroadcast: 1, reposted: 0, discarded: 0, failed: 0 });
    expect(out.boltz).toEqual({
      submarine_resumed: 1,
      submarine_refunded: 0,
      reverse_resumed: 1,
      stablecoin_resumed: 0,
      stablecoin_refunded: 1,
      discarded: 0,
      removed: 2,
      failed: 0,
    });
    expect(out.pegin).toEqual({ pending: 1, cleared: 1, failed: 0 });
    expect(out.sideshift).toEqual({ checked: 2, refreshed: 2, failed: 0 });
  });

  it("surfaces boltz: null (view-only wallet — no Boltz rail)", async () => {
    const wallet = new FakeWallet();
    wallet.recoverResult = { ...wallet.recoverResult, boltz: null };
    const { client } = await connectWallet({ wallet });
    const out = sc(await client.callTool({ name: "wallet_recover", arguments: {} }));
    expect(out.boltz).toBeNull();
  });

  it("maps a wallet failure through mapToolError (isError result)", async () => {
    const wallet = new FakeWallet();
    wallet.throws.recover = new Error("kaboom");
    const { client } = await connectWallet({ wallet });
    const result = await client.callTool({ name: "wallet_recover", arguments: {} });
    expect(result.isError).toBe(true);
  });
});

describe("wallet_pending", () => {
  it("calls wallet.getPending() and maps each rail's fields", async () => {
    const wallet = new FakeWallet();
    const { client } = await connectWallet({ wallet });
    const out = sc(await client.callTool({ name: "wallet_pending", arguments: {} }));
    expect(wallet.lastArgs("getPending")).toEqual([]);
    const pending = out.pending as SC[];
    expect(pending).toHaveLength(4);
    expect(pending[0]).toEqual({
      rail: "withdrawal",
      id: "idem-1",
      state: "signed",
      created_at: 1_720_000_000_000,
      withdrawal_id: "wd_1",
      txid: "cc".repeat(32),
    });
    expect(pending[1]).toEqual({
      rail: "boltz",
      id: "sub_1",
      state: "locked_up",
      created_at: 1_720_000_001_000,
      swap_type: "submarine",
    });
    expect(pending[2]).toEqual({
      rail: "pegin",
      id: "peg_1",
      state: "pending",
      created_at: null,
      peg_addr: "bc1qpeg",
      recv_addr: "lq1qrecv",
    });
    expect(pending[3]).toEqual({
      rail: "sideshift",
      id: "shift_1",
      state: "waiting",
      created_at: 1_720_000_002_000,
      shift_type: "send",
      network: "tron",
    });
  });

  it("returns an empty list when nothing is in flight", async () => {
    const wallet = new FakeWallet();
    wallet.pendingItems = [];
    const { client } = await connectWallet({ wallet });
    const out = sc(await client.callTool({ name: "wallet_pending", arguments: {} }));
    expect(out.pending).toEqual([]);
  });

  it("maps a wallet failure through mapToolError (isError result)", async () => {
    const wallet = new FakeWallet();
    wallet.throws.getPending = new Error("kaboom");
    const { client } = await connectWallet({ wallet });
    const result = await client.callTool({ name: "wallet_pending", arguments: {} });
    expect(result.isError).toBe(true);
  });
});

describe("wallet_status folds the boot conversion-resume summary", () => {
  it("surfaces pending_conversions from the boot summary", async () => {
    const wallet = new FakeWallet();
    const { client } = await connectWallet({
      wallet,
      bootResume: { resumed: 2, rebroadcast: 1, reposted: 1, discarded: 0, failed: 0 },
      bootConversions: {
        boltz: {
          submarineResumed: 1,
          submarineRefunded: 1,
          reverseResumed: 0,
          stablecoinResumed: 0,
          stablecoinRefunded: 0,
          discarded: 0,
          removed: 3,
          failed: 0,
        },
        pegin: { pending: 1, cleared: 0, failed: 0 },
        sideshift: { checked: 1, refreshed: 1, failed: 0 },
        plans: { checked: 1, advanced: 0, completed: 0, needsReview: 1, discarded: 0, failed: 0 },
      },
    });
    const out = sc(await client.callTool({ name: "wallet_status", arguments: {} }));
    expect(out.pending_withdrawals).toMatchObject({ resumed: 2 });
    expect(out.pending_conversions).toEqual({
      boltz: {
        submarine_resumed: 1,
        submarine_refunded: 1,
        reverse_resumed: 0,
        stablecoin_resumed: 0,
        stablecoin_refunded: 0,
        discarded: 0,
        removed: 3,
        failed: 0,
      },
      pegin: { pending: 1, cleared: 0, failed: 0 },
      sideshift: { checked: 1, refreshed: 1, failed: 0 },
      plans: { checked: 1, advanced: 0, completed: 0, needs_review: 1, discarded: 0, failed: 0 },
    });
  });

  it("defaults pending_conversions to an empty summary (boltz null) when no boot summary was given", async () => {
    const wallet = new FakeWallet();
    const { client } = await connectWallet({ wallet });
    const out = sc(await client.callTool({ name: "wallet_status", arguments: {} }));
    expect(out.pending_conversions).toEqual({
      boltz: null,
      pegin: { pending: 0, cleared: 0, failed: 0 },
      sideshift: { checked: 0, refreshed: 0, failed: 0 },
      plans: { checked: 0, advanced: 0, completed: 0, needs_review: 0, discarded: 0, failed: 0 },
    });
  });
});

describe("catalog annotations for the recovery tools", () => {
  it("wallet_pending is read-only; wallet_recover is not (it re-drives broadcasts)", async () => {
    const { client } = await connectWallet({ wallet: new FakeWallet() });
    const { tools } = await client.listTools();
    const pending = tools.find((t) => t.name === "wallet_pending");
    const recover = tools.find((t) => t.name === "wallet_recover");
    expect(pending?.annotations?.readOnlyHint).toBe(true);
    expect(recover?.annotations?.readOnlyHint).toBe(false);
    // The description must tell the agent it never STARTS a new payment.
    expect(recover?.description?.toLowerCase()).toContain("never starts a new payment");
  });
});
