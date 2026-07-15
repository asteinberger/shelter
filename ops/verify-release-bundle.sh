#!/usr/bin/env sh
set -eu

umask 077

script_dir=$(CDPATH= cd -P "$(dirname "$0")" >/dev/null 2>&1 && pwd -P)
# shellcheck source=ops/lib/release-bundle.sh
. "$script_dir/lib/release-bundle.sh"

bundle_dir=$(CDPATH= cd -P "$script_dir/.." >/dev/null 2>&1 && pwd -P)
quiet=0

usage() {
  cat <<'EOF'
Usage: ops/verify-release-bundle.sh [--bundle DIRECTORY] [--quiet]

Validates release.manifest, release.checksums, every listed payload file, and
the immutable control-plane image metadata. Docker is not contacted.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      bundle_dir=$2
      shift
      ;;
    --bundle=*) bundle_dir=${1#*=} ;;
    --quiet) quiet=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      usage >&2
      printf 'Error: unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

shelter_release_load "$bundle_dir"

if [ "$quiet" -eq 0 ]; then
  printf 'Shelter release bundle verified.\n'
  printf '  Version       %s\n' "$SHELTER_RELEASE_VERSION"
  printf '  Commit        %s\n' "$SHELTER_RELEASE_COMMIT"
  printf '  Source image  %s\n' "$SHELTER_RELEASE_SOURCE_IMAGE"
  printf '  Local image   %s\n' "$SHELTER_RELEASE_LOCAL_IMAGE"
  printf '  Payload files %s\n' "$shelter_release_checksum_count"
fi
