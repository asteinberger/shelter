import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import type { DeploymentRow, ProjectRow } from "../src/types/models.js";

const directories: string[] = [];
const apps: FastifyInstance[] = [];

function project(id: string, activeDeploymentId: string): ProjectRow {
  const now = new Date().toISOString();
  return {
    id,
    name: "Private launch",
    slug: "private-launch",
    source_type: "git",
    repository_url: "https://github.com/example/private-launch.git",
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
    active_deployment_id: activeDeploymentId,
    created_at: now,
    updated_at: now
  };
}

function deployment(id: string, projectId: string): DeploymentRow {
  return {
    id,
    project_id: projectId,
    status: "ready",
    source_ref: "main",
    image_tag: "shelter/private-launch:latest",
    previous_image_tag: null,
    internal_port: 3000,
    static_base_path: null,
    runtime_kind: "next",
    runtime_description: "Next.js",
    runtime_container: "shelter-run-private-launch",
    failure_kind: null,
    rollback_status: "not_required",
    rollback_deployment_id: null,
    cancel_requested_at: null,
    commit_sha: null,
    trigger: "manual",
    github_delivery_id: null,
    deployment_scope: "production",
    preview_id: null,
    error: null,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    created_at: new Date().toISOString()
  };
}

async function context(): Promise<{
  app: FastifyInstance;
  config: AppConfig;
  database: Database;
  mutationHeaders: Record<string, string>;
}> {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-site-access-"));
  directories.push(dataDirectory);
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDirectory,
    WEB_DIST: path.join(dataDirectory, "missing-web"),
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "correct horse battery staple",
    APP_SECRET: "a".repeat(64),
    LOG_LEVEL: "silent"
  });
  fs.mkdirSync(path.join(config.WEB_DIST, "brand"), { recursive: true });
  fs.writeFileSync(
    path.join(config.WEB_DIST, "brand", "shelter-icon-64.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47])
  );
  const database = new Database(config);
  const projectId = "prj_site_access";
  const deploymentId = "dep_site_access";
  database.createProject(project(projectId, deploymentId));
  database.createDeployment(deployment(deploymentId, projectId));
  database.createDomain({
    id: "dom_site_access",
    project_id: projectId,
    hostname: "private.example.com",
    zone_id: "zone",
    dns_record_id: "record",
    status: "active",
    error: null,
    created_at: new Date().toISOString()
  });
  const app = await createApp(config, database);
  apps.push(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin@example.com", password: "correct horse battery staple" }
  });
  return {
    app,
    config,
    database,
    mutationHeaders: {
      cookie: `shelter_session=${login.cookies.find((entry) => entry.name === "shelter_session")?.value ?? ""}`,
      "x-csrf-token": login.json().csrfToken as string,
      origin: "http://localhost:7080",
      host: "localhost:7080"
    }
  };
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("per-domain site access", () => {
  it("protects a domain with a separate password and revocable host-bound visitor cookie", async () => {
    const { app, database, mutationHeaders } = await context();
    const update = await app.inject({
      method: "PUT",
      url: "/api/projects/prj_site_access/domains/dom_site_access/access",
      headers: mutationHeaders,
      payload: {
        passwordProtectionEnabled: true,
        password: "share-this-preview",
        accessSessionTtlHours: 72,
        seoIndexing: true
      }
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().domain).toMatchObject({
      passwordProtectionEnabled: true,
      passwordConfigured: true,
      accessSessionTtlHours: 72,
      seoIndexing: false
    });
    expect(update.body).not.toContain("share-this-preview");
    expect(update.body).not.toContain(database.getDomain("dom_site_access")?.password_hash ?? "missing");

    const unauthorized = await app.inject({
      method: "GET",
      url: "/api/site-access/authorize?domainId=dom_site_access",
      headers: {
        "x-forwarded-host": "private.example.com",
        // cloudflared connects to Traefik over HTTP even though the visitor
        // origin is always the public HTTPS hostname.
        "x-forwarded-proto": "http",
        "x-forwarded-uri": "/secret?invite=1"
      }
    });
    expect(unauthorized.statusCode).toBe(302);
    expect(unauthorized.headers.location).toBe(
      "https://private.example.com/_shelter/access/dom_site_access?returnPath=%2Fsecret%3Finvite%3D1"
    );

    const wrongHost = await app.inject({
      method: "GET",
      url: "/api/site-access/authorize?domainId=dom_site_access",
      headers: { "x-forwarded-host": "other.example.com" }
    });
    expect(wrongHost.statusCode).toBe(403);

    const page = await app.inject({
      method: "GET",
      url: "/_shelter/access/dom_site_access?returnPath=%2Fsecret",
      headers: { host: "private.example.com", "accept-language": "de-DE" }
    });
    expect(page.statusCode).toBe(200);
    expect(page.headers["x-robots-tag"]).toContain("noindex");
    expect(page.body).toContain("Diese Seite ist geschützt");
    expect(page.body).toContain("Private launch");
    expect(page.body).toContain('src="/_shelter/access/brand.png"');
    expect(page.body).not.toContain('class="frog"');
    expect(page.body).not.toContain("Admin");

    const brand = await app.inject({
      method: "GET",
      url: "/_shelter/access/brand.png",
      headers: { host: "private.example.com" }
    });
    expect(brand.statusCode).toBe(200);
    expect(brand.headers["content-type"]).toContain("image/png");
    expect(brand.rawPayload).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/_shelter/access/dom_site_access",
      headers: {
        host: "private.example.com",
        origin: "https://private.example.com",
        "content-type": "application/x-www-form-urlencoded"
      },
      payload: "password=incorrect&returnPath=%2Fsecret"
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.body).toContain("not correct");

    const accepted = await app.inject({
      method: "POST",
      url: "/_shelter/access/dom_site_access",
      headers: {
        host: "private.example.com",
        origin: "https://private.example.com",
        "content-type": "application/x-www-form-urlencoded"
      },
      payload: "password=share-this-preview&returnPath=%2Fsecret"
    });
    expect(accepted.statusCode).toBe(303);
    expect(accepted.headers.location).toBe("/secret");
    const accessCookie = accepted.cookies.find((cookie) => cookie.name === "shelter_site_access");
    expect(accessCookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/"
    });

    const authorized = await app.inject({
      method: "GET",
      url: "/api/site-access/authorize?domainId=dom_site_access",
      headers: {
        "x-forwarded-host": "private.example.com",
        cookie: `shelter_site_access=${accessCookie?.value ?? ""}`
      }
    });
    expect(authorized.statusCode).toBe(204);

    const revoke = await app.inject({
      method: "POST",
      url: "/api/projects/prj_site_access/domains/dom_site_access/access/revoke",
      headers: mutationHeaders
    });
    expect(revoke.statusCode).toBe(200);
    const revoked = await app.inject({
      method: "GET",
      url: "/api/site-access/authorize?domainId=dom_site_access",
      headers: {
        "x-forwarded-host": "private.example.com",
        cookie: `shelter_site_access=${accessCookie?.value ?? ""}`
      }
    });
    expect(revoked.statusCode).toBe(302);
  });

  it("generates forward-auth protection and strict noindex routing without changing the app", async () => {
    const { app, config, mutationHeaders } = await context();
    const protectedResponse = await app.inject({
      method: "PUT",
      url: "/api/projects/prj_site_access/domains/dom_site_access/access",
      headers: mutationHeaders,
      payload: {
        passwordProtectionEnabled: true,
        password: "share-this-preview",
        accessSessionTtlHours: 168,
        seoIndexing: true
      }
    });
    expect(protectedResponse.statusCode).toBe(200);
    let routing = fs.readFileSync(config.traefikConfigPath, "utf8");
    expect(routing).toContain("forwardAuth:");
    expect(routing).toContain("http://api:7080/api/site-access/authorize?domainId=dom_site_access");
    expect(routing).toContain("PathPrefix(`/_shelter/access`)");
    expect(routing).toContain("X-Robots-Tag: \"noindex, nofollow, noarchive, nosnippet\"");
    expect(routing).toContain("http://shelter-run-private-launch:3000");

    const publicNoIndex = await app.inject({
      method: "PUT",
      url: "/api/projects/prj_site_access/domains/dom_site_access/access",
      headers: mutationHeaders,
      payload: {
        passwordProtectionEnabled: false,
        accessSessionTtlHours: 168,
        seoIndexing: false
      }
    });
    expect(publicNoIndex.statusCode).toBe(200);
    routing = fs.readFileSync(config.traefikConfigPath, "utf8");
    expect(routing).not.toContain("forwardAuth:");
    expect(routing).toContain("X-Robots-Tag: \"noindex, nofollow, noarchive, nosnippet\"");

    const publicIndexable = await app.inject({
      method: "PUT",
      url: "/api/projects/prj_site_access/domains/dom_site_access/access",
      headers: mutationHeaders,
      payload: {
        passwordProtectionEnabled: false,
        accessSessionTtlHours: 168,
        seoIndexing: true
      }
    });
    expect(publicIndexable.statusCode).toBe(200);
    routing = fs.readFileSync(config.traefikConfigPath, "utf8");
    expect(routing).not.toContain("forwardAuth:");
    expect(routing).not.toContain("X-Robots-Tag: \"noindex, nofollow, noarchive, nosnippet\"");
  });

  it("never exposes the password hash through the project API", async () => {
    const { app, mutationHeaders } = await context();
    await app.inject({
      method: "PUT",
      url: "/api/projects/prj_site_access/domains/dom_site_access/access",
      headers: mutationHeaders,
      payload: {
        passwordProtectionEnabled: true,
        password: "share-this-preview",
        accessSessionTtlHours: 168,
        seoIndexing: false
      }
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/projects/prj_site_access",
      headers: { cookie: mutationHeaders.cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().project.domains[0]).toMatchObject({
      passwordProtectionEnabled: true,
      passwordConfigured: true,
      seoIndexing: false
    });
    expect(response.body).not.toContain("scrypt$");
    expect(response.body).not.toContain("share-this-preview");
  });
});
