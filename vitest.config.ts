import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Argon2id (19 MiB, deliberate) and the live Esplora integration test need
    // headroom beyond the 5 s default.
    testTimeout: 120_000,
    hookTimeout: 60_000
  }
});
