import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import {
  deploymentContainerName,
  isDockerDnsLabel,
  legacyDeploymentContainerName
} from "../src/services/runtime-identity.js";
import type { DeploymentRow, ProjectRow } from "../src/types/models.js";

const defaultCandidateName = "shelter-run-recovery-candidate";
const defaultCandidateDeploymentId = "dep_recovery_candidate";
const docker = vi.hoisted(() => ({
  candidateName: "shelter-run-recovery-candidate",
  candidateDeploymentId: "dep_recovery_candidate",
  removed: [] as string[]
}));

vi.mock("../src/lib/command.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/command.js")>("../src/lib/command.js");
  return {
    ...actual,
    runCommand: vi.fn(async (command: string, args: string[]) => {
      if (command !== "docker") return { stdout: "", stderr: "", exitCode: 0 };
      if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0 };
      if (args[0] === "inspect" && args[1] === "-f") {
        const template = args[2] ?? "";
        const name = args[3] ?? "";
        if (template.includes(".deployment")) {
          return {
            stdout: name === docker.candidateName ? docker.candidateDeploymentId : "",
            stderr: "",
            exitCode: name === docker.candidateName ? 0 : 1
          };
        }
        if (template.includes(".State.Running")) {
          return { stdout: name === docker.candidateName ? "true 0" : "", stderr: "", exitCode: name === docker.candidateName ? 0 : 1 };
        }
      }
      if (args[0] === "inspect") {
        return { stdout: "", stderr: "not found", exitCode: 1 };
      }
      if (args[0] === "rm" && args[1] === "-f" && args[2]) {
        docker.removed.push(args[2]);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    })
  };
});

import { DeploymentWorker } from "../src/services/worker.js";

const directories: string[] = [];
const databases: Database[] = [];

function project(slug = "recovery"): ProjectRow {
  const now = new Date().toISOString();
  return {
    id: "prj_recovery",
    name: "Recovery",
    slug,
    source_type: "git",
    repository_url: "https://github.com/example/recovery.git",
    repository_branch: "main",
    source_archive: null,
    static_base_path: "/old",
    root_directory: ".",
    build_type: "auto",
    dockerfile_path: "Dockerfile",
    port: 3000,
    healthcheck_path: "/health",
    memory_limit: "1g",
    cpu_limit: "1.0",
    active_deployment_id: "dep_recovery_old",
    created_at: now,
    updated_at: now
  };
}

function deployment(id: string, status: DeploymentRow["status"], overrides: Partial<DeploymentRow>): DeploymentRow {
  return {
    id,
    project_id: "prj_recovery",
    status,
    source_ref: "main",
    image_tag: null,
    previous_image_tag: null,
    internal_port: null,
    static_base_path: null,
    runtime_kind: "node",
    runtime_description: "Node.js",
    commit_sha: null,
    error: null,
    started_at: new Date().toISOString(),
    finished_at: null,
    created_at: new Date().toISOString(),
    ...overrides
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  docker.candidateName = defaultCandidateName;
  docker.candidateDeploymentId = defaultCandidateDeploymentId;
  docker.removed.length = 0;
  for (const database of databases.splice(0)) {
    if (database.sqlite.open) database.close();
  }
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("deployment recovery", () => {
  it("finishes an interrupted switch using runtime_container and only then removes the old runtime", async () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-worker-recovery-"));
    directories.push(dataDirectory);
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: dataDirectory,
      WEB_DIST: path.join(dataDirectory, "missing-web"),
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: "correct horse battery staple",
      APP_SECRET: "r".repeat(64),
      HEALTHCHECK_TIMEOUT_SECONDS: "5",
      LOG_LEVEL: "silent"
    });
    const database = new Database(config);
    databases.push(database);
    const longSlug = "qa-upload-projekt-mit-einem-ausgesprochen-langen-projektnamen";
    docker.candidateDeploymentId = "dep_0123456789abcdef0123456789abcdef";
    docker.candidateName = deploymentContainerName(longSlug, docker.candidateDeploymentId);
    expect(isDockerDnsLabel(docker.candidateName)).toBe(true);
    expect(docker.candidateName.length).toBeLessThanOrEqual(63);
    const row = project(longSlug);
    database.createProject(row);
    database.createDeployment(deployment("dep_recovery_old", "ready", {
      image_tag: "shelter/recovery:old",
      internal_port: 3000,
      runtime_container: "shelter-run-recovery-old",
      static_base_path: "/old",
      finished_at: new Date().toISOString()
    }));
    database.createDeployment(deployment(docker.candidateDeploymentId, "switching", {
      image_tag: "shelter/recovery:candidate",
      previous_image_tag: "shelter/recovery:old",
      internal_port: 3000,
      runtime_container: docker.candidateName,
      rollback_deployment_id: "dep_recovery_old",
      static_base_path: "/new"
    }));
    database.createDomain({
      id: "dom_recovery",
      project_id: row.id,
      hostname: "recovery.example.com",
      zone_id: "zone",
      dns_record_id: "record",
      status: "active",
      error: null,
      created_at: new Date().toISOString()
    });
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const worker = new DeploymentWorker(config, database);
    await (worker as unknown as { recoverInterruptedDeployments(): Promise<void> }).recoverInterruptedDeployments();

    expect(database.getDeployment(docker.candidateDeploymentId)).toMatchObject({
      status: "ready",
      runtime_container: docker.candidateName,
      failure_kind: null
    });
    expect(database.getProject(row.id)).toMatchObject({
      active_deployment_id: docker.candidateDeploymentId,
      static_base_path: "/new"
    });
    expect(fs.readFileSync(config.traefikConfigPath, "utf8")).toContain(`http://${docker.candidateName}:3000`);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://${docker.candidateName}:3000/health`,
      expect.objectContaining({ redirect: "manual" })
    );
    expect(docker.removed).toContain("shelter-run-recovery-old");
    expect(docker.removed).not.toContain(docker.candidateName);
  });

  it("finds and cleans an interrupted runtime persisted with the pre-fix long-name format", async () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-worker-legacy-runtime-"));
    directories.push(dataDirectory);
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: dataDirectory,
      WEB_DIST: path.join(dataDirectory, "missing-web"),
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: "correct horse battery staple",
      APP_SECRET: "r".repeat(64),
      LOG_LEVEL: "silent"
    });
    const database = new Database(config);
    databases.push(database);
    const longSlug = "x".repeat(80);
    docker.candidateDeploymentId = "dep_abcdefabcdefabcdefabcdefabcdefab";
    docker.candidateName = legacyDeploymentContainerName(longSlug, docker.candidateDeploymentId);
    expect(docker.candidateName.length).toBeGreaterThan(63);
    const row = project(longSlug);
    database.createProject(row);
    database.createDeployment(deployment("dep_recovery_old", "ready", {
      image_tag: "shelter/recovery:old",
      internal_port: 3000,
      runtime_container: "shelter-run-recovery-old",
      finished_at: new Date().toISOString()
    }));
    database.createDeployment(deployment(docker.candidateDeploymentId, "checking", {
      image_tag: "shelter/recovery:candidate",
      internal_port: 3000,
      runtime_container: docker.candidateName
    }));
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const worker = new DeploymentWorker(config, database);
    await (worker as unknown as { recoverInterruptedDeployments(): Promise<void> }).recoverInterruptedDeployments();

    expect(database.getDeployment(docker.candidateDeploymentId)).toMatchObject({
      status: "failed",
      failure_kind: "worker",
      runtime_container: docker.candidateName
    });
    expect(docker.removed).toContain(docker.candidateName);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
