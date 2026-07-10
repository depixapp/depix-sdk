// DepixApiClient (spec §7 error mapping / retry / idempotency + §3.4 throttle).
// Fully offline — a mock fetch and a fake clock that advances on sleep.
import { describe, expect, it } from "vitest";
import { DepixApiClient } from "../src/api/client.js";
import { Throttle } from "../src/api/throttle.js";
import { DepixApiError, isDepixSdkError } from "../src/errors.js";
import { fakeClock, mockFetch } from "./support/mock.js";

const DEPOSIT_BODY = { amountInCents: 1000, depixAddress: "lq1qexample", payer_tax_number: "12345678909" };
const WITHDRAW_OK = {
  response: { withdrawalId: "w_1", depositAddress: "lq1q", depositAmountInCents: 500, payoutAmountInCents: 490 }
};

function makeClient(mock: ReturnType<typeof mockFetch>, apiKey = "sk_test_abc"): DepixApiClient {
  const clock = fakeClock();
  return new DepixApiClient({
    apiKey,
    fetch: mock.fetch,
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0
  });
}

describe("request wiring", () => {
  it("sends Bearer auth, Idempotency-Key and the canonical base on a deposit POST", async () => {
    const mock = mockFetch([{ json: { async: false, response: { qrCopyPaste: "QR", qrImageUrl: null, id: "dep_1" } } }]);
    const client = makeClient(mock);
    const res = await client.createDeposit(DEPOSIT_BODY, { idempotencyKey: "key-1" });
    expect(res.id).toBe("dep_1");
    expect(mock.calls[0]!.url).toBe("https://api.depixapp.com/api/deposit");
    expect(mock.calls[0]!.method).toBe("POST");
    expect(mock.calls[0]!.headers["Authorization"]).toBe("Bearer sk_test_abc");
    expect(mock.calls[0]!.headers["Idempotency-Key"]).toBe("key-1");
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual(DEPOSIT_BODY);
  });

  it("auto-generates a UUID Idempotency-Key when none is passed", async () => {
    const mock = mockFetch([{ json: WITHDRAW_OK }]);
    const client = makeClient(mock);
    await client.createWithdraw({ pixKey: "k", taxNumber: "t", depositAmountInCents: 500 });
    expect(mock.calls[0]!.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("status reads are GETs with no Idempotency-Key", async () => {
    const mock = mockFetch([
      { json: { id: "dep_1", type: "deposit", amount_cents: 1000, status: "depix_sent", created_at: "x", updated_at: "x", rejection_reasons: [] } }
    ]);
    const client = makeClient(mock);
    const status = await client.getDeposit("dep_1");
    expect(status.status).toBe("depix_sent");
    expect(mock.calls[0]!.method).toBe("GET");
    expect(mock.calls[0]!.headers["Idempotency-Key"]).toBeUndefined();
    expect(mock.calls[0]!.url).toBe("https://api.depixapp.com/api/deposits/dep_1");
  });

  it("keyMode/isSandbox derive locally from the prefix (no /api/me call)", () => {
    expect(new DepixApiClient({ apiKey: "sk_live_x", fetch: mockFetch([]).fetch }).keyMode).toBe("live");
    const test = new DepixApiClient({ apiKey: "sk_test_x", fetch: mockFetch([]).fetch });
    expect(test.keyMode).toBe("test");
    expect(test.isSandbox).toBe(true);
  });
});

describe("error mapping (§7.1)", () => {
  it("maps a structured envelope to a DepixApiError with status/code/request_id", async () => {
    const mock = mockFetch([
      { status: 400, json: { response: { errorMessage: "pt" }, error: { code: "amount_out_of_range", message: "Amount outside range", request_id: "rid-9", docs_url: "u", details: { min_cents: 500, max_cents: 300000 } } } }
    ]);
    const client = makeClient(mock);
    await expect(client.createDeposit(DEPOSIT_BODY, { idempotencyKey: "k" })).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DepixApiError &&
        err.code === "amount_out_of_range" &&
        err.status === 400 &&
        err.requestId === "rid-9" &&
        err.details?.min_cents === 500
      );
    });
  });

  it("hoists details.required_scope to first class on insufficient_scope", async () => {
    const mock = mockFetch([
      { status: 403, json: { response: { errorMessage: "sem escopo" }, error: { code: "insufficient_scope", message: "no scope", request_id: "r", details: { required_scope: "wallet_write" } } } }
    ]);
    const client = makeClient(mock);
    await expect(client.createWithdraw({ pixKey: "k", taxNumber: "t", depositAmountInCents: 500 })).rejects.toSatisfy(
      (err: unknown) => err instanceof DepixApiError && err.code === "insufficient_scope" && err.requiredScope === "wallet_write"
    );
  });

  it("hoists details.field, and preserves the provider PT message (validation with details)", async () => {
    const mock = mockFetch([
      { status: 400, json: { response: { errorMessage: "CPF inválido" }, error: { code: "validation_error", request_id: "r", details: { field: "payer_tax_number" } } } }
    ]);
    const client = makeClient(mock);
    await expect(client.createDeposit(DEPOSIT_BODY, { idempotencyKey: "k" })).rejects.toSatisfy(
      (err: unknown) => err instanceof DepixApiError && err.field === "payer_tax_number" && err.legacyErrorMessage === "CPF inválido"
    );
  });

  it("falls back to legacy response.errors[0].field when details.field is absent (provider rejection)", async () => {
    const mock = mockFetch([
      { status: 400, json: { response: { errorMessage: "Chave PIX inválida", errors: [{ field: "pixKey" }] }, error: { code: "validation_error", request_id: "r" } } }
    ]);
    const client = makeClient(mock);
    await expect(client.createWithdraw({ pixKey: "k", taxNumber: "t", depositAmountInCents: 500 })).rejects.toSatisfy(
      (err: unknown) => err instanceof DepixApiError && err.field === "pixKey" && err.legacyErrorMessage === "Chave PIX inválida" && err.details === undefined
    );
  });

  it("a provider rejection with NO details still surfaces legacyErrorMessage and no field", async () => {
    const mock = mockFetch([
      { status: 400, json: { response: { errorMessage: "Pagador bloqueado pela Eulen" }, error: { code: "validation_error", request_id: "r" } } }
    ]);
    const client = makeClient(mock);
    await expect(client.createDeposit(DEPOSIT_BODY, { idempotencyKey: "k" })).rejects.toSatisfy(
      (err: unknown) => err instanceof DepixApiError && err.legacyErrorMessage === "Pagador bloqueado pela Eulen" && err.field === undefined
    );
  });

  it("an unstructured (HTML) error becomes a synthetic upstream_error with truncated body", async () => {
    const mock = mockFetch(() => ({ status: 502, text: "<html>Bad Gateway</html>" }));
    const client = makeClient(mock);
    await expect(client.getDeposit("dep_1")).rejects.toSatisfy(
      (err: unknown) => err instanceof DepixApiError && err.code === "upstream_error" && String(err.details?.body).includes("Bad Gateway")
    );
  });
});

describe("retry policy (§7.3)", () => {
  it("retries a 5xx up to 3 times then surfaces (4 calls total)", async () => {
    const mock = mockFetch(() => ({ status: 503, json: { error: { code: "service_unavailable" } } }));
    const client = makeClient(mock);
    await expect(client.getWithdrawal("w_1")).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "service_unavailable"));
    expect(mock.calls).toHaveLength(4); // initial + 3 retries
  });

  it("retries a network error then succeeds", async () => {
    let n = 0;
    const mock = mockFetch(() => {
      n++;
      return n === 1 ? null : { json: { id: "dep_1", type: "deposit", amount_cents: 1000, status: "depix_sent", created_at: "x", updated_at: "x", rejection_reasons: [] } };
    });
    const client = makeClient(mock);
    const status = await client.getDeposit("dep_1");
    expect(status.status).toBe("depix_sent");
    expect(mock.calls).toHaveLength(2);
  });

  it("honors retry_after on 429 (max 2 retries)", async () => {
    const mock = mockFetch(() => ({ status: 429, json: { error: { code: "rate_limited", retry_after: 7 } } }));
    const client = makeClient(mock);
    await expect(client.createWithdraw({ pixKey: "k", taxNumber: "t", depositAmountInCents: 500 })).rejects.toSatisfy(
      (err: unknown) => isDepixSdkError(err, "rate_limited")
    );
    expect(mock.calls).toHaveLength(3); // initial + 2 retries
  });

  it("recovers from a 429 then a 200 with the SAME Idempotency-Key on the retry", async () => {
    const responses = [
      { status: 429, json: { error: { code: "rate_limited", retry_after: 3 } } },
      { json: WITHDRAW_OK }
    ];
    const mock = mockFetch(responses);
    const client = makeClient(mock);
    const res = await client.createWithdraw({ pixKey: "k", taxNumber: "t", depositAmountInCents: 500 }, { idempotencyKey: "k-42" });
    expect(res.withdrawalId).toBe("w_1");
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]!.headers["Idempotency-Key"]).toBe("k-42");
    expect(mock.calls[1]!.headers["Idempotency-Key"]).toBe("k-42"); // reused, not regenerated
  });

  it("retries 409 idempotency_in_flight after retry_after (max 3)", async () => {
    const mock = mockFetch(() => ({ status: 409, json: { error: { code: "idempotency_in_flight", retry_after: 5 } } }));
    const client = makeClient(mock);
    await expect(client.createDeposit(DEPOSIT_BODY, { idempotencyKey: "k" })).rejects.toSatisfy(
      (err: unknown) => isDepixSdkError(err, "idempotency_in_flight")
    );
    expect(mock.calls).toHaveLength(4); // initial + 3 retries
  });

  it("never retries a plain 4xx (e.g. insufficient_scope)", async () => {
    const mock = mockFetch(() => ({ status: 403, json: { error: { code: "insufficient_scope", details: { required_scope: "wallet_write" } } } }));
    const client = makeClient(mock);
    await expect(client.createWithdraw({ pixKey: "k", taxNumber: "t", depositAmountInCents: 500 })).rejects.toThrow();
    expect(mock.calls).toHaveLength(1);
  });
});

describe("throttle (§3.4)", () => {
  it("paces creation to 2/min per key — the 3rd POST waits a full window", async () => {
    const clock = fakeClock();
    const mock = mockFetch(() => ({ json: { async: false, response: { qrCopyPaste: "Q", qrImageUrl: null, id: "d" } } }));
    const client = new DepixApiClient({ apiKey: "sk_test_x", fetch: mock.fetch, now: clock.now, sleep: clock.sleep, random: () => 0 });
    await client.createDeposit(DEPOSIT_BODY, { idempotencyKey: "a" });
    await client.createDeposit(DEPOSIT_BODY, { idempotencyKey: "b" });
    expect(clock.now()).toBe(0); // first two slots are free
    await client.createDeposit(DEPOSIT_BODY, { idempotencyKey: "c" });
    expect(clock.now()).toBeGreaterThanOrEqual(60_000); // third waited out the minute
    expect(mock.calls).toHaveLength(3);
  });

  it("Throttle spaces the (limit+1)-th acquire by the window", async () => {
    const clock = fakeClock();
    const throttle = new Throttle({ limit: 30, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 30; i++) await throttle.acquire("deposit-status:key");
    expect(clock.now()).toBe(0);
    await throttle.acquire("deposit-status:key");
    expect(clock.now()).toBeGreaterThanOrEqual(60_000);
  });
});
