// Interactive backup ritual (spec §2.9 — TTY mode of create()).
import { describe, expect, it } from "vitest";
import { runBackupRitual, type RitualIo } from "../src/backup-ritual.js";

const MNEMONIC =
  "abandon ability able about above absent absorb abstract absurd abuse access accident";
const WORDS = MNEMONIC.split(" ");

function scriptedIo(answers: string[]): { io: RitualIo; output: string[] } {
  const output: string[] = [];
  let i = 0;
  return {
    io: {
      write: (text) => {
        output.push(text);
      },
      question: async (prompt) => {
        output.push(prompt);
        return answers[i++] ?? "";
      }
    },
    output
  };
}

// Deterministic "random": always picks the lowest available positions.
const firstPositions = () => 0;

describe("runBackupRitual", () => {
  it("passes when the challenged words and the declaration are correct", async () => {
    // Positions 1..3 (deterministic picker) then the declaration.
    const { io, output } = scriptedIo([WORDS[0]!, WORDS[1]!, WORDS[2]!, "saved"]);
    const ok = await runBackupRitual(MNEMONIC, io, { random: firstPositions });
    expect(ok).toBe(true);
    const printed = output.join("\n");
    // All 12 words were shown, numbered.
    for (const [idx, word] of WORDS.entries()) {
      expect(printed).toContain(`${idx + 1}. ${word}`);
    }
  });

  it("fails when a challenged word is wrong (after retries)", async () => {
    const wrongRound = [WORDS[0]!, "wrongword", WORDS[2]!];
    const { io } = scriptedIo([...wrongRound, ...wrongRound, ...wrongRound]);
    const ok = await runBackupRitual(MNEMONIC, io, { random: firstPositions, maxAttempts: 3 });
    expect(ok).toBe(false);
  });

  it("fails when the declaration is refused", async () => {
    const { io } = scriptedIo([WORDS[0]!, WORDS[1]!, WORDS[2]!, "no"]);
    const ok = await runBackupRitual(MNEMONIC, io, { random: firstPositions });
    expect(ok).toBe(false);
  });

  it("accepts word answers case/whitespace-insensitively", async () => {
    const { io } = scriptedIo([` ${WORDS[0]!.toUpperCase()} `, WORDS[1]!, WORDS[2]!, " SAVED "]);
    const ok = await runBackupRitual(MNEMONIC, io, { random: firstPositions });
    expect(ok).toBe(true);
  });
});
