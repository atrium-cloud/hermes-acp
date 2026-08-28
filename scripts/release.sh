#!/usr/bin/env bash

# Prepare a hermes-acp release: bump the package version, pair it with its
# curated changelog, create a release commit and annotated tag. The tag
# triggers .github/workflows/release.yml, which compiles the six binaries and
# attaches them to the GitHub Release; this script only advances the version
# state and tags.

set -euo pipefail

# Release-policy constants live here so version and Git behavior are not split
# across shell call sites.
readonly DEFAULT_BUMP="patch"
readonly RELEASE_BRANCH="main"
readonly TAG_PREFIX="v"
readonly COMMIT_PREFIX="chore: release v"
readonly SEMVER_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
readonly RELEASE_FILES=(package.json)
readonly CHANGELOG_DIR="docs/changelogs"

usage() {
    cat <<'EOF'
Prepare a hermes-acp release commit and annotated tag.

Usage:
  scripts/release.sh [patch|minor|major|X.Y.Z] [--dry-run] [--push]
  bun run release -- [patch|minor|major|X.Y.Z] [--dry-run] [--push]

The bump defaults to patch. When no release tag exists yet, the package.json
version is released as-is (the initial baseline) instead of being bumped.
A curated changelog must already exist at docs/changelogs/vX.Y.Z.md.
Without --push, the release commit and tag remain local.
EOF
}

fail() {
    printf 'release: error: %s\n' "$*" >&2
    exit 1
}

read_package_version() {
    node -p "require('./package.json').version"
}

write_package_version() {
    local version="$1"
    node -e '
        const fs = require("fs");
        const path = "package.json";
        const source = fs.readFileSync(path, "utf8");
        const updated = source.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${process.argv[1]}$2`);
        if (updated === source) process.exit(1);
        fs.writeFileSync(path, updated);
    ' "$version" || fail "package.json must contain a top-level version"
}

version_is_greater() {
    local candidate="$1"
    local current="$2"
    local candidate_major candidate_minor candidate_patch
    local current_major current_minor current_patch
    IFS=. read -r candidate_major candidate_minor candidate_patch <<<"$candidate"
    IFS=. read -r current_major current_minor current_patch <<<"$current"
    if ((10#$candidate_major != 10#$current_major)); then
        ((10#$candidate_major > 10#$current_major))
    elif ((10#$candidate_minor != 10#$current_minor)); then
        ((10#$candidate_minor > 10#$current_minor))
    else
        ((10#$candidate_patch > 10#$current_patch))
    fi
}

next_version() {
    local current="$1"
    local bump="$2"
    local major minor patch
    IFS=. read -r major minor patch <<<"$current"
    case "$bump" in
        patch) printf '%d.%d.%d\n' "$((10#$major))" "$((10#$minor))" "$((10#$patch + 1))" ;;
        minor) printf '%d.%d.0\n' "$((10#$major))" "$((10#$minor + 1))" ;;
        major) printf '%d.0.0\n' "$((10#$major + 1))" ;;
        *)
            [[ "$bump" =~ $SEMVER_RE ]] || fail "invalid version or bump: $bump"
            version_is_greater "$bump" "$current" \
                || fail "explicit version $bump must be greater than $current"
            printf '%s\n' "$bump"
            ;;
    esac
}

latest_release_tag() {
    local tag
    while IFS= read -r tag; do
        if [[ "${tag#v}" =~ $SEMVER_RE ]]; then
            printf '%s\n' "$tag"
            return 0
        fi
    done < <(git tag --list 'v*' --sort=-version:refname)
    return 1
}

bump=""
do_push=0
dry_run=0
for argument in "$@"; do
    case "$argument" in
        --push) do_push=1 ;;
        --dry-run) dry_run=1 ;;
        -h|--help) usage; exit 0 ;;
        -*) fail "unknown flag: $argument" ;;
        *)
            [[ -z "$bump" ]] || fail "unexpected extra argument: $argument"
            bump="$argument"
            ;;
    esac
done
if [[ "$dry_run" -eq 1 && "$do_push" -eq 1 ]]; then
    fail "--dry-run and --push cannot be combined"
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" \
    || fail "run this script from a Git repository"
cd "$repo_root"

branch="$(git branch --show-current)"
[[ "$branch" == "$RELEASE_BRANCH" ]] \
    || fail "releases must be prepared from $RELEASE_BRANCH (current branch: ${branch:-detached})"
[[ -z "$(git status --porcelain)" ]] \
    || fail "working tree and index must be clean before preparing a release"
git remote get-url origin >/dev/null 2>&1 || fail "origin remote is required"

printf 'release: fetching origin/%s and tags\n' "$RELEASE_BRANCH"
git fetch --quiet --prune --tags origin
remote_ref="refs/remotes/origin/$RELEASE_BRANCH"
git show-ref --verify --quiet "$remote_ref" \
    || fail "origin/$RELEASE_BRANCH does not exist"
start_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse "$remote_ref")"
[[ "$start_head" == "$remote_head" ]] \
    || fail "$RELEASE_BRANCH must be synchronized with origin/$RELEASE_BRANCH"

current_version="$(read_package_version)" \
    || fail "could not read the version from package.json"
[[ "$current_version" =~ $SEMVER_RE ]] \
    || fail "package version must be stable SemVer, got: $current_version"
current_tag="${TAG_PREFIX}${current_version}"

# The first release tags the version already in package.json; every later
# release bumps from the latest tag, which must match package.json.
initial_release=0
if latest_tag="$(latest_release_tag)"; then
    [[ "$latest_tag" == "$current_tag" ]] \
        || fail "latest release tag $latest_tag does not match package version $current_version"
    new_version="$(next_version "$current_version" "${bump:-$DEFAULT_BUMP}")"
else
    [[ -z "$bump" ]] \
        || fail "no release tag exists yet; the initial release takes no bump argument"
    initial_release=1
    new_version="$current_version"
fi
new_tag="${TAG_PREFIX}${new_version}"
if git show-ref --verify --quiet "refs/tags/$new_tag"; then
    fail "tag $new_tag already exists"
fi
[[ -f "${CHANGELOG_DIR}/${new_tag}.md" ]] \
    || fail "missing changelog ${CHANGELOG_DIR}/${new_tag}.md for $new_tag"

commit_created=0
tag_created=0
restore_release_state() {
    local status=$?
    trap - EXIT INT TERM HUP
    if [[ "$tag_created" -eq 1 ]]; then
        git tag --delete "$new_tag" >/dev/null 2>&1 || true
    fi
    if [[ "$commit_created" -eq 1 ]]; then
        git reset --soft "$start_head" >/dev/null 2>&1 || true
    fi
    git restore --staged -- "${RELEASE_FILES[@]}" >/dev/null 2>&1 || true
    git restore --worktree -- "${RELEASE_FILES[@]}" >/dev/null 2>&1 || true
    exit "$status"
}
trap restore_release_state EXIT
trap 'exit 130' INT TERM HUP

if [[ "$initial_release" -eq 1 ]]; then
    printf 'release: preparing initial release %s\n' "$new_version"
else
    printf 'release: preparing %s -> %s\n' "$current_version" "$new_version"
    write_package_version "$new_version"
    git add -- "${RELEASE_FILES[@]}"
fi

# The same gates as the pre-commit hook and CI. The release files are staged
# first so the release commit is exactly what passed.
bun run typecheck
bun run test
bun run build
node dist/index.js --version

if [[ "$dry_run" -eq 1 ]]; then
    if [[ "$initial_release" -eq 1 ]]; then
        printf 'release: dry run passed; would tag HEAD as %s\n' "$new_tag"
    else
        printf 'release: dry run passed; would commit and tag %s\n' "$new_tag"
    fi
    git restore --staged -- "${RELEASE_FILES[@]}"
    git restore --worktree -- "${RELEASE_FILES[@]}"
    trap - EXIT INT TERM HUP
    exit 0
fi

if [[ "$initial_release" -eq 0 ]]; then
    git commit --quiet -m "${COMMIT_PREFIX}${new_version}" -- "${RELEASE_FILES[@]}"
    commit_created=1
fi
git tag -a "$new_tag" -m "${COMMIT_PREFIX}${new_version}"
tag_created=1

# From this point the local commit (if any) and tag are intentional release
# state. A failed network push keeps them available for an explicit retry.
trap - EXIT INT TERM HUP
if [[ "$initial_release" -eq 1 ]]; then
    printf 'release: created annotated tag %s\n' "$new_tag"
else
    printf 'release: created commit and annotated tag %s\n' "$new_tag"
fi
if [[ "$do_push" -eq 1 ]]; then
    if ! git push --atomic origin "$RELEASE_BRANCH" "refs/tags/$new_tag"; then
        printf 'release: push failed; local commit and tag %s were kept for retry\n' "$new_tag" >&2
        exit 1
    fi
    printf 'release: pushed %s and %s\n' "$RELEASE_BRANCH" "$new_tag"
else
    printf 'release: next: git push --atomic origin %s refs/tags/%s\n' \
        "$RELEASE_BRANCH" "$new_tag"
fi
