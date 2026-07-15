#!/usr/bin/env sh
set -eu

umask 077

INSTALLER_VERSION="0.3.0"
ROLLBACK_HELPER_IMAGE="shelter/control-plane:rollback"
ROLLBACK_IMAGE_PREFIX="shelter/control-plane:rollback-"
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
rollback_fail_closed=0
release_identity_fail_closed=0
rollback_compose_file=
rollback_validation_image=
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
control_plane_image=shelter/control-plane:local
tunnel_state=pending
previous_image_id=
previous_image_tag=
previous_revision=
new_image_id=
new_revision=
prior_control_plane_found=0
previous_image_reference=
preloaded_control_plane_image=${SHELTER_INSTALL_PRELOADED_IMAGE:-}
preloaded_control_plane_image_id=${SHELTER_INSTALL_PRELOADED_IMAGE_ID:-}
release_revision=${SHELTER_INSTALL_RELEASE_REVISION:-}
release_install=0
release_compose_bound=0

shelter_compose() {
  if [ "$release_compose_bound" -eq 1 ]; then
    COMPOSE_FILE="$script_dir/compose.yaml" \
    COMPOSE_PATH_SEPARATOR=: \
      docker compose --env-file "$script_dir/.env" -f "$script_dir/compose.yaml" "$@"
  else
    docker compose "$@"
  fi
}

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

  if [ "$release_identity_fail_closed" -eq 1 ]; then
    printf '\n%s[ERROR]%s The running release image identity could not be proven. API and worker are being left stopped.\n' "$red" "$reset" >&2
    shelter_compose stop -t 30 worker api >/dev/null 2>&1 || true
  elif [ "$rollback_fail_closed" -eq 1 ]; then
    printf '\n%s[ERROR]%s Rollback safety could not be proven. API and worker are being left stopped.\n' "$red" "$reset" >&2
    shelter_compose stop -t 30 worker api >/dev/null 2>&1 || true
    if [ -n "$rollback_compose_file" ] && [ -f "$rollback_compose_file" ]; then
      docker compose --env-file .env -f "$rollback_compose_file" stop -t 30 worker api >/dev/null 2>&1 || true
    fi
    printf '%s[ERROR]%s Do not start either writer manually. Preserve the data volume, run ./install.sh doctor, and use ./install.sh rollback only when it reports a ready bundle.\n' "$red" "$reset" >&2
  elif [ "$control_plane_stopped" -eq 1 ]; then
    printf '\n%s[WARN]%s Restoring the API and worker to their previous running or stopped state.\n' "$yellow" "$reset" >&2
    if [ "$worker_was_running" -eq 0 ]; then
      shelter_compose stop -t 30 worker >/dev/null 2>&1 || true
    fi
    if [ "$api_was_running" -eq 0 ]; then
      shelter_compose stop -t 30 api >/dev/null 2>&1 || true
    fi
    if [ "$api_was_running" -eq 1 ]; then
      shelter_compose start api >/dev/null 2>&1 || true
    fi
    if [ "$worker_was_running" -eq 1 ]; then
      shelter_compose start worker >/dev/null 2>&1 || true
    fi
  fi

  if [ -n "$temporary_file" ]; then
    rm -f "$temporary_file"
    temporary_file=
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
  ./install.sh rollback [options]
  ./install.sh doctor [options]

Commands:
  install                      Install, resume, or update Shelter (default)
  rollback                     Restore the last validated control-plane revision
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
  ./install.sh rollback
  ./install.sh doctor
  ./install.sh --non-interactive --email admin@example.com \
    --panel-port 7080 --password-stdin < /run/secrets/shelter-admin-password

Passwords are never accepted as command-line arguments or environment variables.
Rollback restores the last validated pre-update database snapshot and prior control plane.
EOF
}

usage_error() {
  printf 'Error: %s\n\n' "$1" >&2
  usage >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    install|rollback|doctor)
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

if [ "$mode" != install ]; then
  [ -z "$admin_email_arg" ] || usage_error "--email is only available for installation"
  [ "$panel_port_given" -eq 0 ] || usage_error "--panel-port is only available for installation"
  [ "$password_stdin" -eq 0 ] || usage_error "--password-stdin is only available for installation"
  [ "$bootstrap_empty_volume" -eq 0 ] || usage_error "--bootstrap-empty-volume is only available for installation"
  [ "$no_pull" -eq 0 ] || usage_error "--no-pull is only available for installation"
fi

if [ -n "$preloaded_control_plane_image" ] || [ -n "$preloaded_control_plane_image_id" ] || [ -n "$release_revision" ]; then
  [ "$mode" = install ] || usage_error "the internal release-image contract is only available for installation"
  [ -n "$preloaded_control_plane_image" ] && [ -n "$preloaded_control_plane_image_id" ] && [ -n "$release_revision" ] ||
    usage_error "the internal release-image contract is incomplete; use ops/install-release-bundle.sh"
  case "$preloaded_control_plane_image" in
    [A-Za-z0-9]*) ;;
    *) usage_error "the preloaded release image must start with a letter or number" ;;
  esac
  case "$preloaded_control_plane_image" in
    *[!A-Za-z0-9./:_-]*|*@*) usage_error "the preloaded release image must be a taggable local reference" ;;
  esac
  [ "${#preloaded_control_plane_image}" -le 256 ] || usage_error "the preloaded release image reference is too long"

  preloaded_control_plane_image_hex=${preloaded_control_plane_image_id#sha256:}
  [ "$preloaded_control_plane_image_hex" != "$preloaded_control_plane_image_id" ] ||
    usage_error "the preloaded release image identity must use sha256"
  case "$preloaded_control_plane_image_hex" in
    ''|*[!0-9a-f]*) usage_error "the preloaded release image identity is invalid" ;;
  esac
  [ "${#preloaded_control_plane_image_hex}" -eq 64 ] || usage_error "the preloaded release image identity is invalid"

  case "$release_revision" in
    release:[A-Za-z0-9]*) ;;
    *) usage_error "the release revision is invalid" ;;
  esac
  case "$release_revision" in
    *[!A-Za-z0-9:._-]*) usage_error "the release revision is invalid" ;;
  esac
  [ "${#release_revision}" -le 128 ] || usage_error "the release revision is too long"
  release_install=1
  release_compose_bound=1
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

check_release_sync_complete() {
  release_sync_marker=$script_dir/.shelter-release-sync-incomplete
  if [ -L "$release_sync_marker" ] || [ -e "$release_sync_marker" ]; then
    die "an authenticated release payload synchronization was interrupted; rerun ops/install-release-bundle.sh with the same --installation directory before using install, rollback, or doctor"
  fi
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

bind_verified_release_compose_if_configured() {
  configured_release_image=$(env_value CONTROL_PLANE_IMAGE)
  case "$configured_release_image" in
    shelter/control-plane:release-*) release_compose_bound=1 ;;
  esac
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
      count = split("ADMIN_EMAIL APP_SECRET PANEL_PORT SHELTER_DATA_VOLUME CONTROL_PLANE_IMAGE DOCKER_SOCKET ADMIN_PASSWORD ADMIN_PASSWORD_B64 BOOTSTRAP_PENDING", keys, " ")
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

  for env_optional_key in CONTROL_PLANE_IMAGE ADMIN_PASSWORD ADMIN_PASSWORD_B64 BOOTSTRAP_PENDING; do
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

  configured_control_plane_image=$(env_value CONTROL_PLANE_IMAGE)
  if [ -n "$configured_control_plane_image" ]; then
    case "$configured_control_plane_image" in
      [A-Za-z0-9]*) ;;
      *) die "CONTROL_PLANE_IMAGE in .env must start with a letter or number" ;;
    esac
    case "$configured_control_plane_image" in
      *[!A-Za-z0-9./:_-]*|*@*) die "CONTROL_PLANE_IMAGE in .env must be a taggable Docker image reference" ;;
    esac
    [ "${#configured_control_plane_image}" -le 256 ] || die "CONTROL_PLANE_IMAGE in .env is too long"
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
  preserved_temporary_file=$temporary_file
  env_temporary_file=$(mktemp "$script_dir/.env.tmp.XXXXXX")
  chmod 600 "$env_temporary_file"
  if ! awk -v key="$set_key" -v value="$set_value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 {
      if (!found) print key "=" value
      found = 1
      next
    }
    { print }
    END { if (!found) print key "=" value }
  ' .env > "$env_temporary_file"; then
    rm -f "$env_temporary_file"
    temporary_file=$preserved_temporary_file
    return 1
  fi
  if ! mv "$env_temporary_file" .env; then
    rm -f "$env_temporary_file"
    temporary_file=$preserved_temporary_file
    return 1
  fi
  temporary_file=$preserved_temporary_file
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
    if ! printf '%s\n' "$$" > "$install_lock/pid" || ! printf '%s\n' "$lock_owner_token" > "$install_lock/owner" || ! printf '%s\n' "$mode" > "$install_lock/kind"; then
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
  if [ "$existing_lock_kind" = rollback ]; then
    die "another Shelter rollback is already running"
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
  shelter_compose pull traefik cloudflared
}

build_control_plane() {
  if [ "$no_pull" -eq 1 ]; then
    shelter_compose build api worker
  else
    shelter_compose build --pull api worker
  fi
}

wait_for_api() {
  wait_attempt=0
  while [ "$wait_attempt" -lt "$HEALTH_ATTEMPTS" ]; do
    api_id=$(shelter_compose ps -q api 2>/dev/null || true)
    if [ -n "$api_id" ]; then
      api_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$api_id" 2>/dev/null || true)
      [ "$api_health" = healthy ] && return 0
    fi
    wait_attempt=$((wait_attempt + 1))
    sleep "$HEALTH_INTERVAL"
  done
  shelter_compose ps api >&2 || true
  return 1
}

start_and_wait_for_api() {
  shelter_compose up -d --force-recreate --no-deps api || return 1
  wait_for_api
}

wait_for_worker() {
  wait_attempt=0
  while [ "$wait_attempt" -lt "$HEALTH_ATTEMPTS" ]; do
    worker_id=$(shelter_compose ps -q worker 2>/dev/null || true)
    api_id=$(shelter_compose ps -q api 2>/dev/null || true)
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
    traefik_id=$(shelter_compose ps -q traefik 2>/dev/null || true)
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
  shelter_compose up -d || return 1
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

  docker run --rm --read-only --network none --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp \
    -v "${data_volume}:/data:ro" \
    --entrypoint node "$control_plane_image" \
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
  running_api_id=$(shelter_compose ps -a -q api) || return 1
  running_worker_id=$(shelter_compose ps -a -q worker) || return 1
  [ -n "$running_api_id" ] && [ -n "$running_worker_id" ] || return 1
  if [ "$(docker inspect --format '{{.State.Running}}' "$running_api_id" 2>/dev/null || true)" = true ]; then
    api_was_running=1
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$running_worker_id" 2>/dev/null || true)" = true ]; then
    worker_was_running=1
  fi
  api_image_id=$(docker inspect --format '{{.Image}}' "$running_api_id" 2>/dev/null || true)
  worker_image_id=$(docker inspect --format '{{.Image}}' "$running_worker_id" 2>/dev/null || true)
  [ -n "$api_image_id" ] && [ "$api_image_id" = "$worker_image_id" ] || return 1
  previous_image_id=$api_image_id
  previous_revision="image:${previous_image_id}"
}

stop_control_plane() {
  shelter_compose stop -t 60 worker api || return 1
}

backup_database() {
  backup_helper_image=${1:-shelter/control-plane:local}
  docker run --rm --read-only --network none --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp \
    -v "${data_volume}:/data" \
    --entrypoint node "$backup_helper_image" \
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
        fs.chmodSync(temporary, 0o600);
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

current_source_revision() {
  source_revision=
  if command -v git >/dev/null 2>&1; then
    source_revision=$(git -C "$script_dir" rev-parse --verify HEAD 2>/dev/null || true)
  fi
  case "$source_revision" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) printf 'git:%s\n' "$source_revision" ;;
    *) printf 'source:unknown\n' ;;
  esac
}

retain_previous_control_plane_image() {
  [ -n "$previous_image_id" ] || return 1
  image_hex=${previous_image_id#sha256:}
  case "$previous_image_id" in
    sha256:*) ;;
    *) return 1 ;;
  esac
  case "$image_hex" in
    ''|*[!0-9a-f]*) return 1 ;;
  esac
  [ "${#image_hex}" -eq 64 ] || return 1
  previous_image_tag="${ROLLBACK_IMAGE_PREFIX}${image_hex}"
  docker tag "$previous_image_id" "$previous_image_tag" || return 1
  docker tag "$previous_image_id" "$ROLLBACK_HELPER_IMAGE" || return 1
  retained_id=$(docker image inspect --format '{{.Id}}' "$previous_image_tag" 2>/dev/null || true)
  [ "$retained_id" = "$previous_image_id" ]
}

inspect_built_control_plane_image() {
  docker image inspect --format '{{.Id}}' "$control_plane_image"
}

verify_preloaded_control_plane_image() {
  [ "$release_install" -eq 1 ] || return 0
  inspected_preloaded_image_id=$(docker image inspect --format '{{.Id}}' "$control_plane_image" 2>/dev/null || true)
  [ "$inspected_preloaded_image_id" = "$preloaded_control_plane_image_id" ]
}

verify_running_release_images() {
  [ "$release_install" -eq 1 ] || return 0
  release_api_id=$(shelter_compose ps -q api 2>/dev/null || true)
  release_worker_id=$(shelter_compose ps -q worker 2>/dev/null || true)
  [ -n "$release_api_id" ] && [ -n "$release_worker_id" ] || return 1
  release_api_image_id=$(docker inspect --format '{{.Image}}' "$release_api_id" 2>/dev/null || true)
  release_worker_image_id=$(docker inspect --format '{{.Image}}' "$release_worker_id" 2>/dev/null || true)
  [ "$release_api_image_id" = "$preloaded_control_plane_image_id" ] &&
    [ "$release_worker_image_id" = "$preloaded_control_plane_image_id" ]
}

run_rollback_helper() {
  rollback_action=$1
  rollback_helper_image=$2
  rollback_volume_mode=$3
  shift 3

  if [ "$rollback_volume_mode" = ro ]; then
    rollback_volume_mount="${data_volume}:/data:ro"
  else
    rollback_volume_mount="${data_volume}:/data"
  fi

  docker run --rm --read-only --network none --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp \
    -v "$rollback_volume_mount" \
    -e "SHELTER_ROLLBACK_ACTION=${rollback_action}" \
    "$@" \
    --entrypoint node "$rollback_helper_image" \
    --input-type=module -e '
      const fs = await import("node:fs");
      const crypto = await import("node:crypto");
      const { default: Database } = await import("better-sqlite3");

      const root = "/data/.shelter-control-plane";
      const rollbackMetaPath = `${root}/rollback.meta`;
      const rollbackComposePath = `${root}/rollback-compose.yaml`;
      const baselineMetaPath = `${root}/baseline.meta`;
      const baselineComposePath = `${root}/baseline-compose.yaml`;
      const snapshotPath = "/data/shelter-before-update.sqlite";
      const rollbackKeys = [
        "FORMAT_VERSION", "STATE", "REASON", "PREVIOUS_REVISION", "NEW_REVISION",
        "PREVIOUS_IMAGE_ID", "PREVIOUS_IMAGE_TAG", "PREVIOUS_IMAGE_REFERENCE", "NEW_IMAGE_ID", "SNAPSHOT_PATH",
        "SNAPSHOT_STATUS", "SNAPSHOT_SCHEMA", "COMPOSE_PATH", "COMPOSE_STATUS", "COMPOSE_SHA256"
      ];
      const baselineKeys = ["FORMAT_VERSION", "STATE", "REVISION", "IMAGE_ID", "IMAGE_REFERENCE", "SCHEMA_VERSION", "COMPOSE_SHA256"];
      const imageIdPattern = /^sha256:[0-9a-f]{64}$/;
      const imageTagPattern = /^shelter\/control-plane:rollback-[0-9a-f]{64}$/;
      const imageReferencePattern = /^[A-Za-z0-9][A-Za-z0-9./:_-]{0,255}$/;
      const revisionPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
      const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

      function regularFile(path, maximumBytes = 4 * 1024 * 1024, restricted = true) {
        const stat = fs.lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("required rollback artifact is not a regular file");
        if (restricted && (stat.mode & 0o077) !== 0) throw new Error("rollback artifact permissions are too broad");
        if (stat.size <= 0 || stat.size > maximumBytes) throw new Error("rollback artifact size is invalid");
        return stat;
      }

      function ensureRoot() {
        if (fs.existsSync(root)) {
          const stat = fs.lstatSync(root);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("rollback root is unsafe");
          fs.chmodSync(root, 0o700);
        } else {
          fs.mkdirSync(root, { mode: 0o700 });
        }
      }

      function syncDirectory(path) {
        const descriptor = fs.openSync(path, "r");
        try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      }

      function atomicWrite(path, contents) {
        ensureRoot();
        const temporary = `${root}/.${path.split("/").at(-1)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
        const descriptor = fs.openSync(temporary, "wx", 0o600);
        try {
          fs.writeFileSync(descriptor, contents, { encoding: "utf8" });
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        fs.chmodSync(temporary, 0o600);
        fs.renameSync(temporary, path);
        syncDirectory(root);
      }

      function readMetadata(path, keys) {
        regularFile(path, 64 * 1024);
        const raw = fs.readFileSync(path, "utf8");
        if (!raw.endsWith("\n") || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) throw new Error("metadata encoding is invalid");
        const allowed = new Set(keys);
        const values = Object.create(null);
        for (const line of raw.slice(0, -1).split("\n")) {
          const separator = line.indexOf("=");
          if (separator < 1) throw new Error("metadata line is invalid");
          const key = line.slice(0, separator);
          const value = line.slice(separator + 1);
          if (!allowed.has(key) || Object.hasOwn(values, key)) throw new Error("metadata key is invalid");
          values[key] = value;
        }
        for (const key of keys) if (!Object.hasOwn(values, key)) throw new Error("metadata field is missing");
        if (Object.keys(values).length !== keys.length) throw new Error("metadata field count is invalid");
        return values;
      }

      function serialize(keys, values) {
        return `${keys.map((key) => `${key}=${values[key]}`).join("\n")}\n`;
      }

      function validateRevision(value) {
        if (!revisionPattern.test(value)) throw new Error("revision identifier is invalid");
      }

      function inspectSqlite(path, restricted = false) {
        regularFile(path, 1024 * 1024 * 1024 * 8, restricted);
        const database = new Database(path, { readonly: true, fileMustExist: true });
        try {
          const result = database.pragma("quick_check", { simple: true });
          if (result !== "ok") throw new Error("SQLite quick_check failed");
          const schema = Number(database.pragma("user_version", { simple: true }));
          if (!Number.isSafeInteger(schema) || schema < 0) throw new Error("SQLite schema version is invalid");
          return schema;
        } finally {
          database.close();
        }
      }

      function readCompose(path, restricted = true) {
        regularFile(path, 4 * 1024 * 1024, restricted);
        return fs.readFileSync(path);
      }

      function validateRollback() {
        const meta = readMetadata(rollbackMetaPath, rollbackKeys);
        if (meta.FORMAT_VERSION !== "1" || meta.STATE !== "ready" || meta.REASON !== "none") throw new Error("rollback bundle is not ready");
        validateRevision(meta.PREVIOUS_REVISION);
        validateRevision(meta.NEW_REVISION);
        if (!imageIdPattern.test(meta.PREVIOUS_IMAGE_ID) || !imageIdPattern.test(meta.NEW_IMAGE_ID)) throw new Error("image identifier is invalid");
        if (!imageTagPattern.test(meta.PREVIOUS_IMAGE_TAG)) throw new Error("image tag is invalid");
        if (!imageReferencePattern.test(meta.PREVIOUS_IMAGE_REFERENCE)) throw new Error("image reference is invalid");
        if (meta.SNAPSHOT_PATH !== snapshotPath || meta.SNAPSHOT_STATUS !== "valid") throw new Error("snapshot metadata is invalid");
        if (meta.COMPOSE_PATH !== rollbackComposePath || meta.COMPOSE_STATUS !== "valid" || !/^[0-9a-f]{64}$/.test(meta.COMPOSE_SHA256)) throw new Error("Compose metadata is invalid");
        if (!/^(0|[1-9][0-9]*)$/.test(meta.SNAPSHOT_SCHEMA)) throw new Error("snapshot schema is invalid");
        const schema = inspectSqlite(snapshotPath, true);
        if (String(schema) !== meta.SNAPSHOT_SCHEMA) throw new Error("snapshot schema changed");
        const compose = readCompose(rollbackComposePath);
        if (digest(compose) !== meta.COMPOSE_SHA256) throw new Error("saved Compose file changed");
        return meta;
      }

      async function sqliteBackup(sourcePath, destinationPath) {
        fs.rmSync(destinationPath, { force: true });
        const database = new Database(sourcePath, { readonly: true, fileMustExist: true });
        try { await database.backup(destinationPath); } finally { database.close(); }
        fs.chmodSync(destinationPath, 0o600);
        inspectSqlite(destinationPath, true);
        const descriptor = fs.openSync(destinationPath, "r");
        try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      }

      const action = process.env.SHELTER_ROLLBACK_ACTION;
      if (action === "prepare") {
        const previousImageId = process.env.PREVIOUS_IMAGE_ID || "";
        const previousImageTag = process.env.PREVIOUS_IMAGE_TAG || "";
        const fallbackImageReference = process.env.PREVIOUS_IMAGE_REFERENCE || "";
        const newImageId = process.env.NEW_IMAGE_ID || "";
        const fallbackPreviousRevision = process.env.PREVIOUS_REVISION || "";
        const newRevision = process.env.NEW_REVISION || "";
        if (!imageIdPattern.test(previousImageId) || !imageIdPattern.test(newImageId) || !imageTagPattern.test(previousImageTag) || !imageReferencePattern.test(fallbackImageReference)) throw new Error("prepared image metadata is invalid");
        validateRevision(fallbackPreviousRevision);
        validateRevision(newRevision);
        const snapshotSchema = inspectSqlite(snapshotPath, true);
        let state = "incomplete";
        let reason = "baseline_missing";
        let previousRevision = fallbackPreviousRevision;
        let previousImageReference = fallbackImageReference;
        let composeStatus = "missing";
        let composeSha = "none";
        try {
          const baseline = readMetadata(baselineMetaPath, baselineKeys);
          if (baseline.FORMAT_VERSION !== "1" || baseline.STATE !== "baseline") throw new Error("baseline state is invalid");
          validateRevision(baseline.REVISION);
          if (baseline.IMAGE_ID !== previousImageId || !imageIdPattern.test(baseline.IMAGE_ID)) throw new Error("baseline image does not match the running control plane");
          if (!imageReferencePattern.test(baseline.IMAGE_REFERENCE)) throw new Error("baseline image reference is invalid");
          if (!/^(0|[1-9][0-9]*)$/.test(baseline.SCHEMA_VERSION) || !/^[0-9a-f]{64}$/.test(baseline.COMPOSE_SHA256)) throw new Error("baseline metadata is invalid");
          if (baseline.SCHEMA_VERSION !== String(snapshotSchema)) throw new Error("baseline schema does not match the pre-update snapshot");
          const compose = readCompose(baselineComposePath);
          if (digest(compose) !== baseline.COMPOSE_SHA256) throw new Error("baseline Compose file changed");
          atomicWrite(rollbackComposePath, compose);
          state = "ready";
          reason = "none";
          previousRevision = baseline.REVISION;
          previousImageReference = baseline.IMAGE_REFERENCE;
          composeStatus = "valid";
          composeSha = baseline.COMPOSE_SHA256;
        } catch {
          fs.rmSync(rollbackComposePath, { force: true });
        }
        const metadata = {
          FORMAT_VERSION: "1", STATE: state, REASON: reason,
          PREVIOUS_REVISION: previousRevision, NEW_REVISION: newRevision,
          PREVIOUS_IMAGE_ID: previousImageId, PREVIOUS_IMAGE_TAG: previousImageTag,
          PREVIOUS_IMAGE_REFERENCE: previousImageReference,
          NEW_IMAGE_ID: newImageId, SNAPSHOT_PATH: snapshotPath, SNAPSHOT_STATUS: "valid",
          SNAPSHOT_SCHEMA: String(snapshotSchema), COMPOSE_PATH: rollbackComposePath,
          COMPOSE_STATUS: composeStatus, COMPOSE_SHA256: composeSha
        };
        atomicWrite(rollbackMetaPath, serialize(rollbackKeys, metadata));
        if (state === "ready") validateRollback();
        console.log(state);
      } else if (action === "record-baseline") {
        const imageId = process.env.CURRENT_IMAGE_ID || "";
        const imageReference = process.env.CURRENT_IMAGE_REFERENCE || "";
        const revision = process.env.CURRENT_REVISION || "";
        if (!imageIdPattern.test(imageId) || !imageReferencePattern.test(imageReference)) throw new Error("baseline image identifier is invalid");
        validateRevision(revision);
        const sourceCompose = "/source/compose.yaml";
        const compose = readCompose(sourceCompose, false);
        const source = ["/data/shelter.sqlite", "/data/portsmith.sqlite"].find((path) => fs.existsSync(path));
        if (!source) throw new Error("database is missing");
        const schema = inspectSqlite(source);
        atomicWrite(baselineComposePath, compose);
        const metadata = {
          FORMAT_VERSION: "1", STATE: "baseline", REVISION: revision, IMAGE_ID: imageId, IMAGE_REFERENCE: imageReference,
          SCHEMA_VERSION: String(schema), COMPOSE_SHA256: digest(compose)
        };
        atomicWrite(baselineMetaPath, serialize(baselineKeys, metadata));
        console.log("recorded");
      } else if (action === "invalidate") {
        ensureRoot();
        fs.rmSync(rollbackMetaPath, { force: true });
        fs.rmSync(rollbackComposePath, { force: true });
        syncDirectory(root);
        console.log("invalidated");
      } else if (action === "validate") {
        const meta = validateRollback();
        for (const key of ["PREVIOUS_REVISION", "NEW_REVISION", "PREVIOUS_IMAGE_ID", "PREVIOUS_IMAGE_TAG", "PREVIOUS_IMAGE_REFERENCE", "NEW_IMAGE_ID", "SNAPSHOT_SCHEMA", "COMPOSE_SHA256"]) {
          console.log(`${key}=${meta[key]}`);
        }
      } else if (action === "extract-compose") {
        validateRollback();
        process.stdout.write(readCompose(rollbackComposePath));
      } else if (action === "restore") {
        const meta = validateRollback();
        const target = ["/data/shelter.sqlite", "/data/portsmith.sqlite"].find((path) => fs.existsSync(path));
        if (!target) throw new Error("current database is missing");
        const targetStat = regularFile(target, 1024 * 1024 * 1024 * 8, false);
        const diagnosticTemporary = `/data/.shelter-before-rollback.${process.pid}.tmp`;
        const diagnosticTarget = "/data/shelter-before-rollback.sqlite";
        const restoreTemporary = `/data/.shelter-restore.${process.pid}.tmp`;
        try {
          await sqliteBackup(target, diagnosticTemporary);
          fs.renameSync(diagnosticTemporary, diagnosticTarget);
          fs.chmodSync(diagnosticTarget, 0o600);
          await sqliteBackup(snapshotPath, restoreTemporary);
          if (String(inspectSqlite(restoreTemporary)) !== meta.SNAPSHOT_SCHEMA) throw new Error("restored schema does not match metadata");
          fs.chownSync(restoreTemporary, targetStat.uid, targetStat.gid);
          fs.chmodSync(restoreTemporary, targetStat.mode & 0o777);
          const restoreDescriptor = fs.openSync(restoreTemporary, "r");
          try { fs.fsyncSync(restoreDescriptor); } finally { fs.closeSync(restoreDescriptor); }
          fs.rmSync(`${target}-wal`, { force: true });
          fs.rmSync(`${target}-shm`, { force: true });
          fs.renameSync(restoreTemporary, target);
          syncDirectory("/data");
        } catch (error) {
          fs.rmSync(diagnosticTemporary, { force: true });
          fs.rmSync(restoreTemporary, { force: true });
          throw error;
        }
        console.log("restored");
      } else if (action === "promote") {
        const meta = validateRollback();
        const compose = readCompose(rollbackComposePath);
        atomicWrite(baselineComposePath, compose);
        atomicWrite(baselineMetaPath, serialize(baselineKeys, {
          FORMAT_VERSION: "1", STATE: "baseline", REVISION: meta.PREVIOUS_REVISION,
          IMAGE_ID: meta.PREVIOUS_IMAGE_ID, IMAGE_REFERENCE: meta.PREVIOUS_IMAGE_REFERENCE, SCHEMA_VERSION: meta.SNAPSHOT_SCHEMA,
          COMPOSE_SHA256: meta.COMPOSE_SHA256
        }));
        meta.STATE = "applied";
        meta.REASON = "already_applied";
        atomicWrite(rollbackMetaPath, serialize(rollbackKeys, meta));
        console.log("applied");
      } else {
        throw new Error("unknown rollback helper action");
      }
    '
}

prepare_rollback_bundle() {
  run_rollback_helper prepare "$ROLLBACK_HELPER_IMAGE" rw \
    -e "PREVIOUS_IMAGE_ID=${previous_image_id}" \
    -e "PREVIOUS_IMAGE_TAG=${previous_image_tag}" \
    -e "PREVIOUS_IMAGE_REFERENCE=${previous_image_reference:-$control_plane_image}" \
    -e "PREVIOUS_REVISION=${previous_revision}" \
    -e "NEW_IMAGE_ID=${new_image_id}" \
    -e "NEW_REVISION=${new_revision}"
}

record_current_baseline() {
  run_rollback_helper record-baseline "$control_plane_image" rw \
    -v "${script_dir}/compose.yaml:/source/compose.yaml:ro" \
    -e "CURRENT_IMAGE_ID=${new_image_id}" \
    -e "CURRENT_IMAGE_REFERENCE=${control_plane_image}" \
    -e "CURRENT_REVISION=${new_revision}"
}

invalidate_rollback_bundle() {
  run_rollback_helper invalidate "$ROLLBACK_HELPER_IMAGE" rw
}

validate_rollback_bundle() {
  run_rollback_helper validate "${rollback_validation_image:-$ROLLBACK_HELPER_IMAGE}" ro
}

extract_rollback_compose() {
  run_rollback_helper extract-compose "${rollback_validation_image:-$ROLLBACK_HELPER_IMAGE}" ro
}

restore_rollback_database() {
  run_rollback_helper restore "${rollback_validation_image:-$ROLLBACK_HELPER_IMAGE}" rw
}

promote_applied_rollback() {
  run_rollback_helper promote "${rollback_validation_image:-$ROLLBACK_HELPER_IMAGE}" rw
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

  api_id=$(shelter_compose ps -q api 2>/dev/null || true)
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

  traefik_id=$(shelter_compose ps -q traefik 2>/dev/null || true)
  if [ -n "$traefik_id" ] && [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$traefik_id" 2>/dev/null || true)" = healthy ]; then
    ok "Traefik is healthy"
  else
    fail "Traefik is not healthy"
    doctor_failed=1
  fi

  cloudflared_id=$(shelter_compose ps -q cloudflared 2>/dev/null || true)
  if [ -n "$cloudflared_id" ] && [ "$(docker inspect --format '{{.State.Running}}' "$cloudflared_id" 2>/dev/null || true)" = true ]; then
    ok "cloudflared is running"
  else
    note "Cloudflare Tunnel is not configured or not connected"
  fi

  [ "$doctor_failed" -eq 0 ]
}

rollback_metadata_value() {
  rollback_metadata_key=$1
  printf '%s\n' "$validated_rollback_metadata" | awk -F= -v key="$rollback_metadata_key" '
    index($0, key "=") == 1 { print substr($0, length(key) + 2); found += 1 }
    END { if (found != 1) exit 1 }
  '
}

load_validated_rollback_metadata() {
  validated_rollback_metadata=$(validate_rollback_bundle 2>/dev/null) || return 1
  rollback_metadata_count=$(printf '%s\n' "$validated_rollback_metadata" | awk '
    /^(PREVIOUS_REVISION|NEW_REVISION|PREVIOUS_IMAGE_ID|PREVIOUS_IMAGE_TAG|PREVIOUS_IMAGE_REFERENCE|NEW_IMAGE_ID|SNAPSHOT_SCHEMA|COMPOSE_SHA256)=/ { valid += 1; next }
    { invalid += 1 }
    END { if (invalid > 0) exit 1; print valid + 0 }
  ') || return 1
  [ "$rollback_metadata_count" -eq 8 ] || return 1

  rollback_previous_revision=$(rollback_metadata_value PREVIOUS_REVISION) || return 1
  rollback_new_revision=$(rollback_metadata_value NEW_REVISION) || return 1
  rollback_previous_image_id=$(rollback_metadata_value PREVIOUS_IMAGE_ID) || return 1
  rollback_previous_image_tag=$(rollback_metadata_value PREVIOUS_IMAGE_TAG) || return 1
  rollback_previous_image_reference=$(rollback_metadata_value PREVIOUS_IMAGE_REFERENCE) || return 1
  rollback_new_image_id=$(rollback_metadata_value NEW_IMAGE_ID) || return 1
  rollback_snapshot_schema=$(rollback_metadata_value SNAPSHOT_SCHEMA) || return 1
  rollback_compose_sha=$(rollback_metadata_value COMPOSE_SHA256) || return 1

  rollback_previous_image_hex=${rollback_previous_image_id#sha256:}
  rollback_new_image_hex=${rollback_new_image_id#sha256:}
  case "$rollback_previous_image_hex" in ''|*[!0-9a-f]*) return 1 ;; esac
  case "$rollback_new_image_hex" in ''|*[!0-9a-f]*) return 1 ;; esac
  [ "${#rollback_previous_image_id}" -eq 71 ] && [ "${#rollback_new_image_id}" -eq 71 ] || return 1
  rollback_tag_hex=${rollback_previous_image_tag#shelter/control-plane:rollback-}
  [ "$rollback_tag_hex" != "$rollback_previous_image_tag" ] || return 1
  case "$rollback_tag_hex" in ''|*[!0-9a-f]*) return 1 ;; esac
  [ "${#rollback_previous_image_tag}" -eq 95 ] || return 1
  case "$rollback_previous_image_reference" in
    ''|*[!A-Za-z0-9./:_-]*|*@*) return 1 ;;
  esac
  case "$rollback_previous_image_reference" in [A-Za-z0-9]*) ;; *) return 1 ;; esac
  [ "${#rollback_previous_image_reference}" -le 256 ] || return 1
  case "$rollback_snapshot_schema" in ''|*[!0-9]*) return 1 ;; esac
  case "$rollback_compose_sha" in ''|*[!0-9a-f]*) return 1 ;; esac
  [ "${#rollback_compose_sha}" -eq 64 ] || return 1

  inspected_rollback_image_id=$(docker image inspect --format '{{.Id}}' "$rollback_previous_image_tag" 2>/dev/null || true)
  [ "$inspected_rollback_image_id" = "$rollback_previous_image_id" ] || return 1
  rollback_validation_image=$rollback_previous_image_tag
}

extract_and_validate_rollback_compose() {
  temporary_file=$(mktemp "$script_dir/.rollback-compose.XXXXXX") || return 1
  rollback_compose_file=$temporary_file
  chmod 600 "$rollback_compose_file"
  if ! extract_rollback_compose > "$rollback_compose_file"; then
    return 1
  fi
  extracted_compose_sha=$(openssl dgst -sha256 "$rollback_compose_file" 2>/dev/null | awk '{ print $NF }') || return 1
  [ "$extracted_compose_sha" = "$rollback_compose_sha" ] || return 1
  CONTROL_PLANE_IMAGE="$rollback_previous_image_reference" docker compose --env-file .env -f "$rollback_compose_file" config --quiet
}

rollback_compose() {
  CONTROL_PLANE_IMAGE="$rollback_previous_image_reference" docker compose --env-file .env -f "$rollback_compose_file" "$@"
}

rollback_wait_for_api() {
  wait_attempt=0
  while [ "$wait_attempt" -lt "$HEALTH_ATTEMPTS" ]; do
    api_id=$(rollback_compose ps -q api 2>/dev/null || true)
    if [ -n "$api_id" ]; then
      api_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$api_id" 2>/dev/null || true)
      [ "$api_health" = healthy ] && return 0
    fi
    wait_attempt=$((wait_attempt + 1))
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

rollback_wait_for_worker() {
  wait_attempt=0
  while [ "$wait_attempt" -lt "$HEALTH_ATTEMPTS" ]; do
    worker_id=$(rollback_compose ps -q worker 2>/dev/null || true)
    api_id=$(rollback_compose ps -q api 2>/dev/null || true)
    if [ -n "$worker_id" ] && [ "$(docker inspect --format '{{.State.Running}}' "$worker_id" 2>/dev/null || true)" = true ] && [ -n "$api_id" ] && docker exec "$api_id" node -e "fetch('http://127.0.0.1:7080/api/healthz').then(r=>r.json()).then(v=>process.exit(v.worker==='online'?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    wait_attempt=$((wait_attempt + 1))
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

rollback_wait_for_traefik() {
  wait_attempt=0
  while [ "$wait_attempt" -lt "$HEALTH_ATTEMPTS" ]; do
    traefik_id=$(rollback_compose ps -q traefik 2>/dev/null || true)
    if [ -n "$traefik_id" ]; then
      traefik_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$traefik_id" 2>/dev/null || true)
      [ "$traefik_health" = healthy ] && return 0
    fi
    wait_attempt=$((wait_attempt + 1))
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

start_and_verify_rollback_stack() {
  rollback_compose up -d --no-build --force-recreate --no-deps api || return 1
  rollback_wait_for_api || return 1
  rollback_compose up -d --no-build --force-recreate --no-deps worker || return 1
  rollback_compose up -d --no-build traefik || return 1
  rollback_wait_for_worker || return 1
  rollback_wait_for_traefik
}

doctor_rollback_status() {
  heading "Rollback readiness"
  if ! docker volume inspect "$data_volume" >/dev/null 2>&1; then
    note "Rollback incomplete — the configured data volume does not exist"
    return 0
  fi
  if ! docker image inspect "$ROLLBACK_HELPER_IMAGE" >/dev/null 2>&1; then
    note "Rollback incomplete — no retained control-plane image is available"
    return 0
  fi
  if load_validated_rollback_metadata; then
    if rollback_doctor_compose=$(extract_rollback_compose 2>/dev/null) && printf '%s\n' "$rollback_doctor_compose" | CONTROL_PLANE_IMAGE="$rollback_previous_image_reference" docker compose --env-file .env -f - config --quiet >/dev/null 2>&1; then
      ok "Rollback ready: ${rollback_new_revision} → ${rollback_previous_revision} (SQLite schema ${rollback_snapshot_schema})"
    else
      note "Rollback incomplete — the saved prior Compose revision is not usable with the current runtime configuration"
    fi
  else
    note "Rollback incomplete — a validated snapshot, prior image, and matching prior Compose revision are all required"
  fi
}

confirm_rollback() {
  [ "$assume_yes" -eq 1 ] && return 0
  [ "$terminal_available" -eq 1 ] || die "rollback confirmation requires a TTY; use --yes or --non-interactive"
  printf '     Restore the validated snapshot and prior control plane? [y/N]: ' >/dev/tty
  rollback_confirmation=
  IFS= read -r rollback_confirmation </dev/tty || die "rollback confirmation input ended unexpectedly"
  case "$rollback_confirmation" in
    y|Y|yes|YES|Yes) ;;
    *)
      note "Nothing was changed"
      installation_succeeded=1
      exit 0
      ;;
  esac
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

  # Version detection does not evaluate a Compose plan. Keep it independent of
  # .env because a verified first install creates that file after preflight.
  if ! docker compose version >/dev/null 2>&1; then
    die "Docker Compose v2 is missing"
  fi
  ok "Docker Compose v2"

  if [ "$mode" = rollback ]; then
    note "Docker Buildx is not required for rollback"
  elif [ "$release_install" -eq 1 ]; then
    note "Docker Buildx is not required for a verified release image"
  elif ! docker buildx version >/dev/null 2>&1; then
    die "Docker Buildx is missing (Ubuntu package: docker-buildx-plugin)"
  else
    ok "Docker Buildx"
  fi

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

start_operation_log() {
  if [ -L "$install_log" ]; then
    die "installer log must not be a symbolic link: ${install_log}"
  fi
  if [ -e "$install_log" ] && [ ! -f "$install_log" ]; then
    die "installer log path exists but is not a regular file: ${install_log}"
  fi
  : > "$install_log"
  chmod 600 "$install_log"
  install_log_started=1
}

doctor() {
  print_banner
  preflight
  check_release_sync_complete

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
  control_plane_image=$(env_value CONTROL_PLANE_IMAGE)
  [ -n "$control_plane_image" ] || control_plane_image=shelter/control-plane:local
  bind_verified_release_compose_if_configured
  ok ".env is regular and structurally valid"
  check_env_permissions
  check_socket
  if shelter_compose config --quiet; then
    ok "Docker Compose configuration is valid"
  else
    die "Docker Compose configuration is invalid"
  fi

  doctor_rollback_status

  heading "Current service state"
  shelter_compose ps || true
  if ! doctor_check_services; then
    fail "Core services need attention; inspect docker compose logs --tail=200 api worker traefik"
    return 1
  fi
  note "The panel is expected at http://127.0.0.1:${panel_port}"
  installation_succeeded=1
  printf '\n%sDoctor completed.%s No configuration or container was changed.\n' "$bold" "$reset"
}

rollback_shelter() {
  print_banner
  preflight
  check_release_sync_complete
  acquire_install_lock
  start_operation_log

  heading "Checking rollback configuration"
  [ -e .env ] || die "rollback requires the matching .env for this installation"
  validate_env_file
  data_volume=$(env_value SHELTER_DATA_VOLUME)
  [ -n "$data_volume" ] || data_volume=shelter-data
  control_plane_image=$(env_value CONTROL_PLANE_IMAGE)
  [ -n "$control_plane_image" ] || control_plane_image=shelter/control-plane:local
  bind_verified_release_compose_if_configured
  docker volume inspect "$data_volume" >/dev/null 2>&1 || die "the configured data volume does not exist"
  if ! shelter_compose config --quiet; then
    die "the current Compose configuration is invalid"
  fi
  ok "Runtime configuration and data volume found"

  heading "Validating the rollback bundle"
  if ! load_validated_rollback_metadata; then
    die "rollback is incomplete or invalid; no writer was stopped"
  fi
  initial_rollback_metadata=$validated_rollback_metadata
  if ! extract_and_validate_rollback_compose; then
    die "the saved prior Compose revision is invalid; no writer was stopped"
  fi
  ok "Snapshot, prior image, and prior Compose revision agree"
  note "Revision: ${rollback_new_revision} → ${rollback_previous_revision}"
  note "Database: validated SQLite schema ${rollback_snapshot_schema}"
  warn "Rollback replaces the current database with the pre-update snapshot. A diagnostic copy of the current database will be retained."
  confirm_rollback

  rollback_fail_closed=1
  if ! run_step "Stopping API and worker" shelter_compose stop -t 60 worker api; then
    die "the writers could not be stopped; the installer will keep attempting to leave them stopped"
  fi

  heading "Revalidating rollback artifacts with writers stopped"
  if ! load_validated_rollback_metadata || [ "$validated_rollback_metadata" != "$initial_rollback_metadata" ]; then
    die "rollback metadata changed during the safety boundary"
  fi
  extracted_compose_sha=$(openssl dgst -sha256 "$rollback_compose_file" 2>/dev/null | awk '{ print $NF }') || die "the saved Compose digest could not be recalculated"
  [ "$extracted_compose_sha" = "$rollback_compose_sha" ] || die "the extracted prior Compose revision changed"
  ok "Rollback artifacts are still valid"

  if ! run_step "Selecting the retained control-plane image" docker tag "$rollback_previous_image_tag" "$rollback_previous_image_reference"; then
    die "the retained prior image could not be selected"
  fi
  if ! run_step "Restoring the validated database snapshot" restore_rollback_database; then
    die "the atomic database restore failed; API and worker remain stopped"
  fi
  if ! run_step "Starting and verifying the prior control plane" start_and_verify_rollback_stack; then
    die "the prior API, worker, or Traefik did not become healthy; writers remain stopped"
  fi
  heading "Committing the restored image reference"
  if ! set_env_value CONTROL_PLANE_IMAGE "$rollback_previous_image_reference"; then
    die "the prior control plane is healthy, but its image reference could not be committed to .env; writers remain stopped"
  fi
  ok "CONTROL_PLANE_IMAGE restored to ${rollback_previous_image_reference}"

  rollback_fail_closed=0
  control_plane_stopped=0
  if ! run_step "Recording the restored baseline" promote_applied_rollback; then
    if invalidate_rollback_bundle >/dev/null 2>&1; then
      warn "The rollback succeeded, but its restored baseline could not be recorded. The consumed bundle was invalidated to prevent an accidental repeat."
    else
      warn "The rollback succeeded, but its consumed marker could not be recorded or invalidated; do not repeat it without reviewing the retained snapshot."
    fi
  fi

  installation_succeeded=1
  printf '\n%sRollback completed safely.%s\n' "$bold" "$reset"
  printf '  %s[OK]%s API             healthy on %s\n' "$green" "$reset" "$rollback_previous_revision"
  printf '  %s[OK]%s Worker          online\n' "$green" "$reset"
  printf '  %s[OK]%s Traefik         healthy\n' "$green" "$reset"
  printf '\nDiagnostic pre-rollback database: %s:/data/shelter-before-rollback.sqlite\n\n' "$data_volume"
}

install_shelter() {
  print_banner
  preflight
  check_release_sync_complete
  acquire_install_lock
  start_operation_log

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
  configured_control_plane_image=$(env_value CONTROL_PLANE_IMAGE)
  [ -n "$configured_control_plane_image" ] || configured_control_plane_image=shelter/control-plane:local
  if [ "$release_install" -ne 1 ]; then
    case "$configured_control_plane_image" in
      shelter/control-plane:release-*)
        die "this installation tracks a verified release image; update it with ops/install-release-bundle.sh so the digest-specific tag cannot be overwritten by a local build (to switch deliberately, first set CONTROL_PLANE_IMAGE=shelter/control-plane:local)"
        ;;
    esac
  fi
  previous_image_reference=$configured_control_plane_image
  if [ "$release_install" -eq 1 ]; then
    control_plane_image=$preloaded_control_plane_image
    export CONTROL_PLANE_IMAGE=$control_plane_image
    if ! verify_preloaded_control_plane_image; then
      die "the preloaded release image no longer matches its verified identity"
    fi
    ok "Verified preloaded release image ${control_plane_image}"
  else
    control_plane_image=$configured_control_plane_image
  fi

  if ! run_step "Validating the Compose configuration" shelter_compose config --quiet; then
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

  if [ "$fresh_install" -eq 0 ]; then
    heading "Retaining the current control plane"
    if capture_control_plane_state && retain_previous_control_plane_image; then
      prior_control_plane_found=1
      ok "Previous image retained as ${previous_image_tag}"
    else
      note "No complete prior API/worker generation was found; a ready data volume will require one before replacement"
    fi
  fi

  if [ "$release_install" -eq 1 ]; then
    heading "Selecting the verified Shelter release image"
    if ! verify_preloaded_control_plane_image; then
      die "the preloaded release image changed before it could be selected"
    fi
    ok "Using ${control_plane_image} without a local build"
  elif ! run_step "Building the Shelter control plane" build_control_plane; then
    die "the control-plane image could not be built"
  fi
  new_image_id=$(inspect_built_control_plane_image 2>/dev/null || true)
  if [ "$release_install" -eq 1 ]; then
    new_revision=$release_revision
    [ "$new_image_id" = "$preloaded_control_plane_image_id" ] ||
      die "the selected release image identity changed before persistent data inspection"
  else
    new_revision=$(current_source_revision)
  fi
  case "$new_image_id" in sha256:*) ;;
    *) die "the built control-plane image identity could not be verified" ;;
  esac

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
    if [ "$prior_control_plane_found" -eq 0 ]; then
      if ! capture_control_plane_state || ! retain_previous_control_plane_image; then
        die "the prior API and worker image could not be retained safely; the database was not changed"
      fi
      prior_control_plane_found=1
    fi
    control_plane_stopped=1
    if ! run_step "Pausing the control plane for a safe update" stop_control_plane; then
      die "the API and worker could not be paused cleanly; the installer will restore their previous running state"
    fi
    if ! run_step "Invalidating the superseded rollback bundle" invalidate_rollback_bundle; then
      die "the previous rollback metadata could not be invalidated before replacing its snapshot"
    fi
    if ! run_step "Creating the pre-update database snapshot" backup_database "$ROLLBACK_HELPER_IMAGE"; then
      die "the database snapshot failed; the previous API and worker will be restarted"
    fi
    rollback_fail_closed=1
    heading "Preparing safe rollback metadata"
    if ! rollback_bundle_state=$(prepare_rollback_bundle); then
      die "the rollback snapshot or metadata could not be validated; API and worker remain stopped"
    fi
    case "$rollback_bundle_state" in
      ready)
        ok "Rollback bundle is ready (${new_revision} → prior validated revision)"
        ;;
      incomplete)
        warn "Rollback metadata and the prior image were retained, but the prior Compose baseline is unavailable. Any post-migration failure will leave API and worker stopped."
        ;;
      *) die "the rollback bundle returned an unexpected state" ;;
    esac
    note "Snapshot: ${data_volume}:/data/shelter-before-update.sqlite"
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
  if [ "$release_install" -eq 1 ]; then
    heading "Verifying the running release image"
    if ! verify_running_release_images; then
      release_identity_fail_closed=1
      shelter_compose stop -t 30 worker api >/dev/null 2>&1 || true
      die "the verified release became healthy, but the running API or worker image identity did not match the authenticated image; API and worker were stopped"
    fi
    ok "API and worker use the authenticated release image"

    heading "Committing the verified release image"
    if ! set_env_value CONTROL_PLANE_IMAGE "$control_plane_image"; then
      shelter_compose stop -t 30 worker api >/dev/null 2>&1 || true
      die "the verified release became healthy, but its image reference could not be committed to .env; API and worker were stopped"
    fi
    ok "CONTROL_PLANE_IMAGE now selects the digest-specific release tag"
  fi
  rollback_fail_closed=0
  control_plane_stopped=0

  if ! run_step "Recording the control-plane baseline" record_current_baseline; then
    warn "Shelter is healthy, but the next update will not have a complete automatic rollback baseline until this step succeeds."
  fi

  cloudflared_id=$(shelter_compose ps -q cloudflared 2>/dev/null || true)
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
  printf '  ./install.sh rollback  # only when doctor reports a ready bundle\n'
  printf '  docker compose ps\n'
  printf '  docker compose logs --tail=200 api worker traefik cloudflared\n\n'
}

case "$mode" in
  doctor) doctor ;;
  rollback) rollback_shelter ;;
  *) install_shelter ;;
esac
