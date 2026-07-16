import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { CommandResult } from "../src/lib/command.js";
import { Database } from "../src/lib/database.js";
import { encryptString } from "../src/lib/security.js";
import {
  parseProjectStatsLine,
  parseRuntimeLogLine,
  ProjectObservabilityCollector,
  redactRuntimeLog
} from "../src/services/project-observability.js";
import type { DeploymentRow, ProjectMetricSampleRow, ProjectRow } from "../src/types/models.js";

const temporaryDirectories: string[] = [];

function testContext() {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-project-observability-"));
  temporaryDirectories.push(dataDirectory);
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDirectory,
    WEB_DIST: path.join(dataDirectory, "missing-web"),
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "correct horse battery staple",
    APP_SECRET: "o".repeat(64),
    METRICS_INTERVAL_SECONDS: "15",
    METRICS_RETENTION_HOURS: "48",
    LOG_LEVEL: "silent"
  });
  const database = new Database(config);
  return { config, database };
}

function activeProject(database: Database, now = new Date().toISOString()) {
  const project: ProjectRow = {
    id: "prj_observe",
    name: "Observed App",
    slug: "observed-app",
    source_type: "git",
    repository_url: "https://github.com/example/observed.git",
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
    github_repository_id: null,
    github_repository_full_name: null,
    github_installation_id: null,
    auto_deploy: 0,
    github_connection_error: null,
    source_analysis_json: null,
    active_deployment_id: "dep_observe",
    created_at: now,
    updated_at: now
  };
  const deployment: DeploymentRow = {
    id: "dep_observe",
    project_id: project.id,
    status: "ready",
    source_ref: "main",
    image_tag: "shelter/observed:dep_observe",
    previous_image_tag: null,
    internal_port: 3000,
    static_base_path: null,
    runtime_kind: "node",
    runtime_description: "Node.js",
    runtime_container: "shelter-run-observed-app-dep-observe",
    failure_kind: null,
    rollback_status: "not_required",
    rollback_deployment_id: null,
    cancel_requested_at: null,
    commit_sha: null,
    commit_message: null,
    commit_author: null,
    commit_url: null,
    trigger: "manual",
    github_delivery_id: null,
    error: null,
    started_at: now,
    finished_at: now,
    created_at: now
  };
  database.createProject({ ...project, active_deployment_id: null });
  database.createDeployment(deployment);
  database.updateProject(project.id, { active_deployment_id: deployment.id });
  return { project: database.getProject(project.id)!, deployment };
}

function sample(projectId: string, deploymentId: string, sampledAt: number, overrides: Partial<ProjectMetricSampleRow> = {}): ProjectMetricSampleRow {
  return {
    project_id: projectId,
    deployment_id: deploymentId,
    sampled_at: sampledAt,
    runtime_status: "running",
    health_status: "healthy",
    started_at: new Date(sampledAt - 60_000).toISOString(),
    uptime_seconds: 60,
    restart_count: 0,
    oom_killed: 0,
    cpu_usage_percent: 12.5,
    cpu_limit_cores: 1,
    memory_used_bytes: 256 * 1024 ** 2,
    memory_limit_bytes: 1024 ** 3,
    memory_usage_percent: 25,
    network_received_bytes: 10_000,
    network_transmitted_bytes: 5_000,
    network_receive_bytes_per_second: 100,
    network_transmit_bytes_per_second: 50,
    block_read_bytes: 1_000,
    block_write_bytes: 2_000,
    ...overrides
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("project observability parsing and redaction", () => {
  it("parses bounded Docker stats and timestamped log lines", () => {
    expect(parseProjectStatsLine("observed|12.5%|256MiB / 1GiB|1.5MB / 500kB|10MB / 2MB")).toEqual({
      name: "observed",
      stats: {
        cpuUsagePercent: 12.5,
        memoryUsedBytes: 256 * 1_048_576,
        memoryLimitBytes: 1_073_741_824,
        networkReceivedBytes: 1_500_000,
        networkTransmittedBytes: 500_000,
        blockReadBytes: 10_000_000,
        blockWriteBytes: 2_000_000
      }
    });
    expect(parseRuntimeLogLine("2026-07-16T10:00:00.123456789Z listening on 3000")).toEqual({
      sourceTimestamp: "2026-07-16T10:00:00.123456789Z",
      message: "listening on 3000"
    });
    expect(parseRuntimeLogLine("not timestamped")).toBeNull();
    expect(parseProjectStatsLine("observed|12.5%%|256MiB / 1GiB|1.5MB / 500kB|10MB / 2MB")?.stats.cpuUsagePercent)
      .toBe(0);
  });

  it("redacts exact, multiline and short configured secret values", () => {
    expect(redactRuntimeLog("token=super-secret password=x multiline=second", ["super-secret", "first\nsecond", "x"]))
      .toBe("token=[REDACTED] password=[REDACTED] multiline=[REDACTED]");
    expect(redactRuntimeLog("example stays readable", ["x"])).toBe("example stays readable");
  });
});

describe("ProjectObservabilityCollector", () => {
  it("persists per-project samples, rates and redacted active-runtime logs without duplicates", async () => {
    const { config, database } = testContext();
    try {
      const { project } = activeProject(database);
      const now = Date.now();
      database.replaceEnvironment(project.id, [{
        id: "env_secret",
        project_id: project.id,
        key: "API_TOKEN",
        encrypted_value: encryptString("very-secret-token", config.APP_SECRET),
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString()
      }]);
      let statsCall = 0;
      const command = async (_command: string, args: string[]): Promise<CommandResult> => {
        if (args[0] === "ps") return {
          stdout: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd|shelter-run-observed-app-dep-observe|prj_observe|dep_observe",
          stderr: "",
          exitCode: 0
        };
        if (args[0] === "inspect") return {
          stdout: `${JSON.stringify("abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd")}|${JSON.stringify("/shelter-run-observed-app-dep-observe")}|${JSON.stringify("running")}|${JSON.stringify(new Date(now - 60_000).toISOString())}|false|2|${JSON.stringify("healthy")}`,
          stderr: "",
          exitCode: 0
        };
        if (args[0] === "stats") {
          statsCall += 1;
          return {
            stdout: `shelter-run-observed-app-dep-observe|25%|${statsCall === 1 ? "256MiB" : "512MiB"} / 1GiB|${statsCall === 1 ? "1MB / 2MB" : "1.15MB / 2.3MB"}|10MB / 3MB`,
            stderr: "",
            exitCode: 0
          };
        }
        if (args[0] === "logs") return {
          stdout: "2026-07-16T10:00:00.123456789Z token=very-secret-token",
          stderr: "2026-07-16T10:00:01.123456789Z stderr is separate",
          exitCode: 0
        };
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      };
      const collector = new ProjectObservabilityCollector(config, database, command);
      await collector.collect(now);
      await collector.collect(now + 15_000);

      const latest = database.latestProjectMetricSample(project.id);
      expect(latest).toMatchObject({
        deployment_id: "dep_observe",
        runtime_status: "running",
        health_status: "healthy",
        restart_count: 2,
        cpu_usage_percent: 25,
        memory_usage_percent: 50,
        network_receive_bytes_per_second: 10_000,
        network_transmit_bytes_per_second: 20_000
      });
      const logs = database.latestRuntimeLogs(project.id, "dep_observe", 500);
      expect(logs).toHaveLength(2);
      expect(logs.map((entry) => entry.stream)).toEqual(["stdout", "stderr"]);
      expect(logs[0]?.message).toBe("token=[REDACTED]");
      expect(JSON.stringify(logs)).not.toContain("very-secret-token");
    } finally {
      database.close();
    }
  });
});

describe("project observability persistence and API", () => {
  it("downsamples and prunes project history and bounded runtime logs", () => {
    const { database } = testContext();
    try {
      const { project, deployment } = activeProject(database);
      const now = Date.now();
      for (let index = 0; index < 240; index += 1) {
        database.insertProjectMetricSample(sample(project.id, deployment.id, now - (239 - index) * 15_000));
      }
      const rows = Array.from({ length: 120 }, (_, index) => ({
        project_id: project.id,
        deployment_id: deployment.id,
        stream: "stdout" as const,
        message: `line-${index}`,
        source_timestamp: new Date(now - (119 - index) * 1_000).toISOString(),
        collected_at: new Date(now).toISOString()
      }));
      database.insertRuntimeLogs(rows);
      expect(database.listProjectMetricHistory(project.id, now - 60 * 60_000, now, 180).length).toBeLessThanOrEqual(180);
      database.pruneProjectObservability(now - 10 * 60_000, 20, 100);
      const metricCount = database.sqlite.prepare("SELECT COUNT(*) AS count FROM project_metric_samples").get() as { count: number };
      const logCount = database.sqlite.prepare("SELECT COUNT(*) AS count FROM runtime_logs").get() as { count: number };
      expect(metricCount.count).toBe(20);
      expect(logCount.count).toBe(100);
    } finally {
      database.close();
    }
  });

  it("keeps metrics and active-runtime logs admin-only and returns actionable warnings", async () => {
    const { config, database } = testContext();
    const { project, deployment } = activeProject(database);
    const now = Date.now();
    database.insertProjectMetricSample(sample(project.id, deployment.id, now, {
      health_status: "unhealthy",
      restart_count: 3,
      oom_killed: 1,
      cpu_usage_percent: 96,
      memory_usage_percent: 95
    }));
    database.insertRuntimeLogs([{
      project_id: project.id,
      deployment_id: deployment.id,
      stream: "stdout",
      message: "application booted",
      source_timestamp: new Date(now).toISOString(),
      collected_at: new Date(now).toISOString()
    }]);
    database.createDeployment({
      ...deployment,
      id: "dep_previous",
      status: "ready",
      runtime_container: "shelter-run-observed-app-dep-previous",
      created_at: new Date(now - 60_000).toISOString()
    });
    database.insertRuntimeLogs([{
      project_id: project.id,
      deployment_id: "dep_previous",
      stream: "stderr",
      message: "old deployment output must stay hidden",
      source_timestamp: new Date(now - 60_000).toISOString(),
      collected_at: new Date(now - 60_000).toISOString()
    }]);
    const app = await createApp(config, database);
    try {
      const anonymous = await app.inject({ method: "GET", url: `/api/projects/${project.id}/observability?range=1h` });
      expect(anonymous.statusCode).toBe(401);
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "admin@example.com", password: "correct horse battery staple" }
      });
      const cookie = login.cookies.find((entry) => entry.name === "shelter_session");
      const headers = { cookie: `${cookie?.name ?? "shelter_session"}=${cookie?.value ?? ""}` };
      const token = await app.inject({
        method: "POST",
        url: "/api/settings/api-tokens",
        headers: {
          ...headers,
          "x-csrf-token": login.json().csrfToken as string,
          origin: "http://localhost:7080",
          host: "localhost:7080"
        },
        payload: {
          name: "Observability must stay private",
          access: "read",
          expiresInDays: 1,
          currentPassword: "correct horse battery staple"
        }
      });
      expect(token.statusCode).toBe(201);
      const tokenRejected = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/observability?range=1h`,
        headers: { authorization: `Bearer ${token.json().secret as string}` }
      });
      expect(tokenRejected.statusCode).toBe(403);
      expect(tokenRejected.json().code).toBe("SESSION_REQUIRED");
      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/observability?range=1h`,
        headers
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({
        status: "critical",
        activeDeploymentId: deployment.id,
        current: {
          runtime: { health: "unhealthy", restartCount: 3, oomKilled: true },
          cpu: { usagePercent: 96, limitCores: 1, limitUsagePercent: 96 },
          memory: { usagePercent: 95 }
        }
      });
      expect(response.json().warnings.map((warning: { id: string }) => warning.id)).toEqual([
        "health", "oom", "restarts", "cpu", "memory"
      ]);
      const logs = await app.inject({ method: "GET", url: `/api/projects/${project.id}/runtime-logs`, headers });
      expect(logs.statusCode).toBe(200);
      expect(logs.headers["cache-control"]).toBe("no-store");
      expect(logs.json().logs).toEqual([expect.objectContaining({ message: "application booted", deploymentId: deployment.id })]);
      expect(logs.body).not.toContain("old deployment output");
      const malformedCursor = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/runtime-logs?after=not-a-cursor`,
        headers
      });
      const excessiveLimit = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/runtime-logs?limit=501`,
        headers
      });
      expect(malformedCursor.statusCode).toBe(400);
      expect(excessiveLimit.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
