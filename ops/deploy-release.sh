#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPOSITORY_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
readonly REMOTE_HELPER="$SCRIPT_DIR/lib/deploy-release-remote.sh"
# shellcheck source=ops/lib/server-connection.sh
source "$SCRIPT_DIR/lib/server-connection.sh"
# shellcheck source=ops/lib/release-bundle.sh
source "$SCRIPT_DIR/lib/release-bundle.sh"

server_env_file="${SHELTER_SERVER_ENV_FILE:-${PORTSMITH_SERVER_ENV_FILE:-$REPOSITORY_DIR/.env.server}}"
repository_argument=
tag=
dry_run=0
local_temporary_directory=
remote_lock_acquired=0
operation_token=
remote_stage=

usage() {
  cat <<'USAGE'
Usage: ops/deploy-release.sh --tag vMAJOR.MINOR.PATCH [OPTIONS]

Downloads and authenticates an immutable Shelter GitHub Release locally,
transports only that verified bundle to a root-owned VPS staging directory,
verifies it again remotely, atomically publishes /opt/shelter/releases/TAG,
installs it by OCI digest, and runs Shelter doctor.

Options:
  --tag TAG          Required immutable release tag, for example v0.3.0.
  --server-env FILE  Read VPS access from FILE instead of .env.server.
  --repo OWNER/REPO  GitHub repository (default: raum-so/shelter).
  --dry-run          Verify locally and remotely and run the remote installer
                     dry run. Temporary staging is removed; no release is
                     published or installed.
  -h, --help         Show this help.

The server file must be a regular operator-only file (mode 0600 or stricter).
The verified-release workflow intentionally requires SHELTER_SERVER_PATH to be
/opt/shelter and the SSH account to be root. SSH keys are preferred; the same
protected SSH_ASKPASS and ControlMaster fallback as ops/deploy.sh is supported.
USAGE
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

run_remote_action() {
  local action=$1
  local expected_manifest_sha=${2:-}
  local remote_dry_run=${3:-0}
  local remote_command
  remote_command="sh -s -- $(shelter_server_shell_join \
    "$action" \
    "$SHELTER_SERVER_PATH" \
    "$tag" \
    "$operation_token" \
    "$expected_manifest_sha" \
    "$remote_dry_run")"
  # Send the trusted local checksum parser together with the remote workflow.
  # The remote side never has to source unverified code from the upload.
  cat "$SCRIPT_DIR/lib/release-bundle.sh" "$REMOTE_HELPER" |
    "${SHELTER_SERVER_SSH_ARGS[@]}" "$SHELTER_SERVER_SSH_TARGET" "$remote_command"
}

cleanup() {
  local cleanup_status=$?
  trap - EXIT HUP INT TERM
  if ((remote_lock_acquired)) && [[ -n "${SHELTER_SERVER_SSH_TARGET:-}" ]]; then
    run_remote_action cleanup >/dev/null 2>&1 || true
  fi
  if [[ -n "$local_temporary_directory" ]]; then
    rm -rf -- "$local_temporary_directory"
  fi
  shelter_server_connection_cleanup
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

while (($#)); do
  case "$1" in
    --tag|--server-env|--repo)
      (($# >= 2)) || { usage >&2; exit 2; }
      case "$1" in
        --tag) tag=$2 ;;
        --server-env) server_env_file=$2 ;;
        --repo) repository_argument=$2 ;;
      esac
      shift
      ;;
    --tag=*) tag=${1#*=} ;;
    --server-env=*) server_env_file=${1#*=} ;;
    --repo=*) repository_argument=${1#*=} ;;
    --dry-run) dry_run=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; printf 'Error: unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

[[ -n "$tag" ]] || { usage >&2; printf 'Error: --tag is required.\n' >&2; exit 2; }
if [[ ! "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  fail "--tag must use canonical vMAJOR.MINOR.PATCH without a prerelease or build suffix."
fi
[[ -x "$SCRIPT_DIR/download-release.sh" ]] || fail "The trusted local release downloader is missing or not executable."
[[ -f "$REMOTE_HELPER" && ! -L "$REMOTE_HELPER" ]] || fail "The trusted remote release helper is missing or unsafe."

shelter_server_connection_init "$server_env_file" shelter-release-deploy || exit 1
[[ "$SHELTER_SERVER_PATH" == /opt/shelter ]] ||
  fail "Verified releases are installed only at /opt/shelter; SHELTER_SERVER_PATH currently points elsewhere."

repository="${repository_argument:-${SHELTER_RELEASE_REPOSITORY:-raum-so/shelter}}"
case "$repository" in
  */*) ;;
  *) fail "--repo must use OWNER/REPOSITORY." ;;
esac
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
  fail "--repo contains unsupported characters."
[[ "$repository" != *..* ]] || fail "--repo contains an unsafe dot sequence."

for required_command in gh openssl rsync ssh; do
  command -v "$required_command" >/dev/null 2>&1 || fail "$required_command is required."
done

local_temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/shelter-release-deploy.XXXXXX")
chmod 700 "$local_temporary_directory"
local_bundle="$local_temporary_directory/bundle"

printf 'Authenticating immutable Shelter release %s from %s locally…\n' "$tag" "$repository"
"$SCRIPT_DIR/download-release.sh" \
  --repo "$repository" \
  --tag "$tag" \
  --destination "$local_bundle"

shelter_release_load "$local_bundle"
[[ "$tag" == "v${SHELTER_RELEASE_VERSION}" ]] ||
  fail "The authenticated bundle version does not match $tag."
local_manifest_sha="$SHELTER_RELEASE_MANIFEST_SHA256"
[[ "$local_manifest_sha" =~ ^[0-9a-f]{64}$ ]] || fail "The authenticated manifest digest is invalid."

operation_token=$(openssl rand -hex 16)
[[ "$operation_token" =~ ^[0-9a-f]{32}$ ]] || fail "OpenSSL returned an invalid operation token."
remote_stage="$SHELTER_SERVER_PATH/releases/.incoming/${tag}-${operation_token}"

printf 'Preparing protected release staging on %s…\n' "$SHELTER_SERVER_HOST"
remote_lock_acquired=1
run_remote_action prepare

rsync_target="${SHELTER_SERVER_RSYNC_HOST}:${remote_stage}/"
rsync_args=(
  -rlpt
  --delete
  --itemize-changes
  --rsh="$SHELTER_SERVER_RSYNC_RSH"
)
printf 'Transporting the authenticated bundle to the protected incoming directory…\n'
rsync "${rsync_args[@]}" "$local_bundle/" "$rsync_target"

printf 'Re-verifying the release bundle and installer plan on the VPS…\n'
run_remote_action activate "$local_manifest_sha" "$dry_run"
remote_lock_acquired=0

if ((dry_run)); then
  printf 'Verified-release dry run completed; no release was published or installed.\n'
else
  printf 'Shelter %s was installed and doctor completed successfully.\n' "$tag"
fi
