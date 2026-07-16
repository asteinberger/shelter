#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEST_TMP=$(mktemp -d)
trap 'rm -rf "$TEST_TMP"' EXIT

node --check "$ROOT/ops/check-pr-policy.mjs"
node --check "$ROOT/ops/prepare-release.mjs"
node --check "$ROOT/ops/lib/development-policy.mjs"

REMOTE="$TEST_TMP/remote.git"
REPOSITORY="$TEST_TMP/repository"
git init --quiet --bare "$REMOTE"
git init --quiet --initial-branch=main "$REPOSITORY"
git -C "$REPOSITORY" config user.email shelter-test@example.invalid
git -C "$REPOSITORY" config user.name "Shelter test"
mkdir -p "$REPOSITORY/ops/lib"
cp "$ROOT/ops/check-pr-policy.mjs" "$REPOSITORY/ops/check-pr-policy.mjs"
cp "$ROOT/ops/prepare-release.mjs" "$REPOSITORY/ops/prepare-release.mjs"
cp "$ROOT/ops/lib/development-policy.mjs" "$REPOSITORY/ops/lib/development-policy.mjs"
cat >"$REPOSITORY/package.json" <<'EOF'
{
  "name": "shelter-policy-fixture",
  "version": "0.2.1",
  "private": true,
  "scripts": {
    "check": "node -e \"process.exit(0)\""
  }
}
EOF
cat >"$REPOSITORY/package-lock.json" <<'EOF'
{
  "name": "shelter-policy-fixture",
  "version": "0.2.1",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "shelter-policy-fixture",
      "version": "0.2.1"
    }
  }
}
EOF
git -C "$REPOSITORY" add .
git -C "$REPOSITORY" commit --quiet -m initial
git -C "$REPOSITORY" remote add origin "$REMOTE"
git -C "$REPOSITORY" push --quiet -u origin main
git -C "$REPOSITORY" switch --quiet --create dev
git -C "$REPOSITORY" push --quiet -u origin dev

touch "$REPOSITORY/untracked"
if (cd "$REPOSITORY" && node ops/prepare-release.mjs 0.3.0 --dry-run) >/dev/null 2>&1; then
  echo "release preparation unexpectedly accepted a dirty worktree" >&2
  exit 1
fi
rm "$REPOSITORY/untracked"

(cd "$REPOSITORY" && node ops/prepare-release.mjs 0.3.0 --dry-run) >/dev/null
[[ "$(git -C "$REPOSITORY" branch --show-current)" == "dev" ]]
[[ "$(node -p "require('$REPOSITORY/package.json').version")" == "0.2.1" ]]

(cd "$REPOSITORY" && node ops/prepare-release.mjs 0.3.0) >/dev/null
[[ "$(git -C "$REPOSITORY" branch --show-current)" == "agent/release-0.3.0" ]]
[[ "$(node -p "require('$REPOSITORY/package.json').version")" == "0.3.0" ]]
[[ "$(node -p "require('$REPOSITORY/package-lock.json').packages[''].version")" == "0.3.0" ]]
[[ "$(git -C "$REPOSITORY" diff --name-only | LC_ALL=C sort)" == $'package-lock.json\npackage.json' ]]
[[ "$(git -C "$REPOSITORY" rev-parse dev)" == "$(git -C "$REPOSITORY" rev-parse origin/dev)" ]]

git -C "$REPOSITORY" add package.json package-lock.json
git -C "$REPOSITORY" commit --quiet -m "release: prepare v0.3.0"
release_head=$(git -C "$REPOSITORY" rev-parse HEAD)
dev_base=$(git -C "$REPOSITORY" rev-parse dev)
(cd "$REPOSITORY" && node ops/check-pr-policy.mjs \
  --actor maintainer \
  --base-branch dev \
  --base-ref "$dev_base" \
  --base-repository shelter/shelter \
  --expected-head-sha "$release_head" \
  --head-branch agent/release-0.3.0 \
  --head-ref "$release_head" \
  --head-repository shelter/shelter) >/dev/null
git -C "$REPOSITORY" switch --quiet dev
git -C "$REPOSITORY" merge --quiet --ff-only agent/release-0.3.0
git -C "$REPOSITORY" push --quiet origin dev
dev_head=$(git -C "$REPOSITORY" rev-parse HEAD)
main_base=$(git -C "$REPOSITORY" rev-parse main)
(cd "$REPOSITORY" && node ops/check-pr-policy.mjs \
  --actor maintainer \
  --base-branch main \
  --base-ref "$main_base" \
  --base-repository shelter/shelter \
  --expected-head-sha "$dev_head" \
  --head-branch dev \
  --head-ref "$dev_head" \
  --head-repository shelter/shelter) >/dev/null
git -C "$REPOSITORY" switch --quiet main
git -C "$REPOSITORY" merge --quiet --no-ff dev -m "Merge dev for v0.3.0"
git -C "$REPOSITORY" push --quiet origin main
git -C "$REPOSITORY" switch --quiet dev

# A GitHub-style merge commit on main is not an ancestor of dev, but its tree
# is already represented by the merged dev commit and must permit the next release.
(cd "$REPOSITORY" && node ops/prepare-release.mjs 0.4.0 --dry-run) >/dev/null

git -C "$REPOSITORY" switch --quiet main
printf 'main-only\n' >"$REPOSITORY/main-only-change"
git -C "$REPOSITORY" add main-only-change
git -C "$REPOSITORY" commit --quiet -m "unexpected main-only change"
git -C "$REPOSITORY" push --quiet origin main
git -C "$REPOSITORY" switch --quiet dev
if (cd "$REPOSITORY" && node ops/prepare-release.mjs 0.4.0 --dry-run) >/dev/null 2>&1; then
  echo "release preparation ignored a main-only tree change" >&2
  exit 1
fi
