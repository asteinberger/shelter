# Contributing to Shelter

Thank you for helping make Shelter better. The project is still an MVP, so small, focused changes with a clear rationale are the easiest to review and operate safely.

## Before you start

- Search existing issues and pull requests for the same topic.
- Open a feature issue before working on large features, new provider integrations, or breaking changes.
- Never report security vulnerabilities publicly. Follow the process in [SECURITY.md](SECURITY.md).
- Remove tokens, domains, IP addresses, email addresses, and other sensitive values from logs and screenshots.

## Local development

You need Node.js 24 or newer and npm 11 or newer.

```sh
npm ci
npm run dev
```

The development command starts the web app and API together. Run the complete local check before opening a pull request:

```sh
npm run check
```

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the API and web panel in development mode |
| `npm run typecheck` | Run strict TypeScript checks in every workspace |
| `npm run test` | Run server and web tests |
| `npm run build` | Create production builds |
| `npm run check` | Run typecheck, tests, and build |

Local tests use temporary data and do not modify real Cloudflare, GitHub, or Docker resources. Only run provider or VPS smoke tests with explicit approval and disposable test resources.

GitHub also runs the full check, installer and release-bundle tests, Compose
validation, a production container build, CodeQL, and Dependency Review. All
third-party Actions are pinned to complete commit SHAs; keep the version comment
when Dependabot updates a pin.

## Releases

Only maintainers publish releases. Do not create `v*` tags from a contribution
branch or upload release assets manually. The release workflow accepts a
version-matching commit on `main`, builds the multi-platform image once, emits
signed provenance and SBOM attestations, and publishes an immutable GitHub
Release. See [docs/RELEASES.md](docs/RELEASES.md) for the complete process and
verification model.

## What makes a good change

- Keep each pull request focused on one problem or feature.
- Add a regression test for bug fixes and positive and negative tests for new logic.
- Preserve compatibility with existing SQLite databases, volumes, and environment variables.
- Document new configuration in `.env.example` or `.env.server.example` and in the README.
- Reuse the existing UI components and design tokens. Check light mode, dark mode, keyboard navigation, empty states, and small viewports.
- Validate input at API boundaries and treat Cloudflare, GitHub, upload, and deployment code as security-sensitive.

## Pull requests

A pull request should include:

1. a concise description of the problem and the chosen solution,
2. links to related issues,
3. the exact tests that were run,
4. screenshots or a short recording for visible UI changes,
5. migration, rollback, and operational-risk notes when relevant.

By contributing, you confirm that you created the code or may contribute it under terms compatible with the project license. Contributions are published under [GNU AGPL-3.0-only](LICENSE).
