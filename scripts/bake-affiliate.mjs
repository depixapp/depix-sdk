// Bake SIDESHIFT_AFFILIATE_ID into the COMPILED dist after `tsc` (spec §5.4).
//
// The SDK builds with tsc, which has no `define` like esbuild — so the committed
// source (src/convert/sideshift-affiliate.ts) reads `process.env` (used in
// dev/test), and this post-build step overwrites the emitted JS with the literal
// so the PUBLISHED package performs NO runtime env read. Mirror of the frontend's
// esbuild `define` substitution.
//
// LENIENT by design: it bakes whatever the env has (empty string when unset), so a
// dev build still succeeds and simply produces an SDK whose requireAffiliateId()
// throws AFFILIATE_ID_MISSING at call time. The STRICT publish gate lives in
// scripts/check-affiliate-env.mjs (wired into `prepublishOnly`), so a release can
// never ship an empty value.

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve("dist/convert/sideshift-affiliate.js");
if (!existsSync(target)) {
  console.error(`[bake-affiliate] ${target} not found — run \`tsc\` first (npm run build does).`);
  process.exit(1);
}

const value = process.env.SIDESHIFT_AFFILIATE_ID ?? "";
writeFileSync(target, `export const SIDESHIFT_AFFILIATE_ID = ${JSON.stringify(value)};\n`);
console.log(
  `[bake-affiliate] baked SIDESHIFT_AFFILIATE_ID (${value ? "set" : "EMPTY — dev build"}) into ${target}`
);
