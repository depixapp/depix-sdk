// Boltz Lightning namespace (spec §5.3) — public surface + internals barrel.

export {
  BoltzConvert,
  type BoltzWalletContext,
  type BoltzConvertDeps,
  type PayLightningResult,
  type ReceiveLightningResult,
  type SubmarineOutcome,
  type BoltzResumeSummary
} from "./convert.js";
export { BoltzClient, BOLTZ_API_BASE, BOLTZ_WS_URL, ensureBoltzConfig } from "./client.js";
export { BoltzApiError, ConversionError } from "../../errors.js";
export {
  decodeInvoiceAmountSats,
  decodeInvoicePaymentHash,
  assertLockupNotInflated,
  assertTimeoutInBounds,
  mapSubmarineStatus,
  MAX_SUBMARINE_TIMEOUT_BLOCKS,
  LOCKUP_FEE_MARGIN,
  LOCKUP_FIXED_ALLOWANCE_SATS,
  type SubmarineBucket
} from "./lightning.js";
export { assertLockupAddressBindsToUser, type VerifyLockupParams } from "./verify-lockup.js";
export { prepareSubmarineSwap, type PreparedSubmarineSwap, type PrepareSubmarineDeps } from "./submarine.js";
export {
  refundSubmarineSwap,
  buildSubmarineRefundTx,
  RefundPendingError,
  refundLockTime,
  type RefundResult,
  type RefundDeps,
  type SubmarineRefundRecord
} from "./refund.js";
export {
  receiveViaLightning,
  resumeReverseSwap,
  buildReverseClaimTx,
  getReverseLimits,
  estimateReverseReceive,
  mapReverseStatus,
  REVERSE_PHASE,
  type ReverseSwapRecord,
  type ReverseOutcome,
  type ReverseDeps,
  type ReverseBucket,
  type ReversePhase
} from "./reverse.js";
export { randomKeypair, deriveReverseSecrets, type Keypair } from "./keys.js";
export {
  BoltzSwapStore,
  BOLTZ_SWAPS_FILE,
  type StoredBoltzSwap,
  type StoredSubmarineSwap,
  type StoredReverseSwap
} from "./store.js";
export { resetBoltzConfigForTests } from "./client.js";
export { resetBoltzSecpForTests } from "./secp.js";
