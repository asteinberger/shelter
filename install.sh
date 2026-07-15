#!/usr/bin/env sh
set -eu
umask 077

terminal_echo_disabled=0
bootstrap_tmp=

cleanup() {
  if [ "$terminal_echo_disabled" -eq 1 ]; then
    stty echo 2>/dev/null || true
  fi
  if [ -n "$bootstrap_tmp" ]; then
    rm -f "$bootstrap_tmp"
  fi
}

trap cleanup EXIT HUP INT TERM

wait_for_api() {
  attempts=0
  while [ "$attempts" -lt 60 ]; do
    api_id=$(docker compose ps -q api 2>/dev/null || true)
    if [ -n "$api_id" ]; then
      api_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$api_id" 2>/dev/null || true)
      if [ "$api_health" = "healthy" ]; then
        return 0
      fi
    fi
    attempts=$((attempts + 1))
    sleep 2
  done

  echo "Die API wurde nicht rechtzeitig gesund. Prüfe 'docker compose logs api'; .env wird erst nach einem erfolgreichen ersten API-Start bereinigt." >&2
  docker compose ps api >&2 || true
  return 1
}

rewrite_env_without() {
  excluded_pattern=$1
  bootstrap_tmp=$(mktemp .env.tmp.XXXXXX)
  if ! awk -v excluded_pattern="$excluded_pattern" '$0 !~ excluded_pattern { print }' .env > "$bootstrap_tmp"; then
    rm -f "$bootstrap_tmp"
    bootstrap_tmp=
    return 1
  fi
  chmod 600 "$bootstrap_tmp"
  mv "$bootstrap_tmp" .env
  bootstrap_tmp=
}

prompt_bootstrap_password() {
  printf "Admin-Passwort (mindestens 16 Zeichen): "
  stty -echo
  terminal_echo_disabled=1
  IFS= read -r admin_password
  stty echo
  terminal_echo_disabled=0
  printf "\n"

  if [ "${#admin_password}" -lt 16 ]; then
    echo "Das Passwort ist zu kurz." >&2
    exit 1
  fi

  admin_password_b64=$(printf '%s' "$admin_password" | openssl base64 -A)
  rewrite_env_without '^(ADMIN_PASSWORD|ADMIN_PASSWORD_B64)='
  printf 'ADMIN_PASSWORD_B64=%s\n' "$admin_password_b64" >> .env
  chmod 600 .env
  unset admin_password admin_password_b64
}

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker Engine fehlt. Installiere Docker zuerst nach https://docs.docker.com/engine/install/" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 fehlt." >&2
  exit 1
fi
if ! docker buildx version >/dev/null 2>&1; then
  echo "Docker Buildx/BuildKit fehlt (unter Ubuntu: docker-buildx-plugin)." >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl fehlt und wird zum Erzeugen des App-Secrets benötigt." >&2
  exit 1
fi

bootstrap_pending=0
if [ ! -f .env ]; then
  printf "Admin-E-Mail: "
  read -r admin_email
  if ! printf '%s' "$admin_email" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; then
    echo "Die Admin-E-Mail ist ungültig." >&2
    exit 1
  fi
  app_secret=$(openssl rand -hex 32)
  cat > .env <<EOF
ADMIN_EMAIL=${admin_email}
APP_SECRET=${app_secret}
BOOTSTRAP_PENDING=1
PANEL_PORT=7080
PORT=7080
HOST=0.0.0.0
DATA_DIR=/data
TRAEFIK_CONFIG_PATH=/routing/dynamic.yml
TUNNEL_TOKEN_PATH=/tunnel/tunnel-token
RUNTIME_NETWORK=shelter-runtime
SHELTER_DATA_VOLUME=shelter-data
SHELTER_ROUTING_VOLUME=shelter-routing
SHELTER_TUNNEL_VOLUME=shelter-tunnel
TRAEFIK_SERVICE_URL=http://traefik:80
CONTROL_SUBNET=10.253.253.0/24
API_CONTROL_IP=10.253.253.2
TRAEFIK_CONTROL_IP=10.253.253.3
CLOUDFLARED_CONTROL_IP=10.253.253.4
WORKER_CONTROL_IP=10.253.253.5
TRUSTED_PROXY_IP=10.253.253.3
TRUSTED_CLOUDFLARED_IP=10.253.253.4
MAX_UPLOAD_MB=500
DEPLOYMENT_MEMORY=1g
DEPLOYMENT_CPUS=1.0
HEALTHCHECK_TIMEOUT_SECONDS=60
BUILD_TIMEOUT_MINUTES=30
GIT_TIMEOUT_MINUTES=10
BUILD_CACHE_MAX_GB=8
SESSION_TTL_HOURS=24
LOG_LEVEL=info
EOF
  chmod 600 .env
  unset app_secret
  bootstrap_pending=1
  echo ".env wurde angelegt."
else
  chmod 600 .env
  if grep -q '^BOOTSTRAP_PENDING=1$' .env; then
    bootstrap_pending=1
  fi
  echo "Vorhandene .env wird verwendet."
fi

docker compose pull traefik cloudflared
docker compose build api worker

if [ "$bootstrap_pending" -eq 1 ] && ! grep -Eq '^(ADMIN_PASSWORD|ADMIN_PASSWORD_B64)=.+' .env; then
  prompt_bootstrap_password
fi

bootstrap_cleanup_required=0
if grep -Eq '^(ADMIN_PASSWORD|ADMIN_PASSWORD_B64|BOOTSTRAP_PENDING)=' .env; then
  bootstrap_cleanup_required=1
fi

docker compose up -d --force-recreate --no-deps api
wait_for_api

if [ "$bootstrap_cleanup_required" -eq 1 ]; then
  rewrite_env_without '^(ADMIN_PASSWORD|ADMIN_PASSWORD_B64|BOOTSTRAP_PENDING)='
  echo "Bootstrap-Zugangsdaten wurden aus .env entfernt."
  docker compose up -d --force-recreate --no-deps api
  wait_for_api
fi

docker compose up -d

echo ""
echo "Shelter läuft lokal auf dem VPS unter http://127.0.0.1:7080"
echo "Öffne von deinem Rechner einen SSH-Tunnel:"
echo "  ssh -L 7080:127.0.0.1:7080 USER@DEIN-VPS"
echo "Dann im Browser: http://127.0.0.1:7080"
echo "Cloudflare richtest du anschließend unter Einstellungen ein."
