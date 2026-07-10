// Guardrail choke point core behavior (spec §4): per-tx + daily rolling-24h,
// arithmetic fail-closed, atomic accounting. State is now AES-256-GCM
// authenticated (§4.5), so these tests inject a test key + marker and assert
// window behavior through the public API rather than by reading the raw file.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_LIMIT_BRL_CENTS,
  DEFAULT_PER_TX_LIMIT_BRL_CENTS,
  GUARDRAILS_STATE_FILE,
  Guardrails,
  resolveGuardrailConfig,
  type GuardrailConfig
} from "../src/guardrails/guardrails.js";
import { GuardrailError, isDepixSdkError } from "../src/errors.js";
import { InMemoryMarker, keyProvider } from "./guardrail-utils.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-guardrails-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function makeGuardrails(
  opts: { now?: () => number; config?: GuardrailConfig; marker?: InMemoryMarker } = {}
): Guardrails {
  return new Guardrails({
    dataDir,
    config: resolveGuardrailConfig(opts.config, {}),
    stateKey: keyProvider(),
    marker: opts.marker ?? new InMemoryMarker(),
    now: opts.now
  });
}

describe("hardcoded defaults (spec §9 PR1 — main NEVER signs without a ceiling)", () => {
  it("defaults are R$100/tx and R$500/day", () => {
    expect(DEFAULT_PER_TX_LIMIT_BRL_CENTS).toBe(10_000);
    expect(DEFAULT_DAILY_LIMIT_BRL_CENTS).toBe(50_000);
    const config = resolveGuardrailConfig(undefined, {});
    expect(config.perTxLimitBrlCents).toBe(10_000);
    expect(config.dailyLimitBrlCents).toBe(50_000);
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
    const guardrails = makeGuardrails({ now: () => clock });
    await guardrails.recordSpend(50_000, "send"); // fill the day
    await expect(guardrails.enforce({ kind: "send", brlCents: 1 })).rejects.toSatisfy(
      (err: unknown) => isDepixSdkError(err, "GUARDRAIL_DAILY_LIMIT")
    );
    clock += 24 * 60 * 60 * 1000 + 1; // 24h + 1ms later
    await expect(guardrails.enforce({ kind: "send", brlCents: 10_000 })).resolves.toBeUndefined();
    await guardrails.recordSpend(1_000, "send");
    // The stale entry was pruned on write — only the fresh R$10 remains.
    expect((await guardrails.usage()).usedCents).toBe(1_000);
  });

  it("persists across restarts (new instance, same encrypted state + dataDir)", async () => {
    const first = makeGuardrails();
    await first.recordSpend(45_000, "send");
    const second = makeGuardrails();
    await expect(second.enforce({ kind: "send", brlCents: 6_000 })).rejects.toSatisfy(
      (err: unknown) => isDepixSdkError(err, "GUARDRAIL_DAILY_LIMIT")
    );
    await expect(second.enforce({ kind: "send", brlCents: 5_000 })).resolves.toBeUndefined();
    expect((await second.usage()).usedCents).toBe(45_000);
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

describe("state file handling (§4.5 — fresh-wallet semantics without a marker)", () => {
  it("missing state (fresh wallet, no marker yet) counts as an empty window", async () => {
    const guardrails = makeGuardrails();
    await expect(guardrails.enforce({ kind: "send", brlCents: 10_000 })).resolves.toBeUndefined();
  });

  it("corrupted state WITHOUT a marker is surfaced as an empty window", async () => {
    await writeFile(join(dataDir, GUARDRAILS_STATE_FILE), "{corrupt", "utf8");
    const guardrails = makeGuardrails({ marker: new InMemoryMarker(false) });
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

describe("concurrent recordSpend is atomic (TOCTOU compounding fix — §4.5)", () => {
  it("records EVERY concurrent spend — the read-modify-write does not lose entries", async () => {
    const guardrails = makeGuardrails();
    // Fire 10 recordSpend() in parallel. A lock-free read→push→write would let
    // them read the same base state and clobber each other (last-writer-wins),
    // under-counting the window. The internal write-mutex serializes the RMW.
    await Promise.all(Array.from({ length: 10 }, () => guardrails.recordSpend(1_000, "send")));
    expect((await guardrails.usage()).usedCents).toBe(10_000); // 10 × R$10 — nothing lost
  });
});
