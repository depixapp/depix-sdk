// Authenticated guardrails-state (spec §4.5): AES-256-GCM on the seed-store
// key + a wallet.json marker. Missing/corrupt state WITH the marker present →
// fail-closed (window treated as FULL). Without the marker (fresh wallet) →
// empty. A deleted/forged state cannot zero the 24h accumulator.
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
import { InMemoryMarker, keyProvider, otherStateKey, testStateKey } from "./guardrail-utils.js";

let dataDir: string;
const statePath = () => join(dataDir, GUARDRAILS_STATE_FILE);

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-gstate-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function makeG(marker: InMemoryMarker, key = testStateKey): Guardrails {
  return new Guardrails({
    dataDir,
    config: resolveGuardrailConfig(undefined, {}),
    stateKey: keyProvider(key),
    marker
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

describe("encrypted persistence + marker", () => {
  it("state on disk is an authenticated envelope, not plaintext", async () => {
    const g = makeG(new InMemoryMarker());
    await g.recordSpend(30_000, "send");
    const raw = await readFile(statePath(), "utf8");
    const env = JSON.parse(raw);
    expect(env.v).toBe(1);
    expect(typeof env.iv).toBe("string");
    expect(typeof env.ct).toBe("string");
    // No plaintext leakage of the entries/amount.
    expect(raw).not.toContain("entries");
    expect(raw).not.toContain("30000");
  });

  it("sets the wallet.json marker on the FIRST write", async () => {
    const marker = new InMemoryMarker(false);
    const g = makeG(marker);
    expect(marker.present).toBe(false);
    await g.recordSpend(10_000, "send");
    expect(marker.present).toBe(true);
  });

  it("a new instance decrypts the persisted window (same key)", async () => {
    await makeG(new InMemoryMarker()).recordSpend(30_000, "send");
    const second = makeG(new InMemoryMarker(true));
    expect((await second.usage()).usedCents).toBe(30_000);
  });
});

describe("fail-closed when the marker is present (§4.5)", () => {
  it("DELETED state + marker present → window treated as FULL", async () => {
    const marker = new InMemoryMarker();
    const g = makeG(marker);
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
    const marker = new InMemoryMarker();
    const g = makeG(marker);
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
    await makeG(new InMemoryMarker()).recordSpend(1_000, "send");
    // A different key cannot authenticate the file → fail-closed.
    const wrong = makeG(new InMemoryMarker(true), otherStateKey);
    await expect(wrong.enforce({ kind: "send", brlCents: 1 })).rejects.toSatisfy((e: unknown) =>
      isDepixSdkError(e, "GUARDRAIL_DAILY_LIMIT")
    );
  });

  it("recordSpend REFUSES to overwrite a missing/tampered state (no reset attack)", async () => {
    const marker = new InMemoryMarker();
    const g = makeG(marker);
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
    await makeG(new InMemoryMarker()).recordSpend(1_000, "send");
    // Read the real file, keep it, but assert a no-marker instance treats a
    // failed decrypt as empty.
    const noMarker = makeG(new InMemoryMarker(false), otherStateKey);
    await expect(noMarker.enforce({ kind: "send", brlCents: 10_000 })).resolves.toBeUndefined();
  });

  it("a missing state file without a marker is empty (enforce passes)", async () => {
    const noMarker = makeG(new InMemoryMarker(false));
    await expect(noMarker.enforce({ kind: "send", brlCents: 10_000 })).resolves.toBeUndefined();
  });
});
