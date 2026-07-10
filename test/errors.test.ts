import { describe, expect, it } from "vitest";
import {
  DepixSdkError,
  GuardrailError,
  SideShiftApiError,
  WalletError,
  isDepixSdkError
} from "../src/errors.js";

describe("typed error hierarchy (spec §7.1)", () => {
  it("DepixSdkError carries a stable code and message", () => {
    const err = new DepixSdkError("SOME_CODE", "something happened");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("SOME_CODE");
    expect(err.message).toBe("something happened");
    expect(err.name).toBe("DepixSdkError");
  });

  it("WalletError is a DepixSdkError", () => {
    const err = new WalletError("WALLET_NOT_FOUND", "no wallet");
    expect(err).toBeInstanceOf(DepixSdkError);
    expect(err).toBeInstanceOf(WalletError);
    expect(err.code).toBe("WALLET_NOT_FOUND");
    expect(err.name).toBe("WalletError");
  });

  it("GuardrailError exposes structured limit details", () => {
    const err = new GuardrailError("GUARDRAIL_PER_TX_LIMIT", "per-tx limit exceeded", {
      details: { limitCents: 10_000, attemptedCents: 12_000, usedCents: 0 }
    });
    expect(err).toBeInstanceOf(DepixSdkError);
    expect(err.details).toEqual({
      limitCents: 10_000,
      attemptedCents: 12_000,
      usedCents: 0
    });
  });

  it("preserves the cause chain", () => {
    const cause = new Error("io failure");
    const err = new WalletError("BROADCAST_FAILED", "broadcast failed", { cause });
    expect(err.cause).toBe(cause);
  });

  it("SideShiftApiError is a provider-transport DepixSdkError carrying status/body (§5.4)", () => {
    const err = new SideShiftApiError("Below the minimum amount", { status: 400, body: { error: { message: "x" } } });
    expect(err).toBeInstanceOf(DepixSdkError);
    expect(err).toBeInstanceOf(SideShiftApiError);
    expect(err.code).toBe("SIDESHIFT_API_ERROR");
    expect(err.name).toBe("SideShiftApiError");
    expect(err.status).toBe(400);
    expect(err.body).toEqual({ error: { message: "x" } });
    // Distinct from the WS SideSwapError — different provider, different class.
    expect(err.constructor.name).toBe("SideShiftApiError");
  });

  it("isDepixSdkError discriminates by code", () => {
    const err = new WalletError("WRONG_PASSPHRASE", "bad passphrase");
    expect(isDepixSdkError(err)).toBe(true);
    expect(isDepixSdkError(err, "WRONG_PASSPHRASE")).toBe(true);
    expect(isDepixSdkError(err, "WEAK_PASSPHRASE")).toBe(false);
    expect(isDepixSdkError(new Error("plain"))).toBe(false);
    expect(isDepixSdkError(null)).toBe(false);
  });
});
