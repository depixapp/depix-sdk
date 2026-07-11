// Version identity for wallet.diagnostics() (PR-D). Read once from this
// package's own manifest — the file sits one level above both src/ (vitest)
// and dist/ (published build), so the same relative lookup works in both.
// The lwk version is the EXACT dependency pin (deps are pinned exact in this
// repo), read from the manifest rather than lwk_node's package.json because
// lwk_node's `exports` map does not expose its manifest as a subpath.

import { createRequire } from "node:module";

interface PackageManifest {
  version?: unknown;
  dependencies?: Record<string, unknown>;
}

function readManifest(): PackageManifest {
  try {
    return createRequire(import.meta.url)("../package.json") as PackageManifest;
  } catch {
    // Diagnostics must never crash the wallet over a packaging anomaly.
    return {};
  }
}

const manifest = readManifest();

/** This SDK's own version (package.json `version`), or "unknown". */
export const SDK_VERSION: string =
  typeof manifest.version === "string" ? manifest.version : "unknown";

/** The exact pinned lwk_node version this build ships, or "unknown". */
export const LWK_VERSION: string =
  typeof manifest.dependencies?.lwk_node === "string"
    ? manifest.dependencies.lwk_node
    : "unknown";
