# @depixapp/sdk

Non-custodial Liquid wallet SDK for AI agents. An agent runs a full wallet in Node
— its own seed, signing locally — to **pay and receive over Pix/DePix**, hold and
convert the three Liquid assets (DePix, L-BTC, USDt), and buy gift cards. Nothing
custodial: the seed never leaves the agent's environment and the backend never signs.

> Status: **F3 in active implementation.** Spec: internal. Not yet published to npm.

## Install

```bash
npm install @depixapp/sdk   # coming with 1.0.0
```

## Quickstart

```ts
import { DepixWallet } from "@depixapp/sdk";

const wallet = await DepixWallet.open({
  // dataDir:    defaults to ~/.depix-wallet
  // passphrase: defaults to $DEPIX_WALLET_PASSPHRASE
  // apiKey:     defaults to $DEPIX_API_KEY  (sk_test_ / sk_live_)
});
```

See the docs for the full flow (create → back up → fund → pay a real Pix).

## Conversions

`wallet.convert.*` moves between the three Liquid assets and out to other rails.
All are **non-custodial** — the SDK signs locally and funds return to your wallet
— **except SideShift**, which is custodial and signalled as such (see below).

- `wallet.convert.sideswap.*` — market swaps + BTC↔L-BTC peg (non-custodial).
- `wallet.convert.boltz.*` — Lightning send/receive + L-BTC→USDC/USDT EVM (non-custodial).
- `wallet.convert.sideshift.*` — **USDt cross-network — CUSTODIAL, signalled.**

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
const shift = await wallet.convert.sideshift.send({
  network: "tron",              // ethereum | tron | bsc | polygon | solana
  amountSats: 10_000_000n,      // USDt base units (8 decimals on Liquid)
  settleAddress: "T…",          // FINAL destination on the target network
  refundAddress: "lq1…",        // optional Liquid refund address (allowlisted when the allowlist is on)
});
console.log(shift.custodial);   // true

// RECEIVE — external network → USDt into this wallet (an inflow; no guardrail).
await wallet.convert.sideshift.receive({ network: "tron" });
await wallet.convert.sideshift.getStatus(shift.shiftId);
```

With the guardrail allowlist enabled, a SEND requires the `settleAddress` (mapped
to its network class — `evmAddresses` / `tronAddresses`) **and** the
`refundAddress` (`sideshiftRefundAddresses`) to be opted in. A Solana settle has
no representable allowlist class, so it is fail-closed when the allowlist is on.

## Publishing

The SideShift affiliate id (the DePix affiliate id — public, but not committed to
this repo) is **baked into the package at build time**, mirroring the frontend's
build-time substitution. The publisher **must** set `SIDESHIFT_AFFILIATE_ID` in
the publish environment:

```bash
SIDESHIFT_AFFILIATE_ID=<depix-affiliate-id> npm publish
```

`prepublishOnly` runs `scripts/check-affiliate-env.mjs`, which **fails the publish**
if the env var is unset, so a release can never ship without it. `npm run build`
then bakes the value into `dist/convert/sideshift-affiliate.js` — the published
package performs **no runtime env read**. A dev build without the env var succeeds
but bakes an empty id, so SideShift calls throw `AFFILIATE_ID_MISSING` until a real
build is published. Tests run with `SIDESHIFT_AFFILIATE_ID=test-affiliate` (wired
in `package.json`).

## License

MIT — see [LICENSE](./LICENSE).
