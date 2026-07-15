import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { UploadService } from "../src/services/uploads.js";
import type { DeploymentRow, ProjectRow } from "../src/types/models.js";

const directories: string[] = [];
const databases: Database[] = [];
const services: UploadService[] = [];

function config(): AppConfig {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-upload-lifecycle-"));
  directories.push(dataDirectory);
  return loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDirectory,
    WEB_DIST: path.join(dataDirectory, "missing-web"),
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "correct horse battery staple",
    APP_SECRET: "l".repeat(64),
    LOG_LEVEL: "silent"
  });
}

function context(): { config: AppConfig; database: Database; service: UploadService } {
  const appConfig = config();
  fs.mkdirSync(appConfig.sourcesDir, { recursive: true });
  const database = new Database(appConfig);
  const service = new UploadService(appConfig, database);
  databases.push(database);
  services.push(service);
  return { config: appConfig, database, service };
}

function seedUpload(
  appConfig: AppConfig,
  database: Database,
  input: {
    id: string;
    status: "pending" | "complete";
    createdAt: string;
  }
): { archivePath: string | null; sourceDirectory: string; chunkDirectory: string } {
  const sourceDirectory = path.join(appConfig.sourcesDir, input.id);
  const chunkDirectory = path.join(appConfig.sourcesDir, ".chunks", input.id);
  const archivePath = input.status === "complete" ? path.join(sourceDirectory, "source.zip") : null;
  if (archivePath) {
    fs.mkdirSync(sourceDirectory, { recursive: true });
    fs.writeFileSync(archivePath, "managed archive");
  } else {
    fs.mkdirSync(chunkDirectory, { recursive: true });
    fs.writeFileSync(path.join(chunkDirectory, "0.part"), "pending chunk");
  }
  database.sqlite.prepare(`
    INSERT INTO uploads (id, filename, expected_size, chunk_size, total_chunks, status, archive_path, created_at)
    VALUES (?, 'source.zip', 15, 10485760, 1, ?, ?, ?)
  `).run(input.id, input.status, archivePath, input.createdAt);
  return { archivePath, sourceDirectory, chunkDirectory };
}

function project(id: string, sourceArchive: string | null): ProjectRow {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    slug: id,
    source_type: sourceArchive ? "upload" : "git",
    repository_url: sourceArchive ? null : "https://github.com/example/example.git",
    repository_branch: sourceArchive ? null : "main",
    source_archive: sourceArchive,
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
}

function deployment(id: string, projectId: string, sourceRef: string): DeploymentRow {
  return {
    id,
    project_id: projectId,
    status: "failed",
    source_ref: sourceRef,
    image_tag: null,
    previous_image_tag: null,
    internal_port: null,
    static_base_path: null,
    runtime_kind: null,
    runtime_description: null,
    commit_sha: null,
    error: "test",
    started_at: null,
    finished_at: new Date().toISOString(),
    created_at: new Date().toISOString()
  };
}

function expectConflict(action: () => unknown, code: string): void {
  try {
    action();
    expect.fail(`Expected ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ statusCode: 409, code });
  }
}

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("upload deletion lifecycle", () => {
  it("deletes an unbound pending upload through the authenticated API and is idempotently not found", async () => {
    const appConfig = config();
    const database = new Database(appConfig);
    const app = await createApp(appConfig, database);
    try {
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
      const initialized = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers,
        payload: { filename: "cancelled.zip", size: 1 }
      });
      const uploadId = initialized.json().id as string;
      const chunkDirectory = path.join(appConfig.sourcesDir, ".chunks", uploadId);
      expect(initialized.statusCode).toBe(201);
      expect(fs.existsSync(chunkDirectory)).toBe(true);

      const deleted = await app.inject({ method: "DELETE", url: `/api/uploads/${uploadId}`, headers });
      expect(deleted.statusCode).toBe(204);
      expect(deleted.body).toBe("");
      expect(database.sqlite.prepare("SELECT 1 FROM uploads WHERE id = ?").get(uploadId)).toBeUndefined();
      expect(fs.existsSync(chunkDirectory)).toBe(false);

      const replayed = await app.inject({ method: "DELETE", url: `/api/uploads/${uploadId}`, headers });
      expect(replayed.statusCode).toBe(404);
      expect(replayed.json().code).toBe("NOT_FOUND");
    } finally {
      await app.close();
    }
  });

  it("preserves uploads referenced by the current project source or deployment history", () => {
    const { config: appConfig, database, service } = context();
    const current = seedUpload(appConfig, database, {
      id: "upl_current_source",
      status: "complete",
      createdAt: new Date().toISOString()
    });
    const historical = seedUpload(appConfig, database, {
      id: "upl_historical_source",
      status: "complete",
      createdAt: new Date().toISOString()
    });
    database.createProject(project("prj_upload_refs", current.archivePath));
    database.createDeployment(deployment("dep_upload_ref", "prj_upload_refs", "upl_historical_source"));

    expectConflict(() => service.remove("upl_current_source"), "UPLOAD_IN_USE");
    expectConflict(() => service.remove("upl_historical_source"), "UPLOAD_IN_USE");
    expect(service.get("upl_current_source")).toBeDefined();
    expect(service.get("upl_historical_source")).toBeDefined();
    expect(fs.existsSync(current.archivePath!)).toBe(true);
    expect(fs.existsSync(historical.archivePath!)).toBe(true);
  });

  it("fails closed for unmanaged archive metadata without touching an external directory", () => {
    const { config: appConfig, database, service } = context();
    const externalDirectory = path.join(appConfig.DATA_DIR, "must-survive");
    const externalArchive = path.join(externalDirectory, "source.zip");
    fs.mkdirSync(externalDirectory, { recursive: true });
    fs.writeFileSync(externalArchive, "external sentinel");
    database.sqlite.prepare(`
      INSERT INTO uploads (id, filename, expected_size, chunk_size, total_chunks, status, archive_path, created_at)
      VALUES ('upl_unmanaged_path', 'source.zip', 17, 10485760, 1, 'complete', ?, ?)
    `).run(externalArchive, new Date().toISOString());

    expectConflict(() => service.remove("upl_unmanaged_path"), "UPLOAD_PATH_INVALID");
    expect(service.get("upl_unmanaged_path")).toBeDefined();
    expect(fs.readFileSync(externalArchive, "utf8")).toBe("external sentinel");
  });

  it("rolls the database deletion back when filesystem cleanup fails", () => {
    const { config: appConfig, database, service } = context();
    const upload = seedUpload(appConfig, database, {
      id: "upl_cleanup_failure",
      status: "complete",
      createdAt: new Date().toISOString()
    });
    const remove = vi.spyOn(fs, "rmSync")
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("simulated filesystem failure");
      });

    expect(() => service.remove("upl_cleanup_failure")).toThrow(/simulated filesystem failure/);
    expect(service.get("upl_cleanup_failure")).toBeDefined();
    expect(fs.existsSync(upload.archivePath!)).toBe(true);
    remove.mockRestore();
    expect(service.remove("upl_cleanup_failure")).toBe(true);
  });

  it("periodically removes expired unbound uploads, recovers stale locks and preserves live or referenced state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T12:00:00.000Z"));
    const { config: appConfig, database, service } = context();
    const oldCreatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const recentCreatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const expiredPending = seedUpload(appConfig, database, {
      id: "upl_expired_pending",
      status: "pending",
      createdAt: oldCreatedAt
    });
    const expiredComplete = seedUpload(appConfig, database, {
      id: "upl_expired_complete",
      status: "complete",
      createdAt: oldCreatedAt
    });
    const recent = seedUpload(appConfig, database, {
      id: "upl_recent_pending",
      status: "pending",
      createdAt: recentCreatedAt
    });
    const liveLocked = seedUpload(appConfig, database, {
      id: "upl_live_lock",
      status: "pending",
      createdAt: oldCreatedAt
    });
    const staleLocked = seedUpload(appConfig, database, {
      id: "upl_stale_lock",
      status: "pending",
      createdAt: oldCreatedAt
    });
    const referenced = seedUpload(appConfig, database, {
      id: "upl_referenced_cleanup",
      status: "complete",
      createdAt: oldCreatedAt
    });
    database.createProject(project("prj_cleanup_reference", referenced.archivePath));

    // Insert locks immediately before the first hourly tick. One is fresh and
    // one is already stale, modelling recovery after an interrupted request.
    vi.advanceTimersByTime(59 * 60 * 1000);
    database.sqlite.prepare("INSERT INTO upload_locks (upload_id, started_at) VALUES (?, ?)")
      .run("upl_live_lock", new Date().toISOString());
    database.sqlite.prepare("INSERT INTO upload_locks (upload_id, started_at) VALUES (?, ?)")
      .run("upl_stale_lock", new Date(Date.now() - 31 * 60 * 1000).toISOString());
    expectConflict(() => service.remove("upl_live_lock"), "UPLOAD_MUTATION_ACTIVE");
    vi.advanceTimersByTime(60 * 1000);

    expect(service.get("upl_expired_pending")).toBeUndefined();
    expect(service.get("upl_expired_complete")).toBeUndefined();
    expect(service.get("upl_stale_lock")).toBeUndefined();
    expect(fs.existsSync(expiredPending.chunkDirectory)).toBe(false);
    expect(fs.existsSync(expiredComplete.sourceDirectory)).toBe(false);
    expect(fs.existsSync(staleLocked.chunkDirectory)).toBe(false);

    expect(service.get("upl_recent_pending")).toBeDefined();
    expect(service.get("upl_live_lock")).toBeDefined();
    expect(service.get("upl_referenced_cleanup")).toBeDefined();
    expect(fs.existsSync(recent.chunkDirectory)).toBe(true);
    expect(fs.existsSync(liveLocked.chunkDirectory)).toBe(true);
    expect(fs.existsSync(referenced.archivePath!)).toBe(true);
    expect(database.sqlite.prepare("SELECT 1 FROM upload_locks WHERE upload_id = ?").get("upl_live_lock")).toBeDefined();
    expect(database.sqlite.prepare("SELECT 1 FROM upload_locks WHERE upload_id = ?").get("upl_stale_lock")).toBeUndefined();

    service.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
