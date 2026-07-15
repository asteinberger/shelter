import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { GitHubService } from "../src/services/github.js";
import type { DeploymentRow, ProjectRow } from "../src/types/models.js";

const directories: string[] = [];

function databaseContext(): { database: Database; directory: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-github-mutation-"));
  directories.push(directory);
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: directory,
    WEB_DIST: path.join(directory, "missing-web"),
    APP_SECRET: "m".repeat(64)
  });
  return { database: new Database(config), directory };
}

function project(overrides: Partial<ProjectRow> = {}): ProjectRow {
  const now = new Date().toISOString();
  return {
    id: "prj_atomic_github",
    name: "Atomic GitHub",
    slug: "atomic-github",
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
    id: "dep_atomic",
    project_id: "prj_atomic_github",
    status: "queued",
    source_ref: "main",
    image_tag: null,
    previous_image_tag: null,
    internal_port: null,
    static_base_path: null,
    runtime_kind: null,
    runtime_description: null,
    commit_sha: null,
    commit_message: null,
    commit_author: null,
    commit_url: null,
    trigger: "manual",
    github_delivery_id: null,
    error: null,
    started_at: null,
    finished_at: null,
    created_at: new Date().toISOString(),
    ...overrides
  };
}

function addPendingPush(database: Database, projectId = "prj_atomic_github"): void {
  database.sqlite.prepare(`
    INSERT INTO github_pending_pushes (
      project_id, delivery_id, installation_id, repository_id, repository_full_name,
      branch, commit_sha, commit_message, commit_author, commit_url, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId,
    "delivery-pending",
    "123",
    "99",
    "example/private",
    "main",
    "a".repeat(40),
    "Pending commit",
    "Example",
    `https://github.com/example/private/commit/${"a".repeat(40)}`,
    new Date().toISOString()
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("atomic GitHub project configuration", () => {
  it("rejects an idle configuration update when a deployment is already active", () => {
    const { database } = databaseContext();
    const original = project();
    database.createProject(original);
    database.createDeployment(deployment());

    const result = database.updateProjectIfIdle(original.id, original.updated_at, {
      repository_branch: "production"
    });

    expect(result).toEqual({ kind: "deployment_active" });
    expect(database.getProject(original.id)?.repository_branch).toBe("main");
    database.close();
  });

  it("uses updated_at as an optimistic guard and only removes pending pushes after a successful unlink", () => {
    const { database } = databaseContext();
    const original = project();
    database.createProject(original);
    addPendingPush(database);
    const changedAt = new Date(Date.parse(original.updated_at) + 1_000).toISOString();
    database.sqlite.prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?")
      .run("Changed concurrently", changedAt, original.id);

    const stale = database.updateProjectIfIdle(original.id, original.updated_at, {
      github_repository_id: null,
      github_repository_full_name: null,
      github_installation_id: null,
      github_connection_error: null,
      auto_deploy: 0
    }, { clearPendingGithubPush: true });

    expect(stale).toEqual({ kind: "conflict" });
    expect(database.getProject(original.id)?.github_repository_id).toBe("99");
    expect(database.getPendingGithubPush(original.id)).toBeDefined();

    const unlinked = database.updateProjectIfIdle(original.id, changedAt, {
      github_repository_id: null,
      github_repository_full_name: null,
      github_installation_id: null,
      github_connection_error: null,
      auto_deploy: 0
    }, { clearPendingGithubPush: true });

    expect(unlinked.kind).toBe("updated");
    expect(database.getProject(original.id)).toMatchObject({
      github_repository_id: null,
      github_repository_full_name: null,
      github_installation_id: null,
      auto_deploy: 0
    });
    expect(database.getPendingGithubPush(original.id)).toBeUndefined();
    database.close();
  });

  it("prevents a deployment created from a stale project snapshot from crossing a configuration update", () => {
    const { database } = databaseContext();
    const original = project();
    database.createProject(original);

    const updated = database.updateProjectIfIdle(original.id, original.updated_at, {
      repository_branch: "production"
    });
    expect(updated.kind).toBe("updated");
    expect(database.createDeploymentForMutableProject(deployment(), original.updated_at)).toBe(false);
    expect(database.listDeployments(original.id)).toEqual([]);

    const current = database.getProject(original.id)!;
    expect(database.createDeploymentForMutableProject(deployment({ id: "dep_current" }), current.updated_at)).toBe(true);
    expect(database.updateProjectIfIdle(current.id, current.updated_at, { auto_deploy: 0 }))
      .toEqual({ kind: "deployment_active" });
    database.close();
  });

  it("returns precise conflicts when the project or deployment state changes during GitHub resolution", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-github-route-race-"));
    directories.push(directory);
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: directory,
      WEB_DIST: path.join(directory, "missing-web"),
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: "correct horse battery staple",
      APP_SECRET: "r".repeat(64)
    });
    const database = new Database(config);
    const app = await createApp(config, database);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });
    const cookie = login.cookies.find((entry) => entry.name === "shelter_session")?.value ?? "";
    const headers = {
      cookie: `portsmith_session=${cookie}`,
      "x-csrf-token": login.json().csrfToken as string,
      origin: "http://localhost:7080",
      host: "localhost:7080"
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/git",
      headers,
      payload: { name: "Link Race", repositoryUrl: "https://github.com/example/public.git" }
    });
    const projectId = created.json().project.id as string;
    database.sqlite.prepare("UPDATE deployments SET status = 'failed', finished_at = ? WHERE project_id = ?")
      .run(new Date().toISOString(), projectId);

    const resolveRepository = vi.spyOn(GitHubService.prototype, "resolveRepository").mockImplementation(async () => {
      const current = database.getProject(projectId)!;
      database.sqlite.prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?")
        .run("Changed during GitHub request", new Date(Date.parse(current.updated_at) + 1_000).toISOString(), projectId);
      return {
        repository: {
          id: "99",
          installationId: "123",
          name: "private",
          fullName: "example/private",
          private: true,
          defaultBranch: "main",
          htmlUrl: "https://github.com/example/private",
          cloneUrl: "https://github.com/example/private.git",
          owner: "example",
          ownerLogin: "example"
        },
        branch: { name: "main", protected: false, sha: "b".repeat(40), commitSha: "b".repeat(40) }
      };
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/github`,
      headers,
      payload: { installationId: "123", repositoryId: "99", branch: "main", autoDeploy: true }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PROJECT_MUTATION_CONFLICT");
    expect(database.getProject(projectId)).toMatchObject({
      name: "Changed during GitHub request",
      github_repository_id: null
    });

    resolveRepository.mockImplementation(async () => {
      database.createDeployment(deployment({
        id: "dep_started_during_resolve",
        project_id: projectId
      }));
      return {
        repository: {
          id: "99",
          installationId: "123",
          name: "private",
          fullName: "example/private",
          private: true,
          defaultBranch: "main",
          htmlUrl: "https://github.com/example/private",
          cloneUrl: "https://github.com/example/private.git",
          owner: "example",
          ownerLogin: "example"
        },
        branch: { name: "main", protected: false, sha: "c".repeat(40), commitSha: "c".repeat(40) }
      };
    });

    const activeDeployment = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/github`,
      headers,
      payload: { installationId: "123", repositoryId: "99", branch: "main", autoDeploy: true }
    });

    expect(activeDeployment.statusCode).toBe(409);
    expect(activeDeployment.json().code).toBe("DEPLOYMENT_ACTIVE");
    expect(database.getProject(projectId)?.github_repository_id).toBeNull();
    await app.close();
  });

  it("queues a fresh manual branch redeploy while GitHub auto-deploy is disabled", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-manual-redeploy-"));
    directories.push(directory);
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: directory,
      WEB_DIST: path.join(directory, "missing-web"),
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: "correct horse battery staple",
      APP_SECRET: "f".repeat(64),
      LOG_LEVEL: "silent"
    });
    const database = new Database(config);
    const app = await createApp(config, database);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });
    const cookie = login.cookies.find((entry) => entry.name === "shelter_session")?.value ?? "";
    const headers = {
      cookie: `portsmith_session=${cookie}`,
      "x-csrf-token": login.json().csrfToken as string,
      origin: "http://localhost:7080",
      host: "localhost:7080"
    };
    const gitProject = project({
      repository_branch: "release/production",
      auto_deploy: 0
    });
    database.createProject(gitProject);
    database.createDeployment(deployment({
      id: "dep_previous_push",
      status: "ready",
      source_ref: "release/production",
      image_tag: "portsmith/atomic-github:previous",
      internal_port: 3000,
      commit_sha: "d".repeat(40),
      trigger: "github_push",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString()
    }));

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${gitProject.id}/deploy`,
      headers,
      payload: {}
    });

    expect(response.statusCode).toBe(202);
    const queued = database.getDeployment(response.json().deployment.id as string);
    expect(queued).toMatchObject({
      project_id: gitProject.id,
      status: "queued",
      source_ref: "release/production",
      commit_sha: null,
      trigger: "manual"
    });
    expect(database.getProject(gitProject.id)?.auto_deploy).toBe(0);
    await app.close();
  });
});
