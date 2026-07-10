#!/usr/bin/env node
// OpenAPI drift detector (spec §8.2) — NON-BLOCKING in CI.
//
// The SDK's contract tests are pinned to a vendored snapshot of the live
// OpenAPI (test/fixtures/openapi.json). This script fetches the live document
// and diffs it against that snapshot so the team is told LOUDLY when the API
// moved under us — without failing the release build (the CI job runs with
// continue-on-error). Run locally with `npm run openapi:diff`.
//
// Exit codes:
//   0  — no drift, OR the live endpoint was unreachable (not our failure).
//   1  — drift detected (version, paths, methods, or schema body changed).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../test/fixtures/openapi.json");
const LIVE_URL = process.env.DEPIX_OPENAPI_URL ?? "https://api.depixapp.com/openapi.json";

function out(msg) {
  process.stdout.write(`${msg}\n`);
}

function methodsOf(pathItem) {
  const VERBS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];
  return VERBS.filter((v) => pathItem && typeof pathItem[v] === "object").sort();
}

/** Depth-first list of JSON-pointer paths where two values differ (capped). */
function diffPointers(a, b, base = "", acc = [], cap = 40) {
  if (acc.length >= cap) return acc;
  if (a === b) return acc;
  const ta = a === null ? "null" : Array.isArray(a) ? "array" : typeof a;
  const tb = b === null ? "null" : Array.isArray(b) ? "array" : typeof b;
  if (ta !== tb) {
    acc.push(base || "/");
    return acc;
  }
  if (ta === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      if (acc.length >= cap) break;
      const pointer = `${base}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (!(k in a) || !(k in b)) acc.push(pointer);
      else diffPointers(a[k], b[k], pointer, acc, cap);
    }
    return acc;
  }
  if (ta === "array") {
    if (a.length !== b.length) acc.push(`${base} (length ${a.length} → ${b.length})`);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (acc.length >= cap) break;
      diffPointers(a[i], b[i], `${base}/${i}`, acc, cap);
    }
    return acc;
  }
  acc.push(base || "/");
  return acc;
}

async function main() {
  const fixture = JSON.parse(await readFile(FIXTURE, "utf8"));

  let live;
  try {
    const res = await fetch(LIVE_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      out(`⚠ openapi-diff: live endpoint returned HTTP ${res.status} — skipping (not treated as drift).`);
      return 0;
    }
    live = await res.json();
  } catch (err) {
    out(`⚠ openapi-diff: could not reach ${LIVE_URL} (${err?.message ?? err}) — skipping (not treated as drift).`);
    return 0;
  }

  const problems = [];

  const fVer = fixture?.info?.version;
  const lVer = live?.info?.version;
  if (fVer !== lVer) problems.push(`info.version: fixture ${fVer} → live ${lVer}`);

  const fPaths = Object.keys(fixture.paths ?? {}).sort();
  const lPaths = Object.keys(live.paths ?? {}).sort();
  const added = lPaths.filter((p) => !fPaths.includes(p));
  const removed = fPaths.filter((p) => !lPaths.includes(p));
  if (added.length) problems.push(`paths ADDED live: ${added.join(", ")}`);
  if (removed.length) problems.push(`paths REMOVED from live: ${removed.join(", ")}`);

  for (const p of fPaths.filter((p) => lPaths.includes(p))) {
    const fm = methodsOf(fixture.paths[p]).join(",");
    const lm = methodsOf(live.paths[p]).join(",");
    if (fm !== lm) problems.push(`methods for ${p}: fixture [${fm}] → live [${lm}]`);
  }

  const pointers = diffPointers(fixture, live);

  if (problems.length === 0 && pointers.length === 0) {
    out(`✓ openapi-diff: no drift (info.version ${fVer}, ${fPaths.length} paths).`);
    return 0;
  }

  out("✗ openapi-diff: DRIFT DETECTED between the vendored fixture and the live API.");
  for (const p of problems) out(`  - ${p}`);
  if (pointers.length) {
    out(`  - ${pointers.length} differing JSON pointer(s) (first ${Math.min(pointers.length, 40)}):`);
    for (const ptr of pointers.slice(0, 40)) out(`      ${ptr}`);
  }
  out("");
  out("  Re-vendor the snapshot when this is an intended API change:");
  out(`    curl -s ${LIVE_URL} | node -e 'process.stdout.write(JSON.stringify(JSON.parse(require(\"fs\").readFileSync(0,\"utf8\")),null,2)+\"\\n\")' > test/fixtures/openapi.json`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`openapi-diff: unexpected error — ${err?.stack ?? err}\n`);
    process.exit(1);
  });
