// Local wallet MCP facade (spec §6) — public surface for programmatic embedding.
// The stdio bin (`depix-wallet-mcp`) is src/mcp/stdio.ts; this barrel lets a host
// build the same server in-process (e.g. to mount it on its own transport).

export {
  createWalletMcpServer,
  WALLET_TOOL_NAMES,
  SERVER_NAME,
  SERVER_TITLE,
  DEFAULT_SERVER_VERSION,
  type CreateWalletMcpServerOptions,
} from "./server.js";

export {
  ToolError,
  mapToolError,
  missingApiKeyError,
  AUTO_RETRY_CODES,
  SCOPES,
  type Scope,
} from "./errors.js";

export {
  type McpWalletFacade,
  type McpConvertFacade,
  type McpBoltzFacade,
  type McpGiftcardsFacade,
  type ToolContext,
} from "./tools.js";

export {
  SwapStreamRegistry,
  ABANDON_GRACE_MS,
  type McpSwapFacade,
  type McpSwapQuoteStream,
} from "./swap-streams.js";

export {
  MAX_WAIT_SECONDS_CEILING,
  DEFAULT_WAIT_SECONDS,
  DEFAULT_POLL_INTERVAL_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
  SEND_ASSETS,
  SWAP_QUOTE_DEFAULT_WAIT_SECONDS,
  SWAP_QUOTE_MAX_WAIT_SECONDS,
  STABLECOIN_ASSETS,
  STABLECOIN_NETWORK_IDS,
} from "./schemas.js";

export {
  resolveKeyMode,
  resolveMaxWaitSeconds,
  createShutdownHandler,
} from "./runtime.js";
