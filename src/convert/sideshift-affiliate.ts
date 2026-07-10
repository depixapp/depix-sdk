// SideShift affiliate id — BAKED AT BUILD TIME (spec §5.4, GT §4.C).
//
// This mirrors the frontend's build-time `define` (wallet/sideshift.js:37 +
// scripts/build.mjs): the affiliate id is the DePix affiliate id (PUBLIC — it
// appears in every SideShift request and the frontend hardcodes it too — but NOT
// committed to git; it lives in the publish environment). The committed source
// below reads `process.env.SIDESHIFT_AFFILIATE_ID`, which is what dev + tests use
// (`SIDESHIFT_AFFILIATE_ID=test-affiliate`, wired in package.json). The PUBLISHED
// package does NOT read the env at runtime: `scripts/bake-affiliate.mjs` runs
// after `tsc` and overwrites the COMPILED `dist/convert/sideshift-affiliate.js`
// with the literal, exactly like esbuild's `define` substitutes it in the browser
// bundle. `scripts/check-affiliate-env.mjs` (wired into `prepublishOnly`) FAILS
// `npm publish` when the env is unset, so a release can never ship without it
// (mirror of build.mjs's FATAL). See the README "Publishing" section.
//
// Isolated in its own tiny module so the bake step can replace the whole file
// deterministically rather than surgically editing a line of compiled output.
export const SIDESHIFT_AFFILIATE_ID: string = process.env.SIDESHIFT_AFFILIATE_ID ?? "";
