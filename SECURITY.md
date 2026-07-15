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

The API and worker are separate processes and containers. They share `shelter-data`, including the SQLite database, and `shelter-routing`. The API additionally mounts `shelter-tunnel`; the worker cannot access it. Traefik reads only the routing volume and `cloudflared` reads only the tunnel volume. Only the worker has the Docker socket. The control network connects API, worker, Traefik, and `cloudflared`; the runtime network connects worker, Traefik, and applications. Project containers are not connected to the API network, but they still share one runtime network in the MVP. There is no per-project network isolation.

After a successful deployment, the worker briefly opens the internal homepage in headless Chromium to capture a project preview. That browser is inside the same trust boundary as the worker and deployed code.

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
- lateral network attacks by a compromised project container on the shared runtime network,
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

Cloudflare Access is not configured automatically. It is a recommended additional layer and does not replace Shelter authentication or strong administrator credentials.

### Sources and deployments

- Manual Git accepts HTTPS URLs without embedded credentials only. Interactive prompts and the local Git protocol are disabled.
- Manual Git URLs may not contain a query, fragment, or custom port. Linked GitHub sources are reconstructed server-side exclusively from the repository ID and validated full name supplied by GitHub.
- Private GitHub clones use short-lived installation tokens restricted to one repository and `contents:read`. They are supplied to Git through a temporary `GIT_ASKPASS` process, never stored, and never included in URLs, arguments, or logs.
- Project-root and Dockerfile paths must remain relative and may not escape the project workspace.
- ZIP archives are inspected before extraction for traversal, absolute paths, links and device files, entry count, expanded size, and extreme compression ratios.
- Host-side Git and Docker operations are spawned without a shell and with separate arguments.
- Git clones and Docker builds have configurable time limits; a timeout terminates the related process group.
- Project variables are passed to automatic builds as a short-lived BuildKit secret instead of Docker `ARG` or persistent `ENV` values.
- Automatic presets also use a non-secret per-deployment cache key so the secret-dependent build step cannot be incorrectly reused from an older cache. Custom Dockerfiles with project variables build without cache because their secret dependencies are unknown.
- A candidate container must pass an HTTP health check before activation.
- Runtime containers receive memory, CPU, and PID limits, `no-new-privileges`, no Linux capabilities, and bounded local Docker logs.
- Website previews are captured only by the worker through the internal runtime network. The API returns a preview only to an authenticated administrator and accepts no caller-controlled capture target.

These controls reduce accidental damage. They do not make build or runtime safe for untrusted tenants. Build resources are not covered by runtime limits. A correctly used BuildKit secret mount does not automatically persist in an image layer, but a build script or custom Dockerfile can still print, copy, or embed its value.

### GitHub App and webhooks

Manifest registration begins only from an authenticated administrator session. Shelter binds the cryptographic manifest `state` to the user, session, and a short-lived `SameSite=Lax` browser cookie; that callback value is consumed once. A separately hashed setup `state` remains valid for later installations of the same private app and is checked with the App ID. Public callback and webhook origins are set server-side. The private key and webhook secret are purpose-encrypted with AES-256-GCM under `APP_SECRET`.

Webhook signatures are verified against the unmodified request body with HMAC-SHA-256 and constant-time comparison. Valid push events are persisted and resolved by the worker; the HTTP response does not depend on subsequent GitHub API calls or builds. Repository, installation, and branch IDs must match the saved project connection. Multiple pushes coalesce to the latest branch HEAD, older builds are cancelled before activation, and commit-status updates use a persistent retry queue.

This does not prevent deployment of deliberately malicious repository code. Anyone who can write to the selected branch of a linked repository can build and run code on the VPS. Keep write access, branch protection, and GitHub App installation scope as narrow as possible. Disconnecting or suspending an installation pauses new automatic deployments without forgetting the selected auto-deploy preference.

After each processed deployment, the worker limits builder cache with `docker builder prune --max-used-space` and removes unused Shelter-labelled images. Builder-cache cleanup applies to the entire Docker daemon and cannot be isolated by Shelter labels. Sharing the Docker daemon with unrelated build systems is therefore outside the intended operating model.

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

The installer creates `.env` with mode `0600`. During first boot it briefly contains the bootstrap administrator password as a Base64 transport value (`ADMIN_PASSWORD_B64`, explicitly not encryption). After creating the user, the installer removes the value atomically and recreates the API without it. `APP_SECRET` remains. OAuth setups also keep client ID, client secret, redirect URI, scopes, and possibly a proxy URL with credentials; fallback setups may include the Cloudflare API token. Only the API loads the OAuth client secret and optional proxy configuration. The worker does not inherit `.env` and receives neither through its explicit allowlist. GitHub App credentials are encrypted in SQLite instead of `.env`.

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

- Use a dedicated Ubuntu 24.04 or 26.04 LTS VPS and Docker daemon for Shelter. Builder-cache cleanup is daemon-wide.
- Install host, kernel, Docker Engine, and Compose security updates promptly.
- Use SSH keys only and disable root login and password authentication where possible.
- Allow inbound SSH only. Shelter does not require public ports 80, 443, or 7080.
- Allow outbound TCP and UDP 7844 for `cloudflared`, plus required HTTPS, DNS, Git, registry, and package destinations.
- Restrict Docker access to the smallest possible operator group; membership in `docker` is root-equivalent.
- Prefer a private self-managed Cloudflare OAuth client with Account Read, Cloudflare Tunnel Write, Zone Read, and DNS Write. Restrict the API-token fallback to the same account and required zones.
- Register a stable HTTPS callback URL. Use a loopback URL only briefly for bootstrap over a controlled SSH tunnel, then update the client and `.env` together.
- Manually configure Cloudflare Access with a restrictive identity or device policy for the panel domain.
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
