// Dir-lock boot-id derivation under sandboxed runtimes (mainnet e2e P1,
// 2026-07-11): macOS seatbelt / hardened containers deny the uv_uptime /
// uv_os_gethostname syscalls with EPERM, which used to crash create()/open()
// inside acquireDirLock (uncaught ERR_SYSTEM_ERROR from os.uptime()). The
// fallback boot id must (a) keep the lock working, and (b) stay CONSERVATIVE:
// with no boot evidence the lock code may rely on PID liveness only — it must
// never treat "can't tell the boot" as "different boot ⇒ stale ⇒ steal".
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// os.uptime()/os.hostname() throw EPERM exactly like a sandboxed uv_* denial.
// /proc is absent on macOS and the mock keeps readFileSync real, so the linux
// branch also falls through on Linux CI? No — on Linux /proc exists, making the
// fallback unreachable there; these assertions only exercise the crash path on
// hosts without /proc. The conservative sameBoot behavior is asserted via lock
// files, which is host-independent.
const sandboxErr = () => {
  const err = new Error("uv_uptime returned EPERM (operation not permitted)") as NodeJS.ErrnoException;
  err.code = "ERR_SYSTEM_ERROR";
  throw err;
};

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    uptime: () => sandboxErr(),
    hostname: () => sandboxErr()
  };
});

// Import AFTER the mock so dir-lock binds the throwing os fns.
const { acquireDirLock } = await import("../src/store/dir-lock.js");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "depix-dirlock-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("acquireDirLock under a sandboxed runtime (os.uptime/hostname EPERM)", () => {
  it("REGRESSION: acquires and releases instead of crashing with ERR_SYSTEM_ERROR", async () => {
    const lock = await acquireDirLock(dir);
    const content = await readFile(join(dir, ".lock"), "utf8");
    const [pid, , boot] = content.split("\n");
    expect(Number.parseInt(pid!, 10)).toBe(process.pid);
    // The fallback id — never a crash, never a half-written lock.
    expect(boot).toBe("unknown");
    await lock.release();
  });

  it("CONSERVATIVE: does NOT steal a live holder's lock recorded under a real boot id", async () => {
    // A live PID (our own) recorded under a normal time-based boot id from a
    // non-sandboxed process. The sandboxed acquirer cannot prove a different
    // boot, so it must treat the lock as HELD (PID liveness), not stale.
    await writeFile(
      join(dir, ".lock"),
      `${process.pid}\n${Date.now()}\ntime:some-host:1751000000\n`,
      { mode: 0o600 }
    );
    await expect(acquireDirLock(dir)).rejects.toMatchObject({ code: "WALLET_DIR_LOCKED" });
  });

  it("still breaks a genuinely stale lock (dead PID) and acquires", async () => {
    // PID far above any live range on the host; kill(pid, 0) fails ⇒ stale.
    await writeFile(
      join(dir, ".lock"),
      `999999999\n${Date.now()}\ntime:some-host:1751000000\n`,
      { mode: 0o600 }
    );
    const lock = await acquireDirLock(dir);
    await lock.release();
  });
});
