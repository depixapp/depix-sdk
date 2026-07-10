// Allowlist destination classes (spec §4.3): with the allowlist ON, each
// signing op validates its FINAL destination against the matching opt-in class;
// a non-opt-in / unrepresentable class is fail-closed. Verified protocol-bound
// destinations are exempt. OFF (default) → everything passes the value ceilings
// only.
import { describe, expect, it } from "vitest";
import { AllowlistMatcher, type GuardrailDestination } from "../src/guardrails/allowlist.js";
import { resolveGuardrailConfig, type GuardrailAllowlist } from "../src/guardrails/config.js";
import {
  Address,
  buildWollet,
  descriptorFromMnemonic
} from "../src/engine/lwk.js";
import { GuardrailError, isDepixSdkError } from "../src/errors.js";

const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// Two real mainnet confidential addresses from the golden mnemonic, plus the
// explicit (unconfidential ex1) form of the first — same scriptPubkey.
const wollet = buildWollet(descriptorFromMnemonic(KNOWN_MNEMONIC));
const ADDR0_LQ1 = wollet.address(0).address().toString();
const ADDR1_LQ1 = wollet.address(1).address().toString();
const ADDR0_EX1 = new Address(ADDR0_LQ1).toUnconfidential().toString();

function matcherFor(allowlist: GuardrailAllowlist): AllowlistMatcher {
  return new AllowlistMatcher(resolveGuardrailConfig({ allowlist }, {}).allowlist);
}

function expectBlocked(fn: () => void, cls: string): void {
  try {
    fn();
    expect.unreachable("should have blocked");
  } catch (err) {
    expect(isDepixSdkError(err, "GUARDRAIL_ALLOWLIST_BLOCKED"), String(err)).toBe(true);
    expect((err as GuardrailError).details?.class).toBe(cls);
  }
}

describe("allowlist DISABLED (default)", () => {
  it("passes everything, including unknown/empty destinations", () => {
    const m = matcherFor({ enabled: false });
    expect(m.enabled).toBe(false);
    expect(() => m.check([{ kind: "liquidAddress", address: ADDR1_LQ1 }])).not.toThrow();
    expect(() => m.check([{ kind: "pixKey", pixKey: "anything" }])).not.toThrow();
    expect(() => m.check([])).not.toThrow();
  });
});

describe("allowlist ENABLED — empty destinations is fail-closed", () => {
  it("blocks an operation that declares no destination class", () => {
    const m = matcherFor({ enabled: true });
    expectBlocked(() => m.check([]), "unspecified");
  });
});

describe("protocol-bound destinations are exempt by construction", () => {
  it("passes even when the allowlist opts in nothing", () => {
    const m = matcherFor({ enabled: true });
    expect(() => m.check([{ kind: "protocolBound", note: "SideSwap taker_sign" }])).not.toThrow();
  });
});

describe("liquidAddresses — matched by scriptPubkey (lq1/ex1 of the same script match)", () => {
  it("opt-in address passes in BOTH its confidential and explicit forms", () => {
    const m = matcherFor({ enabled: true, liquidAddresses: [ADDR0_LQ1] });
    expect(() => m.check([{ kind: "liquidAddress", address: ADDR0_LQ1 }])).not.toThrow();
    // ex1 form of the same script matches the lq1 entry.
    expect(() => m.check([{ kind: "liquidAddress", address: ADDR0_EX1 }])).not.toThrow();
  });

  it("matches lq1 when the allowlist holds the ex1 form (reverse direction)", () => {
    const m = matcherFor({ enabled: true, liquidAddresses: [ADDR0_EX1] });
    expect(() => m.check([{ kind: "liquidAddress", address: ADDR0_LQ1 }])).not.toThrow();
  });

  it("blocks a Liquid address that is not in the list", () => {
    const m = matcherFor({ enabled: true, liquidAddresses: [ADDR0_LQ1] });
    expectBlocked(() => m.check([{ kind: "liquidAddress", address: ADDR1_LQ1 }]), "liquidAddress");
  });

  it("blocks the class entirely when it is not opted in (list absent/empty)", () => {
    const m = matcherFor({ enabled: true });
    expectBlocked(() => m.check([{ kind: "liquidAddress", address: ADDR0_LQ1 }]), "liquidAddress");
  });

  it("blocks an unparseable destination address (fail-closed)", () => {
    const m = matcherFor({ enabled: true, liquidAddresses: [ADDR0_LQ1] });
    expectBlocked(() => m.check([{ kind: "liquidAddress", address: "not-an-address" }]), "liquidAddress");
  });

  it("an unparseable allowlist entry fails config at construction (GUARDRAIL_CONFIG_INVALID)", () => {
    try {
      matcherFor({ enabled: true, liquidAddresses: ["not-a-liquid-address"] });
      expect.unreachable("should have thrown at construction");
    } catch (err) {
      expect(isDepixSdkError(err, "GUARDRAIL_CONFIG_INVALID")).toBe(true);
    }
  });
});

describe("pixKeys — exact normalized match", () => {
  it("passes an opted-in key (case-insensitive/trimmed), blocks others and non-opt-in", () => {
    const m = matcherFor({ enabled: true, pixKeys: ["USER@Example.com"] });
    expect(() => m.check([{ kind: "pixKey", pixKey: " user@example.com " }])).not.toThrow();
    expectBlocked(() => m.check([{ kind: "pixKey", pixKey: "other@x.com" }]), "pixKey");
    const noKeys = matcherFor({ enabled: true });
    expectBlocked(() => noKeys.check([{ kind: "pixKey", pixKey: "user@example.com" }]), "pixKey");
  });
});

describe("allowLightning — the boolean is the opt-in", () => {
  it("passes when true, blocks when the flag is off", () => {
    const on = matcherFor({ enabled: true, allowLightning: true });
    expect(() => on.check([{ kind: "lightning" }])).not.toThrow();
    const off = matcherFor({ enabled: true });
    expectBlocked(() => off.check([{ kind: "lightning" }]), "lightning");
  });
});

describe("btcAddresses — SideSwap peg-out recv_addr", () => {
  it("passes an opted-in BTC address, blocks others and non-opt-in", () => {
    const m = matcherFor({ enabled: true, btcAddresses: ["bc1qexamplepegoutaddress"] });
    expect(() => m.check([{ kind: "btcAddress", address: "bc1qexamplepegoutaddress" }])).not.toThrow();
    expectBlocked(() => m.check([{ kind: "btcAddress", address: "bc1qother" }]), "btcAddress");
    const none = matcherFor({ enabled: true });
    expectBlocked(() => none.check([{ kind: "btcAddress", address: "bc1qexamplepegoutaddress" }]), "btcAddress");
  });

  it("matches bech32 case-INSENSITIVELY (BIP173) — no spurious fail-closed block (review low)", () => {
    // Owner allowlists uppercase; a peg-out (§5.2) supplies the lowercase form.
    const m = matcherFor({ enabled: true, btcAddresses: ["BC1QEXAMPLEPEGOUTADDRESS"] });
    expect(() => m.check([{ kind: "btcAddress", address: "bc1qexamplepegoutaddress" }])).not.toThrow();
    // And the reverse: lowercase entry, uppercase destination.
    const m2 = matcherFor({ enabled: true, btcAddresses: ["bc1qexamplepegoutaddress"] });
    expect(() => m2.check([{ kind: "btcAddress", address: "BC1QEXAMPLEPEGOUTADDRESS" }])).not.toThrow();
    // A genuinely different address is still blocked.
    expectBlocked(() => m2.check([{ kind: "btcAddress", address: "BC1QOTHER" }]), "btcAddress");
  });
});

describe("evmAddresses — Boltz stablecoin settle (case-insensitive)", () => {
  it("passes a checksummed address against a lowercase entry, blocks others", () => {
    const m = matcherFor({ enabled: true, evmAddresses: ["0xabc0000000000000000000000000000000000def"] });
    expect(() =>
      m.check([{ kind: "evmAddress", address: "0xABC0000000000000000000000000000000000DEF" }])
    ).not.toThrow();
    expectBlocked(
      () => m.check([{ kind: "evmAddress", address: "0x1111111111111111111111111111111111111111" }]),
      "evmAddress"
    );
    const none = matcherFor({ enabled: true });
    expectBlocked(
      () => none.check([{ kind: "evmAddress", address: "0xabc0000000000000000000000000000000000def" }]),
      "evmAddress"
    );
  });
});

describe("tronAddresses — Boltz stablecoin settle (Tron TRC-20, base58 case-SENSITIVE)", () => {
  const TRON = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";
  it("matches EXACTLY and never lowercases (base58check is case-significant)", () => {
    const m = matcherFor({ enabled: true, tronAddresses: [TRON] });
    expect(() => m.check([{ kind: "tronAddress", address: TRON }])).not.toThrow();
    // Same address lower-cased is a DIFFERENT (invalid) base58 string — must NOT match.
    expectBlocked(() => m.check([{ kind: "tronAddress", address: TRON.toLowerCase() }]), "tronAddress");
    expectBlocked(() => m.check([{ kind: "tronAddress", address: "TOtherAddress0000000000000000000000" }]), "tronAddress");
    const none = matcherFor({ enabled: true });
    expectBlocked(() => none.check([{ kind: "tronAddress", address: TRON }]), "tronAddress");
  });
});

describe("giftcardBeneficiaries — CryptoRefills beneficiary_account", () => {
  it("passes an opted-in beneficiary, blocks others and non-opt-in", () => {
    const m = matcherFor({ enabled: true, giftcardBeneficiaries: ["acct-123"] });
    expect(() => m.check([{ kind: "giftcardBeneficiary", beneficiary: "acct-123" }])).not.toThrow();
    expectBlocked(
      () => m.check([{ kind: "giftcardBeneficiary", beneficiary: "acct-999" }]),
      "giftcardBeneficiary"
    );
    const none = matcherFor({ enabled: true });
    expectBlocked(
      () => none.check([{ kind: "giftcardBeneficiary", beneficiary: "acct-123" }]),
      "giftcardBeneficiary"
    );
  });
});

describe("sideshiftRefundAddresses — SideShift refundAddress", () => {
  it("passes an opted-in refund address, blocks others and non-opt-in", () => {
    const m = matcherFor({ enabled: true, sideshiftRefundAddresses: ["ref-addr-1"] });
    expect(() => m.check([{ kind: "sideshiftRefundAddress", address: "ref-addr-1" }])).not.toThrow();
    expectBlocked(
      () => m.check([{ kind: "sideshiftRefundAddress", address: "ref-addr-2" }]),
      "sideshiftRefundAddress"
    );
    const none = matcherFor({ enabled: true });
    expectBlocked(
      () => none.check([{ kind: "sideshiftRefundAddress", address: "ref-addr-1" }]),
      "sideshiftRefundAddress"
    );
  });
});

describe("combined checks — gift card needs BOTH lightning AND beneficiary (§4.3)", () => {
  it("passes when both are opted in", () => {
    const m = matcherFor({
      enabled: true,
      allowLightning: true,
      giftcardBeneficiaries: ["acct-123"]
    });
    const dests: GuardrailDestination[] = [
      { kind: "lightning" },
      { kind: "giftcardBeneficiary", beneficiary: "acct-123" }
    ];
    expect(() => m.check(dests)).not.toThrow();
  });

  it("blocks when the beneficiary is missing even though lightning is allowed", () => {
    const m = matcherFor({ enabled: true, allowLightning: true });
    const dests: GuardrailDestination[] = [
      { kind: "lightning" },
      { kind: "giftcardBeneficiary", beneficiary: "acct-123" }
    ];
    expectBlocked(() => m.check(dests), "giftcardBeneficiary");
  });
});
