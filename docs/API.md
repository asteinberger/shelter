# Shelter API

Shelter exposes the same project and deployment capabilities used by its web panel as an authenticated HTTP API. Every installation serves its own API and OpenAPI document.

## Discover the API

Replace `https://panel.example.com` with the public URL of your Shelter installation:

```text
https://panel.example.com/api
https://panel.example.com/api/openapi.json
```

The API currently follows the Shelter `1.0.0` contract. It is part of the MVP, so review release notes before upgrading automation across Shelter versions.

## Create an access token

1. Sign in to the Shelter panel.
2. Open **Settings → API & CLI**.
3. Choose **Create token**.
4. Give the token a purpose-specific name, choose its access level and expiration, then confirm with the current administrator password.
5. Copy the secret immediately. Shelter stores only its hash and cannot show it again.

Two access presets are available:

| Preset | Scopes |
| --- | --- |
| Read only | `projects:read` |
| Deploy & manage | `projects:read`, `projects:write`, `deployments:write`, `uploads:write`, `domains:write`, `environment:write` |

Tokens expire after at most 365 days. Revocation takes effect on the next request. Changing the administrator password revokes every active API token.

## Authenticate requests

Send the token in the standard Bearer header:

```sh
export SHELTER_URL=https://panel.example.com
export SHELTER_TOKEN='shelter_pat_v1_…'

curl --fail-with-body \
  --header "Authorization: Bearer $SHELTER_TOKEN" \
  "$SHELTER_URL/api/projects"
```

Use HTTPS for every remote Shelter installation. Never put a token in a URL, command argument, repository, image, build log, or issue. Store CI tokens in the CI provider's encrypted secret store and prefer one token per automation.

API-token requests do not use the browser's CSRF header. Browser sessions still require CSRF protection for mutations. Cloudflare and GitHub connection setup, access-token management, password changes, sign-out, server metrics, and project observability/runtime logs remain browser-session-only.

## Core workflows

### Analyze project files

`POST /api/projects/analyze` performs the same bounded, advisory source analysis used by the project form. It requires `projects:read` and accepts file facts rather than an archive:

```sh
curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer $SHELTER_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{
    "files": [
      {"path":"package.json","content":"{\"scripts\":{\"build\":\"vite build\"},\"dependencies\":{\"react\":\"19.1.0\",\"vite\":\"7.0.0\"}}"},
      {"path":"src/main.tsx","size":1200},
      {"path":"package-lock.json","size":42000}
    ]
  }' \
  "$SHELTER_URL/api/projects/analyze"
```

Requests are limited to 10,000 safe relative POSIX paths, 512 KiB of allowlisted manifest content, and a 4 MiB HTTP body. Send lockfiles and source files as presence/size facts only. Content from real `.env` files is rejected; only explicit example/sample files may be inspected, and responses expose variable keys rather than values. The result includes detected applications, framework and rendering mode, package manager, root, commands, output directory, port, confidence, and evidence. Workspace-root manifests and lockfiles should be included when analyzing a monorepo so the recommended commands match the eventual npm, pnpm, Yarn, or Bun build. Treat the result as a recommendation: Shelter validates the checked-out or extracted source again during deployment.

### Verify a token

```sh
curl --fail-with-body \
  --header "Authorization: Bearer $SHELTER_TOKEN" \
  "$SHELTER_URL/api/api-tokens/current"
```

### Create a project from public Git

```sh
curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer $SHELTER_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{
    "name": "Example app",
    "repositoryUrl": "https://github.com/example/app.git",
    "branch": "main"
  }' \
  "$SHELTER_URL/api/projects/git"
```

GitHub App repository selection and linking remain interactive, browser-session-only operations. Automation can create a project from a public HTTPS Git source and redeploy an already configured GitHub-backed project.

### Deploy current source

```sh
curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer $SHELTER_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{}' \
  "$SHELTER_URL/api/projects/prj_REPLACE/deploy"
```

The response contains a deployment ID. Poll its state and logs:

```sh
curl --fail-with-body \
  --header "Authorization: Bearer $SHELTER_TOKEN" \
  "$SHELTER_URL/api/deployments/dep_REPLACE"

curl --fail-with-body \
  --header "Authorization: Bearer $SHELTER_TOKEN" \
  "$SHELTER_URL/api/deployments/dep_REPLACE/logs?after=0"
```

Terminal deployment states are `ready`, `failed`, and `cancelled`.

Deployment responses include structured safety metadata:

- `failureKind` distinguishes timeouts, build failures, health-check failures, activation failures, worker interruptions, superseded builds, and user cancellation.
- `cancelRequestedAt` is set while cooperative cancellation is still stopping the active process and cleaning up.
- `rollbackStatus` and `rollbackDeploymentId` report whether Shelter automatically kept or restored the prior production deployment.

### Cancel a deployment

Queued and running deployments can be cancelled through the deployment resource:

```sh
curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer $SHELTER_TOKEN" \
  "$SHELTER_URL/api/deployments/dep_REPLACE/cancel"
```

Cancellation is cooperative. A running Docker or Git process is terminated and candidate resources are removed before the deployment reaches the terminal `cancelled` state. The short `switching` phase cannot be cancelled because Shelter is completing an atomic traffic transition.

### Roll back to a ready deployment

Rollback creates a new immutable deployment; it does not mutate deployment history:

```sh
curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer $SHELTER_TOKEN" \
  "$SHELTER_URL/api/deployments/dep_READY_VERSION/rollback"
```

The current production container stays online while the selected image is started and health-checked. Shelter switches routing only after the candidate is healthy.

### Replace uploaded source

Upload-based projects use a resumable ZIP workflow:

1. `POST /api/uploads` with the filename and exact byte size.
2. Split the file according to the returned `chunkSize`.
3. `PUT /api/uploads/{uploadId}/chunks/{index}` with each binary chunk.
4. `POST /api/uploads/{uploadId}/complete`.
5. `PUT /api/projects/{projectId}/source` with the completed `uploadId`.

Use the Shelter CLI for this workflow unless direct HTTP integration is required; it handles chunk sizing, cleanup, completion, and optional deployment waiting.

### Manage domains

List active Cloudflare zones with `GET /api/settings/cloudflare/zones`. Add a hostname with `POST /api/projects/{projectId}/domains` and remove it with `DELETE /api/projects/{projectId}/domains/{domainId}`. Domain mutations require a connected Cloudflare account and the `domains:write` scope.

### Inspect project observability in the administrator panel

The following read-only endpoints intentionally require the administrator's browser session and reject personal access tokens because application output can contain sensitive data:

- `GET /api/projects/{projectId}/observability?range=1h` returns the active production container's CPU, memory and configured limits, network rates, block I/O, uptime, restart count, OOM/health/status, concrete warning states, and at most 180 downsampled history points. Ranges are `15m`, `1h`, `6h`, `24h`, and `48h`.
- `GET /api/projects/{projectId}/runtime-logs?after=0&limit=500` returns bounded structured output for the active deployment only.
- `GET /api/projects/{projectId}/runtime-logs/stream?after=0` forwards newly persisted records over SSE. The worker collects Docker output at `METRICS_INTERVAL_SECONDS`, so this is near-live rather than instantaneous streaming. Connections are rate-limited and rotate after ten minutes.

Runtime output is separate from immutable build/deployment logs. Shelter keeps at most 5,000 lines per project within `METRICS_RETENTION_HOURS` and returns at most 500 at once. The worker redacts exact values of configured project environment variables before persistence. Applications can still print derived, encoded, split, or reformatted secrets, so review runtime logs as sensitive administrator data before sharing them. The API process never receives the Docker socket; only the worker performs the label-validated collection.

## Errors and rate limits

Errors use a stable JSON envelope:

```json
{
  "error": "Human-readable message",
  "code": "MACHINE_READABLE_CODE"
}
```

Typical status codes are:

| Status | Meaning |
| --- | --- |
| `400` | Invalid input |
| `401` | Missing, malformed, expired, or revoked token |
| `403` | Token lacks the required scope, or a browser session is required |
| `404` | Resource does not exist |
| `409` | Current project, upload, deployment, or domain state conflicts with the request |
| `429` | Rate limit exceeded |
| `502` | An upstream provider such as Cloudflare failed |

Clients should use the machine-readable `code`, apply bounded retries only to transient failures, and never retry validation or permission failures blindly.

## Shelter CLI

The standalone [Shelter CLI](https://github.com/asteinberger/shelter-cli) wraps these API workflows:

```sh
git clone https://github.com/asteinberger/shelter-cli.git
cd shelter-cli
npm ci
npm run build
npm install --global .
shelter login --server https://panel.example.com
shelter projects
```

See the [CLI repository](https://github.com/asteinberger/shelter-cli) for all commands, JSON output, CI environment variables, and credential-storage details.
