// Filesystem primitives for the data directory (spec §2.4).
//
// Two write recipes:
//   - writeFileDurable: open(tmp) → write → fsync(file) → close → rename →
//     fsync(dataDir dirfd). Normative for files whose loss costs funds or
//     duplicates them: wallet.json, pending-withdrawals.json,
//     guardrails-state.json. rename() alone guarantees metadata atomicity,
//     NOT content durability — power-loss with delayed allocation classically
//     leaves a zero-length file.
//   - writeFileAtomic: tmp + rename only. For updates/*.bin (recoverable by
//     re-scan; tolerant reads cover corruption — §2.5).

import { randomBytes } from "node:crypto";
import { open, mkdir, rename, stat, chmod, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

// Monotonic per-process counter for temp-file names. Combined with pid + random
// it makes every temp path unique so concurrent writers to the SAME target
// (e.g. SeedStore.patch() read-modify-writes of wallet.json) never open/truncate
// a shared `.tmp` and rename a half-written file into place (§2.4 corruption).
let tmpSeq = 0;

function uniqueTmpPath(filePath: string): string {
  const suffix = `${process.pid}.${(tmpSeq++).toString(36)}.${randomBytes(6).toString("hex")}`;
  return `${filePath}.${suffix}.tmp`;
}

/** Create (or tighten) a directory with 0700 permissions. */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true, mode: DIR_MODE });
  // mkdir does not change the mode of a pre-existing directory — tighten it.
  const info = await stat(dirPath);
  if ((info.mode & 0o777) !== DIR_MODE) {
    await chmod(dirPath, DIR_MODE);
  }
}

async function writeTmpAndRename(
  filePath: string,
  data: string | Uint8Array,
  { durable }: { durable: boolean }
): Promise<void> {
  // Unique temp name per write (+ O_EXCL via "wx") so two in-flight writers to
  // the same target cannot clobber each other's temp file.
  const tmpPath = uniqueTmpPath(filePath);
  try {
    const fh = await open(tmpPath, "wx", FILE_MODE);
    try {
      await fh.writeFile(data);
      if (durable) {
        await fh.sync();
      }
    } finally {
      await fh.close();
    }
    await rename(tmpPath, filePath);
  } catch (err) {
    // Never leave an orphan temp behind on a failed write (unique names would
    // otherwise accumulate). Best effort — the temp may already be gone.
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
  if (durable) {
    // fsync the containing directory so the rename itself survives power loss.
    const dirHandle = await open(dirname(filePath), "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  }
}

/** Atomic AND durable write (fsync file + parent dir). Files: wallet.json & co. */
export async function writeFileDurable(filePath: string, data: string | Uint8Array): Promise<void> {
  await writeTmpAndRename(filePath, data, { durable: true });
}

/** Atomic (tmp+rename) write without fsync. Files: updates/*.bin, meta.json. */
export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  await writeTmpAndRename(filePath, data, { durable: false });
}
