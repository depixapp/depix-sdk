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

> **Companion — the payments-gateway MCP.** To *receive* Pix (checkouts,
> products, status) without any custody, DePix runs a hosted gateway,
> **[`@depixapp/mcp`](https://www.npmjs.com/package/@depixapp/mcp)** at
> `https://mcp.depixapp.com/mcp` ([source](https://github.com/depixapp/depix-mcp)).
> Don't confuse it with the local `depix-wallet-mcp` facade above: the gateway MCP
> is the **receive** side (no keys, no signing); **this SDK** holds, signs and
> moves the funds.

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

### Headless creation — when (and why) to pass `mnemonicSecured: true`

In an interactive terminal, `create()` runs a backup ritual: it prints the 12
words, challenges you to re-type a few of them at random positions, and asks
for an explicit "saved" declaration. Passing the ritual is what confirms the
backup and unlocks receive addresses.

A headless agent — CI job, daemon, MCP host, any process without a TTY — has
no human to run that ritual. There, `create()` still succeeds, but the wallet
is born **unconfirmed**: `getReceiveAddress()` and `deposit()` throw
`BACKUP_REQUIRED` until someone calls `confirmBackup()`.

`mnemonicSecured: true` is the non-interactive substitute for the ritual. It
is an **attestation**: by passing it, your code declares that it captures the
returned `mnemonic` and stores it durably (secret manager, encrypted vault,
the human guardian's envelope — see "Fleet operators") *before* any funds can
arrive. The wallet is then born backup-confirmed and can receive immediately.

Rules of thumb:

- **Pass it** when the very next lines of your code persist `mnemonic`
  somewhere a human can recover it from. This is the normal path for headless
  agents.
- **Don't pass it** if your code discards the mnemonic — you would unlock
  deposits into a wallet nobody can restore. If storing the backup can fail
  (e.g. a network call to a vault), prefer omitting the flag and calling
  `confirmBackup()` only after the store succeeds.
- It must be the literal `true` — there is no env var and no silent default.
  Skipping the ritual is a conscious, logged decision.

`restore({ mnemonic })` never needs the flag: possession of the mnemonic IS
the backup proof, so a restored wallet is always born confirmed.

---

## Quickstart 1b — Agent self-onboarding (register the account, get keys)

An agent can open its OWN DePix account — no human filling a form. It proves
identity with an Ed25519 keypair (persisted encrypted in `dataDir`), and the
account is anchored to a human **operator**: the operator connects once via
OAuth (or a GitHub PAT) in the DePix dashboard and hands the agent an `op_…`
**operator token**. One operator can onboard many agents.

The receive `liquid_address` is taken from the agent's wallet (Quickstart 1) and
**fixed at registration** — the agent cannot change it later.

```ts
import { DepixWallet, DepixAgent } from "@depixapp/sdk";

// 1) Wallet (Quickstart 1) → its receive address is the merchant payout address.
const { wallet } = await DepixWallet.create({ passphrase: process.env.DEPIX_WALLET_PASSPHRASE, mnemonicSecured: true });
await wallet.confirmBackup();
const liquidAddress = await wallet.getReceiveAddress();

// 2) Create the agent identity keypair (encrypted in DEPIX_AGENT_DIR).
const agent = await DepixAgent.create({ passphrase: process.env.DEPIX_AGENT_PASSPHRASE });

// 3) Register. `operatorToken` comes from the human operator's one-time connect.
const { agent: me, keys, merchant } = await agent.register({
  name: "Acme Butler",
  operatorToken: process.env.DEPIX_OPERATOR_TOKEN!, // op_…
  operatorEmail: "ops@acme.com",
  liquidAddress
});

// Returned ONCE — persist them now:
//   keys.test.key        → sk_test_… (sandbox, immediate)
//   keys.liveStarter.key → sk_live_… wallet-only starter key (pre-graduation)
//   merchant.webhookSecret → verify inbound webhooks
console.log(me.username, keys.liveStarter.key);
```

Progress to full production is automatic: make real personal deposits with the
starter key; once matured, the account **graduates** and you can mint a full
`sk_live_` key.

```ts
const status = await agent.status();
// { accountStatus, settledPersonalDeposits, graduated, graduationBlockedOn, keys }

if (status.graduated) {
  const key = await agent.createKey({ live: true, scopes: ["wallet_write"] });
  // key.key → full sk_live_… (returned once)
}

// Key lifecycle + webhook secret rotation, all signed by the identity keypair:
await agent.revokeKey(oldKeyId);
const { webhookSecret } = await agent.rotateWebhookSecret();
```

Receiving from third parties (and any `merchant_*`-scoped key) additionally
requires proving control of a domain — a two-phase DNS TXT challenge:

```ts
// Phase 1 — fetch the challenge (server-derived and stable; re-fetch any time).
const { recordName, recordValue } = await agent.verifyDomain("acme.com");
// → publish a DNS TXT record: name recordName ("_depix-verify.acme.com"),
//   value recordValue ("depix-verify=…").

// Phase 2 — once DNS has propagated, confirm. The server resolves the TXT
// record and stores the registrable domain (eTLD+1) as verified.
const { verifiedDomain } = await agent.verifyDomain("acme.com", { confirm: true });
```

`domain_txt_not_found` on confirm means the record has not propagated yet (or
mismatches) — wait and retry phase 2. `domain_tld_not_allowed` carries the
accepted list in `details.allowed_tlds` (also public at
`GET /api/agents/domain-tlds`), and free-subdomain hosts are rejected with
`domain_free_host`.

Errors branch on `err.code` (see `AgentError` for the catalog): before
graduation a live key throws `graduation_pending`; a `merchant_*` scope without a
verified domain throws `domain_required` (clear it with `verifyDomain()` above);
an expired signature throws `agent_signature_expired` (re-sign — clocks
drifted). `DepixAgent.open({ ... })` reloads the identity in later sessions.

`create()` / `open()` read `DEPIX_AGENT_DIR` (default `~/.depix-agent`),
`DEPIX_AGENT_PASSPHRASE` (falls back to `DEPIX_WALLET_PASSPHRASE`) and
`DEPIX_API_BASE` when the options are omitted.

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

// Lightning + refunds live under wallet.advanced.*.
// A documented cross-network USDt route is custodial and marked custodial: true.
```

**Gift cards** (`wallet.giftcards.*`) — buy a gift card or mobile top-up from
CryptoRefills, paid over Lightning via Boltz (non-custodial), with a 1% DePix
service fee. The full agent loop is browse → pick a value → buy → poll → redeem:

```ts
// 1. Browse the catalog, then a brand's denominations.
const { brands } = await wallet.giftcards.list({ countryCode: "BR", query: "amazon" });
const products = await wallet.giftcards.listProducts({ brandName: "Amazon" });
// Each product is FIXED (pass its `denomination`; `priceSats` is the cost) or a
// RANGE product (`isDynamic: true` — pass denomination "range" + a `productValue`
// within `min`..`max`; price a custom value first if you want):
const custom = await wallet.giftcards.price({ brandName: "Amazon", faceValue: 150 }); // { priceSats, currency }

// 2. Buy. Returns after the L-BTC lockup is broadcast; Boltz then pays the
//    invoice in the background. The payment crosses the owner's guardrails first.
const order = await wallet.giftcards.buy({
  brandName: "Amazon",
  denomination: "50 BRL",         // or "range" + productValue for a dynamic product
  email: "agent@example.com",     // delivery target + the allowlisted beneficiary
});

// 3. Poll until terminal, then read the redemption code/URL.
const status = await wallet.giftcards.getOrderStatus(order.orderId);
if (status.terminal && status.delivery) {
  // status.delivery = { kind: "code" | "url" | "none", value }
}
```

The whole flow is gated on the operator's `giftcardEnabled` toggle
(`GIFTCARDS_DISABLED` when off). Over MCP the same loop is
`wallet_list_giftcards` → `wallet_list_giftcard_products` /
`wallet_giftcard_price` → `wallet_buy_giftcard` →
`wallet_get_giftcard_order_status`.

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
| `DEPIX_AGENT_PASSPHRASE` | Required for `DepixAgent` | `DEPIX_WALLET_PASSPHRASE` | Unlocks the encrypted agent **identity** key (Ed25519). **≥ 12 chars**. Falls back to the wallet passphrase. |
| `DEPIX_AGENT_DIR` | Optional | `~/.depix-agent` | Where `DepixAgent` stores its encrypted identity key. |
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
// Can take up to ~1 min (default timeout 60s, WARM_SYNC_TIMEOUT_MS). It polls
// the esplora provider chain, rotating to the next on failure.
await wallet.sync();

// Deep re-scan from ZERO — drops the local scan cache and re-derives the whole
// history. The recovery move when the wallet looks desynchronized (missing
// transactions, stale balances). Can take SEVERAL MINUTES (default timeout 600s
// / 10 min, COLD_START_TIMEOUT_MS — a virgin cold scan also uses this bound).
await wallet.sync({ rescan: true });

// NOTE ON TIMEOUTS: sync() owns its own timeout + provider rotation — do NOT wrap
// it in a shorter race (e.g. Promise.race with a 10s cap): that aborts a scan
// that would have finished, leaving stale balances. A warm sync may legitimately
// run up to ~1 min and a deep re-scan up to ~10 min. Both bounds are tunable when
// constructing the wallet (syncTimeoutMs / coldStartTimeoutMs); raise them for a
// heavily-used wallet or a slow provider rather than capping sync() externally.

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

CI runs the full suite (typecheck + lint + offline tests + build + smoke) on Node
**24 / current** × **ubuntu / macos**; the Node **22.4** engines floor is proven by
a separate smoke-only job (`npm ci --omit=dev` + `npm run smoke` on the prebuilt
`dist/`, because 22.4's bundled npm can't install the build's dev deps). Windows is
out for 1.0.

**Releasing** is automated: bump `version` in `package.json`, then push a
`vX.Y.Z` tag → CI publishes to npm via OIDC Trusted Publishing (no token, with
provenance). Details in [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## License

**AGPL-3.0-only** — see [LICENSE](./LICENSE). The network-copyleft applies: a
modified version offered over a network must make its source available under the
same terms. For use in a closed-source or commercial product without the AGPL
obligations, a separate commercial license is available — contact DePix at
`suporte@depixapp.com`.
