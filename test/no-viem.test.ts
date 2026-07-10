// viem-free invariant guard (§ PR5 note / .npmrc:2 finding). The `boltz-swaps`
// main barrel transitively pulls in `viem` (an EVM/PR5b concern); this SDK stays
// on the EVM-free subpaths and `legacy-peer-deps=true` merely SUPPRESSES the peer
// so it is never installed. That invariant is otherwise incidental — a future
// install without the flag, or an accidental import of a viem-touching subpath,
// would (re)introduce it. This test makes the invariant EXPLICIT and fails loudly
// if `viem` ever lands in node_modules or the lockfile's installed tree.
//
// NOTE: a `viem` entry inside boltz-swaps' peerDependencies is expected and fine
// — we only guard against viem being INSTALLED (a `node_modules/viem` package).
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rootUrl = new URL("../", import.meta.url); // package root (test/ is one level down)

describe("viem-free invariant (no EVM stack installed)", () => {
  it("has no node_modules/viem directory", () => {
    expect(existsSync(new URL("node_modules/viem/", rootUrl))).toBe(false);
  });

  it("has no installed viem package in the lockfile tree", () => {
    const lock = JSON.parse(readFileSync(new URL("package-lock.json", rootUrl), "utf8")) as {
      packages?: Record<string, unknown>;
    };
    const installedViem = Object.keys(lock.packages ?? {}).filter(
      (p) => p === "node_modules/viem" || p.endsWith("/node_modules/viem")
    );
    // An empty list proves viem is not installed anywhere in the tree. A peer
    // DECLARATION (boltz-swaps.peerDependencies.viem) does not create such a key.
    expect(installedViem).toEqual([]);
  });
});
