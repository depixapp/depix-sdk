// Flat ESLint config. The one non-negotiable rule: no `console.*` anywhere in
// src/ (spec §6.1 discipline) — in MCP stdio mode STDOUT is the JSON-RPC
// channel, so every log line must go through the redacting stderr logger
// (src/logger.ts), never through console.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // dist/coverage are build artifacts. scripts/ is intentionally NOT ignored:
    // it holds release-critical Node ESM helpers (publish guard, affiliate bake,
    // smoke, openapi-diff) that must stay linted — a regression in the guard that
    // ships an empty affiliate id would otherwise go uncaught. They get a
    // Node-globals override below (they run directly under `node`, not in dist/).
    ignores: ["dist/", "node_modules/", "coverage/"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "src/**/*.js"],
    rules: {
      // No console in the package source — stdout belongs to MCP JSON-RPC,
      // and ad-hoc logging bypasses secret redaction. Use src/logger.ts.
      "no-console": "error"
    }
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off"
    }
  },
  {
    // Build tooling — plain Node ESM scripts (not shipped in dist). They run under
    // Node, so Node globals (process/console/fetch/AbortSignal…) are legitimate
    // here (unlike src/, where console is banned for the stdio JSON-RPC
    // discipline). Declared explicitly because the `globals` package is not a
    // direct dependency of this project.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortSignal: "readonly",
        AbortController: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        queueMicrotask: "readonly",
        structuredClone: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly"
      }
    }
  }
);
