import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentKeyStore, AGENT_IDENTITY_FILE } from "../src/agent/store.js";
import { generateAgentKeypair } from "../src/agent/keypair.js";
import { isDepixSdkError } from "../src/errors.js";

const PASSPHRASE = "correct-horse-battery"; // ≥12 chars

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-agentstore-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function store(passphrase = PASSPHRASE): AgentKeyStore {
  return new AgentKeyStore({ dataDir, passphrase });
}

describe("AgentKeyStore", () => {
  it("returns null / false when uninitialized", async () => {
    expect(await store().load()).toBeNull();
    expect(await store().exists()).toBe(false);
  });

  it("round-trips the keypair and meta", async () => {
    const kp = generateAgentKeypair();
    await store().save(kp, { username: "acme_agent" });

    expect(await store().exists()).toBe(true);
    const loaded = await store().load();
    expect(loaded).not.toBeNull();
    expect(loaded!.keypair.publicKeyHex).toBe(kp.publicKeyHex);
    expect([...loaded!.keypair.secretKey]).toEqual([...kp.secretKey]);
    expect(loaded!.meta.username).toBe("acme_agent");
  });

  it("merges meta without touching the sealed key", async () => {
    const kp = generateAgentKeypair();
    await store().save(kp, { username: "acme_agent" });
    await store().updateMeta({ merchantId: "mrc_1", registeredAt: "2026-07-16 12:00:00" });

    const loaded = await store().load();
    expect(loaded!.keypair.publicKeyHex).toBe(kp.publicKeyHex);
    expect(loaded!.meta).toMatchObject({ username: "acme_agent", merchantId: "mrc_1" });
  });

  it("rejects a wrong passphrase with agent_key_unreadable", async () => {
    await store().save(generateAgentKeypair());
    await expect(store("a-different-passphrase").load()).rejects.toSatisfy((e) =>
      isDepixSdkError(e, "agent_key_unreadable")
    );
  });

  it("rejects a tampered ciphertext (GCM auth failure)", async () => {
    await store().save(generateAgentKeypair());
    const path = join(dataDir, AGENT_IDENTITY_FILE);
    const file = JSON.parse(await readFile(path, "utf8"));
    // Flip the last base64 char of the ciphertext.
    const ct = file.secret.ct as string;
    file.secret.ct = ct.slice(0, -2) + (ct.at(-2) === "A" ? "B" : "A") + ct.at(-1);
    await writeFile(path, JSON.stringify(file));
    await expect(store().load()).rejects.toSatisfy((e) => isDepixSdkError(e, "agent_key_unreadable"));
  });

  it("rejects malformed JSON with agent_store_corrupted", async () => {
    await writeFile(join(dataDir, AGENT_IDENTITY_FILE), "{ not json");
    await expect(store().load()).rejects.toSatisfy((e) => isDepixSdkError(e, "agent_store_corrupted"));
  });

  it("refuses a weak passphrase on save", async () => {
    const weak = new AgentKeyStore({ dataDir, passphrase: "short" });
    await expect(weak.save(generateAgentKeypair())).rejects.toThrow(/at least/i);
  });
});
