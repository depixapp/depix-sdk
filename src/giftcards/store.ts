// Durable gift-card order log — <dataDir>/giftcard-orders.json (spec §5.5).
//
// Mirrors the frontend's per-user localStorage order list (shop-logic.js): it
// tracks each order so listOrders() can report status/delivery and re-poll after
// a restart. Cap 100 (parity with MAX_STORED_ORDERS), newest first.
//
// NOT encrypted: unlike boltz-swaps.json (which holds swap refund keys), an order
// record carries only metadata — orderId, invoice, beneficiary, denomination,
// status. The Lightning payment's refund material lives in boltz-swaps.json,
// authenticated there (§5.3). So a durable plaintext JSON is enough here; a
// tampered record cannot move funds (the refund key is elsewhere).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultLogger, type Logger } from "../logger.js";
import { Mutex } from "../mutex.js";
import { ensureDir, writeFileDurable } from "../store/fs-util.js";
import type { OrderDelivery } from "./cryptorefills.js";

export const GIFTCARD_ORDERS_FILE = "giftcard-orders.json";
export const MAX_STORED_ORDERS = 100;

export interface StoredGiftcardOrder {
  orderId: string;
  brandName: string;
  denomination: string;
  beneficiaryAccount: string;
  invoice: string;
  invoiceSats: number;
  /** Service fee sats (BigInt serialized as a decimal string, JSON-safe). */
  feeSats: string;
  /** L-BTC the Boltz submarine lockup locks (expectedAmount). */
  expectedAmountSats: number;
  swapId: string;
  lockupTxid?: string;
  /** Last-known CryptoRefills order phase (from mapOrderStatus). */
  phase: string;
  /**
   * Last-known redemption delivery (from extractDelivery) — the code/URL the
   * buyer redeems. null until delivered; absent on legacy records (parity with
   * the frontend, which persists { phase, delivery } per order).
   */
  delivery?: OrderDelivery | null;
  createdAt: number;
  updatedAt: number;
}

interface GiftcardOrdersFileV1 {
  format: "depix-giftcard-orders";
  version: 1;
  orders: StoredGiftcardOrder[];
}

export interface GiftcardOrderStoreOptions {
  dataDir: string;
  logger?: Logger;
  now?: () => number;
}

export class GiftcardOrderStore {
  private readonly dataDir: string;
  private readonly filePath: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly mutex = new Mutex();

  constructor(options: GiftcardOrderStoreOptions) {
    this.dataDir = options.dataDir;
    this.filePath = join(options.dataDir, GIFTCARD_ORDERS_FILE);
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? Date.now;
  }

  private async readOrders(): Promise<StoredGiftcardOrder[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as GiftcardOrdersFileV1;
      if (parsed.format !== "depix-giftcard-orders" || parsed.version !== 1 || !Array.isArray(parsed.orders)) {
        throw new Error("unknown format/version");
      }
      return parsed.orders.filter((o) => o && typeof o.orderId === "string" && o.orderId.length > 0);
    } catch (err) {
      // A corrupt log strands nothing (no funds live here) — discard + log.
      this.logger.error("giftcard-orders.json is corrupt — discarding the order log", {
        error: String((err as Error)?.message ?? err)
      });
      return [];
    }
  }

  private async writeOrders(orders: StoredGiftcardOrder[]): Promise<void> {
    await ensureDir(this.dataDir);
    const file: GiftcardOrdersFileV1 = {
      format: "depix-giftcard-orders",
      version: 1,
      orders: orders.slice(0, MAX_STORED_ORDERS)
    };
    await writeFileDurable(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
  }

  /** Every stored order, newest first. */
  list(): Promise<StoredGiftcardOrder[]> {
    return this.readOrders();
  }

  /** Upsert by orderId, moving it to the front (newest first). Returns the list. */
  async save(order: StoredGiftcardOrder): Promise<StoredGiftcardOrder[]> {
    return this.mutex.runExclusive(async () => {
      const now = this.now();
      const rec: StoredGiftcardOrder = {
        ...order,
        createdAt: order.createdAt || now,
        updatedAt: order.updatedAt || now
      };
      const rest = (await this.readOrders()).filter((o) => o.orderId !== order.orderId);
      const next = [rec, ...rest].slice(0, MAX_STORED_ORDERS);
      await this.writeOrders(next);
      return next;
    });
  }

  /** Merge a patch into a stored order (no-op if absent). Returns the list. */
  async update(orderId: string, patch: Partial<StoredGiftcardOrder>): Promise<StoredGiftcardOrder[]> {
    return this.mutex.runExclusive(async () => {
      const orders = await this.readOrders();
      let touched = false;
      const next = orders.map((o) => {
        if (o.orderId !== orderId) return o;
        touched = true;
        return { ...o, ...patch, orderId: o.orderId, updatedAt: this.now() };
      });
      if (touched) await this.writeOrders(next);
      return next;
    });
  }

  async get(orderId: string): Promise<StoredGiftcardOrder | null> {
    return (await this.readOrders()).find((o) => o.orderId === orderId) ?? null;
  }

  async remove(orderId: string): Promise<StoredGiftcardOrder[]> {
    return this.mutex.runExclusive(async () => {
      const orders = await this.readOrders();
      const next = orders.filter((o) => o.orderId !== orderId);
      if (next.length !== orders.length) await this.writeOrders(next);
      return next;
    });
  }
}
