import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { reconcileRouting } from "../src/services/routing.js";
import type { DeploymentRow, ProjectRow } from "../src/types/models.js";

const directories: string[] = [];
const databases: Database[] = [];

function context(): { config: AppConfig; database: Database } {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-deployment-safety-"));
  directories.push(dataDirectory);
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDirectory,
    WEB_DIST: path.join(dataDirectory, "missing-web"),
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "correct horse battery staple",
    APP_SECRET: "s".repeat(64),
    LOG_LEVEL: "silent"
  });
  const database = new Database(config);
  databases.push(database);
  return { config, database };
}

function project(id: string, overrides: Partial<ProjectRow> = {}): ProjectRow {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    slug: id.replace(/^prj_/, ""),
    source_type: "git",
    repository_url: "https://github.com/example/example.git",
    repository_branch: "main",
    source_archive: null,
    static_base_path: null,
    root_directory: ".",
    build_type: "auto",
    dockerfile_path: "Dockerfile",
    port: 3000,
    healthcheck_path: "/health",
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

async function mutationHeaders(app: FastifyInstance): Promise<Record<string, string>> {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin@example.com", password: "correct horse battery staple" }
  });
  const headers = {
    cookie: `shelter_session=${login.cookies.find((entry) => entry.name === "shelter_session")?.value ?? ""}`,
    "x-csrf-token": login.json().csrfToken as string,
    origin: "http://localhost:7080",
    host: "localhost:7080"
  };
  return headers;
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.sqlite.open) database.close();
  }
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("deployment cancellation API", () => {
  it("cancels queued work immediately and is idempotent", async () => {
    const { config, database } = context();
    const row = project("prj_cancel_queued");
    database.createProject(row);
    database.createDeployment(deployment("dep_cancel_queued", row.id, "queued"));
    const app = await createApp(config, database);
    const headers = await mutationHeaders(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/deployments/dep_cancel_queued/cancel",
      headers
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().deployment).toMatchObject({
      status: "cancelled",
      failureKind: "cancelled",
      rollbackStatus: "not_required"
    });
    expect(response.json().deployment.cancelRequestedAt).toEqual(expect.any(String));
    expect(database.claimNextQueuedDeployment()).toBeUndefined();

    const repeated = await app.inject({
      method: "POST",
      url: "/api/deployments/dep_cancel_queued/cancel",
      headers
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().deployment.status).toBe("cancelled");
    await app.close();
  });

  it("requests cooperative cancellation without prematurely terminalizing running work", async () => {
    const { config, database } = context();
    const row = project("prj_cancel_running");
    database.createProject(row);
    database.createDeployment(deployment("dep_cancel_running", row.id, "building", {
      started_at: new Date().toISOString()
    }));
    const app = await createApp(config, database);
    const headers = await mutationHeaders(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/deployments/dep_cancel_running/cancel",
      headers
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().deployment).toMatchObject({
      status: "building",
      failureKind: "cancelled"
    });
    expect(database.deploymentCancellationRequested("dep_cancel_running")).toBe(true);
    expect(database.failDeploymentIfActive(
      "dep_cancel_running",
      "build",
      "late worker error",
      new Date().toISOString()
    )).toBeUndefined();
    expect(database.getDeployment("dep_cancel_running")?.status).toBe("building");

    expect(database.finalizeDeploymentCancellation("dep_cancel_running")).toMatchObject({
      status: "cancelled",
      failure_kind: "cancelled"
    });
    await app.close();
  });

  it("refuses cancellation during the atomic activation window and after completion", async () => {
    const { config, database } = context();
    const switchingProject = project("prj_switching");
    const readyProject = project("prj_ready");
    database.createProject(switchingProject);
    database.createProject(readyProject);
    database.createDeployment(deployment("dep_switching", switchingProject.id, "switching"));
    database.createDeployment(deployment("dep_ready", readyProject.id, "ready", {
      image_tag: "shelter/ready:dep_ready",
      internal_port: 3000,
      finished_at: new Date().toISOString()
    }));
    const app = await createApp(config, database);
    const headers = await mutationHeaders(app);

    const activating = await app.inject({
      method: "POST",
      url: "/api/deployments/dep_switching/cancel",
      headers
    });
    expect(activating.statusCode).toBe(409);
    expect(activating.json().code).toBe("DEPLOYMENT_ACTIVATING");
    expect(database.getDeployment("dep_switching")?.cancel_requested_at).toBeNull();

    const terminal = await app.inject({
      method: "POST",
      url: "/api/deployments/dep_ready/cancel",
      headers
    });
    expect(terminal.statusCode).toBe(409);
    expect(terminal.json().code).toBe("DEPLOYMENT_TERMINAL");
    await app.close();
  });
});

describe("deployment activation and rollback safety", () => {
  it("atomically changes the active runtime and routes by immutable container identity", () => {
    const { config, database } = context();
    const oldId = "dep_old";
    const candidateId = "dep_candidate";
    const row = project("prj_atomic", { active_deployment_id: oldId, static_base_path: "/old" });
    database.createProject(row);
    database.createDeployment(deployment(oldId, row.id, "ready", {
      image_tag: "shelter/atomic:old",
      internal_port: 3000,
      runtime_container: "shelter-run-atomic-old",
      static_base_path: "/old"
    }));
    database.createDeployment(deployment(candidateId, row.id, "checking", {
      image_tag: "shelter/atomic:new",
      internal_port: 3000,
      runtime_container: "shelter-run-atomic-candidate",
      rollback_deployment_id: oldId,
      static_base_path: "/new"
    }));
    database.createDomain({
      id: "dom_atomic",
      project_id: row.id,
      hostname: "atomic.example.com",
      zone_id: "zone",
      dns_record_id: "record",
      status: "active",
      error: null,
      created_at: new Date().toISOString()
    });

    expect(database.beginDeploymentActivation(candidateId, row.id, null)).toBe("activation_started");
    expect(database.activateDeploymentRuntime(candidateId, row.id, oldId)).toBe(true);
    expect(database.getProject(row.id)).toMatchObject({
      active_deployment_id: candidateId,
      static_base_path: "/new"
    });
    reconcileRouting(config, database);
    const routing = fs.readFileSync(config.traefikConfigPath, "utf8");
    expect(routing).toContain("http://shelter-run-atomic-candidate:3000");
    expect(routing).not.toContain("http://shelter-run-atomic-old:3000");
    expect(database.completeDeploymentActivation(candidateId, row.id, new Date().toISOString())).toBe(true);
    expect(database.getDeployment(candidateId)).toMatchObject({
      status: "ready",
      failure_kind: null,
      rollback_status: "not_required"
    });
  });

  it("restores the previous project pointer when activation cannot be committed", () => {
    const { database } = context();
    const oldId = "dep_restore_old";
    const candidateId = "dep_restore_candidate";
    const row = project("prj_restore", { active_deployment_id: oldId, static_base_path: "/old" });
    database.createProject(row);
    database.createDeployment(deployment(oldId, row.id, "ready", {
      image_tag: "shelter/restore:old",
      internal_port: 3000,
      static_base_path: "/old"
    }));
    database.createDeployment(deployment(candidateId, row.id, "switching", {
      image_tag: "shelter/restore:new",
      internal_port: 3000,
      static_base_path: "/new"
    }));

    expect(database.activateDeploymentRuntime(candidateId, row.id, oldId)).toBe(true);
    expect(database.restoreProjectActiveDeployment(row.id, candidateId, oldId, "/old")).toBe(true);
    expect(database.getProject(row.id)).toMatchObject({
      active_deployment_id: oldId,
      static_base_path: "/old"
    });
  });

  it("leases an older rollback image until the queued rollback becomes terminal", () => {
    const { database } = context();
    const row = project("prj_lease", { active_deployment_id: "dep_lease_current" });
    database.createProject(row);
    for (let index = 0; index < 5; index += 1) {
      database.createDeployment(deployment(`dep_lease_${index}`, row.id, "ready", {
        image_tag: `shelter/lease:${index}`,
        internal_port: 3000,
        created_at: new Date(Date.now() + index * 1_000).toISOString()
      }));
    }
    database.createDeployment(deployment("dep_lease_current", row.id, "ready", {
      image_tag: "shelter/lease:current",
      internal_port: 3000,
      created_at: new Date(Date.now() + 10_000).toISOString()
    }));

    const queued = database.queueRollbackDeployment("dep_lease_0", row.id);
    expect(queued.kind).toBe("queued");
    expect(database.listReadyDeployments(row.id, 3).map((item) => item.id)).not.toContain("dep_lease_0");
    expect(database.listRollbackLeasedImages(row.id)).toEqual(["shelter/lease:0"]);
    if (queued.kind !== "queued") throw new Error("Rollback fixture was not queued");
    database.requestDeploymentCancellation(queued.deployment.id);
    expect(database.listRollbackLeasedImages(row.id)).toEqual([]);
  });
});

describe("one-click rollback API", () => {
  it("supports both deployment and project rollback contracts", async () => {
    const { config, database } = context();
    const currentId = "dep_api_current";
    const targetId = "dep_api_target";
    const row = project("prj_rollback_api", { active_deployment_id: currentId });
    database.createProject(row);
    database.createDeployment(deployment(currentId, row.id, "ready", {
      image_tag: "shelter/rollback:current",
      internal_port: 3000
    }));
    database.createDeployment(deployment(targetId, row.id, "ready", {
      image_tag: "shelter/rollback:target",
      internal_port: 3000,
      runtime_kind: "node"
    }));
    const app = await createApp(config, database);
    const headers = await mutationHeaders(app);

    const direct = await app.inject({
      method: "POST",
      url: `/api/deployments/${targetId}/rollback`,
      headers
    });
    expect(direct.statusCode).toBe(202);
    expect(direct.json().deployment).toMatchObject({
      status: "queued",
      sourceRef: `rollback:${targetId}`,
      trigger: "rollback",
      rollbackDeploymentId: currentId
    });
    database.requestDeploymentCancellation(direct.json().deployment.id as string);

    const projectContract = await app.inject({
      method: "POST",
      url: `/api/projects/${row.id}/rollback`,
      headers,
      payload: { deploymentId: targetId }
    });
    expect(projectContract.statusCode).toBe(202);
    expect(projectContract.json().deployment.sourceRef).toBe(`rollback:${targetId}`);

    const openApi = await app.inject({ method: "GET", url: "/api/openapi.json" });
    expect(openApi.json().paths).toHaveProperty("/api/deployments/{deploymentId}/cancel");
    expect(openApi.json().paths).toHaveProperty("/api/deployments/{deploymentId}/rollback");
    await app.close();
  });
});
