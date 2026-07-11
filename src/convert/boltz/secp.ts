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
// path used by verify-lockup), and (c) PRE-POPULATE boltz-swaps' lazy `utxoSecp`
// cache with the same instance so its claim helpers return ours instead of the
// broken loader. Without (c), the reverse claim / lockup refund threw
// "zkp is not a function" for every real (locked) swap (mainnet e2e, 2026-07-12).

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

      // (b) boltz-core/liquid module-global — the taproot-tweak path.
      (init as (z: unknown) => void)(secp);

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
