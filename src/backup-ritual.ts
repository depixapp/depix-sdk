// Interactive backup ritual (spec §2.9 — TTY mode of create()).
//
// Parity with the app's onboarding: print the 12 words, require re-typing 2-3
// of them at random positions (proof of possession), then an explicit "saved"
// declaration (the app's checkbox equivalent). Only a fully passed ritual
// confirms the backup; any failure leaves the gate closed.
//
// I/O is injected so the ritual is unit-testable; create() wires it to
// readline on a real TTY. The words go to the interactive terminal — never
// through the logger (which would try to redact them anyway).

export interface RitualIo {
  write(text: string): void;
  question(prompt: string): Promise<string>;
}

export interface RitualOptions {
  /** Uniform [0,1) source — injectable for deterministic tests. */
  random?: () => number;
  /** Full challenge rounds before giving up. Default 3. */
  maxAttempts?: number;
  /** Number of word positions challenged. Default 3. */
  challengeCount?: number;
}

function normalizeAnswer(raw: string): string {
  return raw.trim().toLowerCase();
}

function pickPositions(total: number, count: number, random: () => number): number[] {
  const available = Array.from({ length: total }, (_, i) => i);
  const picked: number[] = [];
  while (picked.length < count && available.length > 0) {
    const idx = Math.min(Math.floor(random() * available.length), available.length - 1);
    picked.push(available.splice(idx, 1)[0]!);
  }
  return picked.sort((a, b) => a - b);
}

/**
 * Run the full ritual. Returns true only when the user re-typed the
 * challenged words and typed the "saved" declaration.
 */
export async function runBackupRitual(
  mnemonic: string,
  io: RitualIo,
  options: RitualOptions = {}
): Promise<boolean> {
  const random = options.random ?? Math.random;
  const maxAttempts = options.maxAttempts ?? 3;
  const challengeCount = options.challengeCount ?? 3;
  const words = mnemonic.trim().split(/\s+/);

  io.write("");
  io.write("=== WALLET BACKUP — WRITE THESE 12 WORDS DOWN, IN ORDER ===");
  io.write("Anyone with these words controls the funds. Store them offline.");
  io.write("");
  for (const [idx, word] of words.entries()) {
    io.write(`  ${idx + 1}. ${word}`);
  }
  io.write("");

  let challengePassed = false;
  for (let attempt = 0; attempt < maxAttempts && !challengePassed; attempt++) {
    const positions = pickPositions(words.length, challengeCount, random);
    io.write("Prove you saved them — type the requested words.");
    challengePassed = true;
    for (const pos of positions) {
      const answer = await io.question(`Word #${pos + 1}: `);
      if (normalizeAnswer(answer) !== words[pos]) {
        io.write("That word does not match. Check your backup and try again.");
        challengePassed = false;
        break;
      }
    }
  }
  if (!challengePassed) {
    io.write("Backup NOT confirmed. Receive addresses stay blocked until you run confirmBackup().");
    return false;
  }

  const declaration = await io.question(
    'Type "saved" to declare you stored the words safely: '
  );
  if (normalizeAnswer(declaration) !== "saved") {
    io.write("Backup NOT confirmed. Receive addresses stay blocked until you run confirmBackup().");
    return false;
  }

  io.write("Backup confirmed.");
  return true;
}
