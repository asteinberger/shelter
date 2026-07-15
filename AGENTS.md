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

1. Read the affected files, nearby tests, and relevant documentation before changing behavior.
2. Keep the patch focused on the requested behavior. Do not mix in unrelated refactors.
3. Preserve existing APIs, data, volumes, and configuration. Breaking changes require a documented migration.
4. Add a regression test for a bug fix and suitable positive and negative tests for new logic.
5. Run focused tests first and, whenever possible, `npm run check` before finishing.
6. Update the README, example environment files, security model, or UI copy when user-facing or operational behavior changes.

## Security boundaries

- Never print, commit, or copy into fixtures `.env`, `.env.server`, `APP_SECRET`, passwords, session cookies, OAuth codes, GitHub keys, or Cloudflare tokens.
- Do not modify production VPS, Cloudflare, GitHub, or DNS resources unless the task explicitly authorizes it. Real provider tests must use disposable resources.
- Only the worker may receive the Docker socket. The API, Traefik, and `cloudflared` must never mount it.
- Traefik uses the file provider. Project containers must not expose public host ports.
- Never overwrite or delete Cloudflare DNS records blindly. Verify ownership, zone, hostname collisions, and the current target first.
- The GitHub App requests only permissions it actually needs. `installation` and `installation_repositories` are implicit GitHub App events; only `push` is used as a configurable default event.
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
- Never claim a successful live test when only mocks or local tests ran. State the actual verification depth clearly.

## Definition of done

- The requested behavior is implemented and verified manually or automatically.
- Relevant tests, type checks, and builds pass.
- No secrets, temporary databases, builds, or logs were newly tracked.
- Failure paths, migration, dark mode, and mobile layout were considered where relevant.
- User and operator documentation matches the code.
