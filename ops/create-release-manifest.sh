#!/usr/bin/env sh
set -eu

umask 077

script_dir=$(CDPATH= cd -P "$(dirname "$0")" >/dev/null 2>&1 && pwd -P)
# shellcheck source=ops/lib/release-bundle.sh
. "$script_dir/lib/release-bundle.sh"

bundle_dir=$(CDPATH= cd -P "$script_dir/.." >/dev/null 2>&1 && pwd -P)
version=
commit=
image_reference=
image_digest=
checksums_tmp=
manifest_tmp=

cleanup() {
  [ -z "$checksums_tmp" ] || rm -f "$checksums_tmp"
  [ -z "$manifest_tmp" ] || rm -f "$manifest_tmp"
}
trap cleanup 0 1 2 15

usage() {
  cat <<'EOF'
Usage: ops/create-release-manifest.sh --version VERSION --commit COMMIT \
  --image-reference IMAGE --image-digest sha256:DIGEST [--bundle DIRECTORY]

Creates release.checksums and release.manifest atomically for a prepared
release directory. IMAGE is kept separate from its immutable digest.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle|--version|--commit|--image-reference|--image-digest)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      case "$1" in
        --bundle) bundle_dir=$2 ;;
        --version) version=$2 ;;
        --commit) commit=$2 ;;
        --image-reference) image_reference=$2 ;;
        --image-digest) image_digest=$2 ;;
      esac
      shift
      ;;
    --bundle=*) bundle_dir=${1#*=} ;;
    --version=*) version=${1#*=} ;;
    --commit=*) commit=${1#*=} ;;
    --image-reference=*) image_reference=${1#*=} ;;
    --image-digest=*) image_digest=${1#*=} ;;
    -h|--help) usage; exit 0 ;;
    *)
      usage >&2
      printf 'Error: unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

[ -n "$version" ] && [ -n "$commit" ] && [ -n "$image_reference" ] && [ -n "$image_digest" ] || {
  usage >&2
  printf 'Error: version, commit, image reference, and image digest are required.\n' >&2
  exit 2
}

SHELTER_RELEASE_BUNDLE_ROOT=$(shelter_release_bundle_root "$bundle_dir")
SHELTER_RELEASE_FORMAT_VERSION=1
SHELTER_RELEASE_VERSION=$version
SHELTER_RELEASE_COMMIT=$commit
SHELTER_RELEASE_IMAGE_REFERENCE=$image_reference
SHELTER_RELEASE_IMAGE_DIGEST=$image_digest
SHELTER_RELEASE_CHECKSUMS_SHA256=0000000000000000000000000000000000000000000000000000000000000000
shelter_release_validate_metadata

for relative_path in \
  .env.example \
  compose.yaml \
  install.sh \
  ops/create-release-manifest.sh \
  ops/download-release.sh \
  ops/install-release-bundle.sh \
  ops/lib/release-bundle.sh \
  ops/verify-release-bundle.sh
do
  shelter_release_require_regular_file \
    "$SHELTER_RELEASE_BUNDLE_ROOT/$relative_path" "$relative_path"
done

for target in "$SHELTER_RELEASE_BUNDLE_ROOT/release.checksums" "$SHELTER_RELEASE_BUNDLE_ROOT/release.manifest"; do
  if [ -L "$target" ] || { [ -e "$target" ] && [ ! -f "$target" ]; }; then
    shelter_release_error "refusing to replace unsafe path: ${target}"
    exit 1
  fi
done

checksums_tmp=$(mktemp "$SHELTER_RELEASE_BUNDLE_ROOT/.release.checksums.XXXXXX")
manifest_tmp=$(mktemp "$SHELTER_RELEASE_BUNDLE_ROOT/.release.manifest.XXXXXX")
for relative_path in \
  .env.example \
  compose.yaml \
  install.sh \
  ops/create-release-manifest.sh \
  ops/download-release.sh \
  ops/install-release-bundle.sh \
  ops/lib/release-bundle.sh \
  ops/verify-release-bundle.sh
do
  payload_hash=$(shelter_release_sha256 "$SHELTER_RELEASE_BUNDLE_ROOT/$relative_path")
  printf '%s  %s\n' "$payload_hash" "$relative_path" >> "$checksums_tmp"
done

SHELTER_RELEASE_CHECKSUMS_SHA256=$(shelter_release_sha256 "$checksums_tmp")
{
  printf 'FORMAT_VERSION=1\n'
  printf 'VERSION=%s\n' "$SHELTER_RELEASE_VERSION"
  printf 'COMMIT=%s\n' "$SHELTER_RELEASE_COMMIT"
  printf 'IMAGE_REFERENCE=%s\n' "$SHELTER_RELEASE_IMAGE_REFERENCE"
  printf 'IMAGE_DIGEST=%s\n' "$SHELTER_RELEASE_IMAGE_DIGEST"
  printf 'CHECKSUMS_SHA256=%s\n' "$SHELTER_RELEASE_CHECKSUMS_SHA256"
} > "$manifest_tmp"

chmod 0644 "$checksums_tmp" "$manifest_tmp"
mv "$checksums_tmp" "$SHELTER_RELEASE_BUNDLE_ROOT/release.checksums"
checksums_tmp=
mv "$manifest_tmp" "$SHELTER_RELEASE_BUNDLE_ROOT/release.manifest"
manifest_tmp=

shelter_release_load "$SHELTER_RELEASE_BUNDLE_ROOT"
printf 'Created Shelter release %s (%s).\n' "$SHELTER_RELEASE_VERSION" "$SHELTER_RELEASE_COMMIT"
printf '  Manifest  %s\n' "$SHELTER_RELEASE_MANIFEST"
printf '  Image     %s\n' "$SHELTER_RELEASE_SOURCE_IMAGE"
