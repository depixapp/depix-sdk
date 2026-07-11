// Exclusive dataDir lock (spec §2.4 — mandatory).
//
// Rationale: two MCP hosts (Claude Desktop + Cursor) spawning depix-wallet-mcp
// against the same default ~/.depix-wallet would race the guardrail
// accounting (both read the window, both sign inside the individual cap, the
// sum exceeds the daily cap, last-writer-wins erases the other's entries) and
// clobber pending-withdrawals.json / updates/*.bin. The guardrail is the ONLY
// layer for sends/swaps/gift cards (§4.6), so this lock is not optional.
//
// Mechanics: `<dataDir>/.lock` created with O_EXCL containing PID + timestamp.
// A second process gets a typed WALLET_DIR_LOCKED immediately — no silent
// read-only fallback. Stale detection: if the recorded PID is dead (ESRCH),
// the lock is broken and taken over.

import { readFileSync } from "node:fs";
import { open, readFile, unlink } from "node:fs/promises";
import { hostname, uptime } from "node:os";
import { join } from "node:path";
import { WalletError } from "../errors.js";
import { FILE_MODE } from "./fs-util.js";

export interface DirLock {
  readonly path: string;
  release(): Promise<void>;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means "alive but not ours" — still alive. Only ESRCH is dead.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A per-boot identifier. On PID reuse, `process.kill(pid, 0)` alone cannot tell
 * a still-live original holder from an unrelated process that inherited the PID
 * after a reboot — pairing liveness with the boot id closes that hole (the
 * recorded holder is from a different boot ⇒ definitely stale). Linux exposes a
 * stable UUID; elsewhere we approximate from the boot time.
 */
/**
 * Boot id when the runtime cannot determine the boot (sandboxes deny the
 * uv_uptime / uv_os_gethostname syscalls with EPERM — e.g. macOS seatbelt,
 * hardened containers; mainnet e2e P1, 2026-07-11). sameBoot() treats this
 * value as SAME-boot against anything: we can never prove a different boot, so
 * stale-lock detection degrades to PID-liveness only — conservative (a live
 * holder's lock is never stolen), and create()/open() no longer crash.
 */
const BOOT_ID_UNKNOWN = "unknown";

function bootId(): string {
  try {
    return `linux:${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}`;
  } catch {
    /* no /proc (macOS) — fall through to the time-based derivation */
  }
  try {
    // Derive the boot epoch (seconds). uptime()/Date.now() jitter is
    // sub-second, far below any real reboot gap (compared with a tolerance in
    // sameBoot()), so this is a stable per-boot value.
    return `time:${hostname()}:${Math.round(Date.now() / 1000 - uptime())}`;
  } catch {
    // Sandboxed runtime denied the syscall(s) — see BOOT_ID_UNKNOWN.
    return BOOT_ID_UNKNOWN;
  }
}

/**
 * Whether two boot ids denote the same boot. Exact match for Linux UUIDs; for
 * the time-based fallback, within a 60s tolerance (absorbs derivation jitter
 * while staying far under any reboot gap). Unparseable/mismatched ⇒ treated as
 * DIFFERENT boot only when both are decisively parseable — otherwise we stay
 * conservative and never break a live lock. An UNKNOWN id (sandboxed runtime)
 * is never decisive, so it compares as SAME boot — the caller then relies on
 * PID liveness alone rather than stealing a possibly-live lock.
 */
function sameBoot(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === BOOT_ID_UNKNOWN || b === BOOT_ID_UNKNOWN) return true;
  const sa = a.startsWith("time:") ? Number.parseInt(a.slice(a.lastIndexOf(":") + 1), 10) : null;
  const sb = b.startsWith("time:") ? Number.parseInt(b.slice(b.lastIndexOf(":") + 1), 10) : null;
  if (sa !== null && sb !== null && Number.isFinite(sa) && Number.isFinite(sb)) {
    return Math.abs(sa - sb) <= 60;
  }
  return false;
}

async function tryCreate(lockPath: string): Promise<boolean> {
  try {
    const fh = await open(lockPath, "wx", FILE_MODE);
    try {
      await fh.writeFile(`${process.pid}\n${Date.now()}\n${bootId()}\n`);
      await fh.sync();
    } finally {
      await fh.close();
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Acquire the exclusive lock for a dataDir. Throws WALLET_DIR_LOCKED when
 * another live process holds it.
 */
export async function acquireDirLock(dataDir: string): Promise<DirLock> {
  const lockPath = join(dataDir, ".lock");

  // Two passes: initial attempt, then one retry after breaking a stale lock.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await tryCreate(lockPath)) {
      return {
        path: lockPath,
        async release() {
          try {
            const content = await readFile(lockPath, "utf8");
            const ownerPid = Number.parseInt(content, 10);
            if (ownerPid === process.pid) {
              await unlink(lockPath);
            }
          } catch {
            // Already gone — nothing to release.
          }
        }
      };
    }

    // Lock exists. Stale (dead PID / unparseable / different boot) → break it
    // and retry once.
    let ownerPid: number | null;
    let ownerBootId: string | null = null;
    try {
      const content = await readFile(lockPath, "utf8");
      const lines = content.split("\n");
      const parsed = Number.parseInt(lines[0] ?? "", 10);
      ownerPid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      // Line 3 (boot id) is absent in pre-existing 2-line lock files — null then.
      ownerBootId = lines[2]?.trim() ? lines[2].trim() : null;
    } catch {
      ownerPid = null; // unreadable → treat as stale
    }

    // Held only when the PID is alive AND (the recorded boot matches OR no boot
    // id was recorded — stay conservative for legacy lock files). A live PID
    // recorded under a DIFFERENT boot is a reused PID from a prior boot: stale.
    const heldByLiveProcess =
      ownerPid !== null &&
      pidIsAlive(ownerPid) &&
      (ownerBootId === null || sameBoot(ownerBootId, bootId()));

    if (heldByLiveProcess) {
      throw new WalletError(
        "WALLET_DIR_LOCKED",
        `Data dir is locked by another process (pid ${ownerPid}). ` +
          "Two processes must not share a wallet dataDir — use distinct DEPIX_WALLET_DIR " +
          "values (distinct wallets) or a single shared process."
      );
    }

    try {
      await unlink(lockPath);
    } catch {
      // Someone else may have raced the cleanup; the retry below settles it.
    }
  }

  throw new WalletError(
    "WALLET_DIR_LOCKED",
    "Data dir lock could not be acquired (lost the race twice)"
  );
}
