// SideSwap peg orchestration (spec §5.2) with a fake client + fake hooks:
// peg-out guardrails the L-BTC value in BRL AND the FINAL recv_addr BTC
// destination (allowlist.btcAddresses) before contacting SideSwap; peg-in is one
// in flight at a time (PEG_IN_ALREADY_PENDING).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Wollet } from "lwk_node";
import { GuardrailError, isDepixSdkError } from "../src/errors.js";
import type { ConvertWalletHooks } from "../src/convert/hooks.js";
import type { GuardrailIntent } from "../src/guardrails/guardrails.js";
import { PendingPegIn } from "../src/convert/pending-pegin.js";
import { SideSwapPeg } from "../src/convert/sideswap-peg.js";
import { FakeSideSwapClient } from "./support/sideswap-mock.js";

interface Spies {
  valuate: Array<[string, bigint]>;
  enforce: GuardrailIntent[];
}

function makeHooks(dataDir: string, over: Partial<ConvertWalletHooks> = {}): { hooks: ConvertWalletHooks; spies: Spies } {
  const spies: Spies = { valuate: [], enforce: [] };
  const hooks: ConvertWalletHooks = {
    dataDir,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ensureWollet: async () => ({}) as unknown as Wollet,
    getReceiveAddress: async () => "lq1qmyreceive",
    decryptMnemonic: async () => {
      throw new Error("decryptMnemonic should not run in these tests");
    },
    valuate: async (asset, sats) => {
      spies.valuate.push([asset, sats]);
      return 3_000;
    },
    enforceGuardrails: async (intent) => {
      spies.enforce.push(intent);
    },
    recordSpend: async () => {},
    runExclusive: (fn) => fn(),
    broadcast: async () => "unused",
    assertOpen: () => {},
    now: () => 0,
    ...over
  };
  return { hooks, spies };
}

let dataDir: string;
let pending: PendingPegIn;
let client: FakeSideSwapClient;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-peg-"));
  pending = new PendingPegIn(dataDir);
  client = new FakeSideSwapClient();
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("pegOut — guardrail on L-BTC value + the FINAL BTC recv_addr (§4.3/§5.2)", () => {
  it("counts LBTC in BRL and checks recv_addr against allowlist.btcAddresses BEFORE contacting SideSwap", async () => {
    // Default valuate() records to spies; enforce simulates the allowlist block.
    const { hooks, spies } = makeHooks(dataDir, {
      enforceGuardrails: async () => {
        throw new GuardrailError("GUARDRAIL_ALLOWLIST_BLOCKED", "btc not listed", {
          details: { class: "btcAddress" }
        });
      }
    });
    const peg = new SideSwapPeg({ hooks, pending, clientFactory: () => client });

    await expect(peg.pegOut({ recvAddr: "bc1qdestination", amountSats: 60_000n })).rejects.toSatisfy((e) =>
      isDepixSdkError(e, "GUARDRAIL_ALLOWLIST_BLOCKED")
    );
    // Valued the L-BTC being sent; the guardrail saw the FINAL BTC destination.
    expect(spies.valuate).toEqual([["LBTC", 60_000n]]);
    // Blocked BEFORE any SideSwap RPC.
    expect(client.pegOutCalls).toHaveLength(0);
  });

  it("passes the guardrail (kind + btcAddress destination) then reaches the L-BTC build", async () => {
    const { hooks, spies } = makeHooks(dataDir, {
      ensureWollet: async () => {
        throw new Error("BUILD_REACHED");
      }
    });
    const peg = new SideSwapPeg({ hooks, pending, clientFactory: () => client });

    await expect(peg.pegOut({ recvAddr: "bc1qdestination", amountSats: 60_000n })).rejects.toThrow("BUILD_REACHED");
    expect(spies.enforce).toHaveLength(1);
    const intent = spies.enforce[0]!;
    expect(intent.kind).toBe("sideswap-pegout");
    expect(intent.destinations).toEqual([{ kind: "btcAddress", address: "bc1qdestination" }]);
    // Guardrail passed → the peg RPC ran with the BTC destination, then build.
    expect(client.pegOutCalls).toEqual([{ recvAddr: "bc1qdestination", blocks: undefined }]);
    expect(client.disconnectCount).toBeGreaterThan(0);
  });

  it("rejects an empty recv_addr / non-positive amount before anything", async () => {
    const { hooks } = makeHooks(dataDir);
    const peg = new SideSwapPeg({ hooks, pending, clientFactory: () => client });
    await expect(peg.pegOut({ recvAddr: "", amountSats: 1n })).rejects.toSatisfy((e) =>
      isDepixSdkError(e, "INVALID_ADDRESS")
    );
    await expect(peg.pegOut({ recvAddr: "bc1q", amountSats: 0n })).rejects.toSatisfy((e) =>
      isDepixSdkError(e, "INVALID_AMOUNT")
    );
  });
});

describe("pegIn — one in flight at a time (§5.2)", () => {
  it("PEG_IN_ALREADY_PENDING when a peg-in is already tracked", async () => {
    await pending.put({ orderId: "existing", pegAddr: "bc1qalready", recvAddr: "lq1qmine" });
    const { hooks } = makeHooks(dataDir);
    const peg = new SideSwapPeg({ hooks, pending, clientFactory: () => client });
    await expect(peg.pegIn()).rejects.toSatisfy((e) => isDepixSdkError(e, "PEG_IN_ALREADY_PENDING"));
    // Did not even reach the RPC.
    expect(client.pegInCalls).toHaveLength(0);
  });

  it("issues the peg-in, returns the BTC funding address, and persists it", async () => {
    const { hooks } = makeHooks(dataDir);
    const peg = new SideSwapPeg({ hooks, pending, clientFactory: () => client });
    const res = await peg.pegIn();
    expect(res).toMatchObject({ orderId: "peg_order_in", pegAddr: "bc1qpegin", recvAddr: "lq1qmyreceive" });
    const stored = await pending.load();
    expect(stored).toMatchObject({ orderId: "peg_order_in", pegAddr: "bc1qpegin", recvAddr: "lq1qmyreceive" });
    expect(client.disconnectCount).toBeGreaterThan(0);
  });

  it("serializes concurrent pegIn() through the op mutex — the second gets PEG_IN_ALREADY_PENDING (§5.2 TOCTOU)", async () => {
    // A real serializing runExclusive (the op mutex): the check→write critical
    // section now runs inside it, so two concurrent calls cannot both observe
    // existing===null. Without the fix both would open a SideSwap order and the
    // second put() would clobber the first.
    let tail: Promise<unknown> = Promise.resolve();
    const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = tail.then(fn);
      tail = run.catch(() => {});
      return run;
    };
    const { hooks } = makeHooks(dataDir, { runExclusive: serialize });
    const peg = new SideSwapPeg({ hooks, pending, clientFactory: () => client });

    const [a, b] = await Promise.allSettled([peg.pegIn(), peg.pegIn()]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = (a.status === "rejected" ? a : b) as PromiseRejectedResult;
    expect(isDepixSdkError(rejected.reason, "PEG_IN_ALREADY_PENDING")).toBe(true);
    // Only ONE SideSwap order was opened — no clobbered tracking record.
    expect(client.pegInCalls).toHaveLength(1);
    expect(await pending.load()).toMatchObject({ orderId: "peg_order_in" });
  });
});
