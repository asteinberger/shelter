import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";

const temporaryDirectories: string[] = [];

async function testApp(overrides: NodeJS.ProcessEnv = {}) {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-api-"));
  temporaryDirectories.push(dataDirectory);
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDirectory,
    WEB_DIST: path.join(dataDirectory, "missing-web"),
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "correct horse battery staple",
    APP_SECRET: "c".repeat(64),
    ...overrides
  });
  return createApp(config);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("authentication and project API", () => {
  it("requires a password only for the first user bootstrap", async () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-bootstrap-"));
    temporaryDirectories.push(dataDirectory);
    const commonEnvironment = {
      NODE_ENV: "production",
      DATA_DIR: dataDirectory,
      WEB_DIST: path.join(dataDirectory, "missing-web"),
      APP_SECRET: "b".repeat(64),
      LOG_LEVEL: "silent"
    } as const;

    const missingBootstrapPassword = loadConfig({
      ...commonEnvironment,
      ADMIN_EMAIL: "admin@example.com"
    });
    const emptyDatabase = new Database(missingBootstrapPassword);
    await expect(createApp(missingBootstrapPassword, emptyDatabase)).rejects.toThrow(/initial administrator bootstrap/);
    emptyDatabase.close();

    const firstStart = await createApp(loadConfig({
      ...commonEnvironment,
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: "correct horse battery staple"
    }));
    await firstStart.close();

    const restarted = await createApp(loadConfig({
      ...commonEnvironment,
      ADMIN_EMAIL: "changed@example.com"
    }));
    const originalLogin = await restarted.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });
    expect(originalLogin.statusCode).toBe(200);

    const changedEmailLogin = await restarted.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "changed@example.com", password: "correct horse battery staple" }
    });
    expect(changedEmailLogin.statusCode).toBe(401);
    await restarted.close();
  });

  it("logs in, keeps CSRF stable and creates a Git project with encrypted environment values", async () => {
    const app = await testApp();
    const anonymous = await app.inject({ method: "GET", url: "/api/auth/session" });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json().user).toBeNull();

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((entry) => entry.name === "shelter_session");
    expect(cookie?.httpOnly).toBe(true);
    const sessionOne = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: `portsmith_session=${cookie?.value ?? ""}` }
    });
    const sessionTwo = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: `portsmith_session=${cookie?.value ?? ""}` }
    });
    const csrfToken = sessionOne.json().csrfToken as string;
    expect(sessionTwo.json().csrfToken).toBe(csrfToken);

    const project = await app.inject({
      method: "POST",
      url: "/api/projects/git",
      headers: {
        cookie: `portsmith_session=${cookie?.value ?? ""}`,
        "x-csrf-token": csrfToken,
        origin: "http://localhost:7080",
        host: "localhost:7080"
      },
      payload: {
        name: "Example App",
        repositoryUrl: "https://github.com/example/example.git",
        branch: "main",
        rootDirectory: ".",
        buildType: "auto",
        dockerfilePath: "Dockerfile",
        port: 3000,
        healthcheckPath: "/",
        environment: [{ key: "NEXT_PUBLIC_API_ORIGIN", value: "https://api.example.com" }]
      }
    });
    expect(project.statusCode).toBe(201);
    expect(project.json().project.slug).toBe("example-app");
    expect(project.json().deployment.status).toBe("queued");
    expect(project.body).not.toContain("https://api.example.com");

    const detail = await app.inject({
      method: "GET",
      url: `/api/projects/${project.json().project.id as string}`,
      headers: { cookie: `portsmith_session=${cookie?.value ?? ""}` }
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().project.environmentKeys).toEqual(["NEXT_PUBLIC_API_ORIGIN"]);

    const reserved = await app.inject({
      method: "POST",
      url: "/api/projects/git",
      headers: {
        cookie: `portsmith_session=${cookie?.value ?? ""}`,
        "x-csrf-token": csrfToken,
        origin: "http://localhost:7080",
        host: "localhost:7080"
      },
      payload: {
        name: "Reserved Environment",
        repositoryUrl: "https://github.com/example/example.git",
        environment: [{ key: "PORT", value: "9999" }]
      }
    });
    expect(reserved.statusCode).toBe(400);
    expect(reserved.json().code).toBe("RESERVED_ENV_KEY");
    await app.close();
  });

  it("rejects mutations without CSRF", async () => {
    const app = await testApp();
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });
    const cookie = login.cookies.find((entry) => entry.name === "shelter_session");
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/git",
      headers: { cookie: `portsmith_session=${cookie?.value ?? ""}` },
      payload: { name: "No CSRF", repositoryUrl: "https://github.com/example/example.git" }
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("updates every mutable Git project setting without exposing internal fields", async () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-update-"));
    temporaryDirectories.push(dataDirectory);
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: dataDirectory,
      WEB_DIST: path.join(dataDirectory, "missing-web"),
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: "correct horse battery staple",
      APP_SECRET: "c".repeat(64)
    });
    const database = new Database(config);
    const app = await createApp(config, database);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });
    const sessionCookie = login.cookies.find((entry) => entry.name === "shelter_session")?.value ?? "";
    const csrfToken = login.json().csrfToken as string;
    const mutationHeaders = {
      cookie: `portsmith_session=${sessionCookie}`,
      "x-csrf-token": csrfToken,
      origin: "http://localhost:7080",
      host: "localhost:7080"
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/git",
      headers: mutationHeaders,
      payload: {
        name: "Editable App",
        repositoryUrl: "https://github.com/example/old.git",
        branch: "main"
      }
    });
    const projectId = created.json().project.id as string;

    const blockedWhileQueued = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      headers: mutationHeaders,
      payload: { repositoryBranch: "must-not-race" }
    });
    expect(blockedWhileQueued.statusCode).toBe(409);
    expect(blockedWhileQueued.json().code).toBe("DEPLOYMENT_ACTIVE");
    database.sqlite.prepare("UPDATE deployments SET status = 'failed', finished_at = ? WHERE project_id = ?")
      .run(new Date().toISOString(), projectId);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      headers: mutationHeaders,
      payload: {
        name: "Edited App",
        repositoryUrl: "https://github.com/example/new.git",
        repositoryBranch: "production",
        rootDirectory: "apps/web",
        buildType: "node",
        dockerfilePath: "ops/Dockerfile",
        port: 8080,
        healthcheckPath: "/healthz",
        memoryLimit: "2g",
        cpuLimit: "1.5"
      }
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().project).toMatchObject({
      name: "Edited App",
      repositoryUrl: "https://github.com/example/new.git",
      repositoryBranch: "production",
      rootDirectory: "apps/web",
      buildType: "node",
      dockerfilePath: "ops/Dockerfile",
      port: 8080,
      healthcheckPath: "/healthz",
      memoryLimit: "2g",
      cpuLimit: "1.5"
    });

    const unsafeRepository = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      headers: mutationHeaders,
      payload: { repositoryUrl: "https://user:secret@github.com/example/private.git" }
    });
    expect(unsafeRepository.statusCode).toBe(400);
    expect(unsafeRepository.body).not.toContain("user:secret");
    await app.close();
  });

  it("changes the admin password and invalidates every other session", async () => {
    const app = await testApp();
    const firstLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });
    const secondLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });
    const firstCookie = firstLogin.cookies.find((entry) => entry.name === "shelter_session")?.value ?? "";
    const secondCookie = secondLogin.cookies.find((entry) => entry.name === "shelter_session")?.value ?? "";
    const csrfToken = firstLogin.json().csrfToken as string;

    const withoutCsrf = await app.inject({
      method: "PUT",
      url: "/api/auth/password",
      headers: { cookie: `portsmith_session=${firstCookie}` },
      payload: { currentPassword: "correct horse battery staple", newPassword: "a new secure password for testing" }
    });
    expect(withoutCsrf.statusCode).toBe(403);

    const tooShort = await app.inject({
      method: "PUT",
      url: "/api/auth/password",
      headers: { cookie: `portsmith_session=${firstCookie}`, "x-csrf-token": csrfToken },
      payload: { currentPassword: "correct horse battery staple", newPassword: "too short" }
    });
    expect(tooShort.statusCode).toBe(400);
    expect(tooShort.json().code).toBe("PASSWORD_TOO_SHORT");

    const wrongCurrentPassword = await app.inject({
      method: "PUT",
      url: "/api/auth/password",
      headers: { cookie: `portsmith_session=${firstCookie}`, "x-csrf-token": csrfToken },
      payload: { currentPassword: "this is not the current password", newPassword: "a new secure password for testing" }
    });
    expect(wrongCurrentPassword.statusCode).toBe(400);
    expect(wrongCurrentPassword.json().code).toBe("CURRENT_PASSWORD_INVALID");

    const changed = await app.inject({
      method: "PUT",
      url: "/api/auth/password",
      headers: {
        cookie: `portsmith_session=${firstCookie}`,
        "x-csrf-token": csrfToken,
        origin: "http://localhost:7080",
        host: "localhost:7080"
      },
      payload: { currentPassword: "correct horse battery staple", newPassword: "a new secure password for testing" }
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ ok: true, invalidatedSessions: 1, invalidatedApiTokens: 0 });

    const currentSession = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: `portsmith_session=${firstCookie}` }
    });
    expect(currentSession.json().user.email).toBe("admin@example.com");

    const otherSession = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: `portsmith_session=${secondCookie}` }
    });
    expect(otherSession.json().user).toBeNull();

    const oldPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });
    expect(oldPassword.statusCode).toBe(401);

    const newPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "a new secure password for testing" }
    });
    expect(newPassword.statusCode).toBe(200);
    await app.close();
  });
});

describe("Cloudflare OAuth", () => {
  const redirectUri = "https://panel.example.com/api/settings/cloudflare/oauth/callback";
  const oauthEnvironment = {
    CLOUDFLARE_OAUTH_CLIENT_ID: "cloudflare-client-id",
    CLOUDFLARE_OAUTH_CLIENT_SECRET: "cloudflare-client-secret",
    CLOUDFLARE_OAUTH_REDIRECT_URI: redirectUri,
    CLOUDFLARE_OAUTH_SCOPES: "account-settings.read argotunnel.write zone.read dns.write"
  };

  async function login(app: Awaited<ReturnType<typeof testApp>>) {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });
    return {
      sessionCookie: response.cookies.find((cookie) => cookie.name === "shelter_session")?.value ?? "",
      csrfToken: response.json().csrfToken as string
    };
  }

  it("allows insecure OAuth redirects only on loopback", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      CLOUDFLARE_OAUTH_REDIRECT_URI: "http://panel.example.com/api/settings/cloudflare/oauth/callback"
    })).toThrow(/https unless it targets loopback/);
    expect(loadConfig({
      NODE_ENV: "test",
      CLOUDFLARE_OAUTH_REDIRECT_URI: "http://127.0.0.1:7081/api/settings/cloudflare/oauth/callback"
    }).CLOUDFLARE_OAUTH_REDIRECT_URI).toBe(
      "http://127.0.0.1:7081/api/settings/cloudflare/oauth/callback"
    );
  });

  it("allows a redirect URI to be shown before OAuth client credentials are configured", async () => {
    const app = await testApp({
      CLOUDFLARE_OAUTH_REDIRECT_URI: redirectUri,
      CLOUDFLARE_OAUTH_CLIENT_ID: "",
      CLOUDFLARE_OAUTH_CLIENT_SECRET: ""
    });
    const auth = await login(app);
    const state = await app.inject({
      method: "GET",
      url: "/api/settings/cloudflare",
      headers: { cookie: `portsmith_session=${auth.sessionCookie}` }
    });
    expect(state.statusCode).toBe(200);
    expect(state.json().cloudflare).toMatchObject({
      oauthAvailable: false,
      oauthRedirectUri: redirectUri,
      oauthPending: false,
      connected: false,
      authorized: false,
      authMethod: null
    });

    const unavailable = await app.inject({
      method: "POST",
      url: "/api/settings/cloudflare/oauth/start",
      headers: {
        cookie: `portsmith_session=${auth.sessionCookie}`,
        "x-csrf-token": auth.csrfToken,
        origin: "http://localhost:7080",
        host: "localhost:7080"
      }
    });
    expect(unavailable.statusCode).toBe(400);
    expect(unavailable.json().code).toBe("CLOUDFLARE_OAUTH_UNAVAILABLE");
    await app.close();
  });

  it("uses PKCE, binds the callback to the original live session and stores only a pending connection", async () => {
    const accountId = "a".repeat(32);
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://dash.cloudflare.com/oauth2/token") {
        expect(init?.redirect).toBe("error");
        expect(init?.headers).toMatchObject({
          authorization: `Basic ${Buffer.from("cloudflare-client-id:cloudflare-client-secret").toString("base64")}`
        });
        const body = init?.body as URLSearchParams;
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("provider-code");
        expect(body.get("redirect_uri")).toBe(redirectUri);
        expect(body.get("code_verifier")?.length).toBeGreaterThanOrEqual(43);
        return Response.json({
          access_token: "provider-access-token",
          refresh_token: "provider-refresh-token",
          token_type: "bearer",
          expires_in: 3600,
          scope: oauthEnvironment.CLOUDFLARE_OAUTH_SCOPES
        });
      }
      if (url === "https://api.cloudflare.com/client/v4/accounts?per_page=50&page=1") {
        expect(init?.headers).toMatchObject({ authorization: "Bearer provider-access-token" });
        return Response.json({ success: true, result: [{ id: accountId, name: "Example Account" }] });
      }
      if (url === `https://api.cloudflare.com/client/v4/accounts/${accountId}`) {
        return Response.json({ success: true, result: { id: accountId, name: "Example Account" } });
      }
      if (url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel?`)) {
        return Response.json({ success: true, result: [] });
      }
      if (url === `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel` && init?.method === "POST") {
        return Response.json({ success: true, result: { id: "tunnel-id", name: "portsmith", status: "inactive" } });
      }
      if (url === `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/tunnel-id/configurations`) {
        return Response.json({ success: true, result: {} });
      }
      if (url === `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/tunnel-id/token`) {
        return Response.json({ success: true, result: "signed-tunnel-token" });
      }
      if (url.startsWith("https://api.cloudflare.com/client/v4/zones?")) {
        const query = new URL(url).searchParams;
        expect(query.get("account.id")).toBe(accountId);
        expect(query.get("name")).toBeNull();
        expect(query.get("per_page")).toBe("50");
        expect(query.get("page")).toBe("1");
        return Response.json({ success: true, result: [{ id: "zone-id", name: "example.com", status: "active" }] });
      }
      if (url.startsWith("https://api.cloudflare.com/client/v4/zones/zone-id/dns_records?")) {
        return Response.json({ success: true, result: [] });
      }
      if (url === "https://api.cloudflare.com/client/v4/zones/zone-id/dns_records" && init?.method === "POST") {
        return Response.json({
          success: true,
          result: {
            id: "record-id",
            name: "panel.example.com",
            type: "CNAME",
            content: "tunnel-id.cfargotunnel.com",
            proxied: true
          }
        });
      }
      if (url === "https://dash.cloudflare.com/oauth2/revoke") {
        const body = init?.body as URLSearchParams;
        expect([
          "provider-access-token",
          "provider-refresh-token"
        ]).toContain(body.get("token"));
        expect(["access_token", "refresh_token"]).toContain(body.get("token_type_hint"));
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", providerFetch);

    const app = await testApp(oauthEnvironment);
    const auth = await login(app);
    const started = await app.inject({
      method: "POST",
      url: "/api/settings/cloudflare/oauth/start",
      headers: {
        cookie: `portsmith_session=${auth.sessionCookie}`,
        "x-csrf-token": auth.csrfToken,
        origin: "http://localhost:7080",
        host: "localhost:7080"
      }
    });
    expect(started.statusCode).toBe(200);
    expect(started.headers["cache-control"]).toBe("no-store");
    const nonceCookie = started.cookies.find((cookie) => cookie.name === "shelter_cloudflare_oauth_nonce");
    expect(nonceCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax" });
    expect(nonceCookie?.path).toBe("/api/settings/cloudflare/oauth/callback");

    const authorizationUrl = new URL(started.json().authorizationUrl as string);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("code_challenge")?.length).toBeGreaterThan(20);
    expect(authorizationUrl.searchParams.get("scope")?.split(" ")).toContain("offline_access");
    expect(started.body).not.toContain("cloudflare-client-secret");

    const state = authorizationUrl.searchParams.get("state") ?? "";
    const callback = await app.inject({
      method: "GET",
      url: `/api/settings/cloudflare/oauth/callback?code=provider-code&state=${encodeURIComponent(state)}`,
      // Deliberately omit the Portsmith session cookie. The persisted flow remains
      // bound to that still-live session, while the callback only needs its nonce.
      headers: { cookie: `portsmith_cloudflare_oauth_nonce=${nonceCookie?.value ?? ""}` }
    });
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe("https://panel.example.com/settings?cloudflare=connected");
    expect(callback.headers["cache-control"]).toBe("no-store");
    expect(callback.headers["referrer-policy"]).toBe("no-referrer");
    expect(providerFetch).toHaveBeenCalledTimes(2);

    const pendingState = await app.inject({
      method: "GET",
      url: "/api/settings/cloudflare",
      headers: { cookie: `portsmith_session=${auth.sessionCookie}` }
    });
    expect(pendingState.body).not.toContain("provider-access-token");
    expect(pendingState.body).not.toContain("provider-refresh-token");
    expect(pendingState.json().cloudflare).toMatchObject({
      connected: false,
      authorized: true,
      authMethod: null,
      oauthPending: true,
      accounts: [{ id: accountId, name: "Example Account" }]
    });

    const replay = await app.inject({
      method: "GET",
      url: `/api/settings/cloudflare/oauth/callback?code=provider-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: `portsmith_cloudflare_oauth_nonce=${nonceCookie?.value ?? ""}` }
    });
    expect(replay.statusCode).toBe(303);
    expect(replay.headers.location).toBe("https://panel.example.com/settings?cloudflare=error");
    expect(providerFetch).toHaveBeenCalledTimes(2);

    const configured = await app.inject({
      method: "PUT",
      url: "/api/settings/cloudflare",
      headers: {
        cookie: `portsmith_session=${auth.sessionCookie}`,
        "x-csrf-token": auth.csrfToken,
        origin: "http://localhost:7080",
        host: "localhost:7080"
      },
      payload: { accountId, tunnelName: "portsmith", panelDomain: "panel.example.com" }
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.body).not.toContain("provider-access-token");
    expect(configured.json().cloudflare).toMatchObject({
      configured: true,
      connected: true,
      authorized: true,
      authMethod: "oauth",
      accountId,
      tunnelId: "tunnel-id",
      panelDomain: "panel.example.com",
      oauthPending: false,
      reconnectRequired: false
    });

    const disconnected = await app.inject({
      method: "DELETE",
      url: "/api/settings/cloudflare/connection",
      headers: {
        cookie: `portsmith_session=${auth.sessionCookie}`,
        "x-csrf-token": auth.csrfToken
      }
    });
    expect(disconnected.statusCode).toBe(200);
    expect(disconnected.json().cloudflare).toMatchObject({
      configured: false,
      connected: false,
      authorized: false,
      authMethod: null,
      accountId,
      tunnelId: "tunnel-id",
      oauthPending: false
    });
    expect(providerFetch).toHaveBeenCalledWith(
      "https://dash.cloudflare.com/oauth2/revoke",
      expect.objectContaining({ method: "POST", redirect: "error" })
    );
    await app.close();
  });

  it("rejects duplicate callback parameters before contacting Cloudflare", async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const app = await testApp(oauthEnvironment);
    const auth = await login(app);
    const started = await app.inject({
      method: "POST",
      url: "/api/settings/cloudflare/oauth/start",
      headers: {
        cookie: `portsmith_session=${auth.sessionCookie}`,
        "x-csrf-token": auth.csrfToken
      }
    });
    const nonce = started.cookies.find((cookie) => cookie.name === "shelter_cloudflare_oauth_nonce")?.value ?? "";
    const authorizationUrl = new URL(started.json().authorizationUrl as string);
    const state = encodeURIComponent(authorizationUrl.searchParams.get("state") ?? "");
    const callback = await app.inject({
      method: "GET",
      url: `/api/settings/cloudflare/oauth/callback?state=${state}&state=${state}&code=one`,
      headers: { cookie: `portsmith_cloudflare_oauth_nonce=${nonce}` }
    });
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe("https://panel.example.com/settings?cloudflare=error");
    expect(providerFetch).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects the callback when the originating Portsmith session no longer exists", async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const app = await testApp(oauthEnvironment);
    const auth = await login(app);
    const started = await app.inject({
      method: "POST",
      url: "/api/settings/cloudflare/oauth/start",
      headers: {
        cookie: `portsmith_session=${auth.sessionCookie}`,
        "x-csrf-token": auth.csrfToken
      }
    });
    const nonce = started.cookies.find((cookie) => cookie.name === "shelter_cloudflare_oauth_nonce")?.value ?? "";
    const authorizationUrl = new URL(started.json().authorizationUrl as string);
    const state = authorizationUrl.searchParams.get("state") ?? "";

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        cookie: `portsmith_session=${auth.sessionCookie}`,
        "x-csrf-token": auth.csrfToken
      }
    });
    expect(logout.statusCode).toBe(200);

    const callback = await app.inject({
      method: "GET",
      url: `/api/settings/cloudflare/oauth/callback?state=${encodeURIComponent(state)}&code=provider-code`,
      headers: { cookie: `portsmith_cloudflare_oauth_nonce=${nonce}` }
    });
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe("https://panel.example.com/settings?cloudflare=error");
    expect(providerFetch).not.toHaveBeenCalled();
    await app.close();
  });
});
