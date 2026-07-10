// viem-as-a-regular-dependency invariant (G5 — Boltz stablecoin EVM is IN the F3
// MVP). This INVERTS the pre-PR5b `no-viem` invariant: viem is now a REGULAR
// dependency, pinned exactly, and installed. What still must hold:
//   1. viem is a top-level `dependencies` entry pinned EXACTLY at 2.54.1 (no
//      caret/tilde; NOT under optionalDependencies/devDependencies — G5/§2.2).
//   2. viem is actually installed in node_modules + the lockfile tree.
//   3. The Lightning-send path (client/submarine/reverse/refund) NEVER statically
//      imports viem — it stays out of the LN chunk; only the stablecoin path uses
//      viem, and it imports it DYNAMICALLY (frontend parity, GT §7.1), which also
//      backs the STABLECOIN_DEPS_MISSING defense.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rootUrl = new URL("../", import.meta.url); // package root (test/ is one level down)
const read = (rel: string): string => readFileSync(new URL(rel, rootUrl), "utf8");

describe("viem is a regular, exactly-pinned dependency (G5)", () => {
  const pkg = JSON.parse(read("package.json")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it("declares viem under dependencies pinned exactly at 2.54.1", () => {
    expect(pkg.dependencies?.viem).toBe("2.54.1");
  });

  it("does NOT declare viem as optional or dev (it is a hard runtime dep now)", () => {
    expect(pkg.optionalDependencies?.viem).toBeUndefined();
    expect(pkg.devDependencies?.viem).toBeUndefined();
  });

  it("is installed in node_modules and pinned in the lockfile", () => {
    expect(existsSync(new URL("node_modules/viem/", rootUrl))).toBe(true);
    const lock = JSON.parse(read("package-lock.json")) as {
      packages?: Record<string, { version?: string }>;
    };
    expect(lock.packages?.["node_modules/viem"]?.version).toBe("2.54.1");
  });
});

describe("viem never enters the Lightning-send chunk (stays dynamic-only, §5.3)", () => {
  // A static `import ... from "viem"` in the LN modules would pull the 24 MB EVM
  // graph into the Lightning path. viem may ONLY be dynamically imported, and only
  // from the stablecoin module.
  const STATIC_VIEM = /import\s+[^;]*from\s+["']viem/;

  for (const mod of [
    "src/convert/boltz/client.ts",
    "src/convert/boltz/submarine.ts",
    "src/convert/boltz/reverse.ts",
    "src/convert/boltz/refund.ts",
    "src/convert/boltz/keys.ts"
  ]) {
    it(`${mod} has no static viem import`, () => {
      expect(STATIC_VIEM.test(read(mod))).toBe(false);
    });
  }

  it("stablecoin.ts imports viem DYNAMICALLY only (no top-level static import)", () => {
    const src = read("src/convert/boltz/stablecoin.ts");
    expect(STATIC_VIEM.test(src)).toBe(false); // no `import ... from "viem"`
    expect(src.includes('import("viem")')).toBe(true); // dynamic import present
    expect(src.includes('import("viem/accounts")')).toBe(true);
  });
});
