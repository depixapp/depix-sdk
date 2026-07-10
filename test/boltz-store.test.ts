// BoltzSwapStore (spec §5.3 / §2.4) — durable, AES-256-GCM authenticated,
// one envelope per swap (AAD = swapId). A tampered record is discarded, never
// acted upon.
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64 } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BoltzSwapStore,
  BOLTZ_SWAPS_FILE,
  type StoredReverseSwap,
  type StoredSubmarineSwap
} from "../src/convert/boltz/store.js";
import { isDepixSdkError } from "../src/errors.js";

const PASSPHRASE = "correct-horse-battery-staple";

const SUB: StoredSubmarineSwap = {
  type: "submarine",
  swapId: "sub-1",
  invoice: "lnbc...",
  lockupAddress: "lq1lockup",
  expectedAmountSats: 260_000,
  invoiceSats: 250_000,
  swapTree: { claimLeaf: {}, refundLeaf: {} },
  claimPublicKey: "03" + "cc".repeat(32),
  blindingKey: "dd".repeat(32),
  timeoutBlockHeight: 1_000_100,
  refundPrivateKeyHex: "aa".repeat(32),
  refundPublicKeyHex: "02" + "bb".repeat(32),
  state: "locked_up",
  createdAt: 0
};

const REV: StoredReverseSwap = {
  type: "reverse",
  swapId: "rev-1",
  invoice: "lnbc...",
  lockupAddress: "lq1lockup2",
  onchainAmount: 200_000,
  swapTree: {},
  refundPublicKey: "03" + "ee".repeat(32),
  timeoutBlockHeight: 1_000_200,
  claimAddress: "lq1claim",
  preimageHex: "ff".repeat(32),
  claimPublicKeyHex: "02" + "11".repeat(32),
  claimPrivateKeyHex: "22".repeat(32),
  state: "awaiting_payment",
  createdAt: 0
};

let dataDir: string;
let store: BoltzSwapStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-boltz-store-"));
  store = new BoltzSwapStore({ dataDir, passphrase: PASSPHRASE, saltB64: base64.encode(randomBytes(16)) });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("BoltzSwapStore", () => {
  it("round-trips submarine + reverse records through encryption", async () => {
    await store.put(SUB);
    await store.put(REV);
    const { records, tamperedIds } = await store.readAll();
    expect(tamperedIds).toEqual([]);
    expect(records).toHaveLength(2);
    const sub = records.find((r) => r.swapId === "sub-1") as StoredSubmarineSwap;
    expect(sub.type).toBe("submarine");
    expect(sub.refundPrivateKeyHex).toBe("aa".repeat(32));
    const rev = records.find((r) => r.swapId === "rev-1") as StoredReverseSwap;
    expect(rev.claimPrivateKeyHex).toBe("22".repeat(32));
  });

  it("patches and removes a record without touching the others", async () => {
    await store.put(SUB);
    await store.put(REV);
    await store.patch("sub-1", (r) => {
      (r as StoredSubmarineSwap).state = "refund_pending";
    });
    expect((await store.get("sub-1")) as StoredSubmarineSwap).toMatchObject({ state: "refund_pending" });
    await store.remove("sub-1");
    expect(await store.get("sub-1")).toBeNull();
    expect(await store.count()).toBe(1); // rev-1 survives
  });

  it("discards a tampered record (broken GCM tag) — readAll collects it, get() throws", async () => {
    await store.put(SUB);
    const path = join(dataDir, BOLTZ_SWAPS_FILE);
    const file = JSON.parse(await readFile(path, "utf8")) as { records: { id: string; ct: string }[] };
    // Flip a base64 char in the ciphertext → GCM authentication fails.
    const ct = file.records[0]!.ct;
    file.records[0]!.ct = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    await writeFile(path, JSON.stringify(file));

    const { records, tamperedIds } = await store.readAll();
    expect(records).toEqual([]);
    expect(tamperedIds).toEqual(["sub-1"]);
    await expect(store.get("sub-1")).rejects.toSatisfy((e: unknown) =>
      isDepixSdkError(e, "SWAP_VALIDATION_FAILED")
    );
  });
});
