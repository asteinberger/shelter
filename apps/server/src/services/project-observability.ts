import type { AppConfig } from "../config.js";
import { parseDockerMemoryBytes } from "../config.js";
import type { CommandOptions, CommandResult } from "../lib/command.js";
import { runCommand } from "../lib/command.js";
import type { Database } from "../lib/database.js";
import { decryptString } from "../lib/security.js";
import type {
  ProjectMetricSampleRow,
  ProjectRuntimeHealth,
  ProjectRuntimeStatus,
  RuntimeLogRow
} from "../types/models.js";
import { parseHumanBytes } from "./server-metrics.js";

const DOCKER_TIMEOUT_MS = 5_000;
const COLLECTION_TIMEOUT_MS = 10_000;
const LOG_TAIL_LINES = 500;
const MAX_LOG_LINE_BYTES = 4_096;
const MAX_LOG_LINES_PER_PROJECT = 5_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const containerIdPattern = /^[a-f0-9]{12,64}$/;

export type ObservabilityCommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions
) => Promise<CommandResult>;

interface RuntimeTarget {
  projectId: string;
  deploymentId: string;
  expectedName: string | null;
  cpuLimitCores: number;
  memoryLimitBytes: number;
}

interface DiscoveredContainer {
  id: string;
  name: string;
  projectId: string;
  deploymentId: string;
}

interface InspectedContainer {
  id: string;
  name: string;
  status: ProjectRuntimeStatus;
  health: ProjectRuntimeHealth;
  startedAt: string | null;
  restartCount: number;
  oomKilled: boolean;
}

interface ContainerStats {
  cpuUsagePercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  networkReceivedBytes: number;
  networkTransmittedBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
}

interface PreviousNetworkCounters {
  checkedAt: number;
  deploymentId: string;
  containerId: string;
  received: number;
  transmitted: number;
}

function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percent(used: number, total: number): number {
  return total > 0 ? round(Math.max(0, Math.min(100, used / total * 100))) : 0;
}

function safePositiveNumber(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseBytePair(input: string): [number, number] {
  const [left, right] = input.split("/");
  return [parseHumanBytes(left ?? ""), parseHumanBytes(right ?? "")];
}

function parseRuntimeStatus(value: string): ProjectRuntimeStatus {
  return ["created", "running", "paused", "restarting", "removing", "exited", "dead"].includes(value)
    ? value as ProjectRuntimeStatus
    : "unknown";
}

function parseRuntimeHealth(value: string): ProjectRuntimeHealth {
  return ["healthy", "unhealthy", "starting", "none"].includes(value)
    ? value as ProjectRuntimeHealth
    : "unknown";
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseRuntimeLogLine(line: string): { sourceTimestamp: string; message: string } | null {
  const separator = line.indexOf(" ");
  if (separator <= 0) return null;
  const sourceTimestamp = line.slice(0, separator);
  if (!Number.isFinite(Date.parse(sourceTimestamp))) return null;
  const message = Buffer.from(line.slice(separator + 1), "utf8").subarray(0, MAX_LOG_LINE_BYTES).toString("utf8").trimEnd();
  return message ? { sourceTimestamp, message } : null;
}

function escapedExpression(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
}

export function redactRuntimeLog(message: string, secretValues: string[]): string {
  const fragments = new Set<string>();
  for (const value of secretValues) {
    if (!value) continue;
    fragments.add(value);
    for (const line of value.split(/\r?\n/)) if (line) fragments.add(line);
  }
  let redacted = message;
  for (const secret of [...fragments].sort((left, right) => right.length - left.length)) {
    if (secret.length >= 4) {
      redacted = redacted.replace(escapedExpression(secret), "[REDACTED]");
      continue;
    }
    const expression = escapedExpression(secret).source;
    redacted = redacted.replace(new RegExp(`(^|[^A-Za-z0-9_])(${expression})(?=$|[^A-Za-z0-9_])`, "g"), "$1[REDACTED]");
  }
  return redacted;
}

export function parseProjectStatsLine(line: string): { name: string; stats: ContainerStats } | null {
  const [name = "", cpu = "", memory = "", network = "", block = ""] = line.split("|");
  if (!name) return null;
  const cpuMatch = /^\s*([0-9]+(?:[.,][0-9]+)?)%\s*$/.exec(cpu);
  const cpuValue = cpuMatch ? Number.parseFloat((cpuMatch[1] ?? "0").replaceAll(",", ".")) : Number.NaN;
  const [memoryUsedBytes, memoryLimitBytes] = parseBytePair(memory);
  const [networkReceivedBytes, networkTransmittedBytes] = parseBytePair(network);
  const [blockReadBytes, blockWriteBytes] = parseBytePair(block);
  return {
    name,
    stats: {
      cpuUsagePercent: Number.isFinite(cpuValue) && cpuValue >= 0 ? round(cpuValue) : 0,
      memoryUsedBytes,
      memoryLimitBytes,
      networkReceivedBytes,
      networkTransmittedBytes,
      blockReadBytes,
      blockWriteBytes
    }
  };
}

export class ProjectObservabilityCollector {
  private readonly previousNetwork = new Map<string, PreviousNetworkCounters>();
  private lastPruneAt = 0;
  private activeController: AbortController | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
    private readonly command: ObservabilityCommandRunner = runCommand
  ) {}

  async collect(sampledAt = Date.now()): Promise<void> {
    if (this.activeController) return;
    const controller = new AbortController();
    this.activeController = controller;
    const timeout = setTimeout(() => controller.abort(), COLLECTION_TIMEOUT_MS);
    timeout.unref();
    try {
      await this.collectWithinDeadline(sampledAt, controller.signal);
    } finally {
      clearTimeout(timeout);
      if (this.activeController === controller) this.activeController = null;
    }
  }

  stop(): void {
    this.activeController?.abort();
  }

  private async collectWithinDeadline(sampledAt: number, signal: AbortSignal): Promise<void> {
    this.maintainRetention(sampledAt);
    const targets = this.targets();
    if (targets.length === 0) {
      this.previousNetwork.clear();
      return;
    }
    for (const target of targets) {
      this.database.pruneRuntimeLogsForProject(target.projectId, MAX_LOG_LINES_PER_PROJECT);
    }

    const discovered = await this.discoverActiveContainers(targets, signal);
    if (discovered === null) return;
    const inspections = await this.inspectContainers(discovered, signal);
    const running = discovered.filter((container) => inspections.get(container.id)?.status === "running");
    const stats = await this.stats(running, signal);
    const activeKeys = new Set<string>();

    for (const target of targets) {
      const key = `${target.projectId}:${target.deploymentId}`;
      activeKeys.add(key);
      const container = discovered.find((candidate) => (
        candidate.projectId === target.projectId && candidate.deploymentId === target.deploymentId
      ));
      const inspection = container ? inspections.get(container.id) : undefined;
      const containerStats = container ? stats.get(container.name) : undefined;
      const counters = this.networkRates(key, target, container, containerStats, sampledAt);
      const startedAtMs = inspection?.startedAt ? Date.parse(inspection.startedAt) : Number.NaN;
      const memoryLimitBytes = containerStats?.memoryLimitBytes || target.memoryLimitBytes;
      const sample: ProjectMetricSampleRow = {
        project_id: target.projectId,
        deployment_id: target.deploymentId,
        sampled_at: sampledAt,
        runtime_status: inspection?.status ?? "missing",
        health_status: inspection?.health ?? "unknown",
        started_at: inspection?.startedAt ?? null,
        uptime_seconds: Number.isFinite(startedAtMs) && inspection?.status === "running"
          ? Math.max(0, Math.trunc((sampledAt - startedAtMs) / 1_000))
          : 0,
        restart_count: inspection?.restartCount ?? 0,
        oom_killed: inspection?.oomKilled ? 1 : 0,
        cpu_usage_percent: containerStats?.cpuUsagePercent ?? 0,
        cpu_limit_cores: target.cpuLimitCores,
        memory_used_bytes: containerStats?.memoryUsedBytes ?? 0,
        memory_limit_bytes: memoryLimitBytes,
        memory_usage_percent: percent(containerStats?.memoryUsedBytes ?? 0, memoryLimitBytes),
        network_received_bytes: containerStats?.networkReceivedBytes ?? 0,
        network_transmitted_bytes: containerStats?.networkTransmittedBytes ?? 0,
        network_receive_bytes_per_second: counters.receivedPerSecond,
        network_transmit_bytes_per_second: counters.transmittedPerSecond,
        block_read_bytes: containerStats?.blockReadBytes ?? 0,
        block_write_bytes: containerStats?.blockWriteBytes ?? 0
      };
      this.database.insertProjectMetricSample(sample);
    }

    for (const key of this.previousNetwork.keys()) if (!activeKeys.has(key)) this.previousNetwork.delete(key);
    await this.collectRuntimeLogs(targets, discovered, signal);
  }

  private targets(): RuntimeTarget[] {
    const targets: RuntimeTarget[] = [];
    for (const project of this.database.listProjects()) {
      if (!project.active_deployment_id) continue;
      const deployment = this.database.getDeployment(project.active_deployment_id);
      if (!deployment || deployment.project_id !== project.id || deployment.status !== "ready") continue;
      targets.push({
        projectId: project.id,
        deploymentId: deployment.id,
        expectedName: deployment.runtime_container ?? null,
        cpuLimitCores: Math.max(0.1, safePositiveNumber(project.cpu_limit) || 1),
        memoryLimitBytes: Math.max(0, parseDockerMemoryBytes(project.memory_limit))
      });
    }
    return targets;
  }

  private async discoverActiveContainers(targets: RuntimeTarget[], signal: AbortSignal): Promise<DiscoveredContainer[] | null> {
    try {
      const format = '{{.ID}}|{{.Names}}|{{.Label "shelter.project"}}|{{.Label "shelter.deployment"}}';
      const result = await this.command("docker", [
        "ps", "-a", "--no-trunc", "--filter", "label=shelter.managed=true", "--format", format
      ], { allowFailure: true, timeoutMs: DOCKER_TIMEOUT_MS, signal });
      if (result.exitCode !== 0) return null;
      const expected = new Map(targets.map((target) => [`${target.projectId}:${target.deploymentId}`, target]));
      const containers: DiscoveredContainer[] = [];
      for (const line of result.stdout.split("\n").filter(Boolean)) {
        const [id = "", name = "", projectId = "", deploymentId = ""] = line.split("|");
        const target = expected.get(`${projectId}:${deploymentId}`);
        if (!containerIdPattern.test(id) || !name || !target) continue;
        if (target.expectedName && name !== target.expectedName) continue;
        containers.push({ id, name, projectId, deploymentId });
      }
      return containers;
    } catch {
      return null;
    }
  }

  private async inspectContainers(containers: DiscoveredContainer[], signal: AbortSignal): Promise<Map<string, InspectedContainer>> {
    const inspected = new Map<string, InspectedContainer>();
    if (containers.length === 0) return inspected;
    // Docker omits State.Health entirely for containers without a HEALTHCHECK.
    // Accessing that missing map key directly in a Go template makes the whole
    // multi-container inspect command fail. Serialize State as JSON instead and
    // treat an absent Health object as the valid Docker health value "none".
    const format = '{{json .Id}}\t{{json .Name}}\t{{json .State}}\t{{json .RestartCount}}';
    try {
      const result = await this.command("docker", ["inspect", "--format", format, ...containers.map(({ id }) => id)], {
        allowFailure: true,
        timeoutMs: DOCKER_TIMEOUT_MS,
        signal
      });
      if (result.exitCode !== 0) return inspected;
      for (const line of result.stdout.split("\n").filter(Boolean)) {
        const values = line.split("\t");
        if (values.length !== 4) continue;
        try {
          const id = JSON.parse(values[0] ?? "null") as unknown;
          const rawName = JSON.parse(values[1] ?? "null") as unknown;
          const state = recordValue(JSON.parse(values[2] ?? "null") as unknown);
          const restartCount = JSON.parse(values[3] ?? "0") as unknown;
          if (typeof id !== "string" || !containerIdPattern.test(id)) continue;
          const health = recordValue(state?.Health)?.Status;
          const status = state?.Status;
          const startedAt = state?.StartedAt;
          const oomKilled = state?.OOMKilled;
          inspected.set(id, {
            id,
            name: typeof rawName === "string" ? rawName.replace(/^\//, "") : "",
            status: parseRuntimeStatus(typeof status === "string" ? status : "unknown"),
            health: parseRuntimeHealth(typeof health === "string" ? health : "none"),
            startedAt: typeof startedAt === "string" && Number.isFinite(Date.parse(startedAt)) ? startedAt : null,
            restartCount: typeof restartCount === "number" && restartCount >= 0 ? Math.trunc(restartCount) : 0,
            oomKilled: oomKilled === true
          });
        } catch {
          // Ignore a malformed Docker row without dropping the remaining projects.
        }
      }
    } catch {
      // A failed inspect is reflected as an unknown/missing runtime sample.
    }
    return inspected;
  }

  private async stats(containers: DiscoveredContainer[], signal: AbortSignal): Promise<Map<string, ContainerStats>> {
    const stats = new Map<string, ContainerStats>();
    if (containers.length === 0) return stats;
    try {
      const format = "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}|{{.BlockIO}}";
      const result = await this.command("docker", [
        "stats", "--no-stream", "--format", format, ...containers.map(({ id }) => id)
      ], { allowFailure: true, timeoutMs: DOCKER_TIMEOUT_MS, signal });
      if (result.exitCode !== 0) return stats;
      for (const line of result.stdout.split("\n").filter(Boolean)) {
        const parsed = parseProjectStatsLine(line);
        if (parsed && containers.some((container) => container.name === parsed.name)) stats.set(parsed.name, parsed.stats);
      }
    } catch {
      // Zero-valued samples still carry status/restart/OOM diagnostics.
    }
    return stats;
  }

  private networkRates(
    key: string,
    target: RuntimeTarget,
    container: DiscoveredContainer | undefined,
    stats: ContainerStats | undefined,
    sampledAt: number
  ): { receivedPerSecond: number; transmittedPerSecond: number } {
    if (!container || !stats) {
      this.previousNetwork.delete(key);
      return { receivedPerSecond: 0, transmittedPerSecond: 0 };
    }
    const previous = this.previousNetwork.get(key);
    let receivedPerSecond = 0;
    let transmittedPerSecond = 0;
    if (
      previous
      && previous.deploymentId === target.deploymentId
      && previous.containerId === container.id
      && sampledAt > previous.checkedAt
      && stats.networkReceivedBytes >= previous.received
      && stats.networkTransmittedBytes >= previous.transmitted
    ) {
      const elapsedSeconds = (sampledAt - previous.checkedAt) / 1_000;
      receivedPerSecond = round((stats.networkReceivedBytes - previous.received) / elapsedSeconds);
      transmittedPerSecond = round((stats.networkTransmittedBytes - previous.transmitted) / elapsedSeconds);
    }
    this.previousNetwork.set(key, {
      checkedAt: sampledAt,
      deploymentId: target.deploymentId,
      containerId: container.id,
      received: stats.networkReceivedBytes,
      transmitted: stats.networkTransmittedBytes
    });
    return { receivedPerSecond, transmittedPerSecond };
  }

  private async collectRuntimeLogs(targets: RuntimeTarget[], containers: DiscoveredContainer[], signal: AbortSignal): Promise<void> {
    const jobs = targets.map((target) => async () => {
      const container = containers.find((candidate) => (
        candidate.projectId === target.projectId && candidate.deploymentId === target.deploymentId
      ));
      if (!container) return;
      const lastTimestamp = this.database.latestRuntimeLogTimestamp(target.deploymentId);
      const retentionStart = new Date(Date.now() - this.config.METRICS_RETENTION_HOURS * 60 * 60_000).toISOString();
      const since = lastTimestamp ?? retentionStart;
      let result: CommandResult;
      try {
        result = await this.command("docker", [
          "logs", "--timestamps", "--since", since, "--tail", String(LOG_TAIL_LINES), container.id
        ], { allowFailure: true, timeoutMs: DOCKER_TIMEOUT_MS, signal });
      } catch {
        return;
      }
      if (result.exitCode !== 0) return;
      const secrets = this.database.listEnvironment(target.projectId).flatMap((entry) => {
        try {
          return [decryptString(entry.encrypted_value, this.config.APP_SECRET)];
        } catch {
          return [];
        }
      });
      const collectedAt = new Date().toISOString();
      const rows: Array<Omit<RuntimeLogRow, "id">> = [];
      for (const [stream, output] of [["stdout", result.stdout], ["stderr", result.stderr]] as const) {
        for (const line of output.split("\n").slice(-LOG_TAIL_LINES)) {
          const parsed = parseRuntimeLogLine(line);
          if (!parsed) continue;
          rows.push({
            project_id: target.projectId,
            deployment_id: target.deploymentId,
            stream,
            message: redactRuntimeLog(parsed.message, secrets),
            source_timestamp: parsed.sourceTimestamp,
            collected_at: collectedAt
          });
        }
      }
      rows.sort((left, right) => (
        left.source_timestamp.localeCompare(right.source_timestamp)
        || left.stream.localeCompare(right.stream)
      ));
      this.database.insertRuntimeLogs(rows.slice(-LOG_TAIL_LINES), MAX_LOG_LINES_PER_PROJECT);
    });

    for (let index = 0; index < jobs.length; index += 3) {
      await Promise.all(jobs.slice(index, index + 3).map((job) => job?.()));
    }
  }

  private maintainRetention(sampledAt: number): void {
    const retentionMs = this.config.METRICS_RETENTION_HOURS * 60 * 60_000;
    this.database.pruneProjectObservabilityByAge(sampledAt - retentionMs);
    if (sampledAt - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    const metricLimit = Math.ceil(retentionMs / (this.config.METRICS_INTERVAL_SECONDS * 1_000)) + 100;
    this.database.pruneProjectObservabilityHardLimits(metricLimit, MAX_LOG_LINES_PER_PROJECT);
    this.lastPruneAt = sampledAt;
  }
}
