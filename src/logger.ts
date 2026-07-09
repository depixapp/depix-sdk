// Single stderr logger with secret redaction (spec §6.1, ported discipline
// from depix-mcp). In MCP stdio mode STDOUT is the JSON-RPC channel — every
// SDK log line goes to STDERR, always through `redactSecrets`. Never log a
// secret on purpose; the redaction below is defense-in-depth, not permission.

import { inspect } from "node:util";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

// Exact-match secret registry. Wallet code registers the passphrase and the
// decrypted mnemonic here as soon as it sees them, so even an accidental
// interpolation cannot reach stderr in the clear.
const registeredSecrets = new Set<string>();

/** Register a secret value for exact-match redaction in every log line. */
export function registerSecret(value: string | null | undefined): void {
  if (typeof value === "string" && value.length >= 4) {
    registeredSecrets.add(value);
  }
}

/** Test hook — forget every registered secret. */
export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

const SK_KEY_RE = /sk_(live|test)_[A-Za-z0-9]+/g;
// CT descriptor: the slip77 master blinding key lets the holder unblind every
// wallet transaction. Redact the whole descriptor expression.
const CT_DESCRIPTOR_RE = /ct\(slip77\([^)]*\)[^\s"')]*\)?(#[a-z0-9]+)?/g;
const XPRV_RE = /\b[xt]prv[0-9A-Za-z]{20,}/g;

/** Redact API keys, registered secrets, CT descriptors and xprv material. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const secret of registeredSecrets) {
    out = out.split(secret).join("[REDACTED]");
  }
  out = out.replace(SK_KEY_RE, "sk_$1_[REDACTED]");
  out = out.replace(CT_DESCRIPTOR_RE, "[REDACTED_DESCRIPTOR]");
  out = out.replace(XPRV_RE, "[REDACTED_XPRV]");
  return out;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface LoggerOptions {
  /** Minimum level written to stderr. Default: $DEPIX_SDK_LOG_LEVEL ?? "info". */
  level?: LogLevel;
  /** Prefix tag, default "depix-sdk". */
  name?: string;
}

function resolveLevel(explicit?: LogLevel): LogLevel {
  if (explicit) return explicit;
  const env = process.env.DEPIX_SDK_LOG_LEVEL;
  if (env === "debug" || env === "info" || env === "warn" || env === "error") return env;
  return "info";
}

function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  return inspect(arg, { depth: 4, breakLength: Infinity });
}

/** Create a logger. All output goes to STDERR (stdout is JSON-RPC in MCP mode). */
export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVEL_WEIGHT[resolveLevel(options.level)];
  const name = options.name ?? "depix-sdk";

  function write(level: LogLevel, message: string, args: unknown[]): void {
    if (LEVEL_WEIGHT[level] < threshold) return;
    const parts = [message, ...args.map(formatArg)].join(" ");
    const line = `[${name}] ${level} ${redactSecrets(parts)}\n`;
    process.stderr.write(line);
  }

  return {
    debug: (message, ...args) => write("debug", message, args),
    info: (message, ...args) => write("info", message, args),
    warn: (message, ...args) => write("warn", message, args),
    error: (message, ...args) => write("error", message, args)
  };
}

/** Shared default logger for modules that are not handed one explicitly. */
export const defaultLogger: Logger = createLogger();
