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

## License

MIT — see [LICENSE](./LICENSE).
