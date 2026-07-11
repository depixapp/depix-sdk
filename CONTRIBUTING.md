# Contributing — maintainer notes

This file is repo-only; it is **not** shipped in the npm tarball.

## npm org

The package publishes under the **`@depixapp`** npm org. Before the first publish,
the org must exist on npm (create it at <https://www.npmjs.com/org/create> — free
for public packages) and the publisher must be a member with publish rights. The
first publish of the scope needs `--access public` (a scoped package is private by
default).

## Publishing

The package is published **by a human** — the npm account uses passkey 2FA, so the
publish is interactive. The **`SIDESHIFT_AFFILIATE_ID`** value (the DePix affiliate
id — public, but never committed to this repo) is supplied by the **publisher's
environment** and baked into the build at publish time (spec §5.4), mirroring the
frontend's build-time substitution. It is never read at runtime and never served by
the backend.

`prepublishOnly` runs `scripts/check-affiliate-env.mjs` → `npm run build` → the
offline test suite (`DEPIX_SDK_OFFLINE=1 npm run test`). The guard **fails the
publish loudly** if `SIDESHIFT_AFFILIATE_ID` is unset, so a release can never ship
without it; the build then bakes the value into
`dist/convert/sideshift-affiliate.js`, and the published package performs **no
runtime env read**. A dev build without the env var still succeeds but bakes an
empty id, so SideShift calls throw `AFFILIATE_ID_MISSING` until a real build is
published.

```bash
SIDESHIFT_AFFILIATE_ID=<depix-affiliate-id> npm publish --access public
```

Tests and CI use `SIDESHIFT_AFFILIATE_ID=test-affiliate` (wired in `package.json`).
Validate the tarball without publishing anything:

```bash
SIDESHIFT_AFFILIATE_ID=test-affiliate npm publish --dry-run --access public
```

The published package contains `dist/` (compiled JS + types), `README.md`,
`AGENTS.md`, `llms.txt` and `LICENSE`, and exposes the `depix-wallet-mcp` bin.
