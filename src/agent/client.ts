// Signed HTTP client for the agent surface. Unlike DepixApiClient (Bearer
// sk_ key), every request here is authenticated by the Ed25519 identity: the
// X-Agent-* headers are computed per-call over a FRESH nonce (§2.3), so a
// request is single-shot — retrying means re-signing, never replaying the same
// headers (the server's nonce guard is fail-closed). Reuses the same FetchLike
// seam and the shared mapApiError so error shapes stay identical to the rest
// of the SDK.

import {
  DEFAULT_API_BASE,
  mapApiError,
  type FetchLike,
  type FetchResponseLike,
} from "../api/client.js";
import { defaultLogger, type Logger } from "../logger.js";
import { signAgentRequest, type AgentKeypair } from "./keypair.js";

export interface AgentApiClientOptions {
  keypair: AgentKeypair;
  /** Default: $DEPIX_API_BASE ?? https://api.depixapp.com. */
  apiBase?: string;
  /** Advanced/testing: inject the fetch implementation. */
  fetch?: FetchLike;
  logger?: Logger;
  /** Signed-request audience override (must match the server). */
  audience?: string;
  /** Clock injection (unix ms) for deterministic tests. */
  nowMs?: () => number;
}

export interface AgentRequestSpec {
  method: "GET" | "POST";
  /** Path only, e.g. "/api/agents/status". */
  path: string;
  body?: unknown;
}

function normalizeBase(base: string): string {
  return base.replace(/\/+$/, "");
}

function safeJsonParse(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Success envelope MOST agent endpoints return: `{ response: T }`. Not all do —
 * verify-domain replies flat (`{ record_name, … }` / `{ verified_domain }`), so
 * the unwrap falls back to the raw JSON body when no `response` key is present.
 */
interface WireEnvelope<T> {
  response?: T;
}

export class AgentApiClient {
  private readonly keypair: AgentKeypair;
  readonly apiBase: string;
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;
  private readonly audience?: string;
  private readonly nowMs: () => number;

  constructor(options: AgentApiClientOptions) {
    this.keypair = options.keypair;
    this.apiBase = normalizeBase(options.apiBase ?? process.env.DEPIX_API_BASE ?? DEFAULT_API_BASE);
    const injected = options.fetch;
    if (!injected && typeof globalThis.fetch !== "function") {
      throw new Error("No fetch implementation available; pass options.fetch");
    }
    this.fetchImpl =
      injected ??
      ((url, init) => globalThis.fetch(url, init) as unknown as Promise<FetchResponseLike>);
    this.logger = options.logger ?? defaultLogger;
    this.audience = options.audience;
    this.nowMs = options.nowMs ?? Date.now;
  }

  /** Sign, send, and unwrap the `response` payload. Throws DepixApiError on !2xx. */
  async request<T>(spec: AgentRequestSpec): Promise<T> {
    const signed = signAgentRequest({
      keypair: this.keypair,
      method: spec.method,
      path: spec.path,
      body: spec.body,
      audience: this.audience,
      nowMs: this.nowMs(),
    });

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...signed.headers,
    };
    const hasBody = signed.rawBody !== "";
    if (hasBody) headers["Content-Type"] = "application/json";

    const url = `${this.apiBase}${spec.path}`;
    const res = await this.fetchImpl(url, {
      method: spec.method,
      headers,
      ...(hasBody ? { body: signed.rawBody } : {}),
    });

    const text = await res.text();
    const json = safeJsonParse(text);
    if (!res.ok) {
      throw mapApiError(res.status, json, text, res);
    }
    const envelope = (json ?? {}) as WireEnvelope<T>;
    if (envelope.response !== undefined) return envelope.response;
    // Flat (envelope-less) endpoints — e.g. verify-domain — ARE the payload.
    return (json ?? {}) as T;
  }
}
