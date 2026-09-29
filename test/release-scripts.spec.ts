// Tests for the release tooling in scripts/ (publish.yml and ci.yml run it; it is not shipped):
// release-plan.mjs (semver, dist-tag, skipped versions), release-state.sh end to end with a fake
// `npm` on PATH, and check-changelog-heading.mjs.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

type Plan = typeof import('../scripts/release-plan.mjs');
let plan: Plan;
beforeAll(async () => {
  plan = await import('../scripts/release-plan.mjs');
});

const scripts = resolve(__dirname, '../scripts');
const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'release-scripts-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CHANGELOG = [
  '# Changelog',
  '',
  '## 0.30.1',
  '',
  '- fix',
  '',
  '## 0.30.0',
  '',
  '## 0.29.5',
  '',
  '## 0.29.4',
  '',
  '## 0.29.3',
  '',
].join('\n');

describe('compareSemver', () => {
  it('orders versions by SemVer 2.0.0 precedence', () => {
    // The precedence example from semver.org, plus numeric (not string) core comparison.
    const ordered = [
      '0.9.0',
      '0.10.0',
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0',
    ];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        expect(plan.compareSemver(ordered[i], ordered[j])).toBe(Math.sign(i - j));
      }
    }
  });

  it('ignores build metadata and rejects non-semver input', () => {
    expect(plan.compareSemver('1.0.0+build.1', '1.0.0+build.2')).toBe(0);
    expect(plan.compareSemver('1.0.0-rc.1+b', '1.0.0')).toBe(-1);
    expect(() => plan.compareSemver('v1.0.0', '1.0.0')).toThrow(/not a semver/);
    expect(() => plan.compareSemver('1.0', '1.0.0')).toThrow(/not a semver/);
    expect(plan.parseSemver('01.0.0')).toBeNull();
  });
});

describe('distTagFor', () => {
  it.each([
    ['older than latest', '0.29.5', '0.30.1', 'backport-0.29'],
    ['older patch in the same line', '0.30.0', '0.30.1', 'backport-0.30'],
    ['older major', '0.30.2', '1.0.0', 'backport-0.30'],
    ['newer than latest', '1.0.0', '0.30.1', 'latest'],
    ['equal to latest (re-run)', '0.30.1', '0.30.1', 'latest'],
    ['no latest (first publish)', '0.1.0', null, 'latest'],
    ['prerelease above latest', '1.0.0-rc.1', '0.30.1', 'next'],
    ['prerelease with no latest', '1.0.0-rc.1', null, 'next'],
    ['prerelease below latest', '1.0.0-rc.1', '1.0.0', 'backport-1.0'],
    ['release above a prerelease latest', '1.0.0', '1.0.0-rc.1', 'latest'],
  ])('%s', (_, version, latest, expected) => {
    expect(plan.distTagFor(version, latest)).toBe(expected);
  });

  it('never picks a tag npm would read as a semver range', () => {
    // npm rejects dist-tags that parse as a range; `v0.29`-style names would.
    expect(plan.distTagFor('0.29.5', '0.30.1')).not.toMatch(/^v?\d/);
  });
});

describe('skippedVersions', () => {
  it('lists CHANGELOG versions between the last published one and this one missing on npm', () => {
    // 2026-09-29: the 0.29.5 and 0.30.0 publish runs were cancelled by the 0.30.1 merge.
    const published = ['0.29.2', '0.29.3', '0.29.4'];
    expect(plan.skippedVersions('0.30.1', published, CHANGELOG)).toEqual(['0.29.5', '0.30.0']);
    // Still reported on a re-run after 0.30.1 is out: "last" is the last one below this version.
    expect(plan.skippedVersions('0.30.1', [...published, '0.30.1'], CHANGELOG)).toEqual([
      '0.29.5',
      '0.30.0',
    ]);
  });

  it('is empty when nothing was skipped, and ignores unreleased headings', () => {
    const changelog = `## 1.0.0 (unreleased)\n\n${CHANGELOG}`;
    const all = ['0.29.3', '0.29.4', '0.29.5', '0.30.0'];
    expect(plan.skippedVersions('0.30.1', all, changelog)).toEqual([]);
    expect(plan.changelogVersions(changelog)).toEqual([
      '0.30.1',
      '0.30.0',
      '0.29.5',
      '0.29.4',
      '0.29.3',
    ]);
  });

  it('lists every earlier CHANGELOG version when nothing is published yet', () => {
    expect(plan.skippedVersions('0.29.5', [], CHANGELOG)).toEqual(['0.29.3', '0.29.4']);
  });
});

describe('parseNpmView', () => {
  it('reads versions and the latest dist-tag', () => {
    const raw = JSON.stringify({ versions: ['0.1.0', '0.2.0'], 'dist-tags': { latest: '0.2.0' } });
    expect(plan.parseNpmView(raw, 0)).toEqual({ latest: '0.2.0', versions: ['0.1.0', '0.2.0'] });
  });

  it('accepts a single version printed as a string and a missing latest tag', () => {
    const raw = JSON.stringify({ versions: '0.1.0', 'dist-tags': { next: '0.1.0' } });
    expect(plan.parseNpmView(raw, '0')).toEqual({ latest: null, versions: ['0.1.0'] });
  });

  it('treats E404 as "never published" and fails on anything else', () => {
    const e404 = JSON.stringify({ error: { code: 'E404' } });
    expect(plan.parseNpmView(e404, 1)).toEqual({ latest: null, versions: [] });
    const timeout = JSON.stringify({ error: { code: 'ETIMEDOUT' } });
    expect(() => plan.parseNpmView(timeout, 1)).toThrow(/ETIMEDOUT/);
    expect(() => plan.parseNpmView('', 1)).toThrow(/unparseable/);
    expect(() => plan.parseNpmView('"0.1.0"', 0)).toThrow(/returned/);
    const badLatest = JSON.stringify({ versions: [], 'dist-tags': { latest: 'nope' } });
    expect(() => plan.parseNpmView(badLatest, 0)).toThrow(/returned/);
  });
});

describe('release-state.sh (fake npm)', () => {
  const SHA = 'a'.repeat(40);

  interface Npm {
    /** `npm view glassnode-api@<version> version gitHead --json`: stdout and exit code. */
    version: [string, number];
    /** `npm view glassnode-api versions dist-tags --json`: stdout and exit code. */
    pkg: [string, number];
  }
  const e404: [string, number] = [JSON.stringify({ error: { code: 'E404' } }), 1];
  const pkg = (versions: string[], latest?: string): [string, number] => [
    JSON.stringify({ versions, 'dist-tags': latest ? { latest } : {} }),
    0,
  ];

  /**
   * Runs release-state.sh in a temp repo with a fake `npm`. `plan` replaces release-plan.mjs (the
   * script is copied next to a fake one, since it runs `$(dirname "$0")/release-plan.mjs`).
   */
  function run(version: string, npm: Npm, changelog = CHANGELOG, plan?: string) {
    const dir = tempDir();
    let script = join(scripts, 'release-state.sh');
    if (plan !== undefined) {
      mkdirSync(join(dir, 'scripts'));
      script = join(dir, 'scripts', 'release-state.sh');
      writeFileSync(script, readFileSync(join(scripts, 'release-state.sh')));
      writeFileSync(join(dir, 'scripts', 'release-plan.mjs'), plan);
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'glassnode-api', version }));
    writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
    const fakeNpm = join(dir, 'bin', 'npm');
    mkdirSync(join(dir, 'bin'));
    // $2 is the package spec: `<name>@<version>` for the version query, `<name>` otherwise.
    writeFileSync(
      fakeNpm,
      [
        '#!/bin/sh',
        'echo "$*" >> "$FAKE_NPM_LOG"',
        'case "$2" in',
        '  *@*) printf "%s" "$FAKE_VERSION_OUT"; exit "$FAKE_VERSION_RC" ;;',
        '  *) printf "%s" "$FAKE_PKG_OUT"; exit "$FAKE_PKG_RC" ;;',
        'esac',
        '',
      ].join('\n')
    );
    chmodSync(fakeNpm, 0o755);
    const output = join(dir, 'output');
    const summary = join(dir, 'summary');
    const npmLog = join(dir, 'npm.log');
    writeFileSync(npmLog, '');
    writeFileSync(output, '');
    writeFileSync(summary, '');
    const res = spawnSync('bash', [script], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        GITHUB_SHA: SHA,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        FAKE_VERSION_OUT: npm.version[0],
        FAKE_VERSION_RC: String(npm.version[1]),
        FAKE_PKG_OUT: npm.pkg[0],
        FAKE_PKG_RC: String(npm.pkg[1]),
        FAKE_NPM_LOG: npmLog,
      },
    });
    const outputs = Object.fromEntries(
      readFileSync(output, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(/=(.*)/s).slice(0, 2))
    );
    const npmCalls = readFileSync(npmLog, 'utf8').split('\n').filter(Boolean);
    return { ...res, outputs, npmCalls, summary: readFileSync(summary, 'utf8') };
  }

  it('queries npm with exactly the expected arguments', () => {
    const r = run('0.30.1', { version: e404, pkg: pkg(['0.30.0'], '0.30.0') });
    expect(r.status).toBe(0);
    // --prefer-online: npm's cache must not hide a just-published version or a moved `latest`.
    expect(r.npmCalls).toEqual([
      'view glassnode-api@0.30.1 version gitHead --json --prefer-online',
      'view glassnode-api versions dist-tags --json --prefer-online',
    ]);
  });

  it.each([
    ['empty', 'dist_tag='],
    ['missing', ''],
    ['unexpected', 'dist_tag=beta'],
    ['a semver range', 'dist_tag=v0.29'],
    ['with trailing text', 'dist_tag=latest x'],
  ])('fails, writing no outputs, on a %s dist-tag from release-plan.mjs', (_, line) => {
    const plan = `console.log('latest=0.30.0');\nconsole.log(${JSON.stringify(line)});\nconsole.log('skipped=');\n`;
    const r = run('0.30.1', { version: e404, pkg: pkg(['0.30.0'], '0.30.0') }, CHANGELOG, plan);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Unexpected dist-tag');
    expect(r.outputs).toEqual({});
  });

  it('accepts every dist-tag shape release-plan.mjs produces', () => {
    for (const tag of ['latest', 'next', 'backport-0.29', 'backport-12.345']) {
      const plan = `console.log('latest=0.30.0');\nconsole.log('dist_tag=${tag}');\nconsole.log('skipped=');\n`;
      const r = run('0.30.1', { version: e404, pkg: pkg(['0.30.0'], '0.30.0') }, CHANGELOG, plan);
      expect(r.status, r.stderr).toBe(0);
      expect(r.outputs.dist_tag).toBe(tag);
    }
  });

  it('publishes a new version above latest under `latest`', () => {
    const r = run('0.30.1', {
      version: e404,
      pkg: pkg(['0.29.4', '0.29.5', '0.30.0'], '0.30.0'),
    });
    expect(r.status).toBe(0);
    expect(r.outputs).toEqual({
      version: '0.30.1',
      tag: 'v0.30.1',
      action: 'publish',
      dist_tag: 'latest',
      latest: '0.30.0',
    });
    expect(r.summary).not.toContain('WARNING');
  });

  it('publishes a version below latest under a backport tag and warns about skipped ones', () => {
    // Re-run of the cancelled 0.30.0 after 0.30.1 is out; 0.29.5 is still missing too.
    const r = run('0.30.0', { version: e404, pkg: pkg(['0.29.4', '0.30.1'], '0.30.1') });
    expect(r.status).toBe(0);
    expect(r.outputs).toMatchObject({ action: 'publish', dist_tag: 'backport-0.30' });
    expect(r.summary).toContain('`latest` does not move');
    expect(r.summary).toContain('`0.29.5`');
    expect(r.stdout).toContain('::warning::');
  });

  it('warns about the versions skipped before a new release', () => {
    const r = run('0.30.1', { version: e404, pkg: pkg(['0.29.3', '0.29.4'], '0.29.4') });
    expect(r.outputs).toMatchObject({ action: 'publish', dist_tag: 'latest' });
    expect(r.summary).toContain('`0.29.5`, `0.30.0`');
  });

  it('only (re)tags a version published from this commit, keeping `latest`', () => {
    const view = JSON.stringify({ version: '0.30.1', gitHead: SHA });
    const r = run('0.30.1', {
      version: [view, 0],
      pkg: pkg(['0.29.5', '0.30.0', '0.30.1'], '0.30.1'),
    });
    expect(r.status).toBe(0);
    expect(r.outputs).toMatchObject({ action: 'tag-only', dist_tag: 'latest', latest: '0.30.1' });
  });

  it('skips a version published from another commit', () => {
    const view = JSON.stringify({ version: '0.30.1', gitHead: 'b'.repeat(40) });
    const r = run('0.30.1', { version: [view, 0], pkg: pkg(['0.30.1'], '0.30.1') });
    expect(r.status).toBe(0);
    expect(r.outputs).toMatchObject({ action: 'skip' });
  });

  it('publishes the first version of a package that is not on npm under `latest`', () => {
    const r = run('0.29.3', { version: e404, pkg: e404 }, '## 0.29.3\n');
    expect(r.status).toBe(0);
    expect(r.outputs).toMatchObject({ action: 'publish', dist_tag: 'latest', latest: '' });
  });

  it('publishes a prerelease under `next`', () => {
    const r = run('1.0.0-rc.1', { version: e404, pkg: pkg(['0.30.1'], '0.30.1') });
    expect(r.status).toBe(0);
    expect(r.outputs).toMatchObject({ action: 'publish', dist_tag: 'next' });
    expect(r.summary).toContain('prerelease');
  });

  it('fails, never publishes, when npm cannot be queried', () => {
    const timeout: [string, number] = [JSON.stringify({ error: { code: 'ETIMEDOUT' } }), 1];
    const pkgFails = run('0.30.1', { version: e404, pkg: timeout });
    expect(pkgFails.status).not.toBe(0);
    expect(pkgFails.stderr).toContain('ETIMEDOUT');
    expect(pkgFails.outputs).toEqual({});
    const versionFails = run('0.30.1', { version: timeout, pkg: pkg(['0.30.0'], '0.30.0') });
    expect(versionFails.status).not.toBe(0);
    expect(versionFails.outputs).toEqual({});
  });
});

describe('check-changelog-heading.mjs', () => {
  function check(changelog: string, version: string, target: string) {
    const dir = tempDir();
    writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
    return spawnSync('node', [join(scripts, 'check-changelog-heading.mjs'), target], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CHANGELOG: join(dir, 'CHANGELOG.md'),
        PACKAGE_JSON: join(dir, 'package.json'),
      },
    });
  }
  const log = (heading: string) => `# Changelog\n\n${heading}\n\n- change\n\n## 0.30.0\n`;

  it.each([
    ['main, exact version', log('## 0.30.1'), '0.30.1', 'main'],
    ['release branch, exact version', log('## 1.0.0'), '1.0.0', 'release/1.0'],
    [
      'release branch, unreleased (package.json not compared)',
      log('## 1.0.0 (unreleased)'),
      '0.30.1',
      'release/1.0',
    ],
  ])('passes: %s', (_, changelog, version, target) => {
    const r = check(changelog, version, target);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it.each([
    [
      'main, unreleased heading',
      log('## 1.0.0 (unreleased)'),
      '1.0.0',
      'main',
      /cannot reach main/,
    ],
    ['main, version mismatch', log('## 0.30.2'), '0.30.1', 'main', /must be "## 0.30.1"/],
    [
      'release branch, version mismatch',
      log('## 0.30.2'),
      '0.30.1',
      'release/1.0',
      /"## 0.30.1" or/,
    ],
    [
      'release branch, unreleased non-semver',
      log('## 1.0 (unreleased)'),
      '0.30.1',
      'release/1.0',
      /must be/,
    ],
    ['release branch, other suffix', log('## 1.0.0 (draft)'), '0.30.1', 'release/1.0', /must be/],
    ['trailing whitespace', log('## 0.30.1 '), '0.30.1', 'main', /must be/],
    ['no heading', '# Changelog\n', '0.30.1', 'main', /no "## " heading/],
  ])('fails: %s', (_, changelog, version, target, message) => {
    const r = check(changelog, version, target);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^::error file=CHANGELOG.md::/);
    expect(r.stderr).toMatch(message);
  });

  it('accepts the repository CHANGELOG.md for its own branch rules', () => {
    // release/1.0 carries "## 1.0.0 (unreleased)" with package.json still at 0.30.x.
    const r = spawnSync('node', [join(scripts, 'check-changelog-heading.mjs'), 'release/1.0'], {
      cwd: resolve(__dirname, '..'),
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
  });
});
