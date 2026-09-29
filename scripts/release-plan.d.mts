// Types for scripts/release-plan.mjs, so test/release-scripts.spec.ts type-checks its import.
export interface SemVer {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: string[];
}
export function parseSemver(version: string): SemVer | null;
export function compareSemver(a: string, b: string): -1 | 0 | 1;
export function distTagFor(version: string, latest: string | null): string;
export function changelogVersions(changelog: string): string[];
export function skippedVersions(version: string, published: string[], changelog: string): string[];
export function parseNpmView(
  raw: string,
  rc: string | number
): { latest: string | null; versions: string[] };
