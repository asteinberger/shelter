import { createHmac, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
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
