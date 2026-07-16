import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { requireSessionAuth } from "../services/auth.js";
import type { ProjectMetricSampleRow, RuntimeLogRow } from "../types/models.js";

const RangeSchema = z.enum(["15m", "1h", "6h", "24h", "48h"]);
const RuntimeLogQuerySchema = z.object({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(500)
});
const RuntimeLogStreamQuerySchema = RuntimeLogQuerySchema.pick({ after: true });
type ProjectMetricsRange = z.infer<typeof RangeSchema>;

const rangeMilliseconds: Record<ProjectMetricsRange, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "48h": 48 * 60 * 60_000
};

type ProjectObservabilityStatus = "collecting" | "healthy" | "warning" | "critical" | "stale";

function overallStatus(sample: ProjectMetricSampleRow | undefined, now: number, intervalSeconds: number): ProjectObservabilityStatus {
  if (!sample) return "collecting";
  if (now - sample.sampled_at > intervalSeconds * 2_500) return "stale";
  if (
    sample.oom_killed === 1
    || sample.health_status === "unhealthy"
    || ["dead", "missing"].includes(sample.runtime_status)
  ) return "critical";
  const cpuCapacity = sample.cpu_limit_cores * 100;
  const cpuLimitUsage = cpuCapacity > 0 ? sample.cpu_usage_percent / cpuCapacity * 100 : 0;
  if (
    ["exited", "restarting", "paused", "unknown"].includes(sample.runtime_status)
    || sample.health_status === "starting"
    || sample.memory_usage_percent >= 90
    || cpuLimitUsage >= 90
  ) return "warning";
  return "healthy";
}

function currentPayload(sample: ProjectMetricSampleRow) {
  const cpuCapacity = sample.cpu_limit_cores * 100;
  return {
    deploymentId: sample.deployment_id,
    runtime: {
      status: sample.runtime_status,
      health: sample.health_status,
      startedAt: sample.started_at,
      uptimeSeconds: sample.uptime_seconds,
      restartCount: sample.restart_count,
      oomKilled: sample.oom_killed === 1
    },
    cpu: {
      usagePercent: sample.cpu_usage_percent,
      limitCores: sample.cpu_limit_cores,
      limitUsagePercent: cpuCapacity > 0
        ? Math.round(Math.max(0, sample.cpu_usage_percent / cpuCapacity * 100) * 100) / 100
        : 0
    },
    memory: {
      usedBytes: sample.memory_used_bytes,
      limitBytes: sample.memory_limit_bytes,
      usagePercent: sample.memory_usage_percent
    },
    network: {
      receivedBytes: sample.network_received_bytes,
      transmittedBytes: sample.network_transmitted_bytes,
      receiveBytesPerSecond: sample.network_receive_bytes_per_second,
      transmitBytesPerSecond: sample.network_transmit_bytes_per_second
    },
    blockIo: {
      readBytes: sample.block_read_bytes,
      writeBytes: sample.block_write_bytes
    }
  };
}

function warningPayload(sample: ProjectMetricSampleRow) {
  const warnings: Array<{
    id: "runtime" | "health" | "oom" | "restarts" | "cpu" | "memory";
    severity: "warning" | "critical";
    value?: number;
  }> = [];
  if (["dead", "missing"].includes(sample.runtime_status)) warnings.push({ id: "runtime", severity: "critical" });
  else if (["exited", "restarting", "paused", "unknown"].includes(sample.runtime_status)) warnings.push({ id: "runtime", severity: "warning" });
  if (sample.health_status === "unhealthy") warnings.push({ id: "health", severity: "critical" });
  else if (sample.health_status === "starting") warnings.push({ id: "health", severity: "warning" });
  if (sample.oom_killed === 1) warnings.push({ id: "oom", severity: "critical" });
  if (sample.restart_count > 0) warnings.push({ id: "restarts", severity: "warning", value: sample.restart_count });
  const cpuLimitUsage = sample.cpu_limit_cores > 0
    ? sample.cpu_usage_percent / (sample.cpu_limit_cores * 100) * 100
    : 0;
  if (cpuLimitUsage >= 90) warnings.push({ id: "cpu", severity: cpuLimitUsage >= 100 ? "critical" : "warning", value: cpuLimitUsage });
  if (sample.memory_usage_percent >= 90) warnings.push({
    id: "memory",
    severity: sample.memory_usage_percent >= 98 ? "critical" : "warning",
    value: sample.memory_usage_percent
  });
  return warnings;
}

function presentRuntimeLog(log: RuntimeLogRow) {
  return {
    id: log.id,
    deploymentId: log.deployment_id,
    stream: log.stream,
    message: log.message,
    timestamp: log.source_timestamp,
    collectedAt: log.collected_at
  };
}

export function registerProjectObservabilityRoutes(app: FastifyInstance, config: AppConfig, database: Database): void {
  app.get<{
    Params: { projectId: string };
    Querystring: { range?: string };
  }>("/api/projects/:projectId/observability", {
    preHandler: requireSessionAuth,
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const project = database.getProject(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Projekt nicht gefunden", code: "NOT_FOUND" });
    const range = RangeSchema.parse(request.query.range ?? "1h");
    const now = Date.now();
    const latestSample = database.latestProjectMetricSample(project.id);
    const latest = latestSample?.deployment_id === project.active_deployment_id ? latestSample : undefined;
    const history = database.listProjectMetricHistory(project.id, now - rangeMilliseconds[range], now, 180);
    return {
      status: overallStatus(latest, now, config.METRICS_INTERVAL_SECONDS),
      sampledAt: latest ? new Date(latest.sampled_at).toISOString() : null,
      intervalSeconds: config.METRICS_INTERVAL_SECONDS,
      retentionHours: config.METRICS_RETENTION_HOURS,
      range,
      activeDeploymentId: project.active_deployment_id,
      current: latest ? currentPayload(latest) : null,
      warnings: latest ? warningPayload(latest) : [],
      history: history.map((sample) => ({
        sampledAt: new Date(sample.sampled_at).toISOString(),
        cpuUsagePercent: sample.cpu_usage_percent,
        memoryUsedBytes: sample.memory_used_bytes,
        memoryLimitBytes: sample.memory_limit_bytes,
        memoryUsagePercent: sample.memory_usage_percent,
        networkReceiveBytesPerSecond: sample.network_receive_bytes_per_second,
        networkTransmitBytesPerSecond: sample.network_transmit_bytes_per_second,
        blockReadBytes: sample.block_read_bytes,
        blockWriteBytes: sample.block_write_bytes
      }))
    };
  });

  app.get<{
    Params: { projectId: string };
    Querystring: { after?: string; limit?: string };
  }>("/api/projects/:projectId/runtime-logs", {
    preHandler: requireSessionAuth,
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const project = database.getProject(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Projekt nicht gefunden", code: "NOT_FOUND" });
    const { after, limit } = RuntimeLogQuerySchema.parse(request.query);
    const logs = project.active_deployment_id
      ? after > 0
        ? database.listRuntimeLogs(project.id, project.active_deployment_id, after, limit)
        : database.latestRuntimeLogs(project.id, project.active_deployment_id, limit)
      : [];
    return {
      activeDeploymentId: project.active_deployment_id,
      logs: logs.map(presentRuntimeLog)
    };
  });

  app.get<{
    Params: { projectId: string };
    Querystring: { after?: string };
  }>("/api/projects/:projectId/runtime-logs/stream", {
    preHandler: requireSessionAuth,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const initialProject = database.getProject(request.params.projectId);
    if (!initialProject) return reply.code(404).send({ error: "Projekt nicht gefunden", code: "NOT_FOUND" });
    let { after: cursor } = RuntimeLogStreamQuerySchema.parse(request.query);
    let closed = false;
    const startedAt = Date.now();
    request.raw.once("close", () => { closed = true; });
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    const write = (chunk: string): boolean => {
      if (closed || reply.raw.writableEnded || reply.raw.destroyed) {
        closed = true;
        return false;
      }
      try {
        reply.raw.write(chunk);
        return true;
      } catch {
        closed = true;
        return false;
      }
    };
    write("retry: 3000\n: connected\n\n");

    let activeDeploymentId = initialProject.active_deployment_id;
    while (!closed && !reply.raw.writableEnded) {
      const currentProject = database.getProject(initialProject.id);
      if (!currentProject) {
        write(`event: complete\ndata: ${JSON.stringify({ reason: "project_removed" })}\n\n`);
        break;
      }
      if (currentProject.active_deployment_id !== activeDeploymentId) {
        activeDeploymentId = currentProject.active_deployment_id;
        if (!write(`event: deployment\ndata: ${JSON.stringify({ activeDeploymentId })}\n\n`)) break;
      }
      const logs = activeDeploymentId
        ? database.listRuntimeLogs(initialProject.id, activeDeploymentId, cursor, 500)
        : [];
      for (const log of logs) {
        cursor = log.id;
        if (!write(`id: ${log.id}\nevent: log\ndata: ${JSON.stringify(presentRuntimeLog(log))}\n\n`)) break;
      }
      if (closed) break;
      if (reply.raw.writableLength > 1_000_000) break;
      if (Date.now() - startedAt >= 10 * 60_000) {
        write(`event: reconnect\ndata: ${JSON.stringify({ after: cursor })}\n\n`);
        break;
      }
      if (logs.length === 0 && !write(": keepalive\n\n")) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!reply.raw.writableEnded && !reply.raw.destroyed) {
      try {
        reply.raw.end();
      } catch {
        // The browser may close while the final event is being flushed.
      }
    }
  });
}
