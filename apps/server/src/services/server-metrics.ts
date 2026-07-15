import fs from "node:fs";
import os from "node:os";
import type { AppConfig } from "../config.js";
import { runCommand } from "../lib/command.js";
import type { Database } from "../lib/database.js";
import type { ServerMetricSampleRow, ServerServiceStatus } from "../types/models.js";
import { COMPOSE_PROJECT_NAMES } from "./runtime-identity.js";

const DOCKER_TIMEOUT_MS = 5_000;
const DOCKER_INFO_CACHE_MS = 5 * 60_000;
const DOCKER_INFO_FAILURE_CACHE_MS = 30_000;
const DOCKER_STATS_CACHE_MS = 15_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;

interface CpuSnapshot {
  idle: number;
  total: number;
}

interface DockerInfoSnapshot {
  available: boolean;
  name: string;
  version: string | null;
  operatingSystem: string;
  architecture: string;
  kernel: string;
}

interface ContainerProjection {
  available: boolean;
  managedIds: string[];
  runningManagedIds: string[];
  services: {
    api: ServerServiceStatus;
    worker: ServerServiceStatus;
    traefik: ServerServiceStatus;
    cloudflared: ServerServiceStatus;
  };
}

interface ApplicationMetrics {
  cpuUsagePercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  networkReceivedBytes: number;
  networkTransmittedBytes: number;
  networkReceiveBytesPerSecond: number;
  networkTransmitBytesPerSecond: number;
  blockReadBytes: number;
  blockWriteBytes: number;
}

interface CachedDockerInfo {
  checkedAt: number;
  value: DockerInfoSnapshot;
}

interface CachedApplicationMetrics {
  checkedAt: number;
  containerKey: string;
  value: ApplicationMetrics;
  available: boolean;
}

interface ApplicationMetricsSnapshot {
  value: ApplicationMetrics;
  available: boolean;
}

const emptyApplicationMetrics = (): ApplicationMetrics => ({
  cpuUsagePercent: 0,
  memoryUsedBytes: 0,
  memoryLimitBytes: 0,
  networkReceivedBytes: 0,
  networkTransmittedBytes: 0,
  networkReceiveBytesPerSecond: 0,
  networkTransmitBytesPerSecond: 0,
  blockReadBytes: 0,
  blockWriteBytes: 0
});

function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percent(used: number, total: number): number {
  if (total <= 0) return 0;
  return round(Math.max(0, Math.min(100, used / total * 100)));
}

function safeBigInt(value: bigint): number {
  if (value <= 0n) return 0;
  return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value);
}

export function parseHumanBytes(input: string): number {
  const match = input.trim().match(/^([0-9]+(?:[.,][0-9]+)?)\s*([kmgtpe]?i?b)$/i);
  if (!match) return 0;
  const amount = Number.parseFloat((match[1] ?? "0").replace(",", "."));
  if (!Number.isFinite(amount) || amount < 0) return 0;
  const unit = (match[2] ?? "b").toLowerCase();
  const powers: Record<string, number> = {
    b: 1,
    kb: 1_000,
    mb: 1_000_000,
    gb: 1_000_000_000,
    tb: 1_000_000_000_000,
    pb: 1_000_000_000_000_000,
    eb: 1_000_000_000_000_000_000,
    kib: 1_024,
    mib: 1_048_576,
    gib: 1_073_741_824,
    tib: 1_099_511_627_776,
    pib: 1_125_899_906_842_624,
    eib: 1_152_921_504_606_847_000
  };
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(amount * (powers[unit] ?? 1))));
}

function parseBytePair(input: string): [number, number] {
  const [left, right] = input.split("/");
  return [parseHumanBytes(left ?? ""), parseHumanBytes(right ?? "")];
}

export function parseProcMeminfo(input: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of input.split("\n")) {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/);
    if (match?.[1] && match[2]) values.set(match[1], Number.parseInt(match[2], 10) * 1_024);
  }
  return values;
}

export function calculateCpuUsage(previous: CpuSnapshot, current: CpuSnapshot): number | null {
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (total <= 0 || idle < 0) return null;
  return round(Math.max(0, Math.min(100, (total - idle) / total * 100)));
}

function cpuSnapshot(): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

function serviceStatus(states: string[], projectionAvailable: boolean): ServerServiceStatus {
  if (!projectionAvailable) return "unknown";
  if (states.some((state) => state === "running")) return "online";
  return states.length > 0 ? "offline" : "offline";
}

export class ServerMetricsCollector {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = true;
  private collecting = false;
  private previousCpu: CpuSnapshot | null = null;
  private dockerInfoCache: CachedDockerInfo | null = null;
  private applicationMetricsCache: CachedApplicationMetrics | null = null;
  private previousNetworkCounters: {
    checkedAt: number;
    containerKey: string;
    received: number;
    transmitted: number;
  } | null = null;
  private lastPruneAt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly database: Database
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.launchTick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.launchTick(), this.config.METRICS_INTERVAL_SECONDS * 1_000);
    this.timer.unref();
  }

  private launchTick(): void {
    if (this.stopped || this.inFlight) return;
    const pending = this.tick();
    this.inFlight = pending;
    void pending.finally(() => {
      if (this.inFlight === pending) this.inFlight = null;
    });
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.collecting) return;
    this.collecting = true;
    try {
      await this.collect();
    } catch {
      // Metrics are diagnostic. Collection failures must never stop deployments.
    } finally {
      this.collecting = false;
      this.schedule();
    }
  }

  private async collect(): Promise<void> {
    const currentCpu = cpuSnapshot();
    const previousCpu = this.previousCpu;
    this.previousCpu = currentCpu;
    if (!previousCpu) return;
    const cpuUsagePercent = calculateCpuUsage(previousCpu, currentCpu);
    if (cpuUsagePercent === null) return;

    const sampledAt = Date.now();
    const tunnelConfigured = Boolean(this.database.getSetting("cloudflare.tunnel_id"));
    const [dockerInfo, containers, memory, storage] = await Promise.all([
      this.dockerInfo(sampledAt),
      this.containerProjection(tunnelConfigured),
      this.memory(),
      this.storage()
    ]);
    if (this.stopped) return;
    const applications = containers.available
      ? await this.applicationMetrics(containers.runningManagedIds, sampledAt)
      : { value: emptyApplicationMetrics(), available: false };
    if (this.stopped) return;
    const load = os.loadavg();
    const logicalCores = Math.max(1, os.cpus().length);
    const dockerAvailable = dockerInfo.available && containers.available && applications.available;

    const sample: ServerMetricSampleRow = {
      sampled_at: sampledAt,
      host_name: dockerInfo.name || os.hostname(),
      host_operating_system: dockerInfo.operatingSystem || os.type(),
      host_kernel: dockerInfo.kernel || os.release(),
      host_architecture: dockerInfo.architecture || os.arch(),
      host_uptime_seconds: Math.max(0, Math.trunc(os.uptime())),
      cpu_usage_percent: cpuUsagePercent,
      cpu_logical_cores: logicalCores,
      load_one: Math.max(0, round(load[0] ?? 0)),
      load_five: Math.max(0, round(load[1] ?? 0)),
      load_fifteen: Math.max(0, round(load[2] ?? 0)),
      memory_total_bytes: memory.total,
      memory_used_bytes: memory.used,
      memory_available_bytes: memory.available,
      memory_usage_percent: percent(memory.used, memory.total),
      swap_total_bytes: memory.swapTotal,
      swap_used_bytes: memory.swapUsed,
      storage_total_bytes: storage.total,
      storage_used_bytes: storage.used,
      storage_available_bytes: storage.available,
      storage_usage_percent: percent(storage.used, storage.total),
      docker_available: dockerAvailable ? 1 : 0,
      docker_version: dockerInfo.version,
      managed_containers: containers.managedIds.length,
      running_managed_containers: containers.runningManagedIds.length,
      application_cpu_usage_percent: applications.value.cpuUsagePercent,
      application_memory_used_bytes: applications.value.memoryUsedBytes,
      application_memory_limit_bytes: applications.value.memoryLimitBytes,
      application_network_received_bytes: applications.value.networkReceivedBytes,
      application_network_transmitted_bytes: applications.value.networkTransmittedBytes,
      application_network_receive_bytes_per_second: applications.value.networkReceiveBytesPerSecond,
      application_network_transmit_bytes_per_second: applications.value.networkTransmitBytesPerSecond,
      application_block_read_bytes: applications.value.blockReadBytes,
      application_block_write_bytes: applications.value.blockWriteBytes,
      service_api: containers.services.api,
      service_worker: containers.services.worker,
      service_traefik: containers.services.traefik,
      service_cloudflared: containers.services.cloudflared,
      last_storage_maintenance_at: this.database.getSetting("worker.storage_maintenance") ?? null,
      tunnel_configured: tunnelConfigured ? 1 : 0
    };
    if (this.stopped) return;
    this.database.insertServerMetricSample(sample);

    if (sampledAt - this.lastPruneAt >= PRUNE_INTERVAL_MS) {
      const retentionMs = this.config.METRICS_RETENTION_HOURS * 60 * 60_000;
      const hardLimit = Math.ceil(retentionMs / (this.config.METRICS_INTERVAL_SECONDS * 1_000)) + 100;
      this.database.pruneServerMetricSamples(sampledAt - retentionMs, hardLimit);
      this.lastPruneAt = sampledAt;
    }
  }

  private async memory(): Promise<{
    total: number;
    used: number;
    available: number;
    swapTotal: number;
    swapUsed: number;
  }> {
    let values = new Map<string, number>();
    try {
      values = parseProcMeminfo(await fs.promises.readFile("/proc/meminfo", "utf8"));
    } catch {
      // Node's values are a safe fallback if procfs is unavailable.
    }
    const total = Math.max(0, values.get("MemTotal") ?? os.totalmem());
    const available = Math.max(0, Math.min(total, values.get("MemAvailable") ?? os.freemem()));
    const swapTotal = Math.max(0, values.get("SwapTotal") ?? 0);
    const swapFree = Math.max(0, Math.min(swapTotal, values.get("SwapFree") ?? swapTotal));
    return {
      total,
      used: Math.max(0, total - available),
      available,
      swapTotal,
      swapUsed: Math.max(0, swapTotal - swapFree)
    };
  }

  private async storage(): Promise<{ total: number; used: number; available: number }> {
    const stats = await fs.promises.statfs(this.config.DATA_DIR, { bigint: true });
    const total = safeBigInt(stats.blocks * stats.bsize);
    const available = Math.min(total, safeBigInt(stats.bavail * stats.bsize));
    return { total, used: Math.max(0, total - available), available };
  }

  private async dockerInfo(now: number): Promise<DockerInfoSnapshot> {
    if (this.dockerInfoCache) {
      const cacheDuration = this.dockerInfoCache.value.available
        ? DOCKER_INFO_CACHE_MS
        : DOCKER_INFO_FAILURE_CACHE_MS;
      if (now - this.dockerInfoCache.checkedAt < cacheDuration) return this.dockerInfoCache.value;
    }
    const fallback: DockerInfoSnapshot = {
      available: false,
      name: os.hostname(),
      version: null,
      operatingSystem: os.type(),
      architecture: os.arch(),
      kernel: os.release()
    };
    try {
      const result = await runCommand("docker", [
        "info",
        "--format",
        "{{.Name}}|{{.ServerVersion}}|{{.NCPU}}|{{.MemTotal}}|{{.OperatingSystem}}|{{.OSType}}|{{.Architecture}}|{{.KernelVersion}}"
      ], { allowFailure: true, timeoutMs: DOCKER_TIMEOUT_MS });
      if (result.exitCode !== 0) {
        this.dockerInfoCache = { checkedAt: now, value: fallback };
        return fallback;
      }
      const fields = result.stdout.split("|");
      const value: DockerInfoSnapshot = {
        available: true,
        name: fields[0]?.trim() || fallback.name,
        version: fields[1]?.trim() || null,
        operatingSystem: fields[4]?.trim() || fields[5]?.trim() || fallback.operatingSystem,
        architecture: fields[6]?.trim() || fallback.architecture,
        kernel: fields[7]?.trim() || fallback.kernel
      };
      this.dockerInfoCache = { checkedAt: now, value };
      return value;
    } catch {
      this.dockerInfoCache = { checkedAt: now, value: fallback };
      return fallback;
    }
  }

  private async containerProjection(tunnelConfigured: boolean): Promise<ContainerProjection> {
    const unknown: ContainerProjection = {
      available: false,
      managedIds: [],
      runningManagedIds: [],
      services: {
        api: "unknown",
        worker: "unknown",
        traefik: "unknown",
        cloudflared: tunnelConfigured ? "unknown" : "not_configured"
      }
    };
    try {
      const format = '{{.ID}}|{{.State}}|{{.Label "shelter.managed"}}|{{.Label "portsmith.managed"}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}';
      const result = await runCommand("docker", ["ps", "-a", "--no-trunc", "--format", format], {
        allowFailure: true,
        timeoutMs: DOCKER_TIMEOUT_MS
      });
      if (result.exitCode !== 0) return unknown;
      const managedIds: string[] = [];
      const runningManagedIds: string[] = [];
      const serviceStates = new Map<string, string[]>();
      for (const line of result.stdout.split("\n").filter(Boolean)) {
        const [id = "", state = "", shelterManaged = "", legacyManaged = "", project = "", service = ""] = line.split("|");
        if ((shelterManaged === "true" || legacyManaged === "true") && id) {
          managedIds.push(id);
          if (state === "running") runningManagedIds.push(id);
        }
        if (COMPOSE_PROJECT_NAMES.includes(project as (typeof COMPOSE_PROJECT_NAMES)[number]) && service) {
          serviceStates.set(service, [...(serviceStates.get(service) ?? []), state]);
        }
      }
      return {
        available: true,
        managedIds,
        runningManagedIds,
        services: {
          api: serviceStatus(serviceStates.get("api") ?? [], true),
          worker: serviceStatus(serviceStates.get("worker") ?? [], true),
          traefik: serviceStatus(serviceStates.get("traefik") ?? [], true),
          cloudflared: tunnelConfigured
            ? serviceStatus(serviceStates.get("cloudflared") ?? [], true)
            : "not_configured"
        }
      };
    } catch {
      return unknown;
    }
  }

  private async applicationMetrics(runningManagedIds: string[], now: number): Promise<ApplicationMetricsSnapshot> {
    const containerKey = [...runningManagedIds].sort().join(",");
    if (
      this.applicationMetricsCache
      && this.applicationMetricsCache.containerKey === containerKey
      && now - this.applicationMetricsCache.checkedAt < DOCKER_STATS_CACHE_MS
    ) {
      return {
        value: this.applicationMetricsCache.value,
        available: this.applicationMetricsCache.available
      };
    }
    if (runningManagedIds.length === 0) {
      const value = emptyApplicationMetrics();
      this.applicationMetricsCache = { checkedAt: now, containerKey, value, available: true };
      this.previousNetworkCounters = { checkedAt: now, containerKey, received: 0, transmitted: 0 };
      return { value, available: true };
    }
    try {
      const format = "{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}|{{.BlockIO}}";
      const result = await runCommand("docker", [
        "stats", "--no-stream", "--format", format, ...runningManagedIds
      ], { allowFailure: true, timeoutMs: DOCKER_TIMEOUT_MS });
      if (result.exitCode !== 0) {
        const value = emptyApplicationMetrics();
        this.applicationMetricsCache = { checkedAt: now, containerKey, value, available: false };
        return { value, available: false };
      }

      const value = emptyApplicationMetrics();
      for (const line of result.stdout.split("\n").filter(Boolean)) {
        const [cpu = "", memory = "", network = "", block = ""] = line.split("|");
        const cpuValue = Number.parseFloat(cpu.replace("%", "").replace(",", "."));
        if (Number.isFinite(cpuValue) && cpuValue >= 0) value.cpuUsagePercent += cpuValue;
        const [memoryUsed, memoryLimit] = parseBytePair(memory);
        const [networkReceived, networkTransmitted] = parseBytePair(network);
        const [blockRead, blockWrite] = parseBytePair(block);
        value.memoryUsedBytes += memoryUsed;
        value.memoryLimitBytes += memoryLimit;
        value.networkReceivedBytes += networkReceived;
        value.networkTransmittedBytes += networkTransmitted;
        value.blockReadBytes += blockRead;
        value.blockWriteBytes += blockWrite;
      }
      value.cpuUsagePercent = round(value.cpuUsagePercent);
      const previous = this.previousNetworkCounters;
      if (
        previous
        && previous.containerKey === containerKey
        && now > previous.checkedAt
        && value.networkReceivedBytes >= previous.received
        && value.networkTransmittedBytes >= previous.transmitted
      ) {
        const elapsedSeconds = (now - previous.checkedAt) / 1_000;
        value.networkReceiveBytesPerSecond = round((value.networkReceivedBytes - previous.received) / elapsedSeconds);
        value.networkTransmitBytesPerSecond = round((value.networkTransmittedBytes - previous.transmitted) / elapsedSeconds);
      }
      this.previousNetworkCounters = {
        checkedAt: now,
        containerKey,
        received: value.networkReceivedBytes,
        transmitted: value.networkTransmittedBytes
      };
      this.applicationMetricsCache = { checkedAt: now, containerKey, value, available: true };
      return { value, available: true };
    } catch {
      const value = emptyApplicationMetrics();
      this.applicationMetricsCache = { checkedAt: now, containerKey, value, available: false };
      return { value, available: false };
    }
  }
}
