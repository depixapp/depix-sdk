// wallet.merchant.* — the merchant light-profile namespace (spec §5.6 / §2.3,
// roadmap decision 14).
//
// get()    reads the merchant identity via GET /api/me (scope merchant_read).
// update() edits ONLY the 5 LIGHT profile fields via PATCH /api/merchants/me
//          (scope merchant_write): business name, logo, website, default
//          post-payment redirect URL, default webhook callback URL.
//
// liquid_address (redirects money — human + password only) and split_address
// (admin only) are DELIBERATELY absent from this surface: the field types below
// don't include them, and update() rejects any unknown key with a typed
// MerchantError BEFORE the request. There is no method here that touches money
// or elevates anything. Every key-authenticated PATCH makes the backend email
// the account OWNER naming the changed fields + the key id (compensating control
// G11) — nothing for the SDK to do.

import { MerchantError } from "./errors.js";
import type {
  DepixApiClient,
  MerchantUpdateWireBody
} from "./api/client.js";

/** The merchant identity returned by get() (spec §5.6). */
export interface MerchantProfile {
  merchantId: string;
  name: string;
  /** Owner account username (null when unavailable). */
  username: string | null;
  merchantSlug: string;
  /** false when authenticated with a sk_test_ key (sandbox mode). */
  isLive: boolean;
  createdAt: string;
}

/**
 * The editable LIGHT fields (spec §5.6). Every field is optional; only the
 * provided ones change. The TYPE alone excludes liquid_address/split_address —
 * a caller cannot even name them — and update() enforces the same set at
 * runtime for untyped/agent-generated inputs.
 */
export interface MerchantUpdateFields {
  businessName?: string;
  /** null/empty string clears it. */
  logoUrl?: string | null;
  /** null/empty string clears it. */
  website?: string | null;
  /** Customers' post-payment redirect. null/empty clears it. */
  defaultRedirectUrl?: string | null;
  /** Default deposit/withdraw webhook endpoint. null/empty clears it. */
  defaultCallbackUrl?: string | null;
}

export interface MerchantUpdateResult {
  /** The merchant's public URL slug after the update (changes only when businessName did). */
  merchantSlug: string;
}

// SDK camelCase → wire snake_case. This map IS the allow-list: any key outside
// it is rejected before the request (spec §5.6 client-side validation).
const FIELD_MAP: Record<keyof MerchantUpdateFields, keyof MerchantUpdateWireBody> = {
  businessName: "business_name",
  logoUrl: "logo_url",
  website: "website",
  defaultRedirectUrl: "default_redirect_url",
  defaultCallbackUrl: "default_callback_url"
};

export class MerchantNamespace {
  // A getter (not the client) so a wallet opened without an apiKey throws the
  // wallet's clear API_KEY_REQUIRED at call time, not at construction.
  private readonly api: () => DepixApiClient;

  constructor(api: () => DepixApiClient) {
    this.api = api;
  }

  /** Read the merchant profile behind the key (GET /api/me, scope merchant_read). */
  async get(): Promise<MerchantProfile> {
    const me = await this.api().getMe();
    return {
      merchantId: me.merchant_id,
      name: me.name,
      username: me.username,
      merchantSlug: me.merchant_slug,
      isLive: me.is_live,
      createdAt: me.created_at
    };
  }

  /**
   * Update the LIGHT profile fields (PATCH /api/merchants/me, scope
   * merchant_write). Rejects — before any request — any field outside the 5
   * editable ones (MERCHANT_FIELD_NOT_EDITABLE, details.field), a non-object
   * argument (MERCHANT_UPDATE_INVALID) and an empty update
   * (MERCHANT_UPDATE_EMPTY). A bad VALUE (e.g. a non-HTTPS URL) or a missing
   * scope surfaces from the server as a DepixApiError instead.
   */
  async update(fields: MerchantUpdateFields): Promise<MerchantUpdateResult> {
    if (fields === null || typeof fields !== "object") {
      throw new MerchantError(
        "MERCHANT_UPDATE_INVALID",
        "update() expects an object of light profile fields."
      );
    }
    const allowed = Object.keys(FIELD_MAP) as (keyof MerchantUpdateFields)[];
    const body: MerchantUpdateWireBody = {};
    let count = 0;
    for (const key of Object.keys(fields)) {
      if (!(allowed as string[]).includes(key)) {
        throw new MerchantError(
          "MERCHANT_FIELD_NOT_EDITABLE",
          `Field "${key}" is not editable via an API key. Only ${allowed.join(", ")} are — ` +
            "liquid_address and split_address are owner/admin-only and are never part of this surface.",
          { details: { field: key } }
        );
      }
      const value = (fields as Record<string, unknown>)[key];
      // undefined means "not provided" — leave the field unchanged. (Explicit
      // null clears the field server-side, so it is forwarded.)
      if (value === undefined) continue;
      (body as Record<string, unknown>)[FIELD_MAP[key as keyof MerchantUpdateFields]] = value;
      count++;
    }
    if (count === 0) {
      throw new MerchantError(
        "MERCHANT_UPDATE_EMPTY",
        "update() needs at least one light profile field to change."
      );
    }
    const wire = await this.api().patchMerchantProfile(body);
    return { merchantSlug: wire.merchant_slug };
  }
}
