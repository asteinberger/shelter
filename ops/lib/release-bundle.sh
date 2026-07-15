#!/usr/bin/env sh

# Shared, POSIX-shell helpers for Shelter release bundles. This file is meant
# to be sourced by the create, verify, and install entry points in ops/.

shelter_release_error() {
  printf 'Error: %s\n' "$1" >&2
  return 1
}

shelter_release_bundle_root() {
  shelter_release_root_input=$1
  [ -n "$shelter_release_root_input" ] || {
    shelter_release_error "the release bundle path is empty"
    return 1
  }
  [ -d "$shelter_release_root_input" ] || {
    shelter_release_error "release bundle directory not found: ${shelter_release_root_input}"
    return 1
  }
  [ ! -L "$shelter_release_root_input" ] || {
    shelter_release_error "the release bundle directory must not be a symbolic link"
    return 1
  }
  shelter_release_resolved_root=$(CDPATH= cd -P "$shelter_release_root_input" 2>/dev/null && pwd -P) || {
    shelter_release_error "the release bundle directory could not be resolved"
    return 1
  }
  case "$shelter_release_resolved_root" in
    *'
'*)
      shelter_release_error "the release bundle path must not contain a newline"
      return 1
      ;;
  esac
  printf '%s\n' "$shelter_release_resolved_root"
}

shelter_release_sha256() {
  shelter_release_hash_file=$1
  if command -v sha256sum >/dev/null 2>&1; then
    shelter_release_hash=$(sha256sum "$shelter_release_hash_file" 2>/dev/null | awk '{ print $1 }') || return 1
  elif command -v shasum >/dev/null 2>&1; then
    shelter_release_hash=$(shasum -a 256 "$shelter_release_hash_file" 2>/dev/null | awk '{ print $1 }') || return 1
  elif command -v openssl >/dev/null 2>&1; then
    shelter_release_hash=$(openssl dgst -sha256 "$shelter_release_hash_file" 2>/dev/null | awk '{ print $NF }') || return 1
  else
    shelter_release_error "sha256sum, shasum, or OpenSSL is required"
    return 1
  fi
  case "$shelter_release_hash" in
    *[!0-9a-f]*|'') return 1 ;;
  esac
  [ "${#shelter_release_hash}" -eq 64 ] || return 1
  printf '%s\n' "$shelter_release_hash"
}

shelter_release_require_regular_file() {
  shelter_release_required_file=$1
  shelter_release_required_label=$2
  [ -f "$shelter_release_required_file" ] && [ ! -L "$shelter_release_required_file" ] || {
    shelter_release_error "${shelter_release_required_label} must be a regular file, not a symbolic link"
    return 1
  }
}

shelter_release_validate_metadata() {
  [ "$SHELTER_RELEASE_FORMAT_VERSION" = 1 ] || {
    shelter_release_error "unsupported release manifest format: ${SHELTER_RELEASE_FORMAT_VERSION:-missing}"
    return 1
  }

  [ "${#SHELTER_RELEASE_VERSION}" -le 48 ] &&
    printf '%s\n' "$SHELTER_RELEASE_VERSION" |
      LC_ALL=C grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' || {
        shelter_release_error "VERSION must be a canonical SemVer value without build metadata"
        return 1
      }
  case "$SHELTER_RELEASE_VERSION" in
    *-*)
      shelter_release_prerelease=${SHELTER_RELEASE_VERSION#*-}
      shelter_release_previous_ifs=$IFS
      IFS=.
      for shelter_release_identifier in $shelter_release_prerelease; do
        case "$shelter_release_identifier" in
          0|*[!0-9]*) ;;
          0*)
            IFS=$shelter_release_previous_ifs
            shelter_release_error "numeric SemVer prerelease identifiers must not contain leading zeroes"
            return 1
            ;;
        esac
      done
      IFS=$shelter_release_previous_ifs
      ;;
  esac

  case "$SHELTER_RELEASE_COMMIT" in
    *[!0-9a-f]*|'')
      shelter_release_error "COMMIT must be a full lowercase hexadecimal Git object ID"
      return 1
      ;;
  esac
  [ "${#SHELTER_RELEASE_COMMIT}" -eq 40 ] || [ "${#SHELTER_RELEASE_COMMIT}" -eq 64 ] || {
    shelter_release_error "COMMIT must contain exactly 40 or 64 hexadecimal characters"
    return 1
  }

  [ "${#SHELTER_RELEASE_IMAGE_REFERENCE}" -le 256 ] || {
    shelter_release_error "IMAGE_REFERENCE is too long"
    return 1
  }
  case "$SHELTER_RELEASE_IMAGE_REFERENCE" in
    [A-Za-z0-9]*[A-Za-z0-9]) ;;
    *)
      shelter_release_error "IMAGE_REFERENCE must start and end with a letter or number"
      return 1
      ;;
  esac
  case "$SHELTER_RELEASE_IMAGE_REFERENCE" in
    *[!A-Za-z0-9./:_-]*|*@*|*//*|*..*)
      shelter_release_error "IMAGE_REFERENCE is not a safe taggable OCI image reference"
      return 1
      ;;
  esac

  shelter_release_digest_hex=${SHELTER_RELEASE_IMAGE_DIGEST#sha256:}
  [ "$shelter_release_digest_hex" != "$SHELTER_RELEASE_IMAGE_DIGEST" ] || {
    shelter_release_error "IMAGE_DIGEST must use sha256"
    return 1
  }
  case "$shelter_release_digest_hex" in
    *[!0-9a-f]*|'')
      shelter_release_error "IMAGE_DIGEST must be lowercase hexadecimal"
      return 1
      ;;
  esac
  [ "${#shelter_release_digest_hex}" -eq 64 ] || {
    shelter_release_error "IMAGE_DIGEST must contain exactly 64 hexadecimal characters"
    return 1
  }

  case "$SHELTER_RELEASE_CHECKSUMS_SHA256" in
    *[!0-9a-f]*|'')
      shelter_release_error "CHECKSUMS_SHA256 must be lowercase hexadecimal"
      return 1
      ;;
  esac
  [ "${#SHELTER_RELEASE_CHECKSUMS_SHA256}" -eq 64 ] || {
    shelter_release_error "CHECKSUMS_SHA256 must contain exactly 64 hexadecimal characters"
    return 1
  }
}

shelter_release_parse_manifest() {
  shelter_release_manifest=$1
  shelter_release_require_regular_file "$shelter_release_manifest" "release.manifest" || return 1

  SHELTER_RELEASE_FORMAT_VERSION=
  SHELTER_RELEASE_VERSION=
  SHELTER_RELEASE_COMMIT=
  SHELTER_RELEASE_IMAGE_REFERENCE=
  SHELTER_RELEASE_IMAGE_DIGEST=
  SHELTER_RELEASE_CHECKSUMS_SHA256=
  shelter_release_manifest_lines=0

  while IFS= read -r shelter_release_line || [ -n "$shelter_release_line" ]; do
    shelter_release_manifest_lines=$((shelter_release_manifest_lines + 1))
    case "$shelter_release_line" in
      *"$(printf '\r')"*|'')
        shelter_release_error "release.manifest contains a blank or non-canonical line"
        return 1
        ;;
      *=*) ;;
      *)
        shelter_release_error "release.manifest line ${shelter_release_manifest_lines} is not KEY=VALUE"
        return 1
        ;;
    esac
    shelter_release_key=${shelter_release_line%%=*}
    shelter_release_value=${shelter_release_line#*=}
    [ -n "$shelter_release_value" ] || {
      shelter_release_error "release.manifest key ${shelter_release_key} has an empty value"
      return 1
    }
    case "$shelter_release_key" in
      FORMAT_VERSION)
        [ -z "$SHELTER_RELEASE_FORMAT_VERSION" ] || {
          shelter_release_error "release.manifest contains duplicate FORMAT_VERSION"
          return 1
        }
        SHELTER_RELEASE_FORMAT_VERSION=$shelter_release_value
        ;;
      VERSION)
        [ -z "$SHELTER_RELEASE_VERSION" ] || {
          shelter_release_error "release.manifest contains duplicate VERSION"
          return 1
        }
        SHELTER_RELEASE_VERSION=$shelter_release_value
        ;;
      COMMIT)
        [ -z "$SHELTER_RELEASE_COMMIT" ] || {
          shelter_release_error "release.manifest contains duplicate COMMIT"
          return 1
        }
        SHELTER_RELEASE_COMMIT=$shelter_release_value
        ;;
      IMAGE_REFERENCE)
        [ -z "$SHELTER_RELEASE_IMAGE_REFERENCE" ] || {
          shelter_release_error "release.manifest contains duplicate IMAGE_REFERENCE"
          return 1
        }
        SHELTER_RELEASE_IMAGE_REFERENCE=$shelter_release_value
        ;;
      IMAGE_DIGEST)
        [ -z "$SHELTER_RELEASE_IMAGE_DIGEST" ] || {
          shelter_release_error "release.manifest contains duplicate IMAGE_DIGEST"
          return 1
        }
        SHELTER_RELEASE_IMAGE_DIGEST=$shelter_release_value
        ;;
      CHECKSUMS_SHA256)
        [ -z "$SHELTER_RELEASE_CHECKSUMS_SHA256" ] || {
          shelter_release_error "release.manifest contains duplicate CHECKSUMS_SHA256"
          return 1
        }
        SHELTER_RELEASE_CHECKSUMS_SHA256=$shelter_release_value
        ;;
      *)
        shelter_release_error "release.manifest contains unsupported key: ${shelter_release_key}"
        return 1
        ;;
    esac
  done < "$shelter_release_manifest"

  [ "$shelter_release_manifest_lines" -eq 6 ] || {
    shelter_release_error "release.manifest must contain exactly six canonical entries"
    return 1
  }
  shelter_release_validate_metadata
}

shelter_release_validate_checksums() {
  shelter_release_root=$1
  shelter_release_checksums_file=$shelter_release_root/release.checksums
  shelter_release_require_regular_file "$shelter_release_checksums_file" "release.checksums" || return 1

  shelter_release_checksums_actual=$(shelter_release_sha256 "$shelter_release_checksums_file") || {
    shelter_release_error "release.checksums could not be hashed"
    return 1
  }
  [ "$shelter_release_checksums_actual" = "$SHELTER_RELEASE_CHECKSUMS_SHA256" ] || {
    shelter_release_error "release.checksums does not match CHECKSUMS_SHA256"
    return 1
  }

  shelter_release_seen_paths='
'
  shelter_release_checksum_count=0
  shelter_release_has_env=0
  shelter_release_has_compose=0
  shelter_release_has_installer=0
  shelter_release_has_downloader=0
  shelter_release_has_bundle_installer=0
  shelter_release_has_verifier=0
  shelter_release_has_library=0

  while IFS= read -r shelter_release_checksum_line || [ -n "$shelter_release_checksum_line" ]; do
    shelter_release_checksum_count=$((shelter_release_checksum_count + 1))
    [ "$shelter_release_checksum_count" -le 256 ] || {
      shelter_release_error "release.checksums contains too many entries"
      return 1
    }
    shelter_release_expected_hash=${shelter_release_checksum_line%% *}
    shelter_release_checksum_tail=${shelter_release_checksum_line#"$shelter_release_expected_hash"}
    case "$shelter_release_checksum_tail" in
      '  '*) shelter_release_relative_path=${shelter_release_checksum_tail#'  '} ;;
      *)
        shelter_release_error "release.checksums line ${shelter_release_checksum_count} is not canonical"
        return 1
        ;;
    esac
    case "$shelter_release_expected_hash" in
      *[!0-9a-f]*|'')
        shelter_release_error "release.checksums line ${shelter_release_checksum_count} has an invalid digest"
        return 1
        ;;
    esac
    [ "${#shelter_release_expected_hash}" -eq 64 ] || {
      shelter_release_error "release.checksums line ${shelter_release_checksum_count} has an invalid digest length"
      return 1
    }
    case "$shelter_release_relative_path" in
      ''|/*|*[!A-Za-z0-9._/-]*|*//*|*..*)
        shelter_release_error "release.checksums contains an unsafe path"
        return 1
        ;;
    esac
    case "/$shelter_release_relative_path/" in
      */./*|*/../*)
        shelter_release_error "release.checksums paths must not contain dot segments"
        return 1
        ;;
    esac
    case "$shelter_release_seen_paths" in
      *"
$shelter_release_relative_path
"*)
        shelter_release_error "release.checksums contains a duplicate path: ${shelter_release_relative_path}"
        return 1
        ;;
    esac
    shelter_release_seen_paths="${shelter_release_seen_paths}${shelter_release_relative_path}
"

    shelter_release_payload_file=$shelter_release_root/$shelter_release_relative_path
    shelter_release_require_regular_file "$shelter_release_payload_file" "$shelter_release_relative_path" || return 1
    shelter_release_actual_hash=$(shelter_release_sha256 "$shelter_release_payload_file") || {
      shelter_release_error "${shelter_release_relative_path} could not be hashed"
      return 1
    }
    [ "$shelter_release_actual_hash" = "$shelter_release_expected_hash" ] || {
      shelter_release_error "checksum mismatch: ${shelter_release_relative_path}"
      return 1
    }

    case "$shelter_release_relative_path" in
      .env.example) shelter_release_has_env=1 ;;
      compose.yaml) shelter_release_has_compose=1 ;;
      install.sh) shelter_release_has_installer=1 ;;
      ops/download-release.sh) shelter_release_has_downloader=1 ;;
      ops/install-release-bundle.sh) shelter_release_has_bundle_installer=1 ;;
      ops/verify-release-bundle.sh) shelter_release_has_verifier=1 ;;
      ops/lib/release-bundle.sh) shelter_release_has_library=1 ;;
    esac
  done < "$shelter_release_checksums_file"

  [ "$shelter_release_checksum_count" -gt 0 ] || {
    shelter_release_error "release.checksums is empty"
    return 1
  }
  [ "$shelter_release_has_env" -eq 1 ] &&
    [ "$shelter_release_has_compose" -eq 1 ] &&
    [ "$shelter_release_has_installer" -eq 1 ] &&
    [ "$shelter_release_has_downloader" -eq 1 ] &&
    [ "$shelter_release_has_bundle_installer" -eq 1 ] &&
    [ "$shelter_release_has_verifier" -eq 1 ] &&
    [ "$shelter_release_has_library" -eq 1 ] || {
      shelter_release_error "release.checksums is missing a required installer payload"
      return 1
    }
}

shelter_release_load() {
  SHELTER_RELEASE_BUNDLE_ROOT=$(shelter_release_bundle_root "$1") || return 1
  SHELTER_RELEASE_MANIFEST=$SHELTER_RELEASE_BUNDLE_ROOT/release.manifest
  shelter_release_parse_manifest "$SHELTER_RELEASE_MANIFEST" || return 1
  shelter_release_validate_checksums "$SHELTER_RELEASE_BUNDLE_ROOT" || return 1
  SHELTER_RELEASE_MANIFEST_SHA256=$(shelter_release_sha256 "$SHELTER_RELEASE_MANIFEST") || {
    shelter_release_error "release.manifest could not be hashed"
    return 1
  }
  SHELTER_RELEASE_SOURCE_IMAGE=${SHELTER_RELEASE_IMAGE_REFERENCE}@${SHELTER_RELEASE_IMAGE_DIGEST}
  shelter_release_digest_hex=${SHELTER_RELEASE_IMAGE_DIGEST#sha256:}
  SHELTER_RELEASE_LOCAL_IMAGE=shelter/control-plane:release-${shelter_release_digest_hex}
  SHELTER_RELEASE_REVISION=release:${SHELTER_RELEASE_VERSION}-${SHELTER_RELEASE_COMMIT}
}
