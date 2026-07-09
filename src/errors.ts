// Typed error hierarchy (spec §7.1). Consumers discriminate on `err.code`
// string literals; classes group codes by domain. `DepixApiError` (HTTP
// envelope of the DePix API), `WithdrawContractError` and `ConversionError`
// arrive with the flows that use them (PR2+ — api client / withdraw contract /
// conversions); this module only declares what PR1 exercises.

/** Structured data attached to an error, safe to surface to callers. */
export type ErrorDetails = Record<string, unknown>;

export interface DepixSdkErrorOptions {
  cause?: unknown;
  details?: ErrorDetails;
}

export class DepixSdkError extends Error {
  readonly code: string;
  readonly details?: ErrorDetails;

  constructor(code: string, message?: string, options?: DepixSdkErrorOptions) {
    super(message ?? code, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "DepixSdkError";
    this.code = code;
    if (options?.details !== undefined) {
      this.details = options.details;
    }
  }
}

/**
 * Wallet lifecycle / engine errors.
 *
 * Codes used in PR1 (see spec §7.1 for the full catalog):
 *   INVALID_MNEMONIC, DESCRIPTOR_MISMATCH, WRONG_PASSPHRASE, WEAK_PASSPHRASE,
 *   WALLET_NOT_FOUND, WALLET_ALREADY_EXISTS, WALLET_DIR_LOCKED,
 *   BACKUP_REQUIRED (§2.9), INVALID_ADDRESS, INVALID_AMOUNT,
 *   UNSUPPORTED_ASSET, INSUFFICIENT_FUNDS, INSUFFICIENT_LBTC_FOR_FEE,
 *   ESPLORA_UNAVAILABLE, BROADCAST_FAILED
 */
export class WalletError extends DepixSdkError {
  constructor(code: string, message?: string, options?: DepixSdkErrorOptions) {
    super(code, message, options);
    this.name = "WalletError";
  }
}

export interface GuardrailDetails extends ErrorDetails {
  limitCents?: number;
  attemptedCents?: number;
  usedCents?: number;
}

/**
 * Guardrail choke-point errors (spec §4).
 *
 * Codes used in PR1: GUARDRAIL_PER_TX_LIMIT, GUARDRAIL_DAILY_LIMIT,
 * GUARDRAIL_INVALID_AMOUNT, QUOTES_UNAVAILABLE.
 * GUARDRAIL_ALLOWLIST_BLOCKED arrives with the allowlist in PR3 (§4.3).
 */
export class GuardrailError extends DepixSdkError {
  declare readonly details?: GuardrailDetails;

  constructor(
    code: string,
    message?: string,
    options?: DepixSdkErrorOptions & { details?: GuardrailDetails }
  ) {
    super(code, message, options);
    this.name = "GuardrailError";
  }
}

/** Narrow an unknown value to a DepixSdkError, optionally matching a code. */
export function isDepixSdkError(err: unknown, code?: string): err is DepixSdkError {
  if (!(err instanceof DepixSdkError)) return false;
  if (code === undefined) return true;
  return err.code === code;
}
