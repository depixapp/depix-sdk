// Regression: ensureBoltzUtxoSecp must wire the zkp the Boltz CLAIM/REFUND
// construction actually uses (mainnet e2e, 2026-07-12).
//
// boltz-swaps' own lazy loader (boltz-swaps/dist/utxo/lazy.js) resolves the zkp
// factory as `zkpModule.default ?? zkpModule` — correct under esbuild (the
// frontend), WRONG under node ESM where the factory is nested at
// `.default.default`. So `utxoSecp.get()` throws "zkp is not a function", and
// every reverse-claim / lockup-refund helper (getOutputAmount,
// getConstructClaimTransaction, hashForWitnessV1, setCooperativeWitness) that
// calls utxoSecp.get() internally re-runs that broken loader — so a real
// (locked) swap could never be claimed. The detectSwap fix (1.0.2) uncovered
// this because it's the very next failure once the claim path advances.
//
// ensureBoltzUtxoSecp must PRE-POPULATE boltz-swaps' lazy cache with a
// correctly node-ESM-resolved secp. Pre-fix: utxoSecp.get() below throws
// "zkp is not a function". Post-fix: it returns the initialized modules.
// Verified to fail on the pre-fix secp.ts and pass after.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureBoltzUtxoSecp, resetBoltzSecpForTests } from "../src/convert/boltz/secp.js";

describe("ensureBoltzUtxoSecp — claim-path zkp wiring (mainnet e2e regression, 2026-07-12)", () => {
  it("makes boltz-swaps' utxoSecp.get() return a working secp instead of throwing 'zkp is not a function'", async () => {
    resetBoltzSecpForTests();
    await ensureBoltzUtxoSecp();
    const { utxoSecp } = (await import("boltz-swaps/lazy/utxo")) as unknown as {
      utxoSecp: { get: () => Promise<{ secpZkp?: unknown; confidential?: unknown }> };
    };
    // The exact call boltz-swaps' claim/refund helpers make internally.
    const secp = await utxoSecp.get();
    expect(secp).toBeDefined();
    expect(secp.secpZkp).toBeDefined();
    expect(secp.confidential).toBeDefined();
  });

  it("initializes confidentialLiquid on the boltz-core/liquid copy boltz-swaps' claim construction reads", async () => {
    // The claim CONSTRUCTION (constructClaimTransaction → boltz-core liquid
    // Utils.js) reads `confidentialLiquid` from the boltz-core/liquid copy
    // resolved from boltz-swaps' OWN dir — which under Node ESM can be a
    // physically distinct fork from the one `import("boltz-core/liquid")` gives
    // (boltz-core@5 fails boltz-swaps' ^4.0.5 peer). ensureBoltzUtxoSecp step (d)
    // must init THAT copy, or a real claim throws "Cannot read properties of
    // undefined (reading 'unblindOutputWithKey')". (The two-copy fork itself was
    // validated on mainnet — the stuck 118-sat reverse claim confirmed on-chain
    // once (d) was applied; this asserts the confidential global is wired.)
    resetBoltzSecpForTests();
    await ensureBoltzUtxoSecp();
    const require = createRequire(import.meta.url);
    const bsDir = dirname(require.resolve("boltz-swaps/utxo"));
    const bcEntry = require.resolve("boltz-core/liquid", { paths: [bsDir] });
    const bcInit = require(join(dirname(bcEntry), "init.js")) as {
      confidentialLiquid?: { unblindOutputWithKey?: unknown };
    };
    expect(bcInit.confidentialLiquid).toBeDefined();
    expect(typeof bcInit.confidentialLiquid?.unblindOutputWithKey).toBe("function");
  });
});
