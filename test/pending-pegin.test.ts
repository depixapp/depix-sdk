// Pending peg-in store (spec §5.2): single in-flight record, 7-day TTL prune,
// tolerant reads, atomic durable write.
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PendingPegIn, PENDING_PEGIN_FILE, PENDING_PEGIN_TTL_MS } from "../src/convert/pending-pegin.js";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-pegin-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("PendingPegIn", () => {
  it("round-trips a record and clears it", async () => {
    const store = new PendingPegIn(dataDir);
    expect(await store.load()).toBeNull();
    await store.put({ orderId: "o1", pegAddr: "bc1qfund", recvAddr: "lq1qmine" });
    const rec = await store.load();
    expect(rec).toMatchObject({ orderId: "o1", pegAddr: "bc1qfund", recvAddr: "lq1qmine" });
    expect(typeof rec!.createdAt).toBe("number");
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("prunes an entry older than the 7-day TTL and removes the file", async () => {
    let t = 10_000_000;
    const store = new PendingPegIn(dataDir, { now: () => t });
    await store.put({ orderId: "old", pegAddr: "bc1q", recvAddr: "lq1q", createdAt: t });
    t += PENDING_PEGIN_TTL_MS + 1;
    expect(await store.load()).toBeNull();
    await expect(readFile(join(dataDir, PENDING_PEGIN_FILE), "utf8")).rejects.toThrow();
  });

  it("treats a malformed / incomplete entry as absent", async () => {
    const store = new PendingPegIn(dataDir);
    await store.put({ orderId: "o", pegAddr: "p", recvAddr: "r" });
    // Corrupt the file with junk.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dataDir, PENDING_PEGIN_FILE), "{ not json");
    expect(await store.load()).toBeNull();
  });
});
