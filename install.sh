#!/usr/bin/env sh
set -eu

umask 077

INSTALLER_VERSION="0.2.0"
HEALTH_ATTEMPTS=${SHELTER_INSTALL_HEALTH_ATTEMPTS:-90}
HEALTH_INTERVAL=${SHELTER_INSTALL_HEALTH_INTERVAL:-2}
WORKER_SETTLE_SECONDS=${SHELTER_INSTALL_WORKER_SETTLE_SECONDS:-16}

script_dir=$(CDPATH= cd -P "$(dirname "$0")" >/dev/null 2>&1 && pwd)
cd "$script_dir"

mode=install
admin_email_arg=
panel_port_arg=7080
panel_port_given=0
password_stdin=0
non_interactive=0
assume_yes=0
no_color=0
verbose=0
no_pull=0
bootstrap_empty_volume=0

terminal_available=0
terminal_echo_disabled=0
active_pid=
install_lock="$script_dir/.shelter-install.lock"
lock_acquired=0
lock_owner_token=
lock_managed_externally=0
temporary_file=
install_log="$script_dir/.shelter-install.log"
install_log_started=0
control_plane_stopped=0
api_was_running=0
worker_was_running=0
installation_succeeded=0
step_number=0

admin_email=
panel_port=7080
admin_password=
fresh_install=0
bootstrap_needed=0
bootstrap_values_invalid=0
data_state=unknown
data_volume=shelter-data
tunnel_state=pending

reset=''
bold=''
dim=''
green=''
yellow=''
red=''
cyan=''

cleanup() {
  cleanup_status=$?
  trap - 0 1 2 15

  if [ "$terminal_echo_disabled" -eq 1 ]; then
    stty echo </dev/tty 2>/dev/null || true
    terminal_echo_disabled=0
  fi

  if [ -n "$active_pid" ]; then
    kill "$active_pid" 2>/dev/null || true
    wait "$active_pid" 2>/dev/null || true
    active_pid=
  fi

  if [ -n "$temporary_file" ]; then
    rm -f "$temporary_file"
    temporary_file=
  fi

  if [ "$control_plane_stopped" -eq 1 ]; then
    printf '\n%s[WARN]%s Restoring the API and worker to their previous running or stopped state.\n' "$yellow" "$reset" >&2
    if [ "$worker_was_running" -eq 0 ]; then
      docker compose stop -t 30 worker >/dev/null 2>&1 || true
    fi
    if [ "$api_was_running" -eq 0 ]; then
      docker compose stop -t 30 api >/dev/null 2>&1 || true
    fi
    if [ "$api_was_running" -eq 1 ]; then
      docker compose start api >/dev/null 2>&1 || true
    fi
    if [ "$worker_was_running" -eq 1 ]; then
      docker compose start worker >/dev/null 2>&1 || true
    fi
  fi

  if [ "$lock_acquired" -eq 1 ] && [ "$lock_managed_externally" -eq 0 ]; then
    current_lock_owner=
    if [ -f "$install_lock/owner" ]; then
      IFS= read -r current_lock_owner < "$install_lock/owner" || true
    fi
    if [ -n "$lock_owner_token" ] && [ "$current_lock_owner" = "$lock_owner_token" ]; then
      rm -f "$install_lock/pid" "$install_lock/owner" "$install_lock/kind"
      rmdir "$install_lock" 2>/dev/null || true
    fi
  fi

  unset admin_password

  if [ "$install_log_started" -eq 1 ]; then
    if [ "$cleanup_status" -eq 0 ] && [ "$installation_succeeded" -eq 1 ]; then
      rm -f "$install_log"
    elif [ "$cleanup_status" -ne 0 ] && [ -s "$install_log" ]; then
      printf '\n%s[ERROR]%s The last command failed. Full output: %s\n' "$red" "$reset" "$install_log" >&2
    elif [ "$cleanup_status" -ne 0 ]; then
      rm -f "$install_log"
    fi
  fi

  exit "$cleanup_status"
}

trap cleanup 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15

usage() {
  cat <<'EOF'
Shelter installer

Usage:
  ./install.sh [install] [options]
  ./install.sh doctor [options]

Commands:
  install                      Install, resume, or update Shelter (default)
  doctor                       Run read-only server and configuration checks

Options:
  --email EMAIL                Initial administrator email (fresh installs only)
  --panel-port PORT            Loopback panel port (default: 7080)
  --password-stdin             Read the initial password from standard input
  --bootstrap-empty-volume     Explicitly bootstrap an empty existing data volume
  --non-interactive            Never prompt; implies --yes
  --yes                        Accept the installation summary without prompting
  --no-pull                    Reuse locally cached base and runtime images
  --verbose                    Stream Docker output instead of showing compact progress
  --no-color                   Disable ANSI colors (NO_COLOR is also respected)
  --version                    Print the installer version
  -h, --help                   Show this help

Examples:
  ./install.sh
  ./install.sh doctor
  ./install.sh --non-interactive --email admin@example.com \
    --panel-port 7080 --password-stdin < /run/secrets/shelter-admin-password

Passwords are never accepted as command-line arguments or environment variables.
EOF
}

usage_error() {
  printf 'Error: %s\n\n' "$1" >&2
  usage >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    install|doctor)
      mode=$1
      ;;
    --email)
      [ "$#" -ge 2 ] || usage_error "--email requires a value"
      admin_email_arg=$2
      shift
      ;;
    --email=*)
      admin_email_arg=${1#*=}
      ;;
    --panel-port)
      [ "$#" -ge 2 ] || usage_error "--panel-port requires a value"
      panel_port_arg=$2
      panel_port_given=1
      shift
      ;;
    --panel-port=*)
      panel_port_arg=${1#*=}
      panel_port_given=1
      ;;
    --password-stdin)
      password_stdin=1
      ;;
    --bootstrap-empty-volume)
      bootstrap_empty_volume=1
      ;;
    --non-interactive)
      non_interactive=1
      assume_yes=1
      ;;
    --yes|-y)
      assume_yes=1
      ;;
    --no-pull)
      no_pull=1
      ;;
    --verbose)
      verbose=1
      ;;
    --no-color)
      no_color=1
      ;;
    --version)
      printf '%s\n' "$INSTALLER_VERSION"
      exit 0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage_error "unknown argument: $1"
      ;;
  esac
  shift
done

if [ "$mode" = doctor ]; then
  [ -z "$admin_email_arg" ] || usage_error "--email is only available for installation"
  [ "$panel_port_given" -eq 0 ] || usage_error "--panel-port is only available for installation"
  [ "$password_stdin" -eq 0 ] || usage_error "--password-stdin is only available for installation"
  [ "$bootstrap_empty_volume" -eq 0 ] || usage_error "--bootstrap-empty-volume is only available for installation"
fi

if [ -r /dev/tty ] && [ -w /dev/tty ] && (: </dev/tty) 2>/dev/null; then
  terminal_available=1
fi

if [ "$no_color" -eq 0 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ] && [ -t 1 ]; then
  esc=$(printf '\033')
  reset="${esc}[0m"
  bold="${esc}[1m"
  dim="${esc}[2m"
  green="${esc}[32m"
  yellow="${esc}[33m"
  red="${esc}[31m"
  cyan="${esc}[36m"
fi

print_banner() {
  printf '\n%s' "$green"
  printf '       @..@\n'
  printf '      (----)\n'
  printf '     ( >__< )\n'
  printf '     ^^ ~~ ^^\n'
  printf '%s%sShelter%s\n' "$reset" "$bold" "$reset"
  printf '%sgive your code a home%s\n\n' "$dim" "$reset"
}

heading() {
  step_number=$((step_number + 1))
  printf '\n%s[%02d]%s %s%s%s\n' "$cyan" "$step_number" "$reset" "$bold" "$1" "$reset"
}

ok() {
  printf '     %s[OK]%s %s\n' "$green" "$reset" "$1"
}

note() {
  printf '     %s[--]%s %s\n' "$dim" "$reset" "$1"
}

warn() {
  printf '     %s[WARN]%s %s\n' "$yellow" "$reset" "$1" >&2
}

fail() {
  printf '     %s[ERROR]%s %s\n' "$red" "$reset" "$1" >&2
}

die() {
  fail "$1"
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    die "$2"
  fi
}

validate_email() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
}

validate_port() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] 2>/dev/null && [ "$1" -le 65535 ] 2>/dev/null
}

validate_positive_integer() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -gt 0 ] 2>/dev/null
}

validate_non_negative_integer() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 0 ] 2>/dev/null
}

env_value() {
  env_key=$1
  awk -v key="$env_key" '
    index($0, key "=") == 1 {
      value = substr($0, length(key) + 2)
      if (value ~ /^".*"$/ || value ~ /^'"'"'.*'"'"'$/) {
        value = substr(value, 2, length(value) - 2)
      }
      print value
      exit
    }
  ' .env
}

env_key_count() {
  env_key=$1
  awk -v key="$env_key" 'index($0, key "=") == 1 { count += 1 } END { print count + 0 }' .env
}

validate_env_file() {
  if [ -L .env ]; then
    die ".env must be a regular file, not a symbolic link"
  fi
  if [ ! -f .env ]; then
    die ".env exists but is not a regular file"
  fi

  noncanonical_key=$(awk '
    BEGIN {
      count = split("ADMIN_EMAIL APP_SECRET PANEL_PORT SHELTER_DATA_VOLUME DOCKER_SOCKET ADMIN_PASSWORD ADMIN_PASSWORD_B64 BOOTSTRAP_PENDING", keys, " ")
    }
    {
      raw = $0
      normalized = $0
      sub(/^[[:space:]]*/, "", normalized)
      sub(/^export[[:space:]]+/, "", normalized)
      for (index_key = 1; index_key <= count; index_key += 1) {
        key = keys[index_key]
        if (normalized ~ ("^" key "[[:space:]]*=") && index(raw, key "=") != 1) {
          print key
          exit
        }
      }
    }
  ' .env)
  [ -z "$noncanonical_key" ] || die ".env must use the canonical ${noncanonical_key}=... form without export, indentation, or spaces around ="

  for env_required_key in ADMIN_EMAIL APP_SECRET PANEL_PORT; do
    env_required_count=$(env_key_count "$env_required_key")
    [ "$env_required_count" -eq 1 ] || die ".env must contain exactly one ${env_required_key} entry"
  done

  for env_optional_key in ADMIN_PASSWORD ADMIN_PASSWORD_B64 BOOTSTRAP_PENDING; do
    env_optional_count=$(env_key_count "$env_optional_key")
    [ "$env_optional_count" -le 1 ] || die ".env contains duplicate ${env_optional_key} entries"
  done

  configured_email=$(env_value ADMIN_EMAIL)
  validate_email "$configured_email" || die "ADMIN_EMAIL in .env is invalid"

  configured_secret=$(env_value APP_SECRET)
  [ "${#configured_secret}" -ge 32 ] || die "APP_SECRET in .env must contain at least 32 characters"
  case "$configured_secret" in
    local-development-secret-change-me-please|replace-with-64-random-hex-characters)
      die "APP_SECRET in .env is still a placeholder"
      ;;
  esac

  configured_port=$(env_value PANEL_PORT)
  validate_port "$configured_port" || die "PANEL_PORT in .env must be between 1 and 65535"

  configured_volume=$(env_value SHELTER_DATA_VOLUME)
  if [ -n "$configured_volume" ]; then
    case "$configured_volume" in
      [A-Za-z0-9]*) ;;
      *) die "SHELTER_DATA_VOLUME in .env must start with a letter or number" ;;
    esac
    case "$configured_volume" in
      *[!A-Za-z0-9_.-]*) die "SHELTER_DATA_VOLUME in .env is invalid" ;;
    esac
  fi

  bootstrap_values_invalid=0
  configured_bootstrap_pending=$(env_value BOOTSTRAP_PENDING)
  configured_plain_password=$(env_value ADMIN_PASSWORD)
  configured_encoded_password=$(env_value ADMIN_PASSWORD_B64)
  if [ -n "$configured_bootstrap_pending" ] && [ "$configured_bootstrap_pending" != 1 ]; then
    bootstrap_values_invalid=1
  elif [ -n "$configured_plain_password" ] && [ -n "$configured_encoded_password" ]; then
    bootstrap_values_invalid=1
  elif [ -n "$configured_plain_password" ] && [ "${#configured_plain_password}" -lt 16 ]; then
    bootstrap_values_invalid=1
  elif [ -n "$configured_encoded_password" ]; then
    if ! printf '%s' "$configured_encoded_password" | grep -Eq '^[A-Za-z0-9+/]+={0,2}$' || [ $(( ${#configured_encoded_password} % 4 )) -ne 0 ]; then
      bootstrap_values_invalid=1
    elif ! decoded_bootstrap_password=$(printf '%s' "$configured_encoded_password" | openssl base64 -d -A 2>/dev/null); then
      bootstrap_values_invalid=1
    elif [ "${#decoded_bootstrap_password}" -lt 16 ]; then
      bootstrap_values_invalid=1
    fi
  fi
  unset configured_bootstrap_pending configured_plain_password configured_encoded_password decoded_bootstrap_password

  if [ "$bootstrap_values_invalid" -eq 1 ]; then
    if [ "$mode" = install ] && [ "$password_stdin" -eq 1 ]; then
      warn "Existing bootstrap credentials are invalid; --password-stdin will replace them if this data volume still needs an administrator"
    else
      die "bootstrap credentials in .env are invalid; use --password-stdin to replace them during an installer resume"
    fi
  fi
}

check_env_permissions() {
  env_mode=$(stat -c '%a' .env 2>/dev/null || true)
  if [ "$env_mode" = 600 ]; then
    ok ".env permissions are restricted to mode 0600"
  else
    warn ".env has mode ${env_mode:-unknown}; run chmod 600 .env"
  fi
}

set_env_value() {
  set_key=$1
  set_value=$2
  temporary_file=$(mktemp "$script_dir/.env.tmp.XXXXXX")
  chmod 600 "$temporary_file"
  if ! awk -v key="$set_key" -v value="$set_value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 {
      if (!found) print key "=" value
      found = 1
      next
    }
    { print }
    END { if (!found) print key "=" value }
  ' .env > "$temporary_file"; then
    return 1
  fi
  mv "$temporary_file" .env
  temporary_file=
  chmod 600 .env
}

rewrite_env_without() {
  excluded_pattern=$1
  temporary_file=$(mktemp "$script_dir/.env.tmp.XXXXXX")
  chmod 600 "$temporary_file"
  if ! awk -v excluded_pattern="$excluded_pattern" '$0 !~ excluded_pattern { print }' .env > "$temporary_file"; then
    return 1
  fi
  mv "$temporary_file" .env
  temporary_file=
  chmod 600 .env
}

create_env_file() {
  generated_secret=$(openssl rand -hex 32)
  temporary_file=$(mktemp "$script_dir/.env.tmp.XXXXXX")
  chmod 600 "$temporary_file"
  if ! awk -v email="$admin_email" -v secret="$generated_secret" -v panel_port="$panel_port" '
    /^ADMIN_EMAIL=/ { print "ADMIN_EMAIL=" email; next }
    /^APP_SECRET=/ { print "APP_SECRET=" secret; next }
    /^PANEL_PORT=/ { print "PANEL_PORT=" panel_port; next }
    { print }
    END { print ""; print "BOOTSTRAP_PENDING=1" }
  ' .env.example > "$temporary_file"; then
    return 1
  fi
  if [ -e .env ] || [ -L .env ]; then
    die ".env appeared while the installer was running; no file was replaced"
  fi
  mv "$temporary_file" .env
  temporary_file=
  chmod 600 .env
  unset generated_secret
}

prompt_line() {
  prompt_label=$1
  prompt_default=$2
  if [ "$terminal_available" -ne 1 ]; then
    die "interactive input requires a TTY; use --non-interactive"
  fi
  if [ -n "$prompt_default" ]; then
    printf '     %s [%s]: ' "$prompt_label" "$prompt_default" >/dev/tty
  else
    printf '     %s: ' "$prompt_label" >/dev/tty
  fi
  prompt_value=
  IFS= read -r prompt_value </dev/tty || die "input ended unexpectedly"
  if [ -z "$prompt_value" ]; then
    prompt_value=$prompt_default
  fi
}

prompt_secret() {
  prompt_label=$1
  [ "$terminal_available" -eq 1 ] || die "password input requires a TTY or --password-stdin"
  printf '     %s: ' "$prompt_label" >/dev/tty
  stty -echo </dev/tty
  terminal_echo_disabled=1
  prompt_secret_value=
  IFS= read -r prompt_secret_value </dev/tty || {
    stty echo </dev/tty 2>/dev/null || true
    terminal_echo_disabled=0
    printf '\n' >/dev/tty
    die "password input ended unexpectedly"
  }
  stty echo </dev/tty
  terminal_echo_disabled=0
  printf '\n' >/dev/tty
}

read_password_from_stdin() {
  admin_password=
  if ! IFS= read -r admin_password; then
    [ -n "$admin_password" ] || die "--password-stdin did not receive a password"
  fi
  [ "${#admin_password}" -ge 16 ] || die "the administrator password must contain at least 16 characters"
}

prompt_initial_password() {
  password_attempt=1
  while [ "$password_attempt" -le 3 ]; do
    prompt_secret "Administrator password (16+ characters)"
    first_password=$prompt_secret_value
    if [ "${#first_password}" -lt 16 ]; then
      warn "The password is too short"
      unset first_password prompt_secret_value
      password_attempt=$((password_attempt + 1))
      continue
    fi
    prompt_secret "Confirm administrator password"
    second_password=$prompt_secret_value
    if [ "$first_password" = "$second_password" ]; then
      admin_password=$first_password
      unset first_password second_password prompt_secret_value
      return 0
    fi
    warn "The passwords do not match"
    unset first_password second_password prompt_secret_value
    password_attempt=$((password_attempt + 1))
  done
  die "password confirmation failed three times"
}

confirm_installation() {
  [ "$assume_yes" -eq 1 ] && return 0
  [ "$terminal_available" -eq 1 ] || die "confirmation requires a TTY; use --yes or --non-interactive"
  printf '     Continue? [Y/n]: ' >/dev/tty
  confirmation=
  IFS= read -r confirmation </dev/tty || die "confirmation input ended unexpectedly"
  case "$confirmation" in
    ''|y|Y|yes|YES|Yes) return 0 ;;
    *)
      note "Nothing was changed"
      installation_succeeded=1
      exit 0
      ;;
  esac
}

acquire_install_lock() {
  if [ -L "$install_lock" ]; then
    die "installer lock must not be a symbolic link: ${install_lock}"
  fi
  if [ -e "$install_lock" ] && [ ! -d "$install_lock" ]; then
    die "installer lock path exists but is not a directory: ${install_lock}"
  fi

  requested_lock_token=${SHELTER_INSTALL_LOCK_TOKEN:-}
  if [ -n "$requested_lock_token" ]; then
    current_lock_owner=
    if [ -f "$install_lock/owner" ]; then
      IFS= read -r current_lock_owner < "$install_lock/owner" || true
    fi
    if [ ! -d "$install_lock" ] || [ "$current_lock_owner" != "$requested_lock_token" ]; then
      unset SHELTER_INSTALL_LOCK_TOKEN requested_lock_token
      die "the externally managed Shelter operation lock is missing or has a different owner"
    fi
    lock_owner_token=$requested_lock_token
    lock_acquired=1
    lock_managed_externally=1
    unset SHELTER_INSTALL_LOCK_TOKEN requested_lock_token
    return 0
  fi

  lock_owner_token=$(openssl rand -hex 16)
  if mkdir "$install_lock" 2>/dev/null; then
    lock_acquired=1
    if ! printf '%s\n' "$$" > "$install_lock/pid" || ! printf '%s\n' "$lock_owner_token" > "$install_lock/owner" || ! printf '%s\n' install > "$install_lock/kind"; then
      rm -f "$install_lock/pid" "$install_lock/owner" "$install_lock/kind"
      rmdir "$install_lock" 2>/dev/null || true
      lock_acquired=0
      die "the installer lock could not be initialized"
    fi
    return 0
  fi

  existing_lock_kind=
  if [ -f "$install_lock/kind" ]; then
    IFS= read -r existing_lock_kind < "$install_lock/kind" || true
  fi
  if [ "$existing_lock_kind" = deploy ]; then
    die "another Shelter deploy operation is currently synchronizing or installing this checkout"
  fi

  existing_pid=
  if [ -f "$install_lock/pid" ]; then
    IFS= read -r existing_pid < "$install_lock/pid" || true
  fi
  case "$existing_pid" in
    ''|*[!0-9]*) ;;
    *)
      if kill -0 "$existing_pid" 2>/dev/null; then
        die "another Shelter installer is already running (PID ${existing_pid})"
      fi
      ;;
  esac
  die "stale Shelter operation lock at ${install_lock}; verify no install or deploy is running, remove its pid, owner, and kind files, then remove the directory and retry"
}

run_step() {
  run_label=$1
  shift
  heading "$run_label"

  if [ "$verbose" -eq 1 ] || [ ! -t 1 ]; then
    if "$@"; then
      ok "$run_label"
      return 0
    fi
    fail "$run_label failed"
    return 1
  fi

  printf '\n## %s\n' "$run_label" >> "$install_log"
  "$@" >> "$install_log" 2>&1 &
  active_pid=$!
  spinner_index=0
  while kill -0 "$active_pid" 2>/dev/null; do
    case "$spinner_index" in
      0) spinner_char='|' ;;
      1) spinner_char='/' ;;
      2) spinner_char='-' ;;
      *) spinner_char='\\' ;;
    esac
    printf '\r     %s[%s]%s Working…' "$cyan" "$spinner_char" "$reset"
    spinner_index=$(((spinner_index + 1) % 4))
    sleep 0.2
  done
  if wait "$active_pid"; then
    active_pid=
    printf '\r\033[2K'
    ok "$run_label"
    return 0
  else
    run_status=$?
  fi
  active_pid=
  printf '\r\033[2K'
  fail "$run_label failed"
  tail -n 40 "$install_log" >&2 || true
  return "$run_status"
}

pull_runtime_images() {
  docker compose pull traefik cloudflared
}

build_control_plane() {
  if [ "$no_pull" -eq 1 ]; then
    docker compose build api worker
  else
    docker compose build --pull api worker
  fi
}

wait_for_api() {
  wait_attempt=0
  while [ "$wait_attempt" -lt "$HEALTH_ATTEMPTS" ]; do
    api_id=$(docker compose ps -q api 2>/dev/null || true)
    if [ -n "$api_id" ]; then
      api_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$api_id" 2>/dev/null || true)
      [ "$api_health" = healthy ] && return 0
    fi
    wait_attempt=$((wait_attempt + 1))
    sleep "$HEALTH_INTERVAL"
  done
  docker compose ps api >&2 || true
  return 1
}

start_and_wait_for_api() {
  docker compose up -d --force-recreate --no-deps api || return 1
  wait_for_api
}

wait_for_worker() {
  wait_attempt=0
  while [ "$wait_attempt" -lt "$HEALTH_ATTEMPTS" ]; do
    worker_id=$(docker compose ps -q worker 2>/dev/null || true)
    api_id=$(docker compose ps -q api 2>/dev/null || true)
    if [ -n "$worker_id" ] && [ "$(docker inspect --format '{{.State.Running}}' "$worker_id" 2>/dev/null || true)" = true ] && [ -n "$api_id" ] && docker exec "$api_id" node -e "fetch('http://127.0.0.1:7080/api/healthz').then(r=>r.json()).then(v=>process.exit(v.worker==='online'?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    wait_attempt=$((wait_attempt + 1))
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

wait_for_traefik() {
  wait_attempt=0
  while [ "$wait_attempt" -lt "$HEALTH_ATTEMPTS" ]; do
    traefik_id=$(docker compose ps -q traefik 2>/dev/null || true)
    if [ -n "$traefik_id" ]; then
      traefik_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$traefik_id" 2>/dev/null || true)
      [ "$traefik_health" = healthy ] && return 0
    fi
    wait_attempt=$((wait_attempt + 1))
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

start_and_verify_stack() {
  docker compose up -d || return 1
  wait_for_api || return 1
  if [ "$data_state" = ready ] && [ "$WORKER_SETTLE_SECONDS" -gt 0 ]; then
    sleep "$WORKER_SETTLE_SECONDS" || return 1
  fi
  wait_for_worker || return 1
  wait_for_traefik
}

inspect_data_state() {
  if ! docker volume inspect "$data_volume" >/dev/null 2>&1; then
    printf 'empty\n'
    return 0
  fi

  docker run --rm --read-only --tmpfs /tmp \
    -v "${data_volume}:/data:ro" \
    --entrypoint node shelter/control-plane:local \
    --input-type=module -e '
      const fs = await import("node:fs");
      const { default: Database } = await import("better-sqlite3");
      const source = ["/data/shelter.sqlite", "/data/portsmith.sqlite"].find((file) => fs.existsSync(file));
      if (!source) { console.log("empty"); process.exit(0); }
      const db = new Database(source, { readonly: true, fileMustExist: true });
      const usersTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get("table", "users");
      const state = usersTable && Number(db.prepare("SELECT COUNT(*) AS count FROM users").get().count) > 0 ? "ready" : "empty";
      db.close();
      console.log(state);
    '
}

capture_control_plane_state() {
  running_api_id=$(docker compose ps -q api) || return 1
  running_worker_id=$(docker compose ps -q worker) || return 1
  if [ -n "$running_api_id" ]; then
    api_was_running=1
  fi
  if [ -n "$running_worker_id" ]; then
    worker_was_running=1
  fi
}

stop_control_plane() {
  docker compose stop -t 60 worker api || return 1
}

backup_database() {
  docker run --rm --read-only --tmpfs /tmp \
    -v "${data_volume}:/data" \
    --entrypoint node shelter/control-plane:local \
    --input-type=module -e '
      const fs = await import("node:fs");
      const { default: Database } = await import("better-sqlite3");
      const source = ["/data/shelter.sqlite", "/data/portsmith.sqlite"].find((file) => fs.existsSync(file));
      if (!source) process.exit(0);
      const target = "/data/shelter-before-update.sqlite";
      const temporary = `/data/.shelter-before-update.${process.pid}.tmp`;
      fs.rmSync(temporary, { force: true });
      try {
        const db = new Database(source, { readonly: true, fileMustExist: true });
        try {
          await db.backup(temporary);
        } finally {
          db.close();
        }
        const snapshot = new Database(temporary, { readonly: true, fileMustExist: true });
        try {
          const result = snapshot.pragma("quick_check", { simple: true });
          if (result !== "ok") throw new Error("SQLite quick_check failed");
        } finally {
          snapshot.close();
        }
        const stat = fs.statSync(temporary);
        if (!stat.isFile() || stat.size === 0) throw new Error("SQLite snapshot is empty");
        const fd = fs.openSync(temporary, "r");
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, target);
        const directory = fs.openSync("/data", "r");
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
      }
    '
}

add_bootstrap_password() {
  [ -n "$admin_password" ] || return 0
  encoded_password=$(printf '%s' "$admin_password" | openssl base64 -A) || return 1
  temporary_file=$(mktemp "$script_dir/.env.tmp.XXXXXX")
  chmod 600 "$temporary_file"
  if ! awk -v encoded_password="$encoded_password" '
    $0 !~ /^(ADMIN_PASSWORD|ADMIN_PASSWORD_B64)=/ { print }
    END { print "ADMIN_PASSWORD_B64=" encoded_password }
  ' .env > "$temporary_file"; then
    return 1
  fi
  mv "$temporary_file" .env
  temporary_file=
  chmod 600 .env
  unset admin_password encoded_password
}

scrub_bootstrap_values() {
  rewrite_env_without '^(ADMIN_PASSWORD|ADMIN_PASSWORD_B64|BOOTSTRAP_PENDING)='
}

check_socket() {
  docker_socket=/var/run/docker.sock
  if [ -f .env ]; then
    configured_socket=$(env_value DOCKER_SOCKET)
    [ -z "$configured_socket" ] || docker_socket=$configured_socket
  fi
  if [ -S "$docker_socket" ]; then
    ok "Docker socket available at ${docker_socket}"
  else
    warn "${docker_socket} is not a local Unix socket; set DOCKER_SOCKET in .env if the worker uses another path"
  fi
}

doctor_check_services() {
  doctor_failed=0

  api_id=$(docker compose ps -q api 2>/dev/null || true)
  if [ -n "$api_id" ] && [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$api_id" 2>/dev/null || true)" = healthy ]; then
    ok "API is healthy"
  else
    fail "API is not healthy"
    doctor_failed=1
  fi

  if [ -n "$api_id" ] && docker exec "$api_id" node -e "fetch('http://127.0.0.1:7080/api/healthz').then(r=>r.json()).then(v=>process.exit(v.worker==='online'?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ok "Worker is online"
  else
    fail "Worker is not online"
    doctor_failed=1
  fi

  traefik_id=$(docker compose ps -q traefik 2>/dev/null || true)
  if [ -n "$traefik_id" ] && [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$traefik_id" 2>/dev/null || true)" = healthy ]; then
    ok "Traefik is healthy"
  else
    fail "Traefik is not healthy"
    doctor_failed=1
  fi

  cloudflared_id=$(docker compose ps -q cloudflared 2>/dev/null || true)
  if [ -n "$cloudflared_id" ] && [ "$(docker inspect --format '{{.State.Running}}' "$cloudflared_id" 2>/dev/null || true)" = true ]; then
    ok "cloudflared is running"
  else
    note "Cloudflare Tunnel is not configured or not connected"
  fi

  [ "$doctor_failed" -eq 0 ]
}

preflight() {
  heading "Checking this server"

  require_command docker "Docker Engine is missing: https://docs.docker.com/engine/install/"
  require_command openssl "OpenSSL is required to generate application secrets"
  require_command awk "awk is required"
  require_command grep "grep is required"
  require_command mktemp "mktemp is required"
  require_command stat "stat is required"
  require_command tail "tail is required"

  validate_positive_integer "$HEALTH_ATTEMPTS" || die "SHELTER_INSTALL_HEALTH_ATTEMPTS must be a positive integer"
  validate_non_negative_integer "$HEALTH_INTERVAL" || die "SHELTER_INSTALL_HEALTH_INTERVAL must be a non-negative integer"
  validate_non_negative_integer "$WORKER_SETTLE_SECONDS" || die "SHELTER_INSTALL_WORKER_SETTLE_SECONDS must be a non-negative integer"

  host_os=$(uname -s 2>/dev/null || printf unknown)
  [ "$host_os" = Linux ] || die "Shelter production installations require Linux (Ubuntu 24.04 or 26.04 LTS)"
  ok "Linux host"

  if ! docker info >/dev/null 2>&1; then
    die "Docker is installed but the daemon is unavailable; check the service and your Docker group membership"
  fi
  ok "Docker daemon reachable"

  if ! docker compose version >/dev/null 2>&1; then
    die "Docker Compose v2 is missing"
  fi
  ok "Docker Compose v2"

  if ! docker buildx version >/dev/null 2>&1; then
    die "Docker Buildx is missing (Ubuntu package: docker-buildx-plugin)"
  fi
  ok "Docker Buildx"

  host_arch=$(uname -m 2>/dev/null || printf unknown)
  case "$host_arch" in
    x86_64|amd64|aarch64|arm64) ok "Supported architecture: ${host_arch}" ;;
    *) warn "Architecture ${host_arch} has not been tested" ;;
  esac

  cpu_count=
  if command -v getconf >/dev/null 2>&1; then
    cpu_count=$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)
  fi
  case "$cpu_count" in
    ''|*[!0-9]*) warn "Could not determine the available CPU count" ;;
    0|1) warn "${cpu_count} CPU core available; at least 2 are recommended" ;;
    *) ok "${cpu_count} CPU cores available" ;;
  esac

  memory_kb=$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo 2>/dev/null || true)
  case "$memory_kb" in
    ''|*[!0-9]*) warn "Could not determine available memory" ;;
    *)
      memory_gb=$((memory_kb / 1024 / 1024))
      if [ "$memory_kb" -lt 4194304 ]; then
        warn "${memory_gb} GB memory available; at least 4 GB are recommended"
      else
        ok "${memory_gb} GB memory available"
      fi
      ;;
  esac

  available_kb=$(df -Pk "$script_dir" 2>/dev/null | awk 'NR == 2 { print $4 }')
  case "$available_kb" in
    ''|*[!0-9]*) warn "Could not determine available disk space" ;;
    *)
      available_gb=$((available_kb / 1024 / 1024))
      if [ "$available_kb" -lt 2097152 ]; then
        die "Less than 2 GB of disk space is available"
      elif [ "$available_kb" -lt 41943040 ]; then
        warn "Only ${available_gb} GB is available; 40 GB is recommended"
      else
        ok "${available_gb} GB disk space available"
      fi
      ;;
  esac
}

show_review() {
  heading "Reviewing the installation"
  if [ "$fresh_install" -eq 1 ]; then
    note "Mode: new installation"
    note "Administrator: ${admin_email}"
  else
    note "Mode: update or repair"
    note "Existing APP_SECRET, administrator, volumes, and projects stay unchanged"
  fi
  note "Panel: http://127.0.0.1:${panel_port} (loopback only)"
  note "No project container or persistent volume will be removed"
  confirm_installation
}

doctor() {
  print_banner
  preflight

  if [ ! -e .env ] && [ ! -L .env ]; then
    heading "Checking Shelter configuration"
    note "No .env found — this directory is ready for a new installation"
    check_socket
    installation_succeeded=1
    printf '\n%sDoctor completed.%s Run ./install.sh when you are ready.\n' "$bold" "$reset"
    return 0
  fi

  heading "Checking Shelter configuration"
  validate_env_file
  panel_port=$(env_value PANEL_PORT)
  data_volume=$(env_value SHELTER_DATA_VOLUME)
  [ -n "$data_volume" ] || data_volume=shelter-data
  ok ".env is regular and structurally valid"
  check_env_permissions
  check_socket
  if docker compose config --quiet; then
    ok "Docker Compose configuration is valid"
  else
    die "Docker Compose configuration is invalid"
  fi

  heading "Current service state"
  docker compose ps || true
  if ! doctor_check_services; then
    fail "Core services need attention; inspect docker compose logs --tail=200 api worker traefik"
    return 1
  fi
  note "The panel is expected at http://127.0.0.1:${panel_port}"
  installation_succeeded=1
  printf '\n%sDoctor completed.%s No configuration or container was changed.\n' "$bold" "$reset"
}

install_shelter() {
  print_banner
  preflight
  acquire_install_lock
  if [ -L "$install_log" ]; then
    die "installer log must not be a symbolic link: ${install_log}"
  fi
  if [ -e "$install_log" ] && [ ! -f "$install_log" ]; then
    die "installer log path exists but is not a regular file: ${install_log}"
  fi
  : > "$install_log"
  chmod 600 "$install_log"
  install_log_started=1

  if [ -e .env ] || [ -L .env ]; then
    validate_env_file
    chmod 600 .env
    fresh_install=0
    admin_email=$(env_value ADMIN_EMAIL)
    panel_port=$(env_value PANEL_PORT)
    data_volume=$(env_value SHELTER_DATA_VOLUME)
    [ -n "$data_volume" ] || data_volume=shelter-data
    [ -z "$admin_email_arg" ] || die "--email cannot change an existing administrator; use the Shelter panel"
    [ "$panel_port_given" -eq 0 ] || die "--panel-port cannot change an existing .env; edit PANEL_PORT explicitly"
    ok "Existing .env will be reused"
  else
    for orphan_candidate in shelter-data portsmith-data; do
      if docker volume inspect "$orphan_candidate" >/dev/null 2>&1; then
        die "the ${orphan_candidate} volume exists but .env is missing; restore its matching .env before continuing"
      fi
    done
    [ "$non_interactive" -eq 0 ] || [ -n "$admin_email_arg" ] || usage_error "--email is required for a non-interactive fresh install"
    fresh_install=1
    admin_email=$admin_email_arg
    if [ -z "$admin_email" ]; then
      prompt_line "Administrator email" ""
      admin_email=$prompt_value
    fi
    validate_email "$admin_email" || die "the administrator email is invalid"

    panel_port=$panel_port_arg
    if [ "$panel_port_given" -eq 0 ] && [ "$non_interactive" -eq 0 ]; then
      prompt_line "Local panel port" "7080"
      panel_port=$prompt_value
    fi
    validate_port "$panel_port" || die "the panel port must be between 1 and 65535"
    data_volume=shelter-data
  fi

  known_pending=0
  existing_bootstrap_pending=
  existing_plain_password=
  existing_encoded_password=
  if [ -f .env ]; then
    existing_bootstrap_pending=$(env_value BOOTSTRAP_PENDING)
    existing_plain_password=$(env_value ADMIN_PASSWORD)
    existing_encoded_password=$(env_value ADMIN_PASSWORD_B64)
  fi
  if [ "$existing_bootstrap_pending" = 1 ] || [ -n "$existing_plain_password" ] || [ -n "$existing_encoded_password" ]; then
    known_pending=1
  fi

  password_already_present=0
  if [ "$bootstrap_values_invalid" -eq 0 ] && { [ -n "$existing_plain_password" ] || [ -n "$existing_encoded_password" ]; }; then
    password_already_present=1
  fi
  unset existing_bootstrap_pending existing_plain_password existing_encoded_password

  password_expected=0
  if [ "$fresh_install" -eq 1 ] || [ "$known_pending" -eq 1 ] || [ "$bootstrap_empty_volume" -eq 1 ]; then
    password_expected=1
  fi
  if [ "$password_stdin" -eq 1 ] && [ "$password_expected" -eq 0 ]; then
    usage_error "--password-stdin is only used while bootstrapping an administrator"
  fi
  if [ "$password_expected" -eq 1 ]; then
    if [ "$password_stdin" -eq 1 ]; then
      read_password_from_stdin
      password_already_present=0
    elif [ "$password_already_present" -eq 0 ]; then
      if [ "$non_interactive" -eq 1 ]; then
        usage_error "--password-stdin is required when bootstrap credentials are needed non-interactively"
      else
        heading "Choosing the administrator password"
        prompt_initial_password
        ok "Password confirmed"
      fi
    fi
  fi

  show_review

  if [ "$fresh_install" -eq 1 ]; then
    heading "Writing secure configuration"
    create_env_file
    validate_env_file
    ok ".env created atomically with mode 0600"
  fi
  check_socket

  if ! run_step "Validating the Compose configuration" docker compose config --quiet; then
    die "fix the Compose error above and rerun ./install.sh"
  fi

  if [ "$no_pull" -eq 0 ]; then
    if ! run_step "Pulling runtime images" pull_runtime_images; then
      die "runtime image download failed; rerun the installer or use --no-pull with known local images"
    fi
  else
    heading "Pulling runtime images"
    note "Skipped by --no-pull"
  fi

  if ! run_step "Building the Shelter control plane" build_control_plane; then
    die "the control-plane image could not be built"
  fi

  heading "Inspecting persistent data"
  if ! data_state=$(inspect_data_state); then
    die "the Shelter data volume could not be inspected safely"
  fi
  case "$data_state" in
    ready) ok "Existing administrator and database found" ;;
    empty) note "The data volume has no administrator yet" ;;
    *) die "unexpected data-volume state: ${data_state}" ;;
  esac

  if [ "$data_state" = ready ]; then
    bootstrap_needed=0
    if [ "$password_expected" -eq 1 ] && [ "$password_already_present" -eq 0 ]; then
      warn "An existing administrator was found; the supplied bootstrap password will not be used"
      unset admin_password
    fi
  else
    if [ "$fresh_install" -eq 1 ] || [ "$known_pending" -eq 1 ] || [ "$bootstrap_empty_volume" -eq 1 ]; then
      bootstrap_needed=1
    else
      die "the configured data volume is empty. Restore the expected volume, or rerun with --bootstrap-empty-volume after verifying it is intentionally empty"
    fi
  fi

  if [ "$bootstrap_needed" -eq 1 ] && [ "$password_already_present" -eq 0 ] && [ -z "$admin_password" ]; then
    die "an administrator password is required to bootstrap this data volume"
  fi

  if [ "$data_state" = ready ]; then
    if ! capture_control_plane_state; then
      die "the current API and worker state could not be inspected safely"
    fi
    control_plane_stopped=1
    if ! run_step "Pausing the control plane for a safe update" stop_control_plane; then
      die "the API and worker could not be paused cleanly; the installer will restore their previous running state"
    fi
    if ! run_step "Creating the pre-update database snapshot" backup_database; then
      die "the database snapshot failed; the previous API and worker will be restarted"
    fi
    note "Rollback snapshot: ${data_volume}:/data/shelter-before-update.sqlite"
  fi

  if [ "$bootstrap_needed" -eq 1 ]; then
    heading "Preparing the one-time administrator bootstrap"
    set_env_value BOOTSTRAP_PENDING 1
    add_bootstrap_password
    ok "Bootstrap credential stored temporarily in .env"
  elif grep -Eq '^(ADMIN_PASSWORD|ADMIN_PASSWORD_B64|BOOTSTRAP_PENDING)=' .env; then
    scrub_bootstrap_values
    ok "Removed stale bootstrap values from .env"
  fi

  if ! run_step "Starting the API" start_and_wait_for_api; then
    die "the API did not become healthy. Bootstrap values remain protected in .env when still needed; inspect: docker compose logs --tail=200 api"
  fi

  if [ "$bootstrap_needed" -eq 1 ]; then
    heading "Removing the one-time bootstrap credential"
    scrub_bootstrap_values
    ok "Bootstrap password removed atomically from .env"
    if ! run_step "Restarting the API without bootstrap credentials" start_and_wait_for_api; then
      die "the administrator was created, but the credential-free API restart failed; inspect: docker compose logs --tail=200 api"
    fi
  fi

  if ! run_step "Starting and verifying Shelter" start_and_verify_stack; then
    die "Shelter did not become fully ready; inspect: docker compose ps && docker compose logs --tail=200 api worker traefik"
  fi
  control_plane_stopped=0

  cloudflared_id=$(docker compose ps -q cloudflared 2>/dev/null || true)
  if [ -n "$cloudflared_id" ] && [ "$(docker inspect --format '{{.State.Running}}' "$cloudflared_id" 2>/dev/null || true)" = true ]; then
    tunnel_state=running
  else
    tunnel_state=pending
  fi

  installation_succeeded=1
  printf '\n%sShelter is ready.%s\n\n' "$bold" "$reset"
  printf '  %s[OK]%s API             healthy\n' "$green" "$reset"
  printf '  %s[OK]%s Worker          online\n' "$green" "$reset"
  printf '  %s[OK]%s Traefik         healthy\n' "$green" "$reset"
  if [ "$tunnel_state" = running ]; then
    printf '  %s[OK]%s cloudflared     process running\n' "$green" "$reset"
  else
    printf '  %s[--]%s Cloudflare      not configured yet\n' "$dim" "$reset"
  fi

  printf '\nFrom your computer:\n'
  printf '  ssh -N -L %s:127.0.0.1:%s USER@YOUR-VPS\n' "$panel_port" "$panel_port"
  printf '\nThen open:\n'
  printf '  http://127.0.0.1:%s\n' "$panel_port"
  printf '\nNext:\n'
  printf '  Sign in, open Settings, and connect Cloudflare.\n'
  printf '\nUseful commands:\n'
  printf '  ./install.sh doctor\n'
  printf '  docker compose ps\n'
  printf '  docker compose logs --tail=200 api worker traefik cloudflared\n\n'
}

if [ "$mode" = doctor ]; then
  doctor
else
  install_shelter
fi
