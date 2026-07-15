# Shelter CLI

The Shelter CLI is the script-friendly command-line client for a self-hosted Shelter installation. It creates and inspects projects, triggers deployments, streams logs, replaces uploaded source archives, and manages project domains through the Shelter API.

## Requirements

- Node.js 24 or newer
- A running Shelter installation
- A Shelter personal API token with the scopes required by the command

Create a token in **Settings → API & CLI** in the Shelter dashboard. The token is shown once.

## Install

From a Shelter source checkout:

```sh
npm run build --workspace @shelter/cli
npm install --global ./apps/cli
```

During local CLI development you can also run:

```sh
npm link --workspace @shelter/cli
```

The package name is `@shelter/cli` and the installed executable is `shelter`.

## Log in

Interactive login keeps the token out of shell history:

```sh
shelter login --server https://hosting.example.com
```

For CI or another non-interactive environment, pass the token over standard input:

```sh
printf '%s' "$SHELTER_TOKEN" | shelter login \
  --server https://hosting.example.com \
  --token-stdin
```

Credentials are stored in `$XDG_CONFIG_HOME/shelter/config.json`, or `~/.config/shelter/config.json` when `XDG_CONFIG_HOME` is not set. The directory is created with mode `0700` and the file with mode `0600`.

`SHELTER_URL` and `SHELTER_TOKEN` override stored credentials. This is the recommended configuration for CI:

```sh
export SHELTER_URL=https://hosting.example.com
export SHELTER_TOKEN='shelter_pat_v1_…'
shelter whoami
```

## Commands

```text
shelter whoami
shelter projects
shelter project <project-id>

shelter create git \
  --name "My app" \
  --repository https://github.com/example/my-app.git \
  --branch main

shelter deploy <project-id>
shelter deploy <project-id> --wait
shelter cancel <deployment-id>
shelter rollback <deployment-id>
shelter rollback <deployment-id> --wait
shelter logs <deployment-id>
shelter logs <deployment-id> --follow

shelter upload <project-id> ./release.zip
shelter upload <project-id> ./release.zip --wait

shelter domains <project-id>
shelter domain add <project-id> app.example.com --zone <cloudflare-zone-id>
shelter domain remove <project-id> <domain-id>

shelter logout
```

`upload` replaces the source of an existing upload-based project. It uses Shelter's chunked upload API, validates the archive server-side, and queues a deployment. Git projects should use `deploy`, which fetches the current repository branch.

`cancel` requests cooperative cancellation of a queued or running deployment. Shelter terminates the active build process and cleans up its candidate container before reporting the deployment as cancelled. Deployments that are already activating cannot be cancelled because Shelter is completing an atomic production switch.

`rollback` creates a new immutable deployment from the selected ready version. The current production version stays online until the restored version passes its health check; use `--wait` to return only after the rollback has reached a terminal state.

## JSON output

Add `--json` anywhere in a command for machine-readable output:

```sh
shelter projects --json
shelter --json deploy prj_123 --wait
```

Regular commands emit one JSON document. `logs --follow --json` is a stream and emits newline-delimited JSON (NDJSON): one object per log followed by a completion object.

Progress messages are written to standard error, keeping standard output safe to pipe into another program.

## Security notes

- The CLI never prints the raw API token.
- Prefer the hidden interactive prompt or `--token-stdin`; do not put tokens directly in command arguments.
- Use a narrowly scoped token for automation and set an expiration date.
- `shelter logout` removes stored credentials, but cannot unset `SHELTER_URL` or `SHELTER_TOKEN` from your shell.
- Revoke a token from the Shelter dashboard if it may have been exposed.

## Development

```sh
npm run typecheck --workspace @shelter/cli
npm run test --workspace @shelter/cli
npm run build --workspace @shelter/cli
```

The CLI has no runtime dependencies and uses the Fetch API included with Node.js 24.

## License

AGPL-3.0-only
