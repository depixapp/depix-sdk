// wallet.convert.sideswap wiring through the REAL DepixWallet (spec §2.3/§5) —
// proves the hooks forward to the same choke point (§4.3), BRL valuator (§4.4)
// and op mutex the rest of the wallet uses. Offline: the guardrail rejects
// before any WebSocket, and the "allowed" path reaches the L-BTC build on an
// empty wallet (INSUFFICIENT_FUNDS) via an injected fake client.
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
// L-BTC priced so a tiny sat amount is a few reais (well within the R$100/tx cap).
const QUOTES: QuotesSource = { get: async () => ({ btcUsd: 100_000, usdBrl: 5 }) };
const BTC_DEST = "bc1qdestination000000000000000000000000000";

let dataDir: string;
let wallet: DepixWallet;

async function open(opts: Parameters<typeof DepixWallet.restore>[0]) {
  return DepixWallet.restore(opts);
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-convert-"));
});
afterEach(async () => {
  await wallet?.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
});

describe("wallet.convert.sideswap is wired to the wallet internals (§5)", () => {
  it("exposes the sideswap namespace", async () => {
    wallet = await open({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC, quotes: QUOTES });
    expect(wallet.convert).toBeDefined();
    expect(typeof wallet.convert.sideswap.quote).toBe("function");
    expect(typeof wallet.convert.sideswap.pegOut).toBe("function");
    expect(typeof wallet.convert.sideswap.pegIn).toBe("function");
  });

  it("pegOut is blocked by the allowlist when the recv_addr BTC is not listed (no WS touched)", async () => {
    wallet = await open({
      dataDir,
      passphrase: PASSPHRASE,
      mnemonic: KNOWN_MNEMONIC,
      quotes: QUOTES,
      // Allowlist ON, btcAddresses empty → any peg-out recv_addr is blocked.
      guardrails: { allowlist: { enabled: true, btcAddresses: [] } }
    });
    await expect(
      wallet.convert.sideswap.pegOut({ recvAddr: BTC_DEST, amountSats: 10_000n })
    ).rejects.toSatisfy(
      (e) => isDepixSdkError(e, "GUARDRAIL_ALLOWLIST_BLOCKED") && (e as { details?: { class?: string } }).details?.class === "btcAddress"
    );
  });

  it("pegOut passes the allowlist for a listed recv_addr and reaches the L-BTC build (INSUFFICIENT_FUNDS)", async () => {
    const client = new FakeSideSwapClient();
    wallet = await open({
      dataDir,
      passphrase: PASSPHRASE,
      mnemonic: KNOWN_MNEMONIC,
      quotes: QUOTES,
      guardrails: { allowlist: { enabled: true, btcAddresses: [BTC_DEST] } },
      convert: { clientFactory: () => client }
    });
    // Listed → allowlist passes → peg RPC → build on an empty wallet fails.
    await expect(
      wallet.convert.sideswap.pegOut({ recvAddr: BTC_DEST, amountSats: 10_000n })
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "INSUFFICIENT_FUNDS"));
    expect(client.pegOutCalls).toEqual([{ recvAddr: BTC_DEST, blocks: undefined }]);
  });

  it("quote() on an empty wallet fails with INSUFFICIENT_FUNDS before any WS", async () => {
    const client = new FakeSideSwapClient();
    wallet = await open({
      dataDir,
      passphrase: PASSPHRASE,
      mnemonic: KNOWN_MNEMONIC,
      quotes: QUOTES,
      convert: { clientFactory: () => client }
    });
    await expect(
      wallet.convert.sideswap.quote({ from: "DEPIX", to: "LBTC", amountSats: 5_000_000n })
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "INSUFFICIENT_FUNDS"));
    // Never connected — the local UTXO check fails first.
    expect(client.connectCount).toBe(0);
  });
});
