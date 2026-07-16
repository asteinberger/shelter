import { createHmac, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { HttpError } from "../src/lib/errors.js";
import { decryptString, hashToken } from "../src/lib/security.js";
import { GitHubService } from "../src/services/github.js";
import type { DeploymentRow, ProjectRow } from "../src/types/models.js";

const directories: string[] = [];
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem"
}).toString();
const webhookSecret = "github-webhook-secret-for-tests";

function context(fetcher: typeof fetch): { config: AppConfig; database: Database; github: GitHubService } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-github-"));
  directories.push(directory);
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: directory,
    APP_SECRET: "g".repeat(64)
  });
  const database = new Database(config);
  database.setSetting("cloudflare.panel_domain", "hosting.example.com");
  const now = new Date();
  database.createUser({
    id: "usr_admin",
    email: "admin@example.com",
    password_hash: "test-only",
    created_at: now.toISOString()
  });
  database.createSession({
    token_hash: hashToken("session-token"),
    user_id: "usr_admin",
    csrf_hash: hashToken("csrf-token"),
    csrf_token: "csrf-token",
    expires_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
    created_at: now.toISOString()
  });
  return { config, database, github: new GitHubService(config, database, fetcher) };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function conversion() {
  return {
    id: 42,
    name: "Portsmith Test",
    slug: "portsmith-test",
    html_url: "https://github.com/apps/portsmith-test",
    pem: privateKey,
    webhook_secret: webhookSecret,
    client_id: "Iv1.public-value",
    client_secret: "must-never-be-stored"
  };
}

function upgradeConversion() {
  return {
    id: 84,
    name: "Shelter Upgrade",
    slug: "shelter-upgrade",
    html_url: "https://github.com/apps/shelter-upgrade",
    pem: privateKey,
    webhook_secret: "github-upgrade-webhook-secret-for-tests"
  };
}

function appJwtIssuer(init?: RequestInit): string | null {
  const authorization = new Headers(init?.headers).get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  return String(JSON.parse(Buffer.from(parts[1]!, "base64url").toString()).iss);
}

function repository(id = 99) {
  return {
    id,
    name: "private",
    full_name: "example/private",
    private: true,
    default_branch: "main",
    html_url: "https://github.com/example/private",
    clone_url: "https://github.com/example/private.git",
    owner: { login: "example" }
  };
}

function pullRequestPayload(
  action: "opened" | "reopened" | "synchronize" | "closed",
  installationId: number,
  number = 7,
  updatedAt = "2026-07-16T10:00:00.000Z"
) {
  return {
    action,
    installation: { id: installationId },
    repository: { id: 99, full_name: "example/private" },
    sender: { login: "ada" },
    pull_request: {
      number,
      title: `PR ${number}`,
      html_url: `https://github.com/example/private/pull/${number}`,
      updated_at: updatedAt,
      head: {
        sha: "a".repeat(40),
        ref: `feature-${number}`,
        repo: { id: 99, full_name: "example/private" }
      },
      base: { ref: "main", repo: { id: 99, full_name: "example/private" } }
    }
  };
}

async function connect(github: GitHubService): Promise<string> {
  const started = github.startManifest("usr_admin", hashToken("session-token"));
  const state = new URL(started.registrationUrl).searchParams.get("state")!;
  const setupState = new URL(started.manifest.setup_url).searchParams.get("state")!;
  await github.completeManifest(state, started.browserNonce, "manifest-code");
  return setupState;
}

function project(overrides: Partial<ProjectRow> = {}): ProjectRow {
  const now = new Date().toISOString();
  return {
    id: "prj_github",
    name: "GitHub App",
    slug: "github-app",
    source_type: "git",
    repository_url: "https://github.com/example/private.git",
    repository_branch: "main",
    source_archive: null,
    static_base_path: null,
    root_directory: ".",
    build_type: "auto",
    dockerfile_path: "Dockerfile",
    port: 3000,
    healthcheck_path: "/",
    memory_limit: "1g",
    cpu_limit: "1.0",
    github_repository_id: "99",
    github_repository_full_name: "example/private",
    github_installation_id: "123",
    github_connection_error: null,
    auto_deploy: 1,
    active_deployment_id: null,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

function deployment(overrides: Partial<DeploymentRow> = {}): DeploymentRow {
  return {
    id: "dep_active",
    project_id: "prj_github",
    status: "building",
    source_ref: "main",
    image_tag: null,
    previous_image_tag: null,
    internal_port: null,
    static_base_path: null,
    runtime_kind: null,
    runtime_description: null,
    commit_sha: "a".repeat(40),
    error: null,
    started_at: new Date().toISOString(),
    finished_at: null,
    created_at: new Date().toISOString(),
    ...overrides
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("GitHub App manifest and API authentication", () => {
  it("starts the manifest flow only from the configured panel origin and sets a Lax nonce cookie", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-github-route-"));
    directories.push(directory);
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: directory,
      APP_SECRET: "r".repeat(64)
    });
    const database = new Database(config);
    database.setSetting("cloudflare.panel_domain", "hosting.example.com");
    const app = await createApp(config, database);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@localhost", password: "local-development-only" }
    });
    const loginCookieHeader = login.headers["set-cookie"]!;
    const sessionCookie = (Array.isArray(loginCookieHeader) ? loginCookieHeader[0]! : loginCookieHeader).split(";")[0]!;
    const csrf = login.json().csrfToken as string;
    const response = await app.inject({
      method: "POST",
      url: "/api/settings/github/manifest/start",
      headers: {
        cookie: sessionCookie,
        "x-csrf-token": csrf,
        host: "attacker.invalid"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().manifest.redirect_url).toBe(
      "https://hosting.example.com/api/settings/github/manifest/callback"
    );
    const responseCookies = Array.isArray(response.headers["set-cookie"])
      ? response.headers["set-cookie"].join("\n")
      : response.headers["set-cookie"] ?? "";
    expect(responseCookies).toContain("shelter_github_manifest=");
    expect(responseCookies).toContain("Path=/api/settings/github/manifest/callback");
    expect(responseCookies).toContain("SameSite=Lax");
    expect(responseCookies).toContain("Secure");
    expect(response.headers["content-security-policy"]).toContain("form-action 'self' https://github.com");
    await app.close();
  });

  it("exposes the replacement manifest contract and returns the upgraded callback result", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-github-upgrade-route-"));
    directories.push(directory);
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: directory,
      APP_SECRET: "u".repeat(64)
    });
    const database = new Database(config);
    database.setSetting("cloudflare.panel_domain", "hosting.example.com");
    const manifest: ReturnType<GitHubService["startManifest"]>["manifest"] = {
      name: "Shelter upgrade-test",
      url: "https://hosting.example.com",
      hook_attributes: { url: "https://hosting.example.com/api/webhooks/github", active: true },
      redirect_url: "https://hosting.example.com/api/settings/github/manifest/callback",
      setup_url: "https://hosting.example.com/api/settings/github/setup/callback?state=setup-state",
      public: false,
      request_oauth_on_install: false,
      setup_on_update: true,
      default_permissions: { contents: "read", statuses: "write", metadata: "read", pull_requests: "read" },
      default_events: ["push", "pull_request"]
    };
    vi.spyOn(GitHubService.prototype, "startUpgradeManifest").mockResolvedValue({
      registrationUrl: `https://github.com/settings/apps/new?state=${"s".repeat(32)}`,
      manifest,
      browserNonce: "upgrade-browser-nonce",
      secureCookie: true
    });
    vi.spyOn(GitHubService.prototype, "completeManifest").mockResolvedValue({
      installUrl: "https://github.com/apps/shelter-upgrade/installations/new",
      setupBrowserNonce: "setup-browser-nonce"
    });
    const completeSetup = vi.spyOn(GitHubService.prototype, "completeSetup")
      .mockRejectedValueOnce(new HttpError(
        409,
        "GITHUB_UPGRADE_REPOSITORIES_MISSING",
        "repository selection incomplete"
      ))
      .mockResolvedValue("upgraded");
    const app = await createApp(config, database);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@localhost", password: "local-development-only" }
    });
    const loginCookieHeader = login.headers["set-cookie"]!;
    const sessionCookie = (Array.isArray(loginCookieHeader) ? loginCookieHeader[0]! : loginCookieHeader).split(";")[0]!;
    const csrf = login.json().csrfToken as string;

    const start = await app.inject({
      method: "POST",
      url: "/api/settings/github/manifest/upgrade/start",
      headers: { cookie: sessionCookie, "x-csrf-token": csrf }
    });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toEqual({ registrationUrl: expect.any(String), manifest });
    const startCookies = Array.isArray(start.headers["set-cookie"])
      ? start.headers["set-cookie"].join("\n")
      : start.headers["set-cookie"] ?? "";
    expect(startCookies).toContain("shelter_github_manifest=upgrade-browser-nonce");
    expect(startCookies).toContain("Path=/api/settings/github/manifest/callback");

    const manifestCallback = await app.inject({
      method: "GET",
      url: `/api/settings/github/manifest/callback?state=${"s".repeat(32)}&code=upgrade-code`,
      headers: { cookie: "shelter_github_manifest=upgrade-browser-nonce" }
    });
    expect(manifestCallback.statusCode).toBe(303);
    expect(manifestCallback.headers.location)
      .toBe("https://github.com/apps/shelter-upgrade/installations/new");
    const manifestCallbackCookies = Array.isArray(manifestCallback.headers["set-cookie"])
      ? manifestCallback.headers["set-cookie"].join("\n")
      : manifestCallback.headers["set-cookie"] ?? "";
    expect(manifestCallbackCookies).toContain("shelter_github_upgrade_setup=setup-browser-nonce");
    expect(manifestCallbackCookies).toContain("Path=/api/settings/github/setup/callback");
    expect(manifestCallbackCookies).toContain("SameSite=Lax");

    const incompleteCallback = await app.inject({
      method: "GET",
      url: `/api/settings/github/setup/callback?state=${"r".repeat(32)}&installation_id=456&setup_action=install`,
      headers: { cookie: "shelter_github_upgrade_setup=setup-browser-nonce" }
    });
    expect(incompleteCallback.statusCode).toBe(303);
    expect(incompleteCallback.headers.location).toBe(
      "https://hosting.example.com/settings/github?github=upgrade_incomplete"
    );
    const incompleteCookies = Array.isArray(incompleteCallback.headers["set-cookie"])
      ? incompleteCallback.headers["set-cookie"].join("\n")
      : incompleteCallback.headers["set-cookie"] ?? "";
    expect(incompleteCookies).not.toContain("shelter_github_upgrade_setup=;");

    const callback = await app.inject({
      method: "GET",
      url: `/api/settings/github/setup/callback?state=${"q".repeat(32)}&installation_id=456&setup_action=install`,
      headers: { cookie: "shelter_github_upgrade_setup=setup-browser-nonce" }
    });
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe("https://hosting.example.com/settings/github?github=upgraded");
    expect(completeSetup).toHaveBeenLastCalledWith("q".repeat(32), "456", "setup-browser-nonce");
    const callbackCookies = Array.isArray(callback.headers["set-cookie"])
      ? callback.headers["set-cookie"].join("\n")
      : callback.headers["set-cookie"] ?? "";
    expect(callbackCookies).toContain("shelter_github_upgrade_setup=;");
    await app.close();
  });

  it("creates a least-privilege manifest and stores only purpose-bound encrypted secrets", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://api.github.com/app-manifests/manifest-code/conversions");
      return json(conversion(), 201);
    }) as unknown as typeof fetch;
    const { config, database, github } = context(fetcher);

    const started = github.startManifest("usr_admin", hashToken("session-token"));
    expect(started.registrationUrl).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?state=/);
    expect(started.manifest).toMatchObject({
      url: "https://hosting.example.com",
      hook_attributes: { url: "https://hosting.example.com/api/webhooks/github", active: true },
      redirect_url: "https://hosting.example.com/api/settings/github/manifest/callback",
      public: false,
      request_oauth_on_install: false,
      setup_on_update: true,
      default_permissions: { contents: "read", statuses: "write", metadata: "read", pull_requests: "read" },
      default_events: ["push", "pull_request"]
    });
    const state = new URL(started.registrationUrl).searchParams.get("state")!;
    await github.completeManifest(state, started.browserNonce, "manifest-code");

    const encryptedPrivateKey = database.getSetting("github.private_key")!;
    const encryptedWebhookSecret = database.getSetting("github.webhook_secret")!;
    expect(encryptedPrivateKey).not.toContain("PRIVATE KEY");
    expect(encryptedWebhookSecret).not.toContain(webhookSecret);
    expect(decryptString(encryptedPrivateKey, config.APP_SECRET)).toBe(`github.private_key:v1\0${privateKey}`);
    expect(decryptString(encryptedWebhookSecret, config.APP_SECRET)).toBe(`github.webhook_secret:v1\0${webhookSecret}`);
    expect(JSON.stringify(database.sqlite.prepare("SELECT * FROM settings").all())).not.toContain("must-never-be-stored");
    expect(github.state()).toMatchObject({
      configured: true,
      appId: "42",
      appSlug: "portsmith-test",
      installUrl: "https://github.com/apps/portsmith-test/installations/new"
    });
    database.close();
  });

  it("starts owner-specific replacement manifests without allowing the normal flow to replace an active app", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
      if (url.endsWith("/app") && appJwtIssuer(init) === "42") {
        return json({
          slug: "portsmith-test",
          owner: { login: "example", type: "Organization" },
          permissions: { contents: "read", statuses: "write", metadata: "read" },
          events: ["push"]
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);

    expect(() => github.startManifest("usr_admin", hashToken("session-token")))
      .toThrowError(expect.objectContaining({ code: "GITHUB_ALREADY_CONFIGURED" }));
    const started = await github.startUpgradeManifest("usr_admin", hashToken("session-token"));
    expect(started.registrationUrl).toMatch(
      /^https:\/\/github\.com\/organizations\/example\/settings\/apps\/new\?state=/
    );
    expect(started.manifest.name).toMatch(/^Shelter hosting-[a-z-]+ upgrade-[a-f0-9]{6}$/);
    expect(started.manifest).toMatchObject({
      default_permissions: {
        contents: "read",
        statuses: "write",
        metadata: "read",
        pull_requests: "read"
      },
      default_events: ["push", "pull_request"],
      setup_on_update: true
    });
    database.close();
  });

  it("uses the personal registration endpoint and rejects enterprise-owned app upgrades", async () => {
    let ownerType: "User" | "Enterprise" = "User";
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
      if (url.endsWith("/app") && appJwtIssuer(init) === "42") {
        return json({
          slug: "portsmith-test",
          owner: { login: "andy", type: ownerType },
          permissions: { contents: "read" },
          events: ["push"]
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);

    const personal = await github.startUpgradeManifest("usr_admin", hashToken("session-token"));
    expect(personal.registrationUrl).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?state=/);
    database.deleteGithubAppUpgradeFlows();

    ownerType = "Enterprise";
    await expect(github.startUpgradeManifest("usr_admin", hashToken("session-token")))
      .rejects.toMatchObject({ code: "GITHUB_UPGRADE_ENTERPRISE_UNSUPPORTED" });
    database.close();
  });

  it("persists one-time conversion credentials before rejecting missing candidate capabilities at setup", async () => {
    let candidateAppChecks = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const issuer = appJwtIssuer(init);
      if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
      if (url.endsWith("/app-manifests/upgrade-code/conversions")) return json(upgradeConversion(), 201);
      if (url.endsWith("/app")) {
        if (issuer === "84") {
          candidateAppChecks += 1;
          return json({
              slug: "shelter-upgrade",
              owner: { login: "example", type: "Organization" },
              permissions: { contents: "read", metadata: "read", pull_requests: "read" },
              events: ["pull_request"]
            });
        }
        return json({
          slug: "portsmith-test",
          owner: { login: "example", type: "Organization" },
          permissions: { contents: "read", statuses: "write", metadata: "read" },
          events: ["push"]
        });
      }
      throw new Error(`Unexpected request: ${url} issuer=${issuer}`);
    }) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);
    database.createProject(project());
    const started = await github.startUpgradeManifest("usr_admin", hashToken("session-token"));
    const state = new URL(started.registrationUrl).searchParams.get("state")!;
    const setupState = new URL(started.manifest.setup_url).searchParams.get("state")!;
    const completed = await github.completeManifest(state, started.browserNonce, "upgrade-code");

    expect(candidateAppChecks).toBe(0);
    expect(database.getPendingGithubAppUpgradeFlow()?.encrypted_candidate).toBeTruthy();
    await expect(github.completeSetup(setupState, "456", completed.setupBrowserNonce))
      .rejects.toMatchObject({ code: "GITHUB_UPGRADE_APP_CAPABILITIES" });
    expect(candidateAppChecks).toBe(1);
    expect(github.state()).toMatchObject({ appId: "42", appSlug: "portsmith-test" });
    expect(database.getProject("prj_github")?.github_installation_id).toBe("123");
    expect(database.getPendingGithubAppUpgradeFlow()?.encrypted_candidate).toBeTruthy();
    database.close();
  });

  it("requires the replacement installation to approve every manifest permission and event", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const issuer = appJwtIssuer(init);
      if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
      if (url.endsWith("/app-manifests/upgrade-code/conversions")) return json(upgradeConversion(), 201);
      if (url.endsWith("/app")) {
        return issuer === "84"
          ? json({
              slug: "shelter-upgrade",
              owner: { login: "example", type: "Organization" },
              permissions: { contents: "read", statuses: "write", metadata: "read", pull_requests: "read" },
              events: ["push", "pull_request"]
            })
          : json({
              slug: "portsmith-test",
              owner: { login: "example", type: "Organization" },
              permissions: { contents: "read", statuses: "write", metadata: "read" },
              events: ["push"]
            });
      }
      if (url.endsWith("/app/installations/456") && issuer === "84") {
        return json({
          id: 456,
          app_id: 84,
          account: { login: "example", type: "Organization", avatar_url: null },
          repository_selection: "selected",
          suspended_at: null,
          permissions: { contents: "read", metadata: "read", pull_requests: "read" },
          events: ["pull_request"]
        });
      }
      throw new Error(`Unexpected request: ${url} issuer=${issuer}`);
    }) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);
    const started = await github.startUpgradeManifest("usr_admin", hashToken("session-token"));
    const state = new URL(started.registrationUrl).searchParams.get("state")!;
    const setupState = new URL(started.manifest.setup_url).searchParams.get("state")!;
    const completed = await github.completeManifest(state, started.browserNonce, "upgrade-code");

    await expect(github.completeSetup(setupState, "456", completed.setupBrowserNonce))
      .rejects.toMatchObject({ code: "GITHUB_UPGRADE_INSTALLATION_CAPABILITIES" });
    expect(github.state()).toMatchObject({ appId: "42" });
    expect(database.getPendingGithubAppUpgradeFlow()?.encrypted_candidate).toBeTruthy();
    database.close();
  });

  it("rejects broader candidate-app permissions and additional webhook events", async () => {
    const invalidCapabilities: Array<{
      label: string;
      permissions: Record<string, string>;
      events: string[];
    }> = [
      {
        label: "contents write",
        permissions: {
          contents: "write",
          statuses: "write",
          metadata: "read",
          pull_requests: "read"
        },
        events: ["push", "pull_request"]
      },
      {
        label: "administration write",
        permissions: {
          contents: "read",
          statuses: "write",
          metadata: "read",
          pull_requests: "read",
          administration: "write"
        },
        events: ["push", "pull_request"]
      },
      {
        label: "extra event",
        permissions: {
          contents: "read",
          statuses: "write",
          metadata: "read",
          pull_requests: "read"
        },
        events: ["push", "pull_request", "issues"]
      }
    ];

    for (const invalid of invalidCapabilities) {
      const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const issuer = appJwtIssuer(init);
        if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
        if (url.endsWith("/app-manifests/upgrade-code/conversions")) return json(upgradeConversion(), 201);
        if (url.endsWith("/app") && issuer === "84") {
          return json({
            slug: "shelter-upgrade",
            owner: { login: "example", type: "Organization" },
            permissions: invalid.permissions,
            events: invalid.events
          });
        }
        if (url.endsWith("/app")) {
          return json({
            slug: "portsmith-test",
            owner: { login: "example", type: "Organization" },
            permissions: { contents: "read" },
            events: ["push"]
          });
        }
        throw new Error(`Unexpected request for ${invalid.label}: ${url} issuer=${issuer}`);
      }) as unknown as typeof fetch;
      const { database, github } = context(fetcher);
      await connect(github);
      const started = await github.startUpgradeManifest("usr_admin", hashToken("session-token"));
      const state = new URL(started.registrationUrl).searchParams.get("state")!;
      const setupState = new URL(started.manifest.setup_url).searchParams.get("state")!;
      const completed = await github.completeManifest(state, started.browserNonce, "upgrade-code");

      await expect(github.completeSetup(setupState, "456", completed.setupBrowserNonce))
        .rejects.toMatchObject({ code: "GITHUB_UPGRADE_APP_CAPABILITIES" });
      expect(github.state()).toMatchObject({ appId: "42" });
      database.close();
    }
  });

  it("rejects broader installation permissions and additional webhook events", async () => {
    const invalidCapabilities: Array<{
      label: string;
      permissions: Record<string, string>;
      events: string[];
    }> = [
      {
        label: "contents write",
        permissions: {
          contents: "write",
          statuses: "write",
          metadata: "read",
          pull_requests: "read"
        },
        events: ["push", "pull_request"]
      },
      {
        label: "administration write",
        permissions: {
          contents: "read",
          statuses: "write",
          metadata: "read",
          pull_requests: "read",
          administration: "write"
        },
        events: ["push", "pull_request"]
      },
      {
        label: "extra event",
        permissions: {
          contents: "read",
          statuses: "write",
          metadata: "read",
          pull_requests: "read"
        },
        events: ["push", "pull_request", "issues"]
      }
    ];

    for (const invalid of invalidCapabilities) {
      const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const issuer = appJwtIssuer(init);
        if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
        if (url.endsWith("/app-manifests/upgrade-code/conversions")) return json(upgradeConversion(), 201);
        if (url.endsWith("/app") && issuer === "84") {
          return json({
            slug: "shelter-upgrade",
            owner: { login: "example", type: "Organization" },
            permissions: {
              contents: "read",
              statuses: "write",
              metadata: "read",
              pull_requests: "read"
            },
            events: ["push", "pull_request"]
          });
        }
        if (url.endsWith("/app")) {
          return json({
            slug: "portsmith-test",
            owner: { login: "example", type: "Organization" },
            permissions: { contents: "read" },
            events: ["push"]
          });
        }
        if (url.endsWith("/app/installations/456") && issuer === "84") {
          return json({
            id: 456,
            app_id: 84,
            account: { login: "example", type: "Organization", avatar_url: null },
            repository_selection: "selected",
            suspended_at: null,
            permissions: invalid.permissions,
            events: invalid.events
          });
        }
        throw new Error(`Unexpected request for ${invalid.label}: ${url} issuer=${issuer}`);
      }) as unknown as typeof fetch;
      const { database, github } = context(fetcher);
      await connect(github);
      const started = await github.startUpgradeManifest("usr_admin", hashToken("session-token"));
      const state = new URL(started.registrationUrl).searchParams.get("state")!;
      const setupState = new URL(started.manifest.setup_url).searchParams.get("state")!;
      const completed = await github.completeManifest(state, started.browserNonce, "upgrade-code");

      await expect(github.completeSetup(setupState, "456", completed.setupBrowserNonce))
        .rejects.toMatchObject({ code: "GITHUB_UPGRADE_INSTALLATION_CAPABILITIES" });
      expect(github.state()).toMatchObject({ appId: "42" });
      database.close();
    }
  });

  it("blocks a follow-up upgrade until the active app's buffered webhooks are drained", async () => {
    let appChecks = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
      if (url.endsWith("/app")) {
        appChecks += 1;
        return json({
          slug: "portsmith-test",
          owner: { login: "example", type: "Organization" },
          permissions: { contents: "read", statuses: "write", metadata: "read" },
          events: ["push"]
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);
    const raw = Buffer.from(JSON.stringify({
      ref: "refs/heads/main",
      deleted: false,
      installation: { id: 123 },
      repository: { id: 99, full_name: "example/private" }
    }));
    expect(database.bufferGithubWebhookDelivery(
      "42",
      "follow-up-buffer",
      "push",
      "a".repeat(64),
      raw,
      { maxCount: 100, maxBytes: 5 * 1024 * 1024 }
    )).toBe("buffered");

    await expect(github.startUpgradeManifest("usr_admin", hashToken("session-token")))
      .rejects.toMatchObject({ code: "GITHUB_UPGRADE_WEBHOOKS_PENDING" });
    expect(appChecks).toBe(0);
    database.deleteBufferedGithubWebhooks("42");
    await expect(github.startUpgradeManifest("usr_admin", hashToken("session-token")))
      .resolves.toMatchObject({ registrationUrl: expect.any(String) });
    expect(appChecks).toBe(1);
    database.close();
  });

  it("bounds candidate webhook buffers and cleans them when the pending flow expires", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
      if (url.endsWith("/app-manifests/upgrade-code/conversions")) return json(upgradeConversion(), 201);
      if (url.endsWith("/app") && appJwtIssuer(init) === "42") {
        return json({
          slug: "portsmith-test",
          owner: { login: "example", type: "Organization" },
          permissions: { contents: "read", statuses: "write", metadata: "read" },
          events: ["push"]
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);
    const started = await github.startUpgradeManifest("usr_admin", hashToken("session-token"));
    const state = new URL(started.registrationUrl).searchParams.get("state")!;
    await github.completeManifest(state, started.browserNonce, "upgrade-code");
    const pending = database.getPendingGithubAppUpgradeFlow()!;
    const raw = Buffer.from(JSON.stringify({
      ref: "refs/heads/main",
      deleted: false,
      installation: { id: 456 },
      repository: { id: 99, full_name: "example/private" }
    }));
    const source = {
      kind: "pending" as const,
      appId: "84"
    };
    for (let index = 0; index < 100; index += 1) {
      await expect(github.handleWebhook(
        "push",
        `bounded-${index}`,
        raw,
        source
      )).resolves.toMatchObject({ pending: 1 });
    }
    await expect(github.handleWebhook("push", "bounded-overflow", raw, source))
      .rejects.toMatchObject({ statusCode: 503, code: "GITHUB_WEBHOOK_BUFFER_FULL" });
    expect(database.githubBufferedWebhookUsage("84")).toEqual({
      count: 100,
      bytes: raw.byteLength * 100
    });
    database.sqlite.prepare(`
      UPDATE github_app_upgrade_flows SET expires_at = ? WHERE id = ?
    `).run(new Date(Date.now() - 1_000).toISOString(), pending.id);
    await expect(github.startUpgradeManifest("usr_admin", hashToken("session-token")))
      .resolves.toMatchObject({ registrationUrl: expect.any(String) });
    expect(database.githubBufferedWebhookUsage("84")).toEqual({ count: 0, bytes: 0 });
    database.close();
  });

  it.each(["logout", "password-change", "expired-session"] as const)(
    "deletes candidate webhook BLOBs when the upgrade session ends via %s",
    async (mode) => {
      const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
        if (url.endsWith("/app-manifests/upgrade-code/conversions")) return json(upgradeConversion(), 201);
        if (url.endsWith("/app") && appJwtIssuer(init) === "42") {
          return json({
            slug: "portsmith-test",
            owner: { login: "example", type: "Organization" },
            permissions: { contents: "read" },
            events: ["push"]
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }) as unknown as typeof fetch;
      const { database, github } = context(fetcher);
      await connect(github);
      const started = await github.startUpgradeManifest(
        "usr_admin",
        hashToken("session-token")
      );
      const state = new URL(started.registrationUrl).searchParams.get("state")!;
      await github.completeManifest(state, started.browserNonce, "upgrade-code");
      expect(database.getPendingGithubAppUpgradeFlow()).toMatchObject({
        candidate_app_id: "84"
      });
      const raw = Buffer.from(JSON.stringify({
        ref: "refs/heads/main",
        deleted: false,
        installation: { id: 456 },
        repository: { id: 99, full_name: "example/private" }
      }));
      await expect(github.handleWebhook(
        "push",
        `session-cleanup-${mode}`,
        raw,
        { kind: "pending", appId: "84" }
      )).resolves.toMatchObject({ pending: 1 });
      expect(database.githubBufferedWebhookUsage("84")).toEqual({
        count: 1,
        bytes: raw.byteLength
      });

      if (mode === "logout") {
        // Invalid active metadata must fail closed in the cleanup trigger, not
        // abort the session deletion and leave the candidate BLOB orphaned.
        database.setSetting("github.app_metadata", "{");
        database.deleteSession(hashToken("session-token"));
      } else if (mode === "password-change") {
        const now = new Date();
        database.createSession({
          token_hash: hashToken("current-session"),
          user_id: "usr_admin",
          csrf_hash: hashToken("current-csrf"),
          csrf_token: "current-csrf",
          expires_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
          created_at: now.toISOString()
        });
        database.updateUserPasswordAndInvalidateOtherSessions(
          "usr_admin",
          "changed-test-only",
          hashToken("current-session")
        );
      } else {
        database.sqlite.prepare(`
          UPDATE sessions SET expires_at = ? WHERE token_hash = ?
        `).run(
          new Date(Date.now() - 1_000).toISOString(),
          hashToken("session-token")
        );
        database.pruneExpiredSessions();
      }

      expect(database.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM github_app_upgrade_flows
      `).get()).toEqual({ count: 0 });
      expect(database.githubBufferedWebhookUsage("84")).toEqual({ count: 0, bytes: 0 });
      database.close();
    }
  );

  it("quarantines a deterministic buffered-webhook failure without stopping the worker loop", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/app-manifests/manifest-code/conversions")) {
        return json(conversion(), 201);
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as unknown as typeof fetch;
    const { config, database, github } = context(fetcher);
    await connect(github);
    const raw = Buffer.from(JSON.stringify({
      ref: "refs/heads/main",
      deleted: false,
      installation: { id: 123 },
      repository: { id: 99, full_name: "example/private" }
    }));
    expect(database.bufferGithubWebhookDelivery(
      "42",
      "deterministic-failure",
      "push",
      "b".repeat(64),
      raw,
      { maxCount: 100, maxBytes: 5 * 1024 * 1024 }
    )).toBe("buffered");
    database.sqlite.prepare(`
      UPDATE github_webhook_deliveries SET raw_body = ?, status = 'processing'
      WHERE source_app_id = ? AND delivery_id = ?
    `).run(Buffer.from("{"), "42", "deterministic-failure");

    database.close();
    const reopened = new Database(config);
    const restartedGithub = new GitHubService(config, reopened, fetcher);
    expect(reopened.sqlite.prepare(`
      SELECT status, attempts FROM github_webhook_deliveries
      WHERE source_app_id = ? AND delivery_id = ?
    `).get("42", "deterministic-failure")).toEqual({
      status: "buffered",
      attempts: 0
    });
    await expect(restartedGithub.startUpgradeManifest(
      "usr_admin",
      hashToken("session-token")
    )).rejects.toMatchObject({ code: "GITHUB_UPGRADE_WEBHOOKS_PENDING" });
    await expect(restartedGithub.processNextWebhookJob()).resolves.toBe(true);
    await expect(restartedGithub.processNextWebhookJob()).resolves.toBe(true);
    await expect(restartedGithub.processNextWebhookJob()).resolves.toBe(true);
    expect(reopened.sqlite.prepare(`
      SELECT status, raw_body, attempts, error FROM github_webhook_deliveries
      WHERE source_app_id = ? AND delivery_id = ?
    `).get("42", "deterministic-failure")).toEqual({
      status: "failed",
      raw_body: null,
      attempts: 3,
      error: "GITHUB_PAYLOAD_INVALID"
    });
    await expect(restartedGithub.processNextWebhookJob()).resolves.toBe(false);
    reopened.close();
  });

  it("uses GitHub PR timestamps with a fail-closed tie break", () => {
    const { database } = context(vi.fn() as unknown as typeof fetch);
    database.createProject(project());
    const event = {
      projectId: "prj_github",
      repositoryId: "99",
      pullRequestNumber: 7,
      githubUpdatedAt: "2026-07-16T10:00:00.000Z",
      deliveryId: "watermark-open"
    };
    expect(database.claimGithubPullRequestEventWatermark({
      ...event,
      action: "opened"
    })).toBe("accepted");
    expect(database.claimGithubPullRequestEventWatermark({
      ...event,
      action: "synchronize",
      deliveryId: "watermark-tied-sync"
    })).toBe("ignored");
    expect(database.claimGithubPullRequestEventWatermark({
      ...event,
      action: "closed",
      deliveryId: "watermark-tied-close"
    })).toBe("accepted");
    expect(database.claimGithubPullRequestEventWatermark({
      ...event,
      action: "reopened",
      deliveryId: "watermark-tied-reopen"
    })).toBe("ignored");
    database.close();
  });

  it("records close tombstones before checking preview eligibility", async () => {
    const { database, github } = context(vi.fn() as unknown as typeof fetch);
    database.createProject(project({
      repository_branch: "release",
      preview_deployments_enabled: 0,
      preview_domain_suffix: "preview.example.com",
      github_connection_error: "Installation paused"
    }));
    const newerClose = Buffer.from(JSON.stringify(
      pullRequestPayload(
        "closed",
        123,
        7,
        "2026-07-16T11:00:00.000Z"
      )
    ));
    await expect(github.handleWebhook(
      "pull_request",
      "watermark-ineligible-close",
      newerClose
    )).resolves.toMatchObject({ queued: 0, pending: 0, ignored: 1 });
    expect(database.sqlite.prepare(`
      SELECT github_updated_at, action
      FROM github_pull_request_event_watermarks
      WHERE project_id = ? AND repository_id = ? AND pull_request_number = ?
    `).get("prj_github", "99", 7)).toEqual({
      github_updated_at: "2026-07-16T11:00:00.000Z",
      action: "closed"
    });

    database.sqlite.prepare(`
      UPDATE projects
      SET repository_branch = 'main', preview_deployments_enabled = 1,
          github_connection_error = NULL
      WHERE id = ?
    `).run("prj_github");
    const olderOpen = Buffer.from(JSON.stringify(
      pullRequestPayload(
        "opened",
        123,
        7,
        "2026-07-16T10:00:00.000Z"
      )
    ));
    await expect(github.handleWebhook(
      "pull_request",
      "watermark-eligible-older-open",
      olderOpen
    )).resolves.toMatchObject({ queued: 0, pending: 0, ignored: 1 });
    expect(database.findPullRequestPreview("prj_github", 7)).toBeUndefined();
    database.close();
  });

  it("keeps the active app live until the candidate is verified, then atomically remaps all GitHub state", async () => {
    const candidateIssuers: string[] = [];
    const accessTokenUrls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const issuer = appJwtIssuer(init);
      if (issuer === "84") candidateIssuers.push(issuer);
      if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
      if (url.endsWith("/app-manifests/upgrade-code/conversions")) return json(upgradeConversion(), 201);
      if (url.endsWith("/app")) {
        if (issuer === "84") {
          return json({
            slug: "shelter-upgrade",
            owner: { login: "example", type: "Organization" },
            permissions: { contents: "read", statuses: "write", metadata: "read", pull_requests: "read" },
            events: ["push", "pull_request"]
          });
        }
        return json({
          slug: "portsmith-test",
          owner: { login: "example", type: "Organization" },
          permissions: { contents: "read", statuses: "write", metadata: "read" },
          events: ["push"]
        });
      }
      if (url.endsWith("/app/installations/456") && issuer === "84") {
        return json({
          id: 456,
          app_id: 84,
          account: { login: "example", type: "Organization", avatar_url: null },
          repository_selection: "selected",
          suspended_at: null,
          permissions: { contents: "read", statuses: "write", metadata: "read", pull_requests: "read" },
          events: ["push", "pull_request"]
        });
      }
      if (url.includes("/app/installations?") && issuer === "42") {
        return json([{
          id: 123,
          app_id: 42,
          account: { login: "example", type: "Organization", avatar_url: null },
          repository_selection: "selected",
          suspended_at: null
        }]);
      }
      if (url.endsWith("/app/installations/456/access_tokens") && issuer === "84") {
        accessTokenUrls.push(url);
        return json({
          token: "ghs_candidate_installation_token_1234567890",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString()
        }, 201);
      }
      if (url.includes("/installation/repositories?")) {
        expect(new Headers(init?.headers).get("authorization"))
          .toBe("Bearer ghs_candidate_installation_token_1234567890");
        return json({ repositories: [repository()] });
      }
      if (url.endsWith("/repositories/99")) return json(repository());
      if (url.endsWith("/repos/example/private/commits/main")) {
        return json({
          sha: "c".repeat(40),
          html_url: `https://github.com/example/private/commit/${"c".repeat(40)}`,
          commit: { message: "Buffered candidate push", author: { name: "Shelter" } }
        });
      }
      throw new Error(`Unexpected request: ${url} issuer=${issuer}`);
    }) as unknown as typeof fetch;
    const { config, database, github } = context(fetcher);
    await connect(github);
    database.createProject(project({
      preview_deployments_enabled: 1,
      preview_domain_id: "zone_1",
      preview_domain_suffix: "preview.example.com",
      preview_ttl_hours: 48
    }));
    database.createDeployment(deployment());
    database.sqlite.prepare(`
      INSERT INTO github_pending_pushes (
        project_id, delivery_id, installation_id, repository_id, repository_full_name,
        branch, commit_sha, commit_message, commit_author, commit_url, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "prj_github", "delivery-pending", "123", "99", "example/private", "main",
      "b".repeat(40), "Pending", "Shelter", "https://github.com/example/private/commit/test",
      new Date().toISOString()
    );
    database.enqueueGithubDirtyRef({
      installationId: "123",
      repositoryId: "99",
      repositoryFullName: "example/private",
      branch: "main",
      deliveryId: "delivery-dirty"
    });
    expect(database.queueGithubStatus("dep_active", "pending", "Build läuft")).toBe(true);

    const started = await github.startUpgradeManifest("usr_admin", hashToken("session-token"));
    const state = new URL(started.registrationUrl).searchParams.get("state")!;
    const setupState = new URL(started.manifest.setup_url).searchParams.get("state")!;
    const completed = await github.completeManifest(state, started.browserNonce, "upgrade-code");

    expect(completed).toMatchObject({
      installUrl: "https://github.com/apps/shelter-upgrade/installations/new"
    });
    expect(completed.setupBrowserNonce).toBeTruthy();
    expect(github.state()).toMatchObject({ appId: "42", appSlug: "portsmith-test" });
    expect(database.getProject("prj_github")).toMatchObject({
      github_installation_id: "123",
      auto_deploy: 1,
      preview_deployments_enabled: 1,
      preview_domain_id: "zone_1",
      preview_domain_suffix: "preview.example.com",
      preview_ttl_hours: 48
    });
    const pendingRow = database.getPendingGithubAppUpgradeFlow()!;
    expect(pendingRow.candidate_app_id).toBe("84");
    expect(pendingRow.encrypted_candidate).not.toContain("PRIVATE KEY");
    await expect(github.previewCapability()).resolves.toMatchObject({
      upgradePending: true,
      upgradeInstallUrl: "https://github.com/apps/shelter-upgrade/installations/new",
      upgradeExpiresAt: pendingRow.expires_at
    });

    const candidatePush = Buffer.from(JSON.stringify({
      ref: "refs/heads/main",
      after: "c".repeat(40),
      deleted: false,
      installation: { id: 456 },
      repository: { id: 99, full_name: "example/private" }
    }));
    const candidateSignature = `sha256=${createHmac(
      "sha256",
      "github-upgrade-webhook-secret-for-tests"
    ).update(candidatePush).digest("hex")}`;
    const pendingSource = github.verifyWebhook(candidatePush, candidateSignature);
    expect(pendingSource).toEqual({ kind: "pending", appId: "84" });
    await expect(github.handleWebhook(
      "push",
      "delivery-candidate-before-swap",
      candidatePush,
      pendingSource
    )).resolves.toMatchObject({ pending: 1, ignored: 0 });
    expect(database.sqlite.prepare(`
      SELECT source_app_id, status, raw_body IS NOT NULL AS has_body
      FROM github_webhook_deliveries
      WHERE source_app_id = ? AND delivery_id = ?
    `).get("84", "delivery-candidate-before-swap")).toEqual({
      source_app_id: "84",
      status: "buffered",
      has_body: 1
    });
    expect(database.sqlite.prepare(`
      SELECT latest_delivery_id FROM github_dirty_refs WHERE repository_id = ?
    `).get("99")).toEqual({ latest_delivery_id: "delivery-dirty" });

    const pendingLifecycle = Buffer.from(JSON.stringify({
      action: "suspend",
      installation: { id: 456 }
    }));
    await expect(github.handleWebhook(
      "installation",
      "delivery-candidate-lifecycle",
      pendingLifecycle,
      pendingSource
    )).resolves.toMatchObject({ ignored: 1 });
    expect(database.getProject("prj_github")?.github_connection_error).toBeNull();

    const oldPushBeforeSwap = Buffer.from(JSON.stringify({
      ref: "refs/heads/main",
      after: "f".repeat(40),
      deleted: false,
      installation: { id: 123 },
      repository: { id: 99, full_name: "example/private" }
    }));
    const oldPushBeforeSwapSignature = `sha256=${createHmac("sha256", webhookSecret)
      .update(oldPushBeforeSwap).digest("hex")}`;
    const activeSourceBeforeSwap = github.verifyWebhook(
      oldPushBeforeSwap,
      oldPushBeforeSwapSignature
    );
    await expect(github.handleWebhook(
      "push",
      "delivery-active-before-swap",
      oldPushBeforeSwap,
      activeSourceBeforeSwap
    )).resolves.toMatchObject({ pending: 1, ignored: 0 });
    const activePreviewOpen = Buffer.from(JSON.stringify(
      pullRequestPayload(
        "opened",
        123,
        8,
        "2026-07-16T09:00:00.000Z"
      )
    ));
    await expect(github.handleWebhook(
      "pull_request",
      "delivery-active-pr-open-before-swap",
      activePreviewOpen,
      activeSourceBeforeSwap
    )).resolves.toMatchObject({ queued: 1 });
    expect(database.findPullRequestPreview("prj_github", 8)?.status).toBe("queued");
    // GitHub created this old-app close before the candidate installation
    // completed, but its delivery is intentionally delayed until after swap.
    const delayedRetiredClose = Buffer.from(JSON.stringify(
      pullRequestPayload(
        "closed",
        123,
        8,
        "2026-07-16T10:00:00.000Z"
      )
    ));
    const delayedRetiredCloseSignature = `sha256=${createHmac("sha256", webhookSecret)
      .update(delayedRetiredClose).digest("hex")}`;
    const candidateOlderPullRequest = Buffer.from(JSON.stringify(
      pullRequestPayload(
        "opened",
        456,
        7,
        "2026-07-16T10:00:00.000Z"
      )
    ));
    await expect(github.handleWebhook(
      "pull_request",
      "delivery-candidate-pr-older",
      candidateOlderPullRequest,
      pendingSource
    )).resolves.toMatchObject({ pending: 1, ignored: 0 });
    const activeNewerClose = Buffer.from(JSON.stringify(
      pullRequestPayload(
        "closed",
        123,
        7,
        "2026-07-16T11:00:00.000Z"
      )
    ));
    await expect(github.handleWebhook(
      "pull_request",
      "delivery-active-pr-newer-close",
      activeNewerClose,
      activeSourceBeforeSwap
    )).resolves.toMatchObject({ pending: 0, ignored: 1 });
    expect(database.sqlite.prepare(`
      SELECT github_updated_at, action
      FROM github_pull_request_event_watermarks
      WHERE project_id = ? AND repository_id = ? AND pull_request_number = ?
    `).get("prj_github", "99", 7)).toEqual({
      github_updated_at: "2026-07-16T11:00:00.000Z",
      action: "closed"
    });

    const claimedDirtyRef = database.claimNextGithubDirtyRef();
    expect(claimedDirtyRef?.claim_token).toBeTruthy();
    const oldLifecycle = Buffer.from(JSON.stringify({
      action: "suspend",
      installation: { id: 123 }
    }));
    const oldLifecycleSignature = `sha256=${createHmac("sha256", webhookSecret)
      .update(oldLifecycle).digest("hex")}`;
    const oldSourceBeforeSwap = github.verifyWebhook(oldLifecycle, oldLifecycleSignature);
    expect(oldSourceBeforeSwap).toEqual({ kind: "active", appId: "42" });

    database.sqlite.prepare(`
      UPDATE projects SET github_connection_error = ? WHERE id = ?
    `).run("Die bisherige Installation war pausiert.", "prj_github");
    expect(database.getProject("prj_github")?.github_connection_error).toContain("pausiert");
    const originalRoutingPath = config.traefikConfigPath;
    const routingBlocker = path.join(path.dirname(originalRoutingPath), "not-a-directory");
    fs.writeFileSync(routingBlocker, "block post-commit routing writes");
    config.traefikConfigPath = path.join(routingBlocker, "dynamic.yml");
    await expect(github.completeSetup(setupState, "456", completed.setupBrowserNonce))
      .resolves.toBe("upgraded");
    config.traefikConfigPath = originalRoutingPath;
    fs.rmSync(routingBlocker, { force: true });

    expect(candidateIssuers.length).toBeGreaterThanOrEqual(3);
    expect(github.state()).toMatchObject({ appId: "84", appSlug: "shelter-upgrade" });
    expect(database.getProject("prj_github")).toMatchObject({
      github_installation_id: "456",
      github_repository_id: "99",
      auto_deploy: 1,
      preview_deployments_enabled: 1,
      preview_domain_id: "zone_1",
      preview_domain_suffix: "preview.example.com",
      preview_ttl_hours: 48,
      github_connection_error: null
    });
    expect(database.sqlite.prepare(
      "SELECT installation_id FROM github_pending_pushes WHERE project_id = ?"
    ).get("prj_github")).toEqual({ installation_id: "456" });
    const remappedDirtyRef = database.sqlite.prepare(`
      SELECT installation_id, claim_token, claimed_generation, claimed_at,
             attempts, next_attempt_at, last_error
      FROM github_dirty_refs WHERE repository_id = ?
    `).get("99") as {
      installation_id: string;
      claim_token: string | null;
      claimed_generation: number | null;
      claimed_at: string | null;
      attempts: number;
      next_attempt_at: string;
      last_error: string | null;
    };
    expect(remappedDirtyRef).toMatchObject({
      installation_id: "456",
      claim_token: null,
      claimed_generation: null,
      claimed_at: null,
      attempts: 0,
      last_error: null
    });
    expect(Date.parse(remappedDirtyRef.next_attempt_at)).toBeLessThanOrEqual(Date.now());
    expect(database.sqlite.prepare(
      "SELECT installation_id FROM github_status_outbox WHERE deployment_id = ?"
    ).get("dep_active")).toEqual({ installation_id: "456" });
    expect(database.getPendingGithubAppUpgradeFlow()).toBeUndefined();
    expect(decryptString(database.getSetting("github.webhook_secret")!, config.APP_SECRET))
      .toBe("github.webhook_secret:v1\0github-upgrade-webhook-secret-for-tests");
    expect(github.resultUrl("upgraded")).toBe("https://hosting.example.com/settings/github?github=upgraded");
    expect(github.resultUrl("upgrade_incomplete"))
      .toBe("https://hosting.example.com/settings/github?github=upgrade_incomplete");

    await expect(github.handleWebhook(
      "push",
      "delivery-active-before-swap",
      oldPushBeforeSwap,
      activeSourceBeforeSwap
    )).resolves.toMatchObject({ duplicate: true });
    expect(await github.processNextWebhookJob()).toBe(true);
    expect(database.sqlite.prepare(`
      SELECT installation_id, latest_delivery_id
      FROM github_dirty_refs WHERE repository_id = ?
    `).get("99")).toEqual({
      installation_id: "456",
      latest_delivery_id: "delivery-candidate-before-swap"
    });
    expect(database.sqlite.prepare(`
      SELECT status, raw_body FROM github_webhook_deliveries
      WHERE source_app_id = ? AND delivery_id = ?
    `).get("84", "delivery-candidate-before-swap")).toEqual({
      status: "processed",
      raw_body: null
    });
    expect(await github.processNextWebhookJob()).toBe(true);
    expect(database.sqlite.prepare(`
      SELECT status, raw_body FROM github_webhook_deliveries
      WHERE source_app_id = ? AND delivery_id = ?
    `).get("84", "delivery-candidate-pr-older")).toEqual({
      status: "ignored",
      raw_body: null
    });
    expect(database.findPullRequestPreview("prj_github", 7)).toBeUndefined();
    expect(database.sqlite.prepare(`
      SELECT github_updated_at, action
      FROM github_pull_request_event_watermarks
      WHERE project_id = ? AND repository_id = ? AND pull_request_number = ?
    `).get("prj_github", "99", 7)).toEqual({
      github_updated_at: "2026-07-16T11:00:00.000Z",
      action: "closed"
    });
    await expect(github.handleWebhook(
      "push",
      "delivery-candidate-before-swap",
      candidatePush,
      pendingSource
    )).resolves.toMatchObject({ duplicate: true });
    expect(await github.processNextWebhookJob()).toBe(true);
    expect(accessTokenUrls).toHaveLength(2);
    expect(accessTokenUrls.every((url) => url.endsWith("/app/installations/456/access_tokens")))
      .toBe(true);

    // The source was authenticated while app 42 was still active. After the
    // atomic swap it must be reclassified as retired, so lifecycle events
    // cannot disable the successor installation.
    await expect(github.handleWebhook(
      "installation",
      "delivery-old-lifecycle-after-swap",
      oldLifecycle,
      oldSourceBeforeSwap
    )).resolves.toMatchObject({ ignored: 1 });
    expect(database.getProject("prj_github")?.github_connection_error).toBeNull();

    const retiredPush = Buffer.from(JSON.stringify({
      ref: "refs/heads/main",
      after: "d".repeat(40),
      deleted: false,
      installation: { id: 123 },
      repository: { id: 99, full_name: "example/private" }
    }));
    const retiredSignature = `sha256=${createHmac("sha256", webhookSecret)
      .update(retiredPush).digest("hex")}`;
    const retiredSource = github.verifyWebhook(retiredPush, retiredSignature);
    expect(retiredSource).toEqual({
      kind: "retired",
      appId: "42",
      previousInstallationId: "123",
      successorInstallationId: "456"
    });
    await expect(github.handleWebhook(
      "push",
      "delivery-candidate-before-swap",
      retiredPush,
      retiredSource
    )).resolves.toMatchObject({ pending: 1, ignored: 0 });
    expect(database.sqlite.prepare(`
      SELECT installation_id, latest_delivery_id
      FROM github_dirty_refs WHERE repository_id = ?
    `).get("99")).toEqual({
      installation_id: "456",
      latest_delivery_id: "delivery-candidate-before-swap"
    });
    await expect(github.handleWebhook(
      "pull_request",
      "delivery-retired-pr-delayed-close",
      delayedRetiredClose,
      github.verifyWebhook(delayedRetiredClose, delayedRetiredCloseSignature)
    )).resolves.toMatchObject({ queued: 0, pending: 1, ignored: 0 });
    expect(database.findPullRequestPreview("prj_github", 8)?.status).toBe("closing");
    const candidateReopened = Buffer.from(JSON.stringify(
      pullRequestPayload(
        "reopened",
        456,
        7,
        "2026-07-16T12:00:00.000Z"
      )
    ));
    await expect(github.handleWebhook(
      "pull_request",
      "delivery-candidate-pr-reopen",
      candidateReopened,
      { kind: "active", appId: "84" }
    )).resolves.toMatchObject({ queued: 1 });
    const candidateClosed = Buffer.from(JSON.stringify(
      pullRequestPayload(
        "closed",
        456,
        7,
        "2026-07-16T13:00:00.000Z"
      )
    ));
    await expect(github.handleWebhook(
      "pull_request",
      "delivery-candidate-pr-close",
      candidateClosed,
      { kind: "active", appId: "84" }
    )).resolves.toMatchObject({ pending: 1 });
    expect(database.findPullRequestPreview("prj_github", 7)?.status).toBe("closing");
    const retiredSynchronize = Buffer.from(JSON.stringify(
      pullRequestPayload(
        "synchronize",
        123,
        7,
        "2026-07-16T12:30:00.000Z"
      )
    ));
    const retiredPrSignature = `sha256=${createHmac("sha256", webhookSecret)
      .update(retiredSynchronize).digest("hex")}`;
    await expect(github.handleWebhook(
      "pull_request",
      "delivery-retired-pr-synchronize",
      retiredSynchronize,
      github.verifyWebhook(retiredSynchronize, retiredPrSignature)
    )).resolves.toMatchObject({ queued: 0, pending: 0, ignored: 1 });
    expect(database.findPullRequestPreview("prj_github", 7)?.status).toBe("closing");
    const wrongRetiredPullRequestInstallation = Buffer.from(JSON.stringify(
      pullRequestPayload(
        "closed",
        999,
        7,
        "2026-07-16T14:00:00.000Z"
      )
    ));
    const wrongRetiredPullRequestSignature = `sha256=${createHmac("sha256", webhookSecret)
      .update(wrongRetiredPullRequestInstallation).digest("hex")}`;
    await expect(github.handleWebhook(
      "pull_request",
      "delivery-wrong-retired-pr-installation",
      wrongRetiredPullRequestInstallation,
      github.verifyWebhook(
        wrongRetiredPullRequestInstallation,
        wrongRetiredPullRequestSignature
      )
    )).resolves.toMatchObject({ queued: 0, pending: 0, ignored: 1 });
    expect(database.findPullRequestPreview("prj_github", 7)?.status).toBe("closing");
    const wrongRetiredInstallation = Buffer.from(JSON.stringify({
      ref: "refs/heads/main",
      after: "e".repeat(40),
      deleted: false,
      installation: { id: 999 },
      repository: { id: 99, full_name: "example/private" }
    }));
    const wrongRetiredSignature = `sha256=${createHmac("sha256", webhookSecret)
      .update(wrongRetiredInstallation).digest("hex")}`;
    const wrongRetiredSource = github.verifyWebhook(
      wrongRetiredInstallation,
      wrongRetiredSignature
    );
    await expect(github.handleWebhook(
      "push",
      "delivery-wrong-retired-installation",
      wrongRetiredInstallation,
      wrongRetiredSource
    )).resolves.toMatchObject({ pending: 0, ignored: 1 });
    const invalidSignature = `sha256=${createHmac("sha256", "not-a-valid-webhook-secret")
      .update(retiredPush).digest("hex")}`;
    expect(() => github.verifyWebhook(retiredPush, invalidSignature))
      .toThrowError(expect.objectContaining({ code: "GITHUB_SIGNATURE_INVALID" }));
    expect(database.getGithubRetiredWebhookSource("42")).toMatchObject({
      previous_installation_id: "123",
      successor_installation_id: "456"
    });
    expect(database.retargetGithubRetiredWebhookSources("456", "789")).toBe(1);
    expect(database.getGithubRetiredWebhookSource("42")?.successor_installation_id).toBe("789");
    database.sqlite.prepare(`
      UPDATE github_retired_webhook_sources SET expires_at = ? WHERE app_id = ?
    `).run(new Date(Date.now() - 1_000).toISOString(), "42");
    expect(() => github.verifyWebhook(retiredPush, retiredSignature))
      .toThrowError(expect.objectContaining({ code: "GITHUB_SIGNATURE_INVALID" }));
    expect(database.getGithubRetiredWebhookSource("42")).toBeUndefined();
    database.saveGithubRetiredWebhookSource({
      app_id: "42",
      encrypted_webhook_secret: "disconnect-cleanup-test",
      previous_installation_id: "123",
      successor_installation_id: "456",
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    await github.disconnect();
    expect(database.getGithubRetiredWebhookSource("42")).toBeUndefined();
    database.close();
  });

  it("keeps an incomplete candidate resumable until every linked repository is accessible", async () => {
    let repositoryAccessible = false;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const issuer = appJwtIssuer(init);
      if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
      if (url.endsWith("/app-manifests/upgrade-code/conversions")) return json(upgradeConversion(), 201);
      if (url.endsWith("/app")) {
        return issuer === "84"
          ? json({
              slug: "shelter-upgrade",
              owner: { login: "example", type: "Organization" },
              permissions: { contents: "read", statuses: "write", metadata: "read", pull_requests: "read" },
              events: ["push", "pull_request"]
            })
          : json({
              slug: "portsmith-test",
              owner: { login: "example", type: "Organization" },
              permissions: { contents: "read" },
              events: ["push"]
            });
      }
      if (url.endsWith("/app/installations/456") && issuer === "84") {
        return json({
          id: 456,
          app_id: 84,
          account: { login: "example", type: "Organization", avatar_url: null },
          repository_selection: "selected",
          suspended_at: null,
          permissions: { contents: "read", statuses: "write", metadata: "read", pull_requests: "read" },
          events: ["push", "pull_request"]
        });
      }
      if (url.includes("/app/installations?") && issuer === "42") {
        return json([{
          id: 123,
          app_id: 42,
          account: { login: "example", type: "Organization", avatar_url: null },
          repository_selection: "selected",
          suspended_at: null
        }]);
      }
      if (url.endsWith("/app/installations/456/access_tokens") && issuer === "84") {
        return json({
          token: "ghs_candidate_resume_token_1234567890",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString()
        }, 201);
      }
      if (url.includes("/installation/repositories?")) {
        return json({ repositories: repositoryAccessible ? [repository()] : [] });
      }
      throw new Error(`Unexpected request: ${url} issuer=${issuer}`);
    }) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);
    database.createProject(project());
    const started = await github.startUpgradeManifest("usr_admin", hashToken("session-token"));
    const state = new URL(started.registrationUrl).searchParams.get("state")!;
    const setupState = new URL(started.manifest.setup_url).searchParams.get("state")!;
    const completed = await github.completeManifest(state, started.browserNonce, "upgrade-code");

    await expect(github.completeSetup(setupState, "456", completed.setupBrowserNonce))
      .rejects.toMatchObject({ code: "GITHUB_UPGRADE_REPOSITORIES_MISSING" });
    expect(github.state()).toMatchObject({ appId: "42" });
    expect(database.getProject("prj_github")?.github_installation_id).toBe("123");
    await expect(github.previewCapability()).resolves.toMatchObject({
      upgradePending: true,
      upgradeInstallUrl: "https://github.com/apps/shelter-upgrade/installations/new"
    });

    repositoryAccessible = true;
    await expect(github.completeSetup(setupState, "456", completed.setupBrowserNonce))
      .resolves.toBe("upgraded");
    expect(github.state()).toMatchObject({ appId: "84" });
    expect(database.getProject("prj_github")?.github_installation_id).toBe("456");
    database.close();
  });

  it.each([
    ["the same organization target", "acme", true],
    ["a different organization target", "other-org", false]
  ] as const)(
    "handles a user-owned app installed into %s",
    async (_label, candidateTarget, shouldSucceed) => {
      const organizationRepository = {
        ...repository(),
        full_name: "acme/private",
        html_url: "https://github.com/acme/private",
        clone_url: "https://github.com/acme/private.git",
        owner: { login: "acme" }
      };
      const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const issuer = appJwtIssuer(init);
        if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
        if (url.endsWith("/app-manifests/upgrade-code/conversions")) return json(upgradeConversion(), 201);
        if (url.endsWith("/app")) {
          return issuer === "84"
            ? json({
                slug: "shelter-upgrade",
                owner: { login: "alice", type: "User" },
                permissions: {
                  contents: "read",
                  statuses: "write",
                  metadata: "read",
                  pull_requests: "read"
                },
                events: ["push", "pull_request"]
              })
            : json({
                slug: "portsmith-test",
                owner: { login: "alice", type: "User" },
                permissions: { contents: "read" },
                events: ["push"]
              });
        }
        if (url.endsWith("/app/installations/456") && issuer === "84") {
          return json({
            id: 456,
            app_id: 84,
            account: {
              login: candidateTarget,
              type: "Organization",
              avatar_url: null
            },
            repository_selection: "selected",
            suspended_at: null,
            permissions: {
              contents: "read",
              statuses: "write",
              metadata: "read",
              pull_requests: "read"
            },
            events: ["push", "pull_request"]
          });
        }
        if (url.includes("/app/installations?") && issuer === "42") {
          return json([{
            id: 123,
            app_id: 42,
            account: { login: "acme", type: "Organization", avatar_url: null },
            repository_selection: "selected",
            suspended_at: null
          }]);
        }
        if (url.endsWith("/app/installations/456/access_tokens") && issuer === "84") {
          return json({
            token: "ghs_candidate_cross_owner_token_1234567890",
            expires_at: new Date(Date.now() + 60 * 60_000).toISOString()
          }, 201);
        }
        if (url.includes("/installation/repositories?")) {
          return json({ repositories: [organizationRepository] });
        }
        throw new Error(`Unexpected request: ${url} issuer=${issuer}`);
      }) as unknown as typeof fetch;
      const { database, github } = context(fetcher);
      await connect(github);
      database.createProject(project({
        repository_url: "https://github.com/acme/private.git",
        github_repository_full_name: "acme/private"
      }));
      const started = await github.startUpgradeManifest(
        "usr_admin",
        hashToken("session-token")
      );
      const state = new URL(started.registrationUrl).searchParams.get("state")!;
      const setupState = new URL(started.manifest.setup_url).searchParams.get("state")!;
      const completed = await github.completeManifest(
        state,
        started.browserNonce,
        "upgrade-code"
      );

      if (shouldSucceed) {
        await expect(github.completeSetup(
          setupState,
          "456",
          completed.setupBrowserNonce
        )).resolves.toBe("upgraded");
        expect(github.state()).toMatchObject({ appId: "84" });
        expect(database.getProject("prj_github")?.github_installation_id).toBe("456");
      } else {
        await expect(github.completeSetup(
          setupState,
          "456",
          completed.setupBrowserNonce
        )).rejects.toMatchObject({ code: "GITHUB_UPGRADE_OWNER_MISMATCH" });
        expect(github.state()).toMatchObject({ appId: "42" });
        expect(database.getProject("prj_github")?.github_installation_id).toBe("123");
      }
      database.close();
    }
  );

  it("rolls back installation remapping and credential writes as one SQLite transaction", async () => {
    const fetcher = vi.fn(async () => json(conversion(), 201)) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);
    database.createProject(project());
    const bindings = database.listGithubProjectBindings();
    const oldMetadata = database.getSetting("github.app_metadata");

    expect(() => database.sqlite.transaction(() => {
      database.remapGithubInstallation("123", "456", bindings);
      database.setSetting("github.app_metadata", JSON.stringify({ appId: "84" }));
      database.saveGithubRetiredWebhookSource({
        app_id: "42",
        encrypted_webhook_secret: "encrypted-test-value",
        previous_installation_id: "123",
        successor_installation_id: "456",
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      throw new Error("injected activation failure");
    })()).toThrow("injected activation failure");

    expect(database.getProject("prj_github")?.github_installation_id).toBe("123");
    expect(database.getSetting("github.app_metadata")).toBe(oldMetadata);
    expect(database.getGithubRetiredWebhookSource("42")).toBeUndefined();
    database.close();
  });

  it("binds manifest completion to the still-valid originating session", async () => {
    const fetcher = vi.fn(async () => json(conversion(), 201)) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    const started = github.startManifest("usr_admin", hashToken("session-token"));
    database.deleteSession(hashToken("session-token"));
    const state = new URL(started.registrationUrl).searchParams.get("state")!;

    await expect(github.completeManifest(state, started.browserNonce, "manifest-code"))
      .rejects.toMatchObject({ code: "GITHUB_MANIFEST_STATE_INVALID" });
    expect(fetcher).not.toHaveBeenCalled();
    database.close();
  });

  it("signs app JWTs, caches installation tokens, validates setup and reports commit status", async () => {
    const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization");
      calls.push({ url, authorization, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
      if (url.endsWith("/app/installations/123/access_tokens")) {
        return json({ token: "ghs_short_lived_installation_token", expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }, 201);
      }
      if (url.endsWith("/app/installations/123")) {
        return json({
          id: 123,
          app_id: 42,
          account: { login: "example", type: "Organization", avatar_url: null },
          repository_selection: "selected",
          suspended_at: null
        });
      }
      if (url.includes("/statuses/")) return json({ id: 1 }, 201);
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    const setupState = await connect(github);

    await github.completeSetup(setupState, "123");
    const first = await github.installationToken("123");
    const second = await github.installationToken("123");
    expect(first).toBe(second);
    expect(calls.filter((call) => call.url.endsWith("/access_tokens"))).toHaveLength(1);
    const appAuthorization = calls.find((call) => call.url.endsWith("/access_tokens"))!.authorization!;
    const [header, payload, signature] = appAuthorization.replace(/^Bearer /, "").split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toMatchObject({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({ iss: "42" });
    expect(signature).toBeTruthy();

    database.createProject(project());
    database.createDeployment(deployment({ commit_sha: "b".repeat(40) }));
    expect(database.queueGithubStatus("dep_active", "success", "Deployment ist bereit")).toBe(true);
    await github.reportCommitStatus(database.listDueGithubStatuses(1, "dep_active")[0]!, "prj_github");
    const statusCall = calls.find((call) => call.url.includes("/statuses/"))!;
    expect(statusCall.authorization).toBe("Bearer ghs_short_lived_installation_token");
    expect(statusCall.body).toMatchObject({
      state: "success",
      context: "shelter/deploy",
      target_url: "https://hosting.example.com/projects/prj_github?tab=deployments&deployment=dep_active"
    });
    database.close();
  });

  it("guides app and installation owners through both pull-request permission updates", async () => {
    let appApproved = false;
    let installationApproved = false;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
      if (url.endsWith("/app")) {
        return json({
          slug: "portsmith-test",
          owner: { login: "example", type: "Organization" },
          permissions: appApproved ? { pull_requests: "read" } : { contents: "read" },
          events: appApproved ? ["push", "pull_request"] : ["push"]
        });
      }
      if (url.endsWith("/app/installations/123")) {
        return json({
          id: 123,
          app_id: 42,
          account: { login: "example", type: "Organization", avatar_url: null },
          repository_selection: "selected",
          suspended_at: null,
          permissions: installationApproved ? { pull_requests: "read" } : { contents: "read" },
          events: installationApproved ? ["push", "pull_request"] : ["push"],
          html_url: "https://github.com/organizations/example/settings/installations/123"
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);

    await expect(github.previewCapability("123")).resolves.toMatchObject({
      ready: false,
      pullRequestsPermission: false,
      pullRequestEvent: false,
      installationChecked: true,
      installationPullRequestsPermission: false,
      installationPullRequestEvent: false,
      remediation: "update_existing_app",
      remediationUrl: "https://github.com/organizations/example/settings/apps/portsmith-test/permissions"
    });
    appApproved = true;
    await expect(github.previewCapability("123")).resolves.toMatchObject({
      ready: false,
      pullRequestsPermission: true,
      pullRequestEvent: true,
      installationPullRequestsPermission: false,
      installationPullRequestEvent: false,
      remediation: "approve_installation_update",
      remediationUrl: "https://github.com/organizations/example/settings/installations/123"
    });
    installationApproved = true;
    await expect(github.previewCapability("123")).resolves.toMatchObject({
      ready: true,
      installationPullRequestsPermission: true,
      installationPullRequestEvent: true,
      remediation: "none",
      remediationUrl: null
    });
    database.close();
  });

  it.each([
    ["User", "andy", "https://github.com/settings/apps/portsmith-test/permissions"],
    ["Organization", "raum", "https://github.com/organizations/raum/settings/apps/portsmith-test/permissions"],
    ["Enterprise", "raum-enterprise", "https://github.com/enterprises/raum-enterprise/settings/apps/portsmith-test/permissions"]
  ] as const)("uses the exact %s app-owner permissions URL", async (type, login, expectedUrl) => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
      if (url.endsWith("/app")) {
        return json({
          slug: "portsmith-test",
          owner: { login, type },
          permissions: { contents: "read" },
          events: ["push"]
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);

    await expect(github.previewCapability()).resolves.toMatchObject({
      ready: false,
      remediation: "update_existing_app",
      remediationUrl: expectedUrl
    });
    database.close();
  });

  it("rejects a GitHub App identity that does not match the connected manifest", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
      if (url.endsWith("/app")) {
        return json({
          slug: "different-app",
          owner: { login: "example", type: "Organization" },
          permissions: { contents: "read" },
          events: ["push"]
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);

    await expect(github.previewCapability()).rejects.toMatchObject({ code: "GITHUB_API_INVALID" });
    database.close();
  });

  it("returns only validated GitHub installation settings URLs", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
      if (url.includes("/app/installations?")) {
        return json([
          {
            id: 123,
            app_id: 42,
            account: { login: "andy", type: "User", avatar_url: null },
            repository_selection: "all",
            suspended_at: null,
            html_url: "https://github.com/settings/installations/123"
          },
          {
            id: 124,
            app_id: 42,
            account: { login: "raum", type: "Organization", avatar_url: null },
            repository_selection: "selected",
            suspended_at: null,
            html_url: "https://github.com/organizations/raum/settings/installations/124"
          },
          {
            id: 125,
            app_id: 42,
            account: { login: "raum-enterprise", type: "Enterprise", avatar_url: null },
            repository_selection: "selected",
            suspended_at: null,
            html_url: "https://github.com/enterprises/raum-enterprise/settings/installations/125"
          },
          {
            id: 126,
            app_id: 42,
            account: { login: "fallback-org", type: "Organization", avatar_url: null },
            repository_selection: "selected",
            suspended_at: null
          }
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);

    await expect(github.installations()).resolves.toEqual([
      expect.objectContaining({
        id: "123",
        htmlUrl: "https://github.com/settings/installations/123"
      }),
      expect.objectContaining({
        id: "124",
        htmlUrl: "https://github.com/organizations/raum/settings/installations/124"
      }),
      expect.objectContaining({
        id: "125",
        htmlUrl: "https://github.com/enterprises/raum-enterprise/settings/installations/125"
      }),
      expect.objectContaining({
        id: "126",
        htmlUrl: "https://github.com/organizations/fallback-org/settings/installations/126"
      })
    ]);
    database.close();
  });

  it("rejects unsafe or mismatched GitHub installation settings URLs", async () => {
    let installationUrl = "https://github.com/settings/installations/123";
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
      if (url.includes("/app/installations?")) {
        return json([{
          id: 123,
          app_id: 42,
          account: { login: "example", type: "Organization", avatar_url: null },
          repository_selection: "selected",
          suspended_at: null,
          html_url: installationUrl
        }]);
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);

    for (const invalidUrl of [
      "https://evil.example/settings/installations/123",
      "https://attacker@github.com/settings/installations/123",
      "https://github.com:444/settings/installations/123",
      "https://github.com/settings/installations/123?next=https://evil.example",
      "https://github.com/settings/installations/123#permissions",
      "https://github.com/settings/installations/999",
      "https://github.com/organizations/different/settings/installations/123"
    ]) {
      installationUrl = invalidUrl;
      await expect(github.installations()).rejects.toMatchObject({ code: "GITHUB_API_INVALID" });
    }
    database.close();
  });

  it("persists failed commit statuses and retries them from the outbox", async () => {
    let statusAttempts = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
      if (url.endsWith("/app/installations/123/access_tokens")) {
        return json({
          token: "ghs_outbox_token_value_1234567890",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString()
        }, 201);
      }
      if (url.includes("/statuses/")) {
        statusAttempts += 1;
        return statusAttempts === 1 ? json({ message: "temporary" }, 503) : json({ id: statusAttempts }, 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);
    database.createProject(project());
    database.createDeployment(deployment());

    expect(database.queueGithubStatus("dep_active", "pending", "Build läuft")).toBe(true);
    expect(await github.processNextCommitStatus("dep_active")).toBe(true);
    expect(database.sqlite.prepare("SELECT delivered_state, attempts FROM github_status_outbox WHERE deployment_id = ?")
      .get("dep_active")).toEqual({ delivered_state: null, attempts: 1 });

    database.sqlite.prepare("UPDATE github_status_outbox SET next_attempt_at = ? WHERE deployment_id = ?")
      .run(new Date(0).toISOString(), "dep_active");
    expect(await github.processNextCommitStatus("dep_active")).toBe(true);
    expect(database.sqlite.prepare("SELECT delivered_state, attempts FROM github_status_outbox WHERE deployment_id = ?")
      .get("dep_active")).toEqual({ delivered_state: "pending", attempts: 0 });
    expect(statusAttempts).toBe(2);
    database.close();
  });
});

describe("GitHub webhook deployment queue", () => {
  it("exposes unresolved dirty refs so an in-flight deployment cannot activate stale code", () => {
    const fetcher = vi.fn(async () => json(conversion(), 201)) as unknown as typeof fetch;
    const { database } = context(fetcher);
    database.createProject(project());
    database.createDeployment(deployment());

    expect(database.hasPendingGithubWork("prj_github", "a".repeat(40))).toBe(false);
    database.enqueueGithubDirtyRef({
      installationId: "123",
      repositoryId: "99",
      repositoryFullName: "example/private",
      branch: "main",
      deliveryId: "delivery-during-build"
    });
    expect(database.hasPendingGithubWork("prj_github", "a".repeat(40))).toBe(true);
    database.updateDeployment("dep_active", { status: "checking" });
    expect(database.beginDeploymentActivation("dep_active", "prj_github", "a".repeat(40)))
      .toBe("superseded");
    expect(database.getDeployment("dep_active")).toMatchObject({ status: "cancelled" });
    database.close();
  });

  it("linearizes activation before a later push is accepted", () => {
    const fetcher = vi.fn(async () => json(conversion(), 201)) as unknown as typeof fetch;
    const { database } = context(fetcher);
    database.createProject(project());
    database.createDeployment(deployment({ status: "checking" }));

    expect(database.beginDeploymentActivation("dep_active", "prj_github", "a".repeat(40)))
      .toBe("activation_started");
    database.enqueueGithubDirtyRef({
      installationId: "123",
      repositoryId: "99",
      repositoryFullName: "example/private",
      branch: "main",
      deliveryId: "delivery-after-activation"
    });
    expect(database.getDeployment("dep_active")).toMatchObject({ status: "switching" });
    expect(database.hasPendingGithubWork("prj_github", "a".repeat(40))).toBe(true);
    database.close();
  });

  it("verifies the raw body, resolves current branch HEAD, deduplicates and materializes latest pending push", async () => {
    const desiredSha = "c".repeat(40);
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
      if (url.endsWith("/app/installations/123/access_tokens")) {
        return json({ token: "ghs_webhook_token_value_123456789", expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }, 201);
      }
      if (url.endsWith("/repositories/99")) {
        return json({
          id: 99,
          name: "private",
          full_name: "example/private",
          private: true,
          default_branch: "main",
          html_url: "https://github.com/example/private",
          clone_url: "https://github.com/example/private.git",
          owner: { login: "example" }
        });
      }
      if (url.endsWith("/repos/example/private/commits/main")) {
        return json({
          sha: desiredSha,
          html_url: `https://github.com/example/private/commit/${desiredSha}`,
          commit: { message: "Newest commit from API", author: { name: "Ada" } }
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);
    database.createProject(project());
    database.createDeployment(deployment());

    const raw = Buffer.from(JSON.stringify({
      ref: "refs/heads/main",
      after: "b".repeat(40),
      deleted: false,
      installation: { id: 123 },
      repository: { id: 99, full_name: "example/private" }
    }, null, 2));
    const signature = `sha256=${createHmac("sha256", webhookSecret).update(raw).digest("hex")}`;
    expect(() => github.verifyWebhook(raw, signature)).not.toThrow();
    expect(() => github.verifyWebhook(Buffer.concat([raw, Buffer.from(" ")]), signature))
      .toThrowError(/Signatur/);

    const first = await github.handleWebhook("push", "delivery-1", raw);
    expect(first).toEqual({ duplicate: false, queued: 0, pending: 1, ignored: 0 });
    expect(database.getPendingGithubPush("prj_github")).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1); // only manifest conversion; webhook ACK performs no network I/O
    expect(await github.processNextWebhookJob()).toBe(true);
    expect(database.getPendingGithubPush("prj_github")).toMatchObject({
      delivery_id: "delivery-1",
      commit_sha: desiredSha,
      commit_message: "Newest commit from API",
      commit_author: "Ada"
    });
    expect(await github.handleWebhook("push", "delivery-1", raw)).toMatchObject({ duplicate: true });
    expect(fetcher).toHaveBeenCalledTimes(4); // conversion, token, repository and current HEAD

    const changedPayload = Buffer.from(raw.toString("utf8").replace("refs/heads/main", "refs/heads/other"));
    await expect(github.handleWebhook("push", "delivery-1", changedPayload))
      .rejects.toMatchObject({ code: "GITHUB_DELIVERY_MISMATCH" });

    database.updateDeployment("dep_active", {
      status: "ready",
      finished_at: new Date().toISOString()
    });
    const next = database.materializePendingGithubPush("prj_github");
    expect(next).toMatchObject({
      status: "queued",
      trigger: "github_push",
      github_delivery_id: "delivery-1",
      commit_sha: desiredSha,
      commit_message: "Newest commit from API",
      commit_author: "Ada"
    });
    expect(database.getPendingGithubPush("prj_github")).toBeUndefined();
    database.close();
  });

  it("never lets a stale resolver overwrite a newer dirty generation", async () => {
    const newestSha = "d".repeat(40);
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
      if (url.endsWith("/app/installations/123/access_tokens")) {
        return json({ token: "ghs_generation_token_1234567890", expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }, 201);
      }
      if (url.endsWith("/repositories/99")) {
        return json({
          id: 99,
          name: "private",
          full_name: "example/private",
          private: true,
          default_branch: "main",
          html_url: "https://github.com/example/private",
          clone_url: "https://github.com/example/private.git",
          owner: { login: "example" }
        });
      }
      if (url.endsWith("/repos/example/private/commits/main")) {
        return json({
          sha: newestSha,
          html_url: `https://github.com/example/private/commit/${newestSha}`,
          commit: { message: "Newest generation", author: { name: "Grace" } }
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);
    database.createProject(project());
    const payload = (after: string) => Buffer.from(JSON.stringify({
      ref: "refs/heads/main",
      after,
      deleted: false,
      installation: { id: 123 },
      repository: { id: 99, full_name: "example/private" }
    }));

    await github.handleWebhook("push", "generation-1", payload("a".repeat(40)));
    const staleClaim = database.claimNextGithubDirtyRef()!;
    await github.handleWebhook("push", "generation-2", payload("b".repeat(40)));
    expect(database.applyResolvedGithubRef(staleClaim, {
      deliveryId: "generation-1",
      installationId: "123",
      repositoryId: "99",
      repositoryFullName: "renamed/private",
      branch: "main",
      commitSha: "c".repeat(40),
      commitMessage: "Stale generation",
      commitAuthor: "Old",
      commitUrl: `https://github.com/example/private/commit/${"c".repeat(40)}`,
      receivedAt: new Date().toISOString()
    }, "https://github.com/renamed/private.git")).toEqual({ kind: "superseded" });
    expect(database.listDeployments("prj_github", 10)).toHaveLength(0);
    expect(database.getProject("prj_github")).toMatchObject({
      github_repository_full_name: "example/private",
      repository_url: "https://github.com/example/private.git"
    });

    expect(await github.processNextWebhookJob()).toBe(true);
    expect(database.listDeployments("prj_github", 10)).toHaveLength(1);
    expect(database.listDeployments("prj_github", 10)[0]).toMatchObject({
      commit_sha: newestSha,
      github_delivery_id: "generation-2"
    });
    database.close();
  });

  it("pauses auto-deploy when an installation or repository is removed", async () => {
    const fetcher = vi.fn(async () => json(conversion(), 201)) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);
    database.createProject(project());

    await github.handleWebhook("installation_repositories", "delivery-repo-removed", Buffer.from(JSON.stringify({
      action: "removed",
      installation: { id: 123 },
      repositories_removed: [{ id: 99 }]
    }))); 
    expect(database.getProject("prj_github")).toMatchObject({
      auto_deploy: 1,
      github_connection_error: expect.stringContaining("Repository-Zugriff")
    });
    await github.handleWebhook("installation_repositories", "delivery-repo-added", Buffer.from(JSON.stringify({
      action: "added",
      installation: { id: 123 },
      repositories_added: [{ id: 99 }]
    })));
    expect(database.getProject("prj_github")).toMatchObject({ auto_deploy: 1, github_connection_error: null });
    await github.handleWebhook("installation", "delivery-install-suspended", Buffer.from(JSON.stringify({
      action: "suspend",
      installation: { id: 123 }
    })));
    expect(database.getProject("prj_github")).toMatchObject({
      auto_deploy: 1,
      github_connection_error: expect.stringContaining("pausiert")
    });
    await github.handleWebhook("installation", "delivery-install-unsuspended", Buffer.from(JSON.stringify({
      action: "unsuspend",
      installation: { id: 123 }
    })));
    expect(database.getProject("prj_github")).toMatchObject({ auto_deploy: 1, github_connection_error: null });
    database.close();
  });

  it("keeps a lifecycle error when a claimed resolver loses the dirty ref", async () => {
    const fetcher = vi.fn(async () => json(conversion(), 201)) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);
    database.createProject(project());
    await github.handleWebhook("push", "delivery-before-suspend", Buffer.from(JSON.stringify({
      ref: "refs/heads/main",
      after: "a".repeat(40),
      deleted: false,
      installation: { id: 123 },
      repository: { id: 99, full_name: "example/private" }
    })));
    const claimed = database.claimNextGithubDirtyRef()!;

    await github.handleWebhook("installation", "delivery-suspend-during-resolve", Buffer.from(JSON.stringify({
      action: "suspend",
      installation: { id: 123 }
    })));
    expect(database.applyResolvedGithubRef(claimed, {
      deliveryId: "delivery-before-suspend",
      installationId: "123",
      repositoryId: "99",
      repositoryFullName: "renamed/private",
      branch: "main",
      commitSha: "b".repeat(40),
      commitMessage: "Resolved too late",
      commitAuthor: "Late Resolver",
      commitUrl: `https://github.com/renamed/private/commit/${"b".repeat(40)}`,
      receivedAt: new Date().toISOString()
    }, "https://github.com/renamed/private.git")).toEqual({ kind: "lost" });
    expect(database.getProject("prj_github")).toMatchObject({
      github_connection_error: expect.stringContaining("pausiert"),
      github_repository_full_name: "example/private",
      repository_url: "https://github.com/example/private.git"
    });

    await github.handleWebhook("installation", "delivery-unsuspend-before-remove", Buffer.from(JSON.stringify({
      action: "unsuspend",
      installation: { id: 123 }
    })));
    await github.handleWebhook("push", "delivery-before-remove", Buffer.from(JSON.stringify({
      ref: "refs/heads/main",
      after: "c".repeat(40),
      deleted: false,
      installation: { id: 123 },
      repository: { id: 99, full_name: "example/private" }
    })));
    const removedClaim = database.claimNextGithubDirtyRef()!;
    await github.handleWebhook("installation_repositories", "delivery-remove-during-resolve", Buffer.from(JSON.stringify({
      action: "removed",
      installation: { id: 123 },
      repositories_removed: [{ id: 99 }]
    })));
    expect(database.applyResolvedGithubRef(removedClaim, {
      deliveryId: "delivery-before-remove",
      installationId: "123",
      repositoryId: "99",
      repositoryFullName: "renamed-again/private",
      branch: "main",
      commitSha: "d".repeat(40),
      commitMessage: "Resolved after repository removal",
      commitAuthor: "Late Resolver",
      commitUrl: `https://github.com/renamed-again/private/commit/${"d".repeat(40)}`,
      receivedAt: new Date().toISOString()
    }, "https://github.com/renamed-again/private.git")).toEqual({ kind: "lost" });
    expect(database.getProject("prj_github")).toMatchObject({
      github_connection_error: expect.stringContaining("Repository-Zugriff"),
      github_repository_full_name: "example/private",
      repository_url: "https://github.com/example/private.git"
    });
    database.close();
  });

  it("invalidates cached installation tokens when updated permissions are accepted", async () => {
    let tokenCalls = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
      if (url.endsWith("/app/installations/123/access_tokens")) {
        tokenCalls += 1;
        return json({
          token: `ghs_permissions_token_${tokenCalls}_1234567890`,
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString()
        }, 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);

    await expect(github.installationToken("123"))
      .resolves.toBe("ghs_permissions_token_1_1234567890");
    await expect(github.handleWebhook(
      "installation",
      "delivery-new-permissions-accepted",
      Buffer.from(JSON.stringify({
        action: "new_permissions_accepted",
        installation: { id: 123 }
      }))
    )).resolves.toEqual({ duplicate: false, queued: 0, pending: 0, ignored: 0 });
    await expect(github.installationToken("123"))
      .resolves.toBe("ghs_permissions_token_2_1234567890");
    expect(tokenCalls).toBe(2);
    database.close();
  });

  it("invalidates every cached and in-flight token variant for a changed installation", async () => {
    let tokenCalls = 0;
    let resolveFourthToken!: (response: Response) => void;
    let resolveFifthToken!: (response: Response) => void;
    let markFourthStarted!: () => void;
    let markFifthStarted!: () => void;
    const fourthStarted = new Promise<void>((resolve) => {
      markFourthStarted = resolve;
    });
    const fifthStarted = new Promise<void>((resolve) => {
      markFifthStarted = resolve;
    });
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
      if (url.endsWith("/app/installations/123/access_tokens")) {
        tokenCalls += 1;
        if (tokenCalls === 4) {
          markFourthStarted();
          return await new Promise<Response>((resolve) => {
            resolveFourthToken = resolve;
          });
        }
        if (tokenCalls === 5) {
          markFifthStarted();
          return await new Promise<Response>((resolve) => {
            resolveFifthToken = resolve;
          });
        }
        return json({
          token: `ghs_installation_token_${tokenCalls}_1234567890`,
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString()
        }, 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);
    database.createProject(project());

    await github.installationToken("123");
    await github.installationToken("123", "99");
    expect(tokenCalls).toBe(2);
    await github.handleWebhook("installation_repositories", "delivery-token-repo-removed", Buffer.from(JSON.stringify({
      action: "removed",
      installation: { id: 123 },
      repositories_removed: [{ id: 99 }]
    })));
    await github.installationToken("123", "99");
    expect(tokenCalls).toBe(3);

    const staleToken = github.installationToken("123");
    await fourthStarted;
    expect(tokenCalls).toBe(4);
    await github.handleWebhook("installation", "delivery-token-install-suspended", Buffer.from(JSON.stringify({
      action: "suspend",
      installation: { id: 123 }
    })));
    const freshToken = github.installationToken("123");
    await fifthStarted;
    resolveFourthToken(json({
      token: "ghs_stale_installation_token_1234567890",
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString()
    }, 201));
    await expect(staleToken).rejects.toMatchObject({ code: "GITHUB_TOKEN_INVALIDATED" });
    const deduplicatedFreshToken = github.installationToken("123");
    expect(tokenCalls).toBe(5);
    resolveFifthToken(json({
      token: "ghs_installation_token_5_1234567890",
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString()
    }, 201));
    await expect(freshToken).resolves.toBe("ghs_installation_token_5_1234567890");
    await expect(deduplicatedFreshToken).resolves.toBe("ghs_installation_token_5_1234567890");
    database.close();
  });

  it("analyzes GitHub trees with bounded content reads and caches the result by branch SHA", async () => {
    const commitSha = "a".repeat(40);
    let treeRequests = 0;
    let contentRequests = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/app-manifests/manifest-code/conversions")) return json(conversion(), 201);
      if (url.endsWith("/app/installations/123/access_tokens")) {
        return json({
          token: "ghs_analysis_installation_token_1234567890",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString()
        }, 201);
      }
      if (url.endsWith("/repositories/99")) {
        return json({
          id: 99,
          name: "private",
          full_name: "example/private",
          private: true,
          default_branch: "main",
          html_url: "https://github.com/example/private",
          clone_url: "https://github.com/example/private.git",
          owner: { login: "example" }
        });
      }
      if (url.endsWith("/repos/example/private/branches/main")) {
        return json({ name: "main", protected: false, commit: { sha: commitSha } });
      }
      if (url.includes(`/repos/example/private/git/trees/${commitSha}?recursive=1`)) {
        treeRequests += 1;
        return json({
          sha: commitSha,
          truncated: false,
          tree: [
            { path: "package.json", type: "blob", size: 120, sha: "b".repeat(40) },
            { path: "next.config.mjs", type: "blob", size: 36, sha: "c".repeat(40) },
            { path: "app/page.tsx", type: "blob", size: 20, sha: "d".repeat(40) },
            { path: ".env", type: "blob", size: 500, sha: "e".repeat(40) },
            { path: "node_modules/evil/package.json", type: "blob", size: 20, sha: "f".repeat(40) },
            ...Array.from({ length: 150 }, (_, index) => ({
              path: `public/page-${index}/index.html`, type: "blob", size: 20, sha: "1".repeat(40)
            }))
          ]
        });
      }
      if (url.includes("/contents/package.json?")) {
        contentRequests += 1;
        const content = Buffer.from(JSON.stringify({
          name: "site",
          scripts: { build: "next build" },
          dependencies: { next: "16.0.0" }
        }));
        return json({ type: "file", encoding: "base64", content: content.toString("base64"), size: content.length });
      }
      if (url.includes("/contents/next.config.mjs?")) {
        contentRequests += 1;
        const content = Buffer.from("export default { output: 'export' }");
        return json({ type: "file", encoding: "base64", content: content.toString("base64"), size: content.length });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const { database, github } = context(fetcher);
    await connect(github);

    const first = await github.analyzeRepository("123", "99", "main");
    const second = await github.analyzeRepository("123", "99", "main");
    expect(first).toEqual(second);
    expect(first.applications[0]).toMatchObject({
      framework: "next",
      rendering: "static",
      outputDirectory: "out"
    });
    expect(treeRequests).toBe(1);
    expect(contentRequests).toBe(2);
    expect(JSON.stringify(first)).not.toContain(".env");
    database.close();
  });
});
