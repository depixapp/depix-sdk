// LWK engine goldens (spec §2.1/§2.2) — bump tripwires.
//
// These tests pin behavior that the SDK inherits from lwk_node and must not
// drift silently on a version bump:
//   1. descriptor golden — signer.wpkhSlip77Descriptor() of a fixed mnemonic
//      produces a known string (the 84h/1776h path comes from LWK, not us);
//   2. restore golden — mnemonic `abandon…about` derives a known addr[0];
//   3. `Pset.addDetails` stays exported AND callable (DePix-requested export,
//      load-bearing for the SideSwap/peg-out flows of PR4+ — memory
//      `lwk_wasm DePix dependency`, extended to lwk_node per SPIKE risk 5).
import { describe, expect, it } from "vitest";
import {
  ASSETS,
  DEPIX_SATS_PER_BRL_CENT,
  MAINNET_ASSET_ID_TO_KEY
} from "../src/assets.js";
import {
  buildWollet,
  descriptorFromMnemonic,
  lwk,
  mainnetNetwork,
  normalizeMnemonic,
  validateMnemonic
} from "../src/engine/lwk.js";
import { WalletError } from "../src/errors.js";

const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// Golden values generated once against lwk_node@0.18.0 (same crate/version as
// the frontend's lwk_wasm pin). If a bump changes any of these, derivation
// changed under our feet — stop the bump and investigate.
const GOLDEN_DESCRIPTOR =
  "ct(slip77(9c8e4f05c7711a98c838be228bcb84924d4570ca53f35fa1c793e58841d47023),elwpkh([73c5da0a/84'/1776'/0']xpub6CRFzUgHFDaiDAQFNX7VeV9JNPDRabq6NYSpzVZ8zW8ANUCiDdenkb1gBoEZuXNZb3wPc1SVcDXgD2ww5UBtTb8s8ArAbTkoRQ8qn34KgcY/<0;1>/*))#87kykuta";
const GOLDEN_ADDR_0 =
  "lq1qqvxk052kf3qtkxmrakx50a9gc3smqad2ync54hzntjt980kfej9kkfe0247rp5h4yzmdftsahhw64uy8pzfe7cpg4fgykm7cv";

// Minimal empty PSET (from the F3 spike) — enough to prove addDetails is
// callable against a real Wollet.
const EMPTY_PSET_B64 = "cHNldP8BAgQCAAAAAQQBAAEFAQABBgEDAfsEAgAAAAA=";

describe("lwk_node engine (spec §2.1)", () => {
  it("descriptor golden: fixed mnemonic derives the known CT descriptor", () => {
    const descriptor = descriptorFromMnemonic(KNOWN_MNEMONIC);
    expect(descriptor).toBe(GOLDEN_DESCRIPTOR);
    // The 1776' coin type comes from LWK, not from our code — assert it so a
    // silent path change fails loudly.
    expect(descriptor).toContain("/84'/1776'/0'");
    expect(descriptor.startsWith("ct(slip77(")).toBe(true);
  });

  it("restore golden: abandon…about derives the known addr[0], deterministically", () => {
    const descriptor = descriptorFromMnemonic(KNOWN_MNEMONIC);
    const wollet = buildWollet(descriptor);
    const addr0 = wollet.address(0).address().toString();
    expect(addr0).toBe(GOLDEN_ADDR_0);
    // Deterministic: a second independent derivation produces the same address.
    const wollet2 = buildWollet(descriptorFromMnemonic(KNOWN_MNEMONIC));
    expect(wollet2.address(0).address().toString()).toBe(GOLDEN_ADDR_0);
    wollet.free();
    wollet2.free();
  });

  it("bump guardian: pset.addDetails(wollet) stays exported and callable", () => {
    expect(typeof lwk.Pset.prototype.addDetails).toBe("function");
    const wollet = buildWollet(descriptorFromMnemonic(KNOWN_MNEMONIC));
    const pset = new lwk.Pset(EMPTY_PSET_B64);
    expect(() => pset.addDetails(wollet)).not.toThrow();
    wollet.free();
  });

  it("normalizeMnemonic trims, collapses whitespace and lowercases (frontend parity)", () => {
    expect(normalizeMnemonic("  Abandon\tABANDON  about \n")).toBe("abandon abandon about");
    expect(normalizeMnemonic(null as unknown as string)).toBe("");
  });

  it("validateMnemonic throws INVALID_MNEMONIC on checksum failure (LWK is the validator)", () => {
    expect(() => validateMnemonic(KNOWN_MNEMONIC)).not.toThrow();
    try {
      validateMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WalletError);
      expect((err as WalletError).code).toBe("INVALID_MNEMONIC");
    }
  });

  it("mainnet network + asset registry are consistent", () => {
    const net = mainnetNetwork();
    expect(net.isMainnet()).toBe(true);
    // L-BTC is the mainnet policy asset.
    expect(net.policyAsset().toString()).toBe(ASSETS.LBTC.id);
    expect(MAINNET_ASSET_ID_TO_KEY[ASSETS.DEPIX.id]).toBe("DEPIX");
    // 1 DePix cent == 10^(8-2) base units (§3.2.5).
    expect(DEPIX_SATS_PER_BRL_CENT).toBe(1_000_000n);
  });
});
