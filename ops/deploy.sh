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

usage() {
  cat <<'USAGE'
Usage: ops/deploy.sh [--dry-run] [--sync-only]

Synchronizes the repository to the configured VPS without transferring any
.env file. A normal run then rebuilds and restarts Shelter on the VPS.

Options:
  --dry-run    Show which files rsync would change; do not modify the VPS.
  --sync-only  Synchronize source files, but do not run Docker Compose.
  -h, --help   Show this help.

Configuration is read from .env.server by default. Override its path with
SHELTER_SERVER_ENV_FILE. See .env.server.example for the supported values.
USAGE
}

cleanup() {
  if [[ -n "$control_path" && -n "$ssh_target" && -S "$control_path" ]]; then
    ssh -S "$control_path" -O exit "$ssh_target" >/dev/null 2>&1 || true
  fi
  if [[ -n "$temporary_directory" ]]; then
    rm -rf -- "$temporary_directory"
  fi
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'Fehler: %s\n' "$1" >&2
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
    *) usage >&2; fail "Unbekannte Option: $1" ;;
  esac
  shift
done

[[ -f "$SERVER_ENV_FILE" ]] || fail "$SERVER_ENV_FILE fehlt. Kopiere .env.server.example und trage den VPS ein."

mode="$(file_mode "$SERVER_ENV_FILE")"
[[ "$mode" =~ ^[0-7]{3,4}$ ]] || fail "Dateirechte von $SERVER_ENV_FILE konnten nicht geprüft werden."
mode="${mode: -3}"
(( (8#$mode & 077) == 0 )) || fail "$SERVER_ENV_FILE ist für Gruppe oder andere Benutzer lesbar. Führe 'chmod 600 $SERVER_ENV_FILE' aus."

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

: "${SHELTER_SERVER_HOST:?SHELTER_SERVER_HOST fehlt in $SERVER_ENV_FILE}"
: "${SHELTER_SERVER_USER:?SHELTER_SERVER_USER fehlt in $SERVER_ENV_FILE}"
: "${SHELTER_SERVER_PATH:?SHELTER_SERVER_PATH fehlt in $SERVER_ENV_FILE}"
[[ "$SHELTER_SERVER_HOST" =~ ^[A-Za-z0-9:.%-]+$ ]] || fail "SHELTER_SERVER_HOST enthält nicht unterstützte Zeichen."
[[ "$SHELTER_SERVER_USER" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || fail "SHELTER_SERVER_USER ist ungültig."
[[ "$SHELTER_SERVER_PORT" =~ ^[0-9]+$ ]] || fail "SHELTER_SERVER_PORT muss numerisch sein."
((SHELTER_SERVER_PORT >= 1 && SHELTER_SERVER_PORT <= 65535)) || fail "SHELTER_SERVER_PORT liegt außerhalb von 1–65535."
[[ "$SHELTER_SERVER_PATH" =~ ^/[A-Za-z0-9._/-]+$ && "$SHELTER_SERVER_PATH" != "/" ]] || fail "SHELTER_SERVER_PATH muss ein sicherer absoluter Pfad ungleich / sein."
[[ "$SHELTER_LEGACY_SERVER_PATH" =~ ^/[A-Za-z0-9._/-]+$ && "$SHELTER_LEGACY_SERVER_PATH" != "/" ]] || fail "SHELTER_LEGACY_SERVER_PATH muss ein sicherer absoluter Pfad ungleich / sein."

ssh_args=(
  ssh
  -p "$SHELTER_SERVER_PORT"
  -o ConnectTimeout=15
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=3
  -o StrictHostKeyChecking=accept-new
)

if [[ -n "$SHELTER_SERVER_IDENTITY_FILE" ]]; then
  [[ -f "$SHELTER_SERVER_IDENTITY_FILE" ]] || fail "SSH-Key $SHELTER_SERVER_IDENTITY_FILE fehlt."
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
rsync_rsh="$(shell_join "${ssh_args[@]}")"

if ((dry_run)); then
  "${ssh_args[@]}" "$ssh_target" "test -d $remote_path_q" </dev/null \
    || fail "Das Zielverzeichnis existiert nicht; --dry-run verändert den VPS nicht."
else
  "${ssh_args[@]}" "$ssh_target" "mkdir -p $remote_path_q" </dev/null
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
  --exclude=node_modules/
  --exclude=dist/
  --exclude=coverage/
  --exclude=data/
  --exclude=traefik/dynamic.yml
  --rsh="$rsync_rsh"
)
((dry_run)) && rsync_args+=(--dry-run)

printf 'Synchronisiere Shelter nach %s:%s …\n' "$SHELTER_SERVER_HOST" "$SHELTER_SERVER_PATH"
rsync "${rsync_args[@]}" "$REPOSITORY_DIR/" "$rsync_target"

if ((dry_run)); then
  printf 'Dry-run abgeschlossen; auf dem VPS wurde nichts geändert.\n'
  exit 0
fi

if ((sync_only)); then
  printf 'Quellcode synchronisiert; Docker Compose wurde nicht ausgeführt.\n'
  exit 0
fi

read -r -d '' remote_deploy <<REMOTE || true
set -eu
cd $remote_path_q
if [ ! -f .env ] && [ -f $legacy_path_q/.env ]; then
  install -m 600 $legacy_path_q/.env .env
  echo 'Bestehende Runtime-Konfiguration in das Shelter-Verzeichnis übernommen.'
fi
if [ ! -f .env ]; then
  echo 'Fehler: Die App-Runtime-Datei .env fehlt auf dem VPS. Führe zuerst ./install.sh auf dem VPS aus.' >&2
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
docker compose config --quiet
api_container="\$(docker ps --filter status=running --filter label=com.docker.compose.service=api --filter label=com.docker.compose.project=shelter -q | head -n 1)"
if [ -z "\$api_container" ]; then
  api_container="\$(docker ps --filter status=running --filter label=com.docker.compose.service=api --filter label=com.docker.compose.project=portsmith -q | head -n 1)"
fi
if [ -n "\$api_container" ]; then
  docker exec -i "\$api_container" node --input-type=module -e "const fs=await import('node:fs');const {default:Database}=await import('better-sqlite3');const source=fs.existsSync('/data/shelter.sqlite')?'/data/shelter.sqlite':'/data/portsmith.sqlite';const db=new Database(source);await db.backup('/data/shelter-before-update.sqlite');db.close()"
  echo 'Konsistentes SQLite-Backup im Datenvolume erstellt.'
fi
docker compose pull traefik cloudflared
docker compose build --pull api worker
legacy_containers="\$(docker ps -aq --filter label=com.docker.compose.project=portsmith)"
if [ -n "\$legacy_containers" ]; then
  echo 'Migriere die Control Plane einmalig von Portsmith zu Shelter.'
  # Existing application containers may still use portsmith-runtime. Compose
  # can therefore remove every legacy control-plane container successfully and
  # still return a failure while trying to remove that intentionally preserved
  # network. Re-query and clean only containers that actually remain so the
  # one-time migration stays idempotent.
  docker compose -p portsmith down --remove-orphans || true
  remaining_legacy_containers="\$(docker ps -aq --filter label=com.docker.compose.project=portsmith)"
  if [ -n "\$remaining_legacy_containers" ]; then
    docker rm -f \$remaining_legacy_containers || true
  fi
  docker network rm portsmith-control >/dev/null 2>&1 || true
fi
docker compose up -d --wait --wait-timeout 180
docker compose ps
REMOTE

printf 'Baue und starte Shelter auf dem VPS …\n'
"${ssh_args[@]}" "$ssh_target" "$remote_deploy" </dev/null
printf 'Deployment abgeschlossen.\n'
