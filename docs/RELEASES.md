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

1. Merge feature and fix PRs into `dev` and wait for the required checks plus
   the **Development integration gate** on the resulting `dev` commit.
2. From a clean local `dev` that exactly matches `origin/dev`, prepare the next
   explicit SemVer version. This fetches `main` and `dev`, validates the branch
   history and version state, rejects `main` tree changes missing from `dev`,
   creates `agent/release-<version>` from exact `origin/dev`, updates only the
   root package and lockfile versions, and runs the complete check:

   ```sh
   git switch dev
   git pull --ff-only
   npm ci
   npm run release:prepare -- 0.3.0
   git add package.json package-lock.json
   git commit -m "release: prepare v0.3.0"
   git push -u origin agent/release-0.3.0
   ```

   Use `--dry-run` after the version to validate the release preconditions
   without creating the branch or changing files. If the complete check fails,
   the script restores both version files and exits non-zero while leaving the
   clean release branch available for a retry.
3. Open `agent/release-0.3.0` against `dev`. The policy allows that version
   increase only from the same repository, only when the branch suffix exactly
   matches the new version, and only when the three root version fields changed
   in `package.json` and `package-lock.json`. Merge after review and required
   checks, then wait for the development integration gate on the new `dev`
   revision.
4. Open the release PR from same-repository `dev` to `main`. The policy rejects
   every other source branch, inconsistent package/lockfile versions, and
   versions that are not greater than the version on `main`. Merge only after
   review and all required checks pass.
5. Synchronize `main`, verify the intended commit and version, then create an
   annotated tag on that exact commit and push only the tag:

   ```sh
   git switch main
   git pull --ff-only
   test "$(node -p "require('./package.json').version")" = "0.3.0"
   git tag -a v0.3.0 -m "Shelter v0.3.0"
   git push origin v0.3.0
   ```

Release tags are deliberately one-way: the repository ruleset permits creation
but blocks later updates and deletion. Verify the commit and version before
pushing the tag; use a new version if a release attempt must be replaced.

The release workflow has no manual dispatch path. It refuses malformed or
moved tags, version mismatches, commits outside `main`, pre-existing release
image tags, failed checks, changed image metadata, or a release that GitHub did
not mark immutable. It never overwrites an earlier version tag. Distribution
authenticity comes from the Sigstore-signed image provenance, SBOM and asset
attestations plus GitHub Release immutability; it does not depend on a locally
configured maintainer signing key.

## Deploy a verified release to a VPS

Run the production deployer from a trusted local checkout after the immutable
GitHub Release workflow has completed:

```sh
cp .env.server.example .env.server
chmod 600 .env.server
# Configure root SSH access to /opt/shelter; prefer an identity file.
./ops/deploy-release.sh --tag v0.3.0 --dry-run
./ops/deploy-release.sh --tag v0.3.0
```

The workflow is fail closed and performs these steps in order:

1. `ops/download-release.sh` verifies GitHub's immutable Release and downloaded
   asset attestations, rejects unsafe archives, binds the bundle to the exact
   repository/tag, and verifies every payload checksum locally.
2. The operator connection requires `.env.server` mode `0600` or stricter,
   verifies the SSH host key with `accept-new`, and keeps password fallback in a
   temporary `SSH_ASKPASS` helper plus a protected ControlMaster socket. No
   credential is put in argv or deployment logs.
3. The root SSH account creates `/opt/shelter/releases/.incoming` as root-owned
   mode `0700` and acquires the shared ownership-token lock at
   `/opt/shelter/.shelter-install.lock`. The same lock serializes source
   deploys, release deploys, standalone installs, and rollback. A release holds
   it through the final `doctor` result and releases it in that same remote
   transaction. `rsync -rlpt` transfers no owner/group metadata and never
   transfers the operator environment file.
4. The VPS verifies the complete bundle and the exact locally authenticated
   manifest again, then runs `install-release-bundle.sh --dry-run` before any
   immutable release directory is published.
5. A new bundle is renamed atomically to
   `/opt/shelter/releases/vMAJOR.MINOR.PATCH`. An existing directory is reused
   only if its verified manifest is identical. Different content under the same
   tag is rejected.
6. `install-release-bundle.sh --installation /opt/shelter -- --non-interactive`
   installs the digest-pinned control plane while preserving `.env`, and
   `/opt/shelter/install.sh doctor` must pass before the operator command reports
   success.

`--dry-run` performs the local download, temporary remote transport, repeated
verification, and installer dry run, then removes its owned incoming stage. It
does not publish a release directory, pull an image, or update the installation.
Use `--server-env FILE` for a different protected target file and
`--repo OWNER/REPOSITORY` only for an explicitly reviewed fork release.

The lower-level `download-release.sh` and `install-release-bundle.sh` commands
remain available for offline/manual operations. Do not replace this path with a
source rsync when the intended production identity is an immutable release.

## Required repository rules

Repository settings are part of the security boundary and cannot be enforced
by files in this repository alone. Configure rulesets with these minimums:

- For `dev`: require a pull request, resolved conversations, and the PR policy,
  CI, CodeQL, and Dependency Review checks. Block force pushes and deletion.
- For `main`: require a pull request and the same checks, including
  **CI / Development integration gate**. The PR policy additionally permits
  only same-repository `dev` with a higher SemVer. Block direct/force pushes
  and deletion.
- For `v*`: restrict creation to release maintainers and block updates and
  deletion. Keep immutable GitHub Releases enabled and
  `SHELTER_IMMUTABLE_RELEASES_REQUIRED=true`.

For the current single-maintainer repository, required approvals may remain at
zero so the maintainer is not deadlocked by self-review rules. Keep review
threads resolvable and checks mandatory. Raise the approval count to one and
require Code Owner review as soon as a second trusted reviewer is available.

Use these stable aggregate/security check names in both branch rulesets:

- `PR policy / Branch and release policy`
- `CI / Development integration gate`
- `CodeQL / Analyze JavaScript and TypeScript`
- `Dependency Review / Dependency Review`

The development integration gate already depends fail-closed on the workflow,
application, installer, Compose, and container jobs. Requiring the aggregate
avoids brittle ruleset updates when an internal job is renamed without reducing
coverage.

Because GitHub evaluates a newly added workflow only after it exists on the
target branch, the first merge that introduces this policy is a one-time
bootstrap. Review it manually, then configure the required checks before the
next contribution.

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
