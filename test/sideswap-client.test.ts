// SideSwap WS JSON-RPC client (spec §5.1) — protocol fidelity against a mocked
// WebSocket. Shapes mirror sideswap.js verbatim: start_quotes → quote
// (Success/LowBalance/Error) → get_quote → taker_sign, plus peg RPCs and the
// transient "failed to prove surjection" classification.
import { describe, expect, it } from "vitest";
import { ASSETS } from "../src/assets.js";
import {
  createSideSwapClient,
  isTransientBlindingError,
  SS_ERROR,
  type SideSwapQuoteEvent
} from "../src/convert/sideswap-client.js";
import { makeFakeWebSocket } from "./support/sideswap-mock.js";
import { isDepixSdkError } from "../src/errors.js";

const DEPIX = ASSETS.DEPIX.id;
const LBTC = ASSETS.LBTC.id;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A server that answers the standard RPCs. */
function scriptedServer() {
  return makeFakeWebSocket((msg, ws) => {
    const p = (msg.params ?? {}) as Record<string, unknown>;
    if (p.start_quotes) ws.respond(msg.id, { start_quotes: { quote_sub_id: 42, fee_asset: "FEEASSET" } });
    else if (p.get_quote) ws.respond(msg.id, { get_quote: { pset: "PSET_B64", ttl: 30_000 } });
    else if (p.taker_sign) ws.respond(msg.id, { taker_sign: { txid: "TX_BROADCAST_123" } });
    else if (p.stop_quotes) ws.respond(msg.id, {});
    else if ("peg_in" in p && p.peg_in === true) ws.respond(msg.id, { order_id: "in_1", peg_addr: "bc1qfundme", expires_at: 111 });
    else if ("peg_in" in p && p.peg_in === false) ws.respond(msg.id, { order_id: "out_1", peg_addr: "lq1qpegdeposit", recv_amount: 990 });
    else ws.respond(msg.id, {});
  });
}

const PRESET_MARKETS = [{ asset_pair: { base: DEPIX, quote: LBTC }, type: "Token" }];

async function connectedClient() {
  const { WebSocketImpl, instances } = scriptedServer();
  const client = createSideSwapClient({ WebSocketImpl, presetMarkets: PRESET_MARKETS });
  await client.connect();
  return { client, instances };
}

describe("SideSwap client — quote stream (§5.1)", () => {
  it("parses a Success quote (Sell/Base): base=send, quote=recv, fees + ttl", async () => {
    const { client, instances } = await connectedClient();
    const quotes: SideSwapQuoteEvent[] = [];
    client.startQuotes({
      sendAsset: DEPIX,
      recvAsset: LBTC,
      sendAmountSats: 1000,
      utxos: [],
      receiveAddress: "rcv",
      changeAddress: "chg",
      onQuote: (q) => quotes.push(q)
    });
    await flush(); // start_quotes RPC resolves → quote_sub_id bound
    instances[0]!.notify("market", {
      quote: {
        quote_sub_id: 42,
        status: {
          Success: { quote_id: "Q1", base_amount: 1000, quote_amount: 5, server_fee: 2, fixed_fee: 1, ttl: 25_000 }
        }
      }
    });
    expect(quotes).toHaveLength(1);
    const q = quotes[0]!;
    expect(q.quoteId).toBe("Q1");
    expect(q.sendAmount).toBe(1000n); // base
    expect(q.recvAmount).toBe(5n); // quote
    expect(q.serverFee).toBe(2n);
    expect(q.fixedFee).toBe(1n);
    expect(q.feeAsset).toBe("FEEASSET");
    expect(q.ttlMs).toBe(25_000);
    client.disconnect();
  });

  it("ignores a quote whose quote_sub_id does not match the bound subscription", async () => {
    const { client, instances } = await connectedClient();
    const quotes: SideSwapQuoteEvent[] = [];
    client.startQuotes({
      sendAsset: DEPIX,
      recvAsset: LBTC,
      sendAmountSats: 1000,
      utxos: [],
      receiveAddress: "rcv",
      changeAddress: "chg",
      onQuote: (q) => quotes.push(q)
    });
    await flush();
    instances[0]!.notify("market", {
      quote: { quote_sub_id: 999, status: { Success: { quote_id: "SPOOF", base_amount: 1, quote_amount: 1 } } }
    });
    expect(quotes).toHaveLength(0);
    client.disconnect();
  });

  it("surfaces LowBalance as SS_ERROR.LOW_BALANCE", async () => {
    const { client, instances } = await connectedClient();
    const errors: unknown[] = [];
    client.startQuotes({
      sendAsset: DEPIX,
      recvAsset: LBTC,
      sendAmountSats: 1000,
      utxos: [],
      receiveAddress: "rcv",
      changeAddress: "chg",
      onError: (e) => errors.push(e)
    });
    await flush();
    instances[0]!.notify("market", { quote: { quote_sub_id: 42, status: { LowBalance: { available: 500 } } } });
    expect(errors).toHaveLength(1);
    expect((errors[0] as { code: string }).code).toBe(SS_ERROR.LOW_BALANCE);
    client.disconnect();
  });

  it("classifies 'failed to prove surjection' as transient, but not a sibling error", async () => {
    const { client, instances } = await connectedClient();
    const errors: unknown[] = [];
    client.startQuotes({
      sendAsset: DEPIX,
      recvAsset: LBTC,
      sendAmountSats: 1000,
      utxos: [],
      receiveAddress: "rcv",
      changeAddress: "chg",
      onError: (e) => errors.push(e)
    });
    await flush();
    instances[0]!.notify("market", {
      quote: { quote_sub_id: 42, status: { Error: { error_msg: "failed to prove surjection for output 0" } } }
    });
    instances[0]!.notify("market", {
      quote: { quote_sub_id: 42, status: { Error: { error_msg: "too many tx inputs" } } }
    });
    expect(errors).toHaveLength(2);
    expect(isTransientBlindingError(errors[0])).toBe(true);
    expect(isTransientBlindingError(errors[1])).toBe(false); // deterministic sibling — must keep surfacing
    client.disconnect();
  });
});

describe("SideSwap client — get_quote / taker_sign / peg (§5.1-5.2)", () => {
  it("get_quote returns the PSET + ttl", async () => {
    const { client } = await connectedClient();
    const res = await client.getQuote("Q1");
    expect(res.pset).toBe("PSET_B64");
    expect(res.ttlMs).toBe(30_000);
    client.disconnect();
  });

  it("taker_sign returns the broadcast txid", async () => {
    const { client } = await connectedClient();
    const res = await client.takerSign({ quoteId: "Q1", signedPset: "SIGNED" });
    expect(res.txid).toBe("TX_BROADCAST_123");
    client.disconnect();
  });

  it("get_quote rejects (INVALID_RESPONSE) when the server omits the PSET", async () => {
    const { WebSocketImpl } = makeFakeWebSocket((msg, ws) => ws.respond(msg.id, { get_quote: {} }));
    const client = createSideSwapClient({ WebSocketImpl, presetMarkets: PRESET_MARKETS });
    await client.connect();
    await expect(client.getQuote("Q1")).rejects.toSatisfy((e) => isDepixSdkError(e, SS_ERROR.INVALID_RESPONSE));
    client.disconnect();
  });

  it("pegIn / pegOut return the peg address + order id", async () => {
    const { client } = await connectedClient();
    const pin = await client.pegIn({ recvAddr: "lq1qmine" });
    expect(pin).toMatchObject({ orderId: "in_1", pegAddr: "bc1qfundme" });
    const pout = await client.pegOut({ recvAddr: "bc1qdest", blocks: 6 });
    expect(pout).toMatchObject({ orderId: "out_1", pegAddr: "lq1qpegdeposit", recvAmount: 990 });
    client.disconnect();
  });

  it("a server error to an RPC rejects with SS_ERROR.SERVER_ERROR", async () => {
    const { WebSocketImpl } = makeFakeWebSocket((msg, ws) => ws.respondError(msg.id, "boom"));
    const client = createSideSwapClient({ WebSocketImpl, presetMarkets: PRESET_MARKETS });
    await client.connect();
    await expect(client.getQuote("Q1")).rejects.toSatisfy((e) => isDepixSdkError(e, SS_ERROR.SERVER_ERROR));
    client.disconnect();
  });
});

// Opt-in live check against the real SideSwap WS — connect + market list only.
// NEVER signs or broadcasts. Skipped unless RUN_SIDESWAP_INTEGRATION=1 (so it
// never runs in CI or under DEPIX_SDK_OFFLINE=1). Uses the Node global WebSocket.
describe.skipIf(process.env.RUN_SIDESWAP_INTEGRATION !== "1")("SideSwap live (opt-in, read-only)", () => {
  it("connects and loads the market list (no signing)", async () => {
    const client = createSideSwapClient({});
    await client.connect();
    const deadline = Date.now() + 8_000;
    while (!client.hasMarkets() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(client.hasMarkets()).toBe(true);
    client.disconnect();
  });
});
