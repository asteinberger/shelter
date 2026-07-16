#!/usr/bin/env bash

# Shared local operator connection setup. This file is sourced by Bash-based
# deployment helpers; it deliberately never prints credentials or places a
# password in argv/environment inherited by ssh.

shelter_server_file_mode() {
  local file=$1
  if stat -f '%Lp' "$file" >/dev/null 2>&1; then
    stat -f '%Lp' "$file"
  else
    stat -c '%a' "$file"
  fi
}

shelter_server_shell_join() {
  local item joined=
  for item in "$@"; do
    printf -v item '%q' "$item"
    joined+="${joined:+ }$item"
  done
  printf '%s' "$joined"
}

shelter_server_connection_error() {
  printf 'Error: %s\n' "$1" >&2
  return 1
}

shelter_server_connection_init() {
  local requested_env_file=$1
  local temporary_prefix=${2:-shelter-server}
  local env_parent env_name mode askpass

  [[ -f "$requested_env_file" && ! -L "$requested_env_file" ]] ||
    shelter_server_connection_error "$requested_env_file is missing or is not a regular file. Copy .env.server.example and configure the VPS." || return 1

  env_parent=$(cd -- "$(dirname -- "$requested_env_file")" && pwd -P) ||
    shelter_server_connection_error "Could not resolve the directory containing $requested_env_file." || return 1
  env_name=$(basename -- "$requested_env_file")
  SHELTER_SERVER_ENV_FILE_RESOLVED="$env_parent/$env_name"

  mode=$(shelter_server_file_mode "$SHELTER_SERVER_ENV_FILE_RESOLVED") ||
    shelter_server_connection_error "Could not verify the file mode of $SHELTER_SERVER_ENV_FILE_RESOLVED." || return 1
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] ||
    shelter_server_connection_error "Could not verify the file mode of $SHELTER_SERVER_ENV_FILE_RESOLVED." || return 1
  mode="${mode: -3}"
  (( (8#$mode & 077) == 0 )) ||
    shelter_server_connection_error "$SHELTER_SERVER_ENV_FILE_RESOLVED is readable by the group or other users. Run 'chmod 600 $SHELTER_SERVER_ENV_FILE_RESOLVED'." || return 1

  # This is a trusted, local shell-format file. It is deliberately separate
  # from the application .env consumed by Docker Compose.
  # shellcheck disable=SC1090
  source "$SHELTER_SERVER_ENV_FILE_RESOLVED"

  SHELTER_SERVER_HOST="${SHELTER_SERVER_HOST:-${PORTSMITH_SERVER_HOST:-}}"
  SHELTER_SERVER_USER="${SHELTER_SERVER_USER:-${PORTSMITH_SERVER_USER:-}}"
  SHELTER_SERVER_PATH="${SHELTER_SERVER_PATH:-${PORTSMITH_SERVER_PATH:-}}"
  SHELTER_SERVER_PORT="${SHELTER_SERVER_PORT:-${PORTSMITH_SERVER_PORT:-22}}"
  SHELTER_SERVER_IDENTITY_FILE="${SHELTER_SERVER_IDENTITY_FILE:-${PORTSMITH_SERVER_IDENTITY_FILE:-}}"
  SHELTER_SERVER_PASSWORD="${SHELTER_SERVER_PASSWORD:-${PORTSMITH_SERVER_PASSWORD:-}}"

  [[ -n "$SHELTER_SERVER_HOST" ]] || shelter_server_connection_error "SHELTER_SERVER_HOST is missing from $SHELTER_SERVER_ENV_FILE_RESOLVED." || return 1
  [[ -n "$SHELTER_SERVER_USER" ]] || shelter_server_connection_error "SHELTER_SERVER_USER is missing from $SHELTER_SERVER_ENV_FILE_RESOLVED." || return 1
  [[ -n "$SHELTER_SERVER_PATH" ]] || shelter_server_connection_error "SHELTER_SERVER_PATH is missing from $SHELTER_SERVER_ENV_FILE_RESOLVED." || return 1
  [[ "$SHELTER_SERVER_HOST" =~ ^[A-Za-z0-9:.%-]+$ ]] || shelter_server_connection_error "SHELTER_SERVER_HOST contains unsupported characters." || return 1
  [[ "$SHELTER_SERVER_USER" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || shelter_server_connection_error "SHELTER_SERVER_USER is invalid." || return 1
  [[ "$SHELTER_SERVER_PORT" =~ ^[0-9]+$ ]] || shelter_server_connection_error "SHELTER_SERVER_PORT must be numeric." || return 1
  ((SHELTER_SERVER_PORT >= 1 && SHELTER_SERVER_PORT <= 65535)) || shelter_server_connection_error "SHELTER_SERVER_PORT must be between 1 and 65535." || return 1
  [[ "$SHELTER_SERVER_PATH" =~ ^/[A-Za-z0-9._/-]+$ && "$SHELTER_SERVER_PATH" != "/" ]] || shelter_server_connection_error "SHELTER_SERVER_PATH must be a safe absolute path other than /." || return 1
  [[ "$SHELTER_SERVER_PATH" != */ && "$SHELTER_SERVER_PATH" != *//* && "/$SHELTER_SERVER_PATH/" != */./* && "/$SHELTER_SERVER_PATH/" != */../* ]] ||
    shelter_server_connection_error "SHELTER_SERVER_PATH must not contain empty or dot path segments." || return 1
  [[ "$temporary_prefix" =~ ^[A-Za-z0-9._-]+$ ]] || shelter_server_connection_error "The temporary connection prefix is invalid." || return 1

  SHELTER_SERVER_TEMPORARY_DIRECTORY=
  SHELTER_SERVER_CONTROL_PATH=
  SHELTER_SERVER_SSH_ARGS=(
    ssh
    -p "$SHELTER_SERVER_PORT"
    -o ConnectTimeout=15
    -o ServerAliveInterval=15
    -o ServerAliveCountMax=3
    -o StrictHostKeyChecking=accept-new
  )

  if [[ -n "$SHELTER_SERVER_IDENTITY_FILE" ]]; then
    [[ -f "$SHELTER_SERVER_IDENTITY_FILE" ]] || shelter_server_connection_error "SSH key $SHELTER_SERVER_IDENTITY_FILE is missing." || return 1
    SHELTER_SERVER_SSH_ARGS+=(
      -i "$SHELTER_SERVER_IDENTITY_FILE"
      -o IdentitiesOnly=yes
      -o BatchMode=yes
    )
  elif [[ -n "$SHELTER_SERVER_PASSWORD" ]]; then
    SHELTER_SERVER_TEMPORARY_DIRECTORY=$(mktemp -d "${TMPDIR:-/tmp}/${temporary_prefix}.XXXXXX") || return 1
    chmod 700 "$SHELTER_SERVER_TEMPORARY_DIRECTORY"
    askpass="$SHELTER_SERVER_TEMPORARY_DIRECTORY/askpass"
    cat > "$askpass" <<'ASKPASS'
#!/bin/sh
set -eu
# shellcheck disable=SC1090
. "$SHELTER_SERVER_ENV_FILE"
printf '%s\n' "${SHELTER_SERVER_PASSWORD:-${PORTSMITH_SERVER_PASSWORD:?}}"
ASKPASS
    chmod 700 "$askpass"
    export SHELTER_SERVER_ENV_FILE="$SHELTER_SERVER_ENV_FILE_RESOLVED"
    export SSH_ASKPASS="$askpass"
    export SSH_ASKPASS_REQUIRE=force
    export DISPLAY="${DISPLAY:-shelter-askpass}"
    SHELTER_SERVER_CONTROL_PATH="$SHELTER_SERVER_TEMPORARY_DIRECTORY/ssh-control"
    SHELTER_SERVER_SSH_ARGS+=(
      -o BatchMode=no
      -o NumberOfPasswordPrompts=1
      -o PreferredAuthentications=password,keyboard-interactive
      -o PubkeyAuthentication=no
      -o ControlMaster=auto
      -o ControlPersist=30
      -o ControlPath="$SHELTER_SERVER_CONTROL_PATH"
    )
    # The password remains only in the protected file and this shell's memory.
    unset SHELTER_SERVER_PASSWORD PORTSMITH_SERVER_PASSWORD
  else
    SHELTER_SERVER_SSH_ARGS+=(-o BatchMode=yes)
  fi

  SHELTER_SERVER_SSH_TARGET="${SHELTER_SERVER_USER}@${SHELTER_SERVER_HOST}"
  if [[ "$SHELTER_SERVER_HOST" == *:* ]]; then
    SHELTER_SERVER_RSYNC_HOST="${SHELTER_SERVER_USER}@[${SHELTER_SERVER_HOST}]"
  else
    SHELTER_SERVER_RSYNC_HOST="$SHELTER_SERVER_SSH_TARGET"
  fi
  SHELTER_SERVER_RSYNC_RSH=$(shelter_server_shell_join "${SHELTER_SERVER_SSH_ARGS[@]}")
}

shelter_server_connection_cleanup() {
  if [[ -n "${SHELTER_SERVER_CONTROL_PATH:-}" && -n "${SHELTER_SERVER_SSH_TARGET:-}" && -S "$SHELTER_SERVER_CONTROL_PATH" ]]; then
    ssh -S "$SHELTER_SERVER_CONTROL_PATH" -O exit "$SHELTER_SERVER_SSH_TARGET" >/dev/null 2>&1 || true
  fi
  if [[ -n "${SHELTER_SERVER_TEMPORARY_DIRECTORY:-}" ]]; then
    rm -rf -- "$SHELTER_SERVER_TEMPORARY_DIRECTORY"
    SHELTER_SERVER_TEMPORARY_DIRECTORY=
  fi
}
