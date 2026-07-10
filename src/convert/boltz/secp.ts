// Shared secp256k1-zkp WASM initialisation for the Boltz Liquid crypto (spec
// §5.3). The Liquid taproot tweak (verify-lockup) and the confidential
// claim/refund construction (reverse.ts / refund.ts) all need this WASM inited
// once per process.
//
// Node ESM adaptation (frontend verify-lockup.js:112-122): the boltz-swaps SDK
// loader unwraps a single interop level (`mod.default ?? mod`), correct under
// esbuild but WRONG under node ESM where the factory is nested at
// `.default.default`. So we try the lazy loader first (shares one WASM instance
// when available), then fall back to a robust direct init that handles the node
// interop nesting.

let inited: Promise<void> | null = null;

/** Initialise the Boltz Liquid secp256k1-zkp WASM exactly once (idempotent). */
export function ensureBoltzUtxoSecp(): Promise<void> {
  if (!inited) {
    inited = (async () => {
      try {
        const { utxoSecp } = await import("boltz-swaps/lazy/utxo");
        await utxoSecp.get();
      } catch {
        const [zkpModule, { init }] = await Promise.all([
          import("@vulpemventures/secp256k1-zkp"),
          import("boltz-core/liquid")
        ]);
        const mod = zkpModule as { default?: { default?: unknown } };
        const zkpFactory = (mod.default?.default ?? mod.default ?? zkpModule) as () => Promise<unknown>;
        (init as (z: unknown) => void)(await zkpFactory());
      }
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
