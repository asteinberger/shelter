## What changes?

<!-- Describe the problem and solution in a few sentences. Link related issues with "Closes #…". -->

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor or maintenance
- [ ] Operations, deployment, or migration
- [ ] Documentation

## Verification

<!-- List the exact commands and manual checks you ran. -->

- [ ] `npm run typecheck`
- [ ] `npm run test`
- [ ] `npm run build`
- [ ] Relevant manual checks are described below

## Risk and rollback

<!-- Cover database, volumes, configuration, Cloudflare/GitHub, downtime, or write "not applicable". -->

## Screenshots

<!-- For visible changes: include desktop/mobile and light/dark mode. Remove this section otherwise. -->

## Checklist

- [ ] This targets `dev` from `agent/<feature>` or `fix/<name>`, or is the single release PR from `dev` to `main`.
- [ ] A normal contribution leaves the root version unchanged; `agent/release-<version>` changes only the three root version fields.
- [ ] The change is focused and does not include unrelated refactors.
- [ ] New logic is tested, or missing coverage is explained.
- [ ] Documentation and example configuration are current.
- [ ] Existing installations and persistent data remain compatible.
- [ ] No secrets, private data, build artifacts, or logs were added.
- [ ] Security-sensitive assumptions were checked against `SECURITY.md`.
