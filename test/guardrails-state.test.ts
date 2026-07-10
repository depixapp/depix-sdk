// Authenticated guardrails-state (spec §4.5): AES-256-GCM on an HKDF subkey of
// the seed material + a SEED-BOUND anchor (marker + monotonic epoch) in
// wallet.json's authenticated envelope. Missing/corrupt state WITH the marker
// present → fail-closed (window treated as FULL). Without the marker (fresh
// wallet) → empty. A deleted/forged state cannot zero the 24h accumulator; a
// stripped marker bricks the seed; a replayed old state is rejected by the epoch.
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GUARDRAILS_STATE_FILE,
  Guardrails,
  resolveGuardrailConfig
} from "../src/guardrails/guardrails.js";
import { GuardrailError, isDepixSdkError } from "../src/errors.js";
import { WALLET_FILE_NAME } from "../src/store/seed-store.js";
import {
  InMemoryAnchor,
  keyProvider,
  makeRealAnchor,
  otherStateKey,
  testStateKey,
  type RealAnchorFixture
} from "./guardrail-utils.js";

let dataDir: string;
const statePath = () => join(dataDir, GUARDRAILS_STATE_FILE);
const walletPath = () => join(dataDir, WALLET_FILE_NAME);

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-gstate-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function makeG(anchor: InMemoryAnchor, key = testStateKey): Guardrails {
  return new Guardrails({
    dataDir,
    config: resolveGuardrailConfig(undefined, {}),
    stateKey: keyProvider(key),
    anchor
  });
}

/** Guardrails wired to a REAL SeedStore anchor + real HKDF state key on disk. */
function makeRealG(fx: RealAnchorFixture): Guardrails {
  return new Guardrails({
    dataDir,
    config: resolveGuardrailConfig(undefined, {}),
    stateKey: fx.stateKey,
    anchor: fx.anchor
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("encrypted persistence + anchor", () => {
  it("state on disk is an authenticated envelope, not plaintext", async () => {
    const g = makeG(new InMemoryAnchor());
    await g.recordSpend(30_000, "send");
    const raw = await readFile(statePath(), "utf8");
    const env = JSON.parse(raw);
    expect(env.v).toBe(1);
    expect(typeof env.iv).toBe("string");
    expect(typeof env.ct).toBe("string");
    // No plaintext leakage of the entries/amount/epoch.
    expect(raw).not.toContain("entries");
    expect(raw).not.toContain("30000");
    expect(raw).not.toContain("epoch");
  });

  it("sets the seed-bound marker + epoch on the FIRST write", async () => {
    const anchor = new InMemoryAnchor(false);
    const g = makeG(anchor);
    expect(anchor.initialized).toBe(false);
    expect(anchor.epoch).toBe(0);
    await g.recordSpend(10_000, "send");
    expect(anchor.initialized).toBe(true);
    expect(anchor.epoch).toBe(1);
  });

  it("a new instance decrypts the persisted window (shared anchor + key)", async () => {
    // One anchor object models the single persisted wallet.json across restarts.
    const anchor = new InMemoryAnchor();
    await makeG(anchor).recordSpend(30_000, "send");
    const second = makeG(anchor);
    expect((await second.usage()).usedCents).toBe(30_000);
  });
});

describe("fail-closed when the marker is present (§4.5)", () => {
  it("DELETED state + marker present → window treated as FULL", async () => {
    const anchor = new InMemoryAnchor();
    const g = makeG(anchor);
    await g.recordSpend(1_000, "send"); // marker now present
    await rm(statePath());
    try {
      await g.enforce({ kind: "send", brlCents: 1 });
      expect.unreachable("should fail closed");
    } catch (err) {
      expect((err as GuardrailError).code).toBe("GUARDRAIL_DAILY_LIMIT");
      expect((err as GuardrailError).details?.usedCents).toBe(50_000);
    }
    expect((await g.usage()).usedCents).toBe(50_000); // usage honestly reports FULL
    expect((await g.usage()).remainingCents).toBe(0);
  });

  it("TAMPERED ciphertext + marker present → fail-closed (GCM auth)", async () => {
    const anchor = new InMemoryAnchor();
    const g = makeG(anchor);
    await g.recordSpend(1_000, "send");
    // Flip one base64 char of the ciphertext → GCM tag mismatch on read.
    const env = JSON.parse(await readFile(statePath(), "utf8"));
    env.ct = (env.ct[0] === "A" ? "B" : "A") + env.ct.slice(1);
    await writeFile(statePath(), `${JSON.stringify(env)}\n`, "utf8");
    await expect(g.enforce({ kind: "send", brlCents: 1 })).rejects.toSatisfy((e: unknown) =>
      isDepixSdkError(e, "GUARDRAIL_DAILY_LIMIT")
    );
  });

  it("WRONG key + marker present → fail-closed (cannot authenticate)", async () => {
    await makeG(new InMemoryAnchor()).recordSpend(1_000, "send");
    // A different key cannot authenticate the file → fail-closed (decrypt fails
    // before the epoch is ever compared).
    const wrong = makeG(new InMemoryAnchor(true), otherStateKey);
    await expect(wrong.enforce({ kind: "send", brlCents: 1 })).rejects.toSatisfy((e: unknown) =>
      isDepixSdkError(e, "GUARDRAIL_DAILY_LIMIT")
    );
  });

  it("recordSpend REFUSES to overwrite a missing/tampered state (no reset attack)", async () => {
    const anchor = new InMemoryAnchor();
    const g = makeG(anchor);
    await g.recordSpend(1_000, "send");
    await rm(statePath());
    // A record over a fail-closed state must NOT rewrite a fresh single-entry
    // window (that is the reset the marker exists to prevent).
    await expect(g.recordSpend(1_000, "send")).rejects.toSatisfy((e: unknown) =>
      isDepixSdkError(e, "GUARDRAIL_DAILY_LIMIT")
    );
    expect(await fileExists(statePath())).toBe(false); // nothing was written
  });
});

describe("marker ABSENT (fresh wallet) → empty window, not fail-closed", () => {
  it("a corrupt state file without a marker is treated as empty", async () => {
    // Write a syntactically-valid but wrong-key envelope; no marker set.
    await makeG(new InMemoryAnchor()).recordSpend(1_000, "send");
    // A no-marker instance treats a failed decrypt as empty.
    const noMarker = makeG(new InMemoryAnchor(false), otherStateKey);
    await expect(noMarker.enforce({ kind: "send", brlCents: 10_000 })).resolves.toBeUndefined();
  });

  it("a missing state file without a marker is empty (enforce passes)", async () => {
    const noMarker = makeG(new InMemoryAnchor(false));
    await expect(noMarker.enforce({ kind: "send", brlCents: 10_000 })).resolves.toBeUndefined();
  });
});

describe("monotonic anti-replay of the state file (§4.5)", () => {
  it("a REPLAYED older state ciphertext is rejected (epoch < anchor) → fail-closed", async () => {
    const anchor = new InMemoryAnchor();
    const g = makeG(anchor);
    await g.recordSpend(10_000, "send"); // epoch 1
    const snapshotEpoch1 = await readFile(statePath(), "utf8"); // valid, but stale
    await g.recordSpend(10_000, "send"); // epoch 2 — anchor now ahead
    expect((await g.usage()).usedCents).toBe(20_000);
    // Attacker restores the epoch-1 snapshot to roll the accumulator back.
    await writeFile(statePath(), snapshotEpoch1, "utf8");
    await expect(g.enforce({ kind: "send", brlCents: 1 })).rejects.toSatisfy((e: unknown) =>
      isDepixSdkError(e, "GUARDRAIL_DAILY_LIMIT")
    );
    // And it also cannot be silently re-recorded over.
    await expect(g.recordSpend(1, "send")).rejects.toSatisfy((e: unknown) =>
      isDepixSdkError(e, "GUARDRAIL_DAILY_LIMIT")
    );
  });
});

describe("REAL disk path — the InMemory double cannot mask this (§4.5)", () => {
  let fx: RealAnchorFixture;

  beforeEach(async () => {
    fx = await makeRealAnchor(dataDir);
  });

  it("the seed decrypts before AND after a real anchor advance", async () => {
    expect(await fx.seedStore.decryptMnemonic(fx.passphrase)).toBe(fx.mnemonic);
    await makeRealG(fx).recordSpend(10_000, "send"); // advances the seed-bound anchor
    // Re-encrypted under the bumped anchor AAD — still decrypts with the same passphrase.
    expect(await fx.seedStore.decryptMnemonic(fx.passphrase)).toBe(fx.mnemonic);
    expect((await fx.seedStore.readGuardrailAnchor())).toEqual({ initialized: true, epoch: 1 });
  });

  it("STRIPPING the marker from wallet.json bricks the seed (not a reset)", async () => {
    await makeRealG(fx).recordSpend(10_000, "send"); // marker set, epoch=1, seed re-encrypted
    // Injected agent strips ONLY the marker field, keeping encryptedSeed/salt/iv.
    const wallet = JSON.parse(await readFile(walletPath(), "utf8"));
    delete wallet.guardrailsStateInitialized;
    delete wallet.guardrailEpoch;
    await writeFile(walletPath(), `${JSON.stringify(wallet, null, 2)}\n`, "utf8");
    // The seed no longer decrypts — the AAD changed, and the attacker has no key.
    await expect(fx.seedStore.decryptMnemonic(fx.passphrase)).rejects.toSatisfy((e: unknown) =>
      isDepixSdkError(e, "WRONG_PASSPHRASE")
    );
  });

  it("EDITING the epoch in wallet.json bricks the seed", async () => {
    await makeRealG(fx).recordSpend(10_000, "send"); // epoch=1
    const wallet = JSON.parse(await readFile(walletPath(), "utf8"));
    wallet.guardrailEpoch = 0; // roll the epoch back in plaintext
    await writeFile(walletPath(), `${JSON.stringify(wallet, null, 2)}\n`, "utf8");
    await expect(fx.seedStore.decryptMnemonic(fx.passphrase)).rejects.toSatisfy((e: unknown) =>
      isDepixSdkError(e, "WRONG_PASSPHRASE")
    );
  });

  it("STRIP marker + DELETE state on the real path → fail-closed, no bypass", async () => {
    const g = makeRealG(fx);
    await g.recordSpend(40_000, "send"); // near the R$500 cap; epoch=1
    // Surgical strip of the marker + delete of the state (the §4.5 attack).
    const wallet = JSON.parse(await readFile(walletPath(), "utf8"));
    delete wallet.guardrailsStateInitialized;
    await writeFile(walletPath(), `${JSON.stringify(wallet, null, 2)}\n`, "utf8");
    await rm(statePath());
    // The marker is now covered by the seed AAD: reading it (via the anchor) is
    // consistent with a bricked seed. Either way, no over-cap signing is possible
    // — a real send() would fail to decrypt the seed. Here we assert the anchor
    // read + a fresh recordSpend cannot silently reset the window: advancing the
    // anchor re-decrypts the seed under the tampered AAD and throws.
    await expect(g.recordSpend(40_000, "send")).rejects.toBeInstanceOf(Error);
  });

  it("a real replayed state (epoch<anchor) fails closed", async () => {
    const g = makeRealG(fx);
    await g.recordSpend(10_000, "send"); // epoch 1
    const snap = await readFile(statePath(), "utf8");
    await g.recordSpend(10_000, "send"); // epoch 2
    await writeFile(statePath(), snap, "utf8"); // replay epoch-1 state
    await expect(g.enforce({ kind: "send", brlCents: 1 })).rejects.toSatisfy((e: unknown) =>
      isDepixSdkError(e, "GUARDRAIL_DAILY_LIMIT")
    );
  });
});
