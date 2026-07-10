// wallet.convert.sideshift.* orchestration (spec §5.4, CUSTODIAL/G4):
//   - quote/send/receive/getStatus/setRefundAddress
//   - the SEND guardrail counts the USDt value + gates the settleAddress (per
//     network class) AND the refundAddress (→ sideshiftRefundAddresses)
//   - custodial:true on every result; AFFILIATE_ID_MISSING when unbaked
//   - a real Guardrails proves the send is COUNTED and the allowlist fail-closes.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Wollet } from "lwk_node";
import { isDepixSdkError, GuardrailError } from "../src/errors.js";
import type { FetchLike, FetchResponseLike } from "../src/api/client.js";
import type { ConvertWalletHooks } from "../src/convert/hooks.js";
import type { GuardrailIntent } from "../src/guardrails/guardrails.js";
import { Guardrails } from "../src/guardrails/guardrails.js";
import { resolveGuardrailConfig, type GuardrailAllowlist } from "../src/guardrails/config.js";
import { SideShiftNamespace, type SendUsdt } from "../src/convert/sideshift.js";
import { SideShiftStore } from "../src/convert/sideshift-store.js";
import { InMemoryAnchor, keyProvider } from "./guardrail-utils.js";

const SILENT = { debug() {}, info() {}, warn() {}, error() {} };
const EVM_ADDR = "0x" + "a".repeat(40);
const SOLANA_ADDR = "1".repeat(40); // matches the SPL base58 regex
const REFUND_ADDR = "lq1qrefundaddress";

// ── fake SideShift REST, routed by path ──
interface FetchOverrides {
  quote?: Record<string, unknown>;
  fixed?: Record<string, unknown>;
  variable?: Record<string, unknown>;
  shift?: Record<string, unknown>;
  status?: number;
}
function fakeSideshiftFetch(over: FetchOverrides = {}): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(`${init.method} ${url.replace("https://sideshift.ai/api/v2", "")}`);
    let body: Record<string, unknown> = {};
    if (url.endsWith("/quotes")) body = over.quote ?? { id: "q1", rate: "0.99", settleAmount: "9.9" };
    else if (url.endsWith("/shifts/fixed"))
      body = over.fixed ?? {
        id: "sh1",
        depositAddress: "lq1qdeposit",
        depositAmount: "10",
        settleAmount: "9.9",
        status: "waiting",
        expiresAt: "2026-07-10T13:00:00.000Z"
      };
    else if (url.endsWith("/shifts/variable"))
      body = over.variable ?? { id: "sh2", depositAddress: "Tdeposit", status: "waiting", depositMin: "1", depositMax: "1000" };
    else if (url.includes("/set-refund-address")) body = { ok: true };
    else if (url.includes("/shifts/")) body = over.shift ?? { id: "sh1", status: "settled", settleAmount: "9.9", depositAmount: "10" };
    const res: FetchResponseLike = {
      ok: (over.status ?? 200) >= 200 && (over.status ?? 200) < 300,
      status: over.status ?? 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body)
    };
    return res;
  };
  return { fetchImpl, calls };
}

interface Spies {
  valuate: Array<[string, bigint]>;
  enforce: GuardrailIntent[];
  record: Array<[number, string]>;
  sendUsdt: Array<{ depositAddress: string; amountSats: bigint; brlCents: number }>;
}
function makeHooks(dataDir: string, over: Partial<ConvertWalletHooks> = {}): { hooks: ConvertWalletHooks; spies: Spies } {
  const spies: Spies = { valuate: [], enforce: [], record: [], sendUsdt: [] };
  const hooks: ConvertWalletHooks = {
    dataDir,
    logger: SILENT,
    ensureWollet: async () => ({}) as unknown as Wollet,
    getReceiveAddress: async () => "lq1qmyreceive",
    decryptMnemonic: async () => {
      throw new Error("decryptMnemonic should not run — sendUsdt is injected");
    },
    valuate: async (asset, sats) => {
      spies.valuate.push([asset, sats]);
      return 5_000;
    },
    enforceGuardrails: async (intent) => {
      spies.enforce.push(intent);
    },
    recordSpend: async (cents, kind) => {
      spies.record.push([cents, kind]);
    },
    runExclusive: (fn) => fn(),
    broadcast: async () => "unused",
    assertOpen: () => {},
    now: () => 1_000,
    ...over
  };
  return { hooks, spies };
}

function fakeSendUsdt(spies: Spies, txid = "sh".repeat(32)): SendUsdt {
  return async (p) => {
    spies.sendUsdt.push(p);
    return { txid };
  };
}

let dataDir: string;
let store: SideShiftStore;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-sideshift-ns-"));
  store = new SideShiftStore({ dataDir, logger: SILENT });
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("quote — read-only preview, CUSTODIAL-signalled", () => {
  it("returns a quote carrying custodial:true", async () => {
    const { hooks } = makeHooks(dataDir);
    const { fetchImpl } = fakeSideshiftFetch();
    const ns = new SideShiftNamespace({ hooks, store, fetchImpl, affiliateId: "test-affiliate" });
    const q = await ns.quote({ network: "tron", amountSats: 1_000_000_000n });
    expect(q.quoteId).toBe("q1");
    expect(q.settleNetwork).toBe("tron");
    expect(q.depositAmountSats).toBe(1_000_000_000n);
    expect(q.custodial).toBe(true);
  });
  it("throws AFFILIATE_ID_MISSING when the affiliate id was not baked in", async () => {
    const { hooks } = makeHooks(dataDir);
    const { fetchImpl, calls } = fakeSideshiftFetch();
    const ns = new SideShiftNamespace({ hooks, store, fetchImpl, affiliateId: "" });
    await expect(ns.quote({ network: "tron", amountSats: 1n })).rejects.toSatisfy((e) =>
      isDepixSdkError(e, "AFFILIATE_ID_MISSING")
    );
    expect(calls).toHaveLength(0); // failed before any network call
  });
});

describe("send — guardrail counts the USDt + gates settle/refund; custodial (§4.3/§5.4)", () => {
  it("values the USDt sent, enforces settle(evm)+refund destinations, signs, persists, custodial:true", async () => {
    const { hooks, spies } = makeHooks(dataDir);
    const { fetchImpl, calls } = fakeSideshiftFetch();
    const ns = new SideShiftNamespace({
      hooks,
      store,
      fetchImpl,
      affiliateId: "test-affiliate",
      sendUsdt: fakeSendUsdt(spies)
    });
    const r = await ns.send({
      network: "ethereum",
      amountSats: 1_000_000_000n,
      settleAddress: EVM_ADDR,
      refundAddress: REFUND_ADDR
    });
    // Valued the USDt SENT in BRL.
    expect(spies.valuate).toEqual([["USDT", 1_000_000_000n]]);
    // Guardrail: kind + BOTH destinations (settle → evmAddress, refund → sideshiftRefundAddress).
    expect(spies.enforce).toHaveLength(1);
    expect(spies.enforce[0]!.kind).toBe("sideshift-send");
    expect(spies.enforce[0]!.brlCents).toBe(5_000);
    expect(spies.enforce[0]!.destinations).toEqual([
      { kind: "evmAddress", address: EVM_ADDR },
      { kind: "sideshiftRefundAddress", address: REFUND_ADDR }
    ]);
    // Signed the send to SideShift's deposit address for the shift's deposit amount.
    expect(spies.sendUsdt).toEqual([{ depositAddress: "lq1qdeposit", amountSats: 1_000_000_000n, brlCents: 5_000 }]);
    // Enforce ran BEFORE the shift was created.
    expect(calls).toEqual([`POST /quotes`, `POST /shifts/fixed`]);
    // Result is custodial + carries the txid + brlCents.
    expect(r.custodial).toBe(true);
    expect(r.txid).toBe("sh".repeat(32));
    expect(r.depositAddress).toBe("lq1qdeposit");
    expect(r.brlCents).toBe(5_000);
    // Persisted the shift with the Liquid txid.
    const stored = await store.get("sh1");
    expect(stored?.type).toBe("send");
    expect(stored?.liquidTxid).toBe("sh".repeat(32));
  });

  it("passes only the settle destination when no refundAddress is given", async () => {
    const { hooks, spies } = makeHooks(dataDir);
    const { fetchImpl } = fakeSideshiftFetch();
    const ns = new SideShiftNamespace({ hooks, store, fetchImpl, affiliateId: "test-affiliate", sendUsdt: fakeSendUsdt(spies) });
    await ns.send({ network: "tron", amountSats: 1_000_000_000n, settleAddress: "T" + "1".repeat(33) });
    expect(spies.enforce[0]!.destinations).toEqual([{ kind: "tronAddress", address: "T" + "1".repeat(33) }]);
  });

  it("a solana settle is an UNREPRESENTABLE allowlist class (fail-closed when ON)", async () => {
    const { hooks, spies } = makeHooks(dataDir);
    const { fetchImpl } = fakeSideshiftFetch();
    const ns = new SideShiftNamespace({ hooks, store, fetchImpl, affiliateId: "test-affiliate", sendUsdt: fakeSendUsdt(spies) });
    await ns.send({ network: "solana", amountSats: 1_000_000_000n, settleAddress: SOLANA_ADDR });
    expect(spies.enforce[0]!.destinations).toEqual([{ kind: "unrepresentable", class: "solanaAddress" }]);
  });

  it("a guardrail/allowlist rejection stops BEFORE any shift is created or signed", async () => {
    const { hooks, spies } = makeHooks(dataDir, {
      enforceGuardrails: async () => {
        throw new GuardrailError("GUARDRAIL_ALLOWLIST_BLOCKED", "evm not listed", { details: { class: "evmAddress" } });
      }
    });
    const { fetchImpl, calls } = fakeSideshiftFetch();
    const ns = new SideShiftNamespace({ hooks, store, fetchImpl, affiliateId: "test-affiliate", sendUsdt: fakeSendUsdt(spies) });
    await expect(
      ns.send({ network: "ethereum", amountSats: 1_000_000_000n, settleAddress: EVM_ADDR })
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "GUARDRAIL_ALLOWLIST_BLOCKED"));
    // Only the quote may have run — NO fixed shift, NO signing.
    expect(calls).not.toContain("POST /shifts/fixed");
    expect(spies.sendUsdt).toHaveLength(0);
  });

  it("AFFILIATE_ID_MISSING before valuation / any network call", async () => {
    const { hooks, spies } = makeHooks(dataDir);
    const { fetchImpl, calls } = fakeSideshiftFetch();
    const ns = new SideShiftNamespace({ hooks, store, fetchImpl, affiliateId: "", sendUsdt: fakeSendUsdt(spies) });
    await expect(
      ns.send({ network: "ethereum", amountSats: 1_000_000_000n, settleAddress: EVM_ADDR })
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "AFFILIATE_ID_MISSING"));
    expect(calls).toHaveLength(0);
    expect(spies.valuate).toHaveLength(0);
  });

  it("aborts (SIDESHIFT_AMOUNT_MISMATCH) if SideShift asks to deposit MORE than quoted — nothing signed", async () => {
    const { hooks, spies } = makeHooks(dataDir);
    const { fetchImpl } = fakeSideshiftFetch({
      fixed: { id: "sh1", depositAddress: "lq1qdeposit", depositAmount: "11", status: "waiting" } // > quoted 10
    });
    const ns = new SideShiftNamespace({ hooks, store, fetchImpl, affiliateId: "test-affiliate", sendUsdt: fakeSendUsdt(spies) });
    await expect(
      ns.send({ network: "ethereum", amountSats: 1_000_000_000n, settleAddress: EVM_ADDR })
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "SIDESHIFT_AMOUNT_MISMATCH"));
    expect(spies.sendUsdt).toHaveLength(0);
  });

  it("rejects a bad settle address / non-positive amount / non-shiftable network BEFORE anything", async () => {
    const { hooks } = makeHooks(dataDir);
    const { fetchImpl, calls } = fakeSideshiftFetch();
    const ns = new SideShiftNamespace({ hooks, store, fetchImpl, affiliateId: "test-affiliate" });
    await expect(ns.send({ network: "ethereum", amountSats: 1n, settleAddress: "not-hex" })).rejects.toSatisfy((e) =>
      isDepixSdkError(e, "INVALID_ADDRESS")
    );
    await expect(ns.send({ network: "ethereum", amountSats: 0n, settleAddress: EVM_ADDR })).rejects.toSatisfy((e) =>
      isDepixSdkError(e, "INVALID_AMOUNT")
    );
    await expect(ns.send({ network: "liquid", amountSats: 1n, settleAddress: "lq1q" })).rejects.toSatisfy((e) =>
      isDepixSdkError(e, "UNSUPPORTED_ASSET")
    );
    expect(calls).toHaveLength(0);
  });
});

describe("receive — INFLOW: no guardrail, our own settle address, custodial", () => {
  it("creates a variable shift to OUR receive address without enforcing any guardrail", async () => {
    const { hooks, spies } = makeHooks(dataDir);
    const { fetchImpl, calls } = fakeSideshiftFetch();
    const ns = new SideShiftNamespace({ hooks, store, fetchImpl, affiliateId: "test-affiliate" });
    const r = await ns.receive({ network: "tron" });
    expect(spies.enforce).toHaveLength(0); // inflow — no guardrail
    expect(spies.valuate).toHaveLength(0);
    expect(r.settleAddress).toBe("lq1qmyreceive"); // funds land in our wallet
    expect(r.depositAddress).toBe("Tdeposit");
    expect(r.custodial).toBe(true);
    expect(calls).toEqual([`POST /shifts/variable`]);
    expect((await store.get("sh2"))?.type).toBe("receive");
  });
});

describe("getStatus + setRefundAddress", () => {
  it("getStatus folds the status into the local log + classifies it", async () => {
    const { hooks } = makeHooks(dataDir);
    await store.save({
      id: "sh1",
      type: "send",
      asset: "USDT",
      network: "tron",
      depositAddress: "lq1qdeposit",
      settleAddress: "Trecipient",
      refundAddress: null,
      status: "waiting",
      createdAt: 1,
      updatedAt: 1
    });
    const { fetchImpl } = fakeSideshiftFetch();
    const ns = new SideShiftNamespace({ hooks, store, fetchImpl, affiliateId: "test-affiliate" });
    const st = await ns.getStatus("sh1");
    expect(st.status).toBe("settled");
    expect(st.terminal).toBe(true);
    expect(st.custodial).toBe(true);
    expect((await store.get("sh1"))?.status).toBe("settled");
  });

  it("setRefundAddress passes through + updates the log (no signing, no guardrail)", async () => {
    const { hooks, spies } = makeHooks(dataDir);
    const { fetchImpl, calls } = fakeSideshiftFetch();
    const ns = new SideShiftNamespace({ hooks, store, fetchImpl, affiliateId: "test-affiliate" });
    const out = await ns.setRefundAddress("sh1", "lq1qnewrefund");
    expect(out.refundAddress).toBe("lq1qnewrefund");
    expect(calls).toEqual([`POST /shifts/sh1/set-refund-address`]);
    expect(spies.enforce).toHaveLength(0);
  });
});

describe("integration — a REAL Guardrails: the send is COUNTED + the allowlist fail-closes", () => {
  async function realGuardrailNs(opts: { allowlist?: GuardrailAllowlist; dailyCap?: number; valuateCents?: number } = {}) {
    const { hooks } = makeHooks(dataDir);
    const valuateCents = opts.valuateCents ?? 7_000;
    const guardrails = new Guardrails({
      dataDir,
      config: resolveGuardrailConfig({
        dailyLimitBrlCents: opts.dailyCap ?? 12_000,
        perTxLimitBrlCents: 10_000,
        ...(opts.allowlist ? { allowlist: opts.allowlist } : {})
      }),
      stateKey: keyProvider(),
      anchor: new InMemoryAnchor(),
      logger: SILENT
    });
    // Wire the real guardrails into the hooks; the injected sendUsdt records the
    // spend at signing time exactly as the real seam does (record BEFORE broadcast).
    const wired: ConvertWalletHooks = {
      ...hooks,
      valuate: async () => valuateCents,
      enforceGuardrails: (i) => guardrails.enforce(i),
      recordSpend: (c, k) => guardrails.recordSpend(c, k)
    };
    const sendUsdt: SendUsdt = async ({ brlCents }) => {
      await wired.recordSpend(brlCents, "sideshift-send");
      return { txid: "tx" };
    };
    const ns = new SideShiftNamespace({ hooks: wired, store, fetchImpl: fakeSideshiftFetch().fetchImpl, affiliateId: "test-affiliate", sendUsdt });
    return { ns, guardrails };
  }

  it("counts the sent value against the rolling window; a second send over the cap is blocked", async () => {
    // 12_000 cap, each send R$70 → the 2nd (14_000 total) exceeds it.
    const { ns, guardrails } = await realGuardrailNs({ dailyCap: 12_000, valuateCents: 7_000 });
    await ns.send({ network: "ethereum", amountSats: 1_000_000_000n, settleAddress: EVM_ADDR });
    expect((await guardrails.usage()).usedCents).toBe(7_000);
    await expect(
      ns.send({ network: "ethereum", amountSats: 1_000_000_000n, settleAddress: EVM_ADDR })
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "GUARDRAIL_DAILY_LIMIT"));
  });

  it("with the allowlist ON: an opted-in settle+refund pass; a stray evm / a solana settle fail-closed", async () => {
    // A high daily cap so the ALLOWLIST — not a value ceiling — is the blocker.
    const { ns } = await realGuardrailNs({
      dailyCap: 1_000_000,
      valuateCents: 7_000,
      allowlist: { enabled: true, evmAddresses: [EVM_ADDR], sideshiftRefundAddresses: [REFUND_ADDR] }
    });
    // opted-in → passes
    await expect(
      ns.send({ network: "ethereum", amountSats: 1_000_000_000n, settleAddress: EVM_ADDR, refundAddress: REFUND_ADDR })
    ).resolves.toMatchObject({ custodial: true });
    // a DIFFERENT evm settle → blocked
    await expect(
      ns.send({ network: "ethereum", amountSats: 1_000_000_000n, settleAddress: "0x" + "b".repeat(40) })
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "GUARDRAIL_ALLOWLIST_BLOCKED"));
    // solana → unrepresentable → fail-closed
    await expect(
      ns.send({ network: "solana", amountSats: 1_000_000_000n, settleAddress: SOLANA_ADDR })
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "GUARDRAIL_ALLOWLIST_BLOCKED"));
    // an opted-in settle but a NON-listed refund → blocked (refund is gated too)
    await expect(
      ns.send({ network: "ethereum", amountSats: 1_000_000_000n, settleAddress: EVM_ADDR, refundAddress: "lq1qstray" })
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "GUARDRAIL_ALLOWLIST_BLOCKED"));
  });
});
