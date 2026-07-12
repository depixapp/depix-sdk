// The intent layer (PR-B): wallet.quote() enumerates + estimates candidate
// routes; wallet.convert() executes exactly ONE single-hop route, hiding the
// provider mechanics (quote stream lifecycle, completion promises, status
// polling) behind a single call that waits for settlement by default.
// Providers are mocked — the layer under test is quoteRoutes/convertIntent.
import { describe, expect, it, vi } from "vitest";
import { ASSETS } from "../src/assets.js";
import { isDepixSdkError } from "../src/errors.js";
import { convertIntent, quoteRoutes, makeConvertFacade, type IntentDeps } from "../src/convert/intent.js";
import type { SideSwapQuote, SwapExecuteResult } from "../src/convert/sideswap.js";

const ROUTE_DEPIX_BOLTZ =
  "sideswap.swap:DEPIX@liquid>LBTC@liquid+boltz.toStablecoin:LBTC@liquid>USDT@ethereum";
const ROUTE_DEPIX_SIDESHIFT =
  "sideswap.swap:DEPIX@liquid>USDT@liquid+sideshift.send:USDT@liquid>USDT@ethereum";

// ── fakes ─────────────────────────────────────────────────────────────────────

interface FakeStreamBehaviour {
  recvAmountSats?: bigint;
  serverFeeSats?: bigint;
  fixedFeeSats?: bigint;
  feeAsset?: string | null;
  quoteError?: Error;
}

function makeFakeSideswap(behaviourByTo: Record<string, FakeStreamBehaviour> = {}) {
  const closed: string[] = [];
  const executed: SideSwapQuote[] = [];
  const quoteCalls: Array<{ from: string; to: string; amountSats: bigint }> = [];
  const pegOutCalls: Array<{ recvAddr: string; amountSats: bigint }> = [];
  const pegStatusCalls: Array<{ orderId: string; pegIn: boolean }> = [];
  let pegStatusQueue: Array<{ status: string; txid: string | null }> = [];
  const sideswap = {
    quote: async (params: { from: "DEPIX" | "USDT" | "LBTC"; to: "DEPIX" | "USDT" | "LBTC"; amountSats: bigint }) => {
      quoteCalls.push(params);
      const b = behaviourByTo[params.to] ?? {};
      if (b.quoteError) throw b.quoteError;
      const quote: SideSwapQuote = {
        quoteId: "Q1",
        from: params.from,
        to: params.to,
        sendAmountSats: params.amountSats,
        recvAmountSats: b.recvAmountSats ?? 42n,
        serverFeeSats: b.serverFeeSats ?? 0n,
        fixedFeeSats: b.fixedFeeSats ?? 0n,
        feeAsset: b.feeAsset ?? null,
        ttlMs: 30_000,
        expiresAt: Date.now() + 30_000,
        receiveAddress: "lq1our-receive"
      };
      const streamKey = `${params.from}>${params.to}`;
      return {
        next: async () => quote,
        execute: async (q: SideSwapQuote): Promise<SwapExecuteResult> => {
          executed.push(q);
          return {
            txid: "swap_txid",
            from: q.from,
            to: q.to,
            sendAmountSats: q.sendAmountSats,
            recvAmountSats: q.recvAmountSats,
            brlCents: 100
          };
        },
        close: () => {
          closed.push(streamKey);
        }
      };
    },
    pegIn: async () => ({
      orderId: "PEG_IN_1",
      pegAddr: "bc1qpeg-in-funding-address",
      recvAddr: "lq1our-receive",
      expiresAt: 1234
    }),
    pegOut: async (params: { recvAddr: string; amountSats: bigint }) => {
      pegOutCalls.push(params);
      return {
        orderId: "PEG_OUT_1",
        pegAddr: "lq1sideswap-peg-address",
        recvAddr: params.recvAddr,
        txid: "lbtc_send_txid",
        amountSats: params.amountSats,
        recvAmount: 9_900,
        brlCents: 50
      };
    },
    pegStatus: async (args: { orderId: string; pegIn: boolean }) => {
      pegStatusCalls.push(args);
      const next = pegStatusQueue.shift() ?? { status: "Processing", txid: null };
      return { orderId: args.orderId, status: next.status, confirmations: 0, txid: next.txid, deposits: [] };
    }
  };
  return {
    sideswap,
    closed,
    executed,
    quoteCalls,
    pegOutCalls,
    pegStatusCalls,
    setPegStatusQueue: (q: Array<{ status: string; txid: string | null }>) => {
      pegStatusQueue = q;
    }
  };
}

function makeFakeSideshift() {
  const sendCalls: Array<Record<string, unknown>> = [];
  const statusCalls: string[] = [];
  let statusQueue: Array<{ status: string; settleAmount: string | null }> = [];
  const sideshift = {
    quote: async (params: { network: string; amountSats: bigint }) => ({
      quoteId: "SSQ1",
      depositNetwork: "liquid",
      settleNetwork: params.network,
      depositCoin: "usdt",
      settleCoin: "usdt",
      depositAmountSats: params.amountSats,
      settleAmount: "18.5",
      rate: "0.99",
      expiresAt: null,
      custodial: true as const
    }),
    send: async (params: {
      network: string;
      amountSats: bigint;
      settleAddress: string;
      refundAddress?: string;
    }) => {
      sendCalls.push({ ...params });
      return {
        shiftId: "SHIFT_1",
        network: params.network,
        depositAddress: "lq1sideshift-deposit",
        settleAddress: params.settleAddress,
        refundAddress: params.refundAddress ?? null,
        depositAmountSats: params.amountSats,
        settleAmount: "18.5",
        status: "waiting",
        txid: "usdt_send_txid",
        brlCents: 100,
        custodial: true as const
      };
    },
    receive: async (params: { network: string; refundAddress?: string }) => ({
      shiftId: "SHIFT_R1",
      network: params.network,
      depositAddress: "0xsideshift-inbound-deposit",
      settleAddress: "lq1our-receive",
      min: "10",
      max: "5000",
      expiresAt: 999,
      custodial: true as const
    }),
    getStatus: async (shiftId: string) => {
      statusCalls.push(shiftId);
      const next = statusQueue.shift() ?? { status: "pending", settleAmount: null };
      return {
        shiftId,
        status: next.status,
        pending: !["settled", "refunded", "expired"].includes(next.status),
        terminal: ["settled", "refunded", "expired"].includes(next.status),
        inRefund: ["refund", "refunding", "refunded"].includes(next.status),
        depositAmount: "20",
        settleAmount: next.settleAmount,
        custodial: true as const
      };
    }
  };
  return {
    sideshift,
    sendCalls,
    statusCalls,
    setStatusQueue: (q: Array<{ status: string; settleAmount: string | null }>) => {
      statusQueue = q;
    }
  };
}

function makeFakeBoltz(over: Partial<Record<"pay" | "receive" | "stablecoin", unknown>> = {}) {
  const boltz = {
    payLightningInvoice: vi.fn(async (params: { invoice: string }) => ({
      swapId: "SUB_1",
      lockupTxid: "lockup_txid",
      expectedAmountSats: 10_050,
      invoiceSats: 10_000,
      invoice: params.invoice,
      completion: Promise.resolve({ swapId: "SUB_1", status: "paid" as const }),
      ...(typeof over.pay === "object" ? over.pay : {})
    })),
    receiveLightning: vi.fn(async (params: { amountSats: number }) => ({
      swapId: "REV_1",
      invoice: "lnbc1invoice",
      lockupAddress: "lq1boltz-lockup",
      amountSats: params.amountSats,
      // Never resolves — convert() must NOT wait on an inflow.
      completion: new Promise(() => {}) as Promise<never>,
      ...(typeof over.receive === "object" ? over.receive : {})
    })),
    toStablecoin: vi.fn(
      async (params: { asset: "USDC" | "USDT"; networkId: string; amountSats: number; claimAddress: string }) => ({
        swapId: "CHAIN_1",
        lockupTxid: "chain_lockup_txid",
        lockAmountSats: params.amountSats,
        asset: params.asset,
        networkId: params.networkId,
        claimAddress: params.claimAddress,
        completion: Promise.resolve({
          swapId: "CHAIN_1",
          status: "settled" as const,
          claimTransactionId: "0xclaim"
        }),
        ...(typeof over.stablecoin === "object" ? over.stablecoin : {})
      })
    )
  };
  return boltz;
}

function makeDeps(over: Partial<IntentDeps> = {}) {
  const ss = makeFakeSideswap();
  const shift = makeFakeSideshift();
  const boltz = makeFakeBoltz();
  const deps: IntentDeps = {
    sideswap: ss.sideswap,
    sideshift: shift.sideshift,
    getBoltz: () => boltz,
    pollIntervalMs: 1,
    ...over
  };
  return { deps, ss, shift, boltz };
}

// ── quote() ───────────────────────────────────────────────────────────────────

describe("quoteRoutes — enumerates ALL candidates with chained estimates", () => {
  it("DEPIX → USDT @ethereum: two 2-hop routes, estimates chained leg to leg", async () => {
    const ss = makeFakeSideswap({
      LBTC: { recvAmountSats: 20_000n, serverFeeSats: 100n, fixedFeeSats: 10n, feeAsset: ASSETS.LBTC.id },
      USDT: { recvAmountSats: 1_900_000_000n, serverFeeSats: 0n, fixedFeeSats: 0n }
    });
    const shift = makeFakeSideshift();
    const boltz = makeFakeBoltz();
    const estimateStablecoin = vi.fn(async (p: { asset: string; networkId: string; amountSats: number }) => ({
      receiveAmount: 950_000n, // 0.95 USDT in the 6-decimal EVM base units
      decimals: 6,
      sendAmountSats: p.amountSats,
      boltzPercent: 0.1,
      minerFeesSats: 300,
      bridgeFeeSats: null,
      minSats: 1_000,
      maxSats: null
    }));
    const deps: IntentDeps = {
      sideswap: ss.sideswap,
      sideshift: shift.sideshift,
      getBoltz: () => boltz,
      estimateStablecoin
    };

    const routes = await quoteRoutes({ from: "DEPIX", to: "USDT", network: "ethereum", amount: 100_000_000n }, deps);

    expect(routes.map((r) => r.id)).toEqual([ROUTE_DEPIX_BOLTZ, ROUTE_DEPIX_SIDESHIFT]);
    const [viaBoltz, viaSideshift] = routes;

    // Non-custodial boltz path: swap est feeds the stablecoin estimator with
    // the NET recv (20_000 quoted − 110 declared fees = 19_890) — SideSwap's
    // recv_amount is pre-fee and the dealer nets the fees out of the recv
    // output (mainnet e2e P0/P2, 2026-07-11).
    expect(viaBoltz).toMatchObject({ hops: 2, custodial: false });
    expect(estimateStablecoin).toHaveBeenCalledWith(
      expect.objectContaining({ asset: "USDT", networkId: "ethereum", amountSats: 19_890 })
    );
    // Received is normalized to 8-decimal base units of the destination asset.
    expect(viaBoltz!.estimatedReceivedSats).toBe(95_000_000n);
    expect(viaBoltz!.estimateComplete).toBe(true);
    expect(viaBoltz!.legs[0]!.estimatedReceivedSats).toBe(19_890n);
    expect(viaBoltz!.legs[0]!.estimatedFeeSats).toBe(110n);
    expect(viaBoltz!.legs[0]!.feeAsset).toBe("LBTC");
    // 300 miner sats + ceil(0.1% of 20_000) = 320 L-BTC sats.
    expect(viaBoltz!.legs[1]!.estimatedFeeSats).toBe(320n);
    // Both legs' fees are L-BTC-denominated → a total is meaningful.
    expect(viaBoltz!.estimatedFeeTotalSats).toBe(430n);
    expect(viaBoltz!.feeAsset).toBe("LBTC");

    // Custodial sideshift path: swap → USDT-liquid → sideshift quote.
    expect(viaSideshift!.custodial).toBe(true);
    expect(viaSideshift!.legs[1]!.custodial).toBe(true);
    // settleAmount "18.5" → 1_850_000_000 (8-decimal USDT base units).
    expect(viaSideshift!.estimatedReceivedSats).toBe(1_850_000_000n);
    // Implicit sideshift fee = deposited − settled = 50_000_000 (USDT sats).
    expect(viaSideshift!.legs[1]!.estimatedFeeSats).toBe(50_000_000n);
    expect(viaSideshift!.legs[1]!.feeAsset).toBe("USDT");
    // The swap leg's server omitted fee_asset → the SDK defaults it to the
    // recv asset (fees are netted from the recv side — e2e P2, 2026-07-11).
    // Both legs are then USDT-denominated, so the total IS computable:
    // 0 (zero-fee swap leg) + 50_000_000 (sideshift implicit fee).
    expect(viaSideshift!.legs[0]!.feeAsset).toBe("USDT");
    expect(viaSideshift!.estimatedFeeTotalSats).toBe(50_000_000n);
    expect(viaSideshift!.feeAsset).toBe("USDT");
  });

  it("an unestimatable leg yields null estimates, flags the route and SKIPS downstream estimators", async () => {
    const ss = makeFakeSideswap({
      LBTC: { quoteError: new Error("INSUFFICIENT_FUNDS") },
      USDT: { quoteError: new Error("INSUFFICIENT_FUNDS") }
    });
    const shift = makeFakeSideshift();
    const boltz = makeFakeBoltz();
    const estimateStablecoin = vi.fn();
    const deps: IntentDeps = {
      sideswap: ss.sideswap,
      sideshift: shift.sideshift,
      getBoltz: () => boltz,
      estimateStablecoin: estimateStablecoin as never
    };

    const routes = await quoteRoutes({ from: "DEPIX", to: "USDT", network: "ethereum", amount: 1_000n }, deps);
    expect(routes).toHaveLength(2);
    for (const route of routes) {
      expect(route.estimatedReceivedSats).toBe(null);
      expect(route.estimatedFeeTotalSats).toBe(null);
      expect(route.estimateComplete).toBe(false);
      expect(route.notes.length).toBeGreaterThan(0);
    }
    // The downstream estimator never ran — its input amount is unknown.
    expect(estimateStablecoin).not.toHaveBeenCalled();
  });

  it("market-swap estimation closes the quote stream (no socket leak)", async () => {
    const { deps, ss } = makeDeps();
    await quoteRoutes({ from: "DEPIX", to: "LBTC", network: "liquid", amount: 1_000n }, deps);
    expect(ss.closed).toEqual(["DEPIX>LBTC"]);
    expect(ss.executed).toHaveLength(0); // estimate only — never executes
  });

  it("BTC lightning entry uses estimateReverseReceive over the reverse pair fees", async () => {
    const { deps } = makeDeps({
      reverseLimits: async () => ({ fees: { percentage: 0.5, minerFees: { claim: 100, lockup: 200 } } })
    });
    const routes = await quoteRoutes(
      { from: "BTC", to: "LBTC", network: "liquid", fromNetwork: "lightning", amount: 100_000n },
      deps
    );
    expect(routes).toHaveLength(1);
    // 100_000 − ceil(0.5%) 500 − 300 miner = 99_200.
    expect(routes[0]!.estimatedReceivedSats).toBe(99_200n);
    expect(routes[0]!.legs[0]!.estimatedFeeSats).toBe(800n);
  });

  it("peg legs cannot be pre-estimated: null + an explanatory note", async () => {
    const { deps } = makeDeps();
    const routes = await quoteRoutes(
      { from: "BTC", to: "LBTC", network: "liquid", fromNetwork: "bitcoin", amount: 100_000n },
      deps
    );
    expect(routes[0]!.estimatedReceivedSats).toBe(null);
    expect(routes[0]!.estimateComplete).toBe(false);
    expect(routes[0]!.notes.join(" ")).toMatch(/peg/i);
  });

  it("throws UNSUPPORTED_ASSET with a nextStep when no route exists", async () => {
    const { deps } = makeDeps();
    await expect(
      quoteRoutes({ from: "USDC", to: "DEPIX", network: "liquid", amount: 1n }, deps)
    ).rejects.toSatisfy(
      (e) =>
        isDepixSdkError(e, "UNSUPPORTED_ASSET") &&
        typeof (e as { details?: { nextStep?: string } }).details?.nextStep === "string"
    );
  });

  it("rejects a non-positive amount with INVALID_AMOUNT", async () => {
    const { deps } = makeDeps();
    await expect(
      quoteRoutes({ from: "DEPIX", to: "LBTC", network: "liquid", amount: 0n }, deps)
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "INVALID_AMOUNT"));
  });
});

// ── convert() — route resolution ──────────────────────────────────────────────

describe("convertIntent — route resolution (no policy: the agent chooses)", () => {
  it("rejects a non-positive / non-bigint amount before touching any provider", async () => {
    const { deps } = makeDeps();
    await expect(
      convertIntent({ from: "DEPIX", to: "LBTC", network: "liquid", amount: -5n }, deps)
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "INVALID_AMOUNT"));
    await expect(
      convertIntent({ from: "DEPIX", to: "LBTC", network: "liquid", amount: 5 as unknown as bigint }, deps)
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "INVALID_AMOUNT"));
  });

  it("executes the unique single-hop table row even when multi-hop alternatives exist", async () => {
    // LBTC → USDT @ethereum also has a 2-hop sideshift composition — the
    // designated single-hop row (boltz.toStablecoin) still executes directly.
    const { deps, boltz } = makeDeps();
    const res = await convertIntent(
      { from: "LBTC", to: "USDT", network: "ethereum", amount: 50_000n, address: "0xdest" },
      deps
    );
    expect(boltz.toStablecoin).toHaveBeenCalledOnce();
    expect(res.route.id).toBe("boltz.toStablecoin:LBTC@liquid>USDT@ethereum");
    expect(res.status).toBe("settled");
  });

  it("throws MULTIPLE_ROUTES_AVAILABLE when >1 candidate and no route was passed", async () => {
    const { deps } = makeDeps();
    await expect(
      convertIntent({ from: "BTC", to: "LBTC", network: "liquid", amount: 1_000n }, deps)
    ).rejects.toSatisfy((e) => {
      if (!isDepixSdkError(e, "MULTIPLE_ROUTES_AVAILABLE")) return false;
      const details = (e as { details?: { routes?: unknown[]; nextStep?: string } }).details;
      return Array.isArray(details?.routes) && details.routes.length === 2 && typeof details.nextStep === "string";
    });
  });

  it("a single multi-hop candidate RESOLVES (locked rule: 1 route → execute) — without a plan store it fails with the view-only refusal, not ambiguity", async () => {
    // Full multi-hop execution is covered in convert-multihop.test.ts; these
    // deps have no planStore (the view-only wallet shape), so the multi-hop
    // path must refuse with a per-leg fallback — NEVER MULTIPLE_ROUTES_AVAILABLE.
    const { deps } = makeDeps();
    await expect(
      convertIntent({ from: "DEPIX", to: "BTC", network: "lightning", amount: 1_000n, invoice: "lnbc1xyz" }, deps)
    ).rejects.toSatisfy(
      (e) => isDepixSdkError(e, "WALLET_NOT_FOUND") && /single-hop convert\(\)/.test(String((e as Error).message))
    );
  });

  it("an explicit multi-hop route id resolves to the plan machinery (no MULTI_HOP_NOT_YET_AUTOMATED)", async () => {
    const { deps } = makeDeps();
    await expect(
      convertIntent(
        {
          from: "DEPIX",
          to: "USDT",
          network: "ethereum",
          amount: 1_000n,
          route: ROUTE_DEPIX_BOLTZ,
          address: "0xdest"
        },
        deps
      )
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "WALLET_NOT_FOUND")); // only the missing plan store blocks here
  });

  it("throws ROUTE_NOT_FOUND (with the candidates) for an unknown route id", async () => {
    const { deps } = makeDeps();
    await expect(
      convertIntent({ from: "DEPIX", to: "LBTC", network: "liquid", amount: 1_000n, route: "bogus" }, deps)
    ).rejects.toSatisfy((e) => {
      if (!isDepixSdkError(e, "ROUTE_NOT_FOUND")) return false;
      const details = (e as { details?: { availableRouteIds?: string[]; nextStep?: string } }).details;
      return Array.isArray(details?.availableRouteIds) && typeof details?.nextStep === "string";
    });
  });

  it("executes an explicitly chosen single-hop route (string id or quote() object)", async () => {
    const { deps } = makeDeps();
    const byId = await convertIntent(
      {
        from: "BTC",
        to: "LBTC",
        network: "liquid",
        amount: 1_000n,
        route: "sideswap.pegIn:BTC@bitcoin>LBTC@liquid"
      },
      deps
    );
    expect(byId.status).toBe("awaiting_funding");
    expect(byId.funding?.address).toBe("bc1qpeg-in-funding-address");

    const { deps: deps2 } = makeDeps();
    const byObject = await convertIntent(
      {
        from: "BTC",
        to: "LBTC",
        network: "liquid",
        amount: 1_000n,
        route: { id: "boltz.receiveLightning:BTC@lightning>LBTC@liquid" }
      },
      deps2
    );
    expect(byObject.funding?.invoice).toBe("lnbc1invoice");
  });
});

// ── convert() — single-hop execution per provider ─────────────────────────────

describe("convertIntent — sideswap market swap (stream hidden, settles inline)", () => {
  it("quotes, executes and closes the stream internally", async () => {
    const ss = makeFakeSideswap({ LBTC: { recvAmountSats: 777n } });
    const { deps } = makeDeps({ sideswap: ss.sideswap });
    const res = await convertIntent({ from: "DEPIX", to: "LBTC", network: "liquid", amount: 1_000n }, deps);
    expect(res.status).toBe("settled");
    expect(res.txids).toEqual(["swap_txid"]);
    expect(res.receivedSats).toBe(777n);
    expect(res.custodial).toBe(false);
    expect(res.route.id).toBe("sideswap.swap:DEPIX@liquid>LBTC@liquid");
    expect(ss.executed).toHaveLength(1);
    expect(ss.closed).toEqual(["DEPIX>LBTC"]); // the agent never sees the stream
  });

  it("closes the stream even when execute() fails", async () => {
    const ss = makeFakeSideswap();
    ss.sideswap.quote = async (params) => {
      const stream = await makeFakeSideswap().sideswap.quote(params);
      return {
        ...stream,
        execute: async () => {
          throw new Error("boom");
        },
        close: () => ss.closed.push("closed-after-failure")
      };
    };
    const { deps } = makeDeps({ sideswap: ss.sideswap });
    await expect(
      convertIntent({ from: "DEPIX", to: "LBTC", network: "liquid", amount: 1_000n }, deps)
    ).rejects.toThrow("boom");
    expect(ss.closed).toEqual(["closed-after-failure"]);
  });
});

describe("convertIntent — sideswap pegs", () => {
  it("pegOut requires `address` (typed error with nextStep)", async () => {
    const { deps } = makeDeps();
    await expect(
      convertIntent({ from: "LBTC", to: "BTC", network: "bitcoin", amount: 10_000n }, deps)
    ).rejects.toSatisfy(
      (e) =>
        isDepixSdkError(e, "INVALID_ADDRESS") &&
        typeof (e as { details?: { nextStep?: string } }).details?.nextStep === "string"
    );
  });

  it("pegOut executes then polls pegStatus to settlement (wait default)", async () => {
    const { deps, ss } = makeDeps();
    ss.setPegStatusQueue([
      { status: "Processing", txid: null },
      { status: "Done", txid: "btc_payout_txid" }
    ]);
    const res = await convertIntent(
      { from: "LBTC", to: "BTC", network: "bitcoin", amount: 10_000n, address: "bc1qdest" },
      deps
    );
    expect(ss.pegOutCalls).toEqual([{ recvAddr: "bc1qdest", amountSats: 10_000n }]);
    expect(ss.pegStatusCalls.length).toBe(2);
    expect(res.status).toBe("settled");
    expect(res.txids).toEqual(["lbtc_send_txid", "btc_payout_txid"]);
    expect(res.receivedSats).toBe(9_900n);
    expect(res.trackingId).toBe("PEG_OUT_1");
  });

  it("pegOut wait timeout returns status pending with a nextStep (funds are in flight, not lost)", async () => {
    const { deps, ss } = makeDeps();
    ss.setPegStatusQueue([]); // always Processing
    const res = await convertIntent(
      { from: "LBTC", to: "BTC", network: "bitcoin", amount: 10_000n, address: "bc1qdest", timeoutMs: 15 },
      deps
    );
    expect(res.status).toBe("pending");
    expect(res.txids).toEqual(["lbtc_send_txid"]);
    expect(res.nextStep).toMatch(/pegStatus/);
    // Non-terminal: the BTC is not paid out yet — never report the order estimate.
    expect(res.receivedSats).toBe(null);
  });

  it("pegOut with wait:false returns right after the L-BTC send", async () => {
    const { deps, ss } = makeDeps();
    const res = await convertIntent(
      { from: "LBTC", to: "BTC", network: "bitcoin", amount: 10_000n, address: "bc1qdest", wait: false },
      deps
    );
    expect(ss.pegStatusCalls).toHaveLength(0);
    expect(res.status).toBe("pending");
    expect(res.receivedSats).toBe(null);
  });

  it("pegIn returns the BTC funding address immediately (inflow never blocks)", async () => {
    const { deps } = makeDeps();
    const res = await convertIntent(
      { from: "BTC", to: "LBTC", network: "liquid", fromNetwork: "bitcoin", amount: 1n },
      deps
    );
    expect(res.status).toBe("awaiting_funding");
    expect(res.funding).toMatchObject({ kind: "bitcoin-address", address: "bc1qpeg-in-funding-address" });
    expect(res.trackingId).toBe("PEG_IN_1");
    expect(res.custodial).toBe(false);
    expect(res.nextStep).toBeTruthy();
  });
});

describe("convertIntent — boltz (completion promises hidden)", () => {
  it("payLightningInvoice requires `invoice`", async () => {
    const { deps } = makeDeps();
    await expect(
      convertIntent({ from: "LBTC", to: "BTC", network: "lightning", amount: 10_000n }, deps)
    ).rejects.toSatisfy(
      (e) =>
        isDepixSdkError(e, "INVALID_ADDRESS") &&
        /invoice/i.test(String((e as { details?: { nextStep?: string } }).details?.nextStep))
    );
  });

  it("payLightningInvoice awaits the completion promise (wait default) and maps paid → settled", async () => {
    const { deps, boltz } = makeDeps();
    const res = await convertIntent(
      { from: "LBTC", to: "BTC", network: "lightning", amount: 10_000n, invoice: "lnbc1xyz" },
      deps
    );
    expect(boltz.payLightningInvoice).toHaveBeenCalledWith({ invoice: "lnbc1xyz" });
    expect(res.status).toBe("settled");
    expect(res.txids).toEqual(["lockup_txid"]);
    expect(res.receivedSats).toBe(10_000n); // the invoice amount is what the payee receives
    expect(res.trackingId).toBe("SUB_1");
  });

  it("payLightningInvoice maps a refunded outcome (funds returned, not settled)", async () => {
    const boltz = makeFakeBoltz({
      pay: { completion: Promise.resolve({ swapId: "SUB_1", status: "refunded", refundTxId: "refund_txid" }) }
    });
    const { deps } = makeDeps({ getBoltz: () => boltz });
    const res = await convertIntent(
      { from: "LBTC", to: "BTC", network: "lightning", amount: 10_000n, invoice: "lnbc1xyz" },
      deps
    );
    expect(res.status).toBe("refunded");
    expect(res.txids).toEqual(["lockup_txid", "refund_txid"]);
    expect(res.receivedSats).toBe(null);
  });

  it("a never-settling completion times out into status pending + recovery nextStep — and NEVER a received amount", async () => {
    const boltz = makeFakeBoltz({ pay: { completion: new Promise(() => {}) } });
    const { deps } = makeDeps({ getBoltz: () => boltz });
    const res = await convertIntent(
      { from: "LBTC", to: "BTC", network: "lightning", amount: 10_000n, invoice: "lnbc1xyz", timeoutMs: 10 },
      deps
    );
    expect(res.status).toBe("pending");
    expect(res.nextStep).toMatch(/recover|getPending/i);
    // Non-terminal: the invoice has NOT been paid — a received amount here would
    // read as delivered money.
    expect(res.receivedSats).toBe(null);
    expect(res.txids).toEqual(["lockup_txid"]);
    expect(res.trackingId).toBe("SUB_1");
  });

  it("payLightningInvoice with wait:false returns pending immediately without awaiting the completion", async () => {
    // A NEVER-resolving completion proves wait:false does not await it.
    const boltz = makeFakeBoltz({ pay: { completion: new Promise(() => {}) } });
    const { deps } = makeDeps({ getBoltz: () => boltz });
    const res = await convertIntent(
      { from: "LBTC", to: "BTC", network: "lightning", amount: 10_000n, invoice: "lnbc1xyz", wait: false },
      deps
    );
    expect(res.status).toBe("pending");
    expect(res.txids).toEqual(["lockup_txid"]);
    expect(res.receivedSats).toBe(null); // in flight ≠ delivered
    expect(res.trackingId).toBe("SUB_1");
    expect(res.nextStep).toMatch(/recover|getPending/i);
  });

  it("payLightningInvoice maps refund_pending (non-terminal) with a recover() nextStep and no receipt", async () => {
    const boltz = makeFakeBoltz({
      pay: { completion: Promise.resolve({ swapId: "SUB_1", status: "refund_pending" }) }
    });
    const { deps } = makeDeps({ getBoltz: () => boltz });
    const res = await convertIntent(
      { from: "LBTC", to: "BTC", network: "lightning", amount: 10_000n, invoice: "lnbc1xyz" },
      deps
    );
    expect(res.status).toBe("refund_pending");
    expect(res.receivedSats).toBe(null);
    expect(res.txids).toEqual(["lockup_txid"]);
    expect(res.nextStep).toBe(
      "the refund timeout has not been reached yet — wallet.recover() retries it; funds are safe."
    );
  });

  it("payLightningInvoice maps failed with the retry nextStep and no receipt", async () => {
    const boltz = makeFakeBoltz({
      pay: { completion: Promise.resolve({ swapId: "SUB_1", status: "failed" }) }
    });
    const { deps } = makeDeps({ getBoltz: () => boltz });
    const res = await convertIntent(
      { from: "LBTC", to: "BTC", network: "lightning", amount: 10_000n, invoice: "lnbc1xyz" },
      deps
    );
    expect(res.status).toBe("failed");
    expect(res.receivedSats).toBe(null);
    expect(res.nextStep).toBe("the swap failed before any settlement — check wallet.getPending() and retry.");
  });

  it("toStablecoin executes and settles (claim txid surfaced)", async () => {
    const { deps, boltz } = makeDeps();
    const res = await convertIntent(
      { from: "LBTC", to: "USDC", network: "base", amount: 50_000n, address: "0xAbCd" },
      deps
    );
    expect(boltz.toStablecoin).toHaveBeenCalledWith({
      asset: "USDC",
      networkId: "base",
      amountSats: 50_000,
      claimAddress: "0xAbCd"
    });
    expect(res.status).toBe("settled");
    expect(res.txids).toEqual(["chain_lockup_txid", "0xclaim"]);
    expect(res.custodial).toBe(false);
  });

  it("toStablecoin requires `address`", async () => {
    const { deps } = makeDeps();
    await expect(
      convertIntent({ from: "LBTC", to: "USDT", network: "tron", amount: 50_000n }, deps)
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "INVALID_ADDRESS"));
  });

  // The nextStep text executeToStablecoin attaches to every non-terminal outcome.
  const STABLECOIN_PENDING_NEXT_STEP =
    "the L-BTC lockup is in flight; the EVM legs run in the background — crash-safe. " +
    "wallet.recover() finishes (or refunds) it after a restart; wallet.getPending() tracks it.";

  it("toStablecoin maps a pending outcome (post-lockup failure left for resume): no receipt, recover() nextStep", async () => {
    const boltz = makeFakeBoltz({
      stablecoin: { completion: Promise.resolve({ swapId: "CHAIN_1", status: "pending" }) }
    });
    const { deps } = makeDeps({ getBoltz: () => boltz });
    const res = await convertIntent(
      { from: "LBTC", to: "USDC", network: "base", amount: 50_000n, address: "0xAbCd" },
      deps
    );
    expect(res.status).toBe("pending");
    // The L-BTC is locked but NOTHING was delivered — a receipt here would read
    // as delivered stablecoin (the money-adjacent invariant this suite guards).
    expect(res.receivedSats).toBe(null);
    expect(res.txids).toEqual(["chain_lockup_txid"]);
    expect(res.trackingId).toBe("CHAIN_1");
    expect(res.nextStep).toBe(STABLECOIN_PENDING_NEXT_STEP);
  });

  it("toStablecoin times out a never-settling completion into pending + recover() nextStep, receipt null", async () => {
    const boltz = makeFakeBoltz({ stablecoin: { completion: new Promise(() => {}) } });
    const { deps } = makeDeps({ getBoltz: () => boltz });
    const res = await convertIntent(
      { from: "LBTC", to: "USDC", network: "base", amount: 50_000n, address: "0xAbCd", timeoutMs: 10 },
      deps
    );
    expect(res.status).toBe("pending");
    expect(res.receivedSats).toBe(null);
    expect(res.txids).toEqual(["chain_lockup_txid"]);
    expect(res.trackingId).toBe("CHAIN_1");
    expect(res.nextStep).toBe(STABLECOIN_PENDING_NEXT_STEP);
  });

  it("toStablecoin with wait:false returns pending immediately without awaiting the completion", async () => {
    // A NEVER-resolving completion proves wait:false does not await it.
    const boltz = makeFakeBoltz({ stablecoin: { completion: new Promise(() => {}) } });
    const { deps } = makeDeps({ getBoltz: () => boltz });
    const res = await convertIntent(
      { from: "LBTC", to: "USDC", network: "base", amount: 50_000n, address: "0xAbCd", wait: false },
      deps
    );
    expect(res.status).toBe("pending");
    expect(res.receivedSats).toBe(null);
    expect(res.txids).toEqual(["chain_lockup_txid"]);
    expect(res.nextStep).toBe(STABLECOIN_PENDING_NEXT_STEP);
  });

  it("toStablecoin maps a refunded outcome: refund txid surfaced, receipt null (funds came back, not delivered)", async () => {
    const boltz = makeFakeBoltz({
      stablecoin: {
        completion: Promise.resolve({ swapId: "CHAIN_1", status: "refunded", refundTxId: "chain_refund_txid" })
      }
    });
    const { deps } = makeDeps({ getBoltz: () => boltz });
    const res = await convertIntent(
      { from: "LBTC", to: "USDT", network: "tron", amount: 50_000n, address: "TTronDest" },
      deps
    );
    expect(res.status).toBe("refunded");
    expect(res.receivedSats).toBe(null);
    expect(res.txids).toEqual(["chain_lockup_txid", "chain_refund_txid"]);
    expect(res.trackingId).toBe("CHAIN_1");
    // Terminal without delivery — no nextStep is attached (G3 mandates one only
    // for NON-terminal results).
    expect(res.nextStep).toBeUndefined();
  });

  it("toStablecoin maps refund_pending (non-terminal): receipt null + the recover() nextStep", async () => {
    const boltz = makeFakeBoltz({
      stablecoin: { completion: Promise.resolve({ swapId: "CHAIN_1", status: "refund_pending" }) }
    });
    const { deps } = makeDeps({ getBoltz: () => boltz });
    const res = await convertIntent(
      { from: "LBTC", to: "USDC", network: "base", amount: 50_000n, address: "0xAbCd" },
      deps
    );
    expect(res.status).toBe("refund_pending");
    expect(res.receivedSats).toBe(null);
    expect(res.txids).toEqual(["chain_lockup_txid"]);
    expect(res.nextStep).toBe(STABLECOIN_PENDING_NEXT_STEP);
  });

  it("toStablecoin maps a failed outcome: receipt null, terminal (no nextStep)", async () => {
    const boltz = makeFakeBoltz({
      stablecoin: { completion: Promise.resolve({ swapId: "CHAIN_1", status: "failed" }) }
    });
    const { deps } = makeDeps({ getBoltz: () => boltz });
    const res = await convertIntent(
      { from: "LBTC", to: "USDC", network: "base", amount: 50_000n, address: "0xAbCd" },
      deps
    );
    expect(res.status).toBe("failed");
    expect(res.receivedSats).toBe(null);
    expect(res.txids).toEqual(["chain_lockup_txid"]);
    expect(res.nextStep).toBeUndefined();
  });

  it("receiveLightning returns the invoice immediately — never waits on the payer", async () => {
    const { deps } = makeDeps();
    const res = await convertIntent(
      { from: "BTC", to: "LBTC", network: "liquid", fromNetwork: "lightning", amount: 25_000n },
      deps
    );
    expect(res.status).toBe("awaiting_funding");
    expect(res.funding).toMatchObject({ kind: "lightning-invoice", invoice: "lnbc1invoice" });
    expect(res.trackingId).toBe("REV_1");
    expect(res.nextStep).toMatch(/invoice/i);
  });
});

describe("convertIntent — sideshift (polling hidden, custodial signalled)", () => {
  it("send requires `address`", async () => {
    const { deps } = makeDeps();
    await expect(
      convertIntent({ from: "USDT", to: "USDT", network: "tron", amount: 2_000_000_000n }, deps)
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "INVALID_ADDRESS"));
  });

  it("send executes then polls getStatus to settlement", async () => {
    const { deps, shift } = makeDeps();
    shift.setStatusQueue([
      { status: "processing", settleAmount: null },
      { status: "settled", settleAmount: "19.9" }
    ]);
    const res = await convertIntent(
      { from: "USDT", to: "USDT", network: "tron", amount: 2_000_000_000n, address: "Ttronaddr" },
      deps
    );
    expect(shift.sendCalls).toEqual([
      { network: "tron", amountSats: 2_000_000_000n, settleAddress: "Ttronaddr" }
    ]);
    expect(shift.statusCalls).toEqual(["SHIFT_1", "SHIFT_1"]);
    expect(res.status).toBe("settled");
    expect(res.custodial).toBe(true);
    expect(res.txids).toEqual(["usdt_send_txid"]);
    // Final settleAmount (19.9 USDT) in 8-decimal base units.
    expect(res.receivedSats).toBe(1_990_000_000n);
    expect(res.trackingId).toBe("SHIFT_1");
  });

  it("send forwards refundAddress and times out into pending + getStatus nextStep", async () => {
    const { deps, shift } = makeDeps();
    shift.setStatusQueue([]); // stays pending
    const res = await convertIntent(
      {
        from: "USDT",
        to: "USDT",
        network: "ethereum",
        amount: 2_000_000_000n,
        address: "0xdest",
        refundAddress: "lq1refund",
        timeoutMs: 15
      },
      deps
    );
    expect(shift.sendCalls[0]).toMatchObject({ refundAddress: "lq1refund" });
    expect(res.status).toBe("pending");
    expect(res.nextStep).toMatch(/getStatus|status/i);
    // CUSTODIAL mid-flight: the quoted settleAmount must NOT surface as a receipt.
    expect(res.receivedSats).toBe(null);
  });

  it("send with wait:false returns pending WITHOUT a received amount (custodial mid-flight, not delivered)", async () => {
    const { deps, shift } = makeDeps();
    const res = await convertIntent(
      {
        from: "USDT",
        to: "USDT",
        network: "ethereum",
        amount: 2_000_000_000n,
        address: "0xdest",
        wait: false
      },
      deps
    );
    expect(res.status).toBe("pending");
    expect(res.custodial).toBe(true);
    // The shift only just deposited — SideShift still holds the USDt. The quoted
    // settleAmount must not read as delivered.
    expect(res.receivedSats).toBe(null);
    // wait:false short-circuits BEFORE any getStatus poll.
    expect(shift.statusCalls).toHaveLength(0);
  });

  it("receive returns the external deposit address immediately (inflow, custodial)", async () => {
    const { deps } = makeDeps();
    const res = await convertIntent(
      { from: "USDT", to: "USDT", network: "liquid", fromNetwork: "ethereum", amount: 1n },
      deps
    );
    expect(res.status).toBe("awaiting_funding");
    expect(res.custodial).toBe(true);
    expect(res.funding).toMatchObject({
      kind: "external-deposit-address",
      address: "0xsideshift-inbound-deposit",
      network: "ethereum",
      min: "10",
      max: "5000"
    });
  });

  it("receive without fromNetwork is ambiguous → MULTIPLE_ROUTES_AVAILABLE", async () => {
    const { deps } = makeDeps();
    await expect(
      convertIntent({ from: "USDT", to: "USDT", network: "liquid", amount: 1n }, deps)
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "MULTIPLE_ROUTES_AVAILABLE"));
  });
});

describe("precision guards — the bigint→number boundary fails loud, never silently", () => {
  it("a >8-decimal stablecoin estimate is refused (up-scaling would over-report) and surfaces as a route note", async () => {
    // estimate-only path: the throw at intent.ts (est.decimals > 8) is caught by
    // quoteRoute and becomes a null estimate + note — never a bad number.
    const estimateStablecoin = vi.fn(async (p: { asset: string; networkId: string; amountSats: number }) => ({
      receiveAmount: 950_000_000n,
      decimals: 9, // a hypothetical future 9-decimal boltz variant
      sendAmountSats: p.amountSats,
      boltzPercent: 0.1,
      minerFeesSats: 300,
      bridgeFeeSats: null,
      minSats: 1_000,
      maxSats: null
    }));
    const { deps } = makeDeps({ estimateStablecoin: estimateStablecoin as never });
    const routes = await quoteRoutes({ from: "LBTC", to: "USDC", network: "base", amount: 50_000n }, deps);
    expect(routes).toHaveLength(1); // single-hop boltz.toStablecoin
    expect(estimateStablecoin).toHaveBeenCalledWith(
      expect.objectContaining({ asset: "USDC", networkId: "base", amountSats: 50_000 })
    );
    const route = routes[0]!;
    expect(route.estimatedReceivedSats).toBe(null); // NEVER a 10^(decimals-8)-over-reported number
    expect(route.estimateComplete).toBe(false);
    expect(route.legs[0]!.estimatedReceivedSats).toBe(null);
    expect(route.notes.join(" ")).toMatch(/decimals 9 > 8 not supported/);
  });

  it("an amount above Number.MAX_SAFE_INTEGER is refused with INVALID_AMOUNT BEFORE the provider is called", async () => {
    const { deps, boltz } = makeDeps();
    const over = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    await expect(
      convertIntent({ from: "LBTC", to: "USDC", network: "base", amount: over, address: "0xAbCd" }, deps)
    ).rejects.toSatisfy((e) => {
      if (!isDepixSdkError(e, "INVALID_AMOUNT")) return false;
      const nextStep = String((e as { details?: { nextStep?: string } }).details?.nextStep ?? "");
      // The guard is actionable: it names the exact per-leg ceiling.
      return nextStep.includes(String(Number.MAX_SAFE_INTEGER));
    });
    expect(boltz.toStablecoin).not.toHaveBeenCalled();

    // The same guard protects the receiveLightning inflow narrow.
    await expect(
      convertIntent({ from: "BTC", to: "LBTC", network: "liquid", fromNetwork: "lightning", amount: over }, deps)
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "INVALID_AMOUNT"));
    expect(boltz.receiveLightning).not.toHaveBeenCalled();
  });

  it("an amount of exactly Number.MAX_SAFE_INTEGER passes the bound and reaches the provider losslessly", async () => {
    const { deps, boltz } = makeDeps();
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    const res = await convertIntent(
      { from: "BTC", to: "LBTC", network: "liquid", fromNetwork: "lightning", amount: max },
      deps
    );
    expect(res.status).toBe("awaiting_funding");
    expect(boltz.receiveLightning).toHaveBeenCalledWith({ amountSats: Number.MAX_SAFE_INTEGER });
  });
});

describe("makeConvertFacade — sub-namespace getters are non-enumerable", () => {
  it("incidental enumeration (spread/keys) does NOT invoke the throwing .boltz getter on a view-only wallet", () => {
    // View-only wallet: the `.boltz` getter throws WALLET_NOT_FOUND (gate by design).
    const ns = {
      get sideswap() {
        return { tag: "sideswap" };
      },
      get sideshift() {
        return { tag: "sideshift" };
      },
      get boltz(): never {
        throw new Error("view-only WALLET_NOT_FOUND");
      }
    } as unknown as Parameters<typeof makeConvertFacade>[0];
    const facade = makeConvertFacade(ns, {} as IntentDeps);
    // Spreading / walking own enumerable keys must NOT trip the throwing getter…
    expect(() => ({ ...facade })).not.toThrow();
    expect(Object.keys(facade)).not.toContain("boltz");
    // …but explicit property access still gates as designed…
    expect(() => facade.boltz).toThrow(/view-only/);
    // …and the non-throwing namespaces remain reachable by property access.
    expect((facade.sideswap as unknown as { tag: string }).tag).toBe("sideswap");
  });
});
