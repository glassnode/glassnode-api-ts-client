# Claude Instructions

This document provides context for Claude when working with this project.

## Project Structure

- `/src` - Source code
  - `/src/index.ts` - main entry (`glassnode-api`): client, errors, types
  - `/src/x402.ts` - separate subpath entry (`glassnode-api/x402`): `createX402Fetch` and helpers
  - `/src/types` - TypeScript type definitions (Zod schemas + inferred types)
- `/test` - Test files (Vitest)
  - `/test/contract.spec.ts` - contract tests: each real API response in `/test/fixtures/contract`
    (recorded by `scripts/record-fixtures.mjs`, listed in its `manifest.json`) goes through the
    client and its schemas. Never hand-edit the fixtures; re-record them. A schema failure there is
    real API drift: fix the schema, never the fixture or the test
- `/examples` - Example usage patterns (own `package.json`; type-checked via `tsconfig.examples.json`)
- `/scripts` - `smoke-timeout.mjs`, the plain-Node runtime smoke run on Node 18 in CI;
  `record-fixtures.mjs`, which records the contract fixtures (needs an API key; run only to refresh)
- `/typecheck/x402-node16` - consumer type-check fixture (node16 resolution, `skipLibCheck: false`)
- `/dist` - Compiled output (not checked into git)
- `/api-docs` - Generated TypeDoc API reference (`pnpm run docs`; not checked into git, never
  published to npm)
- `CONTRIBUTING.md` - contributor guide (the PR flow, local check list, version/changelog rules,
  security reporting); keep it in sync with this file
- `LICENSE` (Apache-2.0) and `NOTICE` (attribution; listed in `package.json` `files` so it ships in
  the npm tarball, as Apache-2.0 §4(d) requires)

## Development Workflow

- Use pnpm as package manager
- Run tests with `pnpm test` (Vitest, single run); `pnpm run test:watch` and `pnpm run test:coverage` are also available
- Lint code with `pnpm run lint`
- Format code with `pnpm run format` (check only: `npx prettier --check .`)
- Build the project with `pnpm run build`
- Build browser bundles with `pnpm run build:browser`
- Build the API reference with `pnpm run docs` (TypeDoc; config in `typedoc.json`, output in
  `api-docs/`). It fails on any warning (`treatWarningsAsErrors`): a broken `{@link}`, a doc
  comment referencing a type the entry points do not export, or a bad README path. See
  [API reference (TypeDoc)](#api-reference-typedoc)
- Type-check tests with `pnpm exec tsc -p tsconfig.test.json --noEmit` (Vitest does not type-check)
  and examples with `pnpm exec tsc -p tsconfig.examples.json`
- The Husky pre-commit hook runs `pnpm test`, `lint-staged` (ESLint + Prettier + related tests on
  staged files) and `pnpm run build`

### Node.js versions — two distinct baselines

Keep these separate; they answer different questions:

- **Consumers of the published package** need **Node.js >= 18**. This is the contract in
  `package.json` `engines`. The shipped code uses only universal APIs plus global `fetch`
  (stable since Node 18) — no `node:` builtins. To enforce this at compile time, `@types/node`
  is pinned to the **floor** (`^18`), not the latest, so the compiler rejects any API newer
  than Node 18. Do **not** bump `@types/node` to track the dev runtime — bump it only if the
  minimum supported Node is intentionally raised (a breaking change → major/`engines` bump).
- **Developers of this repo** run **Node.js 24** (`.nvmrc`, the main CI and publish jobs). The dev toolchain
  sets the floor here: `vitest` 5 requires Node `>= 22.12`, so the test suite cannot run on
  Node 18/20 — that constraint is dev-only and never reaches consumers (vitest is a
  devDependency). The CI `compat-node18` job proves the consumer floor instead: on Node 18 it
  builds, `require`s the CJS entry and runs `scripts/smoke-timeout.mjs`.

## Coding Standards

- TypeScript for all source files
- Vitest for testing (config in `vitest.config.ts`; coverage thresholds live there)
- ESLint and Prettier for code quality
- Husky for git hooks
- Zod for runtime validation of API responses and config

### TypeScript version

- Pinned to TypeScript **6.x** (`^6.0.3`), **not** 7.x. `typescript-eslint` still declares its
  `typescript` peer as `>=4.8.4 <6.1.0` (verified on the current latest, `8.70.0` — its canary
  is also 8.x), so TypeScript 7.0 breaks `pnpm run lint` in CI and the Husky pre-commit hook.
  `6.0.3` is already the newest stable 6.x, so TypeScript needs no bump. Only move to 7.x once
  `typescript-eslint` ships a release whose peer range accepts it.
- `typedoc` (`^0.28.20`) also gates the TypeScript version: its `typescript` peer is an explicit
  list of minors (`5.0.x || … || 5.9.x || 6.0.x` on 0.28.20, the current latest), so any
  TypeScript bump — even to 6.1 — needs a `typedoc` release that lists it, or `pnpm run docs`
  (and CI) break.

### API reference (TypeDoc)

- Entry points `src/index.ts` (module `glassnode-api`) and `src/x402.ts` (`glassnode-api/x402`),
  named by their `@module` comments; README.md is the landing page.
- `typedoc-plugin-zod` expands `z.infer`/`z.input` aliases into their object types, so Zod-derived
  types (e.g. `MetricMetadata`, `GlassnodeConfig`) render readably, with their field comments,
  instead of as `z.infer<typeof …>`.
- Validation: `notExported`, `invalidLink`, `invalidPath` and `rewrittenLink` are on, and every
  warning is an error. `notDocumented` is **off**: with it on, the only reports are nested members
  of Zod objects and `z.enum` literals (e.g. `p50`, `ccdata`, `tier1`), and `z.enum` literals
  cannot carry comments at all. Every top-level export and class member is documented — keep it so.

## API Client

The main class is `GlassnodeAPI` which takes a configuration object (validated with Zod in the
constructor; an invalid config throws `GlassnodeConfigError`):

- `apiKey` (required unless `x402`) - Glassnode API key (non-empty string)
- `apiKeyLocation` (optional) - `'query'` (default, `api_key` query param) or `'header'` (`X-Api-Key`
  header, keeps the key out of URLs). `'header'` is server-side only: the API's CORS preflight does
  not allow `X-Api-Key`, so browsers block it. With `'header'`, a custom `fetch` gets
  `(url, { headers, redirect: 'manual' })` (+ `signal` when a timeout or per-call signal is set) so
  `X-Api-Key` is never resent to a redirect target (a 3xx surfaces as a non-retried
  `GlassnodeApiError`); with no key, no header is sent. The default `'query'` path keeps calling
  `fetch(url)` with one argument. `createX402Fetch` likewise forces `redirect: 'manual'` (keeps
  `'error'`) so a signed payment header is never sent cross-origin.
- `apiUrl` (optional) - Base URL, defaults to `https://api.glassnode.com`, or
  `https://x402.glassnode.com` when `x402` is set; an explicit value always wins
- `x402` (optional) - Route through the paid x402 endpoint (default `false`); requires `fetch` (an
  x402-capable one, from `createX402Fetch` in `glassnode-api/x402`)
- `logger` (optional) - Callback for debug logging (e.g. `console.log`)
- `hooks` (optional) - Structured observability callbacks `{ onRequest, onResponse, onRetry, onError }`
  (types in `src/types/hooks.ts`; strict, so an unknown hook name throws). Called synchronously,
  never awaited; a throwing/rejecting hook is swallowed (reported to `logger`). Payloads carry a
  per-call `callId`, the redacted URL and no headers — the API key must never reach a hook payload.
  Events are read-only by contract, but `event.error` is the live error the caller receives.
- `fetch` (optional) - Custom fetch function for testing or custom HTTP behavior (default
  `globalThis.fetch`)
- `maxRetries` (optional) - Number of retries for 429/5xx responses and transport failures (network
  errors, per-attempt timeouts); non-negative integer, default 0
- `retryDelay` (optional) - Base delay in ms between retries (default 1000, doubles each attempt,
  capped at `maxRetryDelay`, then full jitter; a `Retry-After` on a retried response is used
  instead, capped but not jittered)
- `maxRetryDelay` (optional) - Upper bound in ms for a single retry wait (default 30000)
- `timeout` (optional) - Per-attempt timeout in ms; each attempt aborts via `AbortSignal.timeout()`
  (default none)

`timeout`, `retryDelay` and `maxRetryDelay` must be positive integers up to 2147483647 ms (2^31 − 1,
the largest timer delay). Every method also takes optional per-call options as its last argument,
`{ signal?, timeout? }` (`callMetric` also accepts a Zod `schema`). The public API is what
`src/index.ts` and `src/x402.ts` export; README.md documents it for users and must stay in sync.

## Versioning

Follow [semver](https://semver.org/):

- **Major** (1.0.0 → 2.0.0): Breaking changes (removed/renamed exports, changed method signatures)
- **Minor** (0.4.0 → 0.5.0): New features, new methods, new config options (backward-compatible)
- **Patch** (0.5.0 → 0.5.1): Bug fixes, docs, internal refactors (no API changes)

**Before every commit**, you MUST:

1. Bump `version` in `package.json` (patch, minor, or major as appropriate)
2. Add a corresponding entry to `CHANGELOG.md` describing the changes

Exception: PRs into `release/**` branches carry no version bump (they still add a CHANGELOG entry);
see [Release branches](#release-branches).

The `version` in `package.json` is exactly what gets published: CI never bumps it. A change
merged without a bump publishes nothing (see [Publishing](#publishing)).

## Build Targets

- **Node.js (CJS)**: `tsc` → `dist/` (CommonJS; the `require` entry). Relative imports in `src/`
  carry explicit `.js` extensions so the same source also emits valid ESM.
- **Node.js (ESM)**: `tsc -p tsconfig.esm.json` → `dist/esm/` (unbundled ES modules with `zod`
  externalized; the `import` entry). A generated `dist/esm/package.json` (`{"type":"module"}`) marks
  the folder as ESM. `exports` uses per-condition `types` (ESM `.d.ts` for `import`, CJS for
  `require`) — verified with `publint` + `@arethetypeswrong/cli` in CI.
- **Browser**: Rollup (`tsconfig.browser.json`) produces minified UMD
  (`dist/glassnode-api.umd.min.js`, global `GlassnodeAPI`) and minified ESM
  (`dist/glassnode-api.esm.min.js`) bundles from `src/index.ts`, with `zod` bundled in and
  `src/x402.ts` excluded. The `module` field points at the unbundled `dist/esm/index.js`, not a
  Rollup bundle. Source maps are generated `hidden` and not published.
  `tsconfig.browser.json` uses `module: ESNext` + `moduleResolution: bundler` (not the deprecated
  `node`/`node10`, which TypeScript 7 drops); `@rollup/plugin-node-resolve` does the actual
  resolution, so the setting only affects type-checking.
- **CDN entry**: the `unpkg` and `jsdelivr` fields point at the UMD bundle, so the bare package URL
  on those CDNs serves it. There is deliberately **no** top-level `browser` field and **no**
  `browser` condition in `exports`: either would steer bundlers (webpack, Vite, esbuild with
  `platform: 'browser'`) to the pre-minified bundle with `zod` inlined instead of the tree-shakeable
  ESM build. Keep it that way even though `publint` used to suggest the `browser` condition (#37).
- Config: `tsconfig.json` (CJS), `tsconfig.esm.json` (ESM), `tsconfig.browser.json` (browser),
  `tsconfig.test.json` (tests/IDE), `tsconfig.examples.json` (type-checks `examples/` against
  `src/` using root deps), `examples/tsconfig.json` (ts-node config for running the examples;
  extends `tsconfig.examples.json`), `typecheck/x402-node16/tsconfig.json` (consumer fixture). The
  package sets `"type": "commonjs"`.

### Why `src/` imports use `.js` specifiers

Relative imports in `src/` are written `./foo.js` even though the file is `foo.ts`. Keep them so:

- `dist/esm/` is unbundled `tsc` output, and Node's ESM loader requires full file extensions, so
  the emitted specifiers must end in `.js`. `tsc` never rewrites a `.js` specifier, so it has to be
  written that way in the source.
- TypeScript maps a `.js` specifier to the matching `.ts` file when type-checking, so the editor,
  `tsc` and Vitest all resolve it.
- Extensionless specifiers (`./foo`) only work behind a bundler (or CommonJS `require`); they break
  `dist/esm/` under Node.
- `.ts` specifiers with `rewriteRelativeImportExtensions` were tried and rejected: `tsc` rewrites
  them in the emitted `.js` but leaves `.ts` specifiers in the emitted `.d.ts`.
- Tools that run `src/` directly must map `.js` back to `.ts` themselves. ts-node's CommonJS
  `require` does not by default, which is why `examples/tsconfig.json` sets ts-node's
  `experimentalResolver`, and CI imports `../src` through ts-node from `examples/` to guard it.

## CI

`.github/workflows/ci.yml` runs on pull requests to `main` and to `release/**` branches, and
`publish.yml` calls it (`workflow_call`) as its `verify` job, so a release runs the same checks:

- `test` (Node 24): lint, `test:coverage` (thresholds in `vitest.config.ts`), `tsc` on
  `tsconfig.test.json` and `tsconfig.examples.json`, an offline ts-node import of `../src` from
  `examples/` (module-resolution guard, no example runs), `build`, `build:browser`, the
  `typecheck/x402-node16` consumer check, `docs` (TypeDoc), `publint` and
  `@arethetypeswrong/cli --pack .`.
- `compat-node18` (Node 18): build, CJS `require` smoke, `scripts/smoke-timeout.mjs`.

`.github/workflows/docs.yml` builds the API reference on every push to `main` and deploys it to
GitHub Pages (https://glassnode.github.io/glassnode-api-ts-client/). It requires the repo setting
Settings → Pages → Source: **GitHub Actions**.

Its concurrency group cancels superseded runs only for pull requests; a run called by
`publish.yml` gets its own group and is never cancelled.

### Release branches

A major release is prepared on a long-lived `release/**` branch (e.g. `release/1.0`, cut from
`main`); its breaking changes land there as separate PRs, and nothing publishes from it.

- **Versioning:** PRs into `release/**` carry **no** version bump. Each one does add its
  `CHANGELOG.md` entry, with migration notes for breaking changes, under a single
  `## 1.0.0 (unreleased)`-style heading at the top. The final PR from the release branch to `main`
  bumps `version` (e.g. to `1.0.0`) and renames that heading to exactly `## <version>` (e.g.
  `## 1.0.0`): `publish.yml` takes the GitHub Release notes from the line that equals
  `## <version>`, so any suffix left on the heading leaves the Release without notes. Its merge
  publishes as usual.
- **CI:** `ci.yml` runs on PRs into `release/**`, but that is not a merge gate by itself: the checks
  block a merge only if a ruleset for `release/**` requires them. Only PRs are CI-checked, not
  direct pushes to the release branch; the combined state is checked by the final PR to `main`.
- **Keeping in sync:** merge `main` into the release branch during its lifetime, and right after
  any CI change lands on `main`. A `pull_request` run uses the workflow from the PR's merge commit,
  so until the release branch has a `ci.yml` whose trigger includes `release/**` (this change),
  PRs into it get no CI at all.

## Publishing

- `.github/workflows/publish.yml` releases the `version` already in `package.json`. It never bumps
  the version, commits or pushes to `main`.
- `main` is protected by a ruleset: no direct pushes, changes land through PRs with the
  required CI checks. Every change reaches `main` through a merged PR.
- On every push to `main` (a merge):
  1. `verify` runs `ci.yml` (the full CI check list, `test` and `compat-node18`), read-only.
  2. `release` (read-only) runs `scripts/release-state.sh`: `npm view glassnode-api@<version>`.
     Only an E404 means "not published"; any other `npm view` failure (network, registry error)
     fails the job, never publishes. If the version is already on npm (a merge without a bump, a
     re-run), the run ends there with a notice in the job summary, and no approval is requested.
  3. `publish` (`needs: [verify, release]`) runs in the `npm` **environment**, so it waits for a
     required reviewer to approve. It re-checks npm, builds, runs `npm publish`, pushes the
     `v<version>` tag on the published commit and creates a GitHub Release from the version's
     `CHANGELOG.md` section. An existing tag on the same commit or an existing Release is fine; a
     tag on another commit is left alone with a warning. If the version is on npm from this very
     commit (npm records its `gitHead`), a re-run only (re)creates the missing tag and Release.
- Only `publish` has write permissions: `id-token: write` (OIDC) and `contents: write` (the tag and
  Release, via `GITHUB_TOKEN`). A `npm-publish` concurrency group serializes publishes and never
  cancels one in progress.
- It uses **npm Trusted Publishing (OIDC)** with provenance — there is **no `NPM_TOKEN`
  secret**. The Trusted Publisher for `glassnode-api` on npmjs.com must name repo
  `glassnode/glassnode-api-ts-client`, workflow `publish.yml` and environment `npm`.
- The `npm` environment (Settings → Environments) must have the maintainer as required reviewer
  and allow deployments from `main` only.
- npm CLI `>= 11.5.1` performs the OIDC exchange, so the workflow installs the latest npm
  and publishes with `npm publish` (not `pnpm publish`, which uses the setup-node
  placeholder token and 404s). The setup-node `.npmrc` is overwritten before publishing so
  npm authenticates via OIDC instead of the placeholder token.
- The repo `.npmrc` sets `ignore-scripts=true`, so `npm publish` skips `prepublishOnly`: the
  workflow runs `build` and `build:browser` itself. The `pnpm/action-setup` step sets
  `npm_config_ignore_scripts: 'false'` because the standalone pnpm needs its own setup script.
