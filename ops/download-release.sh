#!/usr/bin/env sh
set -eu

umask 077

script_dir=$(CDPATH= cd -P "$(dirname "$0")" >/dev/null 2>&1 && pwd -P)
# Parse downloaded metadata with the already trusted helper code. No code from
# the archive is executed before its manifest and payloads have been verified.
# shellcheck source=ops/lib/release-bundle.sh
. "$script_dir/lib/release-bundle.sh"

repository=
requested_repository=
tag=
asset=
destination=
staging_directory=
maximum_archive_mb=${SHELTER_RELEASE_MAX_ARCHIVE_MB:-100}

usage() {
  cat <<'EOF'
Usage: ops/download-release.sh --repo OWNER/REPOSITORY --tag TAG \
  --destination DIRECTORY [--asset FILE.tar.gz]

Downloads one immutable GitHub Release asset. The release attestation and the
downloaded asset attestation are both verified with GitHub CLI before the tar
archive is inspected or extracted. The extracted Shelter manifest and every
listed payload checksum are then verified before the destination appears.

The default asset name is shelter-TAG.tar.gz.
EOF
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  cleanup_status=$?
  trap - 0 1 2 15
  if [ -n "$staging_directory" ]; then
    rm -rf "$staging_directory"
  fi
  exit "$cleanup_status"
}
trap cleanup 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo|--tag|--asset|--destination)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      case "$1" in
        --repo) repository=$2 ;;
        --tag) tag=$2 ;;
        --asset) asset=$2 ;;
        --destination) destination=$2 ;;
      esac
      shift
      ;;
    --repo=*) repository=${1#*=} ;;
    --tag=*) tag=${1#*=} ;;
    --asset=*) asset=${1#*=} ;;
    --destination=*) destination=${1#*=} ;;
    -h|--help) usage; exit 0 ;;
    *)
      usage >&2
      printf 'Error: unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

[ -n "$repository" ] && [ -n "$tag" ] && [ -n "$destination" ] || {
  usage >&2
  printf 'Error: repository, tag, and destination are required.\n' >&2
  exit 2
}

case "$repository" in
  */*) ;;
  *) fail "--repo must use the exact OWNER/REPOSITORY form" ;;
esac
case "$repository" in
  [A-Za-z0-9_.-]*/*[A-Za-z0-9_.-]) ;;
  *) fail "--repo contains unsupported characters" ;;
esac
case "$repository" in
  *[!A-Za-z0-9_./-]*|*/*/*|*..*) fail "--repo must name exactly one GitHub owner and repository" ;;
esac

case "$tag" in
  [A-Za-z0-9]*[A-Za-z0-9]) ;;
  *) fail "--tag must start and end with a letter or number" ;;
esac
case "$tag" in
  *[!A-Za-z0-9._-]*|*..*) fail "--tag contains unsupported characters" ;;
esac
[ "${#tag}" -le 128 ] || fail "--tag is too long"

[ -n "$asset" ] || asset=shelter-${tag}.tar.gz
case "$asset" in
  [A-Za-z0-9]*.tar.gz) ;;
  *) fail "--asset must be a plain .tar.gz filename" ;;
esac
case "$asset" in
  *[!A-Za-z0-9._-]*|*..*) fail "--asset contains unsupported characters" ;;
esac
[ "${#asset}" -le 192 ] || fail "--asset is too long"

case "$maximum_archive_mb" in
  ''|*[!0-9]*|0) fail "SHELTER_RELEASE_MAX_ARCHIVE_MB must be a positive integer" ;;
esac
[ "$maximum_archive_mb" -le 2048 ] || fail "SHELTER_RELEASE_MAX_ARCHIVE_MB must not exceed 2048"

case "$destination" in
  */*)
    destination_parent=${destination%/*}
    destination_name=${destination##*/}
    [ -n "$destination_parent" ] || destination_parent=/
    ;;
  *)
    destination_parent=.
    destination_name=$destination
    ;;
esac
case "$destination_name" in
  [A-Za-z0-9._-]*[A-Za-z0-9._-]) ;;
  *) fail "--destination must end in a safe directory name" ;;
esac
case "$destination_name" in
  .|..|*..*|*[!A-Za-z0-9._-]*) fail "--destination has an unsafe final component" ;;
esac
[ -d "$destination_parent" ] || fail "the destination parent directory does not exist: ${destination_parent}"
resolved_parent=$(CDPATH= cd -P "$destination_parent" 2>/dev/null && pwd -P) || fail "the destination parent could not be resolved"
resolved_destination=$resolved_parent/$destination_name
[ ! -e "$resolved_destination" ] && [ ! -L "$resolved_destination" ] ||
  fail "the destination already exists; release directories are immutable"

for required_command in gh tar mktemp awk tr wc; do
  command -v "$required_command" >/dev/null 2>&1 || fail "${required_command} is required"
done

# Repository transfers keep GitHub redirects, but release attestations and new
# GHCR images are bound to the repository's current owner. Resolve the canonical
# identity before verifying anything so old, documented clone configurations
# continue to select the transferred repository without weakening provenance.
requested_repository=$repository
repository=$(gh api "repos/${requested_repository}" --jq .full_name) ||
  fail "the canonical GitHub repository identity could not be resolved"
case "$repository" in
  [A-Za-z0-9_.-]*/*[A-Za-z0-9_.-]) ;;
  *) fail "GitHub returned an invalid canonical repository identity" ;;
esac
case "$repository" in
  *[!A-Za-z0-9_./-]*|*/*/*|*..*) fail "GitHub returned an invalid canonical repository identity" ;;
esac
if [ "$repository" != "$requested_repository" ]; then
  printf 'Following repository transfer %s -> %s…\n' "$requested_repository" "$repository"
fi

staging_directory=$(mktemp -d "$resolved_parent/.shelter-release-download.XXXXXX")
archive_path=$staging_directory/$asset
archive_entries=$staging_directory/archive.entries
archive_types=$staging_directory/archive.types
extracted_bundle=$staging_directory/bundle
mkdir "$extracted_bundle"

printf 'Verifying GitHub Release %s from %s…\n' "$tag" "$repository"
gh release verify "$tag" --repo "$repository"

printf 'Downloading %s…\n' "$asset"
gh release download "$tag" --repo "$repository" --pattern "$asset" --output "$archive_path"
[ -f "$archive_path" ] && [ ! -L "$archive_path" ] || fail "GitHub CLI did not create the expected release asset"

printf 'Verifying the downloaded asset attestation…\n'
gh release verify-asset "$tag" "$archive_path" --repo "$repository"

archive_bytes=$(wc -c < "$archive_path" | awk '{ print $1 }')
case "$archive_bytes" in
  ''|*[!0-9]*) fail "the downloaded asset size could not be determined" ;;
esac
maximum_archive_bytes=$((maximum_archive_mb * 1024 * 1024))
[ "$archive_bytes" -le "$maximum_archive_bytes" ] ||
  fail "the downloaded asset exceeds SHELTER_RELEASE_MAX_ARCHIVE_MB"

# No archive data is read before both GitHub attestation checks above pass.
LC_ALL=C tar -tzf "$archive_path" > "$archive_entries"
LC_ALL=C tar -tvzf "$archive_path" > "$archive_types"
if ! awk 'substr($1, 1, 1) != "-" && substr($1, 1, 1) != "d" { exit 1 }' "$archive_types"; then
  fail "the release archive contains a link, device, or unsupported entry type"
fi

entry_count=0
payload_entry_count=0
seen_entries='
'
while IFS= read -r archive_entry || [ -n "$archive_entry" ]; do
  entry_count=$((entry_count + 1))
  [ "$entry_count" -le 4096 ] || fail "the release archive contains too many entries"
  case "$archive_entry" in
    ./|.) continue ;;
  esac
  payload_entry_count=$((payload_entry_count + 1))
  normalized_entry=${archive_entry#./}
  normalized_entry=${normalized_entry%/}
  case "$normalized_entry" in
    ''|/*|*[!A-Za-z0-9._/-]*|*//*|*..*) fail "the release archive contains an unsafe path" ;;
  esac
  case "/$normalized_entry/" in
    */./*|*/../*) fail "the release archive contains a dot-segment path" ;;
  esac
  case "$seen_entries" in
    *"
$normalized_entry
"*) fail "the release archive contains a duplicate path: ${normalized_entry}" ;;
  esac
  seen_entries="${seen_entries}${normalized_entry}
"
done < "$archive_entries"
[ "$payload_entry_count" -gt 0 ] || fail "the release archive is empty"

printf 'Extracting the authenticated release bundle…\n'
tar -xzf "$archive_path" -C "$extracted_bundle" --no-same-owner --no-same-permissions
[ -x "$extracted_bundle/ops/verify-release-bundle.sh" ] ||
  fail "the release archive does not contain an executable Shelter verifier"
shelter_release_load "$extracted_bundle"

# Bind the authenticated GitHub release identity to the installer's internal
# metadata. This prevents a valid asset attached to one tag or fork from
# silently selecting a different release image.
[ "$tag" = "v${SHELTER_RELEASE_VERSION}" ] ||
  fail "the bundle version does not match the verified GitHub Release tag"
normalized_repository=$(printf '%s' "$repository" | tr '[:upper:]' '[:lower:]')
expected_image_reference=ghcr.io/${normalized_repository}:${tag}
legacy_image_reference=
if [ "$normalized_repository" = raum-so/shelter ]; then
  case "$tag" in
    v0.2.0|v0.2.1|v0.3.0|v0.3.1|v0.4.0)
      legacy_image_reference=ghcr.io/asteinberger/shelter:${tag}
      ;;
  esac
fi
if [ "$SHELTER_RELEASE_IMAGE_REFERENCE" != "$expected_image_reference" ] &&
  [ "$SHELTER_RELEASE_IMAGE_REFERENCE" != "$legacy_image_reference" ]; then
  fail "the bundle image does not belong to the verified GitHub repository and tag"
fi

mv "$extracted_bundle" "$resolved_destination"
printf 'Shelter release downloaded and verified at %s\n' "$resolved_destination"
printf 'Install it with:\n  %s/ops/install-release-bundle.sh\n' "$resolved_destination"
