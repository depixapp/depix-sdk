// The Boltz submarine REUSE seam for gift cards (spec §5.5). payLightningInvoice
// is extended with optional extraDestinations / feeSplit / spendKind so the
// gift-card flow reuses the ENTIRE submarine machinery (prepare → verify-lockup →
// guardrail choke point → lockup → refund/watch) instead of duplicating it. This
// unit test spies the wallet's lockupLbtc seam to assert the gift-card call
// forwards BOTH allowlist destination classes + the 1% fee output + the spend
// kind — and that a plain LN send still forwards none of them (backward compat).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoltzConvert, type BoltzWalletContext } from "../src/convert/boltz/convert.js";
import type { BoltzClient } from "../src/convert/boltz/client.js";
import { BoltzSwapStore } from "../src/convert/boltz/store.js";
import type { Logger } from "../src/logger.js";
import { TEST_INVOICE } from "./support/boltz.js";

const SILENT: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const SALT_B64 = Buffer.from(new Uint8Array(16).fill(7)).toString("base64");
const LOCKUP_ADDRESS =
  "lq1qqfk0uw9vlmqlggzs7cxmw49x8ks37l87udspmpt3ssgxjrkqqlww63xvus3c5gaz89r2kd393c4fvurwxf06qj87y2kd3vsln";
const EMAIL = "agent@example.com";

function fakeClient(): BoltzClient {
  return {
    getSubmarinePairHash: async () => "pair-hash",
    createSubmarineSwap: async () => ({
      id: "sub-1",
      address: LOCKUP_ADDRESS,
      expectedAmount: 10_000,
      swapTree: { claimLeaf: {}, refundLeaf: {} },
      claimPublicKey: "03" + "cc".repeat(32),
      blindingKey: "dd".repeat(32),
      timeoutBlockHeight: 1_000_100
    }),
    getChainHeight: async () => 1_000_000,
    getSwapStatus: async () => ({ status: "swap.created" }),
    subscribeSwap: () => () => {}
  } as unknown as BoltzClient;
}

let dataDir: string;
let convert: BoltzConvert;

afterEach(async () => {
  convert?.dispose();
  await rm(dataDir, { recursive: true, force: true });
});

async function convertWithSpyLockup(): Promise<{
  convert: BoltzConvert;
  lockupLbtc: ReturnType<typeof vi.fn>;
}> {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-gc-reuse-"));
  const store = new BoltzSwapStore({ dataDir, passphrase: "correct-horse-battery-staple", saltB64: SALT_B64 });
  const lockupLbtc = vi.fn(async () => ({ txid: "lock-txid" }));
  const ctx: BoltzWalletContext = {
    store,
    logger: SILENT,
    lockupLbtc: lockupLbtc as unknown as BoltzWalletContext["lockupLbtc"],
    getReceiveAddress: async () => LOCKUP_ADDRESS
  };
  convert = new BoltzConvert(ctx, { client: fakeClient(), verifyLockup: vi.fn(async () => {}) });
  return { convert, lockupLbtc };
}

describe("payLightningInvoice reuse seam (§5.5)", () => {
  it("forwards the gift-card fee split + BOTH allowlist classes + spend kind to lockupLbtc", async () => {
    const { convert: c, lockupLbtc } = await convertWithSpyLockup();
    const res = await c.payLightningInvoice({
      invoice: TEST_INVOICE,
      extraDestinations: [{ kind: "giftcardBeneficiary", beneficiary: EMAIL }],
      feeSplit: { address: LOCKUP_ADDRESS, amountSats: 2500n },
      spendKind: "giftcard"
    });
    res.completion.catch(() => {}); // watch stays pending — don't leak

    expect(res.lockupTxid).toBe("lock-txid");
    expect(lockupLbtc).toHaveBeenCalledTimes(1);
    const arg = lockupLbtc.mock.calls[0]![0] as {
      address: string;
      amountSats: bigint;
      destinations: Array<Record<string, unknown>>;
      feeSplit?: { address: string; amountSats: bigint };
      kind?: string;
    };
    expect(arg.address).toBe(LOCKUP_ADDRESS);
    expect(arg.amountSats).toBe(10_000n);
    // DUAL-CLASS: Lightning payee FIRST, then the gift-card beneficiary (§4.3).
    expect(arg.destinations).toEqual([{ kind: "lightning" }, { kind: "giftcardBeneficiary", beneficiary: EMAIL }]);
    expect(arg.feeSplit).toEqual({ address: LOCKUP_ADDRESS, amountSats: 2500n });
    expect(arg.kind).toBe("giftcard");
  });

  it("a plain LN send forwards ONLY the lightning class, no fee split, no custom kind (backward compat)", async () => {
    const { convert: c, lockupLbtc } = await convertWithSpyLockup();
    const res = await c.payLightningInvoice({ invoice: TEST_INVOICE });
    res.completion.catch(() => {});

    const arg = lockupLbtc.mock.calls[0]![0] as {
      destinations: Array<Record<string, unknown>>;
      feeSplit?: unknown;
      kind?: string;
    };
    expect(arg.destinations).toEqual([{ kind: "lightning" }]);
    expect(arg.feeSplit).toBeUndefined();
    expect(arg.kind).toBeUndefined();
  });
});
