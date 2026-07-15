# Shelter releases

Shelter production releases are built once in GitHub Actions and installed by
content digest. The release path is separate from the source-build path used
for local development.

## Security guarantees

A published release has all of the following properties:

- the `vMAJOR.MINOR.PATCH` tag matches `package.json` and `package-lock.json`,
- repository rules prevent matching `v*` tags from being updated or deleted,
- the tagged commit belongs to `main` and passes the complete Shelter check,
- the control-plane image is built once for `linux/amd64` and `linux/arm64`,
- the installable image is recorded as `ghcr.io/...@sha256:...`, never as a
  floating tag,
- BuildKit provenance and an SBOM are attached to the OCI image,
- GitHub signs provenance and SBOM attestations with Sigstore,
- every downloadable asset is covered by `SHA256SUMS` and a GitHub artifact
  attestation,
- the installable source bundle contains its own strict manifest and payload
  checksums, and
- GitHub Release immutability locks the release tag and assets after the draft
  has been populated and published.

Before the first production release, a repository administrator must first
enable **Settings → Releases → Immutable releases** and then create the Actions
repository variable `SHELTER_IMMUTABLE_RELEASES_REQUIRED` with the exact value
`true` under **Settings → Secrets and variables → Actions → Variables**. The
variable is a fail-closed administrator acknowledgement because the workflow's
`GITHUB_TOKEN` cannot read the administrative immutable-release setting. It is
not a substitute for enabling the setting itself. After publication, the
workflow verifies the real GitHub state through `isImmutable` and
`gh release verify`; the job fails unless both confirm an immutable, signed
release. Do not publish Shelter releases from another workflow or by uploading
assets manually.

These guarantees protect the distribution of Shelter itself. They do not make
Docker builds of deployed projects safe for hostile tenants; see
[SECURITY.md](../SECURITY.md#threat-model).

## Publish a release

1. Update the version in `package.json` and `package-lock.json` on `dev`.
2. Run `npm ci && npm run check` and merge the reviewed change into `main`.
3. Create an annotated tag on that exact `main` commit and push only the tag:

   ```sh
   git switch main
   git pull --ff-only
   git tag -a v0.2.1 -m "Shelter v0.2.1"
   git push origin v0.2.1
   ```

Release tags are deliberately one-way: the repository ruleset permits creation
but blocks later updates and deletion. Verify the commit and version before
pushing the tag; use a new version if a release attempt must be replaced.

The release workflow has no manual dispatch path. It refuses malformed tags,
version mismatches, commits outside `main`, pre-existing release image tags,
failed checks, changed image metadata, or a release that GitHub did not mark
immutable. It never overwrites an earlier version tag.

The first GHCR publication creates the package with GitHub's default package
visibility. For a public Shelter release, an administrator must change the
linked `shelter` container package to public once. Installations always use the
digest recorded in the verified bundle regardless of package visibility.

## Download and install a verified release

The download helper requires a current, authenticated GitHub CLI with
`gh release verify` and `gh release verify-asset`. It reads no archive data
until both the immutable release and the exact downloaded asset have passed
GitHub's cryptographic verification.

Run the helper from a trusted Shelter checkout:

```sh
gh auth login
./ops/download-release.sh \
  --repo asteinberger/shelter \
  --tag v0.2.1 \
  --destination ../shelter-v0.2.1
```

Inspect the immutable plan without contacting Docker or changing the current
installation:

```sh
../shelter-v0.2.1/ops/install-release-bundle.sh --dry-run
```

For a new interactive installation:

```sh
cd ../shelter-v0.2.1
./ops/install-release-bundle.sh
```

For an existing installation or non-interactive provisioning, pass normal
installer options after `--` and name the existing canonical installation
directory. Its `.env` is preserved and the authenticated release payloads are
synchronized under the same central operation lock:

```sh
./ops/install-release-bundle.sh \
  --installation /opt/shelter \
  -- --non-interactive
```

The release installer performs these checks before changing the control plane:

1. validate the strict release manifest and every payload checksum,
2. pull the exact `IMAGE_REFERENCE@sha256:DIGEST`,
3. verify Docker's local image identity,
4. create a collision-checked, digest-specific local Compose tag,
5. revalidate the bundle after the potentially long pull, and
6. for an update, atomically copy and revalidate only the authenticated
   operational payloads while leaving the existing `.env` untouched, and
7. bind every Compose operation to the authenticated `compose.yaml`, ignoring
   ambient override-file selectors, and
8. verify the running API and worker image identities before committing the new
   image selection.

`install.sh` skips Buildx and the local control-plane build in this mode. It
commits the new `CONTROL_PLANE_IMAGE` value only after API, worker, and Traefik
health checks pass. A rollback restores both the validated database snapshot
and the previous image reference. An interrupted payload synchronization leaves
a fail-closed marker; rerun the same release command before using `install`,
`rollback`, or `doctor` directly.

## Independent verification

The release and any downloaded asset can be verified again with GitHub CLI:

```sh
gh release verify v0.2.1 --repo asteinberger/shelter
gh release verify-asset v0.2.1 shelter-v0.2.1.tar.gz \
  --repo asteinberger/shelter
```

After authenticating to GHCR, verify the OCI provenance against this repository
and the release workflow:

```sh
gh attestation verify \
  oci://ghcr.io/asteinberger/shelter@sha256:RELEASE_DIGEST \
  --repo asteinberger/shelter \
  --signer-workflow asteinberger/shelter/.github/workflows/release.yml \
  --source-ref refs/tags/v0.2.1 \
  --bundle-from-oci
```

Use the digest from the release manifest; do not copy a digest from an
unverified log or comment.

## Source builds

Running `./install.sh` directly keeps the existing source-build workflow and is
useful for development or a deliberately reviewed checkout. It builds the
control plane locally and therefore does not provide the release attestation
guarantees above. Production operators should prefer verified release bundles.
To prevent a local build from silently replacing release-selected content, the
source installer refuses to run while `.env` selects a
`shelter/control-plane:release-*` image. Deliberately set
`CONTROL_PLANE_IMAGE=shelter/control-plane:local` first if you explicitly want
to leave the verified release channel.
