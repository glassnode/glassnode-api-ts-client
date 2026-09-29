// Release planning for .github/workflows/publish.yml, called by scripts/release-state.sh. It only
// computes; it never publishes, tags or talks to npm itself (the caller passes the `npm view`
// output in). Plain Node, no dependencies. Tested by test/release-scripts.spec.ts.
//
// CLI: node scripts/release-plan.mjs
//   Env:
//     VERSION           the version being released (package.json `version`)
//     NPM_VIEW          stdout of `npm view <name> versions dist-tags --json`
//     NPM_RC            that command's exit code
//     CHANGELOG         path of the changelog (default CHANGELOG.md)
//   Prints, one per line:
//     latest=<current `latest` dist-tag, or empty when the package or tag does not exist>
//     dist_tag=<the dist-tag to publish VERSION under>
//     skipped=<space-separated CHANGELOG versions missing on npm, see skippedVersions()>
//   Exits 1 (message on stderr) when VERSION is not semver or npm could not be queried: only an
//   E404 means "package not on npm yet"; any other failure must fail the job, never publish.
/* global process, console */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The official SemVer 2.0.0 regex (semver.org), with named groups.
const SEMVER =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+(?<build>[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Parses a SemVer 2.0.0 version, or returns null. Numbers are BigInt: no precision limit. */
export function parseSemver(version) {
  const m = SEMVER.exec(String(version));
  if (!m) return null;
  const { major, minor, patch, prerelease } = m.groups;
  return {
    major: BigInt(major),
    minor: BigInt(minor),
    patch: BigInt(patch),
    prerelease: prerelease ? prerelease.split('.') : [],
  };
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * SemVer 2.0.0 precedence: -1, 0 or 1. Build metadata is ignored; a prerelease sorts before its
 * release; prerelease identifiers compare numerically when both are numeric, numeric before
 * alphanumeric, otherwise ASCII order, and a shorter prefix sorts first.
 */
export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x) throw new Error(`not a semver version: ${a}`);
  if (!y) throw new Error(`not a semver version: ${b}`);
  const core = cmp(x.major, y.major) || cmp(x.minor, y.minor) || cmp(x.patch, y.patch);
  if (core) return core;
  if (!x.prerelease.length && !y.prerelease.length) return 0;
  if (!x.prerelease.length) return 1; // 1.0.0 > 1.0.0-rc.1
  if (!y.prerelease.length) return -1;
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    const c = pn && qn ? cmp(BigInt(p), BigInt(q)) : pn ? -1 : qn ? 1 : cmp(p, q);
    if (c) return c;
  }
  return 0;
}

/**
 * The dist-tag to publish `version` under, given the current `latest` (null when the package or
 * the tag does not exist), so `latest` never moves backwards or onto a prerelease:
 * - lower than `latest`: `backport-<major>.<minor>` (e.g. a cancelled 0.29.5 re-run after 0.30.1
 *   is out). It names the release line, and it cannot be read as a semver range, which npm
 *   rejects as a tag name (a `v0.29`-style tag would be one).
 * - a prerelease, not lower: `next`, npm's conventional prerelease tag.
 * - otherwise (higher, equal, no `latest` yet): `latest`.
 */
export function distTagFor(version, latest) {
  const v = parseSemver(version);
  if (!v) throw new Error(`not a semver version: ${version}`);
  if (latest && compareSemver(version, latest) < 0) return `backport-${v.major}.${v.minor}`;
  if (v.prerelease.length) return 'next';
  return 'latest';
}

/** The released versions in a changelog: every `## <semver>` heading, exactly (no suffix). */
export function changelogVersions(changelog) {
  const out = [];
  for (const line of changelog.split(/\r?\n/)) {
    const m = /^## (\S+)$/.exec(line);
    if (m && parseSemver(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * CHANGELOG versions that were never published: above the highest npm version below `version`
 * (the last one published before it) and below `version`, and not on npm. These are releases
 * whose publish run was cancelled or never approved. Sorted ascending.
 */
export function skippedVersions(version, published, changelog) {
  const onNpm = new Set(published);
  const before = published.filter((p) => parseSemver(p) && compareSemver(p, version) < 0);
  const last = before.sort(compareSemver).at(-1) ?? null;
  return changelogVersions(changelog)
    .filter((v) => !onNpm.has(v))
    .filter((v) => compareSemver(v, version) < 0 && (!last || compareSemver(v, last) > 0))
    .sort(compareSemver);
}

/**
 * Interprets `npm view <name> versions dist-tags --json`: `{ latest, versions }`, with
 * `{ latest: null, versions: [] }` for an E404. Throws on any other failure.
 */
export function parseNpmView(raw, rc) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`npm view exited ${rc} with unparseable output`);
  }
  if (String(rc) !== '0') {
    const code = data && data.error && data.error.code;
    if (code === 'E404') return { latest: null, versions: [] };
    throw new Error(`npm view exited ${rc} with ${code || 'no error code'}`);
  }
  if (!data || typeof data !== 'object') {
    throw new Error(`npm view exited 0 but returned ${JSON.stringify(data)}`);
  }
  // One published version prints a bare string instead of an array.
  const versions = [].concat(data.versions ?? []);
  const latest = (data['dist-tags'] && data['dist-tags'].latest) || null;
  if (!versions.every((v) => typeof v === 'string') || (latest && !parseSemver(latest))) {
    throw new Error(`npm view exited 0 but returned ${JSON.stringify(data)}`);
  }
  return { latest, versions };
}

function main() {
  const { VERSION: version = '', NPM_VIEW: raw = '', NPM_RC: rc = '' } = process.env;
  if (!parseSemver(version)) throw new Error(`package.json version is not semver: ${version}`);
  const { latest, versions } = parseNpmView(raw, rc);
  const changelog = readFileSync(process.env.CHANGELOG || 'CHANGELOG.md', 'utf8');
  console.log(`latest=${latest ?? ''}`);
  console.log(`dist_tag=${distTagFor(version, latest)}`);
  console.log(`skipped=${skippedVersions(version, versions, changelog).join(' ')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
