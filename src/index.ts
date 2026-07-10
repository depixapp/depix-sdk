// @depixapp/sdk — non-custodial Liquid wallet SDK for AI agents (F3).
// Public surface of PR1 (wallet core) + PR2 (Pix flows: deposit/withdraw,
// idempotent resume, API client, webhook verification). Conversions, gift
// cards and the local MCP facade arrive in PR3+.

export {
  DepixWallet,
  type BackupTarget,
  type ConversionResumeSummary,
  type CreateOptions,
  type CreateResult,
  type DepositParams,
  type DepositResult,
  type GiftcardsWalletOptions,
  type GuardrailReadout,
  type MnemonicBackup,
  type OpenOptions,
  type PegInResumeSummary,
  type PendingBoltzSwapItem,
  type PendingConversionPlanItem,
  type PendingItem,
  type PendingItemBase,
  type PendingPegInItem,
  type PendingSideShiftItem,
  type PendingWithdrawalItem,
  type RecoverySummary,
  type RestoreOptions,
  type ResumeSummary,
  type SendParams,
  type SendResult,
  type SideShiftResumeSummary,
  type WalletBalances,
  type WalletSyncOptions,
  type WalletTransaction,
  type WithdrawParams,
  type WithdrawResult
} from "./wallet.js";

export {
  BoltzApiError,
  ConversionError,
  CryptorefillsApiError,
  DepixApiError,
  DepixSdkError,
  GuardrailError,
  MerchantError,
  SideShiftApiError,
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
  type StoredReverseSwap,
  // Boltz stablecoin (§5.3, PR5b — L-BTC → USDC/USDT EVM)
  boltzVariantKey,
  checkStablecoinAmount,
  estimateStablecoinOut,
  isValidTronAddress,
  mapChainSwapStatus,
  // prepareStablecoinRoute / PreparedStablecoinRoute are intentionally NOT
  // re-exported (kept internal): the primitive returns the raw ephemeral EVM key
  // bytes, a footgun on the public surface. The public entry point is toStablecoin.
  refundChainSwap,
  BOLTZ_STABLECOIN_NETWORKS,
  MAX_CHAIN_TIMEOUT_BLOCKS,
  STABLECOIN_MAX_FEE_RATIO,
  type StablecoinAsset,
  type StablecoinParams,
  type ToStablecoinResult,
  type StablecoinOutcome,
  type StablecoinEstimate,
  type CheckStablecoinAmountResult,
  type StoredStablecoinSwap,
  type ChainRefundRecord
} from "./convert/boltz/index.js";

export {
  DepixApiClient,
  DEFAULT_API_BASE,
  type ApiClientOptions,
  type DepositRequestBody,
  type DepositWireResponse,
  type FetchLike,
  type MeWireResponse,
  type MerchantUpdateWireBody,
  type MerchantUpdateWireResponse,
  type StatusReadResponse,
  type WithdrawRequestBody,
  type WithdrawWireResponse
} from "./api/client.js";

// ─── merchant light-profile (§5.6): wallet.merchant.* ────────────────────────
export {
  MerchantNamespace,
  type MerchantProfile,
  type MerchantUpdateFields,
  type MerchantUpdateResult
} from "./merchant.js";

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
// The high-level intent layer (PR-B): wallet.quote() + callable wallet.convert().
export {
  enumerateRoutes,
  type IntentAsset,
  type IntentNetwork,
  type Route,
  type RouteLeg,
  type RouteMethod,
  type RouteProvider,
  type RouteSelector
} from "./convert/routes.js";
export {
  convertIntent,
  quoteRoutes,
  intentDepsFromNamespace,
  makeConvertFacade,
  type ConvertFacade,
  type ConvertFunding,
  type ConvertIntent,
  type ConvertIntentOptions,
  type ConvertParams,
  type ConvertResult,
  type ConvertStatus,
  type IntentBoltz,
  type IntentDeps,
  type IntentQuoteStream,
  type IntentSideshift,
  type IntentSideswap,
  type RouteLegQuote,
  type RouteQuote
} from "./convert/intent.js";
// Multi-hop execution (PR-C): durable encrypted plans + crash recovery.
// runAsPlanContinuation/activePlanContinuation (continuation.ts) are
// deliberately NOT exported: entering the count-once context is reserved to
// the multi-hop executor — a public entry point would be a guardrail bypass.
export {
  ConversionPlanStore,
  CONVERSION_PLANS_FILE,
  type ConversionPlanState,
  type ConversionPlanStoreOptions,
  type ConversionPlanStoreReadAll,
  type PlanLegState,
  type StoredConversionPlan,
  type StoredPlanIntent,
  type StoredPlanLegResult,
  type StoredPlanParams
} from "./convert/plan-store.js";
export {
  firstValueLegIndex,
  listPendingPlans,
  resumeConversionPlans,
  type PendingPlanDescriptor,
  type PlanResumeSummary
} from "./convert/multihop.js";
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
// SideShift (§5.4) — USDt cross-network, CUSTODIAL (signalled, G4).
export {
  SideShiftNamespace,
  SIDESHIFT_API_BASE,
  SIDESHIFT_ORDER_URL,
  SHIFT_STATUS,
  USDT_NETWORKS,
  coinIdForNetwork,
  getNetwork,
  validateNetworkAddress,
  settleDestinationForNetwork,
  isShiftPending,
  isShiftTerminal,
  isShiftInRefund,
  usdtSatsToDecimal,
  usdtDecimalToSats,
  requestQuote,
  createFixedShift,
  createVariableShift,
  fetchShift,
  setRefundAddressRequest,
  type SideShiftNamespaceDeps,
  type SideShiftQuote,
  type SideShiftSendResult,
  type SideShiftReceiveResult,
  type SideShiftStatusResult,
  type UsdtNetwork,
  type SendUsdt
} from "./convert/sideshift.js";
export {
  SideShiftStore,
  SIDESHIFT_SHIFTS_FILE,
  MAX_STORED_SHIFTS,
  type StoredSideShift,
  type ShiftType
} from "./convert/sideshift-store.js";

// ─── gift cards (§5.5): wallet.giftcards.* ───────────────────────────────────
export {
  GiftcardsNamespace,
  type BuyGiftcardParams,
  type BuyGiftcardResult,
  type GiftcardCatalog,
  type GiftcardsNamespaceDeps,
  type ListGiftcardsParams
} from "./giftcards/namespace.js";
export {
  CryptorefillsClient,
  CRYPTOREFILLS_API_BASE,
  DEFAULT_COUNTRY,
  LIGHTNING_PAYMENT,
  SUPPORTED_BRAND_KINDS,
  EXTERNAL_CHECKOUT_CATEGORIES,
  computeGiftcardFeeSats,
  buildLightningOrderBody,
  beneficiaryOf,
  extractLightningInvoice,
  extractDelivery,
  mapOrderStatus,
  normalizeBrands,
  filterBrands,
  isRangeProduct,
  orderDenomination,
  requiresExternalCheckout,
  cryptorefillsBrandUrl,
  isLightningRailAvailable,
  type CryptorefillsBrand,
  type CryptorefillsBrandsRaw,
  type CryptorefillsClientOptions,
  type CryptorefillsFetch,
  type CryptorefillsFetchResponse,
  type CryptorefillsOrder,
  type LightningOrderBodyParams,
  type NormalizedBrands,
  type OrderDelivery,
  type OrderPhase
} from "./giftcards/cryptorefills.js";
export {
  GiftcardConfigClient,
  resolveGiftcardConfig,
  DISABLED_GIFTCARD_CONFIG,
  type GiftcardConfigClientOptions,
  type GiftcardConfigSource,
  type ResolvedGiftcardConfig
} from "./giftcards/config.js";
export {
  GiftcardOrderStore,
  GIFTCARD_ORDERS_FILE,
  MAX_STORED_ORDERS,
  type StoredGiftcardOrder
} from "./giftcards/store.js";

// ─── local MCP facade (§6): depix-wallet-mcp stdio + createWalletMcpServer ────
// The `wallet_*` tools (G10) run in the agent's environment; the stdio bin is
// src/mcp/stdio.ts. This barrel lets a host embed the same server in-process.
export {
  createWalletMcpServer,
  WALLET_TOOL_NAMES,
  SERVER_NAME as WALLET_MCP_SERVER_NAME,
  SERVER_TITLE as WALLET_MCP_SERVER_TITLE,
  DEFAULT_SERVER_VERSION as WALLET_MCP_DEFAULT_VERSION,
  ToolError,
  mapToolError,
  missingApiKeyError,
  AUTO_RETRY_CODES,
  SCOPES,
  resolveKeyMode,
  resolveMaxWaitSeconds,
  createShutdownHandler,
  SwapStreamRegistry,
  MAX_WAIT_SECONDS_CEILING,
  DEFAULT_WAIT_SECONDS,
  DEFAULT_POLL_INTERVAL_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
  SEND_ASSETS,
  SWAP_QUOTE_DEFAULT_WAIT_SECONDS,
  SWAP_QUOTE_MAX_WAIT_SECONDS,
  STABLECOIN_ASSETS,
  STABLECOIN_NETWORK_IDS,
  type CreateWalletMcpServerOptions,
  type McpWalletFacade,
  type McpConvertFacade,
  type McpBoltzFacade,
  type McpGiftcardsFacade,
  type McpSwapFacade,
  type McpSwapQuoteStream,
  type ToolContext,
  type Scope
} from "./mcp/index.js";
