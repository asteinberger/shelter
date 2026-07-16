# AGENTS.md

This file applies to the entire repository. It defines the guardrails for coding agents and automated contributions. Human contributors should also follow [CONTRIBUTING.md](CONTRIBUTING.md).

## Product context

Shelter is a self-hosted deployment control plane for a single VPS. Changes should make operations simpler without silently weakening security boundaries, upgrade paths, or existing installations.

## Repository map

| Path | Purpose |
| --- | --- |
| `apps/web` | React/Vite panel with a shadcn-oriented UI and light and dark themes |
| `apps/server` | Fastify API, SQLite, Cloudflare/GitHub integration, and deployment worker |
| `apps/server/test` | Server, integration, and regression tests |
| `docs/API.md` | Public API authentication, workflows, and CLI entry point |
| `compose.yaml`, `Dockerfile`, `install.sh` | VPS installation and runtime |
| `ops/` | Deployment and operational helpers |
| `README.md`, `SECURITY.md` | Operator documentation and security model |

## Working method

1. Synchronize `dev`, then create `agent/<feature>` for planned work or
   `fix/<name>` for a defect. Never develop directly on `dev` or `main`.
2. Read the affected files, nearby tests, and relevant documentation before changing behavior.
3. Keep the patch focused on the requested behavior. Do not mix in unrelated refactors.
4. Preserve existing APIs, data, volumes, and configuration. Breaking changes require a documented migration.
5. Add a regression test for a bug fix and suitable positive and negative tests for new logic.
6. Run focused tests first and, whenever possible, `npm run check` before finishing.
7. Update the README, example environment files, security model, or UI copy when user-facing or operational behavior changes.
8. Open the contribution PR against `dev`. A normal feature/fix PR must not
   alter the root release version. Wait for required checks and review before
   merging, then verify the development integration gate on the resulting
   `dev` revision.

Do not push, merge, prepare a release, or create a tag unless the task grants
that exact authority. A request to implement code does not implicitly authorize
publishing it.

## Security boundaries

- Never print, commit, or copy into fixtures `.env`, `.env.server`, `APP_SECRET`, passwords, session cookies, OAuth codes, GitHub keys, or Cloudflare tokens.
- Do not modify production VPS, Cloudflare, GitHub, or DNS resources unless the task explicitly authorizes it. Real provider tests must use disposable resources.
- Only the worker may receive the Docker socket. The API, Traefik, and `cloudflared` must never mount it.
- Traefik uses the file provider. Project containers must not expose public host ports.
- Never overwrite or delete Cloudflare DNS records blindly. Verify ownership, zone, hostname collisions, and the current target first.
- The GitHub App requests only permissions it actually needs. `installation` and `installation_repositories` are implicit GitHub App events and must not be listed in the manifest; `push` and `pull_request` are the configurable default events.
- Treat a manifest-based GitHub App upgrade as credential rotation, not an in-place update. Stage and verify the replacement without disturbing the active App or project links, switch only after installation checks pass, and never imply that Shelter can delete the old App registration on GitHub.
- Do not bypass OAuth `state`, CSRF protection, session binding, or redirect-URI validation.
- Keep upload and archive handling protected against path traversal, symlinks, device files, size abuse, and decompression abuse.
- Keep project analysis advisory and bounded. Read only allowlisted manifests, never read real `.env` contents, ignore generated dependency/output trees, and revalidate source on the worker before building.
- Project previews may only open internal targets derived from stored project and deployment data. The image endpoint remains authenticated. Screenshots may contain confidential data and must not appear in logs or public fixtures.
- Never interpolate unvalidated user values into shell commands, Docker names, file paths, URLs, or headers. Prefer argument-based process calls and explicit validation.
- Do not remove or rename existing database columns, tables, Docker volumes, or legacy names without an additive and idempotent migration.

## Code and product conventions

- TypeScript remains strict, ESM-based, and free of unnecessary `any` types.
- Validate external input at system boundaries. Error responses must not reveal internals or secrets.
- Database changes must be transactional, repeatable, and compatible with existing installations.
- Public documentation and the marketing website are written in English. The app supports English and German through the shared i18n layer; do not add hard-coded user-facing copy.
- Reuse existing components and tokens, semantic HTML, visible focus states, and functioning light and dark themes.
- Status must not be communicated by color alone. Asynchronous actions need loading, success, error, and empty states.
- Keep modules focused and prefer existing helpers over duplicate provider or process logic.
- Comments should explain reasons or security assumptions, not restate obvious code.

## Useful commands

```sh
npm ci
npm run dev
npm run typecheck
npm run test
npm run build
npm run check
```

For a focused run:

```sh
npm run test -w @shelter/server -- <test-file>
npm run test -w @shelter/web -- <test-file>
```

## Operational and deployment changes

- Treat `install.sh`, `compose.yaml`, `Dockerfile`, `ops/`, and database migrations as high-risk surfaces.
- Preserve a rollback path, back up persistent data, and document new variables in the example files.
- A release is not ready until API health, worker status, login, at least one deployment, and routing have been verified at the appropriate level.
- Deploy published production versions with `ops/deploy-release.sh`, not the
  mutable source deployer. Preserve its local and remote verification order,
  root-only incoming staging, atomic immutable release directory, and final
  `doctor`; never weaken a dry run into an unverified plan.
- Never claim a successful live test when only mocks or local tests ran. State the actual verification depth clearly.

## Promotion and release flow

- A release contains the reviewed state of `dev`; do not cherry-pick feature
  branches directly to `main`.
- Once `dev` is green, a maintainer runs
  `npm run release:prepare -- <version>`. The script requires a clean,
  synchronized `dev`, verifies that `main` contains no tree changes missing
  from `dev`, creates
  `agent/release-<version>`, writes the one explicit SemVer bump, and restores
  the version files if the complete check fails.
- Commit only the root version fields in `package.json` and `package-lock.json`
  on that release branch and open its PR to `dev`. This is the only PR type
  allowed to change the root version before promotion; never push the bump
  directly to `dev`.
- After the release-preparation PR merges and the development integration gate
  passes, open the only permitted `main` PR: same-repository `dev` to `main`.
  The PR policy requires a higher, consistent version in `package.json` and
  `package-lock.json`.
- After that PR is reviewed, green, and merged, synchronize local `main` and
  create an annotated `v<version>` tag on the exact merge commit. The release
  workflow validates tag, commit, branch, and version identity, then reuses the
  immutable pipeline with Sigstore-signed provenance, SBOM and release-asset
  attestations documented in [docs/RELEASES.md](docs/RELEASES.md).
- A failed publication is never repaired by moving or reusing a tag. Fix the
  issue on a new feature/fix branch and prepare a new version.

## Definition of done

- The requested behavior is implemented and verified manually or automatically.
- Relevant tests, type checks, and builds pass.
- No secrets, temporary databases, builds, or logs were newly tracked.
- Failure paths, migration, dark mode, and mobile layout were considered where relevant.
- User and operator documentation matches the code.
