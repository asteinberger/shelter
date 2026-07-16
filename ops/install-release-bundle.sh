#!/usr/bin/env sh
set -eu

umask 077

script_dir=$(CDPATH= cd -P "$(dirname "$0")" >/dev/null 2>&1 && pwd -P)
# shellcheck source=ops/lib/release-bundle.sh
. "$script_dir/lib/release-bundle.sh"

bundle_dir=$(CDPATH= cd -P "$script_dir/.." >/dev/null 2>&1 && pwd -P)
installation_dir=
dry_run=0
release_lock=
release_lock_token=
release_lock_acquired=0
release_lock_managed_externally=0
external_release_lock_token=${SHELTER_RELEASE_INSTALL_LOCK_TOKEN:-}
unset SHELTER_RELEASE_INSTALL_LOCK_TOKEN
sync_marker=
sync_temporary_file=

usage() {
  cat <<'EOF'
Usage: ops/install-release-bundle.sh [--bundle DIRECTORY]
  [--installation DIRECTORY] [--dry-run] [-- INSTALLER_OPTIONS...]

Verifies the release bundle, pulls the control-plane image by digest, creates a
digest-specific local image tag for Compose, and hands it to install.sh without
rebuilding. For an update downloaded into a separate immutable directory,
--installation selects the existing Shelter directory whose .env is preserved.
Options after -- are passed to install.sh unchanged.

Examples:
  ops/install-release-bundle.sh --dry-run
  ops/install-release-bundle.sh -- --non-interactive
  ops/install-release-bundle.sh --installation /opt/shelter -- --non-interactive
  ops/install-release-bundle.sh -- --non-interactive --no-pull
EOF
}

cleanup() {
  cleanup_status=$?
  trap - 0 1 2 15
  if [ -n "$sync_temporary_file" ]; then
    rm -f "$sync_temporary_file"
    sync_temporary_file=
  fi
  if [ "$release_lock_acquired" -eq 1 ] &&
     [ "$release_lock_managed_externally" -eq 0 ] &&
     [ -n "$release_lock" ]; then
    current_owner=
    if [ -f "$release_lock/owner" ]; then
      IFS= read -r current_owner < "$release_lock/owner" || true
    fi
    if [ "$current_owner" = "$release_lock_token" ]; then
      rm -f "$release_lock/pid" "$release_lock/owner" "$release_lock/kind"
      rmdir "$release_lock" 2>/dev/null || true
    fi
  fi
  exit "$cleanup_status"
}
trap cleanup 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle|--installation)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      case "$1" in
        --bundle) bundle_dir=$2 ;;
        --installation) installation_dir=$2 ;;
      esac
      shift
      ;;
    --bundle=*) bundle_dir=${1#*=} ;;
    --installation=*) installation_dir=${1#*=} ;;
    --dry-run) dry_run=1 ;;
    --)
      shift
      break
      ;;
    -h|--help) usage; exit 0 ;;
    *)
      usage >&2
      printf 'Error: unknown release-installer option: %s; place install.sh options after --\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

shelter_release_load "$bundle_dir"
verified_bundle_root=$SHELTER_RELEASE_BUNDLE_ROOT
verified_manifest_sha=$SHELTER_RELEASE_MANIFEST_SHA256
verified_version=$SHELTER_RELEASE_VERSION
verified_commit=$SHELTER_RELEASE_COMMIT
verified_source_image=$SHELTER_RELEASE_SOURCE_IMAGE
verified_local_image=$SHELTER_RELEASE_LOCAL_IMAGE
verified_revision=$SHELTER_RELEASE_REVISION

if [ -n "$installation_dir" ]; then
  installation_root=$(shelter_release_bundle_root "$installation_dir") || exit 1
else
  installation_root=$verified_bundle_root
fi
sync_release_payloads=0
if [ "$installation_root" != "$verified_bundle_root" ]; then
  sync_release_payloads=1
  [ -f "$installation_root/.env" ] && [ ! -L "$installation_root/.env" ] || {
    shelter_release_error "a separate --installation directory must contain its regular existing .env"
    exit 1
  }
fi

printf 'Shelter immutable release plan\n'
printf '  Version       %s\n' "$verified_version"
printf '  Commit        %s\n' "$verified_commit"
printf '  Source image  %s\n' "$verified_source_image"
printf '  Local image   %s\n' "$verified_local_image"
printf '  Installation  %s\n' "$installation_root"
if [ "$sync_release_payloads" -eq 1 ]; then
  printf '  Configuration preserve existing .env\n'
fi

if [ "$dry_run" -eq 1 ]; then
  printf 'Dry run complete; Docker and install.sh were not called.\n'
  exit 0
fi

command -v docker >/dev/null 2>&1 || {
  shelter_release_error "Docker is required to install a release bundle"
  exit 1
}
command -v openssl >/dev/null 2>&1 || {
  shelter_release_error "OpenSSL is required to create the installer operation lock"
  exit 1
}
[ -x "$verified_bundle_root/install.sh" ] || {
  shelter_release_error "the verified install.sh is not executable"
  exit 1
}

release_lock=$installation_root/.shelter-install.lock
if [ -L "$release_lock" ] || { [ -e "$release_lock" ] && [ ! -d "$release_lock" ]; }; then
  shelter_release_error "the installer lock path is unsafe: ${release_lock}"
  exit 1
fi
if [ -n "$external_release_lock_token" ]; then
  case "$external_release_lock_token" in
    *[!0-9a-f]*|'')
      shelter_release_error "the external release operation-lock token is invalid"
      exit 1
      ;;
  esac
  [ "${#external_release_lock_token}" -eq 32 ] || {
    shelter_release_error "the external release operation-lock token is invalid"
    exit 1
  }
  [ -d "$release_lock" ] || {
    shelter_release_error "the externally managed release operation lock is missing"
    exit 1
  }
  [ -f "$release_lock/owner" ] && [ ! -L "$release_lock/owner" ] ||
    {
      shelter_release_error "the externally managed release operation lock has an unsafe owner file"
      exit 1
    }
  [ -f "$release_lock/kind" ] && [ ! -L "$release_lock/kind" ] ||
    {
      shelter_release_error "the externally managed release operation lock has an unsafe kind file"
      exit 1
    }
  external_lock_owner=
  external_lock_kind=
  IFS= read -r external_lock_owner < "$release_lock/owner" || true
  IFS= read -r external_lock_kind < "$release_lock/kind" || true
  [ "$external_lock_owner" = "$external_release_lock_token" ] ||
    {
      shelter_release_error "the externally managed release operation lock has a different owner"
      exit 1
    }
  [ "$external_lock_kind" = release-deploy ] ||
    {
      shelter_release_error "the externally managed release operation lock has an invalid kind"
      exit 1
    }
  release_lock_token=$external_release_lock_token
  release_lock_acquired=1
  release_lock_managed_externally=1
  external_release_lock_token=
else
  release_lock_token=$(openssl rand -hex 16)
  case "$release_lock_token" in
    *[!0-9a-f]*|'')
      shelter_release_error "OpenSSL returned an invalid operation-lock token"
      exit 1
      ;;
  esac
  [ "${#release_lock_token}" -eq 32 ] || {
    shelter_release_error "OpenSSL returned an invalid operation-lock token"
    exit 1
  }
  if ! mkdir "$release_lock" 2>/dev/null; then
    shelter_release_error "another Shelter install, release, or deploy operation is active"
    exit 1
  fi
  release_lock_acquired=1
  if ! printf '%s\n' "$$" > "$release_lock/pid" ||
     ! printf '%s\n' "$release_lock_token" > "$release_lock/owner" ||
     ! printf '%s\n' release > "$release_lock/kind"; then
    shelter_release_error "the release operation lock could not be initialized"
    exit 1
  fi
fi

printf 'Pulling the verified image digest…\n'
docker pull "$verified_source_image"
pulled_image_id=$(docker image inspect --format '{{.Id}}' "$verified_source_image")
pulled_image_hex=${pulled_image_id#sha256:}
[ "$pulled_image_hex" != "$pulled_image_id" ] || {
  shelter_release_error "Docker did not return a sha256 image identity"
  exit 1
}
case "$pulled_image_hex" in
  *[!0-9a-f]*|'')
    shelter_release_error "Docker returned an invalid image identity"
    exit 1
    ;;
esac
[ "${#pulled_image_hex}" -eq 64 ] || {
  shelter_release_error "Docker returned an invalid image identity"
  exit 1
}

existing_local_id=$(docker image inspect --format '{{.Id}}' "$verified_local_image" 2>/dev/null || true)
if [ -n "$existing_local_id" ] && [ "$existing_local_id" != "$pulled_image_id" ]; then
  shelter_release_error "the digest-specific local image tag already points to different content"
  exit 1
fi
docker tag "$verified_source_image" "$verified_local_image"
tagged_image_id=$(docker image inspect --format '{{.Id}}' "$verified_local_image")
[ "$tagged_image_id" = "$pulled_image_id" ] || {
  shelter_release_error "the local release image identity does not match the pulled digest"
  exit 1
}

# Pulling can take time. Revalidate the complete bundle and its manifest before
# crossing into install.sh so a changed local payload fails closed.
shelter_release_load "$verified_bundle_root"
[ "$SHELTER_RELEASE_MANIFEST_SHA256" = "$verified_manifest_sha" ] &&
  [ "$SHELTER_RELEASE_VERSION" = "$verified_version" ] &&
  [ "$SHELTER_RELEASE_COMMIT" = "$verified_commit" ] &&
  [ "$SHELTER_RELEASE_SOURCE_IMAGE" = "$verified_source_image" ] &&
  [ "$SHELTER_RELEASE_LOCAL_IMAGE" = "$verified_local_image" ] || {
    shelter_release_error "the release bundle changed while its image was being prepared"
    exit 1
  }
tagged_image_id=$(docker image inspect --format '{{.Id}}' "$verified_local_image")
[ "$tagged_image_id" = "$pulled_image_id" ] || {
  shelter_release_error "the prepared local release image changed before installation"
  exit 1
}

copy_verified_payload() {
  copy_relative_path=$1
  copy_mode=$2
  copy_source=$verified_bundle_root/$copy_relative_path
  copy_target=$installation_root/$copy_relative_path
  case "$copy_relative_path" in
    */*) copy_parent=${copy_target%/*} ;;
    *) copy_parent=$installation_root ;;
  esac

  [ -f "$copy_source" ] && [ ! -L "$copy_source" ] || {
    shelter_release_error "verified payload disappeared: ${copy_relative_path}"
    return 1
  }
  if [ -L "$copy_parent" ] || { [ -e "$copy_parent" ] && [ ! -d "$copy_parent" ]; }; then
    shelter_release_error "release payload parent is unsafe: ${copy_parent}"
    return 1
  fi
  if [ ! -d "$copy_parent" ]; then
    mkdir "$copy_parent" || return 1
  fi
  if [ -L "$copy_target" ] || { [ -e "$copy_target" ] && [ ! -f "$copy_target" ]; }; then
    shelter_release_error "refusing to replace unsafe installation payload: ${copy_target}"
    return 1
  fi

  sync_temporary_file=$(mktemp "$copy_parent/.shelter-release-payload.XXXXXX") || return 1
  if ! cp "$copy_source" "$sync_temporary_file" ||
     ! chmod "$copy_mode" "$sync_temporary_file" ||
     ! mv "$sync_temporary_file" "$copy_target"; then
    rm -f "$sync_temporary_file"
    sync_temporary_file=
    return 1
  fi
  sync_temporary_file=
}

if [ "$sync_release_payloads" -eq 1 ]; then
  printf 'Synchronizing authenticated release payloads into %s…\n' "$installation_root"
  for required_command in cp chmod mktemp mv; do
    command -v "$required_command" >/dev/null 2>&1 || {
      shelter_release_error "${required_command} is required to update an existing installation"
      exit 1
    }
  done
  if [ -L "$installation_root/ops" ] || { [ -e "$installation_root/ops" ] && [ ! -d "$installation_root/ops" ]; }; then
    shelter_release_error "the installation ops directory is unsafe"
    exit 1
  fi
  [ -d "$installation_root/ops" ] || mkdir "$installation_root/ops"
  if [ -L "$installation_root/ops/lib" ] || { [ -e "$installation_root/ops/lib" ] && [ ! -d "$installation_root/ops/lib" ]; }; then
    shelter_release_error "the installation ops/lib directory is unsafe"
    exit 1
  fi
  [ -d "$installation_root/ops/lib" ] || mkdir "$installation_root/ops/lib"

  sync_marker=$installation_root/.shelter-release-sync-incomplete
  if [ -L "$sync_marker" ] || { [ -e "$sync_marker" ] && [ ! -f "$sync_marker" ]; }; then
    shelter_release_error "the release synchronization marker is unsafe"
    exit 1
  fi
  sync_temporary_file=$(mktemp "$installation_root/.shelter-release-sync.XXXXXX")
  printf '%s\n' "$release_lock_token" > "$sync_temporary_file"
  chmod 600 "$sync_temporary_file"
  mv "$sync_temporary_file" "$sync_marker"
  sync_temporary_file=

  copy_verified_payload .env.example 644 || exit 1
  copy_verified_payload compose.yaml 644 || exit 1
  copy_verified_payload install.sh 755 || exit 1
  copy_verified_payload ops/create-release-manifest.sh 755 || exit 1
  copy_verified_payload ops/download-release.sh 755 || exit 1
  copy_verified_payload ops/install-release-bundle.sh 755 || exit 1
  copy_verified_payload ops/verify-release-bundle.sh 755 || exit 1
  copy_verified_payload ops/lib/release-bundle.sh 644 || exit 1
  copy_verified_payload release.checksums 644 || exit 1
  copy_verified_payload release.manifest 644 || exit 1

  shelter_release_load "$installation_root"
  [ "$SHELTER_RELEASE_MANIFEST_SHA256" = "$verified_manifest_sha" ] &&
    [ "$SHELTER_RELEASE_SOURCE_IMAGE" = "$verified_source_image" ] &&
    [ "$SHELTER_RELEASE_LOCAL_IMAGE" = "$verified_local_image" ] || {
      shelter_release_error "the synchronized installation payload does not match the verified release"
      exit 1
    }
  marker_owner=
  IFS= read -r marker_owner < "$sync_marker" || true
  [ "$marker_owner" = "$release_lock_token" ] || {
    shelter_release_error "the release synchronization marker changed unexpectedly"
    exit 1
  }
  rm -f "$sync_marker"
  sync_marker=
  printf 'Authenticated release payloads synchronized; existing .env preserved.\n'
fi

printf 'Installing verified release %s…\n' "$verified_version"
SHELTER_INSTALL_LOCK_TOKEN=$release_lock_token \
SHELTER_INSTALL_PRELOADED_IMAGE=$verified_local_image \
SHELTER_INSTALL_PRELOADED_IMAGE_ID=$pulled_image_id \
SHELTER_INSTALL_RELEASE_REVISION=$verified_revision \
  "$installation_root/install.sh" "$@"

printf 'Shelter release %s installed from %s.\n' "$verified_version" "$verified_source_image"
