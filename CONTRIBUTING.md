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

Add or update tests for what you change. The public API is what `src/index.ts` and `src/x402.ts`
export; if you change it, update `README.md` to match and give every new export a doc comment.
The shipped code must keep running on Node.js 22 and in browsers: no `node:` built-ins and no APIs
newer than Node 22 in `src/`.

### 3. Bump the version and add a changelog entry

Every change bumps `version` in `package.json` and adds an entry at the top of `CHANGELOG.md`
describing it. Follow [semver](https://semver.org/):

- **Major**: breaking changes (removed or renamed exports, changed method signatures, a higher
  minimum Node.js version).
- **Minor**: new features, methods or config options that are backward compatible.
- **Patch**: bug fixes, docs and internal refactors with no API change.

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
fixtures. See [Recording contract fixtures](./README.md#recording-contract-fixtures) in the README.

## Security

- Report vulnerabilities privately, through GitHub's private vulnerability reporting on this
  repository (the **Security** tab → **Report a vulnerability**). Never open a public issue for
  them.
- Never commit API keys or other secrets, including in fixtures, examples, `.env` files or test
  output.

## License of contributions

This project is licensed under the [Apache License 2.0](./LICENSE). Under its Section 5, any
contribution you intentionally submit for inclusion is licensed under the same terms, unless you
explicitly state otherwise.
