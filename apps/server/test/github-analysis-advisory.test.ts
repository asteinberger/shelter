import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { GitHubService } from "../src/services/github.js";
import type { ProjectRow } from "../src/types/models.js";

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("advisory GitHub source analysis", () => {
  it("does not block GitHub project creation or linking when analysis is unavailable", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-github-analysis-advisory-"));
    directories.push(directory);
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: directory,
      WEB_DIST: path.join(directory, "missing-web"),
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: "correct horse battery staple",
      APP_SECRET: "h".repeat(64)
    });
    const database = new Database(config);
    vi.spyOn(GitHubService.prototype, "resolveRepository").mockResolvedValue({
      repository: {
        id: "99",
        installationId: "123",
        name: "site",
        fullName: "example/site",
        private: true,
        defaultBranch: "main",
        htmlUrl: "https://github.com/example/site",
        cloneUrl: "https://github.com/example/site.git",
        owner: "example",
        ownerLogin: "example"
      },
      branch: { name: "main", protected: false, sha: "a".repeat(40), commitSha: "a".repeat(40) }
    });
    vi.spyOn(GitHubService.prototype, "analyzeRepository").mockRejectedValue(new Error("temporary GitHub tree failure"));
    const app = await createApp(config, database);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });
    const cookie = login.cookies.find((candidate) => candidate.name === "shelter_session")!;
    const headers = {
      cookie: `shelter_session=${cookie.value}`,
      "x-csrf-token": login.json().csrfToken as string,
      origin: "http://localhost:7080",
      host: "localhost:7080"
    };

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/github",
      headers,
      payload: {
        name: "GitHub Site",
        installationId: "123",
        repositoryId: "99",
        branch: "main",
        autoDeploy: true
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().project.sourceAnalysis).toBeNull();

    const now = new Date().toISOString();
    const existing: ProjectRow = {
      id: "prj_existing_git",
      name: "Existing Git",
      slug: "existing-git",
      source_type: "git",
      repository_url: "https://github.com/example/old.git",
      repository_branch: "main",
      source_archive: null,
      source_analysis_json: JSON.stringify({ fingerprint: "old", applications: [], recommendedApplicationId: null }),
      static_base_path: null,
      root_directory: ".",
      build_type: "auto",
      dockerfile_path: "Dockerfile",
      port: 3000,
      healthcheck_path: "/",
      memory_limit: "1g",
      cpu_limit: "1.0",
      active_deployment_id: null,
      created_at: now,
      updated_at: now
    };
    database.createProject(existing);
    const linked = await app.inject({
      method: "PUT",
      url: `/api/projects/${existing.id}/github`,
      headers,
      payload: { installationId: "123", repositoryId: "99", branch: "main", autoDeploy: false }
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().project.sourceAnalysis).toBeNull();
    await app.close();
  });
});
