import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("static base path migration", () => {
  it("keeps existing projects and deployments in automatic mode", () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-static-base-migration-"));
    temporaryDirectories.push(dataDirectory);
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: dataDirectory,
      WEB_DIST: path.join(dataDirectory, "missing-web"),
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: "correct horse battery staple",
      APP_SECRET: "m".repeat(64),
      LOG_LEVEL: "silent"
    });

    const legacy = new BetterSqlite3(config.databasePath);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
        source_type TEXT NOT NULL, repository_url TEXT, repository_branch TEXT, source_archive TEXT,
        root_directory TEXT NOT NULL, build_type TEXT NOT NULL, dockerfile_path TEXT NOT NULL,
        port INTEGER NOT NULL, healthcheck_path TEXT NOT NULL, memory_limit TEXT NOT NULL,
        cpu_limit TEXT NOT NULL, active_deployment_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE deployments (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, source_ref TEXT,
        image_tag TEXT, previous_image_tag TEXT, internal_port INTEGER, runtime_kind TEXT,
        runtime_description TEXT, commit_sha TEXT, error TEXT, started_at TEXT, finished_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    legacy.prepare(`
      INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "prj_legacy", "Legacy", "legacy", "upload", null, null, "/tmp/source.zip", ".", "auto",
      "Dockerfile", 3000, "/", "1g", "1.0", null, now, now
    );
    legacy.prepare(`
      INSERT INTO deployments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("dep_legacy", "prj_legacy", "ready", "upl_legacy", null, null, 8080, "static", "Statische Website", null, null, now, now, now);
    legacy.close();

    const database = new Database(config);
    expect(database.getProject("prj_legacy")?.static_base_path).toBeNull();
    expect(database.getDeployment("dep_legacy")?.static_base_path).toBeNull();
    expect((database.sqlite.pragma("table_info(projects)") as Array<{ name: string }>).some((column) => column.name === "static_base_path")).toBe(true);
    expect((database.sqlite.pragma("table_info(deployments)") as Array<{ name: string }>).some((column) => column.name === "static_base_path")).toBe(true);
    database.close();
  });
});
