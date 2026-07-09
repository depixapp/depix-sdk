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

import { open, mkdir, rename, stat, chmod } from "node:fs/promises";
import { dirname } from "node:path";

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

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
  const tmpPath = `${filePath}.tmp`;
  const fh = await open(tmpPath, "w", FILE_MODE);
  try {
    await fh.writeFile(data);
    if (durable) {
      await fh.sync();
    }
  } finally {
    await fh.close();
  }
  await rename(tmpPath, filePath);
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
