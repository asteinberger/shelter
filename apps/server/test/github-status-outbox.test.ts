import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type AppConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { encryptString } from "../src/lib/security.js";
import { GitHubService } from "../src/services/github.js";
import type { DeploymentRow, ProjectRow } from "../src/types/models.js";

const directories: string[] = [];
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem"
}).toString();

function context(): { config: AppConfig; database: Database } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-github-status-"));
  directories.push(directory);
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: directory,
    APP_SECRET: "s".repeat(64)
  });
  const database = new Database(config);
  database.setSetting("cloudflare.panel_domain", "hosting.example.com");
  database.setSetting("github.app_metadata", JSON.stringify({
    version: 1,
    appId: "42",
    appName: "Portsmith Test",
    appSlug: "portsmith-test",
    appUrl: "https://github.com/apps/portsmith-test",
    createdAt: new Date().toISOString()
  }));
  database.setSetting(
    "github.private_key",
    encryptString(`github.private_key:v1\0${privateKey}`, config.APP_SECRET)
  );
  database.setSetting(
    "github.webhook_secret",
    encryptString("github.webhook_secret:v1\0status-test-secret", config.APP_SECRET)
  );
  return { config, database };
}

function project(overrides: Partial<ProjectRow> = {}): ProjectRow {
  const now = new Date().toISOString();
  return {
    id: "prj_status",
    name: "Status Snapshot",
    slug: "status-snapshot",
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
    id: "dep_status",
    project_id: "prj_status",
    status: "building",
    source_ref: "main",
    image_tag: null,
    previous_image_tag: null,
    internal_port: null,
    static_base_path: null,
    runtime_kind: null,
    runtime_description: null,
    commit_sha: "a".repeat(40),
    commit_message: "Immutable target",
    commit_author: "Ada",
    commit_url: `https://github.com/example/private/commit/${"a".repeat(40)}`,
    trigger: "github_push",
    github_delivery_id: "delivery-status",
    error: null,
    started_at: new Date().toISOString(),
    finished_at: null,
    created_at: new Date().toISOString(),
    ...overrides
  };
}

function githubFetcher(calls: string[]): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/app/installations/123/access_tokens")) {
      return new Response(JSON.stringify({
        token: "ghs_status_snapshot_token_1234567890",
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString()
      }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/statuses/")) {
      return new Response(JSON.stringify({ id: 1 }), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected GitHub request: ${url}`);
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("immutable GitHub commit status targets", () => {
  it("keeps the original repository target across re-link and restart reconciliation", async () => {
    const calls: string[] = [];
    const { config, database } = context();
    database.createProject(project());
    database.createDeployment(deployment());
    expect(database.queueGithubStatus("dep_status", "pending", "Build läuft")).toBe(true);
    expect(database.sqlite.prepare(`
      SELECT installation_id, repository_id, repository_full_name, commit_sha
      FROM github_status_outbox WHERE deployment_id = ?
    `).get("dep_status")).toEqual({
      installation_id: "123",
      repository_id: "99",
      repository_full_name: "example/private",
      commit_sha: "a".repeat(40)
    });

    database.updateProject("prj_status", {
      github_installation_id: "456",
      github_repository_id: "777",
      github_repository_full_name: "new-owner/new-repository",
      repository_url: "https://github.com/new-owner/new-repository.git"
    });
    database.updateDeployment("dep_status", {
      status: "ready",
      finished_at: new Date().toISOString()
    });
    database.close();

    const reopened = new Database(config);
    expect(reopened.reconcileGithubStatusOutbox()).toBe(1);
    expect(reopened.sqlite.prepare(`
      SELECT installation_id, repository_id, repository_full_name, commit_sha, desired_state
      FROM github_status_outbox WHERE deployment_id = ?
    `).get("dep_status")).toEqual({
      installation_id: "123",
      repository_id: "99",
      repository_full_name: "example/private",
      commit_sha: "a".repeat(40),
      desired_state: "success"
    });

    const github = new GitHubService(config, reopened, githubFetcher(calls));
    expect(await github.processNextCommitStatus("dep_status")).toBe(true);
    expect(calls.some((url) => url.endsWith("/app/installations/123/access_tokens"))).toBe(true);
    expect(calls.some((url) => url.includes(`/repos/example/private/statuses/${"a".repeat(40)}`))).toBe(true);
    expect(calls.every((url) => !url.includes("new-owner/new-repository"))).toBe(true);
    reopened.close();
  });

  it("can finish an already snapshotted status after a normal project unlink", async () => {
    const calls: string[] = [];
    const { config, database } = context();
    const current = project();
    database.createProject(current);
    database.createDeployment(deployment({ status: "ready", finished_at: new Date().toISOString() }));
    expect(database.queueGithubStatus("dep_status", "pending", "Build läuft")).toBe(true);

    expect(database.updateProjectIfIdle(current.id, current.updated_at, {
      github_installation_id: null,
      github_repository_id: null,
      github_repository_full_name: null,
      github_connection_error: null,
      auto_deploy: 0
    }, { clearPendingGithubPush: true }).kind).toBe("updated");
    expect(database.reconcileGithubStatusOutbox()).toBe(1);
    expect(database.sqlite.prepare(`
      SELECT desired_state, repository_full_name FROM github_status_outbox WHERE deployment_id = ?
    `).get("dep_status")).toEqual({
      desired_state: "success",
      repository_full_name: "example/private"
    });

    const github = new GitHubService(config, database, githubFetcher(calls));
    expect(await github.processNextCommitStatus("dep_status")).toBe(true);
    expect(calls.some((url) => url.includes("/repos/example/private/statuses/"))).toBe(true);
    expect(database.listDueGithubStatuses(1, "dep_status")).toEqual([]);
    database.close();
  });

  it("recovers only post-migration missing snapshots and drops unsafe legacy outbox rows", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-github-status-migration-"));
    directories.push(directory);
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: directory,
      APP_SECRET: "l".repeat(64)
    });
    const legacy = new BetterSqlite3(config.databasePath);
    legacy.exec(`
      CREATE TABLE github_status_outbox (
        deployment_id TEXT PRIMARY KEY,
        desired_state TEXT NOT NULL,
        description TEXT NOT NULL,
        delivered_state TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO github_status_outbox (
        deployment_id, desired_state, description, delivered_state,
        attempts, next_attempt_at, last_error, updated_at
      ) VALUES (
        'dep_legacy', 'pending', 'Legacy', NULL, 0,
        '1970-01-01T00:00:00.000Z', NULL, '1970-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const database = new Database(config);
    expect(database.sqlite.prepare("SELECT * FROM github_status_outbox").all()).toEqual([]);
    const cutoff = database.getSetting("github.status_snapshot_since")!;
    database.createProject(project());
    database.createDeployment(deployment({
      id: "dep_before_cutoff",
      github_delivery_id: "delivery-before-cutoff",
      created_at: new Date(Date.parse(cutoff) - 1_000).toISOString()
    }));
    database.createDeployment(deployment({
      id: "dep_after_cutoff",
      github_delivery_id: "delivery-after-cutoff",
      status: "ready",
      finished_at: new Date().toISOString(),
      created_at: new Date(Date.parse(cutoff) + 1_000).toISOString()
    }));

    expect(database.reconcileGithubStatusOutbox()).toBe(1);
    expect(database.sqlite.prepare("SELECT deployment_id FROM github_status_outbox ORDER BY deployment_id").all())
      .toEqual([{ deployment_id: "dep_after_cutoff" }]);
    database.close();
  });

  it("discards pending statuses when the complete GitHub App connection is removed", async () => {
    const { config, database } = context();
    database.createProject(project());
    database.createDeployment(deployment({ status: "ready", finished_at: new Date().toISOString() }));
    database.queueGithubStatus("dep_status", "success", "Deployment ist bereit");
    const github = new GitHubService(config, database, githubFetcher([]));

    await github.disconnect();

    expect(database.sqlite.prepare("SELECT * FROM github_status_outbox").all()).toEqual([]);
    expect(database.reconcileGithubStatusOutbox()).toBe(0);
    expect(await github.processNextCommitStatus()).toBe(false);
    database.close();
  });
});
