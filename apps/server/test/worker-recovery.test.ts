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
  removed: [] as string[],
  probed: [] as string[]
}));

vi.mock("../src/lib/command.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/command.js")>("../src/lib/command.js");
  return {
    ...actual,
    runCommand: vi.fn(async (command: string, args: string[]) => {
      if (command !== "docker") return { stdout: "", stderr: "", exitCode: 0 };
      if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0 };
      if (args[0] === "run" && args.includes("shelter.helper=probe")) {
        docker.probed.push(args.at(-1) ?? "");
        return { stdout: JSON.stringify({ status: 200 }), stderr: "", exitCode: 0 };
      }
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
        return { stdout: "", stderr: "Error: No such container: missing", exitCode: 1 };
      }
      if (args[0] === "rm" && args[1] === "-f" && args.at(-1)) {
        docker.removed.push(args.at(-1)!);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    })
  };
});

import { DeploymentWorker, startWorkerHeartbeat } from "../src/services/worker.js";

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
  docker.probed.length = 0;
  for (const database of databases.splice(0)) {
    if (database.sqlite.open) database.close();
  }
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("deployment recovery", () => {
  it("keeps the worker process alive while asynchronous deployment work is pending", () => {
    vi.useFakeTimers();
    const setSetting = vi.fn();
    const heartbeat = startWorkerHeartbeat({ setSetting }, 5_000);
    try {
      expect(heartbeat.hasRef()).toBe(true);
      expect(setSetting).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5_000);
      expect(setSetting).toHaveBeenCalledTimes(2);
    } finally {
      clearInterval(heartbeat);
      vi.useRealTimers();
    }
  });

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
    expect(docker.probed).toContain(`http://${docker.candidateName}:3000/health`);
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

  it("restores the last-good preview when the routing file cannot be switched", async () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-preview-routing-rollback-"));
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
    const row: ProjectRow = {
      ...project("preview-rollback"),
      active_deployment_id: null,
      github_installation_id: "123",
      github_repository_id: "99",
      github_repository_full_name: "example/recovery",
      preview_deployments_enabled: 1,
      preview_domain_id: "dom_preview",
      preview_domain_suffix: "example.com",
      preview_ttl_hours: 24
    };
    database.createProject(row);
    const queue = (sha: string, deliveryId: string) => database.queuePullRequestPreview({
      projectId: row.id,
      pullRequestNumber: 42,
      headSha: sha,
      headRef: "feature/preview",
      baseRef: "main",
      repositoryId: "99",
      repositoryFullName: "example/recovery",
      deliveryId,
      hostname: "pr-42--preview-rollback.example.com",
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      commitMessage: "Preview rollback",
      commitAuthor: "Ada",
      commitUrl: null
    });

    const first = queue("a".repeat(40), "preview-rollback-1").preview;
    const firstId = first.deployment_id!;
    database.updatePullRequestPreviewDns(first.id, firstId, "zone", "record");
    database.beginPullRequestPreviewBuild(first.id, firstId);
    database.updateDeployment(firstId, {
      status: "checking",
      image_tag: "shelter/preview:first",
      runtime_container: "shelter-preview-first",
      internal_port: 3000
    });
    expect(database.completePullRequestPreview(first.id, firstId)).toBe(true);

    const second = queue("b".repeat(40), "preview-rollback-2").preview;
    const secondId = second.deployment_id!;
    database.beginPullRequestPreviewBuild(second.id, secondId);
    database.updateDeployment(secondId, {
      status: "checking",
      image_tag: "shelter/preview:second",
      runtime_container: "shelter-preview-second",
      internal_port: 3000
    });

    const routingDirectory = path.dirname(config.traefikConfigPath);
    fs.rmSync(routingDirectory, { recursive: true, force: true });
    fs.writeFileSync(routingDirectory, "block atomic routing writes");
    const worker = new DeploymentWorker(config, database);
    await expect((worker as unknown as {
      activatePullRequestPreview(
        project: ProjectRow,
        deploymentId: string,
        runtimeName: string,
        imageTag: string,
        internalPort: number,
        previousDeployment?: DeploymentRow
      ): Promise<void>;
    }).activatePullRequestPreview(
      row,
      secondId,
      "shelter-preview-second",
      "shelter/preview:second",
      3000,
      database.getDeployment(firstId)
    )).rejects.toThrow();

    expect(database.getPullRequestPreview(second.id)).toMatchObject({
      deployment_id: secondId,
      active_deployment_id: firstId,
      status: "failed"
    });
    expect(database.getDeployment(firstId)).toMatchObject({ status: "ready", failure_kind: null });
    expect(database.getDeployment(secondId)).toMatchObject({ status: "failed", failure_kind: "activation" });
    expect(docker.removed).toContain("shelter-preview-second");
    expect(docker.removed).not.toContain("shelter-preview-first");
  });
});
