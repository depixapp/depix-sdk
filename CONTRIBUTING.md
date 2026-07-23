# Contributing — maintainer notes

This file is repo-only; it is **not** shipped in the npm tarball.

## npm org

The package publishes under the **`@depixapp`** npm org. Before the first publish,
the org must exist on npm (create it at <https://www.npmjs.com/org/create> — free
for public packages) and the publisher must be a member with publish rights. The
first publish of the scope needs `--access public` (a scoped package is private by
default).

## Releasing / Publishing

Publishing is **automated in CI** via **npm Trusted Publishing (OIDC)** — no npm
token, no interactive 2FA, and every release carries build provenance.
`.github/workflows/release.yml` (on a `v*` tag) publishes `@depixapp/sdk` to npm.
(`.github/workflows/ci.yml` is the separate correctness gate: typecheck + lint +
the offline suite + build + smoke on every push and PR.)

To cut a release:

1. Bump `version` in **`package.json`**, commit to `main`.
2. Tag and push — CI does the rest:
   ```bash
   git tag v1.2.1 && git push origin v1.2.1
   ```

The workflow checks the tag matches `package.json`, then `npm publish` runs
`prepublishOnly` (below) and publishes with provenance. Re-tagging an
already-published version is a safe no-op (the job skips it).

**`SIDESHIFT_AFFILIATE_ID`** (the DePix affiliate id — public, but never committed
to this repo) is baked into the build at publish time (spec §5.4), mirroring the
frontend's build-time substitution. It is never read at runtime and never served
by the backend. In CI it comes from the **`SIDESHIFT_AFFILIATE_ID` repo secret**;
`prepublishOnly` runs `scripts/check-affiliate-env.mjs` → `npm run build` → the
offline test suite (`DEPIX_SDK_OFFLINE=1 npm run test`), and the guard **fails the
publish loudly** if it is unset — so a release can never ship without it. The build
bakes the value into `dist/convert/sideshift-affiliate.js`; the published package
performs **no runtime env read**. A dev build without the env var still succeeds
but bakes an empty id, so SideShift calls throw `AFFILIATE_ID_MISSING` until a real
build is published.

Tests and CI use `SIDESHIFT_AFFILIATE_ID=test-affiliate` (wired in `package.json`).
Validate the tarball locally without publishing anything:

```bash
SIDESHIFT_AFFILIATE_ID=test-affiliate npm publish --dry-run --access public
```

**One-time setup** (already done): the package is registered as an npm **Trusted
Publisher** for this repo with workflow filename `release.yml` (npmjs.com →
package → Settings → Trusted Publisher), and the `SIDESHIFT_AFFILIATE_ID` repo
secret is set. **Manual fallback** (only if you must publish outside CI — needs an
npm login with publish rights):

```bash
SIDESHIFT_AFFILIATE_ID=<depix-affiliate-id> npm publish --access public
```

The published package contains `dist/` (compiled JS + types), `README.md`,
`AGENTS.md`, `llms.txt` and `LICENSE`, and exposes the `depix-wallet-mcp` bin.
