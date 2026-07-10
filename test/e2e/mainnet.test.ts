// ─────────────────────────────────────────────────────────────────────────────
// MAINNET e2e harness (spec §8.4) — REAL FUNDS, HUMAN IN THE LOOP.
//
// This is the F3 Definition-of-Done rehearsal against production. There is no
// testnet in the stack (Eulen / SideSwap / Boltz are mainnet-only), so it moves
// tiny real amounts (~R$15 float, reusable) and needs a human to pay one Pix QR.
// It is SKIPPED by default and only runs when BOTH are set:
//
//     RUN_MAINNET_E2E=1
//     DEPIX_API_KEY=sk_live_...     (see prerequisites below)
//
// Without them the whole describe is skipped cleanly (like the sandbox/offline
// integration tests) — the normal unit/sandbox suite never touches the network.
//
// ── REAL prerequisites (corrected 2026-07-10) ────────────────────────────────
//   • An sk_live_ key. Live keys require the account to have `merchant.api_access`
//     — an ADMIN approval flag granted via /grantapi (api-keys.js:84). They do
//     NOT require account verification / deposit maturation (that is the F4
//     self-issuance path, not this human-run flow).
//   • WhatsApp verified on the OWNER account IF the global toggle
//     `whatsapp:enforcement` is ON (withdraw.js:43-52 / deposit.js:186-190) —
//     otherwise deposit AND withdraw return 403 whatsapp_verification_required.
//     The SDK cannot bypass this; the owner verifies WhatsApp in the app.
//   • ~R$15 of float: a little L-BTC on the wallet for network fees (external
//     send) plus the DePix the deposit QR brings in.
//   • The owner available to pay ONE real Pix QR when the harness prints it.
//
// ── What is deliberately NOT here (spec §8.4) ────────────────────────────────
//   The fee-evasion "negative" test (broadcasting a withdraw WITHOUT the fee
//   output B) is FORBIDDEN live: F0.9 has no dry-run, so it would really block
//   the test account. Correct fee-output assembly is proven by unit/PSET tests
//   (§8.1), never by a live experiment. This harness broadcasts nothing on its
//   own — it only signs the flows the DoD requires and always includes output B.
//
// ── Required environment when RUN_MAINNET_E2E=1 ──────────────────────────────
//   DEPIX_API_KEY                    sk_live_…
//   DEPIX_WALLET_PASSPHRASE          ≥12 chars (§2.4)
//   DEPIX_E2E_PAYER_TAX_NUMBER       CPF/CNPJ of the OWNER paying the deposit QR
//   DEPIX_E2E_PIX_KEY                destination Pix key for the withdraw
//   DEPIX_E2E_RECIPIENT_TAX_NUMBER   CPF/CNPJ of that Pix key's HOLDER
// Optional:
//   DEPIX_E2E_MNEMONIC   restore a reusable, already-funded test wallet (else a
//                        fresh wallet is created and its mnemonic is printed)
//   DEPIX_WALLET_DIR     persist the wallet dir across runs (else a temp dir)
//   DEPIX_E2E_DEPOSIT_CENTS   default 1000 (R$10; keep within R$5–20)
//   DEPIX_E2E_WITHDRAW_CENTS  default 500  (R$5)
//   DEPIX_E2E_SWAP_DEPIX_CENTS default 500 (R$5 of DePix → L-BTC)
//   DEPIX_E2E_MAX_WAIT_MS     default 1_800_000 (30 min) per human-wait step
// ─────────────────────────────────────────────────────────────────────────────

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DepixWallet } from "../../src/wallet.js";
import type { FetchLike } from "../../src/api/client.js";
import { DepixApiError, GuardrailError } from "../../src/errors.js";
import { DEPIX_SATS_PER_BRL_CENT } from "../../src/assets.js";

const RUN = process.env.RUN_MAINNET_E2E === "1";
const API_KEY = process.env.DEPIX_API_KEY ?? "";
const IS_LIVE = API_KEY.startsWith("sk_live_");
const SHOULD_RUN = RUN && IS_LIVE;

// Loud hint when someone opts in but the key isn't live — otherwise skipIf would
// swallow the run silently.
if (RUN && !IS_LIVE) {
  console.warn(
    "[mainnet-e2e] RUN_MAINNET_E2E=1 but DEPIX_API_KEY is not an sk_live_ key — skipping. " +
      "The mainnet DoD needs a live key (merchant.api_access granted via /grantapi)."
  );
}

const DEPOSIT_CENTS = Number(process.env.DEPIX_E2E_DEPOSIT_CENTS ?? "1000");
const WITHDRAW_CENTS = Number(process.env.DEPIX_E2E_WITHDRAW_CENTS ?? "500");
const SWAP_DEPIX_CENTS = Number(process.env.DEPIX_E2E_SWAP_DEPIX_CENTS ?? "500");
const MAX_WAIT_MS = Number(process.env.DEPIX_E2E_MAX_WAIT_MS ?? String(30 * 60 * 1000));
const POLL_MS = 15_000;

function log(msg: string): void {
  // Observability channel for the human running the harness. Allowed in tests.
  console.log(`[mainnet-e2e] ${msg}`);
}

function hr(title: string): void {
  log("");
  log(`──────── ${title} ────────`);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(
      `[mainnet-e2e] missing required env ${name}. See the header of this file for the full list.`
    );
  }
  return v;
}

function fmtBrl(cents: number): string {
  return `R$ ${(cents / 100).toFixed(2)}`;
}

function fmtBalances(b: Record<string, bigint>): string {
  return (["DEPIX", "LBTC", "USDT"] as const)
    .map((k) => `${k}=${(b[k] ?? 0n).toString()} sats`)
    .join("  ");
}

// A FetchLike that delegates to the global fetch but counts every DePix API
// request. The default client captures globalThis.fetch at construction
// (client.ts:209), so we inject this at open() time to OBSERVE requests — the
// guardrail-negative step asserts an over-limit send makes ZERO API calls.
let apiCallCount = 0;
const countingFetch = ((url: string, init: Parameters<FetchLike>[1]) => {
  if (typeof url === "string" && url.includes("/api/")) apiCallCount++;
  return (globalThis.fetch as unknown as FetchLike)(url, init);
}) as FetchLike;

describe.skipIf(!SHOULD_RUN)("mainnet e2e (opt-in, real funds, human in the loop)", () => {
  let wallet: DepixWallet;
  let ownedTempDir: string | null = null;
  // Shared across the sequential steps.
  let localWithdrawTxid: string | null = null;

  beforeAll(async () => {
    const passphrase = requireEnv("DEPIX_WALLET_PASSPHRASE");
    // Fail fast on the rest so a partial config doesn't die mid-flow.
    requireEnv("DEPIX_E2E_PAYER_TAX_NUMBER");
    requireEnv("DEPIX_E2E_PIX_KEY");
    requireEnv("DEPIX_E2E_RECIPIENT_TAX_NUMBER");

    const dataDir =
      process.env.DEPIX_WALLET_DIR ?? (ownedTempDir = await mkdtemp(join(tmpdir(), "depix-e2e-")));

    const mnemonic = process.env.DEPIX_E2E_MNEMONIC;
    const common = {
      dataDir,
      passphrase,
      apiKey: API_KEY,
      fetch: countingFetch
    } as const;

    hr("SETUP");
    log(`dataDir: ${dataDir}${ownedTempDir ? " (temp — set DEPIX_WALLET_DIR to persist/reuse)" : ""}`);
    if (mnemonic && mnemonic.trim().length > 0) {
      log("restoring wallet from DEPIX_E2E_MNEMONIC (born backup-confirmed).");
      wallet = await DepixWallet.restore({ ...common, mnemonic: mnemonic.trim() });
    } else {
      log("no DEPIX_E2E_MNEMONIC — creating a FRESH wallet (mnemonicSecured, backup-confirmed).");
      const created = await DepixWallet.create({ ...common, mnemonicSecured: true });
      wallet = created.wallet;
      hr("SAVE THIS MNEMONIC (reuse via DEPIX_E2E_MNEMONIC to avoid re-funding)");
      log(created.mnemonic);
    }
    log(`descriptor: ${wallet.getDescriptor()}`);
  }, MAX_WAIT_MS);

  afterAll(async () => {
    if (wallet) await wallet.close().catch(() => {});
    if (ownedTempDir) await rm(ownedTempDir, { recursive: true, force: true }).catch(() => {});
  });

  it(
    "step 1 — funding: wallet holds L-BTC for network fees; sync sees the balance",
    async () => {
      hr("STEP 1 — FUNDING");
      const addr = await wallet.getReceiveAddress();
      log("Send a little L-BTC (network fees, e.g. ~2000–5000 sats) to this address:");
      log(`  ${addr}`);
      log("DePix will be added by the deposit() QR in step 2, but the wallet needs L-BTC to");
      log("pay Liquid network fees for the withdraw and the swap. If you reused a funded");
      log("wallet this passes immediately.");

      const deadline = Date.now() + MAX_WAIT_MS;
      for (;;) {
        await wallet.sync();
        const { balances } = await wallet.getBalances();
        const lbtc = balances.LBTC ?? 0n;
        log(`sync: ${fmtBalances(balances)}`);
        if (lbtc > 0n) {
          expect(lbtc).toBeGreaterThan(0n);
          log(`L-BTC present (${lbtc} sats) — proceeding.`);
          return;
        }
        if (Date.now() > deadline) {
          throw new Error("timed out waiting for L-BTC funding — send some L-BTC and re-run.");
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    },
    MAX_WAIT_MS
  );

  it(
    "step 2 — deposit(): owner pays the QR → depix_sent → DePix balance rises",
    async () => {
      hr("STEP 2 — DEPOSIT (on-ramp)");
      const payerTaxNumber = requireEnv("DEPIX_E2E_PAYER_TAX_NUMBER");
      const before = (await wallet.getBalances()).balances.DEPIX ?? 0n;

      log(`creating a ${fmtBrl(DEPOSIT_CENTS)} deposit…`);
      const dep = await wallet.deposit({ amountCents: DEPOSIT_CENTS, payerTaxNumber });
      log(`deposit id: ${dep.id}`);
      hr("PAY THIS PIX QR (copy-and-paste) — the OWNER pays it now");
      log(dep.qrCopyPaste);

      log("polling deposit status until depix_sent (pay the QR above)…");
      const status = await wallet.waitForDeposit(dep.id, {
        intervalMs: POLL_MS,
        timeoutMs: MAX_WAIT_MS
      });
      log(`terminal deposit status: ${status.status}`);
      expect(status.status).toBe("depix_sent");

      // The DePix lands on-chain; a sync should see the balance rise.
      const deadline = Date.now() + 5 * 60 * 1000;
      for (;;) {
        await wallet.sync();
        const after = (await wallet.getBalances()).balances.DEPIX ?? 0n;
        log(`sync: DEPIX=${after} sats (was ${before})`);
        if (after > before) {
          expect(after).toBeGreaterThan(before);
          log("DePix received on the agent wallet.");
          return;
        }
        if (Date.now() > deadline) throw new Error("depix_sent but DePix balance did not rise in time.");
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    },
    MAX_WAIT_MS
  );

  it(
    "step 3 — withdraw() R$5 (send): 2-output tx → sent → liquid_txid == local txid, account not blocked",
    async () => {
      hr("STEP 3 — WITHDRAW (off-ramp)");
      const pixKey = requireEnv("DEPIX_E2E_PIX_KEY");
      const recipientTaxNumber = requireEnv("DEPIX_E2E_RECIPIENT_TAX_NUMBER");

      log(`withdrawing ${fmtBrl(WITHDRAW_CENTS)} (mode "send") to pixKey ${pixKey}…`);
      const res = await wallet.withdraw({
        pixKey,
        recipientTaxNumber,
        amountCents: WITHDRAW_CENTS,
        mode: "send"
      });
      localWithdrawTxid = res.txid;
      log(
        `withdrawalId=${res.withdrawalId} txid=${res.txid} ` +
          `net=${fmtBrl(res.netCents)} gross=${fmtBrl(res.grossCents)} payout=${fmtBrl(res.payoutCents)} ` +
          `fee=${res.feeCents === null ? "none" : fmtBrl(res.feeCents)} feeAddress=${res.feeAddress ?? "none"}`
      );
      expect(res.txid).toBeTruthy();
      // The signed tx MUST carry the explicit fee output B when a fee was quoted
      // (§3.2) — the SDK aborts before signing otherwise, so reaching here proves
      // it. If the fee branch was active, feeAddress is the explicit ex1 form.
      if (res.feeCents !== null) {
        expect(res.feeAddress).toBeTruthy();
        expect(res.netCents + res.feeCents).toBe(res.grossCents);
      }

      log("polling withdrawal status until sent…");
      const status = await wallet.waitForWithdrawal(res.withdrawalId, {
        intervalMs: POLL_MS,
        timeoutMs: MAX_WAIT_MS
      });
      log(`terminal withdrawal status: ${status.status} liquid_txid=${status.liquid_txid ?? "—"}`);
      expect(status.status).toBe("sent");
      // The wire liquid_txid must equal the txid we broadcast locally (§8.4.3).
      expect(status.liquid_txid).toBe(localWithdrawTxid);

      // Account-not-blocked probe (§8.4.3): the F0.9 cron (~1 min) verifies the
      // fee output on-chain; if it were missing it would block the account. Give
      // it a grace window, then confirm the account can still transact — a fresh
      // deposit() would throw account_blocked on a blocked account. No money
      // moves (the QR is left unpaid). velocity/limit errors are NOT blocks.
      hr("STEP 3b — account-not-blocked probe (F0.9)");
      log("waiting ~90s for the F0.9 fee-verification cron, then probing…");
      await new Promise((r) => setTimeout(r, 90_000));
      const payerTaxNumber = requireEnv("DEPIX_E2E_PAYER_TAX_NUMBER");
      try {
        const probe = await wallet.deposit({ amountCents: 500, payerTaxNumber });
        log(`probe deposit ok (id=${probe.id}) — account NOT blocked. Leave this QR unpaid.`);
      } catch (err) {
        if (err instanceof DepixApiError && err.code === "account_blocked") {
          throw new Error(
            "ACCOUNT BLOCKED after the withdraw — F0.9 read the fee output as unpaid. " +
              "Investigate the signed tx's output B.",
            { cause: err }
          );
        }
        log(`probe deposit non-block error (${(err as Error)?.message}) — not a block; continuing.`);
      }
      log("Also confirm no Telegram fee_evasion / block alert fired for this account.");
    },
    MAX_WAIT_MS
  );

  it(
    "step 4 — swap DePix → L-BTC (SideSwap market, non-custodial)",
    async () => {
      hr("STEP 4 — SWAP DePix → L-BTC");
      const amountSats = BigInt(SWAP_DEPIX_CENTS) * DEPIX_SATS_PER_BRL_CENT;
      log(`opening a SideSwap quote stream for ${fmtBrl(SWAP_DEPIX_CENTS)} of DePix → L-BTC…`);
      const stream = await wallet.convert.sideswap.quote({
        from: "DEPIX",
        to: "LBTC",
        amountSats
      });
      try {
        const quote = await stream.next();
        log(
          `quote: send=${quote.sendAmountSats} DePix-sats  recv=${quote.recvAmountSats} L-BTC-sats  ` +
            `serverFee=${quote.serverFeeSats}  ttl=${quote.ttlMs}ms`
        );
        const result = await stream.execute(quote);
        log(`swap broadcast: txid=${result.txid} recv=${result.recvAmountSats} L-BTC-sats`);
        expect(result.txid).toBeTruthy();
        expect(result.to).toBe("LBTC");
      } finally {
        stream.close();
      }
      await wallet.sync();
      log(`post-swap: ${fmtBalances((await wallet.getBalances()).balances)}`);
    },
    MAX_WAIT_MS
  );

  it(
    "step 5 — guardrail negative: an over-limit send is blocked BEFORE any request",
    async () => {
      hr("STEP 5 — GUARDRAIL (negative)");
      const gr = await wallet.getGuardrails();
      // R$1 over the per-tx ceiling — DePix values 1:1 with no /api/quotes call,
      // and send() enforces the guardrail BEFORE valuation-network and BEFORE any
      // broadcast, so an over-limit send makes ZERO API requests. (withdraw()
      // enforces the same ceiling but on the server-quoted GROSS, i.e. AFTER the
      // authenticated POST per §3.2.4 — send() is the vehicle that proves the
      // pre-network block the DoD asks for.)
      const overCents = gr.perTxLimitCents + 100;
      const amountSats = BigInt(overCents) * DEPIX_SATS_PER_BRL_CENT;
      const dest = await wallet.getReceiveAddress();
      log(
        `per-tx limit is ${fmtBrl(gr.perTxLimitCents)}; attempting to send ${fmtBrl(overCents)} of DePix ` +
          `(expected to be blocked, no funds move)…`
      );

      const callsBefore = apiCallCount;
      let thrown: unknown;
      try {
        await wallet.send({ asset: "DEPIX", amountSats, address: dest });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(GuardrailError);
      expect((thrown as GuardrailError).code).toBe("GUARDRAIL_PER_TX_LIMIT");
      // The honest "SEM request" assertion: no DePix API call happened.
      expect(apiCallCount).toBe(callsBefore);
      log(`blocked with GUARDRAIL_PER_TX_LIMIT and ZERO API requests (${callsBefore} → ${apiCallCount}).`);
      hr("DoD COMPLETE — fund → deposit → withdraw (fee verified) → swap → guardrail");
    },
    MAX_WAIT_MS
  );
});
