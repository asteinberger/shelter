import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { conflict } from "../src/lib/errors.js";
import {
  ProjectDeletionService,
  ProjectDeletionWorker,
  type ProjectDeletionCommandRunner
} from "../src/services/project-deletion.js";
import { CloudflareService } from "../src/services/cloudflare.js";
import type { DeploymentRow, ProjectRow } from "../src/types/models.js";

const directories: string[] = [];
const databases: Database[] = [];

function context(): { config: AppConfig; database: Database } {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-delete-"));
  directories.push(dataDirectory);
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDirectory,
    WEB_DIST: path.join(dataDirectory, "missing-web"),
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "correct horse battery staple",
    APP_SECRET: "d".repeat(64),
    LOG_LEVEL: "silent"
  });
  fs.mkdirSync(config.sourcesDir, { recursive: true });
  fs.mkdirSync(config.workspacesDir, { recursive: true });
  const database = new Database(config);
  databases.push(database);
  return { config, database };
}

function project(id: string, name: string, overrides: Partial<ProjectRow> = {}): ProjectRow {
  const now = new Date().toISOString();
  return {
    id,
    name,
    slug: name.toLowerCase().replaceAll(" ", "-"),
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
    active_deployment_id: null,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

function deployment(
  id: string,
  projectId: string,
  status: DeploymentRow["status"],
  overrides: Partial<DeploymentRow> = {}
): DeploymentRow {
  return {
    id,
    project_id: projectId,
    status,
    source_ref: "main",
    image_tag: null,
    previous_image_tag: null,
    internal_port: null,
    static_base_path: null,
    runtime_kind: null,
    runtime_description: null,
    commit_sha: null,
    error: null,
    started_at: null,
    finished_at: null,
    created_at: new Date().toISOString(),
    ...overrides
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) {
    if (database.sqlite.open) database.close();
  }
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("project deletion API", () => {
  it("requires the exact project name, cancels a queued deployment and is idempotent while queued", async () => {
    const { config, database } = context();
    const app = await createApp(config, database);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });
    const sessionCookie = login.cookies.find((entry) => entry.name === "shelter_session")?.value ?? "";
    const csrfToken = login.json().csrfToken as string;
    const mutationHeaders = {
      cookie: `portsmith_session=${sessionCookie}`,
      "x-csrf-token": csrfToken,
      origin: "http://localhost:7080",
      host: "localhost:7080"
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/git",
      headers: mutationHeaders,
      payload: { name: "Delete Me", repositoryUrl: "https://github.com/example/example.git" }
    });
    const projectId = created.json().project.id as string;
    const deploymentId = created.json().deployment.id as string;

    const anonymous = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}`,
      payload: { confirmation: "Delete Me" }
    });
    expect(anonymous.statusCode).toBe(401);

    const mismatch = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}`,
      headers: mutationHeaders,
      payload: { confirmation: "delete me" }
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().code).toBe("PROJECT_CONFIRMATION_MISMATCH");
    expect(database.getProjectDeletion(projectId)).toBeUndefined();

    const accepted = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}`,
      headers: mutationHeaders,
      payload: { confirmation: "Delete Me" }
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ ok: true, status: "queued" });
    expect(database.getDeployment(deploymentId)).toMatchObject({ status: "cancelled" });
    expect(database.getProject(projectId)).toBeUndefined();

    const repeated = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}`,
      headers: mutationHeaders,
      payload: { confirmation: "Delete Me" }
    });
    expect(repeated.statusCode).toBe(202);
    expect(repeated.json()).toEqual({ ok: true, status: "queued" });

    const detail = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}`,
      headers: { cookie: `portsmith_session=${sessionCookie}` }
    });
    expect(detail.statusCode).toBe(404);
    await app.close();
  });

  it("rejects a running deployment without creating a deletion job", async () => {
    const { config, database } = context();
    const row = project("prj_running", "Running App");
    database.createProject(row);
    database.createDeployment(deployment("dep_running", row.id, "building"));
    const cloudflare = { deleteDnsRecord: vi.fn(async () => undefined) };
    const service = new ProjectDeletionService(config, database, cloudflare);

    await expect(service.request(row.id, row.name)).rejects.toMatchObject({
      statusCode: 409,
      code: "DEPLOYMENT_ACTIVE"
    });
    expect(database.getProjectDeletion(row.id)).toBeUndefined();
    expect(database.getProject(row.id)).toMatchObject(row);
    expect(cloudflare.deleteDnsRecord).not.toHaveBeenCalled();
  });

  it("keeps a failed DNS cleanup visible and retries it safely", async () => {
    const { config, database } = context();
    const row = project("prj_retry", "Retry App", { active_deployment_id: "dep_ready_retry" });
    database.createProject(row);
    database.createDeployment(deployment("dep_ready_retry", row.id, "ready", {
      image_tag: "portsmith/retry-app:ready",
      internal_port: 3000,
      finished_at: new Date().toISOString()
    }));
    database.createDomain({
      id: "dom_retry",
      project_id: row.id,
      hostname: "retry.example.com",
      zone_id: "zone-owned",
      dns_record_id: "record-owned",
      status: "active",
      error: null,
      created_at: new Date().toISOString()
    });
    const app = await createApp(config, database);
    const deleteDnsRecord = vi.fn()
      .mockRejectedValueOnce(conflict("DNS record drifted", "DNS_RECORD_DRIFT"))
      .mockResolvedValueOnce(undefined);
    const service = new ProjectDeletionService(config, database, { deleteDnsRecord });

    await expect(service.request(row.id, row.name)).rejects.toMatchObject({ code: "DNS_RECORD_DRIFT" });
    expect(database.getProjectDeletion(row.id)).toMatchObject({ status: "failed" });
    expect(database.getProject(row.id)?.id).toBe(row.id);
    expect(database.getDomain("dom_retry")?.id).toBe("dom_retry");
    expect(fs.readFileSync(config.traefikConfigPath, "utf8")).not.toContain("retry.example.com");
    expect(deleteDnsRecord).toHaveBeenLastCalledWith("zone-owned", "record-owned", "retry.example.com");

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });
    const cookie = `portsmith_session=${login.cookies.find((entry) => entry.name === "shelter_session")?.value ?? ""}`;
    const headers = {
      cookie,
      "x-csrf-token": login.json().csrfToken as string,
      origin: "http://localhost:7080",
      host: "localhost:7080"
    };
    const detail = await app.inject({ method: "GET", url: `/api/projects/${row.id}`, headers: { cookie } });
    expect(detail.json().project).toMatchObject({
      status: "deletion_failed",
      deletionStatus: "failed",
      deletionError: "DNS record drifted"
    });
    const quarantinedMutations = await Promise.all([
      app.inject({ method: "PATCH", url: `/api/projects/${row.id}`, headers, payload: { name: "Changed" } }),
      app.inject({ method: "POST", url: `/api/projects/${row.id}/deploy`, headers }),
      app.inject({ method: "POST", url: `/api/projects/${row.id}/rollback`, headers, payload: { deploymentId: "dep_ready_retry" } }),
      app.inject({ method: "PUT", url: `/api/projects/${row.id}/environment`, headers, payload: { variables: [] } }),
      app.inject({ method: "POST", url: `/api/projects/${row.id}/domains`, headers, payload: { hostname: "other.example.com" } }),
      app.inject({ method: "DELETE", url: `/api/projects/${row.id}/domains/dom_retry`, headers })
    ]);
    expect(quarantinedMutations.every((response) => (
      response.statusCode === 409 && response.json().code === "PROJECT_DELETION_FAILED"
    ))).toBe(true);

    await expect(service.request(row.id, row.name)).resolves.toEqual({ status: "queued" });
    expect(database.getProjectDeletion(row.id)).toMatchObject({ status: "queued", error: null });
    expect(database.getProject(row.id)).toBeUndefined();
    expect(database.getDomain("dom_retry")).toBeUndefined();
    expect(deleteDnsRecord).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("compensates a created Cloudflare record when local activation loses to a deletion state change", async () => {
    const { config, database } = context();
    const row = project("prj_domain_race", "Domain Race");
    database.createProject(row);

    const providerRecords = new Set<string>();
    const ensureDnsRecord = vi.spyOn(CloudflareService.prototype, "ensureDnsRecord")
      .mockImplementation(async () => {
        providerRecords.add("record-domain-race");
        return { zoneId: "zone-domain-race", recordId: "record-domain-race" };
      });
    const deleteDnsRecord = vi.spyOn(CloudflareService.prototype, "deleteDnsRecord")
      .mockImplementation(async (_zoneId, recordId) => {
        if (recordId) providerRecords.delete(recordId);
      });
    const activatePendingDomain = database.activatePendingDomain.bind(database);
    vi.spyOn(database, "activatePendingDomain").mockImplementation((id, projectId, updates) => {
      const now = new Date().toISOString();
      database.sqlite.prepare(`
        INSERT INTO project_deletions (project_id, status, error, requested_at, updated_at)
        VALUES (?, 'failed', 'Simulierter konkurrierender Löschstatus', ?, ?)
      `).run(projectId, now, now);
      return activatePendingDomain(id, projectId, updates);
    });

    const app = await createApp(config, database);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });
    const mutationHeaders = {
      cookie: `portsmith_session=${login.cookies.find((entry) => entry.name === "shelter_session")?.value ?? ""}`,
      "x-csrf-token": login.json().csrfToken as string,
      origin: "http://localhost:7080",
      host: "localhost:7080"
    };

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${row.id}/domains`,
      headers: mutationHeaders,
      payload: { hostname: "race.example.com", zoneId: "zone-domain-race" }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().domain).toMatchObject({
      hostname: "race.example.com",
      status: "error",
      error: "Domainstatus hat sich während der Einrichtung geändert"
    });
    expect(ensureDnsRecord).toHaveBeenCalledWith("race.example.com", "zone-domain-race");
    expect(deleteDnsRecord).toHaveBeenCalledWith(
      "zone-domain-race",
      "record-domain-race",
      "race.example.com"
    );
    expect(providerRecords).toEqual(new Set());
    expect(database.getDomain(response.json().domain.id)).toMatchObject({
      status: "error",
      zone_id: "zone-domain-race",
      dns_record_id: "record-domain-race"
    });
    expect(database.getProjectDeletion(row.id)).toMatchObject({ status: "failed" });
    expect(database.getMutableProject(row.id)).toBeUndefined();
    expect(database.listRoutableProjects()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: row.id })
    ]));
    await app.close();
  });
});

describe("project deletion database serialization", () => {
  it("orders pending domain creation against deletion and recovers interrupted pending rows", () => {
    const { database } = context();
    const domainFirst = project("prj_domain_first", "Domain First");
    database.createProject(domainFirst);
    const pending = {
      id: "dom_pending_first",
      project_id: domainFirst.id,
      hostname: "pending.example.com",
      zone_id: "zone-id",
      dns_record_id: null,
      status: "pending" as const,
      error: null,
      created_at: new Date().toISOString()
    };
    expect(database.createOrRetryPendingDomain(pending).kind).toBe("created");
    expect(database.prepareProjectDeletion(domainFirst.id, domainFirst.name).kind).toBe("domain_pending");

    database.recoverPendingDomains();
    expect(database.getDomain(pending.id)).toMatchObject({
      status: "error",
      error: "Domain-Einrichtung wurde durch einen API-Neustart unterbrochen"
    });
    const retried = database.createOrRetryPendingDomain({ ...pending, id: "unused-retry-id", zone_id: null });
    expect(retried).toMatchObject({ kind: "retry", domain: { id: pending.id, status: "pending", zone_id: "zone-id" } });

    database.failPendingDomain(pending.id, "retry stopped");
    expect(database.prepareProjectDeletion(domainFirst.id, domainFirst.name).kind).toBe("started");
    expect(database.createOrRetryPendingDomain({
      ...pending,
      id: "dom_must_not_exist",
      hostname: "late.example.com"
    }).kind).toBe("project_unavailable");
    expect(database.getDomain("dom_must_not_exist")).toBeUndefined();
  });

  it("claims queued deployments only for projects outside deletion quarantine", () => {
    const { database } = context();
    const deleting = project("prj_claim_deleting", "Claim Deleting");
    const deployable = project("prj_claim_ready", "Claim Ready");
    database.createProject(deleting);
    database.createProject(deployable);
    database.createDeployment(deployment("dep_claim_deleting", deleting.id, "queued"));
    database.createDeployment(deployment("dep_claim_ready", deployable.id, "queued"));
    expect(database.prepareProjectDeletion(deleting.id, deleting.name).kind).toBe("started");

    expect(database.claimNextQueuedDeployment()).toMatchObject({
      id: "dep_claim_ready",
      status: "preparing"
    });
    expect(database.getDeployment("dep_claim_deleting")).toMatchObject({ status: "cancelled" });
  });
});

describe("project deletion worker", () => {
  it("makes a failed worker cleanup visible and accepts an explicit retry", async () => {
    const { config, database } = context();
    const row = project("prj_worker_retry", "Worker Retry");
    database.createProject(row);
    expect(database.prepareProjectDeletion(row.id, row.name).kind).toBe("started");
    expect(database.queueProjectDeletion(row.id)).toBe(true);
    const command = vi.fn<ProjectDeletionCommandRunner>()
      .mockRejectedValueOnce(new Error("Docker is unavailable"))
      .mockImplementation(async (_command, args) => args[0] === "network" && args[1] === "inspect"
        ? { stdout: "", stderr: `Error response from daemon: network ${args.at(-1)} not found`, exitCode: 1 }
        : { stdout: "", stderr: "", exitCode: 0 });
    const worker = new ProjectDeletionWorker(config, database, command);

    await expect(worker.processNext()).resolves.toBe(true);
    expect(database.getProjectDeletion(row.id)).toMatchObject({
      status: "failed",
      error: "Docker is unavailable"
    });
    expect(database.getProject(row.id)?.id).toBe(row.id);

    expect(database.prepareProjectDeletion(row.id, row.name).kind).toBe("started");
    expect(database.queueProjectDeletion(row.id)).toBe(true);
    await expect(worker.processNext()).resolves.toBe(true);
    expect(database.getProjectForDeletion(row.id)).toBeUndefined();
  });

  it("keeps a partially cleaned project quarantined and completes an idempotent retry", async () => {
    const { config, database } = context();
    const deploymentId = "dep_worker_partial";
    const row = project("prj_worker_partial", "Worker Partial", { active_deployment_id: deploymentId });
    database.createProject(row);
    database.createDeployment(deployment(deploymentId, row.id, "ready", {
      image_tag: "portsmith/worker-partial:ready",
      internal_port: 3000,
      finished_at: new Date().toISOString()
    }));

    const app = await createApp(config, database);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });
    const cookie = `portsmith_session=${login.cookies.find((entry) => entry.name === "shelter_session")?.value ?? ""}`;
    const mutationHeaders = {
      cookie,
      "x-csrf-token": login.json().csrfToken as string,
      origin: "http://localhost:7080",
      host: "localhost:7080"
    };

    const containerId = "aaaaaaaaaaaa";
    const imageId = "bbbbbbbbbbbb";
    let containerPresent = true;
    let imageDeleteAttempts = 0;
    const calls: string[][] = [];
    const command: ProjectDeletionCommandRunner = vi.fn(async (_command: string, args: string[]) => {
      calls.push([...args]);
      if (args[0] === "network" && args[1] === "inspect") {
        return { stdout: "", stderr: `Error response from daemon: network ${args.at(-1)} not found`, exitCode: 1 };
      }
      if (args[0] === "ps") {
        return { stdout: containerPresent ? containerId : "", stderr: "", exitCode: 0 };
      }
      if (args[0] === "inspect" && args.some((value) => value.includes('"name"'))) {
        return {
          stdout: JSON.stringify({
            name: "/portsmith-app-worker-partial",
            image: "portsmith/worker-partial:ready",
            labels: { "portsmith.managed": "true", "portsmith.project": row.id }
          }),
          stderr: "",
          exitCode: 0
        };
      }
      if (args[0] === "rm") {
        containerPresent = false;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: imageId, stderr: "", exitCode: 0 };
      }
      if (args[0] === "image" && args[1] === "rm") {
        imageDeleteAttempts += 1;
        if (imageDeleteAttempts === 1) throw new Error("Image cleanup failed after container removal");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const worker = new ProjectDeletionWorker(config, database, command);

    expect(database.prepareProjectDeletion(row.id, row.name).kind).toBe("started");
    expect(database.queueProjectDeletion(row.id)).toBe(true);
    await expect(worker.processNext()).resolves.toBe(true);

    const containerRemovalIndex = calls.findIndex((args) => args[0] === "rm" && args[1] === "-f");
    const failedImageRemovalIndex = calls.findIndex((args) => args[0] === "image" && args[1] === "rm");
    expect(containerRemovalIndex).toBeGreaterThan(-1);
    expect(failedImageRemovalIndex).toBeGreaterThan(containerRemovalIndex);
    expect(containerPresent).toBe(false);
    expect(imageDeleteAttempts).toBe(1);
    expect(database.getProjectDeletion(row.id)).toMatchObject({
      status: "failed",
      error: "Image cleanup failed after container removal"
    });
    expect(database.getMutableProject(row.id)).toBeUndefined();
    expect(database.listRoutableProjects()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: row.id })
    ]));

    const detail = await app.inject({
      method: "GET",
      url: `/api/projects/${row.id}`,
      headers: { cookie }
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().project).toMatchObject({
      status: "deletion_failed",
      deletionStatus: "failed",
      deletionError: "Image cleanup failed after container removal"
    });
    const mutation = await app.inject({
      method: "PATCH",
      url: `/api/projects/${row.id}`,
      headers: mutationHeaders,
      payload: { name: "Must Stay Quarantined" }
    });
    expect(mutation.statusCode).toBe(409);
    expect(mutation.json().code).toBe("PROJECT_DELETION_FAILED");

    expect(database.prepareProjectDeletion(row.id, row.name).kind).toBe("started");
    expect(database.queueProjectDeletion(row.id)).toBe(true);
    await expect(worker.processNext()).resolves.toBe(true);

    expect(imageDeleteAttempts).toBe(2);
    expect(calls.filter((args) => args[0] === "rm" && args[1] === "-f")).toHaveLength(1);
    expect(database.getProjectForDeletion(row.id)).toBeUndefined();
    expect(database.getProjectDeletion(row.id)).toBeUndefined();
    await app.close();
  });

  it("removes only label-owned Docker resources and preserves a source archive until its last project is deleted", async () => {
    const { config, database } = context();
    const uploadId = "upl_sharedsource";
    const sourceDirectory = path.join(config.sourcesDir, uploadId);
    const archivePath = path.join(sourceDirectory, "source.zip");
    const chunkDirectory = path.join(config.sourcesDir, ".chunks", uploadId);
    fs.mkdirSync(sourceDirectory, { recursive: true });
    fs.mkdirSync(chunkDirectory, { recursive: true });
    fs.writeFileSync(archivePath, "zip-placeholder");
    fs.writeFileSync(path.join(chunkDirectory, "0.part"), "chunk-placeholder");
    database.sqlite.prepare(`
      INSERT INTO uploads (id, filename, expected_size, chunk_size, total_chunks, status, archive_path, created_at)
      VALUES (?, 'source.zip', 15, 10485760, 1, 'complete', ?, ?)
    `).run(uploadId, archivePath, new Date().toISOString());
    const historicalUploadId = "upl_historicalsource";
    const historicalDirectory = path.join(config.sourcesDir, historicalUploadId);
    const historicalArchive = path.join(historicalDirectory, "source.zip");
    fs.mkdirSync(historicalDirectory, { recursive: true });
    fs.writeFileSync(historicalArchive, "historical-zip");
    database.sqlite.prepare(`
      INSERT INTO uploads (id, filename, expected_size, chunk_size, total_chunks, status, archive_path, created_at)
      VALUES (?, 'source.zip', 14, 10485760, 1, 'complete', ?, ?)
    `).run(historicalUploadId, historicalArchive, new Date().toISOString());

    const first = project("prj_cleanup_one", "Cleanup One", {
      source_type: "upload",
      repository_url: null,
      repository_branch: null,
      source_archive: archivePath,
      active_deployment_id: "dep_cleanup_ready"
    });
    const second = project("prj_cleanup_two", "Cleanup Two", {
      source_type: "upload",
      repository_url: null,
      repository_branch: null,
      source_archive: archivePath
    });
    database.createProject(first);
    database.createProject(second);
    database.createDeployment(deployment("dep_cleanup_ready", first.id, "ready", {
      image_tag: "portsmith/cleanup-one:ready",
      internal_port: 3000
    }));
    database.createDeployment(deployment("dep_cleanup_failed", first.id, "failed", {
      source_ref: historicalUploadId,
      image_tag: "portsmith/cleanup-one:failed",
      error: "failed"
    }));
    for (const deploymentId of ["dep_cleanup_ready", "dep_cleanup_failed"]) {
      const workspace = path.join(config.workspacesDir, deploymentId);
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(workspace, "temporary"), "data");
    }

    const ownedContainer = "111111111111";
    const foreignContainer = "ffffffffffff";
    const readyImage = "222222222222";
    const failedImage = "333333333333";
    const calls: string[][] = [];
    const command: ProjectDeletionCommandRunner = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "network" && args[1] === "inspect") {
        return { stdout: "", stderr: `Error response from daemon: network ${args.at(-1)} not found`, exitCode: 1 };
      }
      if (args[0] === "ps") {
        return {
          stdout: args.includes(`label=portsmith.project=${first.id}`) ? ownedContainer : "",
          stderr: "",
          exitCode: 0
        };
      }
      if (args[0] === "inspect" && args.some((value) => value.includes('"name"'))) {
        return {
          stdout: JSON.stringify({
            name: "/portsmith-app-cleanup-one",
            image: "portsmith/cleanup-one:ready",
            labels: { "portsmith.managed": "true", "portsmith.project": first.id }
          }),
          stderr: "",
          exitCode: 0
        };
      }
      if (args[0] === "image" && args[1] === "inspect") {
        return {
          stdout: args.at(-1) === "portsmith/cleanup-one:ready" ? readyImage : failedImage,
          stderr: "",
          exitCode: 0
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const worker = new ProjectDeletionWorker(config, database, command);

    expect(database.prepareProjectDeletion(first.id, first.name).kind).toBe("started");
    expect(database.queueProjectDeletion(first.id)).toBe(true);
    await expect(worker.processNext()).resolves.toBe(true);

    expect(database.getProjectForDeletion(first.id)).toBeUndefined();
    expect(database.getProjectForDeletion(second.id)?.id).toBe(second.id);
    expect(fs.existsSync(path.join(config.workspacesDir, "dep_cleanup_ready"))).toBe(false);
    expect(fs.existsSync(path.join(config.workspacesDir, "dep_cleanup_failed"))).toBe(false);
    expect(fs.existsSync(archivePath)).toBe(true);
    expect(database.sqlite.prepare("SELECT id FROM uploads WHERE id = ?").get(uploadId)).toBeTruthy();
    expect(fs.existsSync(historicalDirectory)).toBe(false);
    expect(database.sqlite.prepare("SELECT id FROM uploads WHERE id = ?").get(historicalUploadId)).toBeUndefined();
    expect(calls).toContainEqual([
      "ps", "-aq",
      "--filter", "label=portsmith.managed=true",
      "--filter", `label=portsmith.project=${first.id}`
    ]);
    expect(calls).toContainEqual([
      "ps", "-aq",
      "--filter", "label=shelter.managed=true",
      "--filter", `label=shelter.project=${first.id}`
    ]);
    expect(calls).toContainEqual(["rm", "-f", "-v", ownedContainer]);
    expect(calls).toContainEqual(["image", "rm", readyImage]);
    expect(calls).toContainEqual(["image", "rm", failedImage]);
    expect(calls.flat()).not.toContain(foreignContainer);

    expect(database.prepareProjectDeletion(second.id, second.name).kind).toBe("started");
    expect(database.queueProjectDeletion(second.id)).toBe(true);
    await expect(worker.processNext()).resolves.toBe(true);
    expect(database.getProjectForDeletion(second.id)).toBeUndefined();
    expect(fs.existsSync(sourceDirectory)).toBe(false);
    expect(fs.existsSync(chunkDirectory)).toBe(false);
    expect(database.sqlite.prepare("SELECT id FROM uploads WHERE id = ?").get(uploadId)).toBeUndefined();
  });

  it("does not delete a current Shelter container that only forges legacy ownership of the victim", async () => {
    const { config, database } = context();
    const victim = project("prj_delete_victim", "Delete Victim");
    database.createProject(victim);
    const attackerContainer = "c".repeat(12);
    const calls: string[][] = [];
    const command = vi.fn<ProjectDeletionCommandRunner>(async (_binary, args) => {
      calls.push([...args]);
      if (args[0] === "ps" && args.includes(`label=portsmith.project=${victim.id}`)) {
        return { stdout: attackerContainer, stderr: "", exitCode: 0 };
      }
      if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0 };
      if (args[0] === "inspect" && args.some((value) => value.includes('"name"'))) {
        return {
          stdout: JSON.stringify({
            name: "/shelter-run-attacker",
            image: "shelter/attacker:latest",
            labels: {
              "shelter.managed": "true",
              "shelter.project": "prj_attacker",
              "portsmith.managed": "true",
              "portsmith.project": victim.id
            }
          }),
          stderr: "",
          exitCode: 0
        };
      }
      if (args[0] === "network" && args[1] === "inspect") {
        return { stdout: "", stderr: `Error response from daemon: network ${args.at(-1)} not found`, exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const worker = new ProjectDeletionWorker(config, database, command);
    expect(database.prepareProjectDeletion(victim.id, victim.name).kind).toBe("started");
    expect(database.queueProjectDeletion(victim.id)).toBe(true);

    await expect(worker.processNext()).resolves.toBe(true);

    expect(database.getProjectForDeletion(victim.id)).toBeUndefined();
    expect(calls.some((args) => args[0] === "rm" && args.at(-1) === attackerContainer)).toBe(false);
  });

  it("keeps deletion retryable when a managed image cannot be inspected safely", async () => {
    const { config, database } = context();
    const projectRow = project("prj_image_inspect_failure", "Image Inspect Failure");
    database.createProject(projectRow);
    database.createDeployment(deployment("dep_image_inspect_failure", projectRow.id, "failed", {
      image_tag: "shelter/image-inspect-failure:dep"
    }));
    const command = vi.fn<ProjectDeletionCommandRunner>(async (_binary, args) => {
      if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0 };
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: "", stderr: "Cannot connect to the Docker daemon", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const worker = new ProjectDeletionWorker(config, database, command);
    expect(database.prepareProjectDeletion(projectRow.id, projectRow.name).kind).toBe("started");
    expect(database.queueProjectDeletion(projectRow.id)).toBe(true);

    await expect(worker.processNext()).resolves.toBe(true);

    expect(database.getProjectForDeletion(projectRow.id)?.id).toBe(projectRow.id);
    expect(database.getProjectDeletion(projectRow.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Cannot connect to the Docker daemon")
    });
    expect(command.mock.calls.some(([, args]) => args[0] === "image" && args[1] === "rm")).toBe(false);
  });
});
