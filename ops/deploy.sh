#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPOSITORY_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
readonly SERVER_ENV_FILE="${SHELTER_SERVER_ENV_FILE:-${PORTSMITH_SERVER_ENV_FILE:-$REPOSITORY_DIR/.env.server}}"

dry_run=0
sync_only=0
temporary_directory=
control_path=
ssh_target=
remote_operation_lock_acquired=0
remote_operation_lock_q=
remote_operation_lock_token=

usage() {
  cat <<'USAGE'
Usage: ops/deploy.sh [--dry-run] [--sync-only]

Synchronizes the repository to the configured VPS without transferring any
.env file. A normal run then invokes Shelter's installer on the VPS.

Options:
  --dry-run    Show which files rsync would change; do not modify the VPS.
  --sync-only  Synchronize source files, but do not run the remote installer.
  -h, --help   Show this help.

Configuration is read from .env.server by default. Override its path with
SHELTER_SERVER_ENV_FILE. See .env.server.example for the supported values.
USAGE
}

cleanup() {
  if ((remote_operation_lock_acquired)) && [[ -n "$ssh_target" && -n "$remote_operation_lock_q" && -n "$remote_operation_lock_token" ]]; then
    "${ssh_args[@]}" "$ssh_target" "if [ -f $remote_operation_lock_q/owner ] && [ \"\$(cat $remote_operation_lock_q/owner)\" = '$remote_operation_lock_token' ]; then rm -f $remote_operation_lock_q/pid $remote_operation_lock_q/owner $remote_operation_lock_q/kind; rmdir $remote_operation_lock_q; fi" </dev/null >/dev/null 2>&1 || true
  fi
  if [[ -n "$control_path" && -n "$ssh_target" && -S "$control_path" ]]; then
    ssh -S "$control_path" -O exit "$ssh_target" >/dev/null 2>&1 || true
  fi
  if [[ -n "$temporary_directory" ]]; then
    rm -rf -- "$temporary_directory"
  fi
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

file_mode() {
  local file=$1
  if stat -f '%Lp' "$file" >/dev/null 2>&1; then
    stat -f '%Lp' "$file"
  else
    stat -c '%a' "$file"
  fi
}

shell_join() {
  local item joined=
  for item in "$@"; do
    printf -v item '%q' "$item"
    joined+="${joined:+ }$item"
  done
  printf '%s' "$joined"
}

while (($#)); do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --sync-only) sync_only=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "Unknown option: $1" ;;
  esac
  shift
done

[[ -f "$SERVER_ENV_FILE" ]] || fail "$SERVER_ENV_FILE is missing. Copy .env.server.example and configure the VPS."

mode="$(file_mode "$SERVER_ENV_FILE")"
[[ "$mode" =~ ^[0-7]{3,4}$ ]] || fail "Could not verify the file mode of $SERVER_ENV_FILE."
mode="${mode: -3}"
(( (8#$mode & 077) == 0 )) || fail "$SERVER_ENV_FILE is readable by the group or other users. Run 'chmod 600 $SERVER_ENV_FILE'."

# This is a trusted, local shell-format file. It is deliberately separate from
# the application .env consumed by Docker Compose.
# shellcheck disable=SC1090
source "$SERVER_ENV_FILE"

SHELTER_SERVER_HOST="${SHELTER_SERVER_HOST:-${PORTSMITH_SERVER_HOST:-}}"
SHELTER_SERVER_USER="${SHELTER_SERVER_USER:-${PORTSMITH_SERVER_USER:-}}"
SHELTER_SERVER_PATH="${SHELTER_SERVER_PATH:-${PORTSMITH_SERVER_PATH:-}}"
SHELTER_SERVER_PORT="${SHELTER_SERVER_PORT:-${PORTSMITH_SERVER_PORT:-22}}"
SHELTER_SERVER_IDENTITY_FILE="${SHELTER_SERVER_IDENTITY_FILE:-${PORTSMITH_SERVER_IDENTITY_FILE:-}}"
SHELTER_SERVER_PASSWORD="${SHELTER_SERVER_PASSWORD:-${PORTSMITH_SERVER_PASSWORD:-}}"
SHELTER_LEGACY_SERVER_PATH="${SHELTER_LEGACY_SERVER_PATH:-/opt/portsmith}"

: "${SHELTER_SERVER_HOST:?SHELTER_SERVER_HOST is missing from $SERVER_ENV_FILE}"
: "${SHELTER_SERVER_USER:?SHELTER_SERVER_USER is missing from $SERVER_ENV_FILE}"
: "${SHELTER_SERVER_PATH:?SHELTER_SERVER_PATH is missing from $SERVER_ENV_FILE}"
[[ "$SHELTER_SERVER_HOST" =~ ^[A-Za-z0-9:.%-]+$ ]] || fail "SHELTER_SERVER_HOST contains unsupported characters."
[[ "$SHELTER_SERVER_USER" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || fail "SHELTER_SERVER_USER is invalid."
[[ "$SHELTER_SERVER_PORT" =~ ^[0-9]+$ ]] || fail "SHELTER_SERVER_PORT must be numeric."
((SHELTER_SERVER_PORT >= 1 && SHELTER_SERVER_PORT <= 65535)) || fail "SHELTER_SERVER_PORT must be between 1 and 65535."
[[ "$SHELTER_SERVER_PATH" =~ ^/[A-Za-z0-9._/-]+$ && "$SHELTER_SERVER_PATH" != "/" ]] || fail "SHELTER_SERVER_PATH must be a safe absolute path other than /."
[[ "$SHELTER_LEGACY_SERVER_PATH" =~ ^/[A-Za-z0-9._/-]+$ && "$SHELTER_LEGACY_SERVER_PATH" != "/" ]] || fail "SHELTER_LEGACY_SERVER_PATH must be a safe absolute path other than /."

ssh_args=(
  ssh
  -p "$SHELTER_SERVER_PORT"
  -o ConnectTimeout=15
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=3
  -o StrictHostKeyChecking=accept-new
)

if [[ -n "$SHELTER_SERVER_IDENTITY_FILE" ]]; then
  [[ -f "$SHELTER_SERVER_IDENTITY_FILE" ]] || fail "SSH key $SHELTER_SERVER_IDENTITY_FILE is missing."
  ssh_args+=(
    -i "$SHELTER_SERVER_IDENTITY_FILE"
    -o IdentitiesOnly=yes
    -o BatchMode=yes
  )
elif [[ -n "$SHELTER_SERVER_PASSWORD" ]]; then
  temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/shelter-deploy.XXXXXX")"
  chmod 700 "$temporary_directory"
  askpass="$temporary_directory/askpass"
  cat > "$askpass" <<'ASKPASS'
#!/bin/sh
set -eu
# shellcheck disable=SC1090
. "$SHELTER_SERVER_ENV_FILE"
printf '%s\n' "${SHELTER_SERVER_PASSWORD:-${PORTSMITH_SERVER_PASSWORD:?}}"
ASKPASS
  chmod 700 "$askpass"
  export SHELTER_SERVER_ENV_FILE="$SERVER_ENV_FILE"
  export SSH_ASKPASS="$askpass"
  export SSH_ASKPASS_REQUIRE=force
  export DISPLAY="${DISPLAY:-shelter-askpass}"
  control_path="$temporary_directory/ssh-control"
  ssh_args+=(
    -o BatchMode=no
    -o NumberOfPasswordPrompts=1
    -o PreferredAuthentications=password,keyboard-interactive
    -o PubkeyAuthentication=no
    -o ControlMaster=auto
    -o ControlPersist=30
    -o ControlPath="$control_path"
  )
  # The password remains only in the protected file and the current shell's
  # memory; it is never placed in argv or exported to ssh/rsync.
  unset SHELTER_SERVER_PASSWORD PORTSMITH_SERVER_PASSWORD
else
  ssh_args+=(-o BatchMode=yes)
fi

ssh_target="${SHELTER_SERVER_USER}@${SHELTER_SERVER_HOST}"
if [[ "$SHELTER_SERVER_HOST" == *:* ]]; then
  rsync_target="${SHELTER_SERVER_USER}@[${SHELTER_SERVER_HOST}]:${SHELTER_SERVER_PATH}/"
else
  rsync_target="${ssh_target}:${SHELTER_SERVER_PATH}/"
fi

remote_path_q="$(printf '%q' "$SHELTER_SERVER_PATH")"
legacy_path_q="$(printf '%q' "$SHELTER_LEGACY_SERVER_PATH")"
remote_operation_lock_q="$(printf '%q' "$SHELTER_SERVER_PATH/.shelter-install.lock")"
rsync_rsh="$(shell_join "${ssh_args[@]}")"

if ((dry_run)); then
  "${ssh_args[@]}" "$ssh_target" "test -d $remote_path_q && test ! -d $remote_operation_lock_q" </dev/null \
    || fail "The destination is missing or another install/deploy operation is active; --dry-run does not modify the VPS."
else
  "${ssh_args[@]}" "$ssh_target" "mkdir -p $remote_path_q" </dev/null
  command -v openssl >/dev/null 2>&1 || fail "OpenSSL is required to create the remote operation lock."
  remote_operation_lock_token="$(openssl rand -hex 16)"
  if ! "${ssh_args[@]}" "$ssh_target" "if ! mkdir $remote_operation_lock_q; then exit 1; fi; if ! printf '%s\\n' '$remote_operation_lock_token' > $remote_operation_lock_q/owner || ! printf '%s\\n' deploy > $remote_operation_lock_q/kind; then rm -f $remote_operation_lock_q/owner $remote_operation_lock_q/kind; rmdir $remote_operation_lock_q; exit 1; fi" </dev/null; then
    fail "Another Shelter install or deploy operation is active on the VPS. Verify it before removing a stale lock."
  fi
  remote_operation_lock_acquired=1
fi

rsync_args=(
  --archive
  --compress
  --delete
  --human-readable
  --itemize-changes
  --exclude=.git/
  --exclude=.github/
  --exclude=.env
  --exclude='.env.*'
  --exclude='.env*'
  --exclude=.DS_Store
  --exclude='*.log'
  --exclude=.shelter-install.lock/
  --exclude=backups/
  --exclude=node_modules/
  --exclude=dist/
  --exclude=coverage/
  --exclude=data/
  --exclude=traefik/dynamic.yml
  --rsh="$rsync_rsh"
)
((dry_run)) && rsync_args+=(--dry-run)

printf 'Synchronizing Shelter to %s:%s …\n' "$SHELTER_SERVER_HOST" "$SHELTER_SERVER_PATH"
rsync "${rsync_args[@]}" "$REPOSITORY_DIR/" "$rsync_target"

if ((dry_run)); then
  printf 'Dry run completed; nothing was changed on the VPS.\n'
  exit 0
fi

if ((sync_only)); then
  printf 'Source synchronized; the remote installer was not run.\n'
  exit 0
fi

read -r -d '' remote_deploy <<REMOTE || true
set -eu
cd $remote_path_q
if [ -L .env ]; then
  echo 'Error: .env on the VPS must not be a symbolic link.' >&2
  exit 1
fi
if [ ! -e .env ] && [ -L $legacy_path_q/.env ]; then
  echo 'Error: the legacy .env must not be a symbolic link.' >&2
  exit 1
fi
if [ ! -e .env ] && [ -f $legacy_path_q/.env ]; then
  install -m 600 $legacy_path_q/.env .env
  echo 'Copied the existing runtime configuration into the Shelter directory.'
fi
if [ ! -f .env ]; then
  echo 'Error: the application .env is missing on the VPS. Run ./install.sh interactively on the VPS first.' >&2
  exit 1
fi
chmod 600 .env
ensure_volume_mapping() {
  key="\$1"
  preferred="\$2"
  legacy="\$3"
  if ! grep -q "^\${key}=" .env; then
    if docker volume inspect "\$legacy" >/dev/null 2>&1; then
      value="\$legacy"
    else
      value="\$preferred"
    fi
    printf '%s=%s\n' "\$key" "\$value" >> .env
  fi
}
ensure_volume_mapping SHELTER_DATA_VOLUME shelter-data portsmith-data
ensure_volume_mapping SHELTER_ROUTING_VOLUME shelter-routing portsmith-routing
ensure_volume_mapping SHELTER_TUNNEL_VOLUME shelter-tunnel portsmith-tunnel
if ! grep -q '^RUNTIME_NETWORK=' .env; then
  if docker network inspect portsmith-runtime >/dev/null 2>&1; then
    printf '%s\n' 'RUNTIME_NETWORK=portsmith-runtime' >> .env
  else
    printf '%s\n' 'RUNTIME_NETWORK=shelter-runtime' >> .env
  fi
fi
legacy_containers="\$(docker ps -aq --filter label=com.docker.compose.project=portsmith)"
legacy_control_plane_paused=0
legacy_api_was_running=0
legacy_worker_was_running=0
restore_legacy_control_plane() {
  status="\$?"
  trap - EXIT
  if [ "\$legacy_control_plane_paused" -eq 1 ]; then
    shelter_inspection_failed=0
    if ! shelter_api_containers="\$(docker ps -aq --filter label=com.docker.compose.project=shelter --filter label=com.docker.compose.service=api 2>/dev/null)"; then
      shelter_inspection_failed=1
      shelter_api_containers=
    fi
    if ! shelter_worker_containers="\$(docker ps -aq --filter label=com.docker.compose.project=shelter --filter label=com.docker.compose.service=worker 2>/dev/null)"; then
      shelter_inspection_failed=1
      shelter_worker_containers=
    fi
    shelter_control_created=0
    if [ -n "\$shelter_api_containers\$shelter_worker_containers" ]; then
      shelter_control_created=1
      echo 'The Shelter install created a new control plane before failing; stopping every new database writer.' >&2
      for shelter_container in \$shelter_worker_containers \$shelter_api_containers; do
        docker stop -t 60 "\$shelter_container" >/dev/null 2>&1 || docker kill "\$shelter_container" >/dev/null 2>&1 || true
      done
    fi
    if ! running_shelter_api="\$(docker ps -q --filter label=com.docker.compose.project=shelter --filter label=com.docker.compose.service=api 2>/dev/null)"; then
      shelter_inspection_failed=1
      running_shelter_api=
    fi
    if ! running_shelter_worker="\$(docker ps -q --filter label=com.docker.compose.project=shelter --filter label=com.docker.compose.service=worker 2>/dev/null)"; then
      shelter_inspection_failed=1
      running_shelter_worker=
    fi
    running_shelter_writers="\${running_shelter_api}\${running_shelter_worker}"
    if [ "\$shelter_inspection_failed" -eq 1 ]; then
      echo 'Error: the failed installation state could not be inspected. The legacy control plane will remain stopped to prevent concurrent SQLite writers.' >&2
    elif [ -n "\$running_shelter_writers" ]; then
      echo 'Error: a Shelter API or worker is still running. The legacy control plane will remain stopped to prevent concurrent SQLite writers.' >&2
    elif [ "\$shelter_control_created" -eq 1 ]; then
      echo 'The legacy API and worker remain stopped because the database may already be migrated. Rerun the Shelter installer or restore shelter-before-update.sqlite before starting old binaries.' >&2
    else
      echo 'The Shelter install failed before creating a new control plane; restoring the legacy services.' >&2
      if [ "\$legacy_api_was_running" -eq 1 ]; then
        docker compose -p portsmith start api >/dev/null 2>&1 || true
      fi
      if [ "\$legacy_worker_was_running" -eq 1 ]; then
        docker compose -p portsmith start worker >/dev/null 2>&1 || true
      fi
    fi
  fi
  exit "\$status"
}
trap restore_legacy_control_plane EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -n "\$legacy_containers" ]; then
  echo 'Pausing the legacy Portsmith API and worker for a safe one-time migration.'
  if ! legacy_running_api="\$(docker ps -q --filter label=com.docker.compose.project=portsmith --filter label=com.docker.compose.service=api)"; then
    echo 'Error: the legacy API state could not be inspected.' >&2
    exit 1
  fi
  if ! legacy_running_worker="\$(docker ps -q --filter label=com.docker.compose.project=portsmith --filter label=com.docker.compose.service=worker)"; then
    echo 'Error: the legacy worker state could not be inspected.' >&2
    exit 1
  fi
  if [ -n "\$legacy_running_api" ]; then
    legacy_api_was_running=1
  fi
  if [ -n "\$legacy_running_worker" ]; then
    legacy_worker_was_running=1
  fi
  legacy_control_plane_paused=1
  docker compose -p portsmith stop -t 60 worker api
fi
[ -x ./install.sh ] || {
  echo 'Error: install.sh is missing or not executable on the VPS.' >&2
  exit 1
}
SHELTER_INSTALL_LOCK_TOKEN='$remote_operation_lock_token' ./install.sh --non-interactive
if [ -n "\$legacy_containers" ]; then
  legacy_control_plane_paused=0
  echo 'Shelter is healthy; removing the retired Portsmith control-plane containers.'
  # Existing application containers may still use portsmith-runtime. Compose
  # can therefore remove every legacy control-plane container successfully and
  # still return a failure while trying to remove that intentionally preserved
  # network. Re-query and clean only containers that actually remain so the
  # one-time migration stays idempotent.
  docker compose -p portsmith down --remove-orphans || true
  remaining_legacy_containers="\$(docker ps -aq --filter label=com.docker.compose.project=portsmith)"
  if [ -n "\$remaining_legacy_containers" ]; then
    for legacy_container in \$remaining_legacy_containers; do
      docker rm -f "\$legacy_container"
    done
  fi
  docker network rm portsmith-control >/dev/null 2>&1 || true
  remaining_legacy_containers="\$(docker ps -aq --filter label=com.docker.compose.project=portsmith)"
  if [ -n "\$remaining_legacy_containers" ]; then
    echo 'Error: legacy Portsmith control-plane containers are still present; refusing to start a second database writer.' >&2
    exit 1
  fi
fi
trap - EXIT HUP INT TERM
REMOTE

printf 'Running the Shelter installer on the VPS …\n'
"${ssh_args[@]}" "$ssh_target" "$remote_deploy" </dev/null
printf 'Deployment completed.\n'
