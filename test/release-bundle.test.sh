#!/usr/bin/env bash

set -uo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
TEST_SHELL=${SHELTER_RELEASE_TEST_SHELL:-$(command -v dash || command -v sh)}
TEST_VERSION=1.2.3
TEST_COMMIT=1111111111111111111111111111111111111111
TEST_IMAGE_REFERENCE=ghcr.io/example/shelter:v1.2.3
TEST_IMAGE_DIGEST=sha256:2222222222222222222222222222222222222222222222222222222222222222
TEST_IMAGE_ID=sha256:3333333333333333333333333333333333333333333333333333333333333333
TEST_LOCAL_IMAGE=shelter/control-plane:release-2222222222222222222222222222222222222222222222222222222222222222

passed=0
failed=0

fail_test() {
  printf '       assertion failed: %s\n' "$1" >&2
  exit 1
}

assert_status() {
  local expected=$1
  [[ "$COMMAND_STATUS" -eq "$expected" ]] ||
    fail_test "expected status ${expected}, got ${COMMAND_STATUS}; output: $(tr '\n' ' ' < "$COMMAND_OUTPUT")"
}

assert_contains() {
  local file=$1
  local expected=$2
  grep -Fq -- "$expected" "$file" || fail_test "${file} does not contain: ${expected}"
}

assert_not_contains() {
  local file=$1
  local unexpected=$2
  if grep -Fq -- "$unexpected" "$file"; then
    fail_test "${file} unexpectedly contains: ${unexpected}"
  fi
}

assert_absent() {
  [[ ! -e "$1" ]] || fail_test "expected no path at $1"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    openssl dgst -sha256 "$1" | awk '{ print $NF }'
  fi
}

setup_sandbox() {
  TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/shelter-release-test.XXXXXX")
  BUNDLE=$TEST_TMP/bundle
  MOCK_BIN=$TEST_TMP/bin
  MOCK_DOCKER_LOG=$TEST_TMP/docker.log
  MOCK_GH_LOG=$TEST_TMP/gh.log
  MOCK_INSTALL_LOG=$TEST_TMP/install.log
  MOCK_STATE_DIR=$TEST_TMP/state
  COMMAND_OUTPUT=$TEST_TMP/output.log
  mkdir -p "$BUNDLE/ops/lib" "$MOCK_BIN" "$MOCK_STATE_DIR"
  cp "$REPO_ROOT/.env.example" "$BUNDLE/.env.example"
  cp "$REPO_ROOT/compose.yaml" "$BUNDLE/compose.yaml"
  cp "$REPO_ROOT/ops/create-release-manifest.sh" "$BUNDLE/ops/create-release-manifest.sh"
  cp "$REPO_ROOT/ops/download-release.sh" "$BUNDLE/ops/download-release.sh"
  cp "$REPO_ROOT/ops/install-release-bundle.sh" "$BUNDLE/ops/install-release-bundle.sh"
  cp "$REPO_ROOT/ops/verify-release-bundle.sh" "$BUNDLE/ops/verify-release-bundle.sh"
  cp "$REPO_ROOT/ops/lib/release-bundle.sh" "$BUNDLE/ops/lib/release-bundle.sh"

  cat > "$BUNDLE/install.sh" <<'EOF'
#!/bin/sh
set -eu
root=$(CDPATH= cd -P "$(dirname "$0")" >/dev/null 2>&1 && pwd -P)
[ -d "$root/.shelter-install.lock" ]
[ "$(cat "$root/.shelter-install.lock/owner")" = "$SHELTER_INSTALL_LOCK_TOKEN" ]
{
  printf 'IMAGE=%s\n' "$SHELTER_INSTALL_PRELOADED_IMAGE"
  printf 'IMAGE_ID=%s\n' "$SHELTER_INSTALL_PRELOADED_IMAGE_ID"
  printf 'REVISION=%s\n' "$SHELTER_INSTALL_RELEASE_REVISION"
  printf 'ARGS='
  printf '<%s>' "$@"
  printf '\n'
} > "$MOCK_INSTALL_LOG"
EOF

  cat > "$MOCK_BIN/docker" <<'EOF'
#!/bin/sh
set -u
printf '%s\n' "$*" >> "$MOCK_DOCKER_LOG"
case "$1 ${2:-}" in
  'pull '*)
    if [ "${MOCK_DOCKER_MUTATE_BUNDLE:-0}" -eq 1 ]; then
      printf '\nchanged-during-pull\n' >> "$MOCK_BUNDLE/compose.yaml"
    fi
    [ "${MOCK_DOCKER_FAIL_PULL:-0}" -eq 0 ] || exit 42
    ;;
  'image inspect')
    reference=${5:-}
    if [ "$reference" = "$MOCK_SOURCE_IMAGE" ]; then
      printf '%s\n' "$MOCK_IMAGE_ID"
    elif [ "$reference" = "$MOCK_LOCAL_IMAGE" ]; then
      if [ "${MOCK_LOCAL_COLLISION:-0}" -eq 1 ]; then
        printf 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
      elif [ -f "$MOCK_STATE_DIR/tagged" ]; then
        printf '%s\n' "$MOCK_IMAGE_ID"
      else
        exit 1
      fi
    else
      printf 'unexpected inspect reference: %s\n' "$reference" >&2
      exit 98
    fi
    ;;
  'tag '*)
    [ "$2" = "$MOCK_SOURCE_IMAGE" ] && [ "$3" = "$MOCK_LOCAL_IMAGE" ] || exit 97
    : > "$MOCK_STATE_DIR/tagged"
    ;;
  *)
    printf 'unexpected Docker invocation: %s\n' "$*" >&2
    exit 99
    ;;
esac
EOF

  cat > "$MOCK_BIN/gh" <<'EOF'
#!/bin/sh
set -u
printf '%s\n' "$*" >> "$MOCK_GH_LOG"
[ "${1:-}" = release ] || exit 99
case "${2:-}" in
  verify)
    [ "${MOCK_GH_FAIL_RELEASE:-0}" -eq 0 ] || exit 41
    ;;
  download)
    [ "${MOCK_GH_FAIL_DOWNLOAD:-0}" -eq 0 ] || exit 42
    output=
    shift 2
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --output ]; then
        output=$2
        shift
      fi
      shift
    done
    [ -n "$output" ] && [ -f "$MOCK_RELEASE_ASSET" ] || exit 98
    cp "$MOCK_RELEASE_ASSET" "$output"
    ;;
  verify-asset)
    [ "${MOCK_GH_FAIL_ASSET:-0}" -eq 0 ] || exit 43
    [ -f "${4:-}" ] || exit 97
    ;;
  *) exit 96 ;;
esac
EOF

  chmod 0755 "$BUNDLE/install.sh" "$BUNDLE/ops/create-release-manifest.sh" \
    "$BUNDLE/ops/download-release.sh" "$BUNDLE/ops/install-release-bundle.sh" \
    "$BUNDLE/ops/verify-release-bundle.sh" "$MOCK_BIN/docker" "$MOCK_BIN/gh"
  : > "$MOCK_DOCKER_LOG"
  : > "$MOCK_GH_LOG"
  : > "$COMMAND_OUTPUT"

  export MOCK_BUNDLE=$BUNDLE MOCK_DOCKER_LOG MOCK_GH_LOG MOCK_INSTALL_LOG MOCK_STATE_DIR
  export MOCK_SOURCE_IMAGE="${TEST_IMAGE_REFERENCE}@${TEST_IMAGE_DIGEST}"
  export MOCK_LOCAL_IMAGE=$TEST_LOCAL_IMAGE MOCK_IMAGE_ID=$TEST_IMAGE_ID
  export MOCK_DOCKER_FAIL_PULL=0 MOCK_DOCKER_MUTATE_BUNDLE=0 MOCK_LOCAL_COLLISION=0
  export MOCK_GH_FAIL_RELEASE=0 MOCK_GH_FAIL_DOWNLOAD=0 MOCK_GH_FAIL_ASSET=0
  export MOCK_RELEASE_ASSET=
}

cleanup_sandbox() {
  rm -rf "$TEST_TMP"
}

create_bundle() {
  PATH="$MOCK_BIN:$PATH" "$BUNDLE/ops/create-release-manifest.sh" \
    --bundle "$BUNDLE" \
    --version "$TEST_VERSION" \
    --commit "$TEST_COMMIT" \
    --image-reference "$TEST_IMAGE_REFERENCE" \
    --image-digest "$TEST_IMAGE_DIGEST" \
    > "$COMMAND_OUTPUT" 2>&1 || fail_test "manifest creation failed: $(cat "$COMMAND_OUTPUT")"
}

refresh_manifest_checksum() {
  local checksum
  checksum=$(sha256_file "$BUNDLE/release.checksums")
  awk -v checksum="$checksum" '
    /^CHECKSUMS_SHA256=/ { print "CHECKSUMS_SHA256=" checksum; next }
    { print }
  ' "$BUNDLE/release.manifest" > "$BUNDLE/release.manifest.tmp"
  mv "$BUNDLE/release.manifest.tmp" "$BUNDLE/release.manifest"
}

run_command() {
  set +e
  PATH="$MOCK_BIN:$PATH" "$@" > "$COMMAND_OUTPUT" 2>&1
  COMMAND_STATUS=$?
  set -e
}

test_posix_syntax() {
  "$TEST_SHELL" -n "$REPO_ROOT/ops/lib/release-bundle.sh"
  "$TEST_SHELL" -n "$REPO_ROOT/ops/create-release-manifest.sh"
  "$TEST_SHELL" -n "$REPO_ROOT/ops/download-release.sh"
  "$TEST_SHELL" -n "$REPO_ROOT/ops/verify-release-bundle.sh"
  "$TEST_SHELL" -n "$REPO_ROOT/ops/install-release-bundle.sh"
}

prepare_download_asset() {
  create_bundle
  MOCK_RELEASE_ASSET=$TEST_TMP/shelter-v1.2.3.tar.gz
  export MOCK_RELEASE_ASSET
  tar -czf "$MOCK_RELEASE_ASSET" -C "$BUNDLE" .
  mkdir -p "$TEST_TMP/releases"
}

test_download_verifies_release_and_asset_before_publish() {
  prepare_download_asset
  destination=$TEST_TMP/releases/v1.2.3
  run_command "$REPO_ROOT/ops/download-release.sh" \
    --repo example/shelter --tag v1.2.3 --asset shelter-v1.2.3.tar.gz --destination "$destination"
  assert_status 0
  [[ -f "$destination/release.manifest" ]] || fail_test 'verified release destination was not published'
  assert_contains "$MOCK_GH_LOG" 'release verify v1.2.3 --repo example/shelter'
  assert_contains "$MOCK_GH_LOG" 'release download v1.2.3 --repo example/shelter --pattern shelter-v1.2.3.tar.gz --output'
  assert_contains "$MOCK_GH_LOG" 'release verify-asset v1.2.3'
  local release_line download_line asset_line
  release_line=$(grep -nF 'release verify v1.2.3' "$MOCK_GH_LOG" | cut -d: -f1)
  download_line=$(grep -nF 'release download v1.2.3' "$MOCK_GH_LOG" | cut -d: -f1)
  asset_line=$(grep -nF 'release verify-asset v1.2.3' "$MOCK_GH_LOG" | cut -d: -f1)
  [[ "$release_line" -lt "$download_line" && "$download_line" -lt "$asset_line" ]] || fail_test 'GitHub verification order is wrong'
  expected_destination=$(CDPATH= cd -P "$TEST_TMP/releases" && pwd -P)/v1.2.3
  assert_contains "$COMMAND_OUTPUT" "Shelter release downloaded and verified at ${expected_destination}"
}

test_download_fails_closed_on_attestation_errors() {
  prepare_download_asset
  destination=$TEST_TMP/releases/v1.2.3
  MOCK_GH_FAIL_RELEASE=1
  export MOCK_GH_FAIL_RELEASE
  run_command "$REPO_ROOT/ops/download-release.sh" \
    --repo example/shelter --tag v1.2.3 --destination "$destination"
  assert_status 41
  assert_not_contains "$MOCK_GH_LOG" 'release download'
  assert_absent "$destination"

  : > "$MOCK_GH_LOG"
  MOCK_GH_FAIL_RELEASE=0
  MOCK_GH_FAIL_ASSET=1
  export MOCK_GH_FAIL_RELEASE MOCK_GH_FAIL_ASSET
  run_command "$REPO_ROOT/ops/download-release.sh" \
    --repo example/shelter --tag v1.2.3 --destination "$destination"
  assert_status 43
  assert_contains "$MOCK_GH_LOG" 'release verify-asset v1.2.3'
  assert_absent "$destination"
  [[ -z "$(find "$TEST_TMP/releases" -maxdepth 1 -name '.shelter-release-download.*' -print -quit)" ]] ||
    fail_test 'failed download retained a staging directory'
}

test_download_rejects_links_before_extraction() {
  mkdir -p "$TEST_TMP/malicious" "$TEST_TMP/releases"
  ln -s /etc/passwd "$TEST_TMP/malicious/escape"
  MOCK_RELEASE_ASSET=$TEST_TMP/shelter-v1.2.3.tar.gz
  export MOCK_RELEASE_ASSET
  tar -czf "$MOCK_RELEASE_ASSET" -C "$TEST_TMP/malicious" .
  destination=$TEST_TMP/releases/v1.2.3
  run_command "$REPO_ROOT/ops/download-release.sh" \
    --repo example/shelter --tag v1.2.3 --destination "$destination"
  assert_status 1
  assert_contains "$COMMAND_OUTPUT" 'contains a link, device, or unsupported entry type'
  assert_absent "$destination"
}

test_download_binds_bundle_to_repository_and_tag() {
  prepare_download_asset
  awk '
    /^IMAGE_REFERENCE=/ {
      print "IMAGE_REFERENCE=ghcr.io/example/other:v1.2.3"
      next
    }
    { print }
  ' "$BUNDLE/release.manifest" > "$BUNDLE/release.manifest.tmp"
  mv "$BUNDLE/release.manifest.tmp" "$BUNDLE/release.manifest"
  tar -czf "$MOCK_RELEASE_ASSET" -C "$BUNDLE" .

  destination=$TEST_TMP/releases/v1.2.3
  run_command "$REPO_ROOT/ops/download-release.sh" \
    --repo example/shelter --tag v1.2.3 --destination "$destination"
  assert_status 1
  assert_contains "$COMMAND_OUTPUT" 'bundle image does not belong to the verified GitHub repository and tag'
  assert_absent "$destination"
}

test_create_and_verify_bundle() {
  create_bundle
  [[ -f "$BUNDLE/release.manifest" && -f "$BUNDLE/release.checksums" ]] || fail_test 'release metadata was not created'
  run_command "$BUNDLE/ops/verify-release-bundle.sh" --bundle "$BUNDLE"
  assert_status 0
  assert_contains "$COMMAND_OUTPUT" 'Shelter release bundle verified.'
  assert_contains "$COMMAND_OUTPUT" "Version       ${TEST_VERSION}"
  assert_contains "$COMMAND_OUTPUT" "Source image  ${TEST_IMAGE_REFERENCE}@${TEST_IMAGE_DIGEST}"

  run_command "$BUNDLE/ops/verify-release-bundle.sh" --bundle "$BUNDLE" --quiet
  assert_status 0
  [[ ! -s "$COMMAND_OUTPUT" ]] || fail_test '--quiet produced output'
  [[ ! -s "$MOCK_DOCKER_LOG" ]] || fail_test 'verification must not contact Docker'
}

test_manifest_schema_is_fail_closed() {
  create_bundle
  printf 'UNSUPPORTED=value\n' >> "$BUNDLE/release.manifest"
  run_command "$BUNDLE/ops/verify-release-bundle.sh" --bundle "$BUNDLE"
  assert_status 1
  assert_contains "$COMMAND_OUTPUT" 'unsupported key: UNSUPPORTED'

  create_bundle
  printf 'VERSION=9.9.9\n' >> "$BUNDLE/release.manifest"
  run_command "$BUNDLE/ops/verify-release-bundle.sh" --bundle "$BUNDLE"
  assert_status 1
  assert_contains "$COMMAND_OUTPUT" 'duplicate VERSION'

  rm -f "$BUNDLE/release.manifest" "$BUNDLE/release.checksums"
  run_command "$BUNDLE/ops/create-release-manifest.sh" --bundle "$BUNDLE" \
    --version 01.2.3 --commit "$TEST_COMMIT" \
    --image-reference "$TEST_IMAGE_REFERENCE" --image-digest "$TEST_IMAGE_DIGEST"
  assert_status 1
  assert_contains "$COMMAND_OUTPUT" 'VERSION must be a canonical SemVer value'
  assert_absent "$BUNDLE/release.manifest"

  run_command "$BUNDLE/ops/create-release-manifest.sh" --bundle "$BUNDLE" \
    --version 1.2.3-01 --commit "$TEST_COMMIT" \
    --image-reference "$TEST_IMAGE_REFERENCE" --image-digest "$TEST_IMAGE_DIGEST"
  assert_status 1
  assert_contains "$COMMAND_OUTPUT" 'numeric SemVer prerelease identifiers must not contain leading zeroes'
  assert_absent "$BUNDLE/release.manifest"
}

test_payload_checksums_and_symlinks_are_rejected() {
  create_bundle
  printf '\nmodified\n' >> "$BUNDLE/compose.yaml"
  run_command "$BUNDLE/ops/verify-release-bundle.sh" --bundle "$BUNDLE"
  assert_status 1
  assert_contains "$COMMAND_OUTPUT" 'checksum mismatch: compose.yaml'

  cp "$REPO_ROOT/compose.yaml" "$BUNDLE/compose.yaml"
  create_bundle
  rm "$BUNDLE/install.sh"
  ln -s /bin/true "$BUNDLE/install.sh"
  run_command "$BUNDLE/ops/verify-release-bundle.sh" --bundle "$BUNDLE"
  assert_status 1
  assert_contains "$COMMAND_OUTPUT" 'install.sh must be a regular file, not a symbolic link'
}

test_unsafe_checksum_paths_are_rejected() {
  create_bundle
  printf '%064d  ../outside\n' 0 >> "$BUNDLE/release.checksums"
  refresh_manifest_checksum
  run_command "$BUNDLE/ops/verify-release-bundle.sh" --bundle "$BUNDLE"
  assert_status 1
  assert_contains "$COMMAND_OUTPUT" 'release.checksums contains an unsafe path'
}

test_dry_run_has_no_side_effects() {
  create_bundle
  run_command "$BUNDLE/ops/install-release-bundle.sh" --bundle "$BUNDLE" --dry-run
  assert_status 0
  assert_contains "$COMMAND_OUTPUT" 'Shelter immutable release plan'
  assert_contains "$COMMAND_OUTPUT" 'Dry run complete'
  [[ ! -s "$MOCK_DOCKER_LOG" ]] || fail_test 'dry-run contacted Docker'
  assert_absent "$MOCK_INSTALL_LOG"
  assert_absent "$BUNDLE/.shelter-install.lock"
}

test_installer_pulls_digest_and_passes_verified_identity() {
  create_bundle
  run_command "$BUNDLE/ops/install-release-bundle.sh" --bundle "$BUNDLE" -- --non-interactive --no-pull
  assert_status 0
  assert_contains "$MOCK_DOCKER_LOG" "pull ${TEST_IMAGE_REFERENCE}@${TEST_IMAGE_DIGEST}"
  assert_contains "$MOCK_DOCKER_LOG" "tag ${TEST_IMAGE_REFERENCE}@${TEST_IMAGE_DIGEST} ${TEST_LOCAL_IMAGE}"
  assert_contains "$MOCK_INSTALL_LOG" "IMAGE=${TEST_LOCAL_IMAGE}"
  assert_contains "$MOCK_INSTALL_LOG" "IMAGE_ID=${TEST_IMAGE_ID}"
  assert_contains "$MOCK_INSTALL_LOG" "REVISION=release:${TEST_VERSION}-${TEST_COMMIT}"
  assert_contains "$MOCK_INSTALL_LOG" 'ARGS=<--non-interactive><--no-pull>'
  assert_contains "$COMMAND_OUTPUT" "Shelter release ${TEST_VERSION} installed"
  assert_absent "$BUNDLE/.shelter-install.lock"
}

test_pull_and_local_tag_failures_do_not_run_installer() {
  create_bundle
  MOCK_DOCKER_FAIL_PULL=1
  export MOCK_DOCKER_FAIL_PULL
  run_command "$BUNDLE/ops/install-release-bundle.sh" --bundle "$BUNDLE" -- --non-interactive
  assert_status 42
  assert_absent "$MOCK_INSTALL_LOG"
  assert_absent "$BUNDLE/.shelter-install.lock"

  : > "$MOCK_DOCKER_LOG"
  MOCK_DOCKER_FAIL_PULL=0
  MOCK_LOCAL_COLLISION=1
  export MOCK_DOCKER_FAIL_PULL MOCK_LOCAL_COLLISION
  run_command "$BUNDLE/ops/install-release-bundle.sh" --bundle "$BUNDLE" -- --non-interactive
  assert_status 1
  assert_contains "$COMMAND_OUTPUT" 'already points to different content'
  assert_not_contains "$MOCK_DOCKER_LOG" "tag ${TEST_IMAGE_REFERENCE}@${TEST_IMAGE_DIGEST}"
  assert_absent "$MOCK_INSTALL_LOG"
  assert_absent "$BUNDLE/.shelter-install.lock"
}

test_bundle_is_revalidated_after_pull() {
  create_bundle
  MOCK_DOCKER_MUTATE_BUNDLE=1
  export MOCK_DOCKER_MUTATE_BUNDLE
  run_command "$BUNDLE/ops/install-release-bundle.sh" --bundle "$BUNDLE" -- --non-interactive
  assert_status 1
  assert_contains "$COMMAND_OUTPUT" 'checksum mismatch: compose.yaml'
  assert_absent "$MOCK_INSTALL_LOG"
  assert_absent "$BUNDLE/.shelter-install.lock"
}

test_separate_installation_preserves_env_and_uses_central_lock() {
  create_bundle
  installation=$TEST_TMP/installation
  mkdir "$installation"
  printf 'APP_SECRET=keep-this-exact-value\n' > "$installation/.env"
  chmod 600 "$installation/.env"

  run_command "$BUNDLE/ops/install-release-bundle.sh" \
    --bundle "$BUNDLE" --installation "$installation" -- --non-interactive --no-pull
  assert_status 0
  assert_contains "$installation/.env" 'APP_SECRET=keep-this-exact-value'
  assert_not_contains "$installation/.env" 'CONTROL_PLANE_IMAGE='
  assert_contains "$MOCK_INSTALL_LOG" "IMAGE=${TEST_LOCAL_IMAGE}"
  assert_contains "$MOCK_INSTALL_LOG" 'ARGS=<--non-interactive><--no-pull>'
  cmp "$BUNDLE/compose.yaml" "$installation/compose.yaml" >/dev/null ||
    fail_test 'verified compose payload was not synchronized'
  cmp "$BUNDLE/release.manifest" "$installation/release.manifest" >/dev/null ||
    fail_test 'release manifest was not synchronized'
  assert_absent "$installation/.shelter-install.lock"
  assert_absent "$installation/.shelter-release-sync-incomplete"
  assert_contains "$COMMAND_OUTPUT" 'existing .env preserved'
}

test_separate_installation_fails_closed_on_lock_and_unsafe_target() {
  create_bundle
  installation=$TEST_TMP/installation
  mkdir "$installation"
  printf 'APP_SECRET=keep-this-exact-value\n' > "$installation/.env"
  mkdir "$installation/.shelter-install.lock"

  run_command "$BUNDLE/ops/install-release-bundle.sh" \
    --bundle "$BUNDLE" --installation "$installation" -- --non-interactive
  assert_status 1
  assert_contains "$COMMAND_OUTPUT" 'another Shelter install, release, or deploy operation is active'
  [[ ! -s "$MOCK_DOCKER_LOG" ]] || fail_test 'central lock failure contacted Docker'
  assert_absent "$MOCK_INSTALL_LOG"

  rm -rf "$installation/.shelter-install.lock"
  mkdir "$installation/compose.yaml"
  run_command "$BUNDLE/ops/install-release-bundle.sh" \
    --bundle "$BUNDLE" --installation "$installation" -- --non-interactive
  assert_status 1
  assert_contains "$COMMAND_OUTPUT" 'refusing to replace unsafe installation payload'
  assert_absent "$MOCK_INSTALL_LOG"
  assert_contains "$installation/.env" 'APP_SECRET=keep-this-exact-value'
  [[ -f "$installation/.shelter-release-sync-incomplete" ]] ||
    fail_test 'failed synchronization did not leave its fail-closed marker'
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

printf 'Shelter release-bundle tests (%s)\n\n' "$TEST_SHELL"

run_test 'release scripts parse as POSIX shell' test_posix_syntax
run_test 'manifest creation produces a verifiable offline bundle' test_create_and_verify_bundle
run_test 'download verifies GitHub release and asset attestations' test_download_verifies_release_and_asset_before_publish
run_test 'attestation failures never publish or extract a release' test_download_fails_closed_on_attestation_errors
run_test 'authenticated archives still reject links before extraction' test_download_rejects_links_before_extraction
run_test 'download binds bundle metadata to repository and tag' test_download_binds_bundle_to_repository_and_tag
run_test 'manifest schema and metadata validation fail closed' test_manifest_schema_is_fail_closed
run_test 'payload changes and symbolic links are rejected' test_payload_checksums_and_symlinks_are_rejected
run_test 'checksum paths cannot escape the release bundle' test_unsafe_checksum_paths_are_rejected
run_test 'dry-run verifies and plans without changing state' test_dry_run_has_no_side_effects
run_test 'installer pulls by digest and hands off verified identity' test_installer_pulls_digest_and_passes_verified_identity
run_test 'pull failures and tag collisions never run install.sh' test_pull_and_local_tag_failures_do_not_run_installer
run_test 'bundle is revalidated after the potentially slow pull' test_bundle_is_revalidated_after_pull
run_test 'separate release updates preserve env and use central lock' test_separate_installation_preserves_env_and_uses_central_lock
run_test 'separate updates reject locks and unsafe targets' test_separate_installation_fails_closed_on_lock_and_unsafe_target

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]]
