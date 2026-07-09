// Update store (spec §2.5): LWK Update chain persisted as files, tolerant reads.
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UpdateStore } from "../src/store/update-store.js";

let dataDir: string;
let store: UpdateStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-updates-"));
  store = new UpdateStore(dataDir);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("UpdateStore", () => {
  it("stores and retrieves update blobs keyed by wollet status", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    await store.putUpdate("12345678901234567890", bytes);
    const back = await store.getUpdate("12345678901234567890");
    expect(back).toEqual(bytes);
  });

  it("returns null for a missing status key", async () => {
    expect(await store.getUpdate("999")).toBeNull();
  });

  it("rejects status keys that are not decimal strings (path safety)", async () => {
    await expect(store.putUpdate("../evil", new Uint8Array([1]))).rejects.toThrow();
    await expect(store.getUpdate("../evil")).rejects.toThrow();
  });

  it("tolerant read: unreadable blob is treated as missing (chain tail discarded, §2.5)", async () => {
    // A directory where the file should be makes readFile fail with EISDIR.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dataDir, "updates", "42.bin"), { recursive: true });
    expect(await store.getUpdate("42")).toBeNull();
  });

  it("writes leave no tmp residue (atomic tmp+rename)", async () => {
    await store.putUpdate("7", Uint8Array.from([9]));
    const entries = await readdir(join(dataDir, "updates"));
    expect(entries).toEqual(["7.bin"]);
  });

  it("meta.json merge-writes and tolerates corruption", async () => {
    await store.writeMeta({ lastScanAt: 111 });
    await store.writeMeta({ lastSuccessAt: 222 });
    expect(await store.readMeta()).toMatchObject({ lastScanAt: 111, lastSuccessAt: 222 });
    await writeFile(join(dataDir, "meta.json"), "{corrupt", "utf8");
    expect(await store.readMeta()).toEqual({});
  });

  it("clearAll wipes the chain and meta", async () => {
    await store.putUpdate("1", Uint8Array.from([1]));
    await store.writeMeta({ lastScanAt: 1 });
    await store.clearAll();
    expect(await store.getUpdate("1")).toBeNull();
    expect(await store.readMeta()).toEqual({});
  });
});
