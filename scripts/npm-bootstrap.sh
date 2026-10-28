#!/usr/bin/env bash
# One-time npm setup for a package that has never been published, so that its first real
# release comes from CI through trusted publishing (OIDC) with provenance, and every later
# release is a tag push with no human step.
#
#   npm run bootstrap:npm              # steps 1-3; one 2FA approval
#   npm run bootstrap:npm -- --cleanup # later, any time: steps 4-5; two 2FA approvals
#   npm run bootstrap:npm -- --dry-run # check everything and print the plan; changes nothing
#   npm run bootstrap:npm -- --from 3  # resume at a step after an interruption
#
# For each 2FA step npm prints an authentication URL and waits. On a machine without a display
# (SSH, a headless box) open that URL on any device; npm notices the approval by itself.
#
# Why the detour: npm attaches a trusted publisher only to a package that exists, and a
# trusted-publisher link is validated only by a publish through it. Publishing the real first
# version by hand would spend its version number, forcing a no-change patch release just to
# validate the link. Instead:
#
#   1. `npm stage publish` a throwaway 0.0.0-bootstrap. This creates the package (npm adds a
#      public 0.0.0-stage placeholder) without publishing anything real.  (no 2FA)
#   2. `npm trust github` links .github/workflows/publish.yml to the package.  (2FA)
#   3. Tag v<version> and push: CI publishes the real first version via OIDC with provenance,
#      which validates the link.
#   4. Reject the staged 0.0.0-bootstrap.  (2FA) Only after step 3: while the throwaway is the
#      package's only version, rejecting it unpublishes the package and its trust link.
#   5. Unpublish the 0.0.0-stage placeholder if it is still there.  (2FA)
#
# Steps 4 and 5 are cleanup and run only with --cleanup. Skipping them is harmless: the staged
# throwaway is visible only to maintainers, and npm never resolves the 0.0.0-stage prerelease
# for `latest` or a normal range.
#
# Steps 1, 3, 4, and 5 check whether they are already done. Step 2 cannot (listing trust links
# needs 2FA too), so resume past it with --from 3 instead of creating a duplicate link.
set -euo pipefail

DRY_RUN=0
FROM=1
CLEANUP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --from) FROM=${2:-}; shift ;;
    --cleanup) CLEANUP=1; FROM=4 ;;
    *) printf 'usage: %s [--dry-run] [--cleanup] [--from <1-5>]\n' "$0" >&2; exit 2 ;;
  esac
  shift
done
[[ "$FROM" =~ ^[1-5]$ ]] || { echo "--from takes a step number from 1 to 5" >&2; exit 2; }
# Resuming inside the cleanup steps means running them.
[ "$FROM" -ge 4 ] && CLEANUP=1
WORKFLOW=publish.yml
BOOT_VERSION=0.0.0-bootstrap
PLACEHOLDER=0.0.0-stage

cd "$(dirname "$0")/.."

say() { printf '\n==> %s\n' "$*"; }
# Enter step $1 (titled $2), or skip it when resuming past it.
STEP=0
step() {
  STEP=$1
  if [ "$1" -lt "$FROM" ]; then say "$1/5 $2: skipped (--from $FROM)"; return 1; fi
  say "$1/5 $2"
}
# On any stop after preflight, say exactly how to resume.
on_exit() {
  local status=$?
  rm -rf "${scratch:-}" "${stage_log:-}"
  if [ "$status" -ne 0 ] && [ "$STEP" -gt 0 ] && [ "$DRY_RUN" = 0 ]; then
    printf '\nStopped in step %s. Resume with: npm run bootstrap:npm -- --from %s\n' "$STEP" "$STEP" >&2
  fi
}
trap on_exit EXIT
trap 'exit 130' INT
note() { printf '    %s\n' "$*"; }
die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }
# Run a command, or only print it in dry-run mode.
act() { if [ "$DRY_RUN" = 1 ]; then printf '    [dry-run] %s\n' "$*"; else "$@"; fi; }
published() { npm view "$1" version >/dev/null 2>&1; }
# Poll until a package spec resolves on the registry (npm processes new versions for a minute or more).
wait_for() {
  local spec=$1 tries=${2:-60}
  for _ in $(seq 1 "$tries"); do published "$spec" && return 0; sleep 10; done
  return 1
}
slug() { sed -E 's#^(git\+)?(https://|ssh://git@|git@)github\.com[:/]##; s#\.git$##' <<<"$1"; }

# ------------------------------------------------------------------ preflight
say "Checking prerequisites"
command -v gh >/dev/null || die "the GitHub CLI (gh) is required"
gh auth status >/dev/null 2>&1 || die "gh is not logged in: run gh auth login"
npm_version=$(npm --version)
node -e 'const [a, b] = process.argv[1].split(".").map(Number); process.exit(a > 11 || (a === 11 && b >= 15) ? 0 : 1)' "$npm_version" \
  || die "npm $npm_version is too old: staged publishing of a new package needs npm 11.15.0 or later"
npm_user=$(npm whoami 2>/dev/null) || die "not logged in to npm: run npm login"
[ "$DRY_RUN" = 1 ] || [ -t 0 ] || die "run this in an interactive terminal: npm asks for 2FA codes"
# Without a display, "Press ENTER to open in the browser" can never succeed. With browser=false
# npm only prints the authentication URL and waits for it to be approved from another device.
headless=0
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ] && [ "$(uname)" != Darwin ]; then
  headless=1
  export npm_config_browser=false
fi

name=$(node -p 'require("./package.json").name')
version=$(node -p 'require("./package.json").version')
repo_url=$(node -p 'const r = require("./package.json").repository; typeof r === "string" ? r : (r && r.url) || ""')
[ "$name" != "pi-package-template" ] || die "the package is still named pi-package-template: run npm run init-package"
[[ "$version" != *-* ]] || die "version $version is a prerelease: set the first release version in package.json"
origin=$(git remote get-url origin)
repo=$(slug "$origin")
[ "$(slug "$repo_url")" = "$repo" ] || die "package.json repository ($repo_url) does not match origin ($origin): run npm run init-package"
[ -f ".github/workflows/$WORKFLOW" ] || die "missing .github/workflows/$WORKFLOW"
environment=$(sed -nE 's/^[[:space:]]*environment:[[:space:]]*([A-Za-z0-9_.-]+)[[:space:]]*$/\1/p' ".github/workflows/$WORKFLOW" | head -1)

[ -z "$(git status --porcelain)" ] || die "the working tree has uncommitted changes"
git fetch -q origin
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$branch" 2>/dev/null || true)" ] || die "HEAD is not pushed to origin/$branch"
tag_exists=0
git ls-remote --exit-code --tags origin "refs/tags/v$version" >/dev/null 2>&1 && tag_exists=1

ci=$(gh run list --workflow ci.yml --branch "$branch" --commit "$(git rev-parse HEAD)" --limit 1 --json status,conclusion -q '.[0] | "\(.status) \(.conclusion)"' 2>/dev/null || true)
[ "$ci" = "completed success" ] || die "CI on $branch at HEAD is not green (${ci:-no run found}); fix it before the first release"

package_exists=0
published "$name" && package_exists=1
if [ "$FROM" -le 3 ] && published "$name@$version"; then
  die "$name@$version is already on npm: this script is for a package's first release (resume later steps with --from 4)"
fi

note "npm user:     $npm_user"
note "package:      $name@$version"
note "repository:   $repo ($branch)"
note "workflow:     .github/workflows/$WORKFLOW${environment:+ (environment: $environment)}"
note "package on npm already: $([ $package_exists = 1 ] && echo yes || echo no)"
[ "$headless" = 1 ] && note "no display: open each npm authentication URL on another device, then wait here"
stage_id_file="$(git rev-parse --git-dir)/npm-bootstrap-stage-id"

# ------------------------------------------------- 1. create the package (staged)
stage_log=$(mktemp)
scratch=$(mktemp -d)
if ! step 1 "Create the package on npm with a staged, throwaway $BOOT_VERSION"; then
  :
elif [ "$package_exists" = 1 ]; then
  note "already exists; skipping"
else
  NAME="$name" VERSION="$BOOT_VERSION" REPO_URL="$repo_url" node -e '
    const fs = require("fs");
    fs.writeFileSync(process.argv[1] + "/package.json", JSON.stringify({
      name: process.env.NAME, version: process.env.VERSION,
      description: "Bootstrap placeholder for trusted publishing. Never approved; not a release.",
      license: "MIT", repository: { type: "git", url: process.env.REPO_URL },
    }, null, 2));
    fs.writeFileSync(process.argv[1] + "/README.md", "Bootstrap placeholder for trusted publishing. Not a release.\n");
  ' "$scratch"
  if [ "$DRY_RUN" = 1 ]; then
    if (cd "$scratch" && npm stage publish --tag bootstrap --access public --dry-run >/dev/null 2>&1); then
      note "npm stage publish --dry-run: ok"
    else
      die "npm stage publish --dry-run failed"
    fi
  else
    (cd "$scratch" && npm stage publish --tag bootstrap --access public 2>&1) | tee "$stage_log"
    # Kept for step 3, so a resumed run still knows what to reject.
    grep -oE 'staged with id [0-9a-f-]+' "$stage_log" | awk '{print $4}' | head -1 > "$stage_id_file" || true
    note "waiting for $name to appear on the registry"
    wait_for "$name" 30 || die "$name did not appear on the registry; check npm stage list $name"
  fi
fi

# --------------------------------------------------------- 2. trusted publisher
trust_args=(github "$name" --file "$WORKFLOW" --repo "$repo" --allow-publish --yes)
[ -n "$environment" ] && trust_args+=(--env "$environment")
if ! step 2 "Link the trusted publisher (npm asks for 2FA)"; then
  :
elif [ "$DRY_RUN" = 1 ]; then
  note "[dry-run] npm trust ${trust_args[*]}"
else
  # Listing links needs 2FA too, so try to create it and let a rerun confirm an existing link.
  if ! npm trust "${trust_args[@]}"; then
    die "npm trust failed. If the link was in fact created, resume with --from 3 to avoid a duplicate"
  fi
fi

# ---------------------------------------------------- 3. first release from CI
if ! step 3 "Tag v$version and let CI publish it through trusted publishing"; then
  :
elif [ "$tag_exists" = 1 ]; then
  note "tag v$version is already on origin; watching its publish run"
else
  act git tag -a "v$version" -m "$name $version"
  act git push origin "v$version"
fi
if [ "$STEP" = 3 ] && [ "$FROM" -le 3 ] && [ "$DRY_RUN" = 0 ]; then
  # Match the run by the tagged commit: the newest run for the tag name can be an older run
  # of an earlier tag with the same name, listed before GitHub registers the new one.
  tag_sha=$(git rev-parse "v$version^{commit}" 2>/dev/null || git ls-remote origin "refs/tags/v$version^{}" | cut -f1)
  run_id=""
  for _ in $(seq 1 30); do
    run_id=$(gh run list --workflow "$WORKFLOW" --branch "v$version" --commit "$tag_sha" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)
    [ -n "$run_id" ] && break
    sleep 5
  done
  [ -n "$run_id" ] || die "no $WORKFLOW run started for v$version"
  gh run watch "$run_id" --exit-status >/dev/null || die "the publish run failed: gh run view $run_id --log-failed"
  note "publish run $run_id succeeded; waiting for npm to finish processing $name@$version"
  wait_for "$name@$version" 60 || die "$name@$version is not visible on the registry after 10 minutes"
fi

# ------------------------------------------------------ 4. reject the staged throwaway
# Only now: while the throwaway is the package's only version, rejecting it unpublishes the
# whole package and its trust link, and npm then blocks the name for 24 hours.
if [ "$CLEANUP" = 0 ]; then
  say "4-5/5 Cleanup skipped; run npm run bootstrap:npm -- --cleanup any time (two 2FA approvals)"
elif step 4 "Reject the staged $BOOT_VERSION (npm asks for 2FA)"; then
if [ "$DRY_RUN" = 0 ] && ! published "$name@$version"; then
  die "$name@$version is not on npm yet; rejecting the throwaway now would delete the package"
fi
stage_id=$(cat "$stage_id_file" 2>/dev/null || true)
[ -n "$stage_id" ] || stage_id=$(NAME="$name" BOOT="$BOOT_VERSION" node -e '
  let input = ""; process.stdin.on("data", d => input += d).on("end", () => {
    try {
      const list = JSON.parse(input);
      const items = Array.isArray(list) ? list : Object.values(list).flat();
      const hit = items.find(item => item && item.version === process.env.BOOT);
      if (hit) console.log(hit.id ?? hit.stage_id ?? hit.stageId ?? "");
    } catch {}
  });' < <(timeout 60 npm stage list "$name" --json </dev/null 2>/dev/null || echo '[]'))
[ -n "$stage_id" ] || stage_id=$(grep -oE 'staged with id [0-9a-f-]+' "$stage_log" | awk '{print $4}' | head -1 || true)
if [ -n "$stage_id" ]; then
  act npm stage reject "$stage_id"
  [ "$DRY_RUN" = 1 ] || rm -f "$stage_id_file"
elif [ "$DRY_RUN" = 1 ] && [ "$package_exists" = 0 ]; then
  note "[dry-run] npm stage reject <id of the $BOOT_VERSION staged in step 1>"
else
  note "no staged $BOOT_VERSION found; skipping"
fi
fi

# ------------------------------------------------------- 5. remove the placeholder
if [ "$CLEANUP" = 0 ]; then
  :
elif ! step 5 "Remove the $PLACEHOLDER placeholder (npm asks for 2FA)"; then
  :
elif [ "$DRY_RUN" = 1 ] || published "$name@$PLACEHOLDER"; then
  act npm unpublish "$name@$PLACEHOLDER"
else
  note "no placeholder; skipping"
fi

# ------------------------------------------------------------------ result
STEP=0
if [ "$DRY_RUN" = 1 ]; then
  say "Dry run complete. Nothing was changed."
  exit 0
fi
say "Done"
# `npm view --json` omits the publisher and attestations, so read the registry document itself.
# shellcheck disable=SC2016 # ${...} below is a JavaScript template literal
curl -fsS "https://registry.npmjs.org/${name/\//%2F}" | VERSION="$version" node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const pkg = JSON.parse(s), v = pkg.versions?.[process.env.VERSION] ?? {};
    const trusted = v._npmUser?.trustedPublisher;
    console.log(`    ${pkg.name}@${process.env.VERSION} (versions on npm: ${Object.keys(pkg.versions ?? {}).join(", ")})`);
    console.log(`    publisher:  ${trusted ? `trusted publisher (${trusted.id})` : `NOT a trusted publisher: ${JSON.stringify(v._npmUser)}`}`);
    console.log(`    provenance: ${v.dist?.attestations?.provenance?.predicateType ?? "missing"}`);
  });'
note "From now on a release is: npm version patch && git push --follow-tags"
