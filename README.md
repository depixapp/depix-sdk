# @depixapp/sdk

> **Agents: start here → [AGENTS.md](./AGENTS.md)** — the machine-first manifest
> (mental model, exact signatures, routing table, error catalog, guardrails,
> env vars, MCP tools). A concise link index lives in [llms.txt](./llms.txt).

Non-custodial Liquid wallet SDK for AI agents. An agent runs a full wallet in
Node — its own seed, signing locally — to **pay and receive over Pix/DePix**,
hold and convert the three Liquid assets (DePix, L-BTC, USDt), and buy gift
cards, with **client-side guardrails** blocking anything over the owner's limits.

Nothing custodial: the seed never leaves the agent's environment and the backend
never signs. There is also an optional **local MCP facade** (`depix-wallet-mcp`)
so an MCP host (Claude Desktop, Claude Code, Cursor…) can drive the same wallet.

- **Runtime:** Node **≥ 22.4** (the WebSocket-stable floor), **Linux + macOS**.
  Windows is not supported in 1.0 — use WSL.
- **Install size:** ~25 MB base (+~25 MB when the EVM stablecoin route pulls in
  `viem`); `npx` caches a single download.

```bash
npm install @depixapp/sdk
```

---

## Non-custodial by construction

- The **seed lives only in the agent's environment**, encrypted at rest
  (Argon2id → AES-256-GCM) under your passphrase. No endpoint ever receives a
  private key.
- **Every signature happens locally.** The backend quotes and settles Pix; it
  never signs a Liquid transaction.
- **Conversions are client-direct and non-custodial** (SideSwap market/peg,
  Boltz Lightning/refund) — funds move under your key. One documented route,
  cross-network USDt via a third-party shifter, **is custodial** and is labelled
  as such wherever it appears (JSDoc, MCP tool description, `custodial: true` on
  results).
- **Guardrails are the owner's, immutable at runtime.** They defend against a
  prompt-injected / hallucinating agent — not against the host itself. Whoever
  controls the process controls the passphrase env + the `0600` wallet file, and
  therefore the wallet, regardless of the tool catalog. The mitigation there is
  blast radius: fund the agent with only what it needs.

---

## Quickstart 1 — Agent wallet in 5 minutes (create → back up → open)

A wallet cannot hand out a receive address until its seed has been backed up
(so no funds can ever enter a wallet with no backup).

```ts
import { DepixWallet } from "@depixapp/sdk";

// Create a fresh 12-word wallet. In a real terminal (TTY) this runs an
// interactive backup ritual. In code/CI, pass mnemonicSecured: true to accept
// the backup consciously — the mnemonic is returned in the foreground so it is
// impossible not to receive it.
const { wallet, mnemonic } = await DepixWallet.create({
  passphrase: process.env.DEPIX_WALLET_PASSPHRASE, // ≥ 12 chars
  mnemonicSecured: true
});

// Store `mnemonic` with a human guardian (see "Fleet operators" for many
// agents). To make an explicit backup at any time:
const backup = await wallet.exportBackup(); // { kind: "mnemonic", mnemonic }
await wallet.confirmBackup();               // unlocks receive addresses

const address = await wallet.getReceiveAddress();
const { balances } = await wallet.getBalances();
await wallet.close();

// Later, reopen the same wallet dir:
const reopened = await DepixWallet.open({
  passphrase: process.env.DEPIX_WALLET_PASSPHRASE
});

// Restoring from an existing mnemonic is born backup-confirmed:
const restored = await DepixWallet.restore({
  passphrase: process.env.DEPIX_WALLET_PASSPHRASE,
  mnemonic
});
```

`open()` / `create()` / `restore()` read `DEPIX_WALLET_DIR` (default
`~/.depix-wallet`), `DEPIX_WALLET_PASSPHRASE`, `DEPIX_API_KEY` and
`DEPIX_API_BASE` from the environment when the options are omitted.

---

## Quickstart 2 — An agent that pays a Pix (deposit → owner pays QR → withdraw)

The agent has no bank account. It receives DePix (its owner pays a Pix QR into
it) and pays out to a Pix key via `withdraw()`, signing the Liquid transaction
locally.

```ts
const wallet = await DepixWallet.open({
  apiKey: process.env.DEPIX_API_KEY // sk_test_… (sandbox) or sk_live_… (prod)
});

// ── On-ramp: create a deposit QR. The OWNER (a human with a bank) pays it. ──
const dep = await wallet.deposit({
  amountCents: 1000,            // R$ 10.00 (R$ 5–3000 server-side)
  payerTaxNumber: "OWNER_CPF"   // CPF/CNPJ of whoever pays the QR
});
console.log("Ask the owner to pay:", dep.qrCopyPaste);

const paid = await wallet.waitForDeposit(dep.id, { intervalMs: 5000 });
// paid.status === "depix_sent" → the DePix is now in the wallet.

// ── Off-ramp: pay out R$ 5 to a Pix key. Signed locally with the fee output. ──
const out = await wallet.withdraw({
  pixKey: "destination@pix.key",
  recipientTaxNumber: "HOLDER_CPF", // CPF/CNPJ of the Pix key's HOLDER
  amountCents: 500,                 // R$ 5.00
  mode: "send"                      // "send" = you send X; "payout" = they receive X
});
const settled = await wallet.waitForWithdrawal(out.withdrawalId, { intervalMs: 5000 });
// settled.status === "sent", settled.liquid_txid === out.txid.
```

> **Two different people, two different documents.** `payerTaxNumber` is the
> owner paying the deposit QR; `recipientTaxNumber` is the holder of the
> destination Pix key. Never reuse one for the other.

**Rate/limit notes for the quickstart.** Creating a deposit or withdrawal is
capped at **2/min per key**; status reads at **30/min per endpoint** — the SDK
paces both for you. A live key (`sk_live_`) needs the account's
`merchant.api_access` flag (admin-granted); when WhatsApp enforcement is on, the
owner must have WhatsApp verified in the app or deposit/withdraw return
`whatsapp_verification_required`.

### Sending, converting, gift cards

```ts
await wallet.send({ asset: "LBTC", amountSats: 5000n, address: "lq1…" });

// Converting: quote every candidate route, then execute one — the PRIMARY surface.
const routes = await wallet.quote({ from: "DEPIX", to: "LBTC", network: "liquid", amount: 500_000_000n });
const result = await wallet.convert({ from: "DEPIX", to: "LBTC", network: "liquid", amount: 500_000_000n });

// Power users: the per-provider namespaces live under wallet.advanced.*
// (e.g. drive the SideSwap quote stream yourself, tick by tick).
const stream = await wallet.advanced.sideswap.quote({ from: "DEPIX", to: "LBTC", amountSats: 500_000_000n });
const quote = await stream.next();
const swap = await stream.execute(quote);
stream.close();

// Lightning, refunds and gift cards live under wallet.advanced.* / wallet.giftcards.*.
// A documented cross-network USDt route is custodial and marked custodial: true.
```

Guardrails run on **every** signature. Over the per-tx or daily ceiling, or (with
the allowlist on) to a destination that isn't allow-listed, the call throws a
`GuardrailError` (`GUARDRAIL_PER_TX_LIMIT` / `GUARDRAIL_DAILY_LIMIT` /
`GUARDRAIL_ALLOWLIST_BLOCKED`) **before anything is signed**.

---

## Quickstart 3 — Run the local MCP (`depix-wallet-mcp`)

The SDK ships a stdio MCP server so an MCP host can drive the wallet with
`wallet_*` tools. It runs **in the agent's environment** — the seed never
leaves the machine. It is configured 100% by environment (no CLI flags for
secrets), boots by `open()`-ing the wallet (never auto-creates a seed), and
speaks JSON-RPC on **stdout** while every log line goes to **stderr** (secrets
redacted).

```bash
npx -p @depixapp/sdk depix-wallet-mcp
```

**Claude Desktop / Claude Code** (`claude_desktop_config.json` or the MCP config):

```jsonc
{
  "mcpServers": {
    "depix-wallet": {
      "command": "npx",
      "args": ["-p", "@depixapp/sdk", "depix-wallet-mcp"],
      "env": {
        "DEPIX_API_KEY": "sk_live_…",
        "DEPIX_WALLET_PASSPHRASE": "your-passphrase",
        "DEPIX_WALLET_DIR": "/home/agent/.depix-wallet"
      }
    }
  }
}
```

Tools: `wallet_status`, `wallet_get_address`, `wallet_get_balances`,
`wallet_list_transactions`, `wallet_send`, `wallet_create_deposit`,
`wallet_wait_deposit`, `wallet_create_withdrawal`, `wallet_wait_withdrawal`,
`wallet_get_guardrails`, plus swap/lightning/gift-card fast-follows, the
recovery pair `wallet_recover` / `wallet_pending` (re-drive everything pending
across all rails; list what is in flight — crash recovery also runs
automatically at boot) and the read-only `wallet_diagnostics` health snapshot
(versions, sync health, pending counters — never key material). Monetary
fields name their unit (`amount_cents` for Pix/BRL, `amount_sats` for
sends/swaps). There is **no** tool that exports the seed/mnemonic or changes
guardrails — those are never reachable by a tool call, even from a fully
injected model.

> **Two hosts, one wallet dir?** Each host spawns its own process; a second
> process on the same `DEPIX_WALLET_DIR` fails fast with `WALLET_DIR_LOCKED`.
> Point hosts at **distinct** dirs (distinct wallets) or share a single server.

---

## Environment variables

| Variable | Required? | Default | Purpose |
|---|---|---|---|
| `DEPIX_WALLET_PASSPHRASE` | **Required** when a seed exists | — | Unlocks the encrypted seed (Argon2id → AES-256-GCM). **≥ 12 chars** or `WEAK_PASSPHRASE`. Never logged. |
| `DEPIX_API_KEY` | **Required** for deposit/withdraw/status | — | `sk_test_…` (sandbox) or `sk_live_…` (production). |
| `DEPIX_WALLET_DIR` | Optional | `~/.depix-wallet` | Wallet data dir (encrypted seed, sync state, pending/guardrail files). One process per dir (`WALLET_DIR_LOCKED`). |
| `DEPIX_API_BASE` | Optional | `https://api.depixapp.com` | Canonical API base. |
| `DEPIX_GUARDRAIL_PER_TX_BRL_CENTS` | Optional | `10000` (R$ 100) | Per-transaction ceiling, in BRL cents. `0`/negative is a config error; to disable, set `Number.MAX_SAFE_INTEGER` explicitly. |
| `DEPIX_GUARDRAIL_DAILY_BRL_CENTS` | Optional | `50000` (R$ 500) | Rolling-24h ceiling, in BRL cents. |
| `DEPIX_GUARDRAIL_ALLOWLIST` | Optional | off | JSON allowlist (`liquidAddresses`, `pixKeys`, per-rail opt-ins…). When on, any non-allow-listed / non-representable destination is fail-closed. |
| `DEPIX_MCP_MAX_WAIT_SECONDS` | Optional | `900` | Ceiling (seconds) a `wallet_wait_*` MCP tool may block; the per-tool default is 300. |
| `DEPIX_SDK_LOG_LEVEL` | Optional | `info` | `debug` \| `info` \| `warn` \| `error` — minimum level written to stderr. |

Guardrail options passed to `open()` (`guardrails: { … }`) take precedence over
the env, which takes precedence over the defaults. Guardrails are set **only** at
`open()` and are immutable at runtime — there is no update method an injected
agent could reach.

> **`SIDESHIFT_AFFILIATE_ID` is a build/publish variable, not a runtime one.**
> It is baked into the artifact at publish time (see [Publishing](#publishing))
> and is never read at runtime.

---

## Fleet operators (many agents)

For one agent, the simplest safe thing is for the operator to store that
wallet's mnemonic. At scale, use the **envelope** procedure with standard tools
(age/PGP) — this is a documented manual procedure, **not** a feature of the SDK,
and DePix never hosts the blobs:

1. The **operator** generates a recovery keypair and gives the agent only the
   **public** key (the private key never transits).
2. Each agent encrypts its wallet mnemonic(s) to that public key and stores the
   ciphertext in any durable storage (it is useless without the private key).
3. Recovery: decrypt offline with the private key → `DepixWallet.restore()`.

One private key covers N wallets; the secret doesn't disappear, it changes shape.

---

## Conversions

Conversions move between the three Liquid assets and out to other rails. All
are **non-custodial** — the SDK signs locally and funds return to your wallet
— **except SideShift**, which is custodial and signalled as such (see below).

**Primary surface — the intent layer.** `wallet.quote()` enumerates every
candidate route (single- and multi-hop) with per-leg estimates; the callable
`wallet.convert({ from, to, network, amount })` executes one, hiding the
provider mechanics (quote streams, watches, polling) and waiting for
settlement by default:

```ts
const routes = await wallet.quote({ from: "DEPIX", to: "LBTC", network: "liquid", amount: 500_000_000n });
const result = await wallet.convert({ from: "DEPIX", to: "LBTC", network: "liquid", amount: 500_000_000n, route: routes[0].id });
```

**Advanced surface — `wallet.advanced.*`.** The per-provider namespaces, for
power users who want fine-grained control (drive the quote stream tick by
tick, poll `pegStatus`, resume Boltz swaps manually, manage SideShift refund
addresses):

- `wallet.advanced.sideswap.*` — market swaps + BTC↔L-BTC peg (non-custodial).
- `wallet.advanced.boltz.*` — Lightning send/receive + L-BTC→USDC/USDT EVM (non-custodial).
- `wallet.advanced.sideshift.*` — **USDt cross-network — CUSTODIAL, signalled.**

Every money-moving method still crosses the owner's guardrails before signing
— the advanced surface adds no bypass.

> **Deprecated aliases.** `wallet.convert.sideswap` / `.boltz` / `.sideshift`
> still work (they alias the very same instances) but are deprecated — use
> `wallet.advanced.*`. They will not be removed in 1.x.

### Low-level wallet primitives (`wallet.advanced.*`)

Three primitives for agents that need to see and shape transactions directly:

```ts
// READ-ONLY: every UTXO of the wallet (asset, amount, outpoint, address, confirmations).
const utxos = await wallet.advanced.listUtxos();

// READ-ONLY: which UTXOs would cover a target (greedy, confirmed-first, largest-first),
// plus the estimated change. Informational — LWK's builder does its own selection
// at build time, and the network fee is not modeled here.
const pick = await wallet.advanced.selectCoins({ asset: "DEPIX", targetSats: 500_000_000n });

// MOVES FUNDS: one Liquid tx with N recipient outputs (assets can be mixed).
const { txid } = await wallet.advanced.sendMany({
  recipients: [
    { asset: "DEPIX", amountSats: 200_000_000n, address: "lq1…a" },
    { asset: "DEPIX", amountSats: 300_000_000n, address: "lq1…b" },
    { asset: "LBTC",  amountSats: 10_000n,      address: "lq1…c" }
  ]
});
```

`sendMany` crosses the **same guardrail choke point as `send()`, on the
TOTAL**: output amounts are summed per asset, valued in BRL (non-DePix assets
fail closed without a quote), and the grand total is enforced against the
per-tx and rolling-24h ceilings — N small outputs cannot slice under the cap.
With the allowlist on, **every** destination address must be opted in. The
spend is recorded at signing time, all under the wallet op mutex.

> **No raw PSET surface.** `buildPset`/`signPset`/`broadcastPset` are
> deliberately not exposed: a signed PSET can be broadcast by any code path,
> so signing arbitrary PSETs outside the choke point would be a guardrail
> bypass. If you need a custom transaction shape, ask for a primitive that
> can carry the guardrail with it (like `sendMany` does).

### SideShift (custodial USDt bridge)

SideShift uses a deposit-address model: you **send USDt to an address they give
you** and they pay out from their reserve on the target network. This is the one
flow where funds **leave the non-custodial sphere** — once your send confirms the
USDt is in SideShift's custody (escrow states like review/refund apply). Every
result carries `custodial: true`, and the `wallet_shift_usdt` MCP tool says so in
its description. There is **no blocking flag** — the call works directly; the
custodial nature is documented, not gated (decision G4).

```ts
// SEND — USDt Liquid → another network (guardrailed: value + settle/refund allowlist).
const shift = await wallet.advanced.sideshift.send({
  network: "tron",              // ethereum | tron | bsc | polygon | solana
  amountSats: 10_000_000n,      // USDt base units (8 decimals on Liquid)
  settleAddress: "T…",          // FINAL destination on the target network
  refundAddress: "lq1…",        // optional Liquid refund address (allowlisted when the allowlist is on)
});
console.log(shift.custodial);   // true

// RECEIVE — external network → USDt into this wallet (an inflow; no guardrail).
await wallet.advanced.sideshift.receive({ network: "tron" });
await wallet.advanced.sideshift.getStatus(shift.shiftId);
```

With the guardrail allowlist enabled, a SEND requires the `settleAddress` (mapped
to its network class — `evmAddresses` / `tronAddresses`) **and** the
`refundAddress` (`sideshiftRefundAddresses`) to be opted in. A Solana settle has
no representable allowlist class, so it is fail-closed when the allowlist is on.

---

## Maintenance & diagnostics

```ts
// Incremental sync (the default) — scans forward from the current state.
await wallet.sync();

// Deep re-scan from ZERO — drops the local scan cache and re-derives the whole
// history. The recovery move when the wallet looks desynchronized (missing
// transactions, stale balances). Slower: the cold-start timeout applies.
await wallet.sync({ rescan: true });

// Read-only health snapshot for support: SDK/LWK versions, dataDir, backup
// state, sync health (last scan/success, last persist failure), per-rail
// pending counters and the guardrail budget. NEVER key material — no seed,
// mnemonic, passphrase or descriptor.
const diag = await wallet.diagnostics();
```

The same snapshot is exposed to MCP hosts as the read-only `wallet_diagnostics`
tool.

---

## Testing

- `npm test` — offline unit / sandbox / contract suite. Set `DEPIX_SDK_OFFLINE=1`
  to skip the read-only live-network integration checks.
- `npm run smoke` — smokes the built `dist/` (lwk_node init, descriptor + addr[0]
  goldens, seed-store roundtrip) after `npm run build`.
- `npm run openapi:diff` — advisory drift check of the vendored OpenAPI fixture
  against the live document.
- **Mainnet e2e** (`test/e2e/mainnet.test.ts`) — opt-in, real funds, human in the
  loop. Skipped unless `RUN_MAINNET_E2E=1` and a `sk_live_` `DEPIX_API_KEY` are
  set; see the file header for the full prerequisites.

CI runs the matrix Node **22.4 / 24 / current** × **ubuntu / macos** (Windows is
out for 1.0).

---

## Publishing

The package (`version` **1.0.0**) is published **by a human** — the npm account
uses passkey 2FA, so the publish is interactive. The **`SIDESHIFT_AFFILIATE_ID`**
value (the DePix affiliate id — public, but never committed to this repo) is
supplied by the **publisher's environment** and baked into the build at publish
time (spec §5.4), mirroring the frontend's build-time substitution. It is never
read at runtime and never served by the backend.

`prepublishOnly` runs `scripts/check-affiliate-env.mjs` → `npm run build` → the
offline test suite (`DEPIX_SDK_OFFLINE=1 npm run test`). The guard **fails the
publish loudly** if `SIDESHIFT_AFFILIATE_ID` is unset, so a release can never ship
without it; the build then bakes the value into
`dist/convert/sideshift-affiliate.js`, and the published package performs **no
runtime env read**. A dev build without the env var still succeeds but bakes an
empty id, so SideShift calls throw `AFFILIATE_ID_MISSING` until a real build is
published.

```bash
SIDESHIFT_AFFILIATE_ID=<depix-affiliate-id> npm publish
```

Tests and CI use `SIDESHIFT_AFFILIATE_ID=test-affiliate` (wired in `package.json`).
Validate the tarball without publishing anything:

```bash
SIDESHIFT_AFFILIATE_ID=test-affiliate npm publish --dry-run
```

The published package contains `dist/` (compiled JS + types), `README.md` and
`LICENSE`, and exposes the `depix-wallet-mcp` bin.

---

## License

**AGPL-3.0-only** — see [LICENSE](./LICENSE). The network-copyleft applies: a
modified version offered over a network must make its source available under the
same terms. For use in a closed-source or commercial product without the AGPL
obligations, a separate commercial license is available — contact DePix.
