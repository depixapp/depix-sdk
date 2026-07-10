// wallet.convert()/wallet.quote() wired through the REAL DepixWallet (PR-B):
// the callable facade coexists with the advanced sub-namespaces, and a
// single-hop convert() goes through the SAME guardrail choke point (§4.3) as
// the provider methods it delegates to — the intent layer adds no signing
// path of its own. Offline: guardrails reject before any WebSocket, and
// estimates fail soft (null) on an empty wallet.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DepixWallet } from "../src/wallet.js";
import type { QuotesSource } from "../src/guardrails/quotes.js";
import { isDepixSdkError } from "../src/errors.js";
import { FakeSideSwapClient } from "./support/sideswap-mock.js";

const PASSPHRASE = "correct-horse-battery-staple";
const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const QUOTES: QuotesSource = { get: async () => ({ btcUsd: 100_000, usdBrl: 5 }) };
const BTC_DEST = "bc1qdestination000000000000000000000000000";

let dataDir: string;
let wallet: DepixWallet;

async function open(opts: Parameters<typeof DepixWallet.restore>[0]) {
  return DepixWallet.restore(opts);
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-intent-"));
});
afterEach(async () => {
  await wallet?.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
});

describe("wallet.convert is callable AND keeps the advanced sub-namespaces", () => {
  it("exposes convert() as a function with .sideswap/.sideshift/.boltz intact, plus wallet.quote()", async () => {
    wallet = await open({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC, quotes: QUOTES });
    expect(typeof wallet.convert).toBe("function");
    expect(typeof wallet.convert.sideswap.quote).toBe("function");
    expect(typeof wallet.convert.sideswap.pegOut).toBe("function");
    expect(typeof wallet.convert.sideshift.send).toBe("function");
    expect(typeof wallet.convert.boltz.payLightningInvoice).toBe("function");
    expect(typeof wallet.quote).toBe("function");
  });
});

describe("wallet.convert() respects the guardrail choke point (§4.3) — never bypassed", () => {
  it("a peg-out route is blocked by the allowlist BEFORE any WebSocket", async () => {
    const client = new FakeSideSwapClient();
    wallet = await open({
      dataDir,
      passphrase: PASSPHRASE,
      mnemonic: KNOWN_MNEMONIC,
      quotes: QUOTES,
      guardrails: { allowlist: { enabled: true, btcAddresses: [] } },
      convert: { clientFactory: () => client }
    });
    await expect(
      wallet.convert({ from: "LBTC", to: "BTC", network: "bitcoin", amount: 10_000n, address: BTC_DEST })
    ).rejects.toSatisfy(
      (e) =>
        isDepixSdkError(e, "GUARDRAIL_ALLOWLIST_BLOCKED") &&
        (e as { details?: { class?: string } }).details?.class === "btcAddress"
    );
    expect(client.pegOutCalls).toHaveLength(0);
    expect(client.connectCount).toBe(0);
  });

  it("a peg-out route over the per-tx BRL ceiling is blocked BEFORE any WebSocket", async () => {
    const client = new FakeSideSwapClient();
    wallet = await open({
      dataDir,
      passphrase: PASSPHRASE,
      mnemonic: KNOWN_MNEMONIC,
      quotes: QUOTES,
      convert: { clientFactory: () => client }
    });
    // 0.1 BTC × $100k × R$5 = R$50_000 — far over the default per-tx cap.
    await expect(
      wallet.convert({ from: "LBTC", to: "BTC", network: "bitcoin", amount: 10_000_000n, address: BTC_DEST })
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "GUARDRAIL_PER_TX_LIMIT"));
    expect(client.connectCount).toBe(0);
  });
});

describe("wallet.quote() — full enumeration on a real wallet", () => {
  it("DEPIX → USDT @ethereum returns both candidate routes; estimates fail SOFT on an empty wallet", async () => {
    const client = new FakeSideSwapClient();
    wallet = await open({
      dataDir,
      passphrase: PASSPHRASE,
      mnemonic: KNOWN_MNEMONIC,
      quotes: QUOTES,
      convert: { clientFactory: () => client }
    });
    const routes = await wallet.quote({ from: "DEPIX", to: "USDT", network: "ethereum", amount: 100_000_000n });
    expect(routes.map((r) => r.id)).toEqual([
      "sideswap.swap:DEPIX@liquid>LBTC@liquid+boltz.toStablecoin:LBTC@liquid>USDT@ethereum",
      "sideswap.swap:DEPIX@liquid>USDT@liquid+sideshift.send:USDT@liquid>USDT@ethereum"
    ]);
    expect(routes[0]!.custodial).toBe(false);
    expect(routes[1]!.custodial).toBe(true);
    // Empty wallet → the market leg cannot be estimated (INSUFFICIENT_FUNDS is
    // caught) → estimates are null and flagged, but enumeration still works.
    for (const route of routes) {
      expect(route.estimatedReceivedSats).toBe(null);
      expect(route.estimateComplete).toBe(false);
      expect(route.notes.length).toBeGreaterThan(0);
    }
    // The failed estimate never opened a socket (the UTXO check fails first).
    expect(client.connectCount).toBe(0);
  });

  it("wallet.convert() on an ambiguous intent throws MULTIPLE_ROUTES_AVAILABLE with the candidates", async () => {
    wallet = await open({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC, quotes: QUOTES });
    await expect(
      wallet.convert({ from: "DEPIX", to: "USDT", network: "ethereum", amount: 100_000_000n })
    ).rejects.toSatisfy((e) => {
      if (!isDepixSdkError(e, "MULTIPLE_ROUTES_AVAILABLE")) return false;
      const details = (e as { details?: { routes?: unknown[]; nextStep?: string } }).details;
      return Array.isArray(details?.routes) && details.routes.length === 2 && typeof details.nextStep === "string";
    });
  });
});
