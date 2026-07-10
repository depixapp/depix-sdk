import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, redactSecrets, registerSecret, clearRegisteredSecrets } from "../src/logger.js";

describe("logger redaction (spec §6.1)", () => {
  beforeEach(() => {
    clearRegisteredSecrets();
  });

  it("redacts sk_live_/sk_test_ API keys", () => {
    expect(redactSecrets("auth failed for sk_live_abc123DEF")).not.toContain("sk_live_abc123DEF");
    expect(redactSecrets("auth failed for sk_live_abc123DEF")).toContain("sk_live_[REDACTED]");
    expect(redactSecrets("key sk_test_xyz789")).toContain("sk_test_[REDACTED]");
  });

  it("redacts registered secrets (passphrase, mnemonic) wherever they appear", () => {
    const passphrase = "correct horse battery staple";
    const mnemonic =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    registerSecret(passphrase);
    registerSecret(mnemonic);
    const line = `failed with passphrase="${passphrase}" seed=${mnemonic}!`;
    const out = redactSecrets(line);
    expect(out).not.toContain(passphrase);
    expect(out).not.toContain(mnemonic);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts BIP39-shaped mnemonics BY PATTERN, with no registration (§2.3 fix)", () => {
    // The decrypted mnemonic is never registerSecret()'d (that would keep the
    // seed resident forever). It is scrubbed by pattern instead — proven here
    // WITHOUT any registerSecret() call.
    const mnemonic =
      "legal winner thank year wave sausage worth useful legal winner thank yellow";
    const out = redactSecrets(`unlock failed seed=${mnemonic}; retry`);
    expect(out).not.toContain(mnemonic);
    expect(out).not.toContain("sausage worth");
    expect(out).toContain("[REDACTED_MNEMONIC]");
    expect(out).toContain("retry"); // surrounding context is preserved
  });

  it("redacts CT descriptors (blinding-key material)", () => {
    const descriptor =
      "ct(slip77(9c8e4f05c7711a98c838be228bcb84924d4570ca53f35fa1c793e58841d47023),elwpkh([73c5da0a/84'/1776'/0']xpub6CRFzUgHFDaiDAQFNX7VeV9JNPDRabq6NYSpzVZ8zW8ANUCiDdenkb1gBoEZuXNZb3wPc1SVcDXgD2ww5UBtTb8s8ArAbTkoRQ8qn34KgcY/<0;1>/*))#87kykuta";
    const out = redactSecrets(`descriptor is ${descriptor} end`);
    expect(out).not.toContain("slip77(9c8e4f05");
    expect(out).toContain("[REDACTED_DESCRIPTOR]");
    expect(out).toContain("end");
  });

  it("redacts extended private keys", () => {
    const out = redactSecrets("leak xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi ok");
    expect(out).not.toContain("xprv9s21ZrQH143K3QTDL4LXw2F");
    expect(out).toContain("[REDACTED_XPRV]");
  });

  it("writes to stderr, never stdout", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = createLogger({ level: "debug" });
    log.info("hello", { a: 1 });
    log.error("boom");
    expect(stderrSpy).toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it("applies redaction to formatted output including structured args", () => {
    registerSecret("hunter2hunter2");
    const writes: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
    const log = createLogger({ level: "debug" });
    log.warn("unlock failed", { passphrase: "hunter2hunter2", key: "sk_live_secretsecret" });
    const out = writes.join("");
    expect(out).not.toContain("hunter2hunter2");
    expect(out).not.toContain("sk_live_secretsecret");
    stderrSpy.mockRestore();
  });

  it("filters below the configured level", () => {
    const writes: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
    const log = createLogger({ level: "warn" });
    log.debug("quiet");
    log.info("quiet too");
    log.warn("loud");
    expect(writes.join("")).not.toContain("quiet");
    expect(writes.join("")).toContain("loud");
    stderrSpy.mockRestore();
  });
});
