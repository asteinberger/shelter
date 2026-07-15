import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { sustainedCpuHealth } from "../src/routes/server-metrics.js";
import { calculateCpuUsage, parseHumanBytes, parseProcMeminfo } from "../src/services/server-metrics.js";
import type { ServerMetricSampleRow } from "../src/types/models.js";

const temporaryDirectories: string[] = [];

function testDatabase() {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-metrics-"));
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
  return { config, database: new Database(config) };
}

function sample(sampledAt: number, overrides: Partial<ServerMetricSampleRow> = {}): ServerMetricSampleRow {
  return {
    sampled_at: sampledAt,
    host_name: "raum-hosting",
    host_operating_system: "Ubuntu 26.04 LTS",
    host_kernel: "7.0.0-15-generic",
    host_architecture: "x86_64",
    host_uptime_seconds: 86_400,
    cpu_usage_percent: 20,
    cpu_logical_cores: 2,
    load_one: 0.4,
    load_five: 0.3,
    load_fifteen: 0.2,
    memory_total_bytes: 4_000_000_000,
    memory_used_bytes: 2_000_000_000,
    memory_available_bytes: 2_000_000_000,
    memory_usage_percent: 50,
    swap_total_bytes: 1_000_000_000,
    swap_used_bytes: 100_000_000,
    storage_total_bytes: 100_000_000_000,
    storage_used_bytes: 40_000_000_000,
    storage_available_bytes: 60_000_000_000,
    storage_usage_percent: 40,
    docker_available: 1,
    docker_version: "29.6.1",
    managed_containers: 2,
    running_managed_containers: 2,
    application_cpu_usage_percent: 3.5,
    application_memory_used_bytes: 200_000_000,
    application_memory_limit_bytes: 2_000_000_000,
    application_network_received_bytes: 5_000_000,
    application_network_transmitted_bytes: 2_000_000,
    application_network_receive_bytes_per_second: 2_500,
    application_network_transmit_bytes_per_second: 1_000,
    application_block_read_bytes: 100_000,
    application_block_write_bytes: 50_000,
    service_api: "online",
    service_worker: "online",
    service_traefik: "online",
    service_cloudflared: "not_configured",
    last_storage_maintenance_at: null,
    tunnel_configured: 0,
    ...overrides
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("server metrics parsing", () => {
  it("parses Docker byte units, proc memory and CPU deltas", () => {
    expect(parseHumanBytes("3.387MiB")).toBe(Math.round(3.387 * 1_048_576));
    expect(parseHumanBytes("57.9kB")).toBe(57_900);
    expect(parseHumanBytes("1 GiB")).toBe(1_073_741_824);
    expect(parseHumanBytes("invalid")).toBe(0);

    const memory = parseProcMeminfo("MemTotal:       3900684 kB\nMemAvailable:   2000000 kB\nSwapTotal:      500000 kB\nSwapFree:       450000 kB\n");
    expect(memory.get("MemTotal")).toBe(3_900_684 * 1_024);
    expect(memory.get("SwapFree")).toBe(450_000 * 1_024);
    expect(calculateCpuUsage({ idle: 50, total: 100 }, { idle: 80, total: 200 })).toBe(70);
    expect(calculateCpuUsage({ idle: 50, total: 100 }, { idle: 50, total: 100 })).toBeNull();
  });

  it("only treats recent contiguous CPU samples as sustained load", () => {
    const now = Date.now();
    const intervalSeconds = 15;
    const contiguous = [
      sample(now, { cpu_usage_percent: 96 }),
      sample(now - 15_000, { cpu_usage_percent: 97 }),
      sample(now - 30_000, { cpu_usage_percent: 98 })
    ];

    expect(sustainedCpuHealth(contiguous, now, intervalSeconds)).toBe("critical");
    expect(sustainedCpuHealth(contiguous.map((entry) => ({ ...entry, cpu_usage_percent: 85 })), now, intervalSeconds)).toBe("warning");
    expect(sustainedCpuHealth(contiguous.map((entry, index) => ({
      ...entry,
      cpu_usage_percent: index === 1 ? 40 : entry.cpu_usage_percent
    })), now, intervalSeconds)).toBe("healthy");

    const stale = contiguous.map((entry) => ({ ...entry, sampled_at: entry.sampled_at - 60_000 }));
    expect(sustainedCpuHealth(stale, now, intervalSeconds)).toBe("unknown");
    expect(sustainedCpuHealth([
      contiguous[0]!,
      contiguous[1]!,
      { ...contiguous[2]!, sampled_at: now - 60_000 }
    ], now, intervalSeconds)).toBe("unknown");
  });
});

describe("server metrics persistence", () => {
  it("downsamples history and enforces age and row retention", () => {
    const { database } = testDatabase();
    try {
      const now = Date.now();
      for (let index = 0; index < 240; index += 1) {
        database.insertServerMetricSample(sample(now - (239 - index) * 15_000, {
          cpu_usage_percent: index % 100
        }));
      }

      expect(database.latestServerMetricSample()?.sampled_at).toBe(now);
      expect(database.listRecentServerMetricSamples(3)).toHaveLength(3);
      const history = database.listServerMetricHistory(now - 60 * 60_000, now, 180);
      expect(history.length).toBeLessThanOrEqual(180);
      expect(history[0]?.sampled_at).toBeLessThanOrEqual(history.at(-1)?.sampled_at ?? 0);

      database.pruneServerMetricSamples(now - 10 * 60_000, 20);
      const remaining = database.sqlite.prepare("SELECT COUNT(*) AS count FROM server_metric_samples").get() as { count: number };
      expect(remaining.count).toBe(20);
    } finally {
      database.close();
    }
  });

  it("counts terminal deployments with indexed finished-at and created-at fallback ranges", () => {
    const { database } = testDatabase();
    try {
      const now = Date.now();
      const recent = new Date(now - 60 * 60_000).toISOString();
      const old = new Date(now - 25 * 60 * 60_000).toISOString();
      database.sqlite.prepare(`
        INSERT INTO projects (
          id, name, slug, source_type, root_directory, build_type, dockerfile_path,
          port, healthcheck_path, memory_limit, cpu_limit, created_at, updated_at
        ) VALUES ('prj_metrics', 'Metrics', 'metrics', 'git', '.', 'auto', 'Dockerfile',
          3000, '/', '1g', '1.0', @recent, @recent)
      `).run({ recent });
      const insert = database.sqlite.prepare(`
        INSERT INTO deployments (id, project_id, status, finished_at, created_at)
        VALUES (@id, 'prj_metrics', @status, @finished_at, @created_at)
      `);
      insert.run({ id: "dep_ready_finished_recent", status: "ready", finished_at: recent, created_at: old });
      insert.run({ id: "dep_ready_fallback_recent", status: "ready", finished_at: null, created_at: recent });
      insert.run({ id: "dep_ready_finished_old", status: "ready", finished_at: old, created_at: recent });
      insert.run({ id: "dep_failed_finished_recent", status: "failed", finished_at: recent, created_at: old });
      insert.run({ id: "dep_failed_fallback_old", status: "failed", finished_at: null, created_at: old });

      const counts = database.serverActivityCounts(now);
      expect(counts.deployments_ready_last_24_hours).toBe(2);
      expect(counts.deployments_failed_last_24_hours).toBe(1);

      const indexes = database.sqlite.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'deployments'
      `).all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toContain("deployments_terminal_activity_idx");

      const finishedPlans = database.sqlite.prepare(`
        EXPLAIN QUERY PLAN
        SELECT status FROM deployments
        WHERE status IN ('ready','failed') AND finished_at >= ?
      `).all(recent) as Array<{ detail: string }>;
      const fallbackPlans = database.sqlite.prepare(`
        EXPLAIN QUERY PLAN
        SELECT status FROM deployments
        WHERE status IN ('ready','failed') AND finished_at IS NULL AND created_at >= ?
      `).all(recent) as Array<{ detail: string }>;
      expect(finishedPlans.some((plan) => plan.detail.includes("deployments_terminal_activity_idx"))).toBe(true);
      expect(fallbackPlans.some((plan) => plan.detail.includes("deployments_terminal_activity_idx"))).toBe(true);
    } finally {
      database.close();
    }
  });
});

describe("GET /api/server/metrics", () => {
  it("is session-only, returns collecting during warm-up and bounds history to 180 points", async () => {
    const { config, database } = testDatabase();
    const app = await createApp(config, database);
    try {
      const anonymous = await app.inject({ method: "GET", url: "/api/server/metrics?range=1h" });
      expect(anonymous.statusCode).toBe(401);

      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "admin@example.com", password: "correct horse battery staple" }
      });
      const cookie = login.cookies.find((entry) => entry.name === "shelter_session");
      expect(cookie).toBeDefined();
      const headers = { cookie: `${cookie?.name ?? "shelter_session"}=${cookie?.value ?? ""}` };

      const apiToken = await app.inject({
        method: "POST",
        url: "/api/settings/api-tokens",
        headers: {
          ...headers,
          "x-csrf-token": login.json().csrfToken as string,
          origin: "http://localhost:7080",
          host: "localhost:7080"
        },
        payload: {
          name: "Metrics isolation",
          access: "read",
          expiresInDays: 1,
          currentPassword: "correct horse battery staple"
        }
      });
      expect(apiToken.statusCode).toBe(201);
      const tokenRejected = await app.inject({
        method: "GET",
        url: "/api/server/metrics?range=1h",
        headers: { authorization: `Bearer ${apiToken.json().secret as string}` }
      });
      expect(tokenRejected.statusCode).toBe(403);
      expect(tokenRejected.json().code).toBe("SESSION_REQUIRED");

      const warmup = await app.inject({ method: "GET", url: "/api/server/metrics?range=1h", headers });
      expect(warmup.statusCode).toBe(200);
      expect(warmup.headers["cache-control"]).toBe("no-store");
      expect(warmup.json()).toMatchObject({
        status: "collecting",
        sampledAt: null,
        intervalSeconds: 15,
        range: "1h",
        current: null,
        history: []
      });

      const now = Date.now();
      database.setSetting("worker.heartbeat", new Date(now).toISOString());
      for (let index = 0; index < 240; index += 1) {
        database.insertServerMetricSample(sample(now - (239 - index) * 15_000));
      }
      const response = await app.inject({ method: "GET", url: "/api/server/metrics?range=1h", headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const payload = response.json();
      expect(payload.status).toBe("healthy");
      expect(payload.current).toMatchObject({
        host: { name: "raum-hosting", architecture: "x86_64" },
        cpu: { usagePercent: 20, logicalCores: 2 },
        runtime: {
          dockerAvailable: true,
          dockerVersion: "29.6.1",
          services: { api: "online", worker: "online", traefik: "online", cloudflared: "not_configured" }
        }
      });
      expect(payload.activity).toEqual({
        projects: 0,
        liveProjects: 0,
        domains: 0,
        deployments: { queued: 0, active: 0, readyLast24Hours: 0, failedLast24Hours: 0 }
      });
      expect(payload.health.map((item: { id: string }) => item.id)).toEqual([
        "collector", "worker", "docker", "cpu", "memory", "storage", "traefik", "cloudflared"
      ]);
      expect(payload.history.length).toBeLessThanOrEqual(180);

      const invalid = await app.inject({ method: "GET", url: "/api/server/metrics?range=7d", headers });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
