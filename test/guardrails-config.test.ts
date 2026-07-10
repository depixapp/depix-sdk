// Guardrail config resolution (spec §4.2, G9): option > env > default per
// numeric field; allowlist taken whole from the highest-precedence source;
// immutable at runtime; 0/negative is a config error, disabling requires an
// explicit Number.MAX_SAFE_INTEGER.
import { describe, expect, it } from "vitest";
import { resolveGuardrailConfig } from "../src/guardrails/config.js";
import { isDepixSdkError } from "../src/errors.js";

const EMPTY: NodeJS.ProcessEnv = {};

describe("defaults (no option, no env)", () => {
  it("is R$100/tx + R$500/day with the allowlist DISABLED", () => {
    const c = resolveGuardrailConfig(undefined, EMPTY);
    expect(c.perTxLimitBrlCents).toBe(10_000);
    expect(c.dailyLimitBrlCents).toBe(50_000);
    expect(c.allowlist.enabled).toBe(false);
    expect(c.allowlist.liquidAddresses).toEqual([]);
    expect(c.allowlist.allowLightning).toBe(false);
  });
});

describe("option config", () => {
  it("overrides both ceilings", () => {
    const c = resolveGuardrailConfig(
      { perTxLimitBrlCents: 2_000, dailyLimitBrlCents: 9_000 },
      EMPTY
    );
    expect(c.perTxLimitBrlCents).toBe(2_000);
    expect(c.dailyLimitBrlCents).toBe(9_000);
  });

  it("carries an allowlist through", () => {
    const c = resolveGuardrailConfig(
      { allowlist: { enabled: true, pixKeys: ["a@b.com"], allowLightning: true } },
      EMPTY
    );
    expect(c.allowlist.enabled).toBe(true);
    expect(c.allowlist.pixKeys).toEqual(["a@b.com"]);
    expect(c.allowlist.allowLightning).toBe(true);
  });
});

describe("env config (spec §4.2 names)", () => {
  it("reads DEPIX_GUARDRAIL_PER_TX_BRL_CENTS / DEPIX_GUARDRAIL_DAILY_BRL_CENTS", () => {
    const c = resolveGuardrailConfig(undefined, {
      DEPIX_GUARDRAIL_PER_TX_BRL_CENTS: "1500",
      DEPIX_GUARDRAIL_DAILY_BRL_CENTS: "40000"
    });
    expect(c.perTxLimitBrlCents).toBe(1_500);
    expect(c.dailyLimitBrlCents).toBe(40_000);
  });

  it("reads DEPIX_GUARDRAIL_ALLOWLIST as JSON", () => {
    const c = resolveGuardrailConfig(undefined, {
      DEPIX_GUARDRAIL_ALLOWLIST: JSON.stringify({ enabled: true, btcAddresses: ["bc1xyz"] })
    });
    expect(c.allowlist.enabled).toBe(true);
    expect(c.allowlist.btcAddresses).toEqual(["bc1xyz"]);
  });

  it("malformed allowlist JSON is a config error", () => {
    expect(() =>
      resolveGuardrailConfig(undefined, { DEPIX_GUARDRAIL_ALLOWLIST: "{not json" })
    ).toThrow();
    try {
      resolveGuardrailConfig(undefined, { DEPIX_GUARDRAIL_ALLOWLIST: "{not json" });
    } catch (err) {
      expect(isDepixSdkError(err, "GUARDRAIL_CONFIG_INVALID")).toBe(true);
    }
  });
});

describe("precedence: option > env > default (per numeric field)", () => {
  it("option perTx wins, env daily fills the field option omitted", () => {
    const c = resolveGuardrailConfig(
      { perTxLimitBrlCents: 3_000 },
      { DEPIX_GUARDRAIL_PER_TX_BRL_CENTS: "111", DEPIX_GUARDRAIL_DAILY_BRL_CENTS: "22222" }
    );
    expect(c.perTxLimitBrlCents).toBe(3_000); // option beats env
    expect(c.dailyLimitBrlCents).toBe(22_222); // env beats default
  });

  it("option allowlist wins over env allowlist (taken whole)", () => {
    const c = resolveGuardrailConfig(
      { allowlist: { enabled: false } },
      { DEPIX_GUARDRAIL_ALLOWLIST: JSON.stringify({ enabled: true, pixKeys: ["x"] }) }
    );
    expect(c.allowlist.enabled).toBe(false);
    expect(c.allowlist.pixKeys).toEqual([]);
  });
});

describe("validation — 0/negative is a config error, MAX_SAFE_INTEGER disables (§4.2)", () => {
  it("rejects 0 and negative ceilings with GUARDRAIL_CONFIG_INVALID", () => {
    for (const bad of [0, -1, -10_000]) {
      try {
        resolveGuardrailConfig({ perTxLimitBrlCents: bad }, EMPTY);
        expect.unreachable(`should reject perTx ${bad}`);
      } catch (err) {
        expect(isDepixSdkError(err, "GUARDRAIL_CONFIG_INVALID")).toBe(true);
      }
    }
  });

  it("rejects non-integer / non-finite ceilings", () => {
    for (const bad of [1.5, NaN, Infinity]) {
      expect(() => resolveGuardrailConfig({ dailyLimitBrlCents: bad }, EMPTY)).toThrow();
    }
  });

  it("rejects env ceilings that are not non-negative integer strings", () => {
    expect(() =>
      resolveGuardrailConfig(undefined, { DEPIX_GUARDRAIL_PER_TX_BRL_CENTS: "-5" })
    ).toThrow();
    expect(() =>
      resolveGuardrailConfig(undefined, { DEPIX_GUARDRAIL_DAILY_BRL_CENTS: "1.5" })
    ).toThrow();
    expect(() =>
      resolveGuardrailConfig(undefined, { DEPIX_GUARDRAIL_DAILY_BRL_CENTS: "0" })
    ).toThrow();
  });

  it("accepts Number.MAX_SAFE_INTEGER as the explicit 'disable this ceiling' value", () => {
    const c = resolveGuardrailConfig(
      { perTxLimitBrlCents: Number.MAX_SAFE_INTEGER, dailyLimitBrlCents: Number.MAX_SAFE_INTEGER },
      EMPTY
    );
    expect(c.perTxLimitBrlCents).toBe(Number.MAX_SAFE_INTEGER);
    expect(c.dailyLimitBrlCents).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects a malformed allowlist object", () => {
    expect(() =>
      resolveGuardrailConfig({ allowlist: { enabled: "yes" as unknown as boolean } }, EMPTY)
    ).toThrow();
    expect(() =>
      resolveGuardrailConfig(
        { allowlist: { enabled: true, pixKeys: [1 as unknown as string] } },
        EMPTY
      )
    ).toThrow();
  });
});

describe("immutability at runtime (G9)", () => {
  it("the resolved config and its allowlist arrays are deeply frozen", () => {
    const c = resolveGuardrailConfig(
      { allowlist: { enabled: true, liquidAddresses: ["lq1abc"] } },
      EMPTY
    );
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.allowlist)).toBe(true);
    expect(Object.isFrozen(c.allowlist.liquidAddresses)).toBe(true);
    expect(() => {
      (c as { perTxLimitBrlCents: number }).perTxLimitBrlCents = 999_999;
    }).toThrow(TypeError);
    expect(() => {
      (c.allowlist.liquidAddresses as string[]).push("lq1evil");
    }).toThrow(TypeError);
    // No mutation leaked through.
    expect(c.perTxLimitBrlCents).toBe(10_000);
    expect(c.allowlist.liquidAddresses).toEqual(["lq1abc"]);
  });
});
