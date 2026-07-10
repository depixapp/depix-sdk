#!/usr/bin/env node
// Post-build smoke test of the COMPILED artifact (spec §8.5).
//
// Every CI cell (Node 22.4 / 24 / current × ubuntu / macos) runs this after
// `npm run build` to prove the shipped `dist/` actually works on that platform:
//   1. lwk_node wasm init — the engine loads and the DePix-requested
//      Pset.addDetails export is present (§2.1);
//   2. descriptor golden — a fixed mnemonic derives the known CT descriptor;
//   3. addr[0] golden — abandon…about derives the known first address (§2.1);
//   4. seed-store roundtrip — create (encrypt) → close → open → exportMnemonic
//      (decrypt) returns the SAME words (§2.4, exercised through dist/index.js).
//
// It imports the built package entry (../dist/index.js) plus one internal built
// module for the engine init check — this is a repo-local script, so relative
// imports bypass the package `exports` map by design.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const distIndex = resolve(here, "../dist/index.js");
const distLwk = resolve(here, "../dist/engine/lwk.js");

// Fixed vectors — identical to test/engine.test.ts (§2.1 goldens).
const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const GOLDEN_DESCRIPTOR =
  "ct(slip77(9c8e4f05c7711a98c838be228bcb84924d4570ca53f35fa1c793e58841d47023),elwpkh([73c5da0a/84'/1776'/0']xpub6CRFzUgHFDaiDAQFNX7VeV9JNPDRabq6NYSpzVZ8zW8ANUCiDdenkb1gBoEZuXNZb3wPc1SVcDXgD2ww5UBtTb8s8ArAbTkoRQ8qn34KgcY/<0;1>/*))#87kykuta";
const GOLDEN_ADDR_0 =
  "lq1qqvxk052kf3qtkxmrakx50a9gc3smqad2ync54hzntjt980kfej9kkfe0247rp5h4yzmdftsahhw64uy8pzfe7cpg4fgykm7cv";
const PASSPHRASE = "smoke-test-passphrase-1234"; // ≥12 chars (§2.4 WEAK_PASSPHRASE gate)

function step(msg) {
  process.stdout.write(`  • ${msg}\n`);
}

async function main() {
  process.stdout.write(`smoke: node ${process.version} on ${process.platform}/${process.arch}\n`);

  // 1) lwk_node wasm init + DePix-requested export.
  const lwk = await import(distLwk);
  assert.equal(typeof lwk.Signer, "function", "lwk_node Signer export missing (wasm did not init)");
  assert.equal(
    typeof lwk.Pset.prototype.addDetails,
    "function",
    "Pset.addDetails export missing — the DePix-requested lwk_node export regressed (§2.1)"
  );
  step("lwk_node wasm initialized; Pset.addDetails present");

  const { DepixWallet } = await import(distIndex);

  // 2 & 3) golden descriptor + addr[0] via the public API (restore is born
  //         backup-confirmed, so getReceiveAddress does not hit the backup gate).
  const goldenDir = await mkdtemp(join(tmpdir(), "depix-smoke-golden-"));
  try {
    const w = await DepixWallet.restore({
      dataDir: goldenDir,
      passphrase: PASSPHRASE,
      mnemonic: KNOWN_MNEMONIC
    });
    try {
      assert.equal(w.getDescriptor(), GOLDEN_DESCRIPTOR, "descriptor golden mismatch");
      step("descriptor golden matches");
      const addr0 = await w.getReceiveAddress({ index: 0 });
      assert.equal(addr0, GOLDEN_ADDR_0, "addr[0] golden mismatch");
      step("addr[0] golden matches");
    } finally {
      await w.close();
    }
  } finally {
    await rm(goldenDir, { recursive: true, force: true });
  }

  // 4) seed-store roundtrip: create (encrypt) → close → open → exportMnemonic.
  const rtDir = await mkdtemp(join(tmpdir(), "depix-smoke-store-"));
  try {
    const created = await DepixWallet.create({
      dataDir: rtDir,
      passphrase: PASSPHRASE,
      // Non-interactive escape hatch (§2.9): mnemonic returned in the foreground,
      // born backup-confirmed only with this explicit flag.
      mnemonicSecured: true
    });
    await created.wallet.close();

    const reopened = await DepixWallet.open({ dataDir: rtDir, passphrase: PASSPHRASE });
    try {
      const back = await reopened.exportMnemonic();
      assert.equal(back, created.mnemonic, "seed-store roundtrip mismatch (decrypt != encrypt)");
      step("seed-store encrypt/decrypt roundtrip ok");
    } finally {
      await reopened.close();
    }

    // Wrong passphrase must fail closed (§2.4 WRONG_PASSPHRASE), not silently open.
    let threw = false;
    try {
      await DepixWallet.open({ dataDir: rtDir, passphrase: "wrong-passphrase-000" });
    } catch (err) {
      threw = true;
      assert.equal(err?.code, "WRONG_PASSPHRASE", `expected WRONG_PASSPHRASE, got ${err?.code}`);
    }
    assert.ok(threw, "opening with the wrong passphrase should have thrown");
    step("wrong passphrase fails closed (WRONG_PASSPHRASE)");
  } finally {
    await rm(rtDir, { recursive: true, force: true });
  }

  process.stdout.write("smoke: PASS\n");
}

main().catch((err) => {
  process.stderr.write(`smoke: FAIL — ${err?.stack ?? err}\n`);
  process.exit(1);
});
