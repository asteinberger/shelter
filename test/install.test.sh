#!/usr/bin/env bash

set -uo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
INSTALL_SHELL=${SHELTER_INSTALL_TEST_SHELL:-$(command -v dash || command -v sh)}
TEST_PASSWORD='correct horse battery staple'
TEST_PASSWORD_B64='Y29ycmVjdCBob3JzZSBiYXR0ZXJ5IHN0YXBsZQ=='
TEST_APP_SECRET='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

passed=0
failed=0

fail_test() {
  printf '       assertion failed: %s\n' "$1" >&2
  exit 1
}

assert_status() {
  local expected=$1
  [ "$INSTALL_STATUS" -eq "$expected" ] || fail_test "expected status ${expected}, got ${INSTALL_STATUS}; output: $(tr '\n' ' ' < "$INSTALL_OUTPUT")"
}

assert_contains() {
  local file=$1
  local text=$2
  grep -Fq -- "$text" "$file" || fail_test "${file} does not contain: ${text}"
}

assert_not_contains() {
  local file=$1
  local text=$2
  if grep -Fq -- "$text" "$file"; then
    fail_test "${file} unexpectedly contains: ${text}"
  fi
}

assert_matches() {
  local file=$1
  local expression=$2
  grep -Eq -- "$expression" "$file" || fail_test "${file} does not match: ${expression}"
}

assert_not_matches() {
  local file=$1
  local expression=$2
  if grep -Eq -- "$expression" "$file"; then
    fail_test "${file} unexpectedly matches: ${expression}"
  fi
}

assert_file_absent() {
  [ ! -e "$1" ] || fail_test "expected no file at $1"
}

assert_command_order() {
  local previous=0
  local command line
  for command in "$@"; do
    line=$(grep -nFx -- "$command" "$MOCK_DOCKER_LOG" | head -n 1 | cut -d: -f1)
    [ -n "$line" ] || fail_test "Docker command was not called: ${command}"
    [ "$line" -gt "$previous" ] || fail_test "Docker command order is wrong at: ${command}"
    previous=$line
  done
}

file_mode() {
  local mode
  mode=$(stat -c '%a' "$1" 2>/dev/null || true)
  case "$mode" in
    ''|*[!0-9]*) stat -f '%Lp' "$1" ;;
    *) printf '%s\n' "$mode" ;;
  esac
}

write_mock_commands() {
  cat > "$MOCK_BIN/uname" <<'EOF'
#!/bin/sh
case "${1:-}" in
  -s) printf 'Linux\n' ;;
  -m) printf 'x86_64\n' ;;
  *) printf 'Linux\n' ;;
esac
EOF

  cat > "$MOCK_BIN/df" <<'EOF'
#!/bin/sh
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf '/dev/mock 104857600 1024 52428800 1%% /\n'
EOF

  cat > "$MOCK_BIN/openssl" <<'EOF'
#!/bin/sh
case "$*" in
  'rand -hex 32')
    printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
    ;;
  'rand -hex 16')
    printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'
    ;;
  'base64 -A')
    cat >/dev/null
    printf 'Y29ycmVjdCBob3JzZSBiYXR0ZXJ5IHN0YXBsZQ=='
    ;;
  'base64 -d -A')
    cat >/dev/null
    printf 'correct horse battery staple'
    ;;
  *)
    printf 'unexpected openssl invocation: %s\n' "$*" >&2
    exit 97
    ;;
esac
EOF

  cat > "$MOCK_BIN/docker" <<'EOF'
#!/bin/sh
set -u

command_line=$*
printf '%s\n' "$command_line" >> "$MOCK_DOCKER_LOG"

if [ -n "${MOCK_DOCKER_FAIL_CONTAINS:-}" ]; then
  case "$command_line" in
    *"$MOCK_DOCKER_FAIL_CONTAINS"*) exit 42 ;;
  esac
fi

next_counter() {
  counter_file=$1
  counter=0
  if [ -f "$counter_file" ]; then
    IFS= read -r counter < "$counter_file" || counter=0
  fi
  counter=$((counter + 1))
  printf '%s\n' "$counter" > "$counter_file"
  printf '%s\n' "$counter"
}

if [ "$#" -eq 6 ] && [ "$1" = compose ] && [ "$2" = up ] && [ "$3" = -d ] && [ "$4" = --force-recreate ] && [ "$5" = --no-deps ] && [ "$6" = api ]; then
  snapshot_number=$(next_counter "$MOCK_STATE_DIR/api-up-count")
  if [ -f "$MOCK_SANDBOX/.env" ]; then
    cp "$MOCK_SANDBOX/.env" "$MOCK_SNAPSHOT_DIR/api-${snapshot_number}.env"
  fi
fi

case "$command_line" in
  info)
    [ "${MOCK_DOCKER_INFO_FAIL:-0}" -eq 0 ]
    ;;
  'compose version')
    [ "${MOCK_COMPOSE_VERSION_FAIL:-0}" -eq 0 ]
    ;;
  'buildx version')
    [ "${MOCK_BUILDX_VERSION_FAIL:-0}" -eq 0 ]
    ;;
  'volume inspect '* )
    [ "${MOCK_VOLUME_EXISTS:-0}" -eq 1 ]
    ;;
  'compose config --quiet'|'compose pull traefik cloudflared'|'compose build --pull api worker'|'compose build api worker'|'compose up -d'|'compose stop -t 60 worker api'|'compose start api worker')
    ;;
  'compose start api'|'compose start worker')
    ;;
  'compose up -d --force-recreate --no-deps api')
    ;;
  'compose ps -q api')
    printf 'api-id\n'
    ;;
  'compose ps -q worker')
    printf 'worker-id\n'
    ;;
  'compose ps -q traefik')
    printf 'traefik-id\n'
    ;;
  'compose ps -q cloudflared')
    if [ "${MOCK_CLOUDFLARED_RUNNING:-0}" -eq 1 ]; then
      printf 'cloudflared-id\n'
    fi
    ;;
  'compose ps api')
    printf 'api-id mock-api running\n'
    ;;
  'compose ps')
    printf 'NAME STATUS\napi-id running\n'
    ;;
  inspect*'{{.State.Running}} api-id')
    printf 'true\n'
    ;;
  inspect*'{{.State.Running}} worker-id')
    printf 'true\n'
    ;;
  inspect*api-id)
    printf '%s\n' "${MOCK_API_HEALTH:-healthy}"
    ;;
  inspect*traefik-id)
    printf '%s\n' "${MOCK_TRAEFIK_HEALTH:-healthy}"
    ;;
  inspect*cloudflared-id)
    printf '%s\n' "${MOCK_CLOUDFLARED_STATE:-true}"
    ;;
  exec\ api-id*)
    [ "${MOCK_WORKER_ONLINE:-1}" -eq 1 ]
    ;;
  run\ --rm*)
    case "$command_line" in
      *:/data:ro*) printf '%s\n' "${MOCK_DATA_STATE:-ready}" ;;
      *) : ;;
    esac
    ;;
  *)
    printf 'unexpected docker invocation: %s\n' "$command_line" >&2
    exit 98
    ;;
esac
EOF

  /bin/chmod +x "$MOCK_BIN/docker" "$MOCK_BIN/openssl" "$MOCK_BIN/uname" "$MOCK_BIN/df"
}

setup_sandbox() {
  TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/shelter-install-test.XXXXXX")
  SANDBOX="$TEST_TMP/shelter"
  CALLER_DIR="$TEST_TMP/caller"
  MOCK_BIN="$TEST_TMP/bin"
  MOCK_STATE_DIR="$TEST_TMP/state"
  MOCK_SNAPSHOT_DIR="$TEST_TMP/snapshots"
  MOCK_DOCKER_LOG="$TEST_TMP/docker.log"
  MOCK_SANDBOX=$SANDBOX
  INSTALL_OUTPUT="$TEST_TMP/output.log"
  mkdir -p "$SANDBOX" "$CALLER_DIR" "$MOCK_BIN" "$MOCK_STATE_DIR" "$MOCK_SNAPSHOT_DIR"
  cp "$REPO_ROOT/install.sh" "$REPO_ROOT/.env.example" "$REPO_ROOT/compose.yaml" "$SANDBOX/"
  : > "$MOCK_DOCKER_LOG"
  : > "$INSTALL_OUTPUT"
  write_mock_commands

  export MOCK_SANDBOX MOCK_STATE_DIR MOCK_SNAPSHOT_DIR MOCK_DOCKER_LOG
  export MOCK_DOCKER_INFO_FAIL=0 MOCK_COMPOSE_VERSION_FAIL=0 MOCK_BUILDX_VERSION_FAIL=0
  export MOCK_VOLUME_EXISTS=0 MOCK_DATA_STATE=ready MOCK_API_HEALTH=healthy
  export MOCK_TRAEFIK_HEALTH=healthy MOCK_WORKER_ONLINE=1 MOCK_CLOUDFLARED_RUNNING=0
  export MOCK_CLOUDFLARED_STATE=true MOCK_DOCKER_FAIL_CONTAINS=
  RUN_CWD=$CALLER_DIR
}

cleanup_sandbox() {
  rm -rf "$TEST_TMP"
}

run_installer() {
  local stdin_value=$1
  shift
  (
    cd "$RUN_CWD" || exit 99
    printf '%s' "$stdin_value" | env \
      PATH="$MOCK_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
      TERM=dumb \
      NO_COLOR=1 \
      SHELTER_INSTALL_HEALTH_ATTEMPTS="${TEST_HEALTH_ATTEMPTS:-2}" \
      SHELTER_INSTALL_HEALTH_INTERVAL="${TEST_HEALTH_INTERVAL:-0}" \
      SHELTER_INSTALL_WORKER_SETTLE_SECONDS=0 \
      "$INSTALL_SHELL" "$SANDBOX/install.sh" "$@"
  ) > "$INSTALL_OUTPUT" 2>&1
  INSTALL_STATUS=$?
}

write_valid_env() {
  local panel_port=${1:-7080}
  cat > "$SANDBOX/.env" <<EOF
ADMIN_EMAIL=admin@example.com
APP_SECRET=${TEST_APP_SECRET}
PANEL_PORT=${panel_port}
SHELTER_DATA_VOLUME=shelter-data
RUNTIME_NETWORK=shelter-runtime
EOF
}

test_posix_syntax() {
  "$INSTALL_SHELL" -n "$REPO_ROOT/install.sh" || fail_test "install.sh does not parse with ${INSTALL_SHELL}"
}

test_help_version_and_argument_errors() {
  run_installer '' --help
  assert_status 0
  assert_contains "$INSTALL_OUTPUT" 'Usage:'
  assert_contains "$INSTALL_OUTPUT" '--password-stdin'
  assert_file_absent "$SANDBOX/.env"

  run_installer '' --version
  assert_status 0
  assert_matches "$INSTALL_OUTPUT" '^0\.[0-9]+\.[0-9]+$'

  run_installer '' --definitely-unknown
  assert_status 2
  assert_contains "$INSTALL_OUTPUT" 'unknown argument'
  [ ! -s "$MOCK_DOCKER_LOG" ] || fail_test 'help/version/argument parsing must not call Docker'
}

test_fresh_noninteractive_install() {
  run_installer "${TEST_PASSWORD}"$'\n' --non-interactive --email admin@example.com --panel-port 7444 --password-stdin
  assert_status 0

  [ -f "$SANDBOX/.env" ] || fail_test '.env was not created'
  [ "$(file_mode "$SANDBOX/.env")" = 600 ] || fail_test '.env mode is not 0600'
  assert_contains "$SANDBOX/.env" 'ADMIN_EMAIL=admin@example.com'
  assert_contains "$SANDBOX/.env" "APP_SECRET=${TEST_APP_SECRET}"
  assert_contains "$SANDBOX/.env" 'PANEL_PORT=7444'
  assert_not_matches "$SANDBOX/.env" '^(ADMIN_PASSWORD|ADMIN_PASSWORD_B64|BOOTSTRAP_PENDING)='
  assert_contains "$INSTALL_OUTPUT" 'Shelter is ready.'
  assert_contains "$INSTALL_OUTPUT" 'http://127.0.0.1:7444'
  assert_contains "$INSTALL_OUTPUT" 'Cloudflare      not configured yet'
  assert_not_contains "$INSTALL_OUTPUT" "$TEST_PASSWORD"
  assert_not_contains "$MOCK_DOCKER_LOG" "$TEST_PASSWORD"
  assert_file_absent "$CALLER_DIR/.env"
  assert_file_absent "$SANDBOX/.shelter-install.lock"
  assert_file_absent "$SANDBOX/.shelter-install.log"

  [ -f "$MOCK_SNAPSHOT_DIR/api-1.env" ] || fail_test "first API environment snapshot is missing; snapshots: $(find "$MOCK_SNAPSHOT_DIR" -maxdepth 1 -type f -print | tr '\n' ' '); Docker: $(tr '\n' ';' < "$MOCK_DOCKER_LOG")"
  [ -f "$MOCK_SNAPSHOT_DIR/api-2.env" ] || fail_test 'credential-free API environment snapshot is missing'
  assert_contains "$MOCK_SNAPSHOT_DIR/api-1.env" 'BOOTSTRAP_PENDING=1'
  assert_contains "$MOCK_SNAPSHOT_DIR/api-1.env" "ADMIN_PASSWORD_B64=${TEST_PASSWORD_B64}"
  assert_not_contains "$MOCK_SNAPSHOT_DIR/api-1.env" "$TEST_PASSWORD"
  assert_not_matches "$MOCK_SNAPSHOT_DIR/api-2.env" '^(ADMIN_PASSWORD|ADMIN_PASSWORD_B64|BOOTSTRAP_PENDING)='

  assert_command_order \
    'compose config --quiet' \
    'compose pull traefik cloudflared' \
    'compose build --pull api worker' \
    'compose up -d --force-recreate --no-deps api' \
    'compose up -d'
}

test_no_pull_uses_cached_build_inputs() {
  run_installer "${TEST_PASSWORD}"$'\n' --non-interactive --email admin@example.com --password-stdin --no-pull
  assert_status 0
  assert_contains "$MOCK_DOCKER_LOG" 'compose build api worker'
  assert_not_contains "$MOCK_DOCKER_LOG" 'compose build --pull api worker'
  assert_not_contains "$MOCK_DOCKER_LOG" 'compose pull traefik cloudflared'
  assert_contains "$INSTALL_OUTPUT" 'Skipped by --no-pull'
}

test_noninteractive_input_validation() {
  run_installer "${TEST_PASSWORD}"$'\n' --non-interactive --password-stdin --no-pull
  assert_status 2
  assert_contains "$INSTALL_OUTPUT" '--email is required for a non-interactive fresh install'
  assert_file_absent "$SANDBOX/.env"

  run_installer "${TEST_PASSWORD}"$'\n' --non-interactive --email invalid --password-stdin --no-pull
  assert_status 1
  assert_contains "$INSTALL_OUTPUT" 'administrator email is invalid'
  assert_file_absent "$SANDBOX/.env"

  run_installer $'too-short\n' --non-interactive --email admin@example.com --password-stdin --no-pull
  assert_status 1
  assert_contains "$INSTALL_OUTPUT" 'password must contain at least 16 characters'
  assert_file_absent "$SANDBOX/.env"
  assert_not_contains "$MOCK_DOCKER_LOG" 'compose up -d'
}

test_preflight_dependency_failures() {
  MOCK_DOCKER_INFO_FAIL=1
  export MOCK_DOCKER_INFO_FAIL
  run_installer '' doctor
  assert_status 1
  assert_contains "$INSTALL_OUTPUT" 'daemon is unavailable'

  MOCK_DOCKER_INFO_FAIL=0
  MOCK_COMPOSE_VERSION_FAIL=1
  export MOCK_DOCKER_INFO_FAIL MOCK_COMPOSE_VERSION_FAIL
  run_installer '' doctor
  assert_status 1
  assert_contains "$INSTALL_OUTPUT" 'Docker Compose v2 is missing'

  MOCK_COMPOSE_VERSION_FAIL=0
  MOCK_BUILDX_VERSION_FAIL=1
  export MOCK_COMPOSE_VERSION_FAIL MOCK_BUILDX_VERSION_FAIL
  run_installer '' doctor
  assert_status 1
  assert_contains "$INSTALL_OUTPUT" 'Docker Buildx is missing'
  assert_file_absent "$SANDBOX/.env"
}

test_doctor_is_non_destructive() {
  run_installer '' doctor
  assert_status 0
  assert_contains "$INSTALL_OUTPUT" 'ready for a new installation'
  assert_file_absent "$SANDBOX/.env"
  assert_not_contains "$MOCK_DOCKER_LOG" 'compose up'

  write_valid_env 7555
  printf '%s\n' 'CUSTOM_VALUE=keep-me' >> "$SANDBOX/.env"
  before_checksum=$(cksum "$SANDBOX/.env")
  run_installer '' doctor
  assert_status 0
  assert_contains "$INSTALL_OUTPUT" 'Docker Compose configuration is valid'
  assert_contains "$INSTALL_OUTPUT" 'http://127.0.0.1:7555'
  [ "$before_checksum" = "$(cksum "$SANDBOX/.env")" ] || fail_test 'doctor changed .env contents'
  actual_mode=$(file_mode "$SANDBOX/.env")
  [ "$actual_mode" = 644 ] || fail_test "doctor changed .env permissions (expected 0644, actual: ${actual_mode})"
  assert_not_contains "$MOCK_DOCKER_LOG" 'compose up'
}

test_health_timeout_can_resume_safely() {
  MOCK_API_HEALTH=starting
  export MOCK_API_HEALTH
  run_installer "${TEST_PASSWORD}"$'\n' --non-interactive --email admin@example.com --password-stdin --no-pull
  assert_status 1
  assert_contains "$INSTALL_OUTPUT" 'API did not become healthy'
  assert_contains "$SANDBOX/.env" 'BOOTSTRAP_PENDING=1'
  assert_contains "$SANDBOX/.env" "ADMIN_PASSWORD_B64=${TEST_PASSWORD_B64}"
  assert_not_contains "$SANDBOX/.env" "$TEST_PASSWORD"
  [ -f "$MOCK_SNAPSHOT_DIR/api-1.env" ] || fail_test "failed first API start was not observed; snapshots: $(find "$MOCK_SNAPSHOT_DIR" -maxdepth 1 -type f -print | tr '\n' ' '); Docker: $(tr '\n' ';' < "$MOCK_DOCKER_LOG")"
  [ ! -f "$MOCK_SNAPSHOT_DIR/api-2.env" ] || fail_test 'installer unexpectedly attempted credential-free restart'

  MOCK_API_HEALTH=healthy
  export MOCK_API_HEALTH
  run_installer '' --non-interactive --no-pull
  assert_status 0
  assert_not_matches "$SANDBOX/.env" '^(ADMIN_PASSWORD|ADMIN_PASSWORD_B64|BOOTSTRAP_PENDING)='
  assert_contains "$INSTALL_OUTPUT" 'Shelter is ready.'
}

test_existing_install_update_is_idempotent() {
  write_valid_env 7666
  printf '%s\n' 'CUSTOM_VALUE=keep-me' >> "$SANDBOX/.env"
  chmod 644 "$SANDBOX/.env"
  before_checksum=$(cksum "$SANDBOX/.env")
  MOCK_VOLUME_EXISTS=1
  MOCK_DATA_STATE=ready
  export MOCK_VOLUME_EXISTS MOCK_DATA_STATE

  run_installer '' --non-interactive --no-pull
  assert_status 0
  [ "$before_checksum" = "$(cksum "$SANDBOX/.env")" ] || fail_test 'update changed existing .env contents'
  [ "$(file_mode "$SANDBOX/.env")" = 600 ] || fail_test 'update did not restrict .env to 0600'
  assert_contains "$SANDBOX/.env" 'CUSTOM_VALUE=keep-me'
  assert_contains "$INSTALL_OUTPUT" 'Mode: update or repair'
  assert_contains "$INSTALL_OUTPUT" 'http://127.0.0.1:7666'
  assert_contains "$MOCK_DOCKER_LOG" 'compose stop -t 60 worker api'
  assert_contains "$MOCK_DOCKER_LOG" 'shelter-before-update.sqlite'
  assert_not_matches "$SANDBOX/.env" '^(ADMIN_PASSWORD|ADMIN_PASSWORD_B64|BOOTSTRAP_PENDING)='
}

test_empty_existing_volume_requires_explicit_bootstrap() {
  write_valid_env 7080
  MOCK_VOLUME_EXISTS=1
  MOCK_DATA_STATE=empty
  export MOCK_VOLUME_EXISTS MOCK_DATA_STATE

  run_installer '' --non-interactive --no-pull
  assert_status 1
  assert_contains "$INSTALL_OUTPUT" 'rerun with --bootstrap-empty-volume'
  assert_not_contains "$MOCK_DOCKER_LOG" 'compose up -d --force-recreate --no-deps api'
  assert_not_matches "$SANDBOX/.env" '^(ADMIN_PASSWORD|ADMIN_PASSWORD_B64|BOOTSTRAP_PENDING)='

  run_installer "${TEST_PASSWORD}"$'\n' --non-interactive --bootstrap-empty-volume --password-stdin --no-pull
  assert_status 0
  assert_contains "$INSTALL_OUTPUT" 'Shelter is ready.'
  assert_not_matches "$SANDBOX/.env" '^(ADMIN_PASSWORD|ADMIN_PASSWORD_B64|BOOTSTRAP_PENDING)='
}

test_invalid_pending_password_can_be_replaced() {
  write_valid_env 7080
  printf '%s\n' 'ADMIN_PASSWORD_B64=not-valid-***' 'BOOTSTRAP_PENDING=1' >> "$SANDBOX/.env"
  MOCK_VOLUME_EXISTS=1
  MOCK_DATA_STATE=empty
  export MOCK_VOLUME_EXISTS MOCK_DATA_STATE

  run_installer "${TEST_PASSWORD}"$'\n' --non-interactive --password-stdin --no-pull
  assert_status 0
  assert_contains "$INSTALL_OUTPUT" 'Existing bootstrap credentials are invalid'
  assert_contains "$INSTALL_OUTPUT" 'Shelter is ready.'
  assert_not_matches "$SANDBOX/.env" '^(ADMIN_PASSWORD|ADMIN_PASSWORD_B64|BOOTSTRAP_PENDING)='
  assert_contains "$MOCK_SNAPSHOT_DIR/api-1.env" "ADMIN_PASSWORD_B64=${TEST_PASSWORD_B64}"
  assert_not_contains "$MOCK_SNAPSHOT_DIR/api-1.env" 'not-valid-***'
}

test_env_validation_and_no_code_execution() {
  write_valid_env 7080
  marker="$TEST_TMP/env-was-sourced"
  printf 'EVIL=$(touch %s)\n' "$marker" >> "$SANDBOX/.env"
  run_installer '' doctor
  assert_status 0
  assert_file_absent "$marker"

  rm -f "$SANDBOX/.env"
  write_valid_env 7080
  printf '%s\n' 'APP_SECRET=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' >> "$SANDBOX/.env"
  run_installer '' doctor
  assert_status 1
  assert_contains "$INSTALL_OUTPUT" 'exactly one APP_SECRET entry'

  rm -f "$SANDBOX/.env"
  write_valid_env 7080
  printf '%s\n' "export ADMIN_PASSWORD_B64=${TEST_PASSWORD_B64}" >> "$SANDBOX/.env"
  run_installer '' doctor
  assert_status 1
  assert_contains "$INSTALL_OUTPUT" 'canonical ADMIN_PASSWORD_B64=... form'

  rm -f "$SANDBOX/.env"
  write_valid_env 7080
  printf '%s\n' 'ADMIN_PASSWORD_B64=not-valid-***' 'BOOTSTRAP_PENDING=1' >> "$SANDBOX/.env"
  run_installer '' doctor
  assert_status 1
  assert_contains "$INSTALL_OUTPUT" 'bootstrap credentials in .env are invalid'

  rm -f "$SANDBOX/.env"
  write_valid_env 7080
  printf '%s\n' "ADMIN_PASSWORD_B64=${TEST_PASSWORD_B64}" 'BOOTSTRAP_PENDING=1' >> "$SANDBOX/.env"
  run_installer '' doctor
  assert_status 0
  assert_contains "$INSTALL_OUTPUT" 'Doctor completed.'
}

test_env_symlink_is_rejected() {
  target="$TEST_TMP/runtime.env"
  write_valid_env 7080
  mv "$SANDBOX/.env" "$target"
  ln -s "$target" "$SANDBOX/.env"
  run_installer '' doctor
  assert_status 1
  assert_contains "$INSTALL_OUTPUT" 'not a symbolic link'
}

test_stage_failure_preserves_resumable_configuration() {
  MOCK_DOCKER_FAIL_CONTAINS='compose pull traefik cloudflared'
  export MOCK_DOCKER_FAIL_CONTAINS
  run_installer "${TEST_PASSWORD}"$'\n' --non-interactive --email admin@example.com --password-stdin
  assert_status 1
  assert_contains "$INSTALL_OUTPUT" 'runtime image download failed'
  assert_contains "$SANDBOX/.env" 'BOOTSTRAP_PENDING=1'
  assert_not_matches "$SANDBOX/.env" '^(ADMIN_PASSWORD|ADMIN_PASSWORD_B64)='
  assert_not_contains "$SANDBOX/.env" "$TEST_PASSWORD"
  assert_file_absent "$SANDBOX/.shelter-install.lock"
  assert_not_contains "$MOCK_DOCKER_LOG" 'compose build'
}

test_failed_update_snapshot_restores_running_services() {
  write_valid_env 7080
  before_checksum=$(cksum "$SANDBOX/.env")
  MOCK_VOLUME_EXISTS=1
  MOCK_DATA_STATE=ready
  MOCK_DOCKER_FAIL_CONTAINS='shelter-before-update.sqlite'
  export MOCK_VOLUME_EXISTS MOCK_DATA_STATE MOCK_DOCKER_FAIL_CONTAINS

  run_installer '' --non-interactive --no-pull
  assert_status 1
  assert_contains "$INSTALL_OUTPUT" 'database snapshot failed'
  assert_contains "$INSTALL_OUTPUT" 'Restoring the API and worker'
  assert_contains "$MOCK_DOCKER_LOG" 'compose stop -t 60 worker api'
  assert_contains "$MOCK_DOCKER_LOG" 'compose start api'
  assert_contains "$MOCK_DOCKER_LOG" 'compose start worker'
  [ "$before_checksum" = "$(cksum "$SANDBOX/.env")" ] || fail_test 'failed update changed existing .env contents'
  assert_not_matches "$SANDBOX/.env" '^(ADMIN_PASSWORD|ADMIN_PASSWORD_B64|BOOTSTRAP_PENDING)='
}

test_active_install_lock_is_respected() {
  mkdir -p "$SANDBOX/.shelter-install.lock"
  printf '%s\n' "$$" > "$SANDBOX/.shelter-install.lock/pid"
  run_installer "${TEST_PASSWORD}"$'\n' --non-interactive --email admin@example.com --password-stdin --no-pull
  assert_status 1
  assert_contains "$INSTALL_OUTPUT" 'another Shelter installer is already running'
  assert_file_absent "$SANDBOX/.env"
  [ -d "$SANDBOX/.shelter-install.lock" ] || fail_test 'active lock was removed'
}

test_deploy_lock_requires_matching_handoff_token() {
  deploy_token='cccccccccccccccccccccccccccccccc'
  mkdir -p "$SANDBOX/.shelter-install.lock"
  printf '%s\n' "$deploy_token" > "$SANDBOX/.shelter-install.lock/owner"
  printf '%s\n' deploy > "$SANDBOX/.shelter-install.lock/kind"

  run_installer "${TEST_PASSWORD}"$'\n' --non-interactive --email admin@example.com --password-stdin --no-pull
  assert_status 1
  assert_contains "$INSTALL_OUTPUT" 'another Shelter deploy operation'
  assert_file_absent "$SANDBOX/.env"

  export SHELTER_INSTALL_LOCK_TOKEN="$deploy_token"
  run_installer "${TEST_PASSWORD}"$'\n' --non-interactive --email admin@example.com --password-stdin --no-pull
  unset SHELTER_INSTALL_LOCK_TOKEN
  assert_status 0
  assert_contains "$INSTALL_OUTPUT" 'Shelter is ready.'
  [ -d "$SANDBOX/.shelter-install.lock" ] || fail_test 'externally managed lock was removed by the installer'
  assert_contains "$SANDBOX/.shelter-install.lock/owner" "$deploy_token"
}

run_test() {
  local name=$1
  local function_name=$2
  printf '  %-62s' "$name"
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

printf 'Shelter installer black-box tests (%s)\n\n' "$INSTALL_SHELL"

run_test 'parses as POSIX shell' test_posix_syntax
run_test 'help, version, and usage errors avoid side effects' test_help_version_and_argument_errors
run_test 'fresh non-interactive install protects bootstrap secrets' test_fresh_noninteractive_install
run_test '--no-pull reuses cached build inputs' test_no_pull_uses_cached_build_inputs
run_test 'non-interactive input is validated before mutation' test_noninteractive_input_validation
run_test 'Docker daemon, Compose, and Buildx failures are actionable' test_preflight_dependency_failures
run_test 'doctor checks configuration without starting services' test_doctor_is_non_destructive
run_test 'API timeout retains a safe resumable bootstrap' test_health_timeout_can_resume_safely
run_test 'existing installation update preserves configuration' test_existing_install_update_is_idempotent
run_test 'empty existing volume needs explicit bootstrap consent' test_empty_existing_volume_requires_explicit_bootstrap
run_test 'invalid pending bootstrap password can be replaced safely' test_invalid_pending_password_can_be_replaced
run_test '.env validation never executes file contents' test_env_validation_and_no_code_execution
run_test '.env symbolic links are rejected' test_env_symlink_is_rejected
run_test 'image-pull failure leaves resumable non-secret state' test_stage_failure_preserves_resumable_configuration
run_test 'failed update snapshot restores prior running services' test_failed_update_snapshot_restores_running_services
run_test 'an active installer lock prevents concurrent mutation' test_active_install_lock_is_respected
run_test 'deploy lock requires an explicit matching handoff token' test_deploy_lock_requires_matching_handoff_token

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
