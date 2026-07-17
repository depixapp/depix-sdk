// DepixAgent — agent self-onboarding (F4). A top-level class, sibling to
// DepixWallet: register()/createKey() run BEFORE any sk_ key exists, so they
// can't hang off the API-key-gated wallet. Authentication is the Ed25519
// identity keypair (§2.3), persisted encrypted in dataDir.
//
// Typical flow (see the quickstart): create a DepixWallet, confirm its backup,
// take its receive address, then DepixAgent.create() + register({ liquidAddress
// }). The server fixes liquid_address at registration (the agent cannot change
// it later — field_immutable), so the SDK just passes the wallet-derived
// address through.

import { homedir } from "node:os";
import { join } from "node:path";
import { AgentError } from "./errors.js";
import { type Logger } from "./logger.js";
import type { FetchLike } from "./api/client.js";
import { AgentApiClient } from "./agent/client.js";
import { generateAgentKeypair, type AgentKeypair } from "./agent/keypair.js";
import { AgentKeyStore, type AgentIdentityMeta } from "./agent/store.js";

// ─── options + env resolution ────────────────────────────────────────────

export interface AgentOpenOptions {
  /** Default: $DEPIX_AGENT_DIR ?? ~/.depix-agent. */
  dataDir?: string;
  /** Default: $DEPIX_AGENT_PASSPHRASE ?? $DEPIX_WALLET_PASSPHRASE. Min 12 chars. */
  passphrase?: string;
  /** Default: $DEPIX_API_BASE ?? https://api.depixapp.com. */
  apiBase?: string;
  /** Advanced/testing: inject fetch. */
  fetch?: FetchLike;
  logger?: Logger;
  /** Signed-request audience override (must match the server). */
  audience?: string;
  /** Clock injection (unix ms) for deterministic tests. */
  nowMs?: () => number;
}

export interface AgentCreateOptions extends AgentOpenOptions {
  /** Overwrite an existing identity instead of throwing agent_already_initialized. */
  force?: boolean;
}

function resolveDataDir(explicit?: string): string {
  return explicit ?? process.env.DEPIX_AGENT_DIR ?? join(homedir(), ".depix-agent");
}

function resolvePassphrase(explicit?: string): string {
  const p = explicit ?? process.env.DEPIX_AGENT_PASSPHRASE ?? process.env.DEPIX_WALLET_PASSPHRASE;
  if (!p) {
    throw new AgentError(
      "agent_key_unreadable",
      "No passphrase provided (set DEPIX_AGENT_PASSPHRASE or pass `passphrase`)."
    );
  }
  return p;
}

// ─── register I/O ────────────────────────────────────────────────────────

export interface RegisterInput {
  /** Human-readable agent/merchant name (2–100 chars). */
  name: string;
  /** The op_… operator token from the human operator's OAuth/PAT connect (§2.9). */
  operatorToken: string;
  /** Operator notification email (never becomes the account login). */
  operatorEmail: string;
  /** Liquid address that will RECEIVE settlements — derive from the wallet; immutable after register. */
  liquidAddress: string;
  /** Optional username (defaults server-side to agent_<pubkey-prefix>). */
  username?: string;
  /** Optional default callback URL for outbound webhooks. */
  defaultCallbackUrl?: string;
  /** Optional referral code (an existing username). */
  ref?: string;
}

export interface IssuedKey {
  id: string;
  /** The plaintext key — returned ONLY here; store it now, it can't be re-read. */
  key: string;
  scopes: string;
}

export interface StarterKey extends IssuedKey {
  prefix?: string;
  perTxLimitCents?: number;
  dailyLimitCents?: number;
  starter: true;
}

export interface RegisterResult {
  agent: { username: string; publicKey: string; accountType: string };
  merchant: {
    id: string;
    merchantSlug: string;
    liquidAddress: string;
    /** Webhook signing secret — returned ONLY here. */
    webhookSecret: string;
    defaultCallbackUrl?: string | null;
  };
  keys: { test: IssuedKey; liveStarter: StarterKey };
  /** Server-provided onboarding info (informational). */
  graduation?: Record<string, unknown>;
  limits?: Record<string, unknown>;
}

// Wire shapes (snake_case) — only what we read.
interface RegisterWire {
  agent: { username: string; public_key: string; account_type: string };
  merchant: {
    id: string;
    merchant_slug: string;
    liquid_address: string;
    webhook_secret: string;
    default_callback_url?: string | null;
  };
  keys: {
    test: { id: string; key: string; scopes: string };
    live_starter: {
      id: string;
      key: string;
      scopes: string;
      prefix?: string;
      per_tx_limit_cents?: number;
      daily_limit_cents?: number;
      starter?: boolean;
    };
  };
  graduation?: Record<string, unknown>;
  limits?: Record<string, unknown>;
}

// ─── status / key I/O ────────────────────────────────────────────────────

export interface AgentStatus {
  accountStatus: "active" | "suspended";
  settledPersonalDeposits: number;
  graduated: boolean;
  /** Coarse blocker when the deposit count is reached but graduation hasn't fired. */
  graduationBlockedOn: string | null;
  keys: Array<{
    id: string;
    prefix: string;
    isLive: boolean;
    starter: boolean;
    scopes: string;
    revokedAt: string | null;
  }>;
  /** Present only when suspended. */
  reason?: string;
}

interface StatusWire {
  account_status: "active" | "suspended";
  settled_personal_deposits: number;
  graduated: boolean;
  graduation: { blocked_on: string | null };
  keys: Array<{
    id: string;
    prefix: string;
    is_live: boolean;
    starter: boolean;
    scopes: string;
    revoked_at: string | null;
  }>;
  reason?: string;
}

export interface CreateKeyInput {
  /** true → sk_live_ (requires graduation); false/omitted → sk_test_. */
  live?: boolean;
  /** Scope tokens; omitted → the server default set. */
  scopes?: string[];
  label?: string;
  /** Required floor applies; wallet_write keys get mandatory defaults if unset. */
  perTxLimitCents?: number;
  dailyLimitCents?: number;
}

export interface CreatedKey {
  id: string;
  /** Plaintext key — returned ONLY here. */
  key: string;
  prefix: string;
  isLive: boolean;
  scopes: string;
  perTxLimitCents?: number | null;
  dailyLimitCents?: number | null;
}

interface CreatedKeyWire {
  id: string;
  key: string;
  prefix: string;
  is_live: boolean;
  scopes: string;
  per_tx_limit_cents?: number | null;
  daily_limit_cents?: number | null;
}

// ─── the class ───────────────────────────────────────────────────────────

export class DepixAgent {
  private readonly keypair: AgentKeypair;
  private readonly store: AgentKeyStore;
  private readonly client: AgentApiClient;
  private meta: AgentIdentityMeta;

  private constructor(
    keypair: AgentKeypair,
    store: AgentKeyStore,
    client: AgentApiClient,
    meta: AgentIdentityMeta
  ) {
    this.keypair = keypair;
    this.store = store;
    this.client = client;
    this.meta = meta;
  }

  private static build(keypair: AgentKeypair, meta: AgentIdentityMeta, options: AgentOpenOptions): DepixAgent {
    const dataDir = resolveDataDir(options.dataDir);
    const passphrase = resolvePassphrase(options.passphrase);
    const store = new AgentKeyStore({ dataDir, passphrase, logger: options.logger });
    const client = new AgentApiClient({
      keypair,
      apiBase: options.apiBase,
      fetch: options.fetch,
      logger: options.logger,
      audience: options.audience,
      nowMs: options.nowMs,
    });
    return new DepixAgent(keypair, store, client, meta);
  }

  /** Create a fresh agent identity and persist it. Throws if one already exists (unless force). */
  static async create(options: AgentCreateOptions = {}): Promise<DepixAgent> {
    const dataDir = resolveDataDir(options.dataDir);
    const passphrase = resolvePassphrase(options.passphrase);
    const store = new AgentKeyStore({ dataDir, passphrase, logger: options.logger });
    if (!options.force && (await store.exists())) {
      throw new AgentError(
        "agent_already_initialized",
        `An agent identity already exists in ${dataDir}. Use DepixAgent.open(), or create({ force: true }) to replace it.`
      );
    }
    const keypair = generateAgentKeypair();
    await store.save(keypair, {});
    return DepixAgent.build(keypair, {}, options);
  }

  /** Open the agent identity persisted in dataDir. Throws agent_not_initialized when absent. */
  static async open(options: AgentOpenOptions = {}): Promise<DepixAgent> {
    const dataDir = resolveDataDir(options.dataDir);
    const passphrase = resolvePassphrase(options.passphrase);
    const store = new AgentKeyStore({ dataDir, passphrase, logger: options.logger });
    const loaded = await store.load();
    if (!loaded) {
      throw new AgentError(
        "agent_not_initialized",
        `No agent identity in ${dataDir}. Call DepixAgent.create() (then register) first.`
      );
    }
    return DepixAgent.build(loaded.keypair, loaded.meta, options);
  }

  /** The agent's Ed25519 public key (64 hex) — its stable identifier. */
  get publicKeyHex(): string {
    return this.keypair.publicKeyHex;
  }

  /** The registered username, once known (from register() or a prior session). */
  get username(): string | undefined {
    return this.meta.username;
  }

  /**
   * Register this identity as an agent account (§2.4). Returns the test key, the
   * wallet-only live starter key, and the merchant webhook secret — ALL returned
   * only once. Persists the username/merchantId locally for later sessions.
   */
  async register(input: RegisterInput): Promise<RegisterResult> {
    const body: Record<string, unknown> = {
      name: input.name,
      operator_token: input.operatorToken,
      operator_email: input.operatorEmail,
      liquid_address: input.liquidAddress,
    };
    if (input.username !== undefined) body.username = input.username;
    if (input.defaultCallbackUrl !== undefined) body.default_callback_url = input.defaultCallbackUrl;
    if (input.ref !== undefined) body.ref = input.ref;

    const wire = await this.client.request<RegisterWire>({ method: "POST", path: "/api/agents/register", body });

    const result: RegisterResult = {
      agent: {
        username: wire.agent.username,
        publicKey: wire.agent.public_key,
        accountType: wire.agent.account_type,
      },
      merchant: {
        id: wire.merchant.id,
        merchantSlug: wire.merchant.merchant_slug,
        liquidAddress: wire.merchant.liquid_address,
        webhookSecret: wire.merchant.webhook_secret,
        defaultCallbackUrl: wire.merchant.default_callback_url ?? null,
      },
      keys: {
        test: { id: wire.keys.test.id, key: wire.keys.test.key, scopes: wire.keys.test.scopes },
        liveStarter: {
          id: wire.keys.live_starter.id,
          key: wire.keys.live_starter.key,
          scopes: wire.keys.live_starter.scopes,
          prefix: wire.keys.live_starter.prefix,
          perTxLimitCents: wire.keys.live_starter.per_tx_limit_cents,
          dailyLimitCents: wire.keys.live_starter.daily_limit_cents,
          starter: true,
        },
      },
      graduation: wire.graduation,
      limits: wire.limits,
    };

    this.meta = { ...this.meta, username: result.agent.username, merchantId: result.merchant.id, apiBase: this.client.apiBase };
    await this.store.updateMeta(this.meta);
    return result;
  }

  /** Consumable onboarding progress (§3.4). Open even when the account is suspended. */
  async status(): Promise<AgentStatus> {
    const wire = await this.client.request<StatusWire>({ method: "GET", path: "/api/agents/status" });
    return {
      accountStatus: wire.account_status,
      settledPersonalDeposits: wire.settled_personal_deposits,
      graduated: wire.graduated,
      graduationBlockedOn: wire.graduation?.blocked_on ?? null,
      keys: (wire.keys ?? []).map((k) => ({
        id: k.id,
        prefix: k.prefix,
        isLive: k.is_live,
        starter: k.starter,
        scopes: k.scopes,
        revokedAt: k.revoked_at ?? null,
      })),
      ...(wire.reason !== undefined ? { reason: wire.reason } : {}),
    };
  }

  /** Mint an API key for the agent's own merchant. `live` requires graduation. */
  async createKey(input: CreateKeyInput = {}): Promise<CreatedKey> {
    const body: Record<string, unknown> = {};
    if (input.live !== undefined) body.live = input.live;
    if (input.scopes !== undefined) body.scopes = input.scopes;
    if (input.label !== undefined) body.label = input.label;
    if (input.perTxLimitCents !== undefined) body.per_tx_limit_cents = input.perTxLimitCents;
    if (input.dailyLimitCents !== undefined) body.daily_limit_cents = input.dailyLimitCents;

    const wire = await this.client.request<CreatedKeyWire>({ method: "POST", path: "/api/agents/keys", body });
    return {
      id: wire.id,
      key: wire.key,
      prefix: wire.prefix,
      isLive: wire.is_live,
      scopes: wire.scopes,
      perTxLimitCents: wire.per_tx_limit_cents ?? null,
      dailyLimitCents: wire.daily_limit_cents ?? null,
    };
  }

  /** Revoke one of the agent's own keys. Idempotent server-side. */
  async revokeKey(id: string): Promise<{ id: string; revoked: boolean }> {
    const wire = await this.client.request<{ id: string; revoked: boolean }>({
      method: "POST",
      path: "/api/agents/keys/revoke",
      body: { id },
    });
    return { id: wire.id, revoked: wire.revoked };
  }

  /** Rotate the merchant webhook secret. Returns the NEW secret once; invalidates the old immediately. */
  async rotateWebhookSecret(): Promise<{ webhookSecret: string }> {
    const wire = await this.client.request<{ webhook_secret: string }>({
      method: "POST",
      path: "/api/agents/webhook-secret",
    });
    return { webhookSecret: wire.webhook_secret };
  }
}
