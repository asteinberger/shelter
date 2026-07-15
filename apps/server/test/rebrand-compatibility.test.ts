import { createCipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { decryptString, encryptString } from "../src/lib/security.js";
import { CloudflareService } from "../src/services/cloudflare.js";
import { panelDomainAliases } from "../src/services/panel-domains.js";
import { reconcileRouting } from "../src/services/routing.js";
import { stableContainerName } from "../src/services/runtime-identity.js";
import { buildEnvironmentSecretArgs } from "../src/services/worker.js";
import type { DeploymentRow, DomainRow, ProjectRow } from "../src/types/models.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-rebrand-"));
  directories.push(directory);
  return directory;
}

function legacyEncrypt(value: string, secret: string): string {
  const iv = randomBytes(12);
  const key = createHash("sha256").update(`portsmith:v1:${secret}`).digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function envelope(result: unknown, status = 200): Response {
  return Response.json({ success: true, result }, { status });
}

function project(id: string, slug: string, deploymentId: string): ProjectRow {
  const now = new Date().toISOString();
  return {
    id,
    name: slug,
    slug,
    source_type: "git",
    repository_url: "https://github.com/example/example.git",
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
    active_deployment_id: deploymentId,
    created_at: now,
    updated_at: now
  };
}

function deployment(id: string, projectId: string, imageTag: string, port: number): DeploymentRow {
  const now = new Date().toISOString();
  return {
    id,
    project_id: projectId,
    status: "ready",
    source_ref: "main",
    image_tag: imageTag,
    previous_image_tag: null,
    internal_port: port,
    static_base_path: null,
    runtime_kind: "node",
    runtime_description: "Node.js",
    commit_sha: null,
    error: null,
    started_at: now,
    finished_at: now,
    created_at: now
  };
}

function domain(id: string, projectId: string, hostname: string): DomainRow {
  return {
    id,
    project_id: projectId,
    hostname,
    zone_id: "zone",
    dns_record_id: `record-${id}`,
    status: "active",
    error: null,
    created_at: new Date().toISOString()
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Shelter rebrand compatibility", () => {
  it("uses the Shelter database for new installs and preserves an existing Portsmith database path", () => {
    const fresh = temporaryDirectory();
    expect(loadConfig({ NODE_ENV: "test", DATA_DIR: fresh }).databasePath).toBe(path.join(fresh, "shelter.sqlite"));

    const upgraded = temporaryDirectory();
    fs.writeFileSync(path.join(upgraded, "portsmith.sqlite"), "legacy");
    expect(loadConfig({ NODE_ENV: "test", DATA_DIR: upgraded }).databasePath).toBe(path.join(upgraded, "portsmith.sqlite"));
  });

  it("writes Shelter ciphertext while continuing to decrypt persisted Portsmith v1 values", () => {
    const secret = "s".repeat(64);
    const current = encryptString("new-value", secret);
    expect(current.startsWith("v2.")).toBe(true);
    expect(decryptString(current, secret)).toBe("new-value");
    expect(decryptString(legacyEncrypt("legacy-value", secret), secret)).toBe("legacy-value");
  });

  it("does not rewrite user-controlled text inside historical system logs", () => {
    const directory = temporaryDirectory();
    const config = loadConfig({ NODE_ENV: "test", DATA_DIR: directory, APP_SECRET: "l".repeat(64) });
    const database = new Database(config);
    const existingProject = project("prj_logs", "portsmith-customer", "dep_logs");
    database.createProject(existingProject);
    database.createDeployment(deployment("dep_logs", existingProject.id, "portsmith/customer:old", 3000));
    const message = "Worker startet Deployment für Portsmith Kundenportal.";
    database.addLog("dep_logs", "system", message);
    database.close();

    const reopened = new Database(config);
    expect(reopened.listLogs("dep_logs").map((entry) => entry.message)).toContain(message);
    reopened.close();
  });

  it("offers both BuildKit secret ids to custom Dockerfiles during the transition", () => {
    expect(buildEnvironmentSecretArgs("/tmp/shelter-env.json")).toEqual([
      "--secret", "id=shelter_env,src=/tmp/shelter-env.json",
      "--secret", "id=portsmith_env,src=/tmp/shelter-env.json"
    ]);
  });

  it("issues the Shelter session cookie and still authenticates an unexpired legacy cookie", async () => {
    const directory = temporaryDirectory();
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: directory,
      WEB_DIST: path.join(directory, "missing-web"),
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: "correct horse battery staple",
      APP_SECRET: "a".repeat(64),
      LOG_LEVEL: "silent"
    });
    const app = await createApp(config);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });
    const session = login.cookies.find((cookie) => cookie.name === "shelter_session")?.value;
    expect(session).toBeTruthy();
    expect(login.headers.server).toBe("Shelter");

    const legacyRequest = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: `portsmith_session=${session}` }
    });
    expect(legacyRequest.json().user).toMatchObject({ email: "admin@example.com" });
    await app.close();
  });

  it("renames only the owned tunnel and keeps the previous panel domain as a routed alias", async () => {
    const directory = temporaryDirectory();
    const accountId = "a".repeat(32);
    const tunnelId = "11111111-2222-4333-8444-555555555555";
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: directory,
      APP_SECRET: "b".repeat(64),
      TRAEFIK_CONFIG_PATH: path.join(directory, "traefik", "dynamic.yml"),
      TUNNEL_TOKEN_PATH: path.join(directory, "cloudflared", "tunnel-token")
    });
    const database = new Database(config);
    database.setSetting("cloudflare.account_id", accountId);
    database.setSetting("cloudflare.tunnel_id", tunnelId);
    database.setSetting("cloudflare.tunnel_name", "portsmith");
    database.setSetting("cloudflare.panel_domain", "hosting-old.example.com");
    database.setSetting("cloudflare.panel_zone_id", "old-zone");
    database.setSetting("cloudflare.panel_record_id", "old-record");
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, url, body });
      if (url.endsWith("/user/tokens/verify")) return envelope({ status: "active" });
      if (url.endsWith(`/cfd_tunnel/${tunnelId}`) && method === "GET") {
        return envelope({ id: tunnelId, name: "portsmith", status: "healthy", deleted_at: null });
      }
      if (url.includes("/cfd_tunnel?") && new URL(url).searchParams.get("name") === "shelter") return envelope([]);
      if (url.endsWith(`/cfd_tunnel/${tunnelId}`) && method === "PATCH") {
        expect(body).toEqual({ name: "shelter" });
        return envelope({ id: tunnelId, name: "shelter", status: "healthy", deleted_at: null });
      }
      if (url.endsWith(`/cfd_tunnel/${tunnelId}/configurations`) && method === "PUT") return envelope({});
      if (url.endsWith(`/cfd_tunnel/${tunnelId}/token`)) return envelope("signed-tunnel-token");
      if (url.includes("/zones?")) {
        return envelope([{ id: "new-zone", name: "example.com", status: "active" }]);
      }
      if (url.includes("/zones/new-zone/dns_records?") && method === "GET") return envelope([]);
      if (url.endsWith("/zones/new-zone/dns_records") && method === "POST") {
        return envelope({
          id: "new-record",
          name: "hosting.example.com",
          type: "CNAME",
          content: `${tunnelId}.cfargotunnel.com`,
          proxied: true,
          comment: "Managed by Shelter"
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    const state = await new CloudflareService(config, database).setup({
      accountId,
      apiToken: "cloudflare-api-token",
      tunnelName: "shelter",
      panelDomain: "hosting.example.com"
    });

    expect(state).toMatchObject({ tunnelName: "shelter", panelDomain: "hosting.example.com" });
    expect(database.getSetting("cloudflare.tunnel_name")).toBe("shelter");
    expect(panelDomainAliases(database)).toContainEqual({
      hostname: "hosting-old.example.com",
      zoneId: "old-zone",
      recordId: "old-record"
    });
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(fs.readFileSync(config.traefikConfigPath, "utf8")).toContain("hosting-old.example.com");
    expect(fs.readFileSync(config.traefikConfigPath, "utf8")).toContain("hosting.example.com");
    database.close();
  });

  it("rejects a tunnel-name collision before PATCH and leaves persisted ownership unchanged", async () => {
    const directory = temporaryDirectory();
    const accountId = "c".repeat(32);
    const tunnelId = "11111111-2222-4333-8444-555555555555";
    const config = loadConfig({ NODE_ENV: "test", DATA_DIR: directory, APP_SECRET: "c".repeat(64) });
    const database = new Database(config);
    database.setSetting("cloudflare.account_id", accountId);
    database.setSetting("cloudflare.tunnel_id", tunnelId);
    database.setSetting("cloudflare.tunnel_name", "portsmith");
    const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      methods.push(method);
      if (url.endsWith("/user/tokens/verify")) return envelope({ status: "active" });
      if (url.endsWith(`/cfd_tunnel/${tunnelId}`)) {
        return envelope({ id: tunnelId, name: "portsmith", deleted_at: null });
      }
      if (url.includes("/cfd_tunnel?")) {
        return envelope([{ id: "foreign-tunnel", name: "shelter", deleted_at: null }]);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    await expect(new CloudflareService(config, database).setup({
      accountId,
      apiToken: "cloudflare-api-token",
      tunnelName: "shelter"
    })).rejects.toMatchObject({ code: "TUNNEL_NAME_EXISTS" });
    expect(methods).not.toContain("PATCH");
    expect(database.getSetting("cloudflare.tunnel_name")).toBe("portsmith");
    database.close();
  });

  it("does not persist a tunnel rename when Cloudflare rejects the PATCH", async () => {
    const directory = temporaryDirectory();
    const accountId = "d".repeat(32);
    const tunnelId = "11111111-2222-4333-8444-555555555555";
    const config = loadConfig({ NODE_ENV: "test", DATA_DIR: directory, APP_SECRET: "d".repeat(64) });
    const database = new Database(config);
    database.setSetting("cloudflare.account_id", accountId);
    database.setSetting("cloudflare.tunnel_id", tunnelId);
    database.setSetting("cloudflare.tunnel_name", "portsmith");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/user/tokens/verify")) return envelope({ status: "active" });
      if (url.endsWith(`/cfd_tunnel/${tunnelId}`) && method === "GET") {
        return envelope({ id: tunnelId, name: "portsmith", deleted_at: null });
      }
      if (url.includes("/cfd_tunnel?") && method === "GET") return envelope([]);
      if (url.endsWith(`/cfd_tunnel/${tunnelId}`) && method === "PATCH") {
        return Response.json({
          success: false,
          result: null,
          errors: [{ code: 1000, message: "rename rejected" }]
        }, { status: 409 });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    await expect(new CloudflareService(config, database).setup({
      accountId,
      apiToken: "cloudflare-api-token",
      tunnelName: "shelter"
    })).rejects.toMatchObject({ code: "CLOUDFLARE_API" });
    expect(database.getSetting("cloudflare.tunnel_name")).toBe("portsmith");
    database.close();
  });

  it("routes persisted Portsmith deployments while using Shelter identities for new deployments", () => {
    const directory = temporaryDirectory();
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: directory,
      APP_SECRET: "e".repeat(64),
      TRAEFIK_CONFIG_PATH: path.join(directory, "traefik", "dynamic.yml")
    });
    const database = new Database(config);
    const legacyProject = project("prj_legacy", "legacy-app", "dep_legacy");
    const shelterProject = project("prj_shelter", "shelter-app", "dep_shelter");
    database.createProject(legacyProject);
    database.createProject(shelterProject);
    database.createDeployment(deployment("dep_legacy", legacyProject.id, "portsmith/legacy-app:old", 3000));
    database.createDeployment(deployment("dep_shelter", shelterProject.id, "shelter/shelter-app:new", 4100));
    database.createDomain(domain("dom_legacy", legacyProject.id, "legacy.example.com"));
    database.createDomain(domain("dom_shelter", shelterProject.id, "new.example.com"));

    reconcileRouting(config, database);

    const routing = fs.readFileSync(config.traefikConfigPath, "utf8");
    expect(stableContainerName(legacyProject.slug, "portsmith/legacy-app:old")).toBe("portsmith-app-legacy-app");
    expect(stableContainerName(shelterProject.slug, "shelter/shelter-app:new")).toBe("shelter-app-shelter-app");
    expect(routing).toContain("http://portsmith-app-legacy-app:3000");
    expect(routing).toContain("http://shelter-app-shelter-app:4100");
    database.close();
  });
});
