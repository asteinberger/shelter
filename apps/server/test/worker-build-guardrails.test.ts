import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, parseDockerMemoryBytes, type AppConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { encryptString } from "../src/lib/security.js";
import {
  DeploymentWorker,
  type WorkerCommandRunner,
  type WorkerDiskStatProvider
} from "../src/services/worker.js";
import type { ProjectRow } from "../src/types/models.js";

const directories: string[] = [];
const databases: Database[] = [];

interface PrivateWorker {
  buildResourceLimitsSupported: boolean;
  buildxFingerprint(): string;
  reconcileBuildxBuilder(): Promise<void>;
  dockerBuild(
    deploymentId: string,
    imageTag: string,
    dockerfilePath: string,
    contextDirectory: string,
    project: ProjectRow,
    customDockerfile: boolean,
    fileStorage: boolean,
    signal: AbortSignal
  ): Promise<void>;
  maintainDockerStorage(deploymentId: string): Promise<void>;
}

interface BuilderContainer {
  fingerprint: string | null;
  memory: number;
  memorySwap: number;
  cpuPeriod: number;
  cpuQuota: number;
  pidsLimit: number;
}

interface BuilderState {
  definition: boolean;
  driver: string;
  container: BuilderContainer | null;
}

function commandResult(stdout = "", exitCode = 0, stderr = "") {
  return { stdout, stderr, exitCode };
}

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function driverOption(args: string[], prefix: string): string | undefined {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === "--driver-opt" && args[index + 1]?.startsWith(prefix)) {
      return args[index + 1]?.slice(prefix.length);
    }
  }
  return undefined;
}

function builderHarness(initial: Partial<BuilderState> = {}): {
  command: WorkerCommandRunner;
  calls: Array<{ command: string; args: string[] }>;
  state: BuilderState;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const state: BuilderState = {
    definition: initial.definition ?? false,
    driver: initial.driver ?? "docker-container",
    container: initial.container ?? null
  };
  let pendingContainer: BuilderContainer | null = null;
  const command: WorkerCommandRunner = vi.fn(async (commandName, args) => {
    calls.push({ command: commandName, args: [...args] });
    if (args[0] === "buildx" && args[1] === "inspect" && !args.includes("--bootstrap")) {
      return state.definition
        ? commandResult(`Name: shelter-builder\nDriver: ${state.driver}\n`)
        : commandResult("", 1, "not found");
    }
    if (args[0] === "buildx" && args[1] === "create") {
      const fingerprint = driverOption(args, "env.SHELTER_BUILDER_CONFIG=") ?? null;
      pendingContainer = {
        fingerprint,
        memory: parseDockerMemoryBytes(driverOption(args, "memory=") ?? "0"),
        memorySwap: parseDockerMemoryBytes(driverOption(args, "memory-swap=") ?? "0"),
        cpuPeriod: Number(driverOption(args, "cpu-period=") ?? 0),
        cpuQuota: Number(driverOption(args, "cpu-quota=") ?? 0),
        pidsLimit: 0
      };
      state.definition = true;
      state.driver = "docker-container";
      return commandResult("shelter-builder");
    }
    if (args[0] === "buildx" && args[1] === "inspect" && args.includes("--bootstrap")) {
      if (!state.definition) return commandResult("", 1, "not found");
      if (pendingContainer) {
        state.container = pendingContainer;
        pendingContainer = null;
      }
      return commandResult(`Name: shelter-builder\nDriver: ${state.driver}\n`);
    }
    if (args[0] === "inspect" && args.at(-1) === "buildx_buildkit_shelter-builder0") {
      if (!state.container) return commandResult("", 1, "not found");
      const environment = state.container.fingerprint
        ? [`SHELTER_BUILDER_CONFIG=${state.container.fingerprint}`]
        : ["BUILDKIT_DEBUG=0"];
      return commandResult([
        state.container.memory,
        state.container.memorySwap,
        state.container.cpuPeriod,
        state.container.cpuQuota,
        state.container.pidsLimit,
        JSON.stringify(environment)
      ].join("\n"));
    }
    if (args[0] === "update" && args[1] === "--pids-limit" && state.container) {
      state.container.pidsLimit = Number(args[2]);
      return commandResult();
    }
    if (args[0] === "buildx" && args[1] === "rm") {
      state.definition = false;
      state.container = null;
      pendingContainer = null;
      return commandResult();
    }
    if (args[0] === "rm" && args[1] === "-f" && args[2] === "buildx_buildkit_shelter-builder0") {
      state.container = null;
      return commandResult();
    }
    return commandResult();
  });
  return { command, calls, state };
}

function context(
  overrides: NodeJS.ProcessEnv = {},
  command: WorkerCommandRunner = async () => commandResult(),
  diskStat: WorkerDiskStatProvider = async () => diskStats(20n * 1024n ** 3n)
): { config: AppConfig; database: Database; worker: DeploymentWorker; privateWorker: PrivateWorker } {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-build-guardrails-"));
  directories.push(dataDirectory);
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDirectory,
    WEB_DIST: path.join(dataDirectory, "missing-web"),
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "correct horse battery staple",
    APP_SECRET: "b".repeat(64),
    LOG_LEVEL: "silent",
    ...overrides
  });
  const database = new Database(config);
  databases.push(database);
  const worker = new DeploymentWorker(config, database, command, diskStat);
  return { config, database, worker, privateWorker: worker as unknown as PrivateWorker };
}

function diskStats(availableBytes: bigint, freeBytes = availableBytes): fs.BigIntStatsFs {
  const blockSize = 4096n;
  return {
    type: 0n,
    bsize: blockSize,
    blocks: 100_000_000n,
    bfree: freeBytes / blockSize,
    bavail: availableBytes / blockSize,
    files: 1_000_000n,
    frsize: blockSize,
    ffree: 900_000n
  };
}

function project(id = "prj_build_guardrails"): ProjectRow {
  const now = new Date().toISOString();
  return {
    id,
    name: "Build Guardrails",
    slug: "build-guardrails",
    source_type: "upload",
    repository_url: null,
    repository_branch: null,
    source_archive: "/tmp/source.zip",
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
    updated_at: now
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) {
    if (database.sqlite.open) database.close();
  }
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("build guardrail configuration", () => {
  it("uses bounded defaults and accepts an explicit finite build budget", () => {
    const defaults = loadConfig({ NODE_ENV: "test" });
    expect(defaults).toMatchObject({
      BUILD_MEMORY: "2g",
      BUILD_MEMORY_SWAP: "2g",
      BUILD_CPUS: "1.0",
      BUILD_PIDS_LIMIT: 1024,
      BUILD_MAX_PARALLELISM: 2,
      BUILD_MIN_FREE_GB: 5
    });
    expect(loadConfig({
      NODE_ENV: "test",
      BUILD_MEMORY: "768m",
      BUILD_MEMORY_SWAP: "1g",
      BUILD_CPUS: "1.25",
      BUILD_PIDS_LIMIT: "2048",
      BUILD_MAX_PARALLELISM: "3",
      BUILD_MIN_FREE_GB: "9"
    })).toMatchObject({
      BUILD_MEMORY: "768m",
      BUILD_MEMORY_SWAP: "1g",
      BUILD_CPUS: "1.25",
      BUILD_PIDS_LIMIT: 2048,
      BUILD_MAX_PARALLELISM: 3,
      BUILD_MIN_FREE_GB: 9
    });
  });

  it.each([
    { BUILD_MEMORY: "63m" },
    { BUILD_MEMORY: "65g", BUILD_MEMORY_SWAP: "65g" },
    { BUILD_MEMORY: "2g", BUILD_MEMORY_SWAP: "1g" },
    { BUILD_CPUS: "0.09" },
    { BUILD_CPUS: "65" },
    { BUILD_PIDS_LIMIT: "63" },
    { BUILD_PIDS_LIMIT: "65537" },
    { BUILD_MAX_PARALLELISM: "0" },
    { BUILD_MAX_PARALLELISM: "17" },
    { BUILD_MIN_FREE_GB: "0" },
    { BUILD_MIN_FREE_GB: "1025" }
  ])("rejects an unsafe build budget: %j", (overrides) => {
    expect(() => loadConfig({ NODE_ENV: "test", ...overrides })).toThrow();
  });
});

describe("Buildx builder reconciliation", () => {
  it("creates one deterministic limited builder and reuses it when configuration matches", async () => {
    const harness = builderHarness();
    const { config, privateWorker } = context({
      BUILD_MEMORY: "768m",
      BUILD_MEMORY_SWAP: "1g",
      BUILD_CPUS: "1.25",
      BUILD_PIDS_LIMIT: "2048",
      BUILD_MAX_PARALLELISM: "3"
    }, harness.command);

    await privateWorker.reconcileBuildxBuilder();
    await privateWorker.reconcileBuildxBuilder();

    const createCalls = harness.calls.filter(({ args }) => args[0] === "buildx" && args[1] === "create");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.args).toEqual(expect.arrayContaining([
      "--name", "shelter-builder",
      "--node", "shelter-builder0",
      "--driver", "docker-container",
      "--driver-opt", "memory=768m",
      "--driver-opt", "memory-swap=1g",
      "--driver-opt", "cpu-period=100000",
      "--driver-opt", "cpu-quota=125000",
      "--driver-opt", "default-load=true"
    ]));
    expect(createCalls[0]?.args.join(" ")).toMatch(/env\.SHELTER_BUILDER_CONFIG=[a-f0-9]{64}/);
    expect(harness.calls.some(({ args }) => (
      args[0] === "update" && args.join(" ") === "update --pids-limit 2048 buildx_buildkit_shelter-builder0"
    ))).toBe(true);
    const configPath = path.join(config.DATA_DIR, "buildx", "buildkitd.toml");
    expect(fs.readFileSync(configPath, "utf8")).toBe([
      "[worker.oci]",
      "  gc = true",
      "  max-parallelism = 3",
      "",
      "[[worker.oci.gcpolicy]]",
      "  all = true",
      '  reservedSpace = "1GB"',
      '  maxUsedSpace = "8GB"',
      '  minFreeSpace = "5GB"',
      ""
    ].join("\n"));
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(configPath)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("recreates only an owned builder when its configuration has drifted", async () => {
    const harness = builderHarness({ definition: true });
    const { config, privateWorker } = context({
      BUILD_MEMORY: "768m",
      BUILD_MEMORY_SWAP: "1g",
      BUILD_CPUS: "1.25",
      BUILD_MAX_PARALLELISM: "3"
    }, harness.command);
    harness.state.container = {
      fingerprint: "old-fingerprint",
      memory: parseDockerMemoryBytes(config.BUILD_MEMORY),
      memorySwap: parseDockerMemoryBytes(config.BUILD_MEMORY_SWAP),
      cpuPeriod: 100_000,
      cpuQuota: 125_000,
      pidsLimit: 1024
    };

    await privateWorker.reconcileBuildxBuilder();

    const removeIndex = harness.calls.findIndex(({ args }) => args[0] === "buildx" && args[1] === "rm");
    const createIndex = harness.calls.findIndex(({ args }) => args[0] === "buildx" && args[1] === "create");
    expect(removeIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(removeIndex);
    expect(harness.state.container?.fingerprint).toBe(privateWorker.buildxFingerprint());
  });

  it("fails closed without deleting a foreign builder collision", async () => {
    const harness = builderHarness({
      definition: true,
      container: {
        fingerprint: null,
        memory: parseDockerMemoryBytes("2g"),
        memorySwap: parseDockerMemoryBytes("2g"),
        cpuPeriod: 100_000,
        cpuQuota: 100_000,
        pidsLimit: 1024
      }
    });
    const { privateWorker } = context({}, harness.command);

    await expect(privateWorker.reconcileBuildxBuilder()).rejects.toThrow(/not owned by Shelter/);
    expect(harness.calls.some(({ args }) => args[0] === "buildx" && args[1] === "rm")).toBe(false);
    expect(harness.calls.some(({ args }) => args[0] === "buildx" && args[1] === "create")).toBe(false);
  });

  it("rejects a same-name builder using another driver", async () => {
    const harness = builderHarness({ definition: true, driver: "remote" });
    const { privateWorker } = context({}, harness.command);
    await expect(privateWorker.reconcileBuildxBuilder()).rejects.toThrow(/unsupported driver/);
    expect(harness.calls.some(({ args }) => args[0] === "buildx" && ["rm", "create"].includes(args[1] ?? ""))).toBe(false);
  });
});

describe("guarded Docker builds", () => {
  it("uses the dedicated builder, supported per-step limits, timeout and cancellation signal without leaking values", async () => {
    const command = vi.fn<WorkerCommandRunner>(async () => commandResult());
    const diskStat = vi.fn<WorkerDiskStatProvider>(async () => diskStats(8n * 1024n ** 3n));
    const { config, database, privateWorker } = context({
      BUILD_MEMORY: "768m",
      BUILD_MEMORY_SWAP: "1g",
      BUILD_CPUS: "1.25",
      BUILD_TIMEOUT_MINUTES: "7",
      BUILD_MIN_FREE_GB: "2"
    }, command, diskStat);
    privateWorker.buildResourceLimitsSupported = true;
    const row = project();
    database.createProject(row);
    const secret = "never-print-this-build-secret";
    const now = new Date().toISOString();
    database.replaceEnvironment(row.id, [{
      id: "env_build_guardrails",
      project_id: row.id,
      key: "PRIVATE_TOKEN",
      encrypted_value: encryptString(secret, config.APP_SECRET),
      created_at: now,
      updated_at: now
    }]);
    const controller = new AbortController();

    await privateWorker.dockerBuild(
      "dep_build_guardrails",
      "shelter/build-guardrails:dep",
      "/workspace/Dockerfile",
      "/workspace/source",
      row,
      false,
      false,
      controller.signal
    );

    expect(diskStat).toHaveBeenCalledTimes(2);
    const buildCall = command.mock.calls.find(([, args]) => args[0] === "buildx" && args[1] === "build");
    expect(buildCall).toBeDefined();
    const [, args, options] = buildCall!;
    expect(args.slice(0, 6)).toEqual(["buildx", "build", "--builder", "shelter-builder", "--load", "--progress"]);
    expect(args).toEqual(expect.arrayContaining([
      "--resource", "memory=768m",
      "--resource", "memory-swap=1g",
      "--resource", "cpu-period=100000",
      "--resource", "cpu-quota=125000",
      "--label", "shelter.managed=true",
      "--label", "portsmith.managed=false",
      "-f", "/workspace/Dockerfile"
    ]));
    expect(args.at(-1)).toBe("/workspace/source");
    expect(options).toMatchObject({ timeoutMs: 7 * 60_000 });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.signal?.aborted).toBe(false);
    expect(JSON.stringify(args)).not.toContain(secret);
    const secretArgument = args.find((value) => value.startsWith("id=shelter_env,src="));
    const secretPath = secretArgument?.slice(secretArgument.indexOf("src=") + 4);
    expect(secretPath).toBeTruthy();
    expect(fs.existsSync(secretPath!)).toBe(false);
  });

  it("uses bavail and blocks before invoking Docker when free space is below the configured reserve", async () => {
    const command = vi.fn<WorkerCommandRunner>(async () => commandResult());
    const blockSize = 4096n;
    const required = 2n * 1024n ** 3n;
    const diskStat = vi.fn<WorkerDiskStatProvider>(async () => diskStats(required - blockSize, required * 10n));
    const { privateWorker } = context({ BUILD_MIN_FREE_GB: "2" }, command, diskStat);

    await expect(privateWorker.dockerBuild(
      "dep_low_disk",
      "shelter/low-disk:dep",
      "/workspace/Dockerfile",
      "/workspace/source",
      project("prj_low_disk"),
      false,
      true,
      new AbortController().signal
    )).rejects.toThrow(/only 1\.9 GiB is free/);
    expect(command).not.toHaveBeenCalled();
  });

  it("fails closed when disk capacity cannot be measured", async () => {
    const command = vi.fn<WorkerCommandRunner>(async () => commandResult());
    const diskStat = vi.fn<WorkerDiskStatProvider>(async () => {
      throw new Error("statfs unavailable");
    });
    const { privateWorker } = context({}, command, diskStat);
    await expect(privateWorker.dockerBuild(
      "dep_unknown_disk",
      "shelter/unknown-disk:dep",
      "/workspace/Dockerfile",
      "/workspace/source",
      project("prj_unknown_disk"),
      false,
      true,
      new AbortController().signal
    )).rejects.toThrow(/could not be determined safely/);
    expect(command).not.toHaveBeenCalled();
  });

  it("aborts an active build when the free-space reserve is crossed", async () => {
    let statCalls = 0;
    const diskStat = vi.fn<WorkerDiskStatProvider>(async () => {
      statCalls += 1;
      return statCalls === 1
        ? diskStats(8n * 1024n ** 3n)
        : diskStats(512n * 1024n ** 2n);
    });
    const command = vi.fn<WorkerCommandRunner>(async (_command, _args, options) => (
      new Promise((_, reject) => {
        const signal = options?.signal;
        if (!signal) return reject(new Error("missing build guard signal"));
        if (signal.aborted) return reject(new Error("build aborted"));
        signal.addEventListener("abort", () => reject(new Error("build aborted")), { once: true });
      })
    ));
    const { privateWorker } = context({ BUILD_MIN_FREE_GB: "2" }, command, diskStat);

    await expect(privateWorker.dockerBuild(
      "dep_disk_pressure",
      "shelter/disk-pressure:dep",
      "/workspace/Dockerfile",
      "/workspace/source",
      project("prj_disk_pressure"),
      false,
      true,
      new AbortController().signal
    )).rejects.toThrow(/only 0\.5 GiB is free/);
    expect(statCalls).toBeGreaterThanOrEqual(2);
  });

  it("prunes only the Shelter builder cache", async () => {
    const command = vi.fn<WorkerCommandRunner>(async () => commandResult());
    const { privateWorker } = context({ BUILD_CACHE_MAX_GB: "6" }, command);
    await privateWorker.maintainDockerStorage("dep_prune");
    expect(command.mock.calls[0]?.[1]).toEqual([
      "buildx", "prune", "--builder", "shelter-builder", "-f", "--max-used-space", "6gb"
    ]);
    expect(command.mock.calls.some(([, args]) => args[0] === "builder" && args[1] === "prune")).toBe(false);
  });
});
