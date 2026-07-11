# AGENTS.md — @depixapp/sdk

Machine-first manual for AI agents driving this SDK. Everything here is copied
from the source — signatures are exact. Human-oriented prose lives in
[README.md](./README.md); a link index lives in [llms.txt](./llms.txt).

## 1. What this is — the mental model

**A non-custodial Liquid wallet that runs in YOUR (the agent's) environment.**
You hold a seed, sign locally, and move money over Pix/DePix, Liquid, Lightning
and EVM/Tron rails. The backend never signs; no endpoint ever receives a key.

**Intent-first: say the RESULT, never the provider.** You state *what you want*
(`{ from, to, network, amount }`); the SDK enumerates routes, executes legs,
persists crash-safe plans, recovers after restarts and hides which provider
(SideSwap / Boltz / SideShift) does the work. You never pick a provider — when
more than one route exists, the SDK refuses to choose (`MULTIPLE_ROUTES_AVAILABLE`)
and YOU pick by route id after comparing `quote()` output.

```ts
import { DepixWallet } from "@depixapp/sdk";

const wallet = await DepixWallet.open({});          // env-configured
await wallet.convert({ from: "DEPIX", to: "LBTC", amount: 500_000_000n }); // R$5 → L-BTC
```

Three rules that never bend:

1. **Guardrails run before EVERY signature** and are immutable at runtime — no
   method, option or MCP tool can raise them after `open()`.
2. **The backup gate**: no receive address (and therefore no `deposit()`) until
   the seed backup is exported and confirmed — `BACKUP_REQUIRED` otherwise.
3. **One custodial path exists** (SideShift, USDt cross-network) and it is
   always disclosed via `custodial: true` — never gated, never hidden.

## 2. Units — bigint sats everywhere

- Every on-chain amount is a **`bigint` in 8-decimal base units ("sats")**.
  All three Liquid assets (DEPIX, USDT, LBTC) use 8 decimals.
- Pix amounts (`deposit`/`withdraw`) are **`number` integer BRL cents**
  (`amountCents`). Field names always carry the unit: `amountSats` vs `amountCents`.
- **DePix is pegged 1:1 to BRL.** From `src/assets.ts`:
  `DEPIX_SATS_PER_BRL_CENT = 10n ** BigInt(8 - 2)` = **1_000_000n sats per BRL cent**,
  so **R$ 1.00 = 100_000_000n DEPIX sats** and R$ 5.00 = 500_000_000n.
- L-BTC/USDt BRL valuation uses `GET /api/quotes` and **fails closed**
  (`QUOTES_UNAVAILABLE`) when no quote is available — the SDK never signs a
  value it cannot price.
- On the MCP surface, bigints travel as **decimal strings** (`amount_sats: "500000000"`).

## 3. Core API (exact signatures)

All methods are on `DepixWallet` (import from `@depixapp/sdk`). One process per
wallet dir (`WALLET_DIR_LOCKED` on a second open).

### Lifecycle + backup gate

```ts
static async create(options: CreateOptions = {}): Promise<CreateResult>
static async open(options: OpenOptions = {}): Promise<DepixWallet>
static async restore(options: RestoreOptions): Promise<DepixWallet>
async close(): Promise<void>
```

- `create()` — new 12-word wallet. `CreateResult = { mnemonic, descriptor, backupConfirmed, wallet }`;
  the mnemonic is returned in the foreground (impossible not to receive). In a
  TTY it runs an interactive backup ritual; headless, pass `mnemonicSecured: true`
  to be born backup-confirmed (a conscious, logged decision).
- `open()` — opens an existing wallet; **never auto-creates a seed**
  (`WALLET_NOT_FOUND` if the dir is empty). Auto-runs crash recovery for
  withdrawals AND conversions (opt out: `resumePendingWithdrawalsOnOpen: false`,
  `resumePendingConversionsOnOpen: false`).
- `restore({ mnemonic, ... })` — possession of the mnemonic IS the backup proof:
  born `backupConfirmed`. `DESCRIPTOR_MISMATCH` if the dir holds another wallet.
- Options resolve from env when omitted: `dataDir` ← `DEPIX_WALLET_DIR`,
  `passphrase` ← `DEPIX_WALLET_PASSPHRASE` (≥ 12 chars or `WEAK_PASSPHRASE`),
  `apiKey` ← `DEPIX_API_KEY`, `apiBase` ← `DEPIX_API_BASE`,
  `guardrails` ← option > `DEPIX_GUARDRAIL_*` env > defaults.

```ts
isBackupConfirmed(): boolean
async exportBackup(target: BackupTarget = { kind: "mnemonic" }): Promise<MnemonicBackup>
async exportMnemonic(): Promise<string>
async confirmBackup(): Promise<void>
```

Gate: `getReceiveAddress()` and `deposit()` throw `BACKUP_REQUIRED` until
`confirmBackup()` (or `restore`/`mnemonicSecured: true`). Sequence for a fresh
wallet: `create` → store mnemonic with the human guardian → `confirmBackup()` → receive.

### Reads

```ts
async getReceiveAddress(options: { index?: number } = {}): Promise<string>  // FRESH address per call, no reuse
async getBalances(): Promise<WalletBalances>       // { balances: Record<"DEPIX"|"USDT"|"LBTC", bigint>, brlEstimate: number|null }
async listTransactions(): Promise<WalletTransaction[]>
async getGuardrails(): Promise<GuardrailReadout>   // { usedCents, dailyLimitCents, perTxLimitCents, remainingCents, allowlistEnabled }
async sync(options: WalletSyncCallOptions = {}): Promise<{ updated: boolean }>  // { rescan: true } = deep re-scan from zero
async diagnostics(): Promise<WalletDiagnostics>    // versions, sync health, pending counters — NEVER key material
```

### Pix on/off-ramp (needs `DEPIX_API_KEY`, else `API_KEY_REQUIRED`)

```ts
async deposit(params: DepositParams): Promise<DepositResult>
// DepositParams = { amountCents: number; payerTaxNumber: string }  → { id, qrCopyPaste, sandbox? }
async withdraw(params: WithdrawParams): Promise<WithdrawResult>
// WithdrawParams = { pixKey: string; recipientTaxNumber: string; amountCents: number; mode: "send" | "payout" }
// → { withdrawalId, txid, feeCents, feeAddress, netCents, grossCents, payoutCents, sandbox? }
async waitForDeposit(id: string, options: WaitOptions = {}): Promise<StatusReadResponse>
async waitForWithdrawal(id: string, options: WaitOptions = {}): Promise<StatusReadResponse>
```

- `deposit()` creates a Pix QR (`qrCopyPaste`) that the **human owner** pays —
  you have no bank account. It fills the receive address with this wallet's own
  fresh address. Inflow → no guardrail. R$ 5–3000 server-side.
- `payerTaxNumber` = CPF/CNPJ of the QR **payer**; `recipientTaxNumber` = CPF/CNPJ
  of the destination Pix key **holder**. Two different people — never reuse one
  for the other.
- `withdraw()` mode `"send"` = the DePix you send (gross); `"payout"` = the BRL
  the recipient receives. Crash-safe: persisted before the POST, resumed with
  the same Idempotency-Key, signed bytes re-broadcast never re-signed.
- **`WaitOptions` GOTCHA** (`src/flows/status.ts`):
  `{ intervalMs?: number; timeoutMs?: number }` — interval defaults to 5000 ms,
  but **`timeoutMs` is UNBOUNDED when omitted**. A deposit waits on a human
  paying a QR; without `timeoutMs` your call can block forever. **Always pass a
  `timeoutMs`** when a human is in the loop and handle the thrown `POLL_TIMEOUT`.
  Terminal statuses — deposit: `depix_sent` (success) | refunded | canceled |
  error | expired; withdrawal: `sent` (success; sandbox: `confirmed`) |
  refunded | cancelled | error | expired.

### Send (Liquid)

```ts
async send(params: SendParams): Promise<SendResult>
// SendParams = { asset: AssetKey; amountSats: bigint; address: string }  → { txid }
```

Signed locally; guardrails (value + allowlist) run before signing.

### convert() / quote() — the PRIMARY conversion surface

```ts
async quote(params: ConvertIntent): Promise<RouteQuote[]>          // read-only, moves nothing
wallet.convert(params: ConvertParams): Promise<ConvertResult>      // callable property, executes ONE route
```

```ts
interface ConvertIntent {           // the intent trio + amount
  from: IntentAsset;                // "DEPIX" | "USDT" | "LBTC" | "BTC" | "USDC"
  to: IntentAsset;
  network?: IntentNetwork;          // destination network, default "liquid"
  fromNetwork?: IntentNetwork;      // origin; leave unset on BTC/USDT inflows to enumerate every rail
  amount: bigint;                   // 8-decimal base units of `from`
}
interface ConvertParams extends ConvertIntent {
  route?: string | { id: string };  // REQUIRED when >1 candidate exists
  wait?: boolean;                   // default true — return only once settled
  address?: string;                 // FINAL destination for outbound cross-network routes
  invoice?: string;                 // BOLT11 for LBTC → BTC@lightning
  refundAddress?: string;           // SideShift send only
  timeoutMs?: number;               // settle wait bound (default 15 min)
}
```

`IntentNetwork = "liquid" | "bitcoin" | "lightning" | "ethereum" | "polygon" |
"arbitrum" | "optimism" | "base" | "tron" | "bsc" | "solana"`.

**Routing table** (`src/convert/routes.ts`) — a route is up to 3 legs pivoting
through this wallet's Liquid holdings:

| Leg | from → to | Provider.method | Custodial |
|---|---|---|---|
| entry | BTC@bitcoin → LBTC | `sideswap.pegIn` | no |
| entry | BTC@lightning → LBTC | `boltz.receiveLightning` | no |
| entry | USDT@{ethereum,tron,bsc,polygon,solana} → USDT@liquid | `sideshift.receive` | **yes** |
| market | DEPIX ↔ USDT ↔ LBTC (on Liquid) | `sideswap.swap` | no |
| exit | LBTC → BTC@bitcoin | `sideswap.pegOut` | no |
| exit | LBTC → BTC@lightning | `boltz.payLightningInvoice` | no |
| exit | LBTC → USDC@{ethereum,polygon,arbitrum,optimism,base} / USDT@{ethereum,polygon,arbitrum,optimism,tron} | `boltz.toStablecoin` | no |
| exit | USDT@liquid → USDT@{ethereum,tron,bsc,polygon,solana} | `sideshift.send` | **yes** |

A route is custodial iff ANY leg is. Multi-hop routes (e.g. DEPIX → LBTC →
BTC@lightning) execute end to end behind a **durable encrypted plan with crash
recovery** — legs run sequentially on REAL settled amounts, never estimates.

**The choose-by-quote loop** (the SDK never picks for you):

```ts
try {
  await wallet.convert({ from: "DEPIX", to: "USDT", network: "tron", amount: 10_000_000_000n });
} catch (err) {
  if (isDepixSdkError(err, "MULTIPLE_ROUTES_AVAILABLE")) {
    const quotes = await wallet.quote({ from: "DEPIX", to: "USDT", network: "tron", amount: 10_000_000_000n });
    // compare estimatedReceivedSats / hops / custodial, then:
    await wallet.convert({ from: "DEPIX", to: "USDT", network: "tron",
                           amount: 10_000_000_000n, route: quotes[0].id, address: "T…" });
  }
}
```

- One route resolves the intent (or exactly one single-hop table row) →
  `convert()` executes without `route`. Anything else throws
  `MULTIPLE_ROUTES_AVAILABLE` with every candidate in `details.routes`.
- **A custodial single-hop auto-executes by design** — custody is disclosed
  (`custodial: true` on quotes AND results), never gated. Want non-custodial?
  Pass the multi-hop Boltz route id explicitly.
- `RouteQuote` = `{ id, legs, hops, custodial, estimatedReceivedSats, estimatedFeeTotalSats, feeAsset, estimateComplete, notes }`
  — estimates are best-effort; an unestimatable leg yields nulls + a note, never a throw.
- `ConvertResult` = `{ route, status, txids, receivedSats, custodial, trackingId?, funding?, nextStep? }`
  with `status: "settled" | "pending" | "awaiting_funding" | "refunded" | "refund_pending" | "failed"`.
  On timeout you get `"pending"` + an actionable `nextStep` — **funds in flight
  are never lost**; `recover()` finishes or refunds them.
- Inflow routes (BTC/lightning/USDT entries) return `"awaiting_funding"` +
  `funding` (address or invoice for the external payer) immediately — `wait`
  does not apply.

### Recovery

```ts
async recover(): Promise<RecoverySummary>     // re-drive EVERYTHING pending, all rails; idempotent
async getPending(): Promise<PendingItem[]>    // read-only: withdrawals, boltz swaps, peg-in, sideshift shifts, plans
```

Recovery also auto-runs on `open()`. It only completes or refunds PREVIOUSLY
authorized operations — it never starts a new payment. After any crash:
`open()` → `getPending()` → (if anything remains) `recover()`.

### advanced.* — the power-user escape hatch

```ts
wallet.advanced.listUtxos(): Promise<WalletUtxo[]>                       // read-only
wallet.advanced.selectCoins(params: SelectCoinsParams): Promise<CoinSelection>  // read-only, informational
wallet.advanced.sendMany(params: SendManyParams): Promise<SendManyResult>       // MOVES FUNDS, guardrailed on the TOTAL
wallet.advanced.sideswap   // market swaps + BTC↔L-BTC peg (quote streams, pegStatus)
wallet.advanced.boltz      // Lightning pay/receive + L-BTC→stablecoin (manual resume/refund)
wallet.advanced.sideshift  // USDt cross-network — CUSTODIAL, signalled
```

Same provider instances that back `convert()`/`quote()`. Every money-moving
method still crosses the guardrail choke point — no bypass exists. There is
deliberately **no raw PSET surface** (build/sign/broadcast): that would be a
guardrail bypass. `wallet.convert.sideswap/.boltz/.sideshift` are deprecated
aliases of `wallet.advanced.*` (kept through 1.x).

Also on the wallet: `wallet.giftcards.list()/buy()/listOrders()` (gift cards
paid over Lightning) and `wallet.merchant.get()/update()` (light profile).

## 4. Errors — always branch on `err.code`

Every error is a `DepixSdkError` subclass with a stable string `code`; many
carry an actionable `details.nextStep`. Narrow with
`isDepixSdkError(err, code?)`. The ones you will actually hit:

| Code | Meaning → what to do |
|---|---|
| `GUARDRAIL_PER_TX_LIMIT` | Over the per-tx BRL cap. Split the operation or ask the owner to raise the cap (env + restart — you cannot). |
| `GUARDRAIL_DAILY_LIMIT` | Rolling-24h cap hit. `details.limitCents/usedCents/attemptedCents` say by how much. Wait for the window to roll or ask the owner. |
| `GUARDRAIL_ALLOWLIST_BLOCKED` | Destination not on the owner's allowlist (`details.class` names the destination class). Only the owner can add it. |
| `QUOTES_UNAVAILABLE` | No fresh BRL quote to value L-BTC/USDt — fail-closed, nothing signed. Retry later; DEPIX operations still work (1:1 peg needs no quote). |
| `MULTIPLE_ROUTES_AVAILABLE` | >1 candidate route. Compare via `quote()`, re-call `convert({ route })`. Candidates in `details.routes`. |
| `ROUTE_NOT_FOUND` | Bad `route` id. Valid ids in `details.availableRouteIds`. |
| `INSUFFICIENT_FUNDS` / `INSUFFICIENT_LBTC_FOR_FEE` | Not enough of the asset / no L-BTC for the network fee. Check `getBalances()`; fund or convert first. |
| `BACKUP_REQUIRED` | Receive blocked until backup. `exportBackup()` → store with guardian → `confirmBackup()`. |
| `API_KEY_REQUIRED` | `deposit`/`withdraw`/waiters need `DEPIX_API_KEY`. Only the operator can set it (env + restart). |
| `POLL_TIMEOUT` | A waiter hit your `timeoutMs`. The operation is NOT cancelled — poll again later with the same id. |
| `WALLET_NOT_FOUND` | No wallet in the dataDir (`create()` first — the SDK never auto-creates), or a view-only wallet was asked to sign. |
| `WALLET_ALREADY_EXISTS` / `DESCRIPTOR_MISMATCH` | dataDir already holds a (different) wallet. Open it or use another dir. |
| `WRONG_PASSPHRASE` / `WEAK_PASSPHRASE` | Bad / too-short (< 12 chars) passphrase. |
| `WALLET_DIR_LOCKED` | Another process owns this dataDir. One process per dir. |
| `INVALID_AMOUNT` / `INVALID_ADDRESS` / `UNSUPPORTED_ASSET` | Bad input — amounts must be positive bigints; no route for that asset trio. |
| `SWAP_QUOTE_EXPIRED` / `SWAP_LOW_BALANCE` | SideSwap quote died / dealer illiquid. Get a fresh quote / retry smaller. |
| `PEG_IN_ALREADY_PENDING` | One in-flight peg-in at a time. Check `getPending()`. |
| `GIFTCARDS_DISABLED` / `GIFTCARD_KYC_CATEGORY` | Backend toggle off / KYC-gated brand (deep-link in details). |
| `AFFILIATE_ID_MISSING` | Dev build without the baked SideShift affiliate id — use a published build. |
| `PLAN_VALIDATION_FAILED` | A stored multi-hop plan failed authentication — discarded, never acted on. |
| `ESPLORA_UNAVAILABLE` / `BROADCAST_FAILED` | Transport trouble — retry with backoff. |

API-side errors surface as `DepixApiError` (HTTP envelope: `status`,
`requestId`, `retryAfter`, `details.required_scope`…). Retryable API codes:
`rate_limited`, `merchant_rate_limited`, `service_unavailable`,
`upstream_error`, `idempotency_in_flight`, `platform_shutdown`,
`payer_velocity_limit` — honor `retryAfter`.

## 5. Guardrails — the owner's, not yours

- Defaults: **R$ 100.00 per tx** (`10_000` cents) + **R$ 500.00 rolling-24h**
  (`50_000` cents). Optional destination **allowlist** (Liquid addresses, Pix
  keys, BTC/EVM/Tron addresses, Lightning opt-in, gift-card beneficiaries,
  SideShift refund addresses) — when ON, a destination class not opted in is
  fail-closed.
- Set ONCE at `create()/open()/restore()` (option > `DEPIX_GUARDRAIL_*` env >
  default) and **immutable at runtime** — there is no setter, no MCP tool,
  nothing an injected prompt can call to raise a ceiling. Changing limits =
  owner edits env + restarts.
- Enforced BEFORE signing, recorded AT signing time, serialized under a mutex
  (parallel calls cannot slice under the cap). `sendMany` is enforced on the
  **total** of all outputs.
- **Multi-hop counts the value ONCE** (same money moving through hops), at the
  first outflow leg — but the allowlist still gates EVERY leg's destinations.
- No BRL quote → **fail-closed** (`QUOTES_UNAVAILABLE`), never "benefit of the doubt".
- `getGuardrails()` tells you the budget before you try: check `remainingCents`
  and plan within it instead of burning a failed call.

## 6. Custody

Everything is **non-custodial** — your seed signs client-side, funds move under
your key, Boltz lockups auto-refund on failure — with **exactly one exception**:
**SideShift** (USDt cross-network, both directions). Funds transit SideShift's
custody mid-flight (escrow/review/refund states possible). It is **signalled,
never gated**: quotes and results carry `custodial: true`, the
`wallet_shift_usdt` MCP tool says CUSTODIAL in its description. If you (or your
owner's policy) require non-custodial, filter quotes on `custodial === false`.

## 7. Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DEPIX_WALLET_PASSPHRASE` | when a seed exists | — | ≥ 12 chars (`WEAK_PASSPHRASE`). Encrypts the seed (Argon2id → AES-256-GCM). |
| `DEPIX_API_KEY` | for deposit/withdraw/waiters | — | `sk_test_…` (sandbox) or `sk_live_…` (production). Mode is derived locally from the prefix. |
| `DEPIX_WALLET_DIR` | no | `~/.depix-wallet` | One process per dir. |
| `DEPIX_API_BASE` | no | `https://api.depixapp.com` | |
| `DEPIX_GUARDRAIL_PER_TX_BRL_CENTS` | no | `10000` (R$ 100) | 0/negative = config error, never "off". |
| `DEPIX_GUARDRAIL_DAILY_BRL_CENTS` | no | `50000` (R$ 500) | Rolling 24 h. |
| `DEPIX_GUARDRAIL_ALLOWLIST` | no | off | JSON (`{"enabled":true,"liquidAddresses":[…],…}`). |
| `DEPIX_MCP_MAX_WAIT_SECONDS` | no | `900` | Ceiling for the MCP `wallet_wait_*` / convert timeouts. |
| `DEPIX_SDK_LOG_LEVEL` | no | `info` | Logs go to stderr, secrets redacted. |
| `SIDESHIFT_AFFILIATE_ID` | — | — | **Build/publish-time only** — baked into the artifact, never read at runtime. |

## 8. Local MCP server — `depix-wallet-mcp`

The package ships a stdio MCP bin exposing the SAME wallet as **23 `wallet_*`
tools** (server name `com.depixapp/wallet`). Config is 100% environment (the
table above) — no CLI flags, no tool ever receives a secret. **stdout is
JSON-RPC only; every log goes to stderr, redacted.** Boots by `open()`-ing the
wallet (never creates a seed) and runs crash recovery at boot.

```bash
npx -p @depixapp/sdk depix-wallet-mcp
```

Catalog (`WALLET_TOOL_NAMES`, `src/mcp/server.ts`):

- Reads: `wallet_status`, `wallet_get_address`, `wallet_get_balances`,
  `wallet_list_transactions`, `wallet_get_guardrails`, `wallet_pending`,
  `wallet_diagnostics`, `wallet_list_giftcard_orders`
- Pix: `wallet_create_deposit`, `wallet_wait_deposit`,
  `wallet_create_withdrawal`, `wallet_wait_withdrawal` (waits bounded: default
  300 s, hard ceiling 900 s — unlike the SDK-level waiters)
- **Primary conversion surface: `wallet_quote` + `wallet_convert`** — same
  intent semantics as §3 (`MULTIPLE_ROUTES_AVAILABLE` returns candidates in
  `error.data.routes`; re-call with `route`)
- Provider-level escape hatch: `wallet_swap_quote`, `wallet_swap_execute`,
  `wallet_pay_lightning_invoice`, `wallet_receive_lightning`,
  `wallet_to_stablecoin`, `wallet_buy_giftcard`
- Money + recovery: `wallet_send`, `wallet_shift_usdt` (the ONE custodial
  tool), `wallet_recover`

By design there is **no tool** that exports the seed/mnemonic/descriptor,
mutates guardrails, or pays a merchant checkout QR — unreachable even by a
fully injected model. Amounts: `amount_cents` = BRL cents, `amount_sats` =
base-unit strings.

## 9. Prerequisites & platform limits

- **Runtime:** Node ≥ 22.4, Linux + macOS (Windows via WSL).
- **Live keys:** an `sk_live_` key requires the account's `merchant.api_access`
  flag (**admin-granted**); when WhatsApp enforcement is on, the owner must
  have WhatsApp verified or deposit/withdraw return
  `whatsapp_verification_required`. Test with `sk_test_` first — sandbox
  responses carry `sandbox: true`.
- **Rate limits (SDK paces them):** deposit/withdraw creation 2/min per key;
  status reads 30/min per endpoint (shared across concurrent waiters).
- **Funding model:** you cannot fund yourself — `deposit()` emits a QR a human
  pays. Owner-side blast-radius advice: fund the agent wallet with only what
  it needs.

## 10. Recipes (intent-level)

```ts
// Receive R$ 25 from the owner
const dep = await wallet.deposit({ amountCents: 2500, payerTaxNumber: OWNER_CPF });
// → give dep.qrCopyPaste to the owner, then:
await wallet.waitForDeposit(dep.id, { timeoutMs: 15 * 60_000 });   // ALWAYS bound human waits

// Pay R$ 10 to a Pix key
const w = await wallet.withdraw({ pixKey, recipientTaxNumber: HOLDER_CPF, amountCents: 1000, mode: "payout" });
await wallet.waitForWithdrawal(w.withdrawalId, { timeoutMs: 10 * 60_000 });

// Hold value in BTC terms: R$ 5 of DePix → L-BTC (single market hop, executes directly)
await wallet.convert({ from: "DEPIX", to: "LBTC", amount: 500_000_000n });

// Pay a Lightning invoice from L-BTC
await wallet.convert({ from: "LBTC", to: "BTC", network: "lightning", amount: 30_000n, invoice: bolt11 });

// Anything ambiguous: quote → choose → convert({ route })  (see §3)

// After a crash / restart
const pending = await wallet.getPending();
if (pending.length > 0) await wallet.recover();
```

Say the result. The SDK does the rest.
