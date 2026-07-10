// Publish gate: FAIL when SIDESHIFT_AFFILIATE_ID is not set (spec §5.4).
//
// Wired into `prepublishOnly`, so `npm publish` (the PR9 release) can never ship a
// package whose SideShift affiliate id is empty — the mirror of the frontend
// build.mjs FATAL. The publisher MUST set SIDESHIFT_AFFILIATE_ID in the publish
// environment (README "Publishing"). Dev builds/tests do NOT run this gate.

if (!process.env.SIDESHIFT_AFFILIATE_ID) {
  console.error(
    "\nFATAL: SIDESHIFT_AFFILIATE_ID is not set.\n" +
      "The SideShift affiliate id is baked into the published package at build time.\n" +
      "Set it in the publish environment before `npm publish`:\n" +
      "    SIDESHIFT_AFFILIATE_ID=<depix-affiliate-id> npm publish\n"
  );
  process.exit(1);
}
console.log("[check-affiliate-env] SIDESHIFT_AFFILIATE_ID is set — ok to publish.");
