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

file_mode() {
  local mode
  mode=$(stat -c '%a' "$1" 2>/dev/null || true)
  case "$mode" in
    ''|*[!0-9]*) stat -f '%Lp' "$1" ;;
    *) printf '%s\n' "$mode" ;;
  esac
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
if [ -n "${MOCK_SSH_BLOCK_STATE:-}" ] && [ ! -e "$MOCK_SSH_BLOCK_STATE" ]; then
  : > "$MOCK_SSH_BLOCK_STATE"
  printf '%s\n' "$$" > "$MOCK_SSH_BLOCK_CHILD"
  : > "$MOCK_SSH_BLOCK_READY"
  trap 'exit 129' 1
  trap 'exit 130' 2
  trap 'exit 143' 15
  while :; do
    sleep 1
  done
fi
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
  assert_not_contains "$MOCK_SSH_LOG" '<sh -s -- cleanup /opt/shelter v1.2.3'
  assert_contains "$MOCK_SSH_LOG" 'ASKPASS mode=700 require=force'
  assert_contains "$COMMAND_OUTPUT" 'no release was published or installed'
  assert_not_contains "$COMMAND_OUTPUT" "$TEST_PASSWORD"
  assert_not_contains "$MOCK_GH_LOG" "$TEST_PASSWORD"
  assert_not_contains "$MOCK_SSH_LOG" "$TEST_PASSWORD"
  assert_not_contains "$MOCK_RSYNC_LOG" "$TEST_PASSWORD"
}

test_password_control_socket_ignores_long_tmpdir() {
  long_tmp=$TEST_TMP/$(printf 'long-tmpdir-segment-%.0s' {1..8})
  mkdir -p "$long_tmp"
  run_command env TMPDIR="$long_tmp" \
    "$REPO_ROOT/ops/deploy-release.sh" \
    --server-env "$SERVER_ENV" \
    --repo example/shelter \
    --tag "$TEST_TAG" \
    --dry-run
  assert_status 0

  control_path=$(sed -n 's/.*<ControlPath=\([^>]*\)>.*/\1/p' "$MOCK_SSH_LOG" | head -n 1)
  [[ -n "$control_path" ]] || fail_test 'SSH invocation did not contain a ControlPath'
  case "$control_path" in
    /tmp/shelter-ssh.*/c) ;;
    *) fail_test "ControlPath did not use the compact protected /tmp directory: ${control_path}" ;;
  esac
  [[ "${#control_path}" -le 90 ]] ||
    fail_test "ControlPath is too long for a portable Unix socket: ${#control_path} bytes"
  [[ "$control_path" != "$long_tmp"* ]] ||
    fail_test 'ControlPath inherited the long caller TMPDIR'
  assert_absent "${control_path%/c}"
  assert_not_contains "$COMMAND_OUTPUT" "$TEST_PASSWORD"
  assert_not_contains "$MOCK_SSH_LOG" "$TEST_PASSWORD"
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

assert_deployer_signal_statuses() {
  local deployer=$1
  local signal expected parent child attempt signal_output python
  python=$(command -v python3) || fail_test 'python3 is required for portable signal-disposition tests'
  shift
  while [[ $# -gt 0 ]]; do
    signal=$1
    expected=$2
    shift 2
    block_state=$TEST_TMP/block-${deployer}-${signal}.state
    block_ready=$TEST_TMP/block-${deployer}-${signal}.ready
    block_child=$TEST_TMP/block-${deployer}-${signal}.child
    signal_output=$TEST_TMP/block-${deployer}-${signal}.output
    rm -f "$block_state" "$block_ready" "$block_child"

    set +e
    if [[ "$deployer" == release ]]; then
      PATH="$MOCK_BIN:$PATH" \
      MOCK_SSH_BLOCK_STATE="$block_state" \
      MOCK_SSH_BLOCK_READY="$block_ready" \
      MOCK_SSH_BLOCK_CHILD="$block_child" \
        "$python" -c \
          'import os, signal, sys; [signal.signal(item, signal.SIG_DFL) for item in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)]; os.execvpe(sys.argv[1], sys.argv[1:], os.environ)' \
        "$REPO_ROOT/ops/deploy-release.sh" \
          --server-env "$SERVER_ENV" \
          --repo example/shelter \
          --tag "$TEST_TAG" \
          --dry-run > "$signal_output" 2>&1 &
    else
      PATH="$MOCK_BIN:$PATH" \
      SHELTER_SERVER_ENV_FILE="$SERVER_ENV" \
      MOCK_SSH_BLOCK_STATE="$block_state" \
      MOCK_SSH_BLOCK_READY="$block_ready" \
      MOCK_SSH_BLOCK_CHILD="$block_child" \
        "$python" -c \
          'import os, signal, sys; [signal.signal(item, signal.SIG_DFL) for item in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)]; os.execvpe(sys.argv[1], sys.argv[1:], os.environ)' \
        "$REPO_ROOT/ops/deploy.sh" --dry-run > "$signal_output" 2>&1 &
    fi
    parent=$!
    set -e

    for attempt in {1..200}; do
      [[ -f "$block_ready" && -f "$block_child" ]] && break
      sleep 0.01
    done
    [[ -f "$block_ready" && -f "$block_child" ]] || {
      kill -TERM "$parent" 2>/dev/null || true
      wait "$parent" 2>/dev/null || true
      fail_test "$deployer did not reach the blocking SSH mock"
    }
    child=$(cat "$block_child")
    kill -s "$signal" "$parent" 2>/dev/null ||
      fail_test "could not send $signal to $deployer"
    kill -s "$signal" "$child" 2>/dev/null || true
    for attempt in {1..300}; do
      kill -0 "$parent" 2>/dev/null || break
      sleep 0.01
    done
    if kill -0 "$parent" 2>/dev/null; then
      kill -KILL "$child" "$parent" 2>/dev/null || true
      wait "$parent" 2>/dev/null || true
      fail_test "$deployer did not terminate after $signal"
    fi
    set +e
    wait "$parent"
    COMMAND_STATUS=$?
    set -e
    [[ "$COMMAND_STATUS" -eq "$expected" ]] ||
      fail_test "$deployer swallowed $signal: expected ${expected}, got ${COMMAND_STATUS}; output: $(tr '\n' ' ' < "$signal_output")"
    assert_not_contains "$signal_output" "$TEST_PASSWORD"
  done
}

test_deployer_signals_preserve_exit_status() {
  assert_deployer_signal_statuses release HUP 129 INT 130 TERM 143
  assert_deployer_signal_statuses source HUP 129 INT 130 TERM 143
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
  assert_contains "$MOCK_RSYNC_LOG" '<--exclude=/releases/>'
  assert_not_contains "$MOCK_RSYNC_LOG" '<--exclude=.git/>'
  assert_not_contains "$COMMAND_OUTPUT" "$TEST_PASSWORD"
  assert_not_contains "$MOCK_RSYNC_LOG" "$TEST_PASSWORD"

  source_tree=$TEST_TMP/worktree-source
  destination_tree=$TEST_TMP/worktree-destination
  mkdir -p "$source_tree" \
    "$destination_tree/releases/.incoming/v1.2.3-token" \
    "$destination_tree/releases/v1.2.3" \
    "$source_tree/nested/releases"
  printf 'gitdir: /Users/operator/private/worktree/.git/worktrees/release\n' > "$source_tree/.git"
  printf 'public payload\n' > "$source_tree/README.md"
  printf 'nested application release data\n' > "$source_tree/nested/releases/application.txt"
  printf 'keep immutable release\n' > "$destination_tree/releases/v1.2.3/release.manifest"
  printf 'keep incoming stage\n' > "$destination_tree/releases/.incoming/v1.2.3-token/release.manifest"
  "$SYSTEM_RSYNC" -rlpt --delete --exclude=.git --exclude=/releases/ \
    "$source_tree/" "$destination_tree/"
  assert_absent "$destination_tree/.git"
  assert_contains "$destination_tree/README.md" 'public payload'
  assert_contains "$destination_tree/releases/v1.2.3/release.manifest" 'keep immutable release'
  assert_contains "$destination_tree/releases/.incoming/v1.2.3-token/release.manifest" 'keep incoming stage'
  assert_contains "$destination_tree/nested/releases/application.txt" 'nested application release data'
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
installation=
dry_run=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --installation) installation=$2; shift ;;
    --dry-run) dry_run=1 ;;
  esac
  shift
done
[ -n "$installation" ]
[ -d "$installation/.shelter-install.lock" ]
[ "$(cat "$installation/.shelter-install.lock/owner")" = "$EXPECTED_RELEASE_TOKEN" ]
[ "${SHELTER_RELEASE_INSTALL_LOCK_TOKEN:-}" = "$EXPECTED_RELEASE_TOKEN" ] || [ "$dry_run" -eq 1 ]
if mkdir "$installation/.shelter-install.lock" 2>/dev/null; then
  printf 'source deploy acquired the shared lock during release install\n' >&2
  exit 91
fi
if [ "$dry_run" -eq 0 ]; then
  printf 'release:%s\n' "$EXPECTED_RELEASE_VERSION" > "$installation/current-revision"
fi
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
    EXPECTED_RELEASE_TOKEN="$TEST_TOKEN" EXPECTED_RELEASE_VERSION="$TEST_VERSION" \
    "$TEST_SHELL" -s -- "$@" > "$COMMAND_OUTPUT" 2>&1
  COMMAND_STATUS=$?
  set -e
}

start_remote_helper() {
  local background_output=$1
  shift
  {
    cat <<EOF
shelter_release_load() {
  SHELTER_RELEASE_VERSION=$TEST_VERSION
  SHELTER_RELEASE_MANIFEST_SHA256=$TEST_MANIFEST_SHA
}
EOF
    cat "$REPO_ROOT/ops/lib/deploy-release-remote.sh"
  } | PATH="$MOCK_BIN:$PATH" REMOTE_LOG="$REMOTE_LOG" \
    EXPECTED_RELEASE_TOKEN="$TEST_TOKEN" EXPECTED_RELEASE_VERSION="$TEST_VERSION" \
    "$TEST_SHELL" -s -- "$@" > "$background_output" 2>&1 &
  REMOTE_HELPER_PID=$!
}

test_remote_helper_publishes_atomically_and_repeats_idempotently() {
  mock_remote_commands
  installation=$TEST_TMP/installation
  mkdir "$installation"
  printf 'APP_SECRET=preserved\n' > "$installation/.env"
  cat > "$installation/install.sh" <<'EOF'
#!/bin/sh
set -eu
root=$(CDPATH= cd -P "$(dirname "$0")" >/dev/null 2>&1 && pwd -P)
[ "$1" = doctor ]
[ -d "$root/.shelter-install.lock" ]
[ "$(cat "$root/.shelter-install.lock/owner")" = "0123456789abcdef0123456789abcdef" ]
[ "$(cat "$root/current-revision")" = "release:1.2.3" ]
if mkdir "$root/.shelter-install.lock" 2>/dev/null; then
  printf 'source deploy acquired the shared lock during doctor\n' >&2
  exit 92
fi
if [ "${MOCK_DOCTOR_LEAVE_LOCK_BLOCKER:-0}" -eq 1 ]; then
  : > "$root/.shelter-install.lock/blocker"
fi
printf 'doctor %s\n' "$*" >> "$REMOTE_LOG"
EOF
  chmod 755 "$installation/install.sh"

  run_remote_helper prepare "$installation" "$TEST_TAG" "$TEST_TOKEN" '' 0
  assert_status 0
  incoming=$installation/releases/.incoming
  [[ "$(file_mode "$incoming")" = 700 ]] ||
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
  assert_contains "$installation/current-revision" 'release:1.2.3'
  assert_absent "$installation/.shelter-install.lock"

  : > "$REMOTE_LOG"
  run_remote_helper prepare "$installation" "$TEST_TAG" "$TEST_TOKEN" '' 0
  assert_status 0
  populate_remote_stage "$installation" "$TEST_TOKEN"
  run_remote_helper activate "$installation" "$TEST_TAG" "$TEST_TOKEN" "$TEST_MANIFEST_SHA" 0
  assert_status 0
  assert_contains "$COMMAND_OUTPUT" 'Reusing existing verified immutable release'
  assert_contains "$REMOTE_LOG" 'doctor doctor'
  assert_absent "$installation/.shelter-install.lock"
}

test_remote_helper_surfaces_shared_lock_cleanup_failure() {
  mock_remote_commands
  installation=$TEST_TMP/installation
  mkdir "$installation"
  printf 'APP_SECRET=preserved\n' > "$installation/.env"
  cat > "$installation/install.sh" <<'EOF'
#!/bin/sh
set -eu
root=$(CDPATH= cd -P "$(dirname "$0")" >/dev/null 2>&1 && pwd -P)
[ "$1" = doctor ]
[ -d "$root/.shelter-install.lock" ]
[ "$(cat "$root/current-revision")" = "release:1.2.3" ]
: > "$root/.shelter-install.lock/blocker"
printf 'doctor %s\n' "$*" >> "$REMOTE_LOG"
EOF
  chmod 755 "$installation/install.sh"

  run_remote_helper prepare "$installation" "$TEST_TAG" "$TEST_TOKEN" '' 0
  assert_status 0
  populate_remote_stage "$installation" "$TEST_TOKEN"
  run_remote_helper activate "$installation" "$TEST_TAG" "$TEST_TOKEN" "$TEST_MANIFEST_SHA" 0
  assert_status 1
  assert_contains "$COMMAND_OUTPUT" 'lock contains an unexpected entry'
  assert_contains "$REMOTE_LOG" 'doctor doctor'
  [[ -d "$installation/.shelter-install.lock" ]] ||
    fail_test 'cleanup failure was not left fail-closed'
  rm -f "$installation/.shelter-install.lock/blocker"
  run_remote_helper cleanup "$installation" "$TEST_TAG" "$TEST_TOKEN" '' 0
  assert_status 0
  assert_absent "$installation/.shelter-install.lock"
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
  assert_absent "$installation/.shelter-install.lock"
  assert_absent "$installation/releases/.incoming/${TEST_TAG}-${TEST_TOKEN}"
}

test_remote_cleanup_refuses_live_activation() {
  mock_remote_commands
  installation=$TEST_TMP/installation
  activation_ready=$TEST_TMP/activation.ready
  activation_release=$TEST_TMP/activation.release
  activation_output=$TEST_TMP/activation.output
  mkdir "$installation"
  printf 'APP_SECRET=preserved\n' > "$installation/.env"
  printf '#!/bin/sh\nexit 99\n' > "$installation/install.sh"
  chmod 755 "$installation/install.sh"

  run_remote_helper prepare "$installation" "$TEST_TAG" "$TEST_TOKEN" '' 0
  assert_status 0
  populate_remote_stage "$installation" "$TEST_TOKEN"
  cat > "$installation/releases/.incoming/${TEST_TAG}-${TEST_TOKEN}/ops/install-release-bundle.sh" <<EOF
#!/bin/sh
set -eu
: > "$activation_ready"
trap 'exit 77' 1 2 15
while [ ! -e "$activation_release" ]; do
  sleep 0.02
done
exit 77
EOF
  chmod 755 "$installation/releases/.incoming/${TEST_TAG}-${TEST_TOKEN}/ops/install-release-bundle.sh"

  start_remote_helper "$activation_output" \
    activate "$installation" "$TEST_TAG" "$TEST_TOKEN" "$TEST_MANIFEST_SHA" 0
  for attempt in {1..250}; do
    [[ -f "$activation_ready" ]] && break
    sleep 0.02
  done
  if [[ ! -f "$activation_ready" ]]; then
    kill -TERM "$REMOTE_HELPER_PID" 2>/dev/null || true
    wait "$REMOTE_HELPER_PID" 2>/dev/null || true
    fail_test 'activation did not reach the blocking installer'
  fi

  run_remote_helper cleanup "$installation" "$TEST_TAG" "$TEST_TOKEN" '' 0
  assert_status 1
  assert_contains "$COMMAND_OUTPUT" 'still active'
  [[ -d "$installation/.shelter-install.lock" ]] ||
    fail_test 'cleanup removed the shared lock while activation was alive'

  : > "$activation_release"
  set +e
  wait "$REMOTE_HELPER_PID"
  activation_status=$?
  set -e
  [[ "$activation_status" -ne 0 ]] || fail_test 'the blocked activation unexpectedly succeeded'
  [[ -d "$installation/.shelter-install.lock" ]] ||
    fail_test 'failed activation did not leave the shared lock fail-closed'

  run_remote_helper cleanup "$installation" "$TEST_TAG" "$TEST_TOKEN" '' 0
  assert_status 0
  assert_absent "$installation/.shelter-install.lock"
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
run_test 'password ControlMaster socket stays short with a long TMPDIR' test_password_control_socket_ignores_long_tmpdir
run_test 'real workflow requests remote activation and doctor' test_operator_real_run_requests_install_and_doctor
run_test 'transport failure cleans its owned remote stage' test_operator_failure_cleans_remote_stage
run_test 'blocking SSH preserves HUP, INT, and TERM exit status' test_deployer_signals_preserve_exit_status
run_test 'unsafe tags and server configuration fail before network' test_operator_rejects_unsafe_inputs_before_network
run_test 'source deploy excludes clone and worktree .git metadata' test_source_deployer_excludes_worktree_git_pointer
run_test 'remote helper atomically publishes and repeats idempotently' test_remote_helper_publishes_atomically_and_repeats_idempotently
run_test 'remote helper dry run verifies without publishing' test_remote_helper_dry_run_does_not_publish
run_test 'cleanup cannot unlock a live remote activation' test_remote_cleanup_refuses_live_activation
run_test 'successful doctor still surfaces shared-lock cleanup failure' test_remote_helper_surfaces_shared_lock_cleanup_failure
run_test 'manifest mismatch cannot execute uploaded release code' test_remote_helper_rejects_manifest_before_uploaded_code

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]]
