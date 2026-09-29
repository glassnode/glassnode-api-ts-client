#!/usr/bin/env bash
# Decides what .github/workflows/publish.yml does for the version in package.json. It never
# bumps, commits or publishes anything itself.
#
# Writes to $GITHUB_OUTPUT (stdout when unset):
#   version=<package.json version>
#   tag=v<version>
#   action=publish   the version is not on npm: build, publish, then tag and release
#   action=tag-only  the version is on npm and was published from this very commit
#                    (npm records its gitHead): a re-run after a failed tag/release step,
#                    so only (re)create the tag and the GitHub Release
#   action=skip      the version is on npm from another commit (a merge that did not bump
#                    `version`, or a later re-run): nothing to do
#   dist_tag=<tag>   the npm dist-tag to publish under (scripts/release-plan.mjs): `latest`, or
#                    `backport-<major>.<minor>` when the version is lower than the current
#                    `latest` (a re-run of a cancelled older release), or `next` for a prerelease,
#                    so `latest` never moves backwards
#   latest=<version> the current `latest` dist-tag (empty when the package is not on npm)
#
# It also warns (annotation and job summary) about skipped releases: CHANGELOG versions between
# the last published version and this one that are not on npm (their publish run was cancelled
# by a later merge or never approved).
#
# `npm view` failure modes: only an E404 means "not published". Any other failure (network,
# registry error, unparseable output) exits non-zero, so the job fails instead of publishing.
#
# Env: GITHUB_SHA (required; the commit being released), GITHUB_OUTPUT and
# GITHUB_STEP_SUMMARY (optional, set by Actions). Run from the repository root.
set -euo pipefail

sha=${GITHUB_SHA:?GITHUB_SHA must be set to the commit being released}
out=${GITHUB_OUTPUT:-/dev/stdout}
summary=${GITHUB_STEP_SUMMARY:-/dev/stderr}

name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")
tag="v$version"

# --json prints the fields on success and {"error":{"code":...}} on failure, both on stdout.
# --prefer-online revalidates npm's cache so a just-published version is seen.
set +e
view=$(npm view "$name@$version" version gitHead --json --prefer-online 2>/dev/null)
rc=$?
set -e

# Prints "published <gitHead>", "missing" or "error <reason>".
# shellcheck disable=SC2016 # the single-quoted program is JavaScript, not shell
state=$(
  NPM_VIEW="$view" NPM_RC="$rc" VERSION="$version" node -e '
    const { NPM_VIEW: raw, NPM_RC: rc, VERSION: version } = process.env;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.log(`error npm view exited ${rc} with unparseable output`);
      process.exit(0);
    }
    if (rc === "0") {
      // One field prints a bare string, several print an object.
      const found = typeof data === "string" ? data : data && data.version;
      if (found === version) console.log(`published ${(data && data.gitHead) || "-"}`);
      else console.log(`error npm view exited 0 but returned ${JSON.stringify(data)}`);
    } else {
      const code = data && data.error && data.error.code;
      if (code === "E404") console.log("missing");
      else console.log(`error npm view exited ${rc} with ${code || "no error code"}`);
    }
  '
)

# The package's versions and dist-tags, for the dist-tag and the skipped-release check. Same
# failure policy: an E404 (package never published) is fine, any other failure fails the job.
set +e
pkg_view=$(npm view "$name" versions dist-tags --json --prefer-online 2>/dev/null)
pkg_rc=$?
set -e
plan=$(NPM_VIEW="$pkg_view" NPM_RC="$pkg_rc" VERSION="$version" node "$(dirname "$0")/release-plan.mjs") || {
  echo "::error::Could not plan the release of $name@$version (see above)" >&2
  exit 1
}
dist_tag=$(sed -n 's/^dist_tag=//p' <<<"$plan")
latest=$(sed -n 's/^latest=//p' <<<"$plan")
skipped=$(sed -n 's/^skipped=//p' <<<"$plan")
# Belt and braces: never hand `npm publish --tag` an empty or unexpected tag (an empty one would
# fail the publish, a wrong one could move `latest`).
if ! [[ "$dist_tag" =~ ^(latest|next|backport-[0-9]+\.[0-9]+)$ ]]; then
  echo "::error::Unexpected dist-tag '$dist_tag' for $name@$version from release-plan.mjs" >&2
  exit 1
fi

case "$state" in
  missing)
    action='publish'
    msg="\`$name@$version\` is not on npm yet: publishing it and tagging \`$tag\`."
    ;;
  "published $sha")
    action='tag-only'
    msg="\`$name@$version\` is already on npm, published from this commit: skipping the publish, (re)creating the \`$tag\` tag and GitHub Release if missing."
    ;;
  published\ *)
    action='skip'
    msg="\`$name@$version\` is already on npm (published from commit \`${state#published }\`): nothing to publish. Bump \`version\` in package.json to release."
    ;;
  *)
    echo "::error::Could not determine whether $name@$version is on npm: ${state#error }" >&2
    exit 1
    ;;
esac

{
  echo "version=$version"
  echo "tag=$tag"
  echo "action=$action"
  echo "dist_tag=$dist_tag"
  echo "latest=$latest"
} >>"$out"

echo "### Release: $action" >>"$summary"
echo "$msg" >>"$summary"
if [ "$dist_tag" != latest ]; then
  echo "" >>"$summary"
  if [ "$dist_tag" = next ]; then
    echo "\`$version\` is a prerelease: it goes out under the \`next\` dist-tag, \`latest\` stays at \`${latest:-none}\`." >>"$summary"
  else
    echo "\`$version\` is lower than \`latest\` (\`$latest\`): it goes out under the \`$dist_tag\` dist-tag and \`latest\` does not move." >>"$summary"
  fi
fi
if [ -n "$skipped" ]; then
  echo "::warning::CHANGELOG versions never published to npm (publish run cancelled or not approved): $skipped"
  {
    echo ""
    echo "> [!WARNING]"
    echo "> These CHANGELOG versions, between the last published version and \`$version\`, are not on npm (their publish run was cancelled by a later merge or never approved): \`${skipped// /\`, \`}\`. See CONTRIBUTING.md \"Releases\" to recover."
  } >>"$summary"
fi
if [ "$action" = publish ]; then
  echo "::notice::$name@$version is not on npm: will publish"
else
  echo "::notice::${msg//\`/}"
fi
