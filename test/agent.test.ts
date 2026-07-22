import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DepixAgent } from "../src/agent.js";
import { isDepixSdkError } from "../src/errors.js";
import { mockFetch, type MockResponseSpec, type RecordedRequest } from "./support/mock.js";

const PASSPHRASE = "correct-horse-battery";
const API_BASE = "https://api.test";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-agent-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function makeAgent(responses: MockResponseSpec[] | ((r: RecordedRequest) => MockResponseSpec | null)) {
  const mf = mockFetch(responses);
  const agent = await DepixAgent.create({ dataDir, passphrase: PASSPHRASE, apiBase: API_BASE, fetch: mf.fetch });
  return { agent, calls: mf.calls };
}

function assertSigned(req: RecordedRequest) {
  expect(req.headers["X-Agent-Public-Key"]).toMatch(/^[0-9a-f]{64}$/);
  expect(req.headers["X-Agent-Signature"]).toMatch(/^[0-9a-f]{128}$/);
  expect(req.headers["X-Agent-Timestamp"]).toMatch(/^\d+$/);
  expect(typeof req.headers["X-Agent-Nonce"]).toBe("string");
}

const REGISTER_RESPONSE = {
  response: {
    agent: { username: "acme_agent", public_key: "PUBKEY", account_type: "agent" },
    merchant: {
      id: "mrc_1",
      merchant_slug: "acme_agent",
      liquid_address: "lq1qtest",
      webhook_secret: "whsec_abc",
      default_callback_url: null,
    },
    keys: {
      test: { id: "key_t", key: "sk_test_xyz", scopes: "wallet_read" },
      live_starter: {
        id: "key_s",
        key: "sk_live_starter",
        scopes: "wallet_write",
        per_tx_limit_cents: 5000,
        daily_limit_cents: 20000,
        starter: true,
      },
    },
    graduation: { required_settled_deposits: 5, maturation_days: 15 },
    limits: { first_deposit_max_cents: 10000 },
  },
};

describe("DepixAgent lifecycle", () => {
  it("create() then open() reload the same identity", async () => {
    const { agent } = await makeAgent([]);
    const pub = agent.publicKeyHex;
    expect(pub).toMatch(/^[0-9a-f]{64}$/);

    const reopened = await DepixAgent.open({ dataDir, passphrase: PASSPHRASE, apiBase: API_BASE, fetch: mockFetch([]).fetch });
    expect(reopened.publicKeyHex).toBe(pub);
  });

  it("open() on an empty dir throws agent_not_initialized", async () => {
    await expect(
      DepixAgent.open({ dataDir, passphrase: PASSPHRASE, fetch: mockFetch([]).fetch })
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "agent_not_initialized"));
  });

  it("create() twice throws agent_already_initialized (unless force)", async () => {
    await makeAgent([]);
    await expect(
      DepixAgent.create({ dataDir, passphrase: PASSPHRASE, fetch: mockFetch([]).fetch })
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "agent_already_initialized"));
    // force replaces it
    const replaced = await DepixAgent.create({ dataDir, passphrase: PASSPHRASE, force: true, fetch: mockFetch([]).fetch });
    expect(replaced.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("DepixAgent.register", () => {
  it("POSTs a signed, snake_case body and maps the response to camelCase", async () => {
    const { agent, calls } = await makeAgent([{ status: 201, json: REGISTER_RESPONSE }]);
    const res = await agent.register({
      name: "Acme Butler",
      operatorToken: "op_123",
      operatorEmail: "ops@acme.com",
      liquidAddress: "lq1qtest",
      ref: "referrer1",
    });

    // Request wire form.
    const req = calls[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.test/api/agents/register");
    assertSigned(req);
    const body = JSON.parse(req.body!);
    expect(body).toMatchObject({
      name: "Acme Butler",
      operator_token: "op_123",
      operator_email: "ops@acme.com",
      liquid_address: "lq1qtest",
      ref: "referrer1",
    });
    // The signed body hash is over EXACTLY the bytes we sent.
    expect(req.body).toBe(JSON.stringify(body));

    // Mapped result.
    expect(res.agent).toEqual({ username: "acme_agent", publicKey: "PUBKEY", accountType: "agent" });
    expect(res.merchant.webhookSecret).toBe("whsec_abc");
    expect(res.keys.test.key).toBe("sk_test_xyz");
    expect(res.keys.liveStarter).toMatchObject({ key: "sk_live_starter", perTxLimitCents: 5000, starter: true });

    // Meta persisted → a fresh open() knows the username.
    const reopened = await DepixAgent.open({ dataDir, passphrase: PASSPHRASE, fetch: mockFetch([]).fetch });
    expect(reopened.username).toBe("acme_agent");
  });

  it("surfaces a server rejection as a DepixApiError (branch on err.code)", async () => {
    const { agent } = await makeAgent([
      { status: 401, json: { response: { errorMessage: "bad token" }, error: { code: "invalid_operator_token" } } },
    ]);
    await expect(
      agent.register({ name: "X", operatorToken: "op_bad", operatorEmail: "o@x.com", liquidAddress: "lq1q" })
    ).rejects.toSatisfy((e) => isDepixSdkError(e, "invalid_operator_token"));
  });
});

describe("DepixAgent key + status operations", () => {
  it("status() maps the wire snake_case to camelCase", async () => {
    const { agent, calls } = await makeAgent([
      {
        status: 200,
        json: {
          response: {
            account_status: "active",
            settled_personal_deposits: 3,
            graduated: false,
            graduation: { blocked_on: null },
            keys: [{ id: "k1", prefix: "sk_test_", is_live: false, starter: false, scopes: "wallet_read", revoked_at: null }],
          },
        },
      },
    ]);
    const s = await agent.status();
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://api.test/api/agents/status");
    assertSigned(calls[0]!);
    expect(calls[0]!.body).toBeUndefined(); // no body on GET
    expect(s).toMatchObject({ accountStatus: "active", settledPersonalDeposits: 3, graduated: false, graduationBlockedOn: null });
    expect(s.keys[0]).toMatchObject({ id: "k1", isLive: false, revokedAt: null });
  });

  it("createKey() sends snake_case limits and maps the created key", async () => {
    const { agent, calls } = await makeAgent([
      {
        status: 201,
        json: { response: { id: "key_new", key: "sk_live_new", prefix: "sk_live_", is_live: true, scopes: "wallet_write", per_tx_limit_cents: 5000, daily_limit_cents: 20000 } },
      },
    ]);
    const k = await agent.createKey({ live: true, scopes: ["wallet_write"], perTxLimitCents: 5000, dailyLimitCents: 20000, label: "bot" });
    const body = JSON.parse(calls[0]!.body!);
    expect(body).toEqual({ live: true, scopes: ["wallet_write"], label: "bot", per_tx_limit_cents: 5000, daily_limit_cents: 20000 });
    expect(k).toMatchObject({ id: "key_new", key: "sk_live_new", isLive: true, perTxLimitCents: 5000 });
  });

  it("revokeKey() posts the id and maps the ack", async () => {
    const { agent, calls } = await makeAgent([{ status: 200, json: { response: { id: "key_x", revoked: true } } }]);
    const r = await agent.revokeKey("key_x");
    expect(calls[0]!.url).toBe("https://api.test/api/agents/keys/revoke");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ id: "key_x" });
    expect(r).toEqual({ id: "key_x", revoked: true });
  });

  it("rotateWebhookSecret() returns the new secret", async () => {
    const { agent, calls } = await makeAgent([{ status: 200, json: { response: { webhook_secret: "whsec_new" } } }]);
    const out = await agent.rotateWebhookSecret();
    expect(calls[0]!.url).toBe("https://api.test/api/agents/webhook-secret");
    expect(out).toEqual({ webhookSecret: "whsec_new" });
  });

  it("maps graduation_pending on a live key request", async () => {
    const { agent } = await makeAgent([
      { status: 403, json: { response: { errorMessage: "not graduated" }, error: { code: "graduation_pending" } } },
    ]);
    await expect(agent.createKey({ live: true })).rejects.toSatisfy((e) => isDepixSdkError(e, "graduation_pending"));
  });
});

describe("DepixAgent.verifyDomain", () => {
  it("phase 1: POSTs a signed {domain} body and maps the FLAT challenge response", async () => {
    // The backend replies WITHOUT the `{ response: … }` envelope on this route
    // (agents.js verifyDomain) — the mock mirrors that flat wire shape exactly.
    const { agent, calls } = await makeAgent([
      { status: 200, json: { record_name: "_depix-verify.acme.com", record_value: "depix-verify=3f9a" } },
    ]);
    const challenge = await agent.verifyDomain("acme.com");

    const req = calls[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.test/api/agents/verify-domain");
    assertSigned(req);
    // Byte-exact body: only { domain } — no `confirm` key in phase 1, so the
    // signed hash covers exactly these bytes.
    expect(req.body).toBe(JSON.stringify({ domain: "acme.com" }));

    expect(challenge).toEqual({
      recordName: "_depix-verify.acme.com",
      recordValue: "depix-verify=3f9a",
    });
  });

  it("phase 2: POSTs {domain, confirm: true} and maps the confirmation", async () => {
    const { agent, calls } = await makeAgent([
      { status: 200, json: { verified_domain: "acme.com" } },
    ]);
    const result = await agent.verifyDomain("acme.com", { confirm: true });

    const req = calls[0]!;
    expect(req.url).toBe("https://api.test/api/agents/verify-domain");
    assertSigned(req);
    expect(req.body).toBe(JSON.stringify({ domain: "acme.com", confirm: true }));
    expect(result).toEqual({ verifiedDomain: "acme.com" });
  });

  it("surfaces domain_txt_not_found (TXT not propagated yet) for the retry loop", async () => {
    const { agent } = await makeAgent([
      {
        status: 422,
        json: {
          response: { errorMessage: "TXT not found" },
          error: { code: "domain_txt_not_found", message: "The DNS TXT challenge was not found or does not match." },
        },
      },
    ]);
    await expect(agent.verifyDomain("acme.com", { confirm: true })).rejects.toSatisfy((e) =>
      isDepixSdkError(e, "domain_txt_not_found")
    );
  });

  it("surfaces domain_tld_not_allowed with details.allowed_tlds", async () => {
    const { agent } = await makeAgent([
      {
        status: 422,
        json: {
          response: { errorMessage: "TLD not allowed" },
          error: { code: "domain_tld_not_allowed", details: { allowed_tlds: ["com", "com.br"] } },
        },
      },
    ]);
    await expect(agent.verifyDomain("acme.xyz")).rejects.toSatisfy(
      (e) =>
        isDepixSdkError(e, "domain_tld_not_allowed") &&
        Array.isArray((e as { details?: { allowed_tlds?: unknown } }).details?.allowed_tlds)
    );
  });
});
