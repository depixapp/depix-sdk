// Shared secp256k1-zkp WASM initialisation for the Boltz Liquid crypto (spec
// §5.3). The Liquid taproot tweak (verify-lockup) and the confidential
// claim/refund construction (reverse.ts / refund.ts) all need this WASM inited
// once per process.
//
// Node ESM adaptation: boltz-swaps' own lazy loader
// (boltz-swaps/dist/utxo/lazy.js) resolves the zkp factory as
// `zkpModule.default ?? zkpModule` — correct under esbuild (the frontend) but
// WRONG under node ESM, where the factory is nested one level deeper at
// `.default.default`. So `utxoSecp.get()` throws "zkp is not a function", and
// boltz-swaps' claim helpers (getOutputAmount / getConstructClaimTransaction /
// hashForWitnessV1 / setCooperativeWitness) re-run that broken loader on every
// call. We therefore (a) resolve the factory with the node-ESM nesting
// ourselves, (b) init boltz-core/liquid's module-global secp (the taproot-tweak
// path used by verify-lockup), (c) PRE-POPULATE boltz-swaps' lazy `utxoSecp`
// cache with the same instance so its claim helpers return ours instead of the
// broken loader, and (d) init the SECOND boltz-core/liquid copy that boltz-swaps
// itself resolves. (d) is needed because boltz-core@5 does NOT satisfy
// boltz-swaps' `^4.0.5` peer, so under Node ESM npm forks TWO physical boltz-core
// copies (top-level + nested under this package); (b) inits this package's copy,
// but boltz-swaps' claim CONSTRUCTION (constructClaimTransaction → boltz-core
// liquid Utils.js → confidentialLiquid) reads the OTHER one. Without (c) a real
// claim threw "zkp is not a function"; without (d) it threw "Cannot read
// properties of undefined (reading 'unblindOutputWithKey')" — both on every real
// (locked) reverse/chain claim (mainnet e2e, 2026-07-12; the 118-sat reverse
// claim, confirmed on-chain once (d) was applied). The frontend never hit either
// because esbuild bundles everything into a single module graph.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

let inited: Promise<void> | null = null;

/** Initialise the Boltz Liquid secp256k1-zkp WASM exactly once (idempotent). */
export function ensureBoltzUtxoSecp(): Promise<void> {
  if (!inited) {
    inited = (async () => {
      const [zkpModule, { init }, liquid] = await Promise.all([
        import("@vulpemventures/secp256k1-zkp"),
        import("boltz-core/liquid"),
        import("liquidjs-lib")
      ]);
      // node-ESM interop nesting boltz-swaps' loader gets wrong (see header).
      const mod = zkpModule as { default?: { default?: unknown } };
      const zkpFactory = (mod.default?.default ?? mod.default ?? zkpModule) as () => Promise<unknown>;
      const secp = await zkpFactory();

      // (b) boltz-core/liquid module-global (THIS package's copy) — the
      // taproot-tweak path (verify-lockup) + the SDK's own boltz-core usage.
      (init as (z: unknown) => void)(secp);

      // (d) the boltz-core/liquid copy boltz-swaps resolves from ITS OWN dir —
      // the one its constructClaimTransaction → Utils.js → confidentialLiquid
      // reads, which may be a physically distinct copy under Node ESM (header).
      // Resolve it via boltz-swaps' location and init that module-global too.
      try {
        const req = createRequire(import.meta.url);
        const bsDir = dirname(req.resolve("boltz-swaps/utxo"));
        const bcLiquidEntry = req.resolve("boltz-core/liquid", { paths: [bsDir] });
        // Load init.js via require() — NOT import(). boltz-core@5.0.0 is
        // CommonJS (package.json has no "type":"module"; exports["./liquid"]
        // resolves to a CJS dist; init.js is `exports.confidentialLiquid = …`).
        // Its Utils.js reads that global via `require("./init")` — the LIVE
        // exports object — so we must init THAT same live CJS module. require()
        // of a CJS file works on every supported Node (no ERR_REQUIRE_ESM, which
        // only applies to require of ESM). import() would give a STATIC
        // ESM-wrapped namespace whose `confidentialLiquid` never reflects
        // init()'s mutation, so it does NOT fix the claim (empirically verified,
        // 2026-07-12). Pinned to boltz-core@5.0.0 (exact) — re-verify on a bump
        // (a future ESM boltz-core would need import() + live bindings instead).
        const bcInit = req(join(dirname(bcLiquidEntry), "init.js")) as { init?: (z: unknown) => void };
        bcInit.init?.(secp);
      } catch {
        // Deduped single-copy layout: (b) already covered it.
      }

      // (c) boltz-swaps' lazy cache — the claim/refund construction path. Its
      // Loader.get() returns `modules` verbatim when set, skipping the broken
      // initializer. Mirror the shape boltz-swaps' own loader produces
      // ({ secpZkp, confidential }) so every claim helper resolves this instance.
      const confidential = (
        (liquid as { confidential?: unknown; default?: { confidential?: unknown } }).confidential ??
        (liquid as { default?: { confidential?: unknown } }).default?.confidential
      ) as { Confidential: new (s: unknown) => unknown };
      // NOTE: `modules` is boltz-swaps' internal Loader cache field (not a
      // documented API). Pinned to boltz-swaps@0.0.8 (exact, no ^/~) — any bump
      // must re-verify this field name and the { secpZkp, confidential } shape
      // against boltz-swaps/dist/utxo/lazy.js, or claim construction breaks with
      // no type error.
      const { utxoSecp } = (await import("boltz-swaps/lazy/utxo")) as unknown as {
        utxoSecp: { modules?: unknown };
      };
      utxoSecp.modules = { secpZkp: secp, confidential: new confidential.Confidential(secp) };
    })().catch((err) => {
      // Let the next call retry rather than latch a failed init.
      inited = null;
      throw err;
    });
  }
  return inited;
}

/** Test hook — forget the one-shot secp init latch. */
export function resetBoltzSecpForTests(): void {
  inited = null;
}
