// ConversionPlanStore (PR-C) — durable, AES-256-GCM authenticated multi-hop
// conversion plans (one envelope per plan, AAD = planId), mirroring the Boltz
// swap store's anti-tamper contract: a record that fails authentication is
// discarded and never acted upon (a forged plan could otherwise redirect a
// continuation leg or forge a guardrail authorization).
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64 } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConversionPlanStore,
  CONVERSION_PLANS_FILE,
  type StoredConversionPlan
} from "../src/convert/plan-store.js";
import { enumerateRoutes } from "../src/convert/routes.js";
import { isDepixSdkError } from "../src/errors.js";

const PASSPHRASE = "correct-horse-battery-staple";

const ROUTE = enumerateRoutes({ from: "DEPIX", to: "USDT", network: "ethereum" })[0]!;

function makePlan(planId = "plan-1"): StoredConversionPlan {
  return {
    planId,
    intent: { from: "DEPIX", to: "USDT", network: "ethereum", amountSats: 100_000_000n },
    route: ROUTE,
    params: { address: "0x" + "a".repeat(40) },
    currentLegIndex: 0,
    legResults: [{ state: "settled", txids: ["swap_txid"], receivedSats: 19_500n, trackingId: null }],
    state: "pending",
    createdAt: 0
  };
}

let dataDir: string;
let store: ConversionPlanStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-plan-store-"));
  store = new ConversionPlanStore({ dataDir, passphrase: PASSPHRASE, saltB64: base64.encode(randomBytes(16)) });
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("ConversionPlanStore — encrypted round-trip", () => {
  it("put/get round-trips a plan, reviving bigint amounts", async () => {
    await store.put(makePlan());
    const got = await store.get("plan-1");
    expect(got).not.toBeNull();
    expect(got!.intent.amountSats).toBe(100_000_000n);
    expect(got!.legResults[0]!.receivedSats).toBe(19_500n);
    expect(got!.route.id).toBe(ROUTE.id);
    expect(got!.createdAt).toBeGreaterThan(0); // stamped on first put
  });

  it("the file on disk never contains plaintext plan material", async () => {
    await store.put(makePlan());
    const raw = await readFile(join(dataDir, CONVERSION_PLANS_FILE), "utf8");
    expect(raw).not.toContain("swap_txid");
    expect(raw).not.toContain("0x" + "a".repeat(40));
    expect(raw).not.toContain("DEPIX");
  });

  it("patch() read-modifies-writes one record", async () => {
    await store.put(makePlan());
    await store.patch("plan-1", (r) => {
      r.currentLegIndex = 1;
      r.state = "executing";
    });
    const got = await store.get("plan-1");
    expect(got!.currentLegIndex).toBe(1);
    expect(got!.state).toBe("executing");
  });

  it("remove() deletes the record; count() reflects it", async () => {
    await store.put(makePlan("a"));
    await store.put(makePlan("b"));
    expect(await store.count()).toBe(2);
    await store.remove("a");
    expect(await store.count()).toBe(1);
    expect(await store.get("a")).toBeNull();
  });
});

describe("ConversionPlanStore — anti-tamper (GCM, AAD = planId)", () => {
  it("a ciphertext-tampered record fails authentication: get() throws, readAll() collects it", async () => {
    await store.put(makePlan());
    const path = join(dataDir, CONVERSION_PLANS_FILE);
    const file = JSON.parse(await readFile(path, "utf8")) as { records: Array<{ id: string; ct: string }> };
    const ct = Uint8Array.from(base64.decode(file.records[0]!.ct));
    ct[0] = ct[0]! ^ 0xff;
    file.records[0]!.ct = base64.encode(ct);
    await writeFile(path, JSON.stringify(file));

    await expect(store.get("plan-1")).rejects.toSatisfy((e) => isDepixSdkError(e, "PLAN_VALIDATION_FAILED"));
    const all = await store.readAll();
    expect(all.records).toHaveLength(0);
    expect(all.tamperedIds).toEqual(["plan-1"]);
  });

  it("swapping a record under another planId (AAD mismatch) fails authentication", async () => {
    await store.put(makePlan());
    const path = join(dataDir, CONVERSION_PLANS_FILE);
    const file = JSON.parse(await readFile(path, "utf8")) as { records: Array<{ id: string }> };
    file.records[0]!.id = "plan-EVIL";
    await writeFile(path, JSON.stringify(file));
    const all = await store.readAll();
    expect(all.records).toHaveLength(0);
    expect(all.tamperedIds).toEqual(["plan-EVIL"]);
  });

  it("a wholesale-corrupt file is treated as empty (logged), not a crash", async () => {
    await writeFile(join(dataDir, CONVERSION_PLANS_FILE), "not json at all");
    const all = await store.readAll();
    expect(all.records).toHaveLength(0);
    expect(all.tamperedIds).toHaveLength(0);
  });
});
