#!/usr/bin/env bash

set -uo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
TEST_SHELL=${SHELTER_RELEASE_TEST_SHELL:-$(command -v dash || command -v sh)}
SYSTEM_RSYNC=$(command -v rsync)
TEST_TAG=v1.2.3
TEST_VERSION=1.2.3
TEST_COMMIT=1111111111111111111111111111111111111111
TEST_DIGEST=sha256:2222222222222222222222222222222222222222222222222222222222222222
TEST_MANIFEST_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
TEST_TOKEN=0123456789abcdef0123456789abcdef
TEST_PASSWORD='release-test-password-must-never-appear'

passed=0
failed=0

fail_test() {
  printf '       assertion failed: %s\n' "$1" >&2
  exit 1
}

assert_status() {
  local expected=$1
  [[ "$COMMAND_STATUS" -eq "$expected" ]] ||
    fail_test "expected status ${expected}, got ${COMMAND_STATUS}; output: $(tr '\n' ' ' < "$COMMAND_OUTPUT")"
}

assert_contains() {
  local file=$1
  local expected=$2
  grep -Fq -- "$expected" "$file" || fail_test "${file} does not contain: ${expected}"
}

assert_not_contains() {
  local file=$1
  local unexpected=$2
  if grep -Fq -- "$unexpected" "$file"; then
    fail_test "${file} unexpectedly contains: ${unexpected}"
  fi
}

assert_absent() {
  [[ ! -e "$1" && ! -L "$1" ]] || fail_test "expected no path at $1"
}

setup_sandbox() {
  local temporary_parent=${TMPDIR:-/tmp}
  temporary_parent=${temporary_parent%/}
  TEST_TMP=$(mktemp -d "$temporary_parent/shelter-deploy-release-test.XXXXXX")
  MOCK_BIN=$TEST_TMP/bin
  MOCK_GH_LOG=$TEST_TMP/gh.log
  MOCK_SSH_LOG=$TEST_TMP/ssh.log
  MOCK_RSYNC_LOG=$TEST_TMP/rsync.log
  REMOTE_LOG=$TEST_TMP/remote.log
  COMMAND_OUTPUT=$TEST_TMP/output.log
  SERVER_ENV=$TEST_TMP/server.env
  RELEASE_BUNDLE=$TEST_TMP/release-bundle
  RELEASE_ASSET=$TEST_TMP/shelter-${TEST_TAG}.tar.gz
  mkdir -p "$MOCK_BIN" "$RELEASE_BUNDLE/ops/lib"
  : > "$MOCK_GH_LOG"
  : > "$MOCK_SSH_LOG"
  : > "$MOCK_RSYNC_LOG"
  : > "$REMOTE_LOG"
  : > "$COMMAND_OUTPUT"

  cp "$REPO_ROOT/.env.example" "$RELEASE_BUNDLE/.env.example"
  cp "$REPO_ROOT/compose.yaml" "$RELEASE_BUNDLE/compose.yaml"
  cp "$REPO_ROOT/install.sh" "$RELEASE_BUNDLE/install.sh"
  cp "$REPO_ROOT/ops/create-release-manifest.sh" "$RELEASE_BUNDLE/ops/create-release-manifest.sh"
  cp "$REPO_ROOT/ops/download-release.sh" "$RELEASE_BUNDLE/ops/download-release.sh"
  cp "$REPO_ROOT/ops/install-release-bundle.sh" "$RELEASE_BUNDLE/ops/install-release-bundle.sh"
  cp "$REPO_ROOT/ops/verify-release-bundle.sh" "$RELEASE_BUNDLE/ops/verify-release-bundle.sh"
  cp "$REPO_ROOT/ops/lib/release-bundle.sh" "$RELEASE_BUNDLE/ops/lib/release-bundle.sh"
  chmod 755 "$RELEASE_BUNDLE/install.sh" "$RELEASE_BUNDLE/ops/"*.sh
  "$RELEASE_BUNDLE/ops/create-release-manifest.sh" \
    --bundle "$RELEASE_BUNDLE" \
    --version "$TEST_VERSION" \
    --commit "$TEST_COMMIT" \
    --image-reference "ghcr.io/example/shelter:${TEST_TAG}" \
    --image-digest "$TEST_DIGEST" >/dev/null
  tar -czf "$RELEASE_ASSET" -C "$RELEASE_BUNDLE" .

  cat > "$SERVER_ENV" <<EOF
SHELTER_SERVER_HOST=server.example
SHELTER_SERVER_PORT=22
SHELTER_SERVER_USER=root
SHELTER_SERVER_PATH=/opt/shelter
SHELTER_SERVER_IDENTITY_FILE=
SHELTER_SERVER_PASSWORD='$TEST_PASSWORD'
EOF
  chmod 600 "$SERVER_ENV"

  cat > "$MOCK_BIN/gh" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$MOCK_GH_LOG"
case "$1 ${2:-}" in
  'release verify') exit 0 ;;
  'release verify-asset') exit 0 ;;
  'release download')
    output=
    shift 2
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --output ]; then
        output=$2
        shift
      fi
      shift
    done
    [ -n "$output" ]
    cp "$MOCK_RELEASE_ASSET" "$output"
    ;;
  *) exit 98 ;;
esac
EOF

  cat > "$MOCK_BIN/ssh" <<'EOF'
#!/bin/sh
set -eu
{
  printf 'CALL'
  for argument in "$@"; do printf ' <%s>' "$argument"; done
  printf '\n'
  if [ -n "${SSH_ASKPASS:-}" ]; then
    if stat -f '%Lp' "$SSH_ASKPASS" >/dev/null 2>&1; then
      askpass_mode=$(stat -f '%Lp' "$SSH_ASKPASS")
    else
      askpass_mode=$(stat -c '%a' "$SSH_ASKPASS")
    fi
    printf 'ASKPASS mode=%s require=%s\n' "$askpass_mode" "${SSH_ASKPASS_REQUIRE:-missing}"
  fi
} >> "$MOCK_SSH_LOG"
exit "${MOCK_SSH_STATUS:-0}"
EOF

  cat > "$MOCK_BIN/rsync" <<'EOF'
#!/bin/sh
set -eu
printf 'CALL' >> "$MOCK_RSYNC_LOG"
for argument in "$@"; do printf ' <%s>' "$argument" >> "$MOCK_RSYNC_LOG"; done
printf '\n' >> "$MOCK_RSYNC_LOG"
exit "${MOCK_RSYNC_STATUS:-0}"
EOF

  chmod 755 "$MOCK_BIN/gh" "$MOCK_BIN/ssh" "$MOCK_BIN/rsync"
  export MOCK_BIN MOCK_GH_LOG MOCK_SSH_LOG MOCK_RSYNC_LOG MOCK_RELEASE_ASSET=$RELEASE_ASSET
  export MOCK_SSH_STATUS=0 MOCK_RSYNC_STATUS=0
}

cleanup_sandbox() {
  rm -rf "$TEST_TMP"
}

run_command() {
  set +e
  PATH="$MOCK_BIN:$PATH" "$@" > "$COMMAND_OUTPUT" 2>&1
  COMMAND_STATUS=$?
  set -e
}

run_deployer() {
  run_command "$REPO_ROOT/ops/deploy-release.sh" \
    --server-env "$SERVER_ENV" \
    --repo example/shelter \
    --tag "$TEST_TAG" \
    "$@"
}

test_shell_syntax() {
  bash -n "$REPO_ROOT/ops/deploy.sh"
  bash -n "$REPO_ROOT/ops/deploy-release.sh"
  bash -n "$REPO_ROOT/ops/lib/server-connection.sh"
  "$TEST_SHELL" -n "$REPO_ROOT/ops/lib/deploy-release-remote.sh"
}

test_operator_dry_run_verifies_and_stages_safely() {
  run_deployer --dry-run
  assert_status 0
  assert_contains "$MOCK_GH_LOG" 'release verify v1.2.3 --repo example/shelter'
  assert_contains "$MOCK_GH_LOG" 'release verify-asset v1.2.3'
  assert_contains "$MOCK_RSYNC_LOG" '<-rlpt>'
  assert_contains "$MOCK_RSYNC_LOG" '<--delete>'
  assert_not_contains "$MOCK_RSYNC_LOG" '<--archive>'
  assert_not_contains "$MOCK_RSYNC_LOG" '<--owner>'
  assert_not_contains "$MOCK_RSYNC_LOG" '<--group>'
  assert_contains "$MOCK_SSH_LOG" '<sh -s -- prepare /opt/shelter v1.2.3'
  assert_contains "$MOCK_SSH_LOG" '<sh -s -- activate /opt/shelter v1.2.3'
  assert_contains "$MOCK_SSH_LOG" "${TEST_TAG}"
  assert_contains "$MOCK_SSH_LOG" ' 1>'
  assert_contains "$MOCK_SSH_LOG" '<sh -s -- cleanup /opt/shelter v1.2.3'
  assert_contains "$MOCK_SSH_LOG" 'ASKPASS mode=700 require=force'
  assert_contains "$COMMAND_OUTPUT" 'no release was published or installed'
  assert_not_contains "$COMMAND_OUTPUT" "$TEST_PASSWORD"
  assert_not_contains "$MOCK_GH_LOG" "$TEST_PASSWORD"
  assert_not_contains "$MOCK_SSH_LOG" "$TEST_PASSWORD"
  assert_not_contains "$MOCK_RSYNC_LOG" "$TEST_PASSWORD"
}

test_operator_real_run_requests_install_and_doctor() {
  run_deployer
  assert_status 0
  assert_contains "$MOCK_SSH_LOG" '<sh -s -- activate /opt/shelter v1.2.3'
  assert_contains "$MOCK_SSH_LOG" ' 0>'
  assert_contains "$COMMAND_OUTPUT" 'was installed and doctor completed successfully'
}

test_operator_failure_cleans_remote_stage() {
  MOCK_RSYNC_STATUS=47
  export MOCK_RSYNC_STATUS
  run_deployer
  assert_status 47
  assert_contains "$MOCK_SSH_LOG" '<sh -s -- prepare /opt/shelter v1.2.3'
  assert_contains "$MOCK_SSH_LOG" '<sh -s -- cleanup /opt/shelter v1.2.3'
  assert_not_contains "$MOCK_SSH_LOG" '<sh -s -- activate /opt/shelter v1.2.3'
}

test_operator_rejects_unsafe_inputs_before_network() {
  chmod 644 "$SERVER_ENV"
  run_deployer --dry-run
  assert_status 1
  assert_contains "$COMMAND_OUTPUT" 'readable by the group or other users'
  [[ ! -s "$MOCK_GH_LOG" && ! -s "$MOCK_SSH_LOG" ]] ||
    fail_test 'unsafe server config contacted the network'
  assert_not_contains "$COMMAND_OUTPUT" "$TEST_PASSWORD"

  chmod 600 "$SERVER_ENV"
  run_command "$REPO_ROOT/ops/deploy-release.sh" \
    --server-env "$SERVER_ENV" --repo example/shelter --tag v01.2.3
  assert_status 1
  assert_contains "$COMMAND_OUTPUT" 'canonical vMAJOR.MINOR.PATCH'
}

test_source_deployer_excludes_worktree_git_pointer() {
  run_command env SHELTER_SERVER_ENV_FILE="$SERVER_ENV" \
    "$REPO_ROOT/ops/deploy.sh" --dry-run
  assert_status 0
  assert_contains "$MOCK_RSYNC_LOG" '<--exclude=.git>'
  assert_contains "$MOCK_RSYNC_LOG" '<--exclude=releases/>'
  assert_not_contains "$MOCK_RSYNC_LOG" '<--exclude=.git/>'
  assert_not_contains "$COMMAND_OUTPUT" "$TEST_PASSWORD"
  assert_not_contains "$MOCK_RSYNC_LOG" "$TEST_PASSWORD"

  source_tree=$TEST_TMP/worktree-source
  destination_tree=$TEST_TMP/worktree-destination
  mkdir -p "$source_tree" \
    "$destination_tree/releases/.incoming/v1.2.3-token" \
    "$destination_tree/releases/.deploy-release.lock" \
    "$destination_tree/releases/v1.2.3"
  printf 'gitdir: /Users/operator/private/worktree/.git/worktrees/release\n' > "$source_tree/.git"
  printf 'public payload\n' > "$source_tree/README.md"
  printf 'keep immutable release\n' > "$destination_tree/releases/v1.2.3/release.manifest"
  printf 'keep incoming stage\n' > "$destination_tree/releases/.incoming/v1.2.3-token/release.manifest"
  printf 'keep lock\n' > "$destination_tree/releases/.deploy-release.lock/owner"
  "$SYSTEM_RSYNC" -rlpt --delete --exclude=.git --exclude=releases/ \
    "$source_tree/" "$destination_tree/"
  assert_absent "$destination_tree/.git"
  assert_contains "$destination_tree/README.md" 'public payload'
  assert_contains "$destination_tree/releases/v1.2.3/release.manifest" 'keep immutable release'
  assert_contains "$destination_tree/releases/.incoming/v1.2.3-token/release.manifest" 'keep incoming stage'
  assert_contains "$destination_tree/releases/.deploy-release.lock/owner" 'keep lock'
  if grep -R -Fq -- '/Users/operator/private/worktree' "$destination_tree"; then
    fail_test 'a local worktree path reached the synchronized destination'
  fi
}

mock_remote_commands() {
  cat > "$MOCK_BIN/id" <<'EOF'
#!/bin/sh
[ "${1:-}" = -u ] && { printf '0\n'; exit 0; }
exit 1
EOF
  cat > "$MOCK_BIN/chown" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod 755 "$MOCK_BIN/id" "$MOCK_BIN/chown"
}

populate_remote_stage() {
  local installation=$1
  local token=$2
  local stage=$installation/releases/.incoming/${TEST_TAG}-${token}
  mkdir -p "$stage/ops/lib"
  cat > "$stage/ops/verify-release-bundle.sh" <<'EOF'
#!/bin/sh
set -eu
printf 'verify %s\n' "$*" >> "$REMOTE_LOG"
EOF
  cat > "$stage/ops/install-release-bundle.sh" <<'EOF'
#!/bin/sh
set -eu
printf 'install %s\n' "$*" >> "$REMOTE_LOG"
EOF
  cat > "$stage/ops/lib/release-bundle.sh" <<EOF
shelter_release_load() {
  SHELTER_RELEASE_VERSION=$TEST_VERSION
  SHELTER_RELEASE_MANIFEST_SHA256=$TEST_MANIFEST_SHA
}
EOF
  chmod 755 "$stage/ops/verify-release-bundle.sh" "$stage/ops/install-release-bundle.sh"
}

run_remote_helper() {
  set +e
  {
    cat <<EOF
shelter_release_load() {
  SHELTER_RELEASE_VERSION=$TEST_VERSION
  SHELTER_RELEASE_MANIFEST_SHA256=$TEST_MANIFEST_SHA
}
EOF
    cat "$REPO_ROOT/ops/lib/deploy-release-remote.sh"
  } | PATH="$MOCK_BIN:$PATH" REMOTE_LOG="$REMOTE_LOG" \
    "$TEST_SHELL" -s -- "$@" > "$COMMAND_OUTPUT" 2>&1
  COMMAND_STATUS=$?
  set -e
}

test_remote_helper_publishes_atomically_and_repeats_idempotently() {
  mock_remote_commands
  installation=$TEST_TMP/installation
  mkdir "$installation"
  printf 'APP_SECRET=preserved\n' > "$installation/.env"
  cat > "$installation/install.sh" <<'EOF'
#!/bin/sh
set -eu
printf 'doctor %s\n' "$*" >> "$REMOTE_LOG"
EOF
  chmod 755 "$installation/install.sh"

  run_remote_helper prepare "$installation" "$TEST_TAG" "$TEST_TOKEN" '' 0
  assert_status 0
  incoming=$installation/releases/.incoming
  [[ "$(stat -f '%Lp' "$incoming" 2>/dev/null || stat -c '%a' "$incoming")" = 700 ]] ||
    fail_test 'incoming directory is not mode 0700'
  populate_remote_stage "$installation" "$TEST_TOKEN"
  run_remote_helper activate "$installation" "$TEST_TAG" "$TEST_TOKEN" "$TEST_MANIFEST_SHA" 0
  assert_status 0
  final=$installation/releases/$TEST_TAG
  [[ -d "$final" ]] || fail_test 'release was not atomically published'
  assert_absent "$installation/releases/.incoming/${TEST_TAG}-${TEST_TOKEN}"
  assert_contains "$REMOTE_LOG" 'install --bundle'
  assert_contains "$REMOTE_LOG" '--dry-run -- --non-interactive'
  assert_contains "$REMOTE_LOG" 'doctor doctor'
  run_remote_helper cleanup "$installation" "$TEST_TAG" "$TEST_TOKEN" '' 0
  assert_status 0
  assert_absent "$installation/releases/.deploy-release.lock"

  : > "$REMOTE_LOG"
  run_remote_helper prepare "$installation" "$TEST_TAG" "$TEST_TOKEN" '' 0
  assert_status 0
  populate_remote_stage "$installation" "$TEST_TOKEN"
  run_remote_helper activate "$installation" "$TEST_TAG" "$TEST_TOKEN" "$TEST_MANIFEST_SHA" 0
  assert_status 0
  assert_contains "$COMMAND_OUTPUT" 'Reusing existing verified immutable release'
  assert_contains "$REMOTE_LOG" 'doctor doctor'
  run_remote_helper cleanup "$installation" "$TEST_TAG" "$TEST_TOKEN" '' 0
  assert_status 0
}

test_remote_helper_dry_run_does_not_publish() {
  mock_remote_commands
  installation=$TEST_TMP/installation
  mkdir "$installation"
  printf 'APP_SECRET=preserved\n' > "$installation/.env"
  printf '#!/bin/sh\nexit 99\n' > "$installation/install.sh"
  chmod 755 "$installation/install.sh"

  run_remote_helper prepare "$installation" "$TEST_TAG" "$TEST_TOKEN" '' 0
  assert_status 0
  populate_remote_stage "$installation" "$TEST_TOKEN"
  run_remote_helper activate "$installation" "$TEST_TAG" "$TEST_TOKEN" "$TEST_MANIFEST_SHA" 1
  assert_status 0
  assert_absent "$installation/releases/$TEST_TAG"
  assert_contains "$REMOTE_LOG" '--dry-run -- --non-interactive'
  assert_not_contains "$REMOTE_LOG" 'doctor'
  run_remote_helper cleanup "$installation" "$TEST_TAG" "$TEST_TOKEN" '' 0
  assert_status 0
  assert_absent "$installation/releases/.incoming/${TEST_TAG}-${TEST_TOKEN}"
}

test_remote_helper_rejects_manifest_before_uploaded_code() {
  mock_remote_commands
  installation=$TEST_TMP/installation
  mkdir "$installation"
  printf 'APP_SECRET=preserved\n' > "$installation/.env"
  printf '#!/bin/sh\nexit 99\n' > "$installation/install.sh"
  chmod 755 "$installation/install.sh"

  run_remote_helper prepare "$installation" "$TEST_TAG" "$TEST_TOKEN" '' 0
  assert_status 0
  populate_remote_stage "$installation" "$TEST_TOKEN"
  wrong_manifest_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  run_remote_helper activate "$installation" "$TEST_TAG" "$TEST_TOKEN" "$wrong_manifest_sha" 1
  assert_status 1
  assert_contains "$COMMAND_OUTPUT" 'differs from the locally authenticated bundle'
  [[ ! -s "$REMOTE_LOG" ]] || fail_test 'uploaded verifier or installer ran before manifest identity matched'
  run_remote_helper cleanup "$installation" "$TEST_TAG" "$TEST_TOKEN" '' 0
  assert_status 0
}

run_test() {
  local name=$1
  local function_name=$2
  printf '  %-66s' "$name"
  if (
    setup_sandbox
    trap cleanup_sandbox EXIT
    "$function_name"
  ); then
    printf 'ok\n'
    passed=$((passed + 1))
  else
    printf 'FAILED\n'
    failed=$((failed + 1))
  fi
}

printf 'Shelter verified-release deploy tests (%s)\n\n' "$TEST_SHELL"

run_test 'operator and remote helpers parse with their declared shells' test_shell_syntax
run_test 'dry run authenticates, stages with -rlpt, and redacts secrets' test_operator_dry_run_verifies_and_stages_safely
run_test 'real workflow requests remote activation and doctor' test_operator_real_run_requests_install_and_doctor
run_test 'transport failure cleans its owned remote stage' test_operator_failure_cleans_remote_stage
run_test 'unsafe tags and server configuration fail before network' test_operator_rejects_unsafe_inputs_before_network
run_test 'source deploy excludes clone and worktree .git metadata' test_source_deployer_excludes_worktree_git_pointer
run_test 'remote helper atomically publishes and repeats idempotently' test_remote_helper_publishes_atomically_and_repeats_idempotently
run_test 'remote helper dry run verifies without publishing' test_remote_helper_dry_run_does_not_publish
run_test 'manifest mismatch cannot execute uploaded release code' test_remote_helper_rejects_manifest_before_uploaded_code

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]]
