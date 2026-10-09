# Contributing to glassnode-api

Thanks for helping improve the TypeScript client for the Glassnode API. This guide walks you
through opening a pull request (PR).

**A merge to `main` releases the `version` in `package.json` to npm once a maintainer approves
the release** (`.github/workflows/publish.yml`). `main` only accepts changes through reviewed PRs.

## Prerequisites

- **Node.js 24** for development (see `.nvmrc`; the test runner, Vitest, needs Node >= 22.12).
  Consumers of the published package only need Node.js >= 22.
- **pnpm** (the version is pinned in `package.json` `packageManager`; `corepack enable` picks it
  up).

## Opening a pull request, step by step

### 1. Fork or branch

Fork the repository (or, with write access, create a branch) and install dependencies:

```bash
git clone https://github.com/<you>/glassnode-api-ts-client.git
cd glassnode-api-ts-client
git checkout -b my-change
pnpm install
pnpm exec husky   # install the pre-commit hook
```

The repo's `.npmrc` disables install scripts, so `pnpm install` does not set up the Husky
pre-commit hook on its own; `pnpm exec husky` does. The hook runs the tests, ESLint + Prettier on
staged files and the build.

### 2. Make the change

Project layout:

- `src/index.ts` - main entry (`glassnode-api`): the `GlassnodeAPI` client, errors and types
- `src/x402.ts` - the `glassnode-api/x402` subpath entry (paid calls via x402)
- `src/types/` - Zod schemas and the types inferred from them
- `test/` - Vitest tests, including the contract tests in `test/contract.spec.ts`
- `examples/` - runnable usage examples (their own `package.json`)
- `scripts/` - the Node-floor smoke test, the contract fixture recorder and the release tooling
- `typecheck/x402-node16/` - a consumer type-check fixture
- `NOTICE` - attribution; listed in `package.json` `files` so it ships in the npm tarball, as
  Apache-2.0 section 4(d) requires

Add or update tests for what you change. The public API is what `src/index.ts` and `src/x402.ts`
export; if you change it, update `README.md` to match and give every new export a doc comment.
The shipped code must keep running on Node.js 22 and in browsers: no `node:` built-ins and no APIs
newer than Node 22 in `src/`.

### 3. Bump the version and add a changelog entry

Every change to the published package bumps `version` in `package.json` and adds an entry at the
top of `CHANGELOG.md` describing it. Docs-, CI- and tooling-only changes (README, CONTRIBUTING,
workflows, tests, lint and editor config) don't: they publish nothing, and the top `CHANGELOG.md`
heading must keep naming the current version. Follow [semver](https://semver.org/):

- **Major**: breaking changes (removed or renamed exports, changed method signatures, changed
  defaults, tightened or widened response schemas, a higher minimum Node.js version).
- **Minor**: new features, methods or config options that are backward compatible.
- **Patch**: bug fixes and internal refactors with no API change.

The README's [Stability and versioning](./README.md#stability-and-versioning) section spells out
what counts as breaking.

The version in your PR is exactly the one that gets published: the release workflow does not bump
it. A PR merged without a bump publishes nothing.

**Release branches.** A major release is prepared on a long-lived `release/**` branch (e.g.
`release/1.0`). PRs into a release branch carry no version bump (except the last one, below), but
each still adds its `CHANGELOG.md` entry, with migration notes for breaking changes, under a single
`## 1.0.0 (unreleased)`-style heading. Before the release branch goes to `main`, a last PR (into
the release branch, or the final PR itself) bumps the version (e.g. to `1.0.0`) and renames that
heading to exactly `## 1.0.0`, the form the release workflow extracts the GitHub Release notes
from. CI enforces it: into a release branch the top heading may be `## <x.y.z> (unreleased)` or
`## <package.json version>`, into `main` it must be exactly `## <package.json version>`
(`node scripts/check-changelog-heading.mjs <target branch>` runs the check locally). The release
branch takes merges from `main` during its lifetime, and right after any CI change lands there: a
PR's CI runs the `ci.yml` of its merge commit, so the release branch needs the current one. Only
PRs into it are CI-checked, not direct pushes; the final PR to `main` checks the combined result.

### 4. Run the full local check list

CI runs these on every PR into `main` or a `release/**` branch; run them locally first:

```bash
pnpm run lint
pnpm test
pnpm exec tsc -p tsconfig.test.json --noEmit
pnpm exec tsc -p tsconfig.examples.json
pnpm run build
pnpm run build:browser
pnpm exec tsc -p typecheck/x402-node16/tsconfig.json
node scripts/check-changelog-heading.mjs main
npx prettier --check .
pnpm run docs
pnpm dlx publint
pnpm dlx @arethetypeswrong/cli --pack .
```

`pnpm run test:coverage` enforces the coverage thresholds in `vitest.config.ts`, and
`pnpm run format` fixes formatting. `pnpm run docs` fails on any TypeDoc warning, such as a broken
`{@link}`.

### 5. Open the PR against `main`

(Or against the `release/**` branch, for a change that belongs to an upcoming major release.)

A good PR description says:

- **What** changed.
- **Why**: the problem it solves or the issue it closes.
- **How it was verified**: the checks you ran and any manual testing.
- **User-facing impact**: behaviour changes for consumers, and any breaking change called out
  explicitly.

### 6. CI, review and merge

CI must pass, and a maintainer reviews the PR. Once it is approved, a maintainer merges it.

The merge starts the release workflow. It re-runs the full CI check list, then its publish job
waits for a maintainer to approve it (the `npm` environment). After the approval it publishes the
new version to npm with provenance, tags the commit `v<version>` and creates a GitHub Release from
your `CHANGELOG.md` entry. If that version is already on npm, the workflow skips the release.

## Releases (for maintainers)

**Merge release PRs one at a time.** Publishes run one after another (the `npm-publish`
concurrency group), and one in progress is never cancelled. But GitHub keeps only **one pending**
run per group: when a newer merge's publish job queues up, it replaces an older one that is still
waiting, including one waiting for its approval. That older version is then never published. This
happened to 0.29.5 and 0.30.0 on 2026-09-29. Wait for each release to finish (published, tagged,
GitHub Release created) before merging the next PR that bumps the version.

**Detecting a skipped version.** Every release run's summary lists, as a warning, each
`CHANGELOG.md` version between the last one published to npm and the one being released that is
missing on npm.

**Recovering.** Open the skipped version's workflow run (Actions → Publish Package, the merge
commit that carries that version) and choose **Re-run all jobs**, then approve the publish. If a
higher version is already npm's `latest`, the older one is published under the
`backport-<major>.<minor>` dist-tag (e.g. `backport-0.29`) instead, so `latest` never moves
backwards, and its GitHub Release is not marked "Latest". A prerelease version is published under
`next`. A run from a commit older than this guard (1.0.0) publishes with npm's default tag, so after
re-running one, check `npm dist-tag ls glassnode-api`; if `latest` moved backwards, a maintainer
restores it with `npm dist-tag add glassnode-api@<newest version> latest`.

## Contract fixtures

`test/fixtures/contract/` holds real API responses recorded by `scripts/record-fixtures.mjs`.
Never hand-edit them; re-record them. That needs an API key, so it is only done to refresh the
fixtures. A contract test that fails against a fixture is real API drift: fix the schema, not the
fixture or the test (after a re-recording, the README lists the few literal values in
`test/contract.spec.ts` that may legitimately need updating). See
[Recording contract fixtures](./README.md#recording-contract-fixtures) in the README.

## Security

- Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md). Never open a
  public issue for them.
- Never commit API keys or other secrets, including in fixtures, examples, `.env` files or test
  output.

## Design notes

Decisions that are easy to undo by accident. Read the relevant one before changing the toolchain,
the build or the workflows.

### Node.js versions

Two baselines, kept separate:

- **Consumers** need Node.js >= 22 (`package.json` `engines`; raised from 18 in 1.0). `src/` uses
  only universal APIs plus global `fetch` and also runs in browsers, so the floor is no licence to
  use Node-only APIs.
- **Developers** run Node.js 24 (`.nvmrc`, the main CI and publish jobs). Vitest 5 needs
  Node.js >= 22.12; that is dev-only and never reaches consumers. The CI `compat-node-floor` job
  proves the consumer floor: on Node 22 it builds, `require`s the CJS entry and runs
  `scripts/smoke-timeout.mjs`.

### Toolchain pins

- **`@types/node` is pinned to the floor** (`^22`), not the dev runtime, so the compiler rejects
  APIs newer than Node 22. It is approximate (CI runs the latest 22.x and `@types/node` is
  `^22.20`, so an API added after 22.0 is not caught). Bump its major only when the minimum
  supported Node.js is intentionally raised, which is a breaking change (major release and
  `engines` bump). Dependabot ignores its major updates for this reason.
- **TypeScript stays on 6.x.** As of 1.0.0, `typescript-eslint` declares its `typescript` peer as
  `<6.1.0`, so TypeScript 7 breaks `pnpm run lint` (in CI and in the pre-commit hook). Move to 7.x
  only once a `typescript-eslint` release accepts it.
- **`typedoc` also gates TypeScript:** its `typescript` peer lists explicit minors (up to 6.0.x on
  0.28.20), so any TypeScript bump, even to 6.1, needs a `typedoc` release that lists it, or
  `pnpm run docs` (and CI) break.

### API reference (TypeDoc)

- Entry points are `src/index.ts` (`glassnode-api`) and `src/x402.ts` (`glassnode-api/x402`),
  named by their `@module` comments; README.md is the landing page. Config in `typedoc.json`,
  output in `api-docs/` (not committed, not published to npm).
- `typedoc-plugin-zod` expands `z.infer`/`z.input` aliases, so Zod-derived types such as
  `MetricMetadata` and `GlassnodeConfig` render as objects with their field comments.
- Every warning is an error (`treatWarningsAsErrors`; `notExported`, `invalidLink`, `invalidPath`
  and `rewrittenLink` on). `notDocumented` is off: it only reports nested members of Zod objects
  and `z.enum` literals, which cannot carry comments. Every top-level export and class member is
  documented; keep it so.
- `.github/workflows/docs.yml` deploys the reference to GitHub Pages
  (https://glassnode.github.io/glassnode-api-ts-client/) on every push to `main`. It needs the repo
  setting Settings → Pages → Source: **GitHub Actions**.

### Build targets and packaging

- **CJS:** `tsc` → `dist/` (the `require` entry). **ESM:** `tsc -p tsconfig.esm.json` →
  `dist/esm/`, unbundled with `zod` external (the `import` entry), plus a generated
  `dist/esm/package.json` (`{"type":"module"}`). `exports` has per-condition `types`, checked by
  `publint` and `@arethetypeswrong/cli` in CI. The package itself is `"type": "commonjs"`.
- **Browser:** Rollup (`tsconfig.browser.json`) builds minified UMD
  (`dist/glassnode-api.umd.min.js`, global `GlassnodeAPI`) and ESM
  (`dist/glassnode-api.esm.min.js`) bundles from `src/index.ts`, with `zod` bundled in and
  `src/x402.ts` left out. Source maps are `hidden` and not published. `module` points at the
  unbundled `dist/esm/index.js`, not a bundle. `tsconfig.browser.json` uses
  `moduleResolution: bundler` (not the deprecated `node`/`node10`); Rollup's node-resolve plugin
  does the actual resolution.
- **No `browser` field.** `unpkg` and `jsdelivr` point at the UMD bundle so the bare CDN URL serves
  it. There is deliberately no top-level `browser` field and no `browser` condition in `exports`:
  the condition would send webpack 5, Vite and esbuild to the pre-minified bundle with `zod`
  inlined instead of the tree-shakeable ESM build (the top-level field only affected
  `exports`-unaware tools such as Browserify). Keep both out, even though `publint` suggests the
  condition (#37).
- **`src/` imports end in `.js`** (`./foo.js` for `foo.ts`). `dist/esm/` is unbundled `tsc`
  output, Node's ESM loader needs full extensions, and `tsc` never rewrites a `.js` specifier.
  Extensionless specifiers only work behind a bundler or CommonJS. `.ts` specifiers with
  `rewriteRelativeImportExtensions` were rejected: `tsc` leaves them as `.ts` in the emitted
  `.d.ts`. Tools that run `src/` directly must map `.js` to `.ts`; ts-node needs
  `experimentalResolver`, set in `examples/tsconfig.json`, and CI guards it by importing `../src`
  through ts-node from `examples/`.
- **`GlassnodeConfigSchema` stays a plain `z.object`** (no `.transform()`), so `.shape`, `.pick`,
  `.extend` and `.partial` keep working. Defaults that depend on other options (`maxRetries` is
  `DEFAULT_MAX_RETRIES`, or `DEFAULT_X402_MAX_RETRIES` with `x402`) are applied in the constructor.
- TypeScript configs: `tsconfig.json` (CJS), `tsconfig.esm.json` (ESM), `tsconfig.browser.json`
  (browser), `tsconfig.test.json` (tests and IDE), `tsconfig.examples.json` (type-checks
  `examples/` against `src/` with the root dependencies), `examples/tsconfig.json` (ts-node, for
  running the examples) and `typecheck/x402-node16/tsconfig.json` (a node16 consumer with
  `skipLibCheck: false`).

### CI and workflows

- `ci.yml` runs on PRs into `main` and `release/**`, and `publish.yml` calls it as its `verify` job,
  so a release runs the same checks. Its concurrency group cancels superseded runs only for PRs; a
  run called by `publish.yml` is never cancelled.
- Its jobs are `test` (Node 24: the step-4 check list, `test:coverage` and the examples' ts-node
  import guard) and `compat-node-floor` (Node 22). The rulesets require them by name, so renaming
  a job means updating the rulesets; `compat-node-floor` is version-neutral so a floor bump only
  changes its `node-version`.
- Every action is pinned by full commit SHA with a `# vX.Y.Z` comment, never by a movable tag. To
  bump one, resolve the tag with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` (for an
  annotated tag, dereference it with `gh api repos/<owner>/<repo>/git/tags/<sha>` to get the
  commit), update SHA and comment together, and read the release notes for changed inputs or
  defaults.
- Every workflow sets minimal `permissions:`: `contents: read` by default, and write access only on
  the `publish` job, which needs it.

### Publishing setup

- `publish.yml` publishes with **npm Trusted Publishing (OIDC)** and provenance: there is no
  `NPM_TOKEN` secret. The Trusted Publisher for `glassnode-api` on npmjs.com names repo
  `glassnode/glassnode-api-ts-client`, workflow `publish.yml` and environment `npm`.
- The `npm` environment (Settings → Environments) has the maintainer as required reviewer and
  allows deployments from `main` only. Only the `publish` job has write permissions:
  `id-token: write` (OIDC) and `contents: write` (tag and Release, via `GITHUB_TOKEN`).
- The `release` job runs `scripts/release-state.sh`: only an E404 from `npm view` means "not
  published"; any other failure fails the job and never publishes. `publish` re-checks npm before
  publishing. An existing tag on the same commit or an existing Release is fine; a tag on another
  commit is left alone with a warning. If the version is on npm from this very commit (npm records
  its `gitHead`), a re-run only (re)creates the missing tag and Release.
- npm CLI >= 11.5.1 does the OIDC exchange, so the workflow installs the latest npm and runs
  `npm publish`, not `pnpm publish` (which uses the setup-node placeholder token and gets a 404).
  The setup-node `.npmrc` is overwritten first so npm authenticates via OIDC.
- The repo `.npmrc` sets `ignore-scripts=true`, so `npm publish` skips `prepublishOnly`: the
  workflow runs `build` and `build:browser` itself. The `pnpm/action-setup` steps set
  `npm_config_ignore_scripts: 'false'` because the standalone pnpm needs its own setup script.
- **Dist-tag guard** (`scripts/release-plan.mjs`, SemVer 2.0.0 precedence, no dependencies):
  `npm publish` always gets an explicit `--tag`: `latest`, `next` for a prerelease, or
  `backport-<major>.<minor>` for a version below the current `latest`. Not `v<major>.<minor>`: npm
  rejects a tag that is a valid semver range. `release-state.sh` fails on any other tag.
  `package.json` `publishConfig` deliberately sets **no** `tag`: `tag: "latest"` there would force
  `latest` on a manual publish or an npm that doesn't let `--tag` override it. Keep it out.

## License of contributions

This project is licensed under the [Apache License 2.0](./LICENSE). Under its Section 5, any
contribution you intentionally submit for inclusion is licensed under the same terms, unless you
explicitly state otherwise.
