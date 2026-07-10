// Guardrail choke point skeleton (spec §4, PR1 scope):
// hardcoded defaults R$100/tx + R$500/day rolling 24h, arithmetic fail-closed,
// quote fail-closed for non-DePix, persisted daily accumulator.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_LIMIT_BRL_CENTS,
  DEFAULT_PER_TX_LIMIT_BRL_CENTS,
  Guardrails
} from "../src/guardrails/guardrails.js";
import { GuardrailError, isDepixSdkError } from "../src/errors.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-guardrails-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function makeGuardrails(now?: () => number): Guardrails {
  return new Guardrails({ dataDir, now });
}

describe("hardcoded defaults (spec §9 PR1 — main NEVER signs without a ceiling)", () => {
  it("defaults are R$100/tx and R$500/day", () => {
    expect(DEFAULT_PER_TX_LIMIT_BRL_CENTS).toBe(10_000);
    expect(DEFAULT_DAILY_LIMIT_BRL_CENTS).toBe(50_000);
  });
});

describe("per-tx limit", () => {
  it("allows exactly the limit, blocks one cent above with structured details", async () => {
    const guardrails = makeGuardrails();
    await expect(guardrails.enforce({ kind: "send", brlCents: 10_000 })).resolves.toBeUndefined();
    try {
      await guardrails.enforce({ kind: "send", brlCents: 10_001 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GuardrailError);
      expect((err as GuardrailError).code).toBe("GUARDRAIL_PER_TX_LIMIT");
      expect((err as GuardrailError).details).toEqual({
        limitCents: 10_000,
        attemptedCents: 10_001,
        usedCents: 0
      });
    }
  });
});

describe("daily limit — rolling 24h window (G7)", () => {
  it("accumulates recorded spends and blocks when the window would overflow", async () => {
    const guardrails = makeGuardrails();
    for (let i = 0; i < 5; i++) {
      await guardrails.enforce({ kind: "send", brlCents: 10_000 });
      await guardrails.recordSpend(10_000, "send");
    }
    // 5 × R$100 = R$500 used; anything more trips the daily cap.
    try {
      await guardrails.enforce({ kind: "send", brlCents: 1 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as GuardrailError).code).toBe("GUARDRAIL_DAILY_LIMIT");
      expect((err as GuardrailError).details).toEqual({
        limitCents: 50_000,
        attemptedCents: 1,
        usedCents: 50_000
      });
    }
  });

  it("entries older than 24h leave the window (and are pruned on write)", async () => {
    let clock = Date.now();
    const guardrails = makeGuardrails(() => clock);
    await guardrails.recordSpend(50_000, "send"); // fill the day
    await expect(guardrails.enforce({ kind: "send", brlCents: 1 })).rejects.toSatisfy(
      (err: unknown) => isDepixSdkError(err, "GUARDRAIL_DAILY_LIMIT")
    );
    clock += 24 * 60 * 60 * 1000 + 1; // 24h + 1ms later
    await expect(guardrails.enforce({ kind: "send", brlCents: 10_000 })).resolves.toBeUndefined();
    await guardrails.recordSpend(1_000, "send");
    // The stale entry was pruned from the persisted state on write.
    const raw = JSON.parse(await readFile(join(dataDir, "guardrails-state.json"), "utf8"));
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0].brlCents).toBe(1_000);
  });

  it("persists across restarts (new instance, same dataDir)", async () => {
    const first = makeGuardrails();
    await first.recordSpend(45_000, "send");
    const second = makeGuardrails();
    await expect(second.enforce({ kind: "send", brlCents: 6_000 })).rejects.toSatisfy(
      (err: unknown) => isDepixSdkError(err, "GUARDRAIL_DAILY_LIMIT")
    );
    await expect(second.enforce({ kind: "send", brlCents: 5_000 })).resolves.toBeUndefined();
  });
});

describe("arithmetic fail-closed (§4.4 — GUARDRAIL_INVALID_AMOUNT)", () => {
  it("rejects undefined/NaN/Infinity/float/zero/negative/bigint before any comparison", async () => {
    const guardrails = makeGuardrails();
    const bad = [undefined, NaN, Infinity, -Infinity, 1.5, 0, -1, 10n, "100", null];
    for (const value of bad) {
      try {
        await guardrails.enforce({ kind: "send", brlCents: value as unknown as number });
        expect.unreachable(`should reject: ${String(value)}`);
      } catch (err) {
        expect(isDepixSdkError(err, "GUARDRAIL_INVALID_AMOUNT"), String(value)).toBe(true);
      }
    }
  });
});

describe("state file handling (PR1 skeleton of §4.5)", () => {
  it("missing state (fresh wallet, no marker yet) counts as an empty window", async () => {
    const guardrails = makeGuardrails();
    await expect(guardrails.enforce({ kind: "send", brlCents: 10_000 })).resolves.toBeUndefined();
  });

  it("corrupted state file is surfaced as an empty window with a loud log (auth arrives in PR3)", async () => {
    await writeFile(join(dataDir, "guardrails-state.json"), "{corrupt", "utf8");
    const guardrails = makeGuardrails();
    await expect(guardrails.enforce({ kind: "send", brlCents: 10_000 })).resolves.toBeUndefined();
  });

  it("usage() reports the current window", async () => {
    const guardrails = makeGuardrails();
    await guardrails.recordSpend(12_345, "send");
    const usage = await guardrails.usage();
    expect(usage).toEqual({
      usedCents: 12_345,
      dailyLimitCents: 50_000,
      perTxLimitCents: 10_000,
      remainingCents: 37_655
    });
  });
});
