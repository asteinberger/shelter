import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import {
  findContentRoot,
  healthcheckPathFor,
  refreshProjectSourceAnalysis,
  resolveUploadArchiveForDeployment
} from "../src/services/worker.js";
import type { ProjectRow } from "../src/types/models.js";

const temporaryDirectories: string[] = [];
const databases: Database[] = [];

function context(): { config: AppConfig; database: Database } {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-worker-source-"));
  temporaryDirectories.push(dataDirectory);
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDirectory,
    WEB_DIST: path.join(dataDirectory, "missing-web"),
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "correct horse battery staple",
    APP_SECRET: "w".repeat(64),
    LOG_LEVEL: "silent"
  });
  fs.mkdirSync(config.sourcesDir, { recursive: true });
  const database = new Database(config);
  databases.push(database);
  return { config, database };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("upload deployment source snapshots", () => {
  it("uses the neutral root healthcheck for file storage deployments", () => {
    expect(healthcheckPathFor(
      { healthcheck_path: "/custom-health" },
      { runtime_kind: "files" }
    )).toBe("/");
    expect(healthcheckPathFor(
      { healthcheck_path: "/custom-health" },
      { runtime_kind: "static" }
    )).toBe("/custom-health");
  });

  it("unwraps a single selected folder while ignoring root operating-system metadata", () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-content-root-"));
    temporaryDirectories.push(sourceRoot);
    const wrapper = path.join(sourceRoot, "my-images");
    fs.mkdirSync(wrapper);
    fs.mkdirSync(path.join(sourceRoot, "__MACOSX"));
    fs.writeFileSync(path.join(sourceRoot, ".DS_Store"), "metadata");
    fs.writeFileSync(path.join(sourceRoot, "Thumbs.db"), "metadata");
    fs.writeFileSync(path.join(wrapper, "frog.jpg"), "image");

    expect(findContentRoot(sourceRoot)).toBe(wrapper);
  });

  it("resolves manual roots against raw or wrapper-relative ZIP layouts without changing their meaning", () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-content-root-aware-"));
    temporaryDirectories.push(sourceRoot);
    const wrapper = path.join(sourceRoot, "repository-main");
    fs.mkdirSync(path.join(wrapper, "apps", "web"), { recursive: true });

    expect(findContentRoot(sourceRoot, "apps/web")).toBe(wrapper);
    expect(findContentRoot(sourceRoot, "repository-main/apps/web")).toBe(sourceRoot);

    fs.mkdirSync(path.join(sourceRoot, "apps", "web"), { recursive: true });
    // Ambiguous layouts preserve the explicit raw archive interpretation.
    expect(findContentRoot(sourceRoot, "apps/web")).toBe(sourceRoot);
  });

  it("fails closed when a referenced upload row is missing instead of using the mutable project archive", () => {
    const { config, database } = context();
    expect(() => resolveUploadArchiveForDeployment(
      config,
      database,
      { source_archive: path.join(config.sourcesDir, "newer", "source.zip") },
      { source_ref: "upl_missing" }
    )).toThrow(/upl_missing.*nicht mehr als vollständiger Upload/);
  });

  it("rejects an inconsistent archive path for a referenced complete upload", () => {
    const { config, database } = context();
    database.sqlite.prepare(`
      INSERT INTO uploads (id, filename, expected_size, chunk_size, total_chunks, status, archive_path, created_at)
      VALUES (?, ?, ?, ?, ?, 'complete', ?, ?)
    `).run("upl_inconsistent", "source.zip", 1, 1, 1, path.join(config.DATA_DIR, "outside.zip"), new Date().toISOString());

    expect(() => resolveUploadArchiveForDeployment(
      config,
      database,
      { source_archive: path.join(config.sourcesDir, "newer", "source.zip") },
      { source_ref: "upl_inconsistent" }
    )).toThrow(/nicht verwaltetes Quellarchiv/);
  });

  it("uses the exact managed archive and reserves project fallback for legacy deployments", () => {
    const { config, database } = context();
    const managedArchive = path.join(config.sourcesDir, "upl_exact", "source.zip");
    database.sqlite.prepare(`
      INSERT INTO uploads (id, filename, expected_size, chunk_size, total_chunks, status, archive_path, created_at)
      VALUES (?, ?, ?, ?, ?, 'complete', ?, ?)
    `).run("upl_exact", "source.zip", 1, 1, 1, managedArchive, new Date().toISOString());

    expect(resolveUploadArchiveForDeployment(
      config,
      database,
      { source_archive: path.join(config.sourcesDir, "newer", "source.zip") },
      { source_ref: "upl_exact" }
    )).toBe(managedArchive);

    const legacyArchive = path.join(config.sourcesDir, "legacy", "source.zip");
    expect(resolveUploadArchiveForDeployment(
      config,
      database,
      { source_archive: legacyArchive },
      { source_ref: null }
    )).toBe(legacyArchive);
  });

  it("revalidates extracted source without racing a project deletion", () => {
    const { database } = context();
    const now = new Date().toISOString();
    const project: ProjectRow = {
      id: "prj_analysis",
      name: "Analysis",
      slug: "analysis",
      source_type: "upload",
      repository_url: null,
      repository_branch: null,
      source_archive: "/tmp/source.zip",
      source_analysis_json: null,
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
    database.createProject(project);
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-worker-analysis-"));
    temporaryDirectories.push(source);
    fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({
      scripts: { build: "vite build" },
      devDependencies: { vite: "7.0.0" }
    }));
    const first = refreshProjectSourceAnalysis(database, project.id, source);
    expect(first?.applications[0]?.framework).toBe("vite");
    const stored = database.getProject(project.id)?.source_analysis_json;
    expect(stored).toContain('"framework":"vite"');

    database.sqlite.prepare(`
      INSERT INTO project_deletions (project_id, status, error, requested_at, updated_at)
      VALUES (?, 'queued', NULL, ?, ?)
    `).run(project.id, now, now);
    fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ scripts: { start: "node server.js" } }));
    expect(refreshProjectSourceAnalysis(database, project.id, source)).toBeNull();
    expect(database.getProjectForDeletion(project.id)?.source_analysis_json).toBe(stored);
  });
});
