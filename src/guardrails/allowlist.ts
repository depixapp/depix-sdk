// Allowlist enforcement over destination classes (spec §4.3).
//
// When the allowlist is ON, every signing operation validates its FINAL
// destination against the matching opt-in class. The corrected review rule
// (verbatim §4.3):
//
//   Destinations that are TRULY protocol-bound and verified — the Eulen address
//   + fee_address from the API's authenticated response, a SideSwap PSET proven
//   to pay OUR OWN script — are exempt by construction (kind "protocolBound").
//   BUT a lockup/peg address being protocol-bound does NOT make the flow exempt:
//   the FINAL destination of those rails is free and chosen by the agent — the
//   BOLT11 payee, the peg-out recv_addr (BTC), the EVM settle address, the gift
//   card beneficiary, the SideShift refundAddress. assertLockupAddressBindsToUser
//   binds the tree to the payment hash of the SUPPLIED invoice; if the invoice
//   is the attacker's, the "verified" lockup pays the attacker. So those final
//   destinations pass through the allowlist.
//
// With the allowlist ON, any destination class that is NOT representable or NOT
// opted in is FAIL-CLOSED → GUARDRAIL_ALLOWLIST_BLOCKED. With it OFF (default),
// everything passes the value ceilings only.

import { Address } from "../engine/lwk.js";
import { GuardrailError } from "../errors.js";
import type { ResolvedAllowlist } from "./config.js";

/**
 * The FINAL destination of a signing operation, tagged with its class (§4.3).
 * `protocolBound` is a verified return-to-self / API-authenticated destination —
 * exempt by construction. Every other kind is checked against its opt-in class.
 */
export type GuardrailDestination =
  | { kind: "liquidAddress"; address: string } // send(), SideShift settle to Liquid
  | { kind: "pixKey"; pixKey: string } // withdraw()
  | { kind: "lightning" } // Boltz submarine / gift-card BOLT11 payee
  | { kind: "btcAddress"; address: string } // SideSwap peg-out recv_addr
  | { kind: "evmAddress"; address: string } // Boltz stablecoin settle (EVM, case-insensitive)
  | { kind: "tronAddress"; address: string } // Boltz stablecoin settle (Tron TRC-20, base58 — case-sensitive)
  | { kind: "giftcardBeneficiary"; beneficiary: string } // CryptoRefills beneficiary_account
  | { kind: "sideshiftRefundAddress"; address: string } // SideShift refundAddress
  | { kind: "protocolBound"; note?: string }; // verified return-to-self / Eulen — exempt

function allowlistError(destClass: string, message: string): GuardrailError {
  return new GuardrailError("GUARDRAIL_ALLOWLIST_BLOCKED", message, {
    details: { class: destClass }
  });
}

/** scriptPubkey hex of a Liquid address (lq1 confidential and ex1 explicit of the same script produce the SAME hex). */
export function liquidScriptHex(address: string): string {
  const addr = new Address(address);
  try {
    const script = addr.scriptPubkey();
    try {
      return script.toString();
    } finally {
      script.free();
    }
  } finally {
    addr.free();
  }
}

const normPixKey = (k: string): string => k.trim().toLowerCase();
const normEvm = (a: string): string => a.trim().toLowerCase();
const normExact = (s: string): string => s.trim();

/**
 * Normalize a BTC address for allowlist matching (review low, allowlist.ts:158).
 * BTC bech32/bech32m (BIP173) is case-INSENSITIVE and only valid as all-lower or
 * all-upper; the canonical form is lowercase. So an owner who allowlists a
 * `bc1…` in one case and a PR4+ peg-out (§5.2) that supplies the other case must
 * still match. We lowercase ONLY bech32 (bc1/tb1/bcrt1 HRP, bech32 charset) —
 * base58 P2PKH/P2SH (`1…`/`3…`) is case-SENSITIVE, so those (and the non-bech32
 * classes: gift-card beneficiary, SideShift refund) stay exact to avoid
 * corrupting a case-significant identifier.
 */
const normBtcAddress = (a: string): string => {
  const t = a.trim();
  return /^(bc1|tb1|bcrt1)[0-9a-z]+$/i.test(t) ? t.toLowerCase() : t;
};

/**
 * Pre-derives normalized lookup sets from the resolved allowlist once (at open
 * time). An invalid liquidAddresses entry fails fast with
 * GUARDRAIL_CONFIG_INVALID — a typo in the owner's allowlist must not silently
 * become an address that matches nothing (which would fail-closed every send).
 */
export class AllowlistMatcher {
  private readonly liquidScripts: ReadonlySet<string>;
  private readonly pixKeys: ReadonlySet<string>;
  private readonly btcAddresses: ReadonlySet<string>;
  private readonly evmAddresses: ReadonlySet<string>;
  private readonly tronAddresses: ReadonlySet<string>;
  private readonly giftcardBeneficiaries: ReadonlySet<string>;
  private readonly sideshiftRefundAddresses: ReadonlySet<string>;

  constructor(private readonly allowlist: ResolvedAllowlist) {
    this.liquidScripts = new Set(
      allowlist.liquidAddresses.map((addr) => {
        try {
          return liquidScriptHex(addr);
        } catch (err) {
          throw new GuardrailError(
            "GUARDRAIL_CONFIG_INVALID",
            `allowlist.liquidAddresses contains an unparseable Liquid address: ${addr}`,
            { cause: err }
          );
        }
      })
    );
    this.pixKeys = new Set(allowlist.pixKeys.map(normPixKey));
    this.btcAddresses = new Set(allowlist.btcAddresses.map(normBtcAddress));
    this.evmAddresses = new Set(allowlist.evmAddresses.map(normEvm));
    // base58check is case-SENSITIVE — store exact (normExact = trim only), never normEvm.
    this.tronAddresses = new Set(allowlist.tronAddresses.map(normExact));
    this.giftcardBeneficiaries = new Set(allowlist.giftcardBeneficiaries.map(normExact));
    this.sideshiftRefundAddresses = new Set(allowlist.sideshiftRefundAddresses.map(normExact));
  }

  get enabled(): boolean {
    return this.allowlist.enabled;
  }

  /**
   * Validate every destination of an intent. No-op when the allowlist is OFF.
   * When ON, an empty destination list is FAIL-CLOSED (a money op that declares
   * no destination class is not representable) and any non-opt-in / unmatched
   * class throws GUARDRAIL_ALLOWLIST_BLOCKED.
   */
  check(destinations: readonly GuardrailDestination[]): void {
    if (!this.allowlist.enabled) return;
    if (destinations.length === 0) {
      throw allowlistError(
        "unspecified",
        "Allowlist is enabled but this operation declared no destination class — fail-closed (§4.3)."
      );
    }
    for (const dest of destinations) this.checkOne(dest);
  }

  private checkOne(dest: GuardrailDestination): void {
    switch (dest.kind) {
      case "protocolBound":
        return; // verified return-to-self / API-authenticated — exempt by construction
      case "liquidAddress": {
        let hex: string;
        try {
          hex = liquidScriptHex(dest.address);
        } catch {
          throw allowlistError(
            "liquidAddress",
            `Destination Liquid address is not parseable — fail-closed (§4.3): ${dest.address}`
          );
        }
        if (!this.liquidScripts.has(hex)) {
          throw allowlistError(
            "liquidAddress",
            `Liquid destination is not in the allowlist (allowlist.liquidAddresses): ${dest.address}`
          );
        }
        return;
      }
      case "pixKey":
        if (!this.pixKeys.has(normPixKey(dest.pixKey))) {
          throw allowlistError("pixKey", `Pix key is not in the allowlist (allowlist.pixKeys).`);
        }
        return;
      case "lightning":
        if (!this.allowlist.allowLightning) {
          throw allowlistError(
            "lightning",
            "Lightning destinations are not opted in (allowlist.allowLightning must be true) — fail-closed (§4.3)."
          );
        }
        return;
      case "btcAddress":
        if (!this.btcAddresses.has(normBtcAddress(dest.address))) {
          throw allowlistError(
            "btcAddress",
            `BTC destination is not in the allowlist (allowlist.btcAddresses): ${dest.address}`
          );
        }
        return;
      case "evmAddress":
        if (!this.evmAddresses.has(normEvm(dest.address))) {
          throw allowlistError(
            "evmAddress",
            `EVM destination is not in the allowlist (allowlist.evmAddresses): ${dest.address}`
          );
        }
        return;
      case "tronAddress":
        // base58check is case-SENSITIVE — EXACT match (trim only), never lowercased.
        if (!this.tronAddresses.has(normExact(dest.address))) {
          throw allowlistError(
            "tronAddress",
            `Tron destination is not in the allowlist (allowlist.tronAddresses): ${dest.address}`
          );
        }
        return;
      case "giftcardBeneficiary":
        if (!this.giftcardBeneficiaries.has(normExact(dest.beneficiary))) {
          throw allowlistError(
            "giftcardBeneficiary",
            "Gift card beneficiary is not in the allowlist (allowlist.giftcardBeneficiaries)."
          );
        }
        return;
      case "sideshiftRefundAddress":
        if (!this.sideshiftRefundAddresses.has(normExact(dest.address))) {
          throw allowlistError(
            "sideshiftRefundAddress",
            "SideShift refund address is not in the allowlist (allowlist.sideshiftRefundAddresses)."
          );
        }
        return;
      default: {
        // Exhaustiveness: an unrepresented class with the allowlist ON is
        // fail-closed by construction.
        const _never: never = dest;
        throw allowlistError(
          "unknown",
          `Unrepresentable destination class — fail-closed (§4.3): ${JSON.stringify(_never)}`
        );
      }
    }
  }
}
