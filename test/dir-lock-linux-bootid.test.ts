// Dir-lock boot-id semantics when /proc/sys/kernel/random/boot_id IS readable
// (every real Linux host — this is what ubuntu CI exercises natively). The
// /proc read is mocked so the branch runs identically on macOS.
//
// Pins the conservatism gap that Linux CI exposed (main red, 2026-07): a live
// holder that recorded a time-based boot id (sandbox denied /proc but not
// uptime/hostname, or another derivation entirely) was STOLEN by an acquirer
// holding a linux:<uuid> id, because sameBoot() treated mixed-form ids as a
// decisively different boot. Mixed forms prove nothing — the lock must fall
// back to PID liveness, never steal.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FAKE_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((path, ...rest) =>
    path === "/proc/sys/kernel/random/boot_id"
      ? `${FAKE_UUID}\n`
      : (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)) as typeof actual.readFileSync;
  return { ...actual, readFileSync };
});

// Import AFTER the mock so dir-lock binds the mocked readFileSync.
const { acquireDirLock } = await import("../src/store/dir-lock.js");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "depix-dirlock-linux-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("acquireDirLock with a readable Linux boot_id", () => {
  it("records linux:<uuid> as the boot id", async () => {
    const lock = await acquireDirLock(dir);
    const [pid, , boot] = (await readFile(join(dir, ".lock"), "utf8")).split("\n");
    expect(Number.parseInt(pid!, 10)).toBe(process.pid);
    expect(boot).toBe(`linux:${FAKE_UUID}`);
    await lock.release();
  });

  it("CONSERVATIVE: does NOT steal a live holder recorded under a time-based id (mixed forms are not decisive)", async () => {
    await writeFile(
      join(dir, ".lock"),
      `${process.pid}\n${Date.now()}\ntime:some-host:1751000000\n`,
      { mode: 0o600 }
    );
    await expect(acquireDirLock(dir)).rejects.toMatchObject({ code: "WALLET_DIR_LOCKED" });
  });

  it("still breaks a live PID recorded under a DIFFERENT linux uuid (decisive: reused PID from a prior boot)", async () => {
    await writeFile(
      join(dir, ".lock"),
      `${process.pid}\n${Date.now()}\nlinux:11111111-2222-3333-4444-555555555555\n`,
      { mode: 0o600 }
    );
    const lock = await acquireDirLock(dir);
    await lock.release();
  });

  it("does not steal a live holder recorded under the SAME linux uuid", async () => {
    await writeFile(
      join(dir, ".lock"),
      `${process.pid}\n${Date.now()}\nlinux:${FAKE_UUID}\n`,
      { mode: 0o600 }
    );
    await expect(acquireDirLock(dir)).rejects.toMatchObject({ code: "WALLET_DIR_LOCKED" });
  });
});
