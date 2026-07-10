// wallet.merchant.* — the merchant light-profile namespace (spec §5.6 / §2.3).
// Fully offline: a mock fetch + fake clock at the client level, plus a wiring
// test through the REAL DepixWallet proving the namespace uses the same API
// client as the Pix flows.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DepixApiClient, type MerchantUpdateWireBody } from "../src/api/client.js";
import { MerchantNamespace, type MerchantUpdateFields } from "../src/merchant.js";
import { DepixApiError, MerchantError, isDepixSdkError } from "../src/errors.js";
import { DepixWallet } from "../src/wallet.js";
import { fakeClock, mockFetch, type MockFetch } from "./support/mock.js";

const ME = {
  merchant_id: "mrc_1",
  name: "Loja Teste",
  username: "owner",
  merchant_slug: "loja-teste",
  is_live: false,
  created_at: "2026-01-01 00:00:00"
};

function makeClient(mock: MockFetch, apiKey = "sk_test_abc"): DepixApiClient {
  const clock = fakeClock();
  return new DepixApiClient({ apiKey, fetch: mock.fetch, now: clock.now, sleep: clock.sleep, random: () => 0 });
}

function ns(mock: MockFetch): MerchantNamespace {
  const client = makeClient(mock);
  return new MerchantNamespace(() => client);
}

describe("wallet.merchant.get() (§5.6)", () => {
  it("maps GET /api/me to a MerchantProfile", async () => {
    const mock = mockFetch([{ json: ME }]);
    const profile = await ns(mock).get();
    expect(profile).toEqual({
      merchantId: "mrc_1",
      name: "Loja Teste",
      username: "owner",
      merchantSlug: "loja-teste",
      isLive: false,
      createdAt: "2026-01-01 00:00:00"
    });
    expect(mock.calls[0]!.method).toBe("GET");
    expect(mock.calls[0]!.url).toBe("https://api.depixapp.com/api/me");
    expect(mock.calls[0]!.headers["Authorization"]).toBe("Bearer sk_test_abc");
    // A read — never carries an Idempotency-Key.
    expect(mock.calls[0]!.headers["Idempotency-Key"]).toBeUndefined();
  });
});

describe("wallet.merchant.update() — light fields only (§5.6)", () => {
  it("maps camelCase fields to the snake_case wire body and returns the new slug", async () => {
    const mock = mockFetch([{ json: { success: true, merchant_slug: "nova-loja" } }]);
    const result = await ns(mock).update({
      businessName: "Nova Loja",
      logoUrl: "https://cdn.example.com/logo.png",
      website: "https://loja.example.com",
      defaultRedirectUrl: "https://loja.example.com/obrigado",
      defaultCallbackUrl: "https://loja.example.com/webhook"
    });
    expect(result).toEqual({ merchantSlug: "nova-loja" });
    expect(mock.calls[0]!.method).toBe("PATCH");
    expect(mock.calls[0]!.url).toBe("https://api.depixapp.com/api/merchants/me");
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({
      business_name: "Nova Loja",
      logo_url: "https://cdn.example.com/logo.png",
      website: "https://loja.example.com",
      default_redirect_url: "https://loja.example.com/obrigado",
      default_callback_url: "https://loja.example.com/webhook"
    });
  });

  it("forwards an explicit null to clear a field, and omits undefined fields", async () => {
    const mock = mockFetch([{ json: { success: true, merchant_slug: "loja-teste" } }]);
    await ns(mock).update({ website: null, logoUrl: undefined });
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({ website: null });
  });

  it("forwards businessName: null on the wire (type allows it — no type/runtime skew)", async () => {
    const mock = mockFetch([{ json: { success: true, merchant_slug: "loja-teste" } }]);
    // businessName is typed `string | null` like the other four fields, so an
    // explicit null is a plain typed call (no cast) and is forwarded, not dropped.
    await ns(mock).update({ businessName: null });
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({ business_name: null });
  });

  it("rejects a forbidden field (liquid_address) BEFORE any request", async () => {
    const mock = mockFetch([]);
    await expect(
      ns(mock).update({ liquidAddress: "ex1qexample" } as unknown as MerchantUpdateFields)
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof MerchantError &&
        e.code === "MERCHANT_FIELD_NOT_EDITABLE" &&
        (e.details as { field?: string } | undefined)?.field === "liquidAddress"
    );
    // No request was made — the forbidden field never reaches the wire (§5.6).
    expect(mock.calls.length).toBe(0);
  });

  it("rejects split_address too (never part of the surface)", async () => {
    const mock = mockFetch([]);
    await expect(
      ns(mock).update({ splitAddress: "ex1qsplit" } as unknown as MerchantUpdateFields)
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "MERCHANT_FIELD_NOT_EDITABLE"));
    expect(mock.calls.length).toBe(0);
  });

  it("rejects a GENERIC unknown key (foo) — the guard is not address-specific", async () => {
    // The rejection mechanism is any-key-outside-FIELD_MAP, not a special-case on
    // address fields; a plain unknown key locks in that generality.
    const mock = mockFetch([]);
    await expect(
      ns(mock).update({ foo: "x" } as unknown as MerchantUpdateFields)
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof MerchantError &&
        e.code === "MERCHANT_FIELD_NOT_EDITABLE" &&
        (e.details as { field?: string } | undefined)?.field === "foo"
    );
    expect(mock.calls.length).toBe(0);
  });

  it("patchMerchantProfile primitive rejects an owner-only key before any request (defense-in-depth)", async () => {
    // Second line of defense: even bypassing the guarded namespace and calling
    // the public client primitive directly with an excess key must not reach the
    // wire — the forbidden field is rejected client-side.
    const mock = mockFetch([]);
    const client = makeClient(mock);
    await expect(
      client.patchMerchantProfile({ liquid_address: "ex1qexample" } as unknown as MerchantUpdateWireBody)
    ).rejects.toBeInstanceOf(TypeError);
    expect(mock.calls.length).toBe(0);
  });

  it("rejects an empty update (no editable field) with no request", async () => {
    const mock = mockFetch([]);
    await expect(ns(mock).update({})).rejects.toSatisfy((e: unknown) =>
      isDepixSdkError(e, "MERCHANT_UPDATE_EMPTY")
    );
    await expect(ns(mock).update({ businessName: undefined })).rejects.toSatisfy((e: unknown) =>
      isDepixSdkError(e, "MERCHANT_UPDATE_EMPTY")
    );
    expect(mock.calls.length).toBe(0);
  });

  it("rejects a non-object argument", async () => {
    const mock = mockFetch([]);
    await expect(
      ns(mock).update(null as unknown as MerchantUpdateFields)
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "MERCHANT_UPDATE_INVALID"));
    expect(mock.calls.length).toBe(0);
  });

  it("surfaces a server 403 insufficient_scope as a DepixApiError with requiredScope", async () => {
    const mock = mockFetch([
      {
        status: 403,
        json: {
          response: { errorMessage: "Esta API key não tem permissão para esta operação." },
          error: { code: "insufficient_scope", request_id: "r", details: { required_scope: "merchant_write" } }
        }
      }
    ]);
    await expect(ns(mock).update({ businessName: "X" })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DepixApiError && e.code === "insufficient_scope" && e.requiredScope === "merchant_write"
    );
  });

  it("surfaces a server 400 validation_error (bad value) with details.field", async () => {
    const mock = mockFetch([
      {
        status: 400,
        json: {
          response: { errorMessage: "logo_url deve usar HTTPS." },
          error: { code: "validation_error", request_id: "r", details: { field: "logo_url" } }
        }
      }
    ]);
    await expect(ns(mock).update({ logoUrl: "http://insecure.example.com/logo.png" })).rejects.toSatisfy(
      (e: unknown) => e instanceof DepixApiError && e.code === "validation_error" && e.field === "logo_url"
    );
  });
});

describe("wallet.merchant is wired through the real DepixWallet (§2.3/§5.6)", () => {
  const PASSPHRASE = "correct-horse-battery-staple";
  const KNOWN_MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  let dataDir: string;
  let wallet: DepixWallet | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-merchant-"));
  });
  afterEach(async () => {
    await wallet?.close().catch(() => {});
    wallet = undefined;
    await rm(dataDir, { recursive: true, force: true });
  });

  it("routes wallet.merchant.get() to GET /api/me through the wallet's API client", async () => {
    // Only answer /api/me; anything else (nothing else is expected) is a 500 so
    // an accidental extra call fails loudly.
    const mock = mockFetch((req) =>
      req.url.endsWith("/api/me") ? { json: ME } : { status: 500, json: {} }
    );
    wallet = await DepixWallet.restore({
      dataDir,
      passphrase: PASSPHRASE,
      mnemonic: KNOWN_MNEMONIC,
      apiKey: "sk_test_wiring",
      fetch: mock.fetch
    });
    expect(typeof wallet.merchant.get).toBe("function");
    expect(typeof wallet.merchant.update).toBe("function");
    const profile = await wallet.merchant.get();
    expect(profile.merchantId).toBe("mrc_1");
    expect(mock.calls.at(-1)!.headers["Authorization"]).toBe("Bearer sk_test_wiring");
  });

  it("wallet.merchant.get() without an apiKey throws API_KEY_REQUIRED", async () => {
    wallet = await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC });
    await expect(wallet.merchant.get()).rejects.toSatisfy((e: unknown) =>
      isDepixSdkError(e, "API_KEY_REQUIRED")
    );
  });
});
