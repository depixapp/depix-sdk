// Guardrail configuration — owner-set, immutable in runtime (spec §4.2, G9).
//
// The guardrails are LAYER 1 of the two-layer defense (§4.1): they defend
// against prompt injection / agent hallucination, NOT against a malicious owner
// (who controls the process). So the config is the OWNER's — supplied at
// open()/create() (the `guardrails` option) or via env — and is IMMUTABLE at
// runtime (G9): there is no update method, no MCP tool, nothing an injected LLM
// can call to raise its own ceilings. Changing a limit means editing the
// option/env and restarting.
//
// Precedence (§4.2): option > env > default, resolved per numeric field; the
// allowlist is taken as a whole from the highest-precedence source that
// provides it. `0`/negative is a CONFIG ERROR, never "disabled" — disabling a
// ceiling requires an explicit Number.MAX_SAFE_INTEGER (a conscious owner
// decision, glaring in the diff).

import { GuardrailError } from "../errors.js";

/** R$ 100,00 per transaction (roadmap decision 6). */
export const DEFAULT_PER_TX_LIMIT_BRL_CENTS = 10_000;
/** R$ 500,00 per rolling 24h window (roadmap decision 6, G7). */
export const DEFAULT_DAILY_LIMIT_BRL_CENTS = 50_000;

/** Env names (spec §4.2). */
export const ENV_PER_TX = "DEPIX_GUARDRAIL_PER_TX_BRL_CENTS";
export const ENV_DAILY = "DEPIX_GUARDRAIL_DAILY_BRL_CENTS";
export const ENV_ALLOWLIST = "DEPIX_GUARDRAIL_ALLOWLIST";

/**
 * Owner-facing allowlist (§4.2/§4.3). When `enabled`, every signing operation
 * validates its FINAL destination against the matching opt-in class. A class
 * that is absent (not opted in) is fail-closed — see resolve/allowlist.ts.
 */
export interface GuardrailAllowlist {
  enabled: boolean;
  /** Liquid receive addresses, matched by derived scriptPubkey (lq1/ex1 of the same script match). */
  liquidAddresses?: string[];
  /** Pix keys, matched exact-normalized. */
  pixKeys?: string[];
  /** BOLT11 payee (Boltz submarine, gift card) — the boolean is the opt-in; the payee lives inside the invoice. */
  allowLightning?: boolean;
  /** recv_addr of a SideSwap peg-out (BTC on-chain). */
  btcAddresses?: string[];
  /** settle address of a Boltz stablecoin swap (EVM, PR5b). */
  evmAddresses?: string[];
  /** settle address of a Boltz stablecoin swap (Tron TRC-20, base58 — case-SENSITIVE, exact match). */
  tronAddresses?: string[];
  /** beneficiary_account of a CryptoRefills gift card. */
  giftcardBeneficiaries?: string[];
  /** refundAddress of a SideShift shift. */
  sideshiftRefundAddresses?: string[];
}

/** Owner-facing guardrail config accepted at open()/create() (§4.2). */
export interface GuardrailConfig {
  dailyLimitBrlCents?: number;
  perTxLimitBrlCents?: number;
  /** Default: DISABLED (everything passes the value ceilings only). */
  allowlist?: GuardrailAllowlist;
}

/** Fully-resolved, deeply-frozen allowlist (§4.3). */
export interface ResolvedAllowlist {
  readonly enabled: boolean;
  readonly liquidAddresses: readonly string[];
  readonly pixKeys: readonly string[];
  readonly allowLightning: boolean;
  readonly btcAddresses: readonly string[];
  readonly evmAddresses: readonly string[];
  readonly tronAddresses: readonly string[];
  readonly giftcardBeneficiaries: readonly string[];
  readonly sideshiftRefundAddresses: readonly string[];
}

/** Fully-resolved, deeply-frozen guardrail config — immutable in runtime (G9). */
export interface ResolvedGuardrailConfig {
  readonly perTxLimitBrlCents: number;
  readonly dailyLimitBrlCents: number;
  readonly allowlist: ResolvedAllowlist;
}

function configError(message: string): GuardrailError {
  // Owner misconfiguration surfaced loudly at open() — fail fast, never coerce
  // a bad value into a silent "disabled" (that would remove a ceiling).
  return new GuardrailError("GUARDRAIL_CONFIG_INVALID", message);
}

/**
 * A limit must be a positive safe integer. `0`/negative is a config error, not
 * "off"; disabling requires an explicit Number.MAX_SAFE_INTEGER (§4.2).
 */
function requirePositiveIntLimit(value: number, source: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw configError(
      `${source} must be a positive integer number of BRL cents (got ${String(value)}). ` +
        "0 or negative is not accepted — to remove a ceiling set it explicitly to Number.MAX_SAFE_INTEGER."
    );
  }
  return value;
}

function parseEnvLimit(raw: string | undefined, envName: string): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw configError(`${envName} must be a non-negative integer string of BRL cents (got "${raw}").`);
  }
  return requirePositiveIntLimit(Number(trimmed), envName);
}

function asStringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw configError(`allowlist.${field} must be an array of strings.`);
  }
  return Object.freeze([...(value as string[])]);
}

function resolveAllowlist(input: GuardrailAllowlist | undefined): ResolvedAllowlist {
  if (input === undefined) {
    return Object.freeze({
      enabled: false,
      liquidAddresses: Object.freeze([]),
      pixKeys: Object.freeze([]),
      allowLightning: false,
      btcAddresses: Object.freeze([]),
      evmAddresses: Object.freeze([]),
      tronAddresses: Object.freeze([]),
      giftcardBeneficiaries: Object.freeze([]),
      sideshiftRefundAddresses: Object.freeze([])
    });
  }
  if (typeof input !== "object" || input === null || typeof input.enabled !== "boolean") {
    throw configError("allowlist must be an object with a boolean `enabled` field.");
  }
  if (input.allowLightning !== undefined && typeof input.allowLightning !== "boolean") {
    throw configError("allowlist.allowLightning must be a boolean.");
  }
  return Object.freeze({
    enabled: input.enabled,
    liquidAddresses: asStringArray(input.liquidAddresses, "liquidAddresses"),
    pixKeys: asStringArray(input.pixKeys, "pixKeys"),
    allowLightning: input.allowLightning === true,
    btcAddresses: asStringArray(input.btcAddresses, "btcAddresses"),
    evmAddresses: asStringArray(input.evmAddresses, "evmAddresses"),
    tronAddresses: asStringArray(input.tronAddresses, "tronAddresses"),
    giftcardBeneficiaries: asStringArray(input.giftcardBeneficiaries, "giftcardBeneficiaries"),
    sideshiftRefundAddresses: asStringArray(input.sideshiftRefundAddresses, "sideshiftRefundAddresses")
  });
}

function parseEnvAllowlist(raw: string | undefined): GuardrailAllowlist | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw configError(`${ENV_ALLOWLIST} must be valid JSON (${String((err as Error).message)}).`);
  }
  return parsed as GuardrailAllowlist;
}

/**
 * Resolve the effective guardrail config (§4.2). Reads env (defaults to
 * process.env; injectable for tests). Returns a deeply-frozen object — there is
 * no way to mutate the ceilings after this call (G9).
 */
export function resolveGuardrailConfig(
  option: GuardrailConfig | undefined,
  env: NodeJS.ProcessEnv = process.env
): ResolvedGuardrailConfig {
  const perTx =
    option?.perTxLimitBrlCents !== undefined
      ? requirePositiveIntLimit(option.perTxLimitBrlCents, "guardrails.perTxLimitBrlCents")
      : (parseEnvLimit(env[ENV_PER_TX], ENV_PER_TX) ?? DEFAULT_PER_TX_LIMIT_BRL_CENTS);

  const daily =
    option?.dailyLimitBrlCents !== undefined
      ? requirePositiveIntLimit(option.dailyLimitBrlCents, "guardrails.dailyLimitBrlCents")
      : (parseEnvLimit(env[ENV_DAILY], ENV_DAILY) ?? DEFAULT_DAILY_LIMIT_BRL_CENTS);

  // The per-tx ceiling above the daily ceiling would be dead config (a single
  // tx can never exceed daily anyway). It is not an error, but flag it? Keep it
  // permissive — the owner may intend daily as the only effective bound.

  const allowlistInput =
    option?.allowlist !== undefined ? option.allowlist : parseEnvAllowlist(env[ENV_ALLOWLIST]);

  return Object.freeze({
    perTxLimitBrlCents: perTx,
    dailyLimitBrlCents: daily,
    allowlist: resolveAllowlist(allowlistInput)
  });
}
