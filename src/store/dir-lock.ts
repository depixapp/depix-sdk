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

import { open, readFile, unlink } from "node:fs/promises";
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

async function tryCreate(lockPath: string): Promise<boolean> {
  try {
    const fh = await open(lockPath, "wx", FILE_MODE);
    try {
      await fh.writeFile(`${process.pid}\n${Date.now()}\n`);
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

    // Lock exists. Stale (dead PID / unparseable) → break it and retry once.
    let ownerPid: number | null = null;
    try {
      const content = await readFile(lockPath, "utf8");
      const parsed = Number.parseInt(content, 10);
      ownerPid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } catch {
      ownerPid = null; // unreadable → treat as stale
    }

    if (ownerPid !== null && pidIsAlive(ownerPid)) {
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
