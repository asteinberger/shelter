# Shelter Security Policy

Shelter manages builds, DNS, and containers on a Docker host. A compromised administrator account or worker must therefore be treated as a full compromise of the VPS. This policy describes the current MVP and does not replace hardening the operating system, Docker, or Cloudflare.

## Supported versions

Security fixes currently apply only to the latest state of the primary development branch. There are no long-term support release lines yet. Reports should include the commit or Shelter version, Compose configuration, and affected image versions.

## Reporting a vulnerability

Report vulnerabilities privately. On GitHub, prefer **Security → Report a vulnerability** and GitHub Private Vulnerability Reporting. If no private reporting channel is enabled, first contact the repository owner through a monitored private channel without technical details and arrange a secure disclosure path. Never publish exploit details, credentials, or unpatched vulnerabilities in a public issue.

A useful report includes:

- the affected version or commit,
- prerequisites and reproducible steps,
- expected and observed behavior,
- likely impact and attack scenario,
- the smallest necessary set of already-redacted logs or requests,
- known workarounds.

Never send real administrator passwords, session cookies, CSRF tokens, `APP_SECRET`, Cloudflare OAuth client secrets, access/refresh/API/tunnel tokens, GitHub App private keys, webhook secrets, installation tokens, project variables, or complete `.env` files. Testing must not affect third-party systems, Cloudflare or GitHub accounts, repositories, domains, or data. Destructive tests and persistence on a VPS that was not explicitly approved for testing are prohibited.

## Threat model

### Assets

- the Docker daemon and host operating system,
- administrator account, session, and CSRF token,
- `.env`, including `ADMIN_PASSWORD_B64` and `APP_SECRET`,
- Cloudflare OAuth client secret, access/refresh/API tokens, tunnel ID, and connector token,
- GitHub App private key, webhook secret, and short-lived installation tokens,
- short-lived OAuth values such as `state`, PKCE verifier, callback nonce, and pending account selection,
- project environment variables,
- source archives, Git contents, build logs, and generated images,
- SQLite database, DNS mappings, and Traefik routes.

### Trust boundaries

The external request path is Cloudflare Edge → `cloudflared` → Traefik → API or project container. The VPS establishes the tunnel outbound. Traefik selects a target from the Host header and generated file-provider configuration.

The API and worker are separate processes and containers. They share `shelter-data`, including the SQLite database, and `shelter-routing`. The API additionally mounts `shelter-tunnel`; the worker cannot access it. Traefik reads only the routing volume and `cloudflared` reads only the tunnel volume. Only the worker has the Docker socket. The control network connects API, worker, the current Shelter Traefik generation, and `cloudflared`. The worker is not attached to application networks. Each project has a separately owned bridge network containing that project's runtimes, its short-lived health/preview helpers when active, and the current Shelter Traefik generation. Migration from the legacy shared network removes a runtime's legacy attachment only after both the project network and Traefik attachment have been verified.

The worker asks Docker to create disposable health-probe and Chromium-preview helpers on the relevant project network; it does not open the project from inside the worker. Helpers receive no Docker socket or host bind mount, have a read-only root filesystem, drop all capabilities, and use bounded memory, CPU, PIDs, temporary storage, output size, and execution time. Random invocation labels are checked before cleanup so Shelter will not delete an unrelated container with a colliding name.

The central trust assumption is that the administrator and deployed source code are trusted. Anyone who can sign in to the panel and deploy a project can build and run code and must be treated like a VPS administrator.

### Considered attackers

- unauthenticated internet users targeting the panel or hosted applications,
- attackers with stolen administrator or Cloudflare credentials,
- attackers attempting to manipulate, replay, or bind OAuth callbacks to another browser or administrator session,
- compromised dependencies or container images,
- faulty or malicious project code,
- attackers with access to backups, SQLite, or the host filesystem.

### Outside the security guarantee

Shelter does not protect against:

- a malicious or compromised administrator,
- hostile Dockerfiles, build scripts, or dependencies as a hard tenant sandbox,
- root, Docker socket, kernel, or Docker daemon compromise,
- side channels or denial of service between projects on the same VPS,
- a compromised project attacking another project through channels outside Shelter's project bridge isolation, including the shared kernel, Docker daemon, host resource exhaustion, or a compromised routing tier,
- compromise of the Cloudflare account or upstream registries,
- abuse of granted OAuth permissions after compromise of an administrator session, the API container, `APP_SECRET`, or OAuth client credentials,
- secrets exposed, transmitted, or logged by an application itself,
- complete availability; the MVP has one node and no high availability.

## Implemented controls

### Control plane

- API and worker run separately; only the worker mounts the Docker socket.
- Server metrics are collected in the worker and reduced to bounded numeric snapshots in SQLite. The API reads those snapshots and never receives Docker access.
- Docker stats cover only containers with Shelter or legacy Portsmith management labels; raw inspect output, container IDs, names, labels, and environment values are not persisted or returned.
- Control-plane containers use a read-only root filesystem, `no-new-privileges`, and no Linux capabilities.
- The host publishes the panel only on `127.0.0.1`.
- Traefik uses the file provider and has no Docker socket.
- `cloudflared` creates an outbound public connection; Traefik and applications publish no host ports.
- Every project receives a separately labelled bridge network. The worker remains on the control network; only the project's runtime/helper containers and the currently managed Shelter Traefik generation are attached to that project network.

### Installer and update path

- `install.sh` operates from the checked-out Shelter directory and changes Docker state with the operator's privileges. Run it only from a revision you have verified; access to the Docker daemon is root-equivalent.
- The installer validates Linux, Docker daemon access, Compose v2, Buildx, required host tools, capacity, `.env`, and Compose configuration before replacing the control plane, and reports a missing or non-standard Docker socket. `./install.sh doctor` performs the same host and configuration checks without starting, stopping, or rebuilding containers.
- One owner-token operation lock serializes manual installs, remote source synchronization, and deploy-triggered installs. New `.env` files and bootstrap-value changes use a restricted temporary file followed by an atomic rename, and `.env` is kept at mode `0600`. Symlinked, structurally invalid, duplicate-key, or placeholder-secret configurations are rejected.
- Initial passwords are accepted only from an interactive terminal or standard input. The installer has no password command-line option or password environment variable. Non-interactive automation should redirect a protected, single-line secret file to `--password-stdin` and remove that file after secure handoff.
- The installer fails closed when the default data volume exists without its matching `.env`, or when a configured data volume is unexpectedly empty. `--bootstrap-empty-volume` is an explicit recovery override for a volume that the operator has independently verified is intentionally empty; it is not a way to bypass suspected data loss.
- Before replacing a ready control plane, the installer identifies the API and worker container images, requires them to match, and retains that image under a content-derived tag whose image ID is rechecked. It then pauses both writers, builds a temporary SQLite snapshot, runs `quick_check`, flushes it, and atomically renames it to `shelter-before-update.sqlite` inside the data volume.
- Rollback metadata is stored outside the source checkout in a mode-`0700` directory in the configured data volume; its files are mode `0600`, written through fsync plus atomic rename, and parsed as a strict non-executable key/value format. A ready bundle records the prior and new revision/image identifiers, validated snapshot path and schema, and SHA-256 digest of the restricted saved prior Compose file. Validation runs in a networkless, capability-free helper container with the data volume read-only.
- `./install.sh rollback` validates the metadata, retained image ID, Compose digest, and SQLite `quick_check` before touching writers and repeats validation after both writers stop. It saves a diagnostic copy of the current database, restores the validated snapshot with an atomic rename, and starts the prior API/worker only with `--no-build`. API health, worker connectivity, and Traefik health are mandatory. Any failure after the stop boundary leaves API and worker stopped; an older binary is never started against a database that has not first been restored to its validated matching snapshot.
- Existing installations initially lack a trustworthy saved prior Compose baseline. Because `compose.yaml` currently uses a mutable local image reference and the image lacks an immutable release/revision label, the first update with this installer records an explicitly `incomplete` bundle and fails closed if the new revision may have migrated the database. A successful run records the baseline for the next update. Future integration should use immutable release image references plus an OCI revision label so the first transition can be proven without this bootstrap gap.
- The rollback snapshot is replaced by the next update and covers only SQLite and the control plane. It is not a complete backup; normal retention and restore testing remain required.
- Compact interactive installer output is backed by `.shelter-install.log` after a failed run. Non-interactive and verbose output is streamed instead. The file has restrictive permissions and is removed after success, but its Docker output and host details must still be treated as operationally sensitive and redacted before sharing.

### Authentication and requests

- Passwords are hashed with scrypt and a random salt.
- Session and CSRF tokens are random. Only a SHA-256 hash of each session token is stored. The session record also holds the CSRF token alongside its verification hash so multiple tabs can share it; the token is not sufficient without the HttpOnly session cookie.
- Session cookies are `HttpOnly` and `SameSite=Strict`, and also `Secure` behind HTTPS.
- Mutations require a CSRF header and, when present, compare the Origin with the forwarded host.
- Failed logins are limited to five attempts per minute.
- The API sends CSP, frame, MIME, referrer, and permissions headers.

The Cloudflare connection flow can only start from an authenticated administrator session and uses the same CSRF and Origin protection as other mutations. Shelter creates cryptographically random OAuth `state` and PKCE values per attempt and uses PKCE `S256`. The server stores only a `state` hash, a separate browser-nonce hash, and the PKCE verifier encrypted under `APP_SECRET`. The record is bound to the user and a still-valid administrator session, consumed atomically once, and expires after at most ten minutes.

The short-lived callback cookie contains only the random browser nonce, never `state`, an authorization code, or a token. It is `HttpOnly`, `SameSite=Lax`, additionally `Secure` under HTTPS, and scoped to the exact callback path. `Lax` is required so the top-level redirect from Cloudflare includes the cookie. A callback without the matching cookie, `state`, server record, and still-valid originating session is rejected. The code exchange runs server-side with the configured redirect URI, PKCE verifier, and `client_secret_basic`.

Traefik access logs are disabled globally. API request logging is also disabled for the OAuth callback route so authorization codes, `state`, and error parameters are not recorded from the request URL. Token responses, client secrets, PKCE verifiers, and pending connection records must never be emitted as structured log fields or error messages. This does not protect against host root, process dumps, external debug proxies, or deliberately unsafe logging changes.

Cloudflare Access is not configured or verified automatically. Shelter exposes a checklist and stores an administrator confirmation bound to the exact current panel hostname; changing the hostname invalidates the confirmation. Until confirmation, the panel shows a red production-unsafe status without disabling deployments. This status records an operator acknowledgement and must not be interpreted as proof that an Access application or policy exists or is restrictive. Access remains a recommended additional layer and does not replace Shelter authentication or strong administrator credentials.

### Sources and deployments

- Manual Git accepts HTTPS URLs without embedded credentials only. Interactive prompts and the local Git protocol are disabled.
- Manual Git URLs may not contain a query, fragment, or custom port. Linked GitHub sources are reconstructed server-side exclusively from the repository ID and validated full name supplied by GitHub.
- Private GitHub clones use short-lived installation tokens restricted to one repository and `contents:read`. They are supplied to Git through a temporary `GIT_ASKPASS` process, never stored, and never included in URLs, arguments, or logs.
- Project-root and Dockerfile paths must remain relative and may not escape the project workspace.
- ZIP archives are inspected before extraction for traversal, absolute paths, links and device files, entry count, expanded size, and extreme compression ratios.
- Host-side Git and Docker operations are spawned without a shell and with separate arguments.
- Git clones and Docker builds have configurable time limits; a timeout terminates the related process group.
- Builds run through a dedicated, Shelter-owned Docker-container BuildKit builder with validated memory, memory-plus-swap, CPU, PID, cache-GC, and maximum-parallelism settings. When Buildx supports per-build resource flags, the same memory and CPU limits are supplied to each build. A continuously sampled filesystem guard cancels cancellable source/build work and refuses completion when free space is unknown or below `BUILD_MIN_FREE_GB`.
- Project variables are passed to automatic builds as a short-lived BuildKit secret instead of Docker `ARG` or persistent `ENV` values.
- Automatic presets also use a non-secret per-deployment cache key so the secret-dependent build step cannot be incorrectly reused from an older cache. Custom Dockerfiles with project variables build without cache because their secret dependencies are unknown.
- A candidate container must pass an HTTP health check from a disposable bounded helper on its own project network before activation.
- Runtime containers receive memory, CPU, and PID limits, `no-new-privileges`, no Linux capabilities, and bounded local Docker logs.
- Website previews are captured by a separate disposable bounded helper on the project's network. Health and preview helpers have no Docker socket or host mount and are removed after ownership verification. The API returns a preview only to an authenticated administrator and accepts no caller-controlled capture target.

These controls reduce accidental damage. They do not make build or runtime safe for untrusted tenants: all projects still share one kernel and Docker daemon, and the trusted worker retains host-equivalent Docker access. Build limits bound the dedicated BuildKit container and supported per-build execution, but they are not a hostile-code sandbox. BuildKit's cache target and minimum-free-space policy are garbage-collection guardrails, not a hard storage quota for a single in-progress build. Docker also does not provide Shelter with a portable per-container writable-layer quota, so a malicious build or runtime can still consume host storage until host-level storage limits intervene. A correctly used BuildKit secret mount does not automatically persist in an image layer, but a build script or custom Dockerfile can still print, copy, or embed its value.

### GitHub App and webhooks

Manifest registration begins only from an authenticated administrator session. Shelter binds the cryptographic manifest `state` to the user, session, and a short-lived `SameSite=Lax` browser cookie; that callback value is consumed once. A separately hashed setup `state` remains valid for later installations of the same private app and is checked with the App ID. Public callback and webhook origins are set server-side. The private key and webhook secret are purpose-encrypted with AES-256-GCM under `APP_SECRET`.

Webhook signatures are verified against the unmodified request body with HMAC-SHA-256 and constant-time comparison. Valid push events are persisted and resolved by the worker; the HTTP response does not depend on subsequent GitHub API calls or builds. Repository, installation, and branch IDs must match the saved project connection. Multiple pushes coalesce to the latest branch HEAD, older builds are cancelled before activation, and commit-status updates use a persistent retry queue.

This does not prevent deployment of deliberately malicious repository code. Anyone who can write to the selected branch of a linked repository can build and run code on the VPS. Keep write access, branch protection, and GitHub App installation scope as narrow as possible. Disconnecting or suspending an installation pauses new automatic deployments without forgetting the selected auto-deploy preference.

After each processed deployment, the worker limits only Shelter's dedicated builder cache with `docker buildx prune --builder shelter-builder --max-used-space` and removes unused Shelter-labelled images. Sharing the worker's Docker daemon with unrelated or untrusted build systems remains outside the intended operating model because the worker itself has host-equivalent socket access.

### Cloudflare and DNS

- The OAuth client requests only Account Read, Zone Read, DNS Write, and Cloudflare Tunnel Write. The API-token fallback can be restricted to one account and selected zones.
- Shelter searches zones only under the configured account ID.
- An existing DNS record that does not target the Shelter tunnel is not adopted or overwritten.
- A DNS record is deleted only if it still points to Shelter's tunnel.
- When the panel domain changes, Shelter first creates the new CNAME. The previous domain remains a routed alias for sessions, OAuth callbacks, and rollback. Shelter currently has no automatic cleanup endpoint for that alias.

A dedicated tunnel name is required. Shelter rejects initial setup when an unrelated tunnel already uses the name. After creating its own tunnel, Shelter immediately persists the account, ID, and name ownership before configuration and token steps. A partially failed setup can therefore resume with the exact tunnel. Changing account or tunnel ID still requires a planned migration. The stored tunnel's name can be changed: Shelter first checks for collisions, updates the exact stored tunnel ID through Cloudflare, and writes the local name only after the remote request succeeds.

When Cloudflare returns multiple authorized accounts, Shelter keeps the OAuth response and server-derived account list only as an `APP_SECRET`-encrypted pending record that expires after at most 30 minutes. Selection again requires a valid administrator session and accepts only an account ID from that authorized list. Permanent credentials are stored only afterward; expired or replaced pending records are discarded.

Access and refresh tokens are encrypted at rest, expiry is checked, and refresh happens server-side. **Disconnect Cloudflare** attempts remote revocation and removes local OAuth credentials and pending data regardless of that result. Remote revocation is best effort because of possible network failure; if in doubt, revoke authorization in Cloudflare as well. Shelter cannot revoke an API token loaded from `.env`.

The tunnel connector uses a separate connector token in the tunnel volume. The existing tunnel intentionally stays online after the management OAuth connection is removed, and existing routes may keep serving. DNS and tunnel changes remain unavailable until reconnection. Fully shutting down or removing the tunnel also requires stopping the connector and rotating or deleting the tunnel in Cloudflare.

## Secret handling

### Local VPS access

The optional `.env.server` is local deployment configuration for SSH target, destination, and authentication only. It is separate from the application runtime `.env`, ignored by Git, excluded from rsync, and excluded from the Docker build context. `ops/deploy.sh` accepts it only when group and world permissions are disabled. It must never reach the VPS, a container, a Shelter backup, or a CI artifact.

Prefer an SSH key or short-lived agent key to a stored root password. With the password fallback, a temporary `SSH_ASKPASS` helper reads the secret directly from the protected file; it is not passed as a command-line argument or exported environment variable to `ssh` or `rsync`. This cannot protect a compromised local account or host root. Remove the saved password and rotate the server password after switching to key authentication.

### `.env` and `APP_SECRET`

The installer creates `.env` atomically with mode `0600`. During first boot it briefly contains the bootstrap administrator password as a Base64 transport value (`ADMIN_PASSWORD_B64`, explicitly not encryption). After creating the user, the installer removes the value atomically and recreates the API without it. If bootstrap fails before that point, the value may remain so the same installation can resume; keep `.env` protected and rerun the installer instead of copying, printing, or manually editing the bootstrap fields. `APP_SECRET` remains. OAuth setups also keep client ID, client secret, redirect URI, scopes, and possibly a proxy URL with credentials; fallback setups may include the Cloudflare API token. Only the API loads the OAuth client secret and optional proxy configuration. The worker does not inherit `.env` and receives neither through its explicit allowlist. GitHub App credentials are encrypted in SQLite instead of `.env`.

A credentialed proxy is part of the secret and trust boundary. With an `http://` proxy URL, proxy authentication is not TLS-protected before reaching the proxy; use it only for a local or otherwise isolated trusted proxy. Remote credentialed proxies require HTTPS.

`APP_SECRET` is derived into an AES-256-GCM key and encrypts:

- Cloudflare OAuth access/refresh tokens and API tokens saved through the panel,
- short-lived PKCE verifiers and pending OAuth connection records,
- GitHub App private key and webhook secret,
- project environment variables.

Do not rotate `APP_SECRET` without an explicit migration. Changing or losing it makes existing encrypted values unreadable. Every restore must therefore pair the data volume with its matching `.env`.

Encryption protects against isolated SQLite disclosure. It does not protect when the attacker also has `.env`, a running control-plane container, the Docker daemon, or the host.

### Cloudflare connector token

The tunnel token is stored as `/tunnel/tunnel-token` in the separate `shelter-tunnel` volume and is not additionally encrypted under `APP_SECRET`. Only the API and `cloudflared` mount the volume; `cloudflared` mounts it read-only. Treat it as a secret. If it may have leaked, rotate the tunnel or connector credentials in Cloudflare and reconfigure Shelter.

### Project variables

Saved values are never returned to the browser. The worker decrypts them for build and container startup. Generated Dockerfiles receive them during the actual build command through the BuildKit secret mount `/run/secrets/shelter_env` and use a non-secret cache key to force re-execution. A custom Dockerfile may use the same optional JSON mount; when variables exist, the build runs without cache. At runtime the values are Docker environment variables and are visible to host root, Docker administrators, and container inspection.

Correct BuildKit usage does not automatically persist secrets in image layers, but build code is part of the trust boundary and can print secrets or embed them in files and client bundles. `NEXT_PUBLIC_*` and similar public variables are explicitly intended for visible client code and must not contain confidential values. Running applications can also read their variables and send them to logs or external systems.

Provide only necessary secrets, use separate credentials per project, rotate them regularly, and redact deployment logs before export.

### Backups

A complete backup of `.env`, `shelter-data`, `shelter-routing`, and `shelter-tunnel` contains the full control-plane state and keys, including OAuth client secret, possible proxy credentials, decryptable access/refresh/API tokens, connector token, source archives, project previews, and decryptable project variables. Screenshots may contain confidential content shown on an application's homepage. Backups must be:

- encrypted in storage and transit,
- protected with restrictive file permissions,
- subject to a defined retention and deletion policy,
- tested regularly through restore on an isolated system.

## Production hardening

- Use a dedicated Ubuntu 24.04 or 26.04 LTS VPS and Docker daemon for Shelter. Builder-cache cleanup is scoped to Shelter's dedicated Buildx builder, but the worker's Docker socket remains host-equivalent.
- Install host, kernel, Docker Engine, and Compose security updates promptly.
- Verify the Shelter revision before running the installer, run `./install.sh doctor` before and after an update, and retain the previous commit identifier until the new control plane is healthy.
- Do not use `--no-pull` for routine updates. It deliberately reuses local runtime and base images and can therefore miss upstream security fixes.
- Use SSH keys only and disable root login and password authentication where possible.
- Allow inbound SSH only. Shelter does not require public ports 80, 443, or 7080.
- Allow outbound TCP and UDP 7844 for `cloudflared`, plus required HTTPS, DNS, Git, registry, and package destinations.
- Restrict Docker access to the smallest possible operator group; membership in `docker` is root-equivalent.
- Prefer a private self-managed Cloudflare OAuth client with Account Read, Cloudflare Tunnel Write, Zone Read, and DNS Write. Restrict the API-token fallback to the same account and required zones.
- Register a stable HTTPS callback URL. Use an HTTP loopback callback only briefly through a controlled SSH forward, never over an exposed network, then update the Cloudflare client and `.env` together to the exact final HTTPS callback.
- Manually configure Cloudflare Access with a restrictive identity or device policy for the panel domain, verify the exact hostname in Cloudflare, and only then save Shelter's hostname-bound administrator confirmation. Do not treat that confirmation as automated policy verification.
- Deploy trusted sources only and review pull requests and dependency changes before building.
- Use minimal custom Dockerfiles for complex applications and remove unnecessary packages.
- Do not treat project containers as database or persistent file storage; Shelter mounts no persistent application volumes.
- Monitor disk usage, Docker images, deployment logs, and tunnel status.
- Automate and encrypt backups and test the restore procedure.

## Responding to a secret leak

If exposure is suspected:

1. Restrict panel access through Cloudflare Access or the firewall.
2. Revoke Shelter's Cloudflare OAuth authorization, rotate the OAuth client secret if it may be exposed, and reconnect with minimal scopes. Delete and recreate an affected API token.
3. Rotate tunnel or connector credentials if the connector token may be affected.
4. Rotate project credentials at their source systems.
5. Invalidate administrator sessions through controlled session cleanup or a dedicated maintenance change.
6. Inspect the host, Docker events, containers, DNS changes, and logs for persistence or abuse.
7. Treat possible Docker-socket or root access as a complete VPS compromise and rebuild from a clean image.

Do not change `APP_SECRET` impulsively. Plan a migration or controlled reconfiguration first, because changing it invalidates all data encrypted under that key.
