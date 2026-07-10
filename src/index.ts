// @depixapp/sdk — non-custodial Liquid wallet SDK for AI agents (F3).
// Public surface of PR1 (wallet core). Pix flows (deposit/withdraw),
// conversions, gift cards and the local MCP facade arrive in PR2+.

export {
  DepixWallet,
  type BackupTarget,
  type CreateOptions,
  type CreateResult,
  type MnemonicBackup,
  type OpenOptions,
  type RestoreOptions,
  type SendParams,
  type SendResult,
  type WalletBalances,
  type WalletSyncOptions,
  type WalletTransaction
} from "./wallet.js";

export {
  DepixSdkError,
  GuardrailError,
  WalletError,
  isDepixSdkError,
  type ErrorDetails,
  type GuardrailDetails
} from "./errors.js";

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
  DEFAULT_API_BASE,
  QuotesClient,
  type Quotes,
  type QuotesClientOptions,
  type QuotesSource
} from "./guardrails/quotes.js";

export { createLogger, registerSecret, type Logger, type LogLevel } from "./logger.js";

export { type RitualIo } from "./backup-ritual.js";
