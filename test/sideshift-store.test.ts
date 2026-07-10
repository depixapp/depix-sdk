// Durable SideShift shift log (spec §5.4/§2.5): upsert newest-first, patch, remove,
// cap, and survive a corrupt file (nothing key-shaped lives here — plaintext is ok).
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_STORED_SHIFTS,
  SIDESHIFT_SHIFTS_FILE,
  SideShiftStore,
  type StoredSideShift
} from "../src/convert/sideshift-store.js";

const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

function rec(id: string, over: Partial<StoredSideShift> = {}): StoredSideShift {
  return {
    id,
    type: "send",
    asset: "USDT",
    network: "tron",
    depositAddress: "lq1qdep",
    settleAddress: "Trecipient",
    refundAddress: null,
    status: "waiting",
    depositAmount: "10",
    settleAmount: "9.9",
    liquidTxid: null,
    expiresAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...over
  };
}

let dataDir: string;
let store: SideShiftStore;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-sideshift-store-"));
  store = new SideShiftStore({ dataDir, logger: SILENT, now: () => 1_000 });
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("SideShiftStore", () => {
  it("saves newest-first, upserts by id, and persists durably", async () => {
    await store.save(rec("a"));
    await store.save(rec("b"));
    let list = await store.list();
    expect(list.map((s) => s.id)).toEqual(["b", "a"]);
    // Re-saving `a` moves it to the front (upsert).
    await store.save(rec("a", { status: "settling" }));
    list = await store.list();
    expect(list.map((s) => s.id)).toEqual(["a", "b"]);
    expect(list[0]!.status).toBe("settling");
    // File on disk is the documented format.
    const raw = JSON.parse(await readFile(join(dataDir, SIDESHIFT_SHIFTS_FILE), "utf8"));
    expect(raw.format).toBe("depix-sideshift-shifts");
    expect(raw.version).toBe(1);
  });

  it("patches an existing record, is a no-op for an unknown id", async () => {
    await store.save(rec("a"));
    await store.update("a", { status: "settled", liquidTxid: "tx" });
    expect((await store.get("a"))?.status).toBe("settled");
    expect((await store.get("a"))?.liquidTxid).toBe("tx");
    await store.update("missing", { status: "settled" });
    expect(await store.get("missing")).toBeNull();
  });

  it("removes by id and caps the log", async () => {
    await store.save(rec("a"));
    await store.remove("a");
    expect(await store.list()).toHaveLength(0);
    for (let i = 0; i < MAX_STORED_SHIFTS + 5; i++) await store.save(rec(`s${i}`));
    expect(await store.list()).toHaveLength(MAX_STORED_SHIFTS);
  });

  it("discards a corrupt file rather than throwing (no funds/keys live here)", async () => {
    await writeFile(join(dataDir, SIDESHIFT_SHIFTS_FILE), "{ not json", "utf8");
    expect(await store.list()).toEqual([]);
  });
});
