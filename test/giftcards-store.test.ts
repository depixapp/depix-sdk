// Gift-card order log — durable JSON, cap 100, newest first (spec §5.5).
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GiftcardOrderStore,
  GIFTCARD_ORDERS_FILE,
  MAX_STORED_ORDERS,
  type StoredGiftcardOrder
} from "../src/giftcards/store.js";
import type { Logger } from "../src/logger.js";

const SILENT: Logger = { debug() {}, info() {}, warn() {}, error() {} };

let dataDir: string;
let store: GiftcardOrderStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-gc-store-"));
  store = new GiftcardOrderStore({ dataDir, logger: SILENT });
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function order(id: string, over: Partial<StoredGiftcardOrder> = {}): StoredGiftcardOrder {
  return {
    orderId: id,
    brandName: "Amazon",
    denomination: "50",
    beneficiaryAccount: "a@b.com",
    invoice: "lnbc...",
    invoiceSats: 250_000,
    feeSats: "2500",
    expectedAmountSats: 10_000,
    swapId: "sub-1",
    phase: "awaiting_payment",
    createdAt: 0,
    updatedAt: 0,
    ...over
  };
}

describe("GiftcardOrderStore", () => {
  it("saves + lists newest-first and upserts by orderId", async () => {
    await store.save(order("a"));
    await store.save(order("b"));
    await store.save(order("a", { phase: "paid" })); // re-save moves to front
    const list = await store.list();
    expect(list.map((o) => o.orderId)).toEqual(["a", "b"]);
    expect(list[0]!.phase).toBe("paid");
  });

  it("updates a stored order in place (no-op if absent)", async () => {
    await store.save(order("a"));
    await store.update("a", { swapId: "sub-99", lockupTxid: "txid-1", phase: "paid" });
    const got = await store.get("a");
    expect(got).toMatchObject({ swapId: "sub-99", lockupTxid: "txid-1", phase: "paid" });
    // Absent orderId is a no-op.
    await store.update("missing", { phase: "delivered" });
    expect((await store.list()).length).toBe(1);
  });

  it("removes an order", async () => {
    await store.save(order("a"));
    await store.save(order("b"));
    await store.remove("a");
    expect((await store.list()).map((o) => o.orderId)).toEqual(["b"]);
  });

  it("caps the log at MAX_STORED_ORDERS (newest kept)", async () => {
    for (let i = 0; i < MAX_STORED_ORDERS + 5; i++) await store.save(order(`o${i}`));
    const list = await store.list();
    expect(list.length).toBe(MAX_STORED_ORDERS);
    expect(list[0]!.orderId).toBe(`o${MAX_STORED_ORDERS + 4}`); // newest first
  });

  it("persists durably across a fresh store instance", async () => {
    await store.save(order("a", { phase: "delivered" }));
    const reopened = new GiftcardOrderStore({ dataDir, logger: SILENT });
    expect((await reopened.get("a"))?.phase).toBe("delivered");
  });

  it("round-trips the redemption delivery and tolerates legacy records without it", async () => {
    await store.save(order("a", { delivery: { kind: "code", value: "PIN-42" } }));
    expect((await store.get("a"))?.delivery).toEqual({ kind: "code", value: "PIN-42" });
    await store.update("a", { phase: "delivered", delivery: { kind: "url", value: "https://redeem/x" } });
    expect((await store.get("a"))?.delivery).toEqual({ kind: "url", value: "https://redeem/x" });
    // A legacy record written before `delivery` existed loads without crashing.
    const legacy = order("legacy");
    delete (legacy as Partial<StoredGiftcardOrder>).delivery; // the helper omits it anyway
    await writeFile(
      join(dataDir, GIFTCARD_ORDERS_FILE),
      JSON.stringify({ format: "depix-giftcard-orders", version: 1, orders: [legacy] })
    );
    const got = await store.get("legacy");
    expect(got?.orderId).toBe("legacy");
    expect(got?.delivery).toBeUndefined();
  });

  it("discards a corrupt log instead of throwing", async () => {
    await writeFile(join(dataDir, GIFTCARD_ORDERS_FILE), "{ not json");
    await expect(store.list()).resolves.toEqual([]);
    // A subsequent save recovers the file.
    await store.save(order("a"));
    const raw = await readFile(join(dataDir, GIFTCARD_ORDERS_FILE), "utf8");
    expect(raw).toContain("depix-giftcard-orders");
  });
});
