// SideSwap market orchestration (spec §5.1) with a fake client + fake hooks:
// the guardrail counts the SENT side in BRL BEFORE signing, the swap is exempt
// from the allowlist (protocolBound — funds return to us), a fail-closed
// validation aborts WITHOUT recording or broadcasting, and transient blinding
// errors are ignored while quoting.
import { describe, expect, it, beforeEach } from "vitest";
import type { Wollet } from "lwk_node";
import { ASSETS, type AssetKey } from "../src/assets.js";
import { ConversionError, GuardrailError, SideSwapError, isDepixSdkError } from "../src/errors.js";
import { liquidScriptHex } from "../src/guardrails/allowlist.js";
import type { ConvertWalletHooks } from "../src/convert/hooks.js";
import type { GuardrailIntent } from "../src/guardrails/guardrails.js";
import {
  SideSwapMarket,
  SS_ERROR,
  type SwapPsetInspection
} from "../src/convert/sideswap.js";
import { FakeSideSwapClient } from "./support/sideswap-mock.js";
import { fakeClock } from "./support/mock.js";

// A real mainnet confidential address (golden addr[1]) so liquidScriptHex works.
const RECEIVE_ADDRESS =
  "lq1qqfk0uw9vlmqlggzs7cxmw49x8ks37l87udspmpt3ssgxjrkqqlww63xvus3c5gaz89r2kd393c4fvurwxf06qj87y2kd3vsln";
const EXPECTED_SCRIPT = liquidScriptHex(RECEIVE_ADDRESS);
const DEPIX = ASSETS.DEPIX.id;
const LBTC = ASSETS.LBTC.id;

/** A fake WalletTxOut collectSwapUtxos can read. */
function fakeUtxo(assetId: string, value: number, height: number | undefined) {
  return {
    outpoint: () => ({ txid: () => ({ toString: () => "aa".repeat(32) }), vout: () => 0 }),
    unblinded: () => ({
      asset: () => ({ toString: () => assetId }),
      assetBlindingFactor: () => ({ toString: () => "abf" }),
      value: () => value,
      valueBlindingFactor: () => ({ toString: () => "vbf" })
    }),
    height: () => height
  };
}
const fakeWollet = { utxos: () => [fakeUtxo(DEPIX, 1_000_000, 100)] } as unknown as Wollet;

interface Spies {
  valuate: Array<[AssetKey, bigint]>;
  enforce: GuardrailIntent[];
  record: Array<[number, string]>;
}

function makeHooks(over: Partial<ConvertWalletHooks> & { clockNow?: () => number } = {}): {
  hooks: ConvertWalletHooks;
  spies: Spies;
} {
  const spies: Spies = { valuate: [], enforce: [], record: [] };
  const hooks: ConvertWalletHooks = {
    dataDir: "/tmp/none",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ensureWollet: async () => fakeWollet,
    getReceiveAddress: async () => RECEIVE_ADDRESS,
    decryptMnemonic: async () => {
      throw new Error("decryptMnemonic should not run — signForeignPset is faked");
    },
    valuate: async (asset, sats) => {
      spies.valuate.push([asset, sats]);
      return 5_000; // R$ 50 default
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
    now: over.clockNow ?? (() => 0),
    ...over
  };
  return { hooks, spies };
}

const goodInspection: SwapPsetInspection = {
  outputScriptsHex: [EXPECTED_SCRIPT],
  netBalances: new Map([[LBTC, 5n]])
};
const okSigner = async (_p: string, validate: (i: SwapPsetInspection) => void): Promise<string> => {
  validate(goodInspection);
  return "SIGNED_PSET_B64";
};

function makeMarket(hooks: ConvertWalletHooks, client: FakeSideSwapClient, signer = okSigner, now = () => 0) {
  return new SideSwapMarket({ hooks, clientFactory: () => client, signForeignPset: signer, now });
}

async function openStreamWithQuote(
  market: SideSwapMarket,
  client: FakeSideSwapClient,
  recvAmount = 5n,
  ttlMs = 30_000
) {
  const stream = await market.quote({ from: "DEPIX", to: "LBTC", amountSats: 1000n });
  client.emitQuote({
    quoteId: "Q1",
    sendAmount: 1000n,
    recvAmount,
    serverFee: 1n,
    fixedFee: 0n,
    feeAsset: null,
    ttlMs,
    sendAsset: DEPIX,
    recvAsset: LBTC
  });
  const quote = await stream.next();
  return { stream, quote };
}

describe("execute() — guardrail counts the SENT side BEFORE signing (§4.3)", () => {
  let client: FakeSideSwapClient;
  beforeEach(() => {
    client = new FakeSideSwapClient();
  });

  it("valuates and enforces the SENT amount, exempt from the allowlist (protocolBound), then records + taker_signs", async () => {
    const { hooks, spies } = makeHooks();
    const market = makeMarket(hooks, client);
    const { stream, quote } = await openStreamWithQuote(market, client);

    const res = await stream.execute(quote);

    // Guardrail counted the SENT side (from asset, quote.sendAmount).
    expect(spies.valuate).toEqual([["DEPIX", 1000n]]);
    expect(spies.enforce).toHaveLength(1);
    const intent = spies.enforce[0]!;
    expect(intent.kind).toBe("sideswap-swap");
    expect(intent.brlCents).toBe(5_000);
    // EXEMPT from the allowlist — the only destination is protocolBound.
    expect(intent.destinations).toEqual([expect.objectContaining({ kind: "protocolBound" })]);
    // Accounted the SENT side, then taker_sign (SideSwap broadcasts).
    expect(spies.record).toEqual([[5_000, "sideswap-swap"]]);
    expect(client.getQuoteCalls).toEqual(["Q1"]);
    expect(client.takerSignCalls).toEqual([{ quoteId: "Q1", signedPset: "SIGNED_PSET_B64" }]);
    expect(res.txid).toBe("fake_txid");
    expect(res.brlCents).toBe(5_000);
    stream.close();
  });

  it("blocks over the per-tx cap: no get_quote, no signing, no record", async () => {
    const { hooks, spies } = makeHooks({
      valuate: async () => 10_001,
      enforceGuardrails: async (intent) => {
        if (intent.brlCents > 10_000) {
          throw new GuardrailError("GUARDRAIL_PER_TX_LIMIT", "over cap");
        }
      }
    });
    const market = makeMarket(hooks, client);
    const { stream, quote } = await openStreamWithQuote(market, client);

    await expect(stream.execute(quote)).rejects.toSatisfy((e) => isDepixSdkError(e, "GUARDRAIL_PER_TX_LIMIT"));
    expect(client.getQuoteCalls).toHaveLength(0);
    expect(client.takerSignCalls).toHaveLength(0);
    expect(spies.record).toHaveLength(0);
    stream.close();
  });
});

describe("execute() — fail-closed validation aborts before recording/broadcasting (§5.1/G3)", () => {
  it("a null-inspection validate throw (SWAP_VALIDATION_FAILED) stops the swap: no record, no taker_sign", async () => {
    const client = new FakeSideSwapClient();
    const failClosedSigner = async (_p: string, validate: (i: SwapPsetInspection) => void): Promise<string> => {
      // Primary passes (script present) but the net-balance inspection is null →
      // the SDK's fail-closed check (G3) aborts inside validate.
      validate({ outputScriptsHex: [EXPECTED_SCRIPT], netBalances: null });
      return "NEVER";
    };
    const { hooks, spies } = makeHooks();
    const market = makeMarket(hooks, client, failClosedSigner);
    const { stream, quote } = await openStreamWithQuote(market, client);

    await expect(stream.execute(quote)).rejects.toSatisfy((e) => isDepixSdkError(e, "SWAP_VALIDATION_FAILED"));
    // get_quote ran, but nothing was accounted and taker_sign never fired.
    expect(client.getQuoteCalls).toEqual(["Q1"]);
    expect(spies.record).toHaveLength(0);
    expect(client.takerSignCalls).toHaveLength(0);
    stream.close();
  });
});

describe("execute() — quote TTL guard (§5.1)", () => {
  it("refuses a (nearly) expired quote with SWAP_QUOTE_EXPIRED — no get_quote", async () => {
    const clock = fakeClock(1_000_000);
    const client = new FakeSideSwapClient();
    const { hooks } = makeHooks({ clockNow: clock.now });
    const market = makeMarket(hooks, client, okSigner, clock.now);
    // ttl 1s → within QUOTE_MIN_REMAINING (3s) of expiry immediately.
    const { stream, quote } = await openStreamWithQuote(market, client, 5n, 1_000);

    await expect(stream.execute(quote)).rejects.toSatisfy((e) => isDepixSdkError(e, "SWAP_QUOTE_EXPIRED"));
    expect(client.getQuoteCalls).toHaveLength(0);
    stream.close();
  });

  it("rejects a foreign quote object not issued by the stream", async () => {
    const client = new FakeSideSwapClient();
    const { hooks } = makeHooks();
    const market = makeMarket(hooks, client);
    const { stream } = await openStreamWithQuote(market, client);
    const foreign = { ...(await Promise.resolve({})) } as never;
    await expect(stream.execute(foreign)).rejects.toBeInstanceOf(ConversionError);
    stream.close();
  });
});

describe("stream — transient vs terminal quote errors (§5.1)", () => {
  it("IGNORES a transient blinding error (keeps the waiter alive for the next tick)", async () => {
    const client = new FakeSideSwapClient();
    const { hooks } = makeHooks();
    const market = makeMarket(hooks, client);
    const stream = await market.quote({ from: "DEPIX", to: "LBTC", amountSats: 1000n });

    const pending = stream.next({ timeoutMs: 5_000 });
    client.emitError(new SideSwapError(SS_ERROR.SERVER_ERROR, "failed to prove surjection for output 1"));
    client.emitQuote({
      quoteId: "Q2",
      sendAmount: 1000n,
      recvAmount: 5n,
      serverFee: 0n,
      fixedFee: 0n,
      feeAsset: null,
      ttlMs: 30_000,
      sendAsset: DEPIX,
      recvAsset: LBTC
    });
    const q = await pending;
    expect(q.quoteId).toBe("Q2");
    stream.close();
  });

  it("rejects the pending next() on LowBalance, mapped to SWAP_LOW_BALANCE", async () => {
    const client = new FakeSideSwapClient();
    const { hooks } = makeHooks();
    const market = makeMarket(hooks, client);
    const stream = await market.quote({ from: "DEPIX", to: "LBTC", amountSats: 1000n });

    const pending = stream.next({ timeoutMs: 5_000 });
    client.emitError(new SideSwapError(SS_ERROR.LOW_BALANCE, "Insufficient liquidity. Available: 10 sats"));
    await expect(pending).rejects.toSatisfy((e) => isDepixSdkError(e, "SWAP_LOW_BALANCE"));
    stream.close();
  });
});
