import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { requireSessionAuth } from "../services/auth.js";
import type { ServerMetricSampleRow, ServerServiceStatus } from "../types/models.js";

const RangeSchema = z.enum(["1h", "6h", "24h"]);
type MetricsRange = z.infer<typeof RangeSchema>;
type HealthStatus = "healthy" | "warning" | "critical" | "unknown";
type HealthId = "collector" | "worker" | "docker" | "cpu" | "memory" | "storage" | "traefik" | "cloudflared";

const rangeMilliseconds: Record<MetricsRange, number> = {
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000
};

function capacityHealth(usagePercent: number): HealthStatus {
  if (usagePercent >= 90) return "critical";
  if (usagePercent >= 80) return "warning";
  return "healthy";
}

function serviceHealth(status: ServerServiceStatus): HealthStatus {
  if (status === "online") return "healthy";
  if (status === "offline") return "critical";
  return "unknown";
}

function workerHealth(database: Database, now: number): HealthStatus {
  const heartbeat = database.getSetting("worker.heartbeat");
  if (!heartbeat) return "unknown";
  const heartbeatAt = Date.parse(heartbeat);
  if (!Number.isFinite(heartbeatAt)) return "unknown";
  const age = now - heartbeatAt;
  if (age <= 15_000) return "healthy";
  if (age <= 60_000) return "warning";
  return "critical";
}

export function sustainedCpuHealth(
  samples: ServerMetricSampleRow[],
  now: number,
  intervalSeconds: number
): HealthStatus {
  const current = samples[0];
  if (!current) return "unknown";

  // Collection includes bounded Docker calls, so a healthy series can take
  // slightly longer than the configured interval. Beyond 2.5 intervals the
  // values no longer represent a recent, contiguous sustained condition.
  const maximumSampleGap = Math.max(1, intervalSeconds) * 2_500;
  const currentAge = now - current.sampled_at;
  if (currentAge < -maximumSampleGap || currentAge > maximumSampleGap) return "unknown";
  if (current.cpu_usage_percent < 80) return "healthy";
  if (samples.length < 3) return "unknown";

  const recent = samples.slice(0, 3);
  for (let index = 1; index < recent.length; index += 1) {
    const newer = recent[index - 1];
    const older = recent[index];
    if (!newer || !older) return "unknown";
    const gap = newer.sampled_at - older.sampled_at;
    if (gap <= 0 || gap > maximumSampleGap) return "unknown";
  }
  if (recent.every((sample) => sample.cpu_usage_percent >= 95)) return "critical";
  if (recent.every((sample) => sample.cpu_usage_percent >= 80)) return "warning";
  return "healthy";
}

function currentPayload(sample: ServerMetricSampleRow) {
  return {
    host: {
      name: sample.host_name,
      operatingSystem: sample.host_operating_system,
      kernel: sample.host_kernel,
      architecture: sample.host_architecture,
      uptimeSeconds: sample.host_uptime_seconds
    },
    cpu: {
      usagePercent: sample.cpu_usage_percent,
      logicalCores: sample.cpu_logical_cores,
      loadAverage: {
        one: sample.load_one,
        five: sample.load_five,
        fifteen: sample.load_fifteen
      }
    },
    memory: {
      totalBytes: sample.memory_total_bytes,
      usedBytes: sample.memory_used_bytes,
      availableBytes: sample.memory_available_bytes,
      usagePercent: sample.memory_usage_percent,
      swapTotalBytes: sample.swap_total_bytes,
      swapUsedBytes: sample.swap_used_bytes
    },
    storage: {
      totalBytes: sample.storage_total_bytes,
      usedBytes: sample.storage_used_bytes,
      availableBytes: sample.storage_available_bytes,
      usagePercent: sample.storage_usage_percent
    },
    runtime: {
      dockerAvailable: sample.docker_available === 1,
      dockerVersion: sample.docker_version,
      managedContainers: sample.managed_containers,
      runningManagedContainers: sample.running_managed_containers,
      applicationCpuUsagePercent: sample.application_cpu_usage_percent,
      applicationMemoryUsedBytes: sample.application_memory_used_bytes,
      applicationMemoryLimitBytes: sample.application_memory_limit_bytes,
      applicationNetworkReceivedBytes: sample.application_network_received_bytes,
      applicationNetworkTransmittedBytes: sample.application_network_transmitted_bytes,
      applicationNetworkReceiveBytesPerSecond: sample.application_network_receive_bytes_per_second,
      applicationNetworkTransmitBytesPerSecond: sample.application_network_transmit_bytes_per_second,
      applicationBlockReadBytes: sample.application_block_read_bytes,
      applicationBlockWriteBytes: sample.application_block_write_bytes,
      services: {
        api: sample.service_api,
        worker: sample.service_worker,
        traefik: sample.service_traefik,
        cloudflared: sample.service_cloudflared
      },
      lastStorageMaintenanceAt: sample.last_storage_maintenance_at,
      tunnelConfigured: sample.tunnel_configured === 1
    }
  };
}

export function registerServerMetricsRoutes(app: FastifyInstance, config: AppConfig, database: Database): void {
  app.get<{ Querystring: { range?: string } }>("/api/server/metrics", {
    preHandler: requireSessionAuth
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const range = RangeSchema.parse(request.query.range ?? "1h");
    const now = Date.now();
    const latest = database.latestServerMetricSample();
    const recent = database.listRecentServerMetricSamples(3);
    const activity = database.serverActivityCounts(now);
    const history = database.listServerMetricHistory(now - rangeMilliseconds[range], now, 180);
    const collectorStatus: HealthStatus = !latest
      ? "unknown"
      : now - latest.sampled_at <= config.METRICS_INTERVAL_SECONDS * 2_500
        ? "healthy"
        : now - latest.sampled_at <= config.METRICS_INTERVAL_SECONDS * 6_000
          ? "warning"
          : "critical";
    const health: Array<{ id: HealthId; status: HealthStatus }> = [
      { id: "collector", status: collectorStatus },
      { id: "worker", status: workerHealth(database, now) },
      { id: "docker", status: latest ? (latest.docker_available === 1 ? "healthy" : "critical") : "unknown" },
      { id: "cpu", status: sustainedCpuHealth(recent, now, config.METRICS_INTERVAL_SECONDS) },
      { id: "memory", status: latest ? capacityHealth(latest.memory_usage_percent) : "unknown" },
      { id: "storage", status: latest ? capacityHealth(latest.storage_usage_percent) : "unknown" },
      { id: "traefik", status: latest ? serviceHealth(latest.service_traefik) : "unknown" },
      { id: "cloudflared", status: latest ? serviceHealth(latest.service_cloudflared) : "unknown" }
    ];
    const status = !latest
      ? "collecting" as const
      : health.some((item) => item.status === "critical")
        ? "critical" as const
        : health.some((item) => item.status === "warning")
          ? "warning" as const
          : "healthy" as const;

    return {
      status,
      sampledAt: latest ? new Date(latest.sampled_at).toISOString() : null,
      intervalSeconds: config.METRICS_INTERVAL_SECONDS,
      range,
      current: latest ? currentPayload(latest) : null,
      activity: {
        projects: activity.projects,
        liveProjects: activity.live_projects,
        domains: activity.domains,
        deployments: {
          queued: activity.deployments_queued,
          active: activity.deployments_active,
          readyLast24Hours: activity.deployments_ready_last_24_hours,
          failedLast24Hours: activity.deployments_failed_last_24_hours
        }
      },
      health,
      history: history.map((sample) => ({
        sampledAt: new Date(sample.sampled_at).toISOString(),
        cpuUsagePercent: sample.cpu_usage_percent,
        memoryUsagePercent: sample.memory_usage_percent,
        storageUsagePercent: sample.storage_usage_percent,
        loadOne: sample.load_one,
        applicationNetworkReceiveBytesPerSecond: sample.application_network_receive_bytes_per_second,
        applicationNetworkTransmitBytesPerSecond: sample.application_network_transmit_bytes_per_second
      }))
    };
  });
}
