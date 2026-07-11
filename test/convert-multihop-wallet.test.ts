// Multi-hop wallet.convert() through the REAL DepixWallet (PR-C e2e): both legs
// of a REAL 2-hop route execute through the real wiring — the §4.3 guardrail
// choke point (real Guardrails engine + BRL valuator), the real encrypted
// conversion-plan store on disk, and the real provider namespaces — with ONLY
// the outer edges faked (SideSwap WS client, the foreign-PSET/lwk signing seam,
// SideShift REST + USDt-send signing seam, and the LWK chain-state view of the
// wallet's UTXOs).
//
// Route under test: DEPIX → USDT@ethereum via
//   sideswap.swap:DEPIX@liquid>USDT@liquid + sideshift.send:USDT@liquid>USDT@ethereum
// Leg 2's input is leg 1's REAL executed output; guardrail caps are set LOW
// (R$50) so the R$100 exit leg would BUST them unless the count-once
// continuation authenticates in the wallet's own encrypted plan store.
//
// The companion test creates GENUINE in-flight state — the SAME wallet.convert()
// call times out waiting on the shift — and then wallet.recover() on the SAME
// wallet completes the plan (probe-to-settled, never a re-execution).
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DepixWallet } from "../src/wallet.js";
import { ASSETS } from "../src/assets.js";
import { Wollet } from "../src/engine/lwk.js";
import { liquidScriptHex } from "../src/guardrails/allowlist.js";
import type { QuotesSource } from "../src/guardrails/quotes.js";
import type { FetchLike, FetchResponseLike } from "../src/api/client.js";
import type { SwapPsetInspection } from "../src/convert/sideswap.js";
import { ConversionPlanStore } from "../src/convert/plan-store.js";
import { FakeSideSwapClient } from "./support/sideswap-mock.js";

const PASSPHRASE = "correct-horse-battery-staple";
const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const QUOTES: QuotesSource = { get: async () => ({ btcUsd: 100_000, usdBrl: 5 }) };
const EVM_DEST = "0x" + "a".repeat(40);
const ROUTE_DEPIX_SIDESHIFT =
  "sideswap.swap:DEPIX@liquid>USDT@liquid+sideshift.send:USDT@liquid>USDT@ethereum";

// The swap leg's REAL executed output — 20 USDt in 8-decimal base units. The
// SideShift REST fake's depositAmount ("20") matches it, so a drift between the
// two would fail SIDESHIFT_AMOUNT_MISMATCH.
const SWAP_RECV_USDT_SATS = 2_000_000_000n;

let dataDir: string;
let wallet: DepixWallet;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-mh-wallet-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await wallet?.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
});

/** LWK chain-state edge: one confirmed 1.0-DEPIX UTXO on the real Wollet. */
function stubConfirmedDepixUtxo(): void {
  const utxo = {
    outpoint: () => ({ txid: () => ({ toString: () => "aa".repeat(32) }), vout: () => 0 }),
    unblinded: () => ({
      asset: () => ({ toString: () => ASSETS.DEPIX.id }),
      assetBlindingFactor: () => ({ toString: () => "ab".repeat(32) }),
      value: () => 100_000_000,
      valueBlindingFactor: () => ({ toString: () => "cd".repeat(32) })
    }),
    height: () => 3_000_000 // confirmed — selectSwapUtxos skips unconfirmed
  };
  vi.spyOn(Wollet.prototype, "utxos").mockReturnValue([utxo] as unknown as ReturnType<Wollet["utxos"]>);
}

/** Fake SideShift REST, status-flippable; records the raw request bodies. */
function fakeSideshiftREST() {
  const state = { shiftStatus: "settled", settleAmount: "19.8" as string | null };
  const quoteBodies: Array<Record<string, unknown>> = [];
  const shiftBodies: Array<Record<string, unknown>> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    let body: Record<string, unknown> = {};
    if (url.endsWith("/quotes")) {
      quoteBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      body = { id: "q1", rate: "0.99", settleAmount: "19.8" };
    } else if (url.endsWith("/shifts/fixed")) {
      shiftBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      body = {
        id: "SHIFT_MH1",
        depositAddress: "lq1qdeposit",
        depositAmount: "20",
        settleAmount: "19.8",
        status: "waiting"
      };
    } else if (url.includes("/shifts/")) {
      body = {
        id: "SHIFT_MH1",
        status: state.shiftStatus,
        settleAmount: state.shiftStatus === "settled" ? state.settleAmount : null,
        depositAmount: "20"
      };
    }
    const res: FetchResponseLike = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body)
    };
    return res;
  };
  return { fetchImpl, state, quoteBodies, shiftBodies };
}

/** Open the wallet's OWN encrypted plan store from disk (same dataDir/passphrase/salt). */
async function planStoreOf(dir: string): Promise<ConversionPlanStore> {
  const walletFile = JSON.parse(await readFile(join(dir, "wallet.json"), "utf8")) as { salt: string };
  return new ConversionPlanStore({ dataDir: dir, passphrase: PASSPHRASE, saltB64: walletFile.salt });
}

async function waitFor(cond: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Rig {
  client: FakeSideSwapClient;
  rest: ReturnType<typeof fakeSideshiftREST>;
  sendUsdtCalls: Array<{ depositAddress: string; amountSats: bigint; brlCents: number }>;
  signerPsets: string[];
}

/**
 * Open the REAL wallet with only the edges faked. Caps are R$50 — the R$100
 * exit leg busts them for anything but an authenticated plan continuation.
 */
async function openRig(): Promise<Rig> {
  stubConfirmedDepixUtxo();
  const client = new FakeSideSwapClient();
  const rest = fakeSideshiftREST();
  const sendUsdtCalls: Rig["sendUsdtCalls"] = [];
  const signerPsets: string[] = [];
  wallet = await DepixWallet.restore({
    dataDir,
    passphrase: PASSPHRASE,
    mnemonic: KNOWN_MNEMONIC,
    quotes: QUOTES,
    guardrails: { perTxLimitBrlCents: 5_000, dailyLimitBrlCents: 5_000 },
    convert: {
      clientFactory: () => client,
      // The lwk signing edge. It still drives the REAL fail-closed validation
      // (assertSwapPsetPaysAndBalances) against the REAL pinned receive script.
      signForeignPset: async (psetB64, validate) => {
        signerPsets.push(psetB64);
        const receiveAddress = client.startQuotesCalls[0]!.receiveAddress;
        const inspection: SwapPsetInspection = {
          outputScriptsHex: [liquidScriptHex(receiveAddress)],
          netBalances: new Map([
            [ASSETS.USDT.id, SWAP_RECV_USDT_SATS], // recv: exactly the quote
            [ASSETS.DEPIX.id, -100_000_000n] // send: exactly the quoted send side
          ])
        };
        validate(inspection);
        return "SIGNED_PSET_B64";
      },
      sideshift: {
        fetchImpl: rest.fetchImpl,
        affiliateId: "test-affiliate",
        sendUsdt: async (p) => {
          sendUsdtCalls.push({ ...p });
          return { txid: "usdt_send_txid" };
        }
      },
      intent: { pollIntervalMs: 1 }
    }
  });
  return { client, rest, sendUsdtCalls, signerPsets };
}

/** Start convert() and feed the swap leg one live quote tick once it subscribes. */
function startConvert(rig: Rig, params: { timeoutMs?: number } = {}) {
  const promise = wallet.convert({
    from: "DEPIX",
    to: "USDT",
    network: "ethereum",
    amount: 100_000_000n, // 1.0 DEPIX = R$1 — leg 1 passes the R$50 caps
    route: ROUTE_DEPIX_SIDESHIFT,
    address: EVM_DEST,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {})
  });
  const fed = (async () => {
    await waitFor(() => rig.client.startQuotesCalls.length === 1, "the swap quote subscription");
    rig.client.emitQuote({
      quoteId: "QMH1",
      sendAmount: 100_000_000n,
      recvAmount: SWAP_RECV_USDT_SATS,
      serverFee: 0n,
      fixedFee: 0n,
      feeAsset: null,
      ttlMs: 30_000,
      sendAsset: ASSETS.DEPIX.id,
      recvAsset: ASSETS.USDT.id
    });
  })();
  return Promise.all([promise, fed]).then(([res]) => res);
}

describe("multi-hop wallet.convert() e2e — BOTH legs through the real wiring", () => {
  it("DEPIX → USDT@ethereum settles end to end: real guardrail count-once, real plan store, leg 2 sized by leg 1's REAL output", async () => {
    const rig = await openRig();
    const res = await startConvert(rig);

    // Terminal result of the WHOLE route, from the SETTLED shift.
    expect(res.status).toBe("settled");
    expect(res.route.id).toBe(ROUTE_DEPIX_SIDESHIFT);
    expect(res.receivedSats).toBe(1_980_000_000n); // "19.8" settled USDt, 8-decimal base units
    expect(res.txids).toEqual(["fake_txid", "usdt_send_txid"]); // swap txid + USDt-send txid, leg order
    expect(res.custodial).toBe(true); // the sideshift leg is custodial — signalled
    expect(res.trackingId).toBe("SHIFT_MH1");

    // Leg 1 ran the REAL SideSwap wiring: one subscription, one get_quote, one
    // signed taker_sign — and the REAL fail-closed PSET validation passed against
    // the REAL pinned receive script (the fake signer called validate()).
    expect(rig.client.connectCount).toBe(1);
    expect(rig.client.getQuoteCalls).toEqual(["QMH1"]);
    expect(rig.client.takerSignCalls).toEqual([{ quoteId: "QMH1", signedPset: "SIGNED_PSET_B64" }]);
    expect(rig.signerPsets).toEqual(["FAKE_PSET_B64"]);

    // Leg 2 consumed leg 1's REAL executed output: the SideShift quote was
    // requested for EXACTLY 20 USDt (2_000_000_000 base units), and the USDt
    // send signed exactly the shift's deposit amount.
    expect(rig.rest.quoteBodies.map((b) => b.depositAmount)).toEqual(["20"]); // send()'s fresh quote — sized by the REAL leg-1 output
    expect(rig.rest.shiftBodies).toHaveLength(1);
    expect(rig.rest.shiftBodies[0]).toMatchObject({ settleAddress: EVM_DEST, affiliateId: "test-affiliate" });
    expect(rig.sendUsdtCalls).toEqual([
      { depositAddress: "lq1qdeposit", amountSats: SWAP_RECV_USDT_SATS, brlCents: 10_000 }
    ]);

    // COUNT-ONCE through the REAL guardrail engine: the R$100 exit leg would
    // bust the R$50 caps as a direct call — it executed ONLY because the plan
    // continuation authenticated in the wallet's encrypted store, and the
    // rolling-24h window recorded ONLY leg 1's R$1 (100 cents).
    const usage = await wallet.getGuardrails();
    expect(usage.usedCents).toBe(100);

    // Terminal outcome → the durable plan is gone from the wallet's OWN store.
    const store = await planStoreOf(dataDir);
    expect(await store.count()).toBe(0);
    expect((await wallet.getPending()).filter((i) => i.rail === "plan")).toHaveLength(0);
  });

  it("a shift that outlives the wait leaves GENUINE in-flight state; wallet.recover() on the SAME wallet completes it without re-executing", async () => {
    const rig = await openRig();
    rig.rest.state.shiftStatus = "waiting"; // the shift stays non-terminal past the wait bound

    // The SAME public call an agent makes — no seeded fixture: leg 1 settles,
    // leg 2 sends the USDt and times out polling the shift.
    const res = await startConvert(rig, { timeoutMs: 40 });
    expect(res.status).toBe("pending");
    expect(res.receivedSats).toBe(null); // mid-flight in SideShift custody — never "delivered"
    expect(res.txids).toEqual(["fake_txid", "usdt_send_txid"]);
    expect(res.nextStep).toMatch(/recover|getPending/i);
    expect(rig.sendUsdtCalls).toHaveLength(1); // the USDt send happened exactly once

    // GENUINE in-flight state on disk, written by that same convert() call.
    const store = await planStoreOf(dataDir);
    const { records } = await store.readAll();
    expect(records).toHaveLength(1);
    const plan = records[0]!;
    expect(plan.state).toBe("pending");
    expect(plan.currentLegIndex).toBe(1);
    expect(plan.legResults[0]).toMatchObject({ state: "settled", receivedSats: SWAP_RECV_USDT_SATS });
    expect(plan.legResults[1]).toMatchObject({ state: "pending", trackingId: "SHIFT_MH1" });
    const pendingView = await wallet.getPending();
    expect(pendingView.filter((i) => i.rail === "plan")).toEqual([
      expect.objectContaining({ id: plan.planId, routeId: ROUTE_DEPIX_SIDESHIFT, hops: 2, currentLeg: 2 })
    ]);

    // The shift settles at the provider; recover() on the SAME wallet probes it
    // to terminal and closes the plan — it must NOT re-broadcast anything.
    rig.rest.state.shiftStatus = "settled";
    const summary = await wallet.recover();
    expect(summary.plans).toMatchObject({ checked: 1, completed: 1, needsReview: 0, discarded: 0, failed: 0 });
    expect(rig.sendUsdtCalls).toHaveLength(1); // STILL once — probed, never re-executed
    expect(rig.client.takerSignCalls).toHaveLength(1); // the swap leg was never re-run either
    expect(await store.count()).toBe(0);
    expect((await wallet.getPending()).filter((i) => i.rail === "plan")).toHaveLength(0);

    // recover() completed the plan WITHOUT re-counting anything: still only
    // leg 1's R$1 in the rolling window.
    expect((await wallet.getGuardrails()).usedCents).toBe(100);
  });
});
