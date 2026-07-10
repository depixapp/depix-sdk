// SideShift REST layer + pure helpers (spec §5.4). Fixtures mirror the real API
// (POST /quotes, /shifts/fixed, /shifts/variable, GET /shifts/{id},
// /shifts/{id}/set-refund-address); errors surface as SideShiftApiError.
import { describe, expect, it } from "vitest";
import type { FetchLike, FetchResponseLike } from "../src/api/client.js";
import { isDepixSdkError } from "../src/errors.js";
import {
  SIDESHIFT_API_BASE,
  SHIFT_STATUS,
  coinIdForNetwork,
  createFixedShift,
  createVariableShift,
  fetchShift,
  getNetwork,
  isShiftInRefund,
  isShiftPending,
  isShiftTerminal,
  requestQuote,
  setRefundAddressRequest,
  settleDestinationForNetwork,
  usdtDecimalToSats,
  usdtSatsToDecimal,
  validateNetworkAddress
} from "../src/convert/sideshift.js";

interface Captured {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string };
}

function fakeFetch(
  respond: (c: Captured) => { status?: number; body?: unknown }
): { fetchImpl: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const captured: Captured = { url, init: init as Captured["init"] };
    calls.push(captured);
    const { status = 200, body = {} } = respond(captured);
    const res: FetchResponseLike = {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body)
    };
    return res;
  };
  return { fetchImpl, calls };
}

describe("coinIdForNetwork + network table", () => {
  it("polygon → usdt0 (LayerZero OFT), everything else → usdt", () => {
    expect(coinIdForNetwork("polygon")).toBe("usdt0");
    expect(coinIdForNetwork("liquid")).toBe("usdt");
    expect(coinIdForNetwork("tron")).toBe("usdt");
    expect(coinIdForNetwork("ethereum")).toBe("usdt");
  });
  it("liquid is the no-shift fast path; the other five require a shift", () => {
    expect(getNetwork("liquid")?.requiresShift).toBe(false);
    for (const id of ["ethereum", "tron", "bsc", "polygon", "solana"]) {
      expect(getNetwork(id)?.requiresShift, id).toBe(true);
    }
    expect(getNetwork("dogecoin")).toBeNull();
  });
});

describe("validateNetworkAddress", () => {
  it("accepts well-formed addresses per network, rejects mismatches + liquid", () => {
    expect(validateNetworkAddress("ethereum", "0x" + "a".repeat(40))).toBe(true);
    expect(validateNetworkAddress("bsc", "0x" + "F".repeat(40))).toBe(true);
    expect(validateNetworkAddress("polygon", "0x" + "0".repeat(40))).toBe(true);
    expect(validateNetworkAddress("tron", "T" + "1".repeat(33))).toBe(true);
    expect(validateNetworkAddress("solana", "1".repeat(40))).toBe(true);
    // wrong format / empty / the no-shift liquid path all fail
    expect(validateNetworkAddress("ethereum", "not-an-address")).toBe(false);
    expect(validateNetworkAddress("tron", "0x" + "a".repeat(40))).toBe(false);
    expect(validateNetworkAddress("liquid", "lq1qanything")).toBe(false);
    expect(validateNetworkAddress("ethereum", "")).toBe(false);
  });
});

describe("settleDestinationForNetwork — allowlist class mapping (§4.3)", () => {
  it("EVM networks → evmAddress; tron → tronAddress; solana → unrepresentable", () => {
    expect(settleDestinationForNetwork("ethereum", "0xabc")).toEqual({ kind: "evmAddress", address: "0xabc" });
    expect(settleDestinationForNetwork("bsc", "0xabc")).toEqual({ kind: "evmAddress", address: "0xabc" });
    expect(settleDestinationForNetwork("polygon", "0xabc")).toEqual({ kind: "evmAddress", address: "0xabc" });
    expect(settleDestinationForNetwork("tron", "Tabc")).toEqual({ kind: "tronAddress", address: "Tabc" });
    // Solana has NO representable allowlist class → fail-closed when the allowlist is ON.
    expect(settleDestinationForNetwork("solana", "SoLaNa")).toEqual({
      kind: "unrepresentable",
      class: "solanaAddress"
    });
    expect(settleDestinationForNetwork("dogecoin", "D...")).toEqual({ kind: "unrepresentable", class: "dogecoin" });
  });
});

describe("USDt amount ↔ SideShift decimal", () => {
  it("round-trips base units ↔ decimal (8 decimals on Liquid)", () => {
    expect(usdtSatsToDecimal(1_000_000_000n)).toBe("10");
    expect(usdtSatsToDecimal(1_050_000_000n)).toBe("10.5");
    expect(usdtSatsToDecimal(1n)).toBe("0.00000001");
    expect(usdtSatsToDecimal(0n)).toBe("0");
    expect(usdtDecimalToSats("10")).toBe(1_000_000_000n);
    expect(usdtDecimalToSats("10.5")).toBe(1_050_000_000n);
    expect(usdtDecimalToSats("10.50000000")).toBe(1_050_000_000n); // trailing zeros normalize
    expect(usdtDecimalToSats("0.00000001")).toBe(1n);
  });
  it("rejects malformed / unrepresentable (>8 non-zero decimals) → null", () => {
    expect(usdtDecimalToSats("abc")).toBeNull();
    expect(usdtDecimalToSats("")).toBeNull();
    expect(usdtDecimalToSats("1.2.3")).toBeNull();
    expect(usdtDecimalToSats("10.123456789")).toBeNull(); // 9th decimal is non-zero
    expect(usdtDecimalToSats("10.100000000")).toBe(1_010_000_000n); // trailing zero beyond 8 is fine
  });
});

describe("SHIFT_STATUS taxonomy", () => {
  it("classifies pending / terminal / refund", () => {
    for (const s of ["waiting", "pending", "processing", "review", "settling"]) {
      expect(isShiftPending(s), s).toBe(true);
      expect(isShiftTerminal(s), s).toBe(false);
    }
    for (const s of ["settled", "refunded", "expired"]) expect(isShiftTerminal(s), s).toBe(true);
    for (const s of ["refund", "refunding", "refunded"]) expect(isShiftInRefund(s), s).toBe(true);
    expect(isShiftInRefund(SHIFT_STATUS.SETTLED)).toBe(false);
  });
});

describe("REST layer — request shapes + affiliate id", () => {
  it("requestQuote posts to /quotes with derived coin ids + affiliate", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ body: { id: "q1", rate: "0.99", settleAmount: "9.9" } }));
    const q = await requestQuote(
      { depositNetwork: "liquid", settleNetwork: "polygon", depositAmount: "10", affiliateId: "aff-1" },
      fetchImpl
    );
    expect(q.id).toBe("q1");
    expect(calls[0]!.url).toBe(`${SIDESHIFT_API_BASE}/quotes`);
    expect(calls[0]!.init.method).toBe("POST");
    const body = JSON.parse(calls[0]!.init.body!);
    expect(body).toMatchObject({
      depositCoin: "usdt",
      settleCoin: "usdt0", // polygon → usdt0
      depositNetwork: "liquid",
      settleNetwork: "polygon",
      depositAmount: "10",
      affiliateId: "aff-1"
    });
  });

  it("createFixedShift posts quoteId + settleAddress (+ refundAddress when present)", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      body: { id: "sh1", depositAddress: "lq1qdep", depositAmount: "10", settleAmount: "9.9", status: "waiting" }
    }));
    await createFixedShift(
      { quoteId: "q1", settleAddress: "0xdead", refundAddress: "lq1qrefund", affiliateId: "aff-1" },
      fetchImpl
    );
    expect(calls[0]!.url).toBe(`${SIDESHIFT_API_BASE}/shifts/fixed`);
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({
      quoteId: "q1",
      settleAddress: "0xdead",
      refundAddress: "lq1qrefund",
      affiliateId: "aff-1"
    });
    // refundAddress omitted when absent
    await createFixedShift({ quoteId: "q2", settleAddress: "0xbeef", affiliateId: "aff-1" }, fetchImpl);
    expect(JSON.parse(calls[1]!.init.body!)).not.toHaveProperty("refundAddress");
  });

  it("createVariableShift hardcodes settleNetwork=liquid + settleCoin=usdt", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      body: { id: "sh2", depositAddress: "Tdeposit", status: "waiting", depositMin: "1", depositMax: "1000" }
    }));
    await createVariableShift({ depositNetwork: "tron", settleAddress: "lq1qmine", affiliateId: "aff-1" }, fetchImpl);
    expect(calls[0]!.url).toBe(`${SIDESHIFT_API_BASE}/shifts/variable`);
    expect(JSON.parse(calls[0]!.init.body!)).toMatchObject({
      depositCoin: "usdt",
      settleCoin: "usdt",
      depositNetwork: "tron",
      settleNetwork: "liquid",
      settleAddress: "lq1qmine",
      affiliateId: "aff-1"
    });
  });

  it("fetchShift GETs /shifts/{id}; setRefundAddressRequest POSTs the address", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ body: { id: "sh1", status: "settled", settleAmount: "9.9" } }));
    await fetchShift("sh1", fetchImpl);
    expect(calls[0]!.url).toBe(`${SIDESHIFT_API_BASE}/shifts/sh1`);
    expect(calls[0]!.init.method).toBe("GET");
    await setRefundAddressRequest("sh1", "lq1qnewrefund", fetchImpl);
    expect(calls[1]!.url).toBe(`${SIDESHIFT_API_BASE}/shifts/sh1/set-refund-address`);
    expect(JSON.parse(calls[1]!.init.body!)).toEqual({ address: "lq1qnewrefund" });
  });

  it("a non-2xx surfaces a SideShiftApiError carrying the upstream message (untrusted DATA)", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 400, body: { error: { message: "Below the minimum amount" } } }));
    await expect(
      requestQuote({ depositNetwork: "liquid", settleNetwork: "tron", depositAmount: "0.01", affiliateId: "aff-1" }, fetchImpl)
    ).rejects.toSatisfy(
      (e) => isDepixSdkError(e, "SIDESHIFT_API_ERROR") && String((e as Error).message).includes("Below the minimum")
    );
  });
});
