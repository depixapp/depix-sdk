// @depixapp/sdk — non-custodial Liquid wallet SDK for AI agents (F3).
// Public surface of PR1 (wallet core) + PR2 (Pix flows: deposit/withdraw,
// idempotent resume, API client, webhook verification). Conversions, gift
// cards and the local MCP facade arrive in PR3+.

export {
  DepixWallet,
  type BackupTarget,
  type CreateOptions,
  type CreateResult,
  type DepositParams,
  type DepositResult,
  type MnemonicBackup,
  type OpenOptions,
  type RestoreOptions,
  type ResumeSummary,
  type SendParams,
  type SendResult,
  type WalletBalances,
  type WalletSyncOptions,
  type WalletTransaction,
  type WithdrawParams,
  type WithdrawResult
} from "./wallet.js";

export {
  DepixApiError,
  DepixSdkError,
  GuardrailError,
  WalletError,
  WithdrawContractError,
  isDepixSdkError,
  type DepixApiErrorDetails,
  type DepixApiErrorInit,
  type ErrorDetails,
  type GuardrailDetails
} from "./errors.js";

export {
  DepixApiClient,
  DEFAULT_API_BASE,
  type ApiClientOptions,
  type DepositRequestBody,
  type DepositWireResponse,
  type FetchLike,
  type StatusReadResponse,
  type WithdrawRequestBody,
  type WithdrawWireResponse
} from "./api/client.js";

export { type WaitOptions } from "./flows/status.js";
export { type WithdrawMode } from "./flows/withdraw.js";
export { verifyWebhookSignature, type VerifyWebhookOptions } from "./webhooks.js";

export { ASSETS, DEPIX_SATS_PER_BRL_CENT, type AssetInfo, type AssetKey } from "./assets.js";

export {
  DEFAULT_ESPLORA_PROVIDERS,
  type EsploraProvider
} from "./sync/sync.js";

export {
  DEFAULT_DAILY_LIMIT_BRL_CENTS,
  DEFAULT_PER_TX_LIMIT_BRL_CENTS,
  resolveGuardrailConfig,
  type GuardrailAllowlist,
  type GuardrailConfig,
  type GuardrailDestination,
  type GuardrailIntent,
  type GuardrailUsage,
  type ResolvedGuardrailConfig
} from "./guardrails/guardrails.js";

export {
  QuotesClient,
  type Quotes,
  type QuotesClientOptions,
  type QuotesSource
} from "./guardrails/quotes.js";

export { createLogger, registerSecret, type Logger, type LogLevel } from "./logger.js";

export { type RitualIo } from "./backup-ritual.js";
