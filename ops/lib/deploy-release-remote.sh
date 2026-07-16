#!/usr/bin/env sh
set -eu

umask 077

action=${1:-}
installation=${2:-}
tag=${3:-}
token=${4:-}
expected_manifest_sha=${5:-}
dry_run=${6:-0}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

validate_inputs() {
  case "$installation" in
    /*) ;;
    *) fail "the installation must be an absolute path" ;;
  esac
  case "$installation" in
    /|*/|*//*|*/./*|*/.|*/../*|*/..|*[!A-Za-z0-9._/-]*) fail "the installation path is unsafe" ;;
  esac
  case "$tag" in
    *[!A-Za-z0-9.]*|*..*) fail "the release tag is unsafe" ;;
  esac
  case "$tag" in
    v*) ;;
    *) fail "the release tag must use vMAJOR.MINOR.PATCH" ;;
  esac
  tag_version=${tag#v}
  old_ifs=$IFS
  IFS=.
  # shellcheck disable=SC2086
  set -- $tag_version
  IFS=$old_ifs
  [ "$#" -eq 3 ] || fail "the release tag must use vMAJOR.MINOR.PATCH"
  for component in "$@"; do
    case "$component" in
      0) ;;
      [1-9]*)
        case "$component" in
          *[!0-9]*) fail "the release tag must use canonical numeric components" ;;
        esac
        ;;
      *) fail "the release tag must use canonical numeric components" ;;
    esac
  done
  case "$token" in
    *[!0-9a-f]*|'') fail "the operation token is invalid" ;;
  esac
  [ "${#token}" -eq 32 ] || fail "the operation token is invalid"
  case "$dry_run" in
    0|1) ;;
    *) fail "the dry-run flag is invalid" ;;
  esac
  if [ "$action" = activate ]; then
    case "$expected_manifest_sha" in
      *[!0-9a-f]*|'') fail "the expected manifest digest is invalid" ;;
    esac
    [ "${#expected_manifest_sha}" -eq 64 ] || fail "the expected manifest digest is invalid"
  fi
}

require_root() {
  [ "$(id -u)" = 0 ] || fail "verified release deployment requires a root SSH account"
}

path_is_directory() {
  [ -d "$1" ] && [ ! -L "$1" ]
}

lock_owner_matches() {
  [ -f "$operation_lock/owner" ] && [ ! -L "$operation_lock/owner" ] || return 1
  lock_owner=
  IFS= read -r lock_owner < "$operation_lock/owner" || true
  [ "$lock_owner" = "$token" ]
}

release_owned_operation() {
  operation_entry=
  lock_owner_matches || fail "the shared Shelter operation lock is no longer owned by this process"
  if path_is_directory "$stage"; then
    rm -rf "$stage"
  elif [ -e "$stage" ] || [ -L "$stage" ]; then
    fail "refusing to remove an unsafe incoming release stage"
  fi
  for operation_entry in \
    "$operation_lock"/* \
    "$operation_lock"/.[!.]* \
    "$operation_lock"/..?*
  do
    [ -e "$operation_entry" ] || [ -L "$operation_entry" ] || continue
    case "$operation_entry" in
      "$operation_lock/owner"|"$operation_lock/pid"|"$operation_lock/kind") ;;
      *) fail "the shared Shelter operation lock contains an unexpected entry" ;;
    esac
  done
  rm -f "$operation_lock/pid" "$operation_lock/owner" "$operation_lock/kind" ||
    fail "the shared Shelter operation lock files could not be removed"
  rmdir "$operation_lock" ||
    fail "the shared Shelter operation lock directory could not be removed"
}

validate_inputs
require_root

install_lock=$installation/.shelter-install.lock
releases=$installation/releases
incoming=$releases/.incoming
operation_lock=$install_lock
stage=$incoming/${tag}-${token}
final=$releases/$tag

case "$action" in
  prepare)
    path_is_directory "$installation" || fail "the Shelter installation is missing or unsafe: ${installation}"
    [ -f "$installation/.env" ] && [ ! -L "$installation/.env" ] ||
      fail "the Shelter installation must contain a regular existing .env"
    if [ -L "$releases" ] || { [ -e "$releases" ] && [ ! -d "$releases" ]; }; then
      fail "the release directory is unsafe"
    fi
    if [ -L "$incoming" ] || { [ -e "$incoming" ] && [ ! -d "$incoming" ]; }; then
      fail "the incoming release directory is unsafe"
    fi
    mkdir -p "$releases" "$incoming"
    chown root:root "$releases" "$incoming"
    chmod 700 "$releases" "$incoming"
    if [ -L "$operation_lock" ] || { [ -e "$operation_lock" ] && [ ! -d "$operation_lock" ]; }; then
      fail "the shared Shelter operation lock is unsafe"
    fi
    if ! mkdir "$operation_lock" 2>/dev/null; then
      fail "another Shelter install, source deploy, release deploy, or rollback is active"
    fi
    if ! printf '%s\n' "$token" > "$operation_lock/owner" ||
       ! printf '%s\n' "$$" > "$operation_lock/pid" ||
       ! printf '%s\n' release-deploy > "$operation_lock/kind"; then
      rm -f "$operation_lock/owner" "$operation_lock/pid" "$operation_lock/kind"
      rmdir "$operation_lock" 2>/dev/null || true
      fail "the shared Shelter operation lock could not be initialized"
    fi
    if [ -e "$stage" ] || [ -L "$stage" ]; then
      rm -f "$operation_lock/owner" "$operation_lock/pid" "$operation_lock/kind"
      rmdir "$operation_lock" 2>/dev/null || true
      fail "the incoming release stage already exists"
    fi
    mkdir "$stage"
    chown root:root "$stage"
    chmod 700 "$stage"
    ;;

  activate)
    path_is_directory "$incoming" || fail "the incoming release directory is missing or unsafe"
    lock_owner_matches || fail "the shared Shelter operation lock is not owned by this process"
    path_is_directory "$stage" || fail "the incoming release bundle is missing or unsafe"
    [ -x "$stage/ops/verify-release-bundle.sh" ] || fail "the incoming release verifier is missing"
    [ -x "$stage/ops/install-release-bundle.sh" ] || fail "the incoming release installer is missing"

    command -v shelter_release_load >/dev/null 2>&1 ||
      fail "the trusted release verification library was not provided"
    # shelter_release_load is sent from the trusted local checkout, ahead of
    # this helper. It validates the manifest and every payload before any
    # uploaded script is executed.
    shelter_release_load "$stage"
    [ "$SHELTER_RELEASE_MANIFEST_SHA256" = "$expected_manifest_sha" ] ||
      fail "the remote release manifest differs from the locally authenticated bundle"
    [ "$tag" = "v${SHELTER_RELEASE_VERSION}" ] ||
      fail "the remote release version does not match the requested tag"
    "$stage/ops/verify-release-bundle.sh" --bundle "$stage" --quiet

    "$stage/ops/install-release-bundle.sh" \
      --bundle "$stage" \
      --installation "$installation" \
      --dry-run \
      -- --non-interactive

    if [ "$dry_run" -eq 1 ]; then
      release_owned_operation
      printf 'Remote release verification and installer dry run completed.\n'
      exit 0
    fi

    if [ -L "$final" ] || { [ -e "$final" ] && [ ! -d "$final" ]; }; then
      fail "the immutable release destination is unsafe"
    fi
    if [ -d "$final" ]; then
      [ -x "$final/ops/verify-release-bundle.sh" ] ||
        fail "the existing immutable release is incomplete"
      shelter_release_load "$final"
      [ "$SHELTER_RELEASE_MANIFEST_SHA256" = "$expected_manifest_sha" ] ||
        fail "the immutable release tag already contains different content"
      [ "$tag" = "v${SHELTER_RELEASE_VERSION}" ] ||
        fail "the existing immutable release version does not match its directory"
      "$final/ops/verify-release-bundle.sh" --bundle "$final" --quiet
      rm -rf "$stage"
      printf 'Reusing existing verified immutable release %s.\n' "$tag"
    else
      chown -R root:root "$stage"
      chmod -R go-rwx "$stage"
      mv "$stage" "$final"
      shelter_release_load "$final"
      [ "$SHELTER_RELEASE_MANIFEST_SHA256" = "$expected_manifest_sha" ] ||
        fail "the published immutable release failed post-rename verification"
      "$final/ops/verify-release-bundle.sh" --bundle "$final" --quiet
      printf 'Published immutable release directory %s.\n' "$final"
    fi

    SHELTER_RELEASE_INSTALL_LOCK_TOKEN=$token \
      "$final/ops/install-release-bundle.sh" \
      --bundle "$final" \
      --installation "$installation" \
      -- --non-interactive
    "$installation/install.sh" doctor
    release_owned_operation
    ;;

  cleanup)
    if lock_owner_matches; then
      release_owned_operation
    fi
    ;;

  *) fail "unknown remote release action" ;;
esac
