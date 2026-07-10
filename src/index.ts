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
  BoltzApiError,
  ConversionError,
  DepixApiError,
  DepixSdkError,
  GuardrailError,
  SideSwapError,
  WalletError,
  WithdrawContractError,
  isDepixSdkError,
  type DepixApiErrorDetails,
  type DepixApiErrorInit,
  type ErrorDetails,
  type GuardrailDetails
} from "./errors.js";

export {
  BoltzClient,
  BoltzConvert,
  BOLTZ_API_BASE,
  BOLTZ_WS_URL,
  MAX_SUBMARINE_TIMEOUT_BLOCKS,
  decodeInvoiceAmountSats,
  decodeInvoicePaymentHash,
  assertLockupAddressBindsToUser,
  prepareSubmarineSwap,
  refundSubmarineSwap,
  RefundPendingError,
  receiveViaLightning,
  resumeReverseSwap,
  getReverseLimits,
  estimateReverseReceive,
  type BoltzConvertDeps,
  type PayLightningResult,
  type ReceiveLightningResult,
  type SubmarineOutcome,
  type BoltzResumeSummary,
  type PreparedSubmarineSwap,
  type ReverseSwapRecord,
  type ReverseOutcome,
  type StoredBoltzSwap,
  type StoredSubmarineSwap,
  type StoredReverseSwap
} from "./convert/boltz/index.js";

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

// ─── conversions (§5): wallet.convert.* ──────────────────────────────────────
export {
  ConvertNamespace,
  SideSwapNamespace,
  type ConvertNamespaceOptions
} from "./convert/namespace.js";
export {
  SideSwapMarket,
  SwapQuoteStream,
  assertSwapPsetPaysAndBalances,
  inspectSwapPset,
  collectSwapUtxos,
  selectSwapUtxos,
  isTransientBlindingError,
  SS_ERROR,
  type SideSwapQuote,
  type SwapQuoteParams,
  type SwapExecuteResult,
  type SwapPsetInspection,
  type SwapValidationExpectation,
  type NextQuoteOptions
} from "./convert/sideswap.js";
export {
  SideSwapPeg,
  assertPegOutRecipient,
  type PegInResult,
  type PegOutParams,
  type PegOutResult,
  type PegOutRecipient,
  type PegOutRecipientExpectation
} from "./convert/sideswap-peg.js";
export {
  createSideSwapClient,
  SIDESWAP_WS_URL,
  type SideSwapClient,
  type SideSwapClientOptions,
  type SideSwapUtxo,
  type SideSwapQuoteEvent,
  type PegResult,
  type PegStatusResult
} from "./convert/sideswap-client.js";
export {
  PendingPegIn,
  PENDING_PEGIN_TTL_MS,
  type PegInRecord
} from "./convert/pending-pegin.js";
export type { ConvertWalletHooks } from "./convert/hooks.js";
