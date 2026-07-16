import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import extractZip from "extract-zip";
import { parseDockerMemoryBytes, type AppConfig } from "../config.js";
import {
  CommandCancelledError,
  CommandTimeoutError,
  runCommand,
  type CommandOptions,
  type CommandResult
} from "../lib/command.js";
import type { Database } from "../lib/database.js";
import { decryptString, resolveWithin } from "../lib/security.js";
import type { DeploymentFailureKind, DeploymentRollbackStatus, DeploymentRow, ProjectRow } from "../types/models.js";
import { createBuildPlan } from "./build-plan.js";
import { prepareGitSource } from "./git-source.js";
import { GitHubService } from "./github.js";
import { ProjectDeletionWorker } from "./project-deletion.js";
import { ProjectNetworkReconciler } from "./project-network-reconciler.js";
import { probeProjectContainer } from "./project-runtime-helper.js";
import { analyzeProjectDirectory, type ProjectAnalysis } from "./project-analysis.js";
import { captureProjectPreview, projectPreviewState } from "./project-preview.js";
import { reconcileRouting } from "./routing.js";
import { ServerMetricsCollector } from "./server-metrics.js";
import {
  COMPOSE_PROJECT_NAMES,
  deploymentContainerName,
  deploymentContainerNames,
  imageTag as shelterImageTag,
  isDockerDnsLabel,
  isManagedVersionedRuntimeName,
  isManagedImage,
  MANAGED_LABEL_NAMESPACES,
  stableContainerNames
} from "./runtime-identity.js";

const activeStatuses = new Set(["queued", "preparing", "building", "checking", "switching"]);
const BUILDX_BUILDER_NAME = "shelter-builder";
const BUILDX_BUILDER_NODE = `${BUILDX_BUILDER_NAME}0`;
const BUILDX_BUILDER_CONTAINER = `buildx_buildkit_${BUILDX_BUILDER_NODE}`;
const BUILDX_CONFIG_MARKER = "SHELTER_BUILDER_CONFIG";
const BUILD_CPU_PERIOD = 100_000;
const BUILD_GIB = 1024n ** 3n;
const PROJECT_NETWORK_RECONCILE_INTERVAL_MS = 15_000;

export type WorkerCommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions
) => Promise<CommandResult>;

export type WorkerDiskStatProvider = (target: string) => Promise<fs.BigIntStatsFs>;

interface BuildxContainerState {
  owned: boolean;
  matches: boolean;
}

class DeploymentCancelledError extends Error {
  constructor() {
    super("Deployment wurde vom Benutzer abgebrochen");
    this.name = "DeploymentCancelledError";
  }
}

class DeploymentHealthcheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentHealthcheckError";
  }
}

class DeploymentActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentActivationError";
  }
}

export function deploymentFailureKind(error: unknown, status?: DeploymentRow["status"]): DeploymentFailureKind {
  if (error instanceof CommandTimeoutError) return "timeout";
  if (error instanceof DeploymentCancelledError) return "cancelled";
  if (error instanceof DeploymentHealthcheckError) return "healthcheck";
  if (error instanceof DeploymentActivationError) return "activation";
  if (status === "preparing" || status === "building") return "build";
  return "worker";
}

export function healthcheckPathFor(
  project: Pick<ProjectRow, "healthcheck_path">,
  deployment?: Pick<DeploymentRow, "runtime_kind">
): string {
  return deployment?.runtime_kind === "files" ? "/" : project.healthcheck_path;
}

export function buildEnvironmentSecretArgs(secretPath: string): string[] {
  // Existing user Dockerfiles may still mount the original secret id. Both ids
  // point at the same short-lived file, are BuildKit-only, and never enter an
  // image unless the Dockerfile explicitly mounts one of them.
  return [
    "--secret", `id=shelter_env,src=${secretPath}`,
    "--secret", `id=portsmith_env,src=${secretPath}`
  ];
}

export function resolveUploadArchiveForDeployment(
  config: Pick<AppConfig, "sourcesDir">,
  database: Pick<Database, "sqlite">,
  project: Pick<ProjectRow, "source_archive">,
  deployment: Pick<DeploymentRow, "source_ref">
): string {
  if (deployment.source_ref !== null) {
    const referencedUpload = database.sqlite.prepare(`
      SELECT id, archive_path FROM uploads WHERE id = ? AND status = 'complete'
    `).get(deployment.source_ref) as { id: string; archive_path: string | null } | undefined;
    if (!referencedUpload?.archive_path) {
      throw new Error(`Deployment-Quellrevision '${deployment.source_ref}' ist nicht mehr als vollständiger Upload vorhanden`);
    }
    const expectedArchive = resolveWithin(config.sourcesDir, path.join(referencedUpload.id, "source.zip"));
    if (path.resolve(referencedUpload.archive_path) !== expectedArchive) {
      throw new Error("Deployment verweist auf ein nicht verwaltetes Quellarchiv");
    }
    return expectedArchive;
  }

  if (!project.source_archive) throw new Error("Quellarchiv fehlt");
  return project.source_archive;
}

export function startWorkerHeartbeat(
  database: Pick<Database, "setSetting">,
  intervalMs = 5_000
): NodeJS.Timeout {
  const heartbeat = (): void => {
    database.setSetting("worker.heartbeat", new Date().toISOString());
  };
  heartbeat();
  // Keep this timer referenced: the worker's top-level await needs a live
  // handle while archive libraries briefly wait on callbacks that may not
  // keep the Node.js process alive themselves.
  return setInterval(heartbeat, intervalMs);
}

export class DeploymentWorker {
  private stopping = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private activeDeploymentAbort: AbortController | null = null;
  private previewBackfillPending = true;
  private readonly projectDeletion: ProjectDeletionWorker;
  private readonly github: GitHubService;
  private readonly metrics: ServerMetricsCollector;
  private readonly projectNetworks: ProjectNetworkReconciler;
  private buildResourceLimitsSupported = false;
  private lastProjectNetworkReconcile = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
    private readonly command: WorkerCommandRunner = runCommand,
    private readonly diskStat: WorkerDiskStatProvider = async (target) => fs.promises.statfs(target, { bigint: true })
  ) {
    this.projectDeletion = new ProjectDeletionWorker(config, database);
    this.github = new GitHubService(config, database);
    this.metrics = new ServerMetricsCollector(config, database);
    this.projectNetworks = new ProjectNetworkReconciler(config, database, command);
  }

  async run(): Promise<void> {
    await this.ensureDockerReady();
    await this.reconcileProjectNetworks(true);
    await this.resetWorkspaces();
    this.projectDeletion.recoverInterrupted();
    await this.recoverInterruptedDeployments();
    await this.cleanupInactiveRuntimeContainers();
    this.database.reconcileGithubStatusOutbox();
    reconcileRouting(this.config, this.database);
    this.heartbeatTimer = startWorkerHeartbeat(this.database);
    this.metrics.start();

    try {
      while (!this.stopping) {
        await this.reconcileProjectNetworks();
        await this.reconcileCloudflaredRestart();
        if (await this.cleanupNextPullRequestPreview()) continue;
        if (await this.projectDeletion.processNext()) continue;
        if (await this.github.processNextWebhookJob()) continue;
        if (await this.github.processNextCommitStatus()) continue;
        this.database.materializePendingGithubPush();
        const deployment = this.database.claimNextQueuedDeployment();
        if (!deployment) {
          if (this.previewBackfillPending) {
            this.previewBackfillPending = false;
            await this.backfillProjectPreviews();
            continue;
          }
          await wait(750);
          continue;
        }
        const cancellation = this.monitorDeploymentCancellation(deployment.id);
        this.activeDeploymentAbort = cancellation.controller;
        try {
          await this.reportGithubStatus(deployment, "pending", "Deployment wird von Shelter gebaut");
          await this.process(deployment, cancellation.controller.signal);
          const completed = this.database.getDeployment(deployment.id);
          if (completed?.status === "ready") {
            await this.reportGithubStatus(completed, "success", "Deployment ist bereit");
          } else if (completed?.status === "cancelled") {
            await this.reportGithubStatus(
              completed,
              "error",
              completed.failure_kind === "superseded" ? "Durch einen neueren Push ersetzt" : "Deployment wurde abgebrochen"
            );
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unbekannter Deployment-Fehler";
          const current = this.database.getDeployment(deployment.id);
          if (current?.cancel_requested_at || current?.status === "cancelled") {
            const cancelled = this.database.finalizeDeploymentCancellation(
              deployment.id,
              current.rollback_status ?? "not_required",
              current.rollback_deployment_id ?? null
            ) ?? current;
            this.safeLog(deployment.id, "system", "Deployment-Abbruch wurde abgeschlossen.");
            await this.reportGithubStatus(cancelled, "error", "Deployment wurde abgebrochen");
          } else if (current?.status !== "ready") {
            this.log(deployment.id, "stderr", message);
            const failed = this.database.failDeploymentIfActive(
              deployment.id,
              current?.failure_kind ?? deploymentFailureKind(error, current?.status),
              message,
              new Date().toISOString()
            );
            if (failed?.deployment_scope === "preview" && failed.preview_id) {
              this.database.failPullRequestPreview(failed.preview_id, failed.id, message);
              reconcileRouting(this.config, this.database);
            }
            if (failed) await this.reportGithubStatus(failed, "failure", "Deployment fehlgeschlagen");
          }
        } finally {
          cancellation.stop();
          this.activeDeploymentAbort = null;
          if (deployment.deployment_scope === "preview" && deployment.preview_id) {
            this.database.materializePullRequestPreview(deployment.preview_id);
          }
          this.database.materializePendingGithubPush(deployment.project_id);
        }
        try {
          await this.pruneFailedImages(deployment.project_id);
        } catch (error) {
          this.safeLog(deployment.id, "stderr", `Aufräumen fehlgeschlagener Images fehlgeschlagen: ${error instanceof Error ? error.message : "unbekannter Fehler"}`);
        }
        this.database.pruneDeploymentLogsForScope(
          deployment.project_id,
          deployment.deployment_scope === "preview" ? "preview" : "production"
        );
        await this.maintainDockerStorage(deployment.id);
      }
    } finally {
      await this.metrics.stop();
    }
  }

  stop(): void {
    this.stopping = true;
    this.activeDeploymentAbort?.abort();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    void this.metrics.stop();
  }

  private monitorDeploymentCancellation(deploymentId: string): {
    controller: AbortController;
    stop: () => void;
  } {
    const controller = new AbortController();
    const check = (): void => {
      if (!controller.signal.aborted && this.database.deploymentCancellationRequested(deploymentId)) {
        controller.abort();
      }
    };
    check();
    const timer = setInterval(check, 250);
    timer.unref();
    return {
      controller,
      stop: () => clearInterval(timer)
    };
  }

  private throwIfDeploymentCancelled(deploymentId: string, signal: AbortSignal): void {
    if (signal.aborted || this.database.deploymentCancellationRequested(deploymentId)) {
      throw new DeploymentCancelledError();
    }
  }

  private buildxDirectory(): string {
    return path.join(this.config.DATA_DIR, "buildx");
  }

  private buildxEnvironment(): NodeJS.ProcessEnv {
    return { ...process.env, BUILDX_CONFIG: this.buildxDirectory() };
  }

  private buildCpuQuota(): number {
    return Math.round(Number(this.config.BUILD_CPUS) * BUILD_CPU_PERIOD);
  }

  private buildxFingerprint(): string {
    return createHash("sha256").update(JSON.stringify({
      version: 1,
      memory: this.config.BUILD_MEMORY,
      memorySwap: this.config.BUILD_MEMORY_SWAP,
      cpus: this.config.BUILD_CPUS,
      pidsLimit: this.config.BUILD_PIDS_LIMIT,
      maxParallelism: this.config.BUILD_MAX_PARALLELISM,
      cacheMaxGb: this.config.BUILD_CACHE_MAX_GB,
      minFreeGb: this.config.BUILD_MIN_FREE_GB
    })).digest("hex");
  }

  private async writeBuildkitdConfig(): Promise<string> {
    const directory = this.buildxDirectory();
    const target = path.join(directory, "buildkitd.toml");
    const temporary = path.join(directory, `.buildkitd.${randomUUID()}.tmp`);
    const contents = [
      "[worker.oci]",
      "  gc = true",
      `  max-parallelism = ${this.config.BUILD_MAX_PARALLELISM}`,
      "",
      "[[worker.oci.gcpolicy]]",
      "  all = true",
      '  reservedSpace = "1GB"',
      `  maxUsedSpace = "${this.config.BUILD_CACHE_MAX_GB}GB"`,
      `  minFreeSpace = "${this.config.BUILD_MIN_FREE_GB}GB"`,
      ""
    ].join("\n");
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(directory, 0o700);
    try {
      await fs.promises.writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
      await fs.promises.rename(temporary, target);
      await fs.promises.chmod(target, 0o600);
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
    return target;
  }

  private async inspectBuildxContainer(fingerprint: string): Promise<BuildxContainerState | null> {
    const format = [
      "{{.HostConfig.Memory}}",
      "{{.HostConfig.MemorySwap}}",
      "{{.HostConfig.CpuPeriod}}",
      "{{.HostConfig.CpuQuota}}",
      "{{.HostConfig.PidsLimit}}",
      "{{json .Config.Env}}"
    ].join("\n");
    const inspected = await this.command(
      "docker",
      ["inspect", "--format", format, BUILDX_BUILDER_CONTAINER],
      { allowFailure: true, env: this.buildxEnvironment(), timeoutMs: 15_000 }
    );
    if (inspected.exitCode !== 0) return null;
    const [memory, memorySwap, cpuPeriod, cpuQuota, pidsLimit, ...environmentLines] = inspected.stdout.split("\n");
    let environment: unknown;
    try {
      environment = JSON.parse(environmentLines.join("\n"));
    } catch {
      throw new Error("Shelter could not validate the BuildKit container environment safely");
    }
    if (!Array.isArray(environment) || !environment.every((entry) => typeof entry === "string")) {
      throw new Error("Shelter received an invalid BuildKit container environment");
    }
    const markerPrefix = `${BUILDX_CONFIG_MARKER}=`;
    const marker = environment.find((entry) => entry.startsWith(markerPrefix));
    const owned = marker !== undefined;
    return {
      owned,
      matches: marker === `${markerPrefix}${fingerprint}`
        && Number(memory) === parseDockerMemoryBytes(this.config.BUILD_MEMORY)
        && Number(memorySwap) === parseDockerMemoryBytes(this.config.BUILD_MEMORY_SWAP)
        && Number(cpuPeriod) === BUILD_CPU_PERIOD
        && Number(cpuQuota) === this.buildCpuQuota()
        && Number(pidsLimit) === this.config.BUILD_PIDS_LIMIT
    };
  }

  private async createBuildxBuilder(buildkitdConfigPath: string, fingerprint: string): Promise<void> {
    await this.command("docker", [
      "buildx", "create",
      "--name", BUILDX_BUILDER_NAME,
      "--node", BUILDX_BUILDER_NODE,
      "--driver", "docker-container",
      "--driver-opt", `memory=${this.config.BUILD_MEMORY}`,
      "--driver-opt", `memory-swap=${this.config.BUILD_MEMORY_SWAP}`,
      "--driver-opt", `cpu-period=${BUILD_CPU_PERIOD}`,
      "--driver-opt", `cpu-quota=${this.buildCpuQuota()}`,
      "--driver-opt", "default-load=true",
      "--driver-opt", `env.${BUILDX_CONFIG_MARKER}=${fingerprint}`,
      "--buildkitd-config", buildkitdConfigPath
    ], { env: this.buildxEnvironment(), timeoutMs: 60_000 });
  }

  private async bootstrapAndValidateBuildxBuilder(fingerprint: string): Promise<BuildxContainerState> {
    await this.command(
      "docker",
      ["buildx", "inspect", "--bootstrap", BUILDX_BUILDER_NAME],
      { env: this.buildxEnvironment(), timeoutMs: 60_000 }
    );
    let state = await this.inspectBuildxContainer(fingerprint);
    if (!state) throw new Error("Shelter's BuildKit container was not created");
    if (state.owned) {
      await this.command("docker", [
        "update", "--pids-limit", String(this.config.BUILD_PIDS_LIMIT), BUILDX_BUILDER_CONTAINER
      ], { env: this.buildxEnvironment(), timeoutMs: 15_000 });
      state = await this.inspectBuildxContainer(fingerprint);
      if (!state) throw new Error("Shelter's BuildKit container disappeared while applying its PID limit");
    }
    return state;
  }

  private async reconcileBuildxBuilder(): Promise<void> {
    const buildkitdConfigPath = await this.writeBuildkitdConfig();
    const fingerprint = this.buildxFingerprint();
    const environment = this.buildxEnvironment();
    const definition = await this.command(
      "docker",
      ["buildx", "inspect", BUILDX_BUILDER_NAME],
      { allowFailure: true, env: environment, timeoutMs: 15_000 }
    );

    if (definition.exitCode !== 0) {
      const orphan = await this.inspectBuildxContainer(fingerprint);
      if (orphan && !orphan.owned) {
        throw new Error(`Docker container '${BUILDX_BUILDER_CONTAINER}' already exists but is not owned by Shelter`);
      }
      if (orphan && !orphan.matches) {
        await this.command("docker", ["rm", "-f", BUILDX_BUILDER_CONTAINER], {
          env: environment,
          timeoutMs: 60_000
        });
      }
      await this.createBuildxBuilder(buildkitdConfigPath, fingerprint);
      const created = await this.bootstrapAndValidateBuildxBuilder(fingerprint);
      if (!created.matches) throw new Error("Shelter's BuildKit resource limits do not match the requested configuration");
      return;
    }

    const driver = definition.stdout.match(/^Driver:\s*(\S+)\s*$/m)?.[1];
    if (driver !== "docker-container") {
      throw new Error(`Buildx builder '${BUILDX_BUILDER_NAME}' already exists with an unsupported driver`);
    }

    const current = await this.bootstrapAndValidateBuildxBuilder(fingerprint);
    if (current.matches) return;
    if (!current.owned) {
      throw new Error(`Buildx builder '${BUILDX_BUILDER_NAME}' already exists but is not owned by Shelter`);
    }

    await this.command(
      "docker",
      ["buildx", "rm", "--force", "--keep-state", BUILDX_BUILDER_NAME],
      { env: environment, timeoutMs: 60_000 }
    );
    await this.createBuildxBuilder(buildkitdConfigPath, fingerprint);
    const reconciled = await this.bootstrapAndValidateBuildxBuilder(fingerprint);
    if (!reconciled.matches) throw new Error("Shelter's BuildKit resource limits could not be reconciled safely");
  }

  private async ensureBuildxReady(): Promise<void> {
    const environment = this.buildxEnvironment();
    const version = await this.command("docker", ["buildx", "version"], {
      allowFailure: true,
      env: environment,
      timeoutMs: 15_000
    });
    if (version.exitCode !== 0) throw new Error("Docker Buildx ist im Worker-Container nicht verfügbar");
    const help = await this.command("docker", ["buildx", "build", "--help"], {
      allowFailure: true,
      env: environment,
      timeoutMs: 15_000
    });
    this.buildResourceLimitsSupported = help.exitCode === 0 && /(^|\s)--resource(?:\s|$)/m.test(`${help.stdout}\n${help.stderr}`);
    await this.reconcileBuildxBuilder();
  }

  private async ensureDockerReady(): Promise<void> {
    const dockerConfig = process.env.DOCKER_CONFIG ?? path.join(this.config.DATA_DIR, ".docker");
    await fs.promises.mkdir(dockerConfig, { recursive: true, mode: 0o700 });
    const version = await this.command("docker", ["version", "--format", "{{.Server.Version}}"]).catch((error) => {
      throw new Error(`Docker Engine ist nicht erreichbar: ${error instanceof Error ? error.message : "unbekannter Fehler"}`);
    });
    if (!version.stdout) throw new Error("Docker Engine ist nicht erreichbar");
    await this.ensureBuildxReady();
    const inspected = await this.command("docker", ["network", "inspect", this.config.RUNTIME_NETWORK], { allowFailure: true });
    if (inspected.exitCode !== 0) {
      await this.command("docker", ["network", "create", this.config.RUNTIME_NETWORK]);
    }
  }

  private async managedContainerIds(label?: { name: string; value: string }): Promise<string[]> {
    const ids = new Set<string>();
    for (const namespace of MANAGED_LABEL_NAMESPACES) {
      const result = await this.command("docker", [
        "ps", "-aq",
        "--filter", `label=${namespace}.managed=true`,
        ...(label ? ["--filter", `label=${namespace}.${label.name}=${label.value}`] : [])
      ], { allowFailure: true });
      for (const id of result.stdout.split("\n").map((value) => value.trim()).filter(Boolean)) ids.add(id);
    }
    return [...ids];
  }

  private async reconcileProjectNetworks(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastProjectNetworkReconcile < PROJECT_NETWORK_RECONCILE_INTERVAL_MS) return;
    await this.projectNetworks.reconcileAll();
    this.lastProjectNetworkReconcile = now;
  }

  private async process(deployment: DeploymentRow, signal: AbortSignal): Promise<void> {
    const project = this.database.getProject(deployment.project_id);
    if (!project) throw new Error("Projekt wurde gelöscht");
    const isPreview = deployment.deployment_scope === "preview";
    if (isPreview) {
      if (!deployment.preview_id || !this.database.beginPullRequestPreviewBuild(deployment.preview_id, deployment.id)) {
        throw new DeploymentCancelledError();
      }
    }
    this.log(deployment.id, "system", `Worker startet Deployment für ${project.name}.`);
    this.throwIfDeploymentCancelled(deployment.id, signal);

    let imageTag: string;
    let internalPort: number;
    let commitSha: string | null = deployment.commit_sha;
    const rollbackTarget = deployment.source_ref?.startsWith("rollback:")
      ? this.database.getDeployment(deployment.source_ref.slice("rollback:".length))
      : undefined;

    if (rollbackTarget) {
      if (!rollbackTarget.image_tag || !rollbackTarget.internal_port) throw new Error("Rollback-Image ist unvollständig");
      const retainedImage = await runCommand("docker", ["image", "inspect", rollbackTarget.image_tag], { allowFailure: true, signal });
      if (retainedImage.exitCode !== 0) throw new Error("Rollback-Image wurde gemäß Retention bereits entfernt und ist nicht mehr verfügbar");
      imageTag = rollbackTarget.image_tag;
      internalPort = rollbackTarget.internal_port;
      commitSha = rollbackTarget.commit_sha;
      this.log(deployment.id, "system", `Rollback auf Image ${imageTag}.`);
      this.database.updateDeployment(deployment.id, {
        image_tag: imageTag,
        internal_port: internalPort,
        static_base_path: rollbackTarget.static_base_path,
        runtime_kind: rollbackTarget.runtime_kind,
        runtime_description: rollbackTarget.runtime_description,
        commit_sha: commitSha,
        commit_message: rollbackTarget.commit_message ?? null,
        commit_author: rollbackTarget.commit_author ?? null,
        commit_url: rollbackTarget.commit_url ?? null
      });
    } else {
      const workspace = path.join(this.config.workspacesDir, deployment.id);
      await fs.promises.rm(workspace, { recursive: true, force: true });
      await fs.promises.mkdir(workspace, { recursive: true, mode: 0o700 });
      try {
        const sourceDirectory = await this.runWithDiskCapacityGuard(
          signal,
          (guardedSignal) => this.prepareSource(project, deployment, workspace, guardedSignal)
        );
        this.throwIfDeploymentCancelled(deployment.id, signal);
        const sourceAnalysis = isPreview
          ? safeAnalyzeProjectDirectory(sourceDirectory)
          : refreshProjectSourceAnalysis(this.database, project.id, sourceDirectory);
        if (sourceAnalysis) {
          this.log(deployment.id, "system", `Source erkannt: ${sourceAnalysis.applications.length} Anwendung(en).`);
        } else {
          this.safeLog(deployment.id, "stderr", "Source-Analyse übersprungen; das Deployment läuft weiter.");
        }
        const generationDirectory = path.join(workspace, "generated");
        const plan = createBuildPlan(project, sourceDirectory, generationDirectory, deployment.static_base_path);
        internalPort = plan.internalPort;
        imageTag = shelterImageTag(project.slug, deployment.id);
        this.log(deployment.id, "system", `Build erkannt: ${plan.description}; interner Port ${internalPort}.`);
        const building = this.database.updateDeployment(deployment.id, {
          status: "building",
          image_tag: imageTag,
          internal_port: internalPort,
          runtime_kind: plan.kind,
          runtime_description: plan.description,
          commit_sha: commitSha
        });
        if (building?.cancel_requested_at) throw new DeploymentCancelledError();
        await this.dockerBuild(
          deployment.id,
          imageTag,
          plan.dockerfilePath,
          plan.contextDirectory,
          project,
          plan.kind === "dockerfile",
          plan.kind === "files",
          signal
        );
        this.throwIfDeploymentCancelled(deployment.id, signal);
        if (project.source_type === "git") {
          const result = await runCommand("git", ["-C", sourceDirectory, "rev-parse", "HEAD"], { allowFailure: true, signal });
          commitSha = result.exitCode === 0 ? result.stdout.trim() : null;
          this.database.updateDeployment(deployment.id, { commit_sha: commitSha });
          if (!isPreview) this.database.clearPendingGithubPushIfSha(project.id, commitSha);
          const identified = this.database.getDeployment(deployment.id);
          if (identified && !deployment.commit_sha) {
            await this.reportGithubStatus(identified, "pending", "Deployment wird von Shelter gebaut");
          }
        }
      } finally {
        await fs.promises.rm(workspace, { recursive: true, force: true });
      }
    }

    this.throwIfDeploymentCancelled(deployment.id, signal);
    if (!isPreview && this.cancelIfSuperseded(project, deployment.id, commitSha)) return;

    const previousActiveDeploymentId = isPreview ? null : project.active_deployment_id;
    const previewState = isPreview && deployment.preview_id
      ? this.database.getPullRequestPreview(deployment.preview_id)
      : undefined;
    const previousPreviewDeployment = previewState?.active_deployment_id
      && previewState.active_deployment_id !== deployment.id
      ? this.database.getDeployment(previewState.active_deployment_id)
      : undefined;
    const previousRuntime = isPreview ? null : await this.currentRuntime(project, signal);
    const previousImage = previousRuntime?.image ?? null;
    const runtimeName = deploymentContainerName(project.slug, deployment.id);
    this.database.updateDeployment(deployment.id, {
      previous_image_tag: previousImage,
      rollback_deployment_id: previousActiveDeploymentId,
      runtime_container: runtimeName,
      status: "checking"
    });
    const preparedDeployment = this.database.getDeployment(deployment.id) ?? deployment;
    const healthcheckPath = healthcheckPathFor(project, preparedDeployment);
    await this.removeContainer(runtimeName);
    this.log(deployment.id, "system", "Starte versionsgebundenen Candidate-Container; die aktive Version bleibt online.");
    try {
      await this.startContainer(runtimeName, imageTag, project, internalPort, true, deployment.id, signal);
      await this.waitForHealth(runtimeName, internalPort, healthcheckPath, deployment.id, signal);
    } catch (error) {
      await this.removeContainer(runtimeName);
      const rollbackStatus: DeploymentRollbackStatus = previousActiveDeploymentId
        ? previousRuntime ? "automatic_succeeded" : "automatic_failed"
        : "not_required";
      this.database.updateDeployment(deployment.id, {
        rollback_status: rollbackStatus,
        rollback_deployment_id: previousActiveDeploymentId
      });
      if (error instanceof CommandCancelledError || error instanceof DeploymentCancelledError || signal.aborted) throw error;
      throw new DeploymentHealthcheckError(error instanceof Error ? error.message : "Candidate-Healthcheck fehlgeschlagen");
    }

    this.throwIfDeploymentCancelled(deployment.id, signal);
    if (!isPreview && this.cancelIfSuperseded(project, deployment.id, commitSha)) {
      await this.removeContainer(runtimeName);
      return;
    }

    if (isPreview) {
      await this.activatePullRequestPreview(project, deployment.id, runtimeName, imageTag, internalPort, previousPreviewDeployment);
      return;
    }

    const activation = this.database.beginDeploymentActivation(deployment.id, project.id, commitSha);
    if (activation === "superseded") {
      await this.removeContainer(runtimeName);
      this.safeLog(deployment.id, "system", "Ein neuerer GitHub-Push liegt bereit; diese Version wird nicht aktiviert.");
      return;
    }
    if (activation !== "activation_started") {
      this.throwIfDeploymentCancelled(deployment.id, signal);
      throw new DeploymentActivationError("Deployment-Status hat sich vor der Aktivierung unerwartet geändert");
    }
    this.log(deployment.id, "system", "Healthcheck erfolgreich. Schalte das Routing atomar auf den Candidate um.");
    let rollbackStatus: DeploymentRollbackStatus = "not_required";
    try {
      if (!this.database.activateDeploymentRuntime(deployment.id, project.id, previousActiveDeploymentId)) {
        throw new DeploymentActivationError("Aktives Deployment hat sich vor dem Routing-Wechsel geändert");
      }
      reconcileRouting(this.config, this.database);
      if (!this.database.completeDeploymentActivation(deployment.id, project.id, new Date().toISOString())) {
        throw new DeploymentActivationError("Deployment konnte nach dem Routing-Wechsel nicht atomar abgeschlossen werden");
      }
    } catch (error) {
      const restored = this.database.restoreProjectActiveDeployment(
        project.id,
        deployment.id,
        previousActiveDeploymentId,
        project.static_base_path
      );
      try {
        if (!restored) throw new Error("Aktives Deployment konnte nicht auf die vorige Version zurückgesetzt werden");
        reconcileRouting(this.config, this.database);
        rollbackStatus = previousActiveDeploymentId ? "automatic_succeeded" : "not_required";
      } catch (rollbackError) {
        rollbackStatus = "automatic_failed";
        this.safeLog(
          deployment.id,
          "stderr",
          `Automatischer Rollback fehlgeschlagen: ${rollbackError instanceof Error ? rollbackError.message : "unbekannter Fehler"}`
        );
      }
      this.database.updateDeployment(deployment.id, {
        rollback_status: rollbackStatus,
        rollback_deployment_id: previousActiveDeploymentId
      });
      if (rollbackStatus !== "automatic_failed") {
        await this.removeContainer(runtimeName);
      }
      if (error instanceof DeploymentCancelledError || error instanceof CommandCancelledError) throw error;
      throw error instanceof DeploymentActivationError
        ? error
        : new DeploymentActivationError(error instanceof Error ? error.message : "Routing-Aktivierung fehlgeschlagen");
    }

    const previousDeployment = previousActiveDeploymentId
      ? this.database.getDeployment(previousActiveDeploymentId)
      : undefined;
    await this.removeObsoleteRuntimeContainers(
      project,
      runtimeName,
      previousDeployment,
      previousImage,
      previousRuntime?.name
    );
    this.safeLog(deployment.id, "system", "Deployment ist bereit und wurde aktiviert.");
    await this.capturePreview(project, deployment.id, runtimeName, internalPort);
    try {
      await this.pruneImages(project.id, imageTag);
    } catch (error) {
      this.safeLog(deployment.id, "stderr", `Aufräumen alter Images fehlgeschlagen (Deployment bleibt aktiv): ${error instanceof Error ? error.message : "unbekannter Fehler"}`);
    }
  }

  private async capturePreview(
    project: ProjectRow,
    deploymentId: string,
    containerName: string,
    port: number
  ): Promise<void> {
    const deployment = this.database.getDeployment(deploymentId);
    const staticBasePath = deployment?.static_base_path ?? project.static_base_path;
    const previewPath = staticBasePath && staticBasePath !== "/"
      ? `${staticBasePath.replace(/\/$/, "")}/`
      : "/";
    try {
      const preview = await captureProjectPreview(this.config, {
        projectId: project.id,
        deploymentId,
        url: `http://${containerName}:${port}${previewPath}`,
        networkName: this.projectNetworks.networkName(project.id),
        helperImage: this.config.CONTROL_PLANE_IMAGE
      });
      if (preview.status === "ready") {
        this.safeLog(deploymentId, "system", "Website-Vorschau wurde aktualisiert.");
      } else if (preview.reason === "not_html") {
        this.safeLog(deploymentId, "system", "Keine Website-Vorschau erzeugt: Die Startseite liefert kein HTML.");
      } else {
        this.safeLog(deploymentId, "stderr", "Website-Vorschau konnte nicht erzeugt werden; das Deployment bleibt aktiv.");
      }
    } catch (error) {
      this.safeLog(
        deploymentId,
        "stderr",
        `Website-Vorschau konnte nicht gespeichert werden (Deployment bleibt aktiv): ${error instanceof Error ? error.message : "unbekannter Fehler"}`
      );
    }
  }

  private async activatePullRequestPreview(
    project: ProjectRow,
    deploymentId: string,
    runtimeName: string,
    imageTag: string,
    internalPort: number,
    previousDeployment?: DeploymentRow
  ): Promise<void> {
    const deployment = this.database.getDeployment(deploymentId);
    const previewId = deployment?.preview_id;
    if (!deployment || !previewId) throw new DeploymentActivationError("Preview-Zuordnung fehlt");
    const preview = this.database.getPullRequestPreview(previewId);
    if (!preview || preview.deployment_id !== deploymentId || preview.status === "closing") {
      await this.removeContainer(runtimeName);
      throw new DeploymentCancelledError();
    }

    try {
      if (!preview.zone_id || !preview.dns_record_id) {
        throw new DeploymentActivationError("Preview-DNS ist noch nicht durch die Control Plane bereitgestellt");
      }

      if (!this.database.completePullRequestPreview(preview.id, deploymentId)) {
        throw new DeploymentActivationError("Preview-Status hat sich vor der Aktivierung geändert");
      }
      reconcileRouting(this.config, this.database);
      this.safeLog(deploymentId, "system", `Preview ist unter https://${preview.hostname} bereit.`);

      if (previousDeployment?.runtime_container && previousDeployment.runtime_container !== runtimeName) {
        await this.removeContainer(previousDeployment.runtime_container);
      }
      try {
        await this.pruneImages(project.id, imageTag);
      } catch (error) {
        this.safeLog(deploymentId, "stderr", `Aufräumen alter Preview-Images fehlgeschlagen: ${error instanceof Error ? error.message : "unbekannter Fehler"}`);
      }
    } catch (error) {
      const currentPreview = this.database.getPullRequestPreview(preview.id);
      if (currentPreview?.active_deployment_id === deploymentId) {
        const restored = this.database.restorePullRequestPreviewActive(
          preview.id,
          deploymentId,
          previousDeployment?.id ?? null
        );
        if (!restored) {
          this.safeLog(
            deploymentId,
            "stderr",
            "Automatischer Preview-Rollback fehlgeschlagen; der gesunde Candidate bleibt zur sicheren Wiederherstellung erhalten."
          );
          throw new DeploymentActivationError("Aktive Preview konnte nach dem Routing-Fehler nicht zurückgesetzt werden");
        }
      }
      await this.removeContainer(runtimeName);
      if (this.database.getDeployment(deploymentId)?.status === "ready") {
        this.database.updateDeployment(deploymentId, {
          status: "failed",
          failure_kind: "activation",
          error: error instanceof Error ? error.message : "Preview-Aktivierung fehlgeschlagen",
          finished_at: new Date().toISOString()
        });
      }
      this.database.failPullRequestPreview(
        preview.id,
        deploymentId,
        error instanceof Error ? error.message : "Preview-Aktivierung fehlgeschlagen"
      );
      reconcileRouting(this.config, this.database);
      throw error;
    }
  }

  private async cleanupNextPullRequestPreview(): Promise<boolean> {
    const preview = this.database.nextPullRequestPreviewCleanup();
    if (!preview) return false;
    const deployments = this.database.listPreviewDeployments(preview.id);
    const active = deployments.find((deployment) => (
      ["preparing", "building", "checking", "switching"].includes(deployment.status)
    ));
    if (active) {
      this.database.requestDeploymentCancellation(active.id);
      return false;
    }
    for (const deployment of deployments) {
      if (deployment.runtime_container) await this.removeContainer(deployment.runtime_container);
    }
    reconcileRouting(this.config, this.database);
    if (preview.status !== "closing") {
      this.database.requestPullRequestPreviewClose(preview.project_id, preview.id);
      return true;
    }
    // The API-side DNS reconciler owns Cloudflare credentials. Keep the local
    // preview in `closing` until it has safely removed the exact owned record.
    if (preview.zone_id || preview.dns_record_id) return false;
    this.database.closePullRequestPreview(preview.id);
    reconcileRouting(this.config, this.database);
    for (const image of new Set(deployments.map((deployment) => deployment.image_tag).filter((value): value is string => Boolean(value)))) {
      await this.command("docker", ["image", "rm", image], { allowFailure: true });
    }
    return true;
  }

  private async backfillProjectPreviews(): Promise<void> {
    for (const project of this.database.listProjects()) {
      if (!project.active_deployment_id) continue;
      const state = projectPreviewState(this.config, project.id, project.active_deployment_id);
      if (state?.status !== "pending") continue;
      const deployment = this.database.getDeployment(project.active_deployment_id);
      if (!deployment?.image_tag || !deployment.internal_port) continue;
      try {
        const runtime = await this.currentRuntime(project);
        if (!runtime) continue;
        await this.capturePreview(project, deployment.id, runtime.name, deployment.internal_port);
      } catch (error) {
        this.safeLog(
          deployment.id,
          "stderr",
          `Bestehende Website-Vorschau konnte nicht nachgezogen werden: ${error instanceof Error ? error.message : "unbekannter Fehler"}`
        );
      }
    }
  }

  private async prepareSource(project: ProjectRow, deployment: DeploymentRow, workspace: string, signal: AbortSignal): Promise<string> {
    const preparing = this.database.updateDeployment(deployment.id, { status: "preparing" });
    if (preparing?.cancel_requested_at || signal.aborted) throw new DeploymentCancelledError();
    const sourceRoot = path.join(workspace, "source");
    if (project.source_type === "git") {
      if (!project.repository_url || !project.repository_branch) throw new Error("Git-Quelle ist unvollständig");
      const branch = deployment.source_ref ?? project.repository_branch;
      this.log(deployment.id, "system", `Lade Git-Quelle (${branch}).`);
      return prepareGitSource({
        config: this.config,
        project,
        deployment,
        workspace,
        github: this.github,
        signal,
        onStdout: (line) => this.log(deployment.id, "stdout", line),
        onStderr: (line) => this.log(deployment.id, "stderr", line)
      });
    }

    const archivePath = resolveUploadArchiveForDeployment(this.config, this.database, project, deployment);
    if (!fs.existsSync(archivePath)) throw new Error("Quellarchiv fehlt");
    this.log(deployment.id, "system", "Entpacke geprüftes Quellarchiv.");
    await fs.promises.mkdir(sourceRoot, { recursive: true, mode: 0o700 });
    await extractZip(archivePath, { dir: sourceRoot });
    this.throwIfDeploymentCancelled(deployment.id, signal);
    return findContentRoot(sourceRoot, project.root_directory);
  }

  private async assertBuildDiskCapacity(): Promise<void> {
    let stats: fs.BigIntStatsFs;
    try {
      stats = await this.diskStat(this.config.DATA_DIR);
    } catch {
      throw new Error("Build blocked because free disk space could not be determined safely");
    }
    const availableBytes = stats.bavail * stats.bsize;
    const requiredBytes = BigInt(this.config.BUILD_MIN_FREE_GB) * BUILD_GIB;
    if (availableBytes < requiredBytes) {
      const availableGiB = Number(availableBytes / (BUILD_GIB / 10n)) / 10;
      throw new Error(
        `Build blocked because only ${availableGiB.toFixed(1)} GiB is free; `
        + `${this.config.BUILD_MIN_FREE_GB} GiB is required`
      );
    }
  }

  private async runWithDiskCapacityGuard<T>(
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    await this.assertBuildDiskCapacity();
    const diskAbort = new AbortController();
    const guardedSignal = AbortSignal.any([signal, diskAbort.signal]);
    let diskFailure: Error | null = null;
    let checking = false;
    const timer = setInterval(() => {
      if (checking || diskFailure || guardedSignal.aborted) return;
      checking = true;
      void this.assertBuildDiskCapacity()
        .catch((error: unknown) => {
          diskFailure = error instanceof Error ? error : new Error("Build disk capacity guard failed");
          diskAbort.abort();
        })
        .finally(() => {
          checking = false;
        });
    }, 500);
    timer.unref();
    try {
      const result = await operation(guardedSignal);
      if (diskFailure) throw diskFailure;
      await this.assertBuildDiskCapacity();
      return result;
    } catch (error) {
      if (diskFailure) throw diskFailure;
      throw error;
    } finally {
      clearInterval(timer);
    }
  }

  private async dockerBuild(
    deploymentId: string,
    imageTag: string,
    dockerfilePath: string,
    contextDirectory: string,
    project: ProjectRow,
    customDockerfile: boolean,
    fileStorage: boolean,
    signal: AbortSignal
  ): Promise<void> {
    const args = [
      "buildx", "build",
      "--builder", BUILDX_BUILDER_NAME,
      "--load",
      "--progress", "plain",
      "--label", "shelter.managed=true",
      "--label", `shelter.deployment=${deploymentId}`,
      "--label", "portsmith.managed=false",
      "--label", "portsmith.deployment=",
      "-t", imageTag
    ];
    if (this.buildResourceLimitsSupported) {
      args.push(
        "--resource", `memory=${this.config.BUILD_MEMORY}`,
        "--resource", `memory-swap=${this.config.BUILD_MEMORY_SWAP}`,
        "--resource", `cpu-period=${BUILD_CPU_PERIOD}`,
        "--resource", `cpu-quota=${this.buildCpuQuota()}`
      );
    }
    const deployment = this.database.getDeployment(deploymentId);
    const environmentRows = deployment?.deployment_scope === "preview"
      ? this.database.listPreviewEnvironment(project.id)
      : this.database.listEnvironment(project.id);
    const environment = fileStorage
      ? {}
      : Object.fromEntries(
          environmentRows.map((entry) => [
            entry.key,
            decryptString(entry.encrypted_value, this.config.APP_SECRET)
          ])
        );
    let secretPath: string | null = null;
    try {
      if (Object.keys(environment).length > 0) {
        secretPath = path.join(os.tmpdir(), `shelter-build-env-${deploymentId}-${randomUUID()}.json`);
        await fs.promises.writeFile(secretPath, JSON.stringify(environment), { mode: 0o600, flag: "wx" });
        args.push(...buildEnvironmentSecretArgs(secretPath));
        if (customDockerfile) args.push("--no-cache");
        else args.push("--build-arg", `SHELTER_CACHE_BUSTER=${deploymentId}`);
      }
      args.push(
        "-f", dockerfilePath,
        contextDirectory
      );
      await this.runWithDiskCapacityGuard(signal, (guardedSignal) => this.command("docker", args, {
        env: this.buildxEnvironment(),
        timeoutMs: this.config.BUILD_TIMEOUT_MINUTES * 60_000,
        signal: guardedSignal,
        onStdout: (line) => this.log(deploymentId, "stdout", line),
        onStderr: (line) => this.log(deploymentId, "stderr", line)
      }));
    } finally {
      if (secretPath) await fs.promises.rm(secretPath, { force: true });
    }
  }

  private async startContainer(
    name: string,
    imageTag: string,
    project: ProjectRow,
    port: number,
    restart: boolean,
    deploymentId?: string,
    signal?: AbortSignal
  ): Promise<void> {
    const runtimeKind = deploymentId
      ? this.database.getDeployment(deploymentId)?.runtime_kind
      : null;
    const deployment = deploymentId ? this.database.getDeployment(deploymentId) : undefined;
    const environmentRows = deployment?.deployment_scope === "preview"
      ? this.database.listPreviewEnvironment(project.id)
      : this.database.listEnvironment(project.id);
    const environment = runtimeKind === "files"
      ? []
      : environmentRows.map((entry) => [
          entry.key,
          decryptString(entry.encrypted_value, this.config.APP_SECRET)
        ] as const).filter(([key]) => !["PORT", "HOSTNAME", "NODE_ENV"].includes(key));
    const projectNetwork = await this.projectNetworks.prepareProject(project.id);
    const args = [
      "run", "-d", "--name", name,
      "--pull", "never",
      "--network", projectNetwork,
      "--restart", restart ? "unless-stopped" : "no",
      "--memory", project.memory_limit,
      "--cpus", project.cpu_limit,
      "--pids-limit", "512",
      "--security-opt", "no-new-privileges:true",
      "--cap-drop", "ALL",
      "--log-driver", "local",
      "--log-opt", "max-size=10m",
      "--log-opt", "max-file=3",
      "--label", "shelter.managed=true",
      "--label", `shelter.project=${project.id}`,
      "--label", `shelter.internal-port=${port}`,
      "--label", `shelter.candidate=${restart ? "false" : "true"}`,
      // Image labels are project-controlled. Neutralize identifiers that could
      // otherwise impersonate a legacy runtime or a Compose control service.
      "--label", "portsmith.managed=false",
      "--label", "portsmith.project=",
      "--label", "portsmith.deployment=",
      "--label", "com.docker.compose.project=",
      "--label", "com.docker.compose.service=",
      "-e", "NODE_ENV=production",
      "-e", `PORT=${port}`,
      "-e", "HOSTNAME=0.0.0.0"
    ];
    if (deploymentId) args.push("--label", `shelter.deployment=${deploymentId}`);
    for (const [key, value] of environment) args.push("-e", `${key}=${value}`);
    args.push(imageTag);
    await this.command("docker", args, signal ? { signal } : {});
  }

  private async waitForHealth(
    containerName: string,
    port: number,
    healthPath: string,
    deploymentId: string,
    signal?: AbortSignal
  ): Promise<void> {
    const deadline = Date.now() + this.config.HEALTHCHECK_TIMEOUT_SECONDS * 1000;
    const deployment = this.database.getDeployment(deploymentId);
    if (!deployment) throw new Error(`Deployment ${deploymentId} wurde vor dem Healthcheck entfernt`);
    const networkName = this.projectNetworks.networkName(deployment.project_id);
    let lastError = "keine Antwort";
    while (Date.now() < deadline) {
      if (signal) this.throwIfDeploymentCancelled(deploymentId, signal);
      const remaining = Math.max(250, deadline - Date.now());
      const inspect = await this.command(
        "docker",
        ["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", containerName],
        { allowFailure: true, timeoutMs: Math.min(2_500, remaining), ...(signal ? { signal } : {}) }
      );
      if (inspect.exitCode !== 0 || !inspect.stdout.startsWith("true")) {
        const logs = await this.command("docker", ["logs", "--tail", "40", containerName], {
          allowFailure: true,
          timeoutMs: Math.min(2_500, remaining),
          ...(signal ? { signal } : {})
        });
        if (logs.stdout) this.log(deploymentId, "stdout", logs.stdout);
        if (logs.stderr) this.log(deploymentId, "stderr", logs.stderr);
        throw new Error(`Container wurde vor dem Healthcheck beendet (${inspect.stdout || inspect.stderr})`);
      }
      try {
        const probe = await probeProjectContainer({
          projectId: deployment.project_id,
          deploymentId,
          networkName,
          targetContainer: containerName,
          port,
          path: healthPath,
          helperImage: this.config.CONTROL_PLANE_IMAGE,
          ...(signal ? { signal } : {})
        }, this.command);
        if (probe.ok) {
          this.log(deploymentId, "system", `Healthcheck ${healthPath}: ${probe.detail}.`);
          return;
        }
        lastError = probe.detail;
      } catch (error) {
        if (signal?.aborted) throw new DeploymentCancelledError();
        lastError = error instanceof Error ? error.message : "Verbindung fehlgeschlagen";
      }
      await wait(1_000, signal);
    }
    const logs = await this.command("docker", ["logs", "--tail", "80", containerName], { allowFailure: true, timeoutMs: 2_500 });
    if (logs.stdout) this.log(deploymentId, "stdout", logs.stdout);
    if (logs.stderr) this.log(deploymentId, "stderr", logs.stderr);
    throw new Error(`Healthcheck nach ${this.config.HEALTHCHECK_TIMEOUT_SECONDS}s fehlgeschlagen: ${lastError}. Prüfe, ob die App auf 0.0.0.0:${port} lauscht.`);
  }

  private async currentRuntime(project: ProjectRow, signal?: AbortSignal): Promise<{ name: string; image: string } | null> {
    const activeDeployment = project.active_deployment_id
      ? this.database.getDeployment(project.active_deployment_id)
      : undefined;
    const names = activeDeployment
      ? [
          ...deploymentContainerNames(project.slug, activeDeployment.id, activeDeployment.runtime_container),
          ...stableContainerNames(project.slug, activeDeployment.image_tag)
        ]
      : stableContainerNames(project.slug);
    for (const name of names) {
      const result = await runCommand("docker", ["inspect", "-f", "{{.Config.Image}}", name], {
        allowFailure: true,
        ...(signal ? { signal } : {})
      });
      if (result.exitCode === 0 && result.stdout.trim()) {
        if (isManagedVersionedRuntimeName(name) && !isDockerDnsLabel(name)) continue;
        if (
          activeDeployment &&
          isManagedVersionedRuntimeName(name) &&
          activeDeployment.runtime_container !== name
        ) this.database.updateDeployment(activeDeployment.id, { runtime_container: name });
        return { name, image: result.stdout.trim() };
      }
    }
    return null;
  }

  private async containerExists(name: string): Promise<boolean> {
    const result = await runCommand("docker", ["inspect", name], { allowFailure: true });
    return result.exitCode === 0;
  }

  private async containerDeploymentId(name: string): Promise<string | null> {
    return this.containerManagedLabel(name, "deployment");
  }

  private async containerManagedLabel(name: string, label: "deployment" | "project"): Promise<string | null> {
    for (const namespace of MANAGED_LABEL_NAMESPACES) {
      const result = await runCommand(
        "docker",
        ["inspect", "-f", `{{ index .Config.Labels \"${namespace}.${label}\" }}`, name],
        { allowFailure: true }
      );
      if (result.exitCode === 0 && result.stdout.trim()) return result.stdout.trim();
    }
    return null;
  }

  private async removeContainer(name: string): Promise<void> {
    await runCommand("docker", ["rm", "-f", "-v", name], { allowFailure: true });
  }

  private async pruneImages(projectId: string, activeImage: string): Promise<void> {
    const keep = new Set(
      this.database.listReadyDeployments(projectId, 3)
        .filter((deployment) => deployment.image_tag)
        .map((deployment) => deployment.image_tag as string)
    );
    for (const preview of this.database.listPullRequestPreviews(projectId)) {
      const deployment = preview.active_deployment_id
        ? this.database.getDeployment(preview.active_deployment_id)
        : undefined;
      if (deployment?.status === "ready" && deployment.image_tag) {
        keep.add(deployment.image_tag);
      }
    }
    keep.add(activeImage);
    for (const image of this.database.listRollbackLeasedImages(projectId)) keep.add(image);
    const old = this.database.listAllDeployments(projectId, 100)
      .map((deployment) => deployment.image_tag)
      .filter((image): image is string => Boolean(image) && !keep.has(image as string));
    for (const image of new Set(old)) await runCommand("docker", ["image", "rm", image], { allowFailure: true });
  }

  private async pruneFailedImages(projectId: string): Promise<void> {
    const keep = new Set(
      this.database.listReadyDeployments(projectId, 3)
        .map((deployment) => deployment.image_tag)
        .filter((image): image is string => Boolean(image))
    );
    for (const preview of this.database.listPullRequestPreviews(projectId)) {
      const deployment = preview.active_deployment_id
        ? this.database.getDeployment(preview.active_deployment_id)
        : undefined;
      if (deployment?.status === "ready" && deployment.image_tag) {
        keep.add(deployment.image_tag);
      }
    }
    const project = this.database.getProject(projectId);
    if (project?.active_deployment_id) {
      const activeImage = this.database.getDeployment(project.active_deployment_id)?.image_tag;
      if (activeImage) keep.add(activeImage);
    }
    for (const image of this.database.listRollbackLeasedImages(projectId)) keep.add(image);
    const prunable = this.database.listAllDeployments(projectId, 10_000)
      .filter((deployment) => deployment.status === "failed" || deployment.status === "cancelled")
      .map((deployment) => deployment.image_tag)
      .filter((image): image is string => typeof image === "string" && isManagedImage(image) && !keep.has(image));
    for (const image of new Set(prunable)) {
      await runCommand("docker", ["image", "rm", image], { allowFailure: true });
    }
  }

  private log(deploymentId: string, stream: "system" | "stdout" | "stderr", message: string): void {
    this.database.addLog(deploymentId, stream, message);
  }

  private safeLog(deploymentId: string, stream: "system" | "stdout" | "stderr", message: string): void {
    try {
      this.log(deploymentId, stream, message);
    } catch {
      // Post-commit diagnostics must never revert an already active deployment.
    }
  }

  private async reportGithubStatus(
    deployment: DeploymentRow,
    state: "pending" | "success" | "failure" | "error",
    description: string
  ): Promise<void> {
    const project = this.database.getProject(deployment.project_id);
    if (!project?.github_installation_id || !project.github_repository_id || !deployment.commit_sha) return;
    this.database.queueGithubStatus(deployment.id, state, description);
    await this.github.processNextCommitStatus(deployment.id);
  }

  private cancelIfSuperseded(project: ProjectRow, deploymentId: string, commitSha: string | null): boolean {
    if (!project.github_repository_id || !this.database.hasPendingGithubWork(project.id, commitSha)) return false;
    this.database.updateDeployment(deploymentId, {
      status: "cancelled",
      failure_kind: "superseded",
      rollback_status: project.active_deployment_id ? "automatic_succeeded" : "not_required",
      rollback_deployment_id: project.active_deployment_id,
      error: "Deployment wurde durch einen neueren GitHub-Push ersetzt",
      finished_at: new Date().toISOString()
    });
    this.safeLog(deploymentId, "system", "Ein neuerer GitHub-Push liegt bereit; diese Version wird nicht aktiviert.");
    return true;
  }

  private async recoverInterruptedDeployments(): Promise<void> {
    for (const containerId of await this.managedContainerIds({ name: "candidate", value: "true" })) {
      await this.removeContainer(containerId);
    }

    for (const deployment of this.database.listInterruptedDeployments()) {
      const project = this.database.getProject(deployment.project_id);
      if (!project) {
        this.database.updateDeployment(deployment.id, {
          status: "failed",
          error: "Project disappeared while recovering an interrupted deployment",
          finished_at: new Date().toISOString()
        });
        continue;
      }

      if (deployment.deployment_scope === "preview") {
        for (const runtimeName of deploymentContainerNames(
          project.slug,
          deployment.id,
          deployment.runtime_container
        )) await this.removeContainer(runtimeName);
        const message = "Preview-Deployment wurde durch einen Worker-Neustart unterbrochen";
        this.database.updateDeployment(deployment.id, {
          status: "failed",
          failure_kind: "worker",
          error: message,
          finished_at: new Date().toISOString()
        });
        if (deployment.preview_id) {
          this.database.failPullRequestPreview(deployment.preview_id, deployment.id, message);
          this.database.materializePullRequestPreview(deployment.preview_id, { allowWorkerRetry: true });
        }
        reconcileRouting(this.config, this.database);
        continue;
      }

      const runtimeNames = [
        ...deploymentContainerNames(project.slug, deployment.id, deployment.runtime_container),
        ...stableContainerNames(project.slug, deployment.image_tag)
      ];
      let runtimeName = runtimeNames[0] ?? deploymentContainerName(project.slug, deployment.id);
      let runtimeDeploymentId: string | null = null;
      for (const candidateName of new Set(runtimeNames)) {
        const candidateDeploymentId = await this.containerDeploymentId(candidateName);
        if (candidateDeploymentId === deployment.id) {
          runtimeName = candidateName;
          runtimeDeploymentId = candidateDeploymentId;
          break;
        }
      }
      const previousDeploymentId = deployment.rollback_deployment_id ?? null;
      const previousDeployment = previousDeploymentId
        ? this.database.getDeployment(previousDeploymentId)
        : undefined;

      if (
        deployment.status === "switching" &&
        runtimeDeploymentId === deployment.id &&
        (!isManagedVersionedRuntimeName(runtimeName) || isDockerDnsLabel(runtimeName)) &&
        deployment.image_tag &&
        deployment.internal_port
      ) {
        let rollbackStatus: DeploymentRollbackStatus = previousDeploymentId ? "automatic_failed" : "not_required";
        let candidateHealthy = false;
        try {
          this.log(deployment.id, "system", "Worker wurde während des Umschaltens neu gestartet; prüfe den versionsgebundenen Container.");
          await this.waitForHealth(runtimeName, deployment.internal_port, healthcheckPathFor(project, deployment), deployment.id);
          candidateHealthy = true;

          const currentProject = this.database.getProject(project.id);
          if (!currentProject) throw new DeploymentActivationError("Projekt ist während der Recovery nicht mehr verfügbar");
          if (currentProject.active_deployment_id !== deployment.id) {
            if (currentProject.active_deployment_id !== previousDeploymentId) {
              throw new DeploymentActivationError("Aktives Deployment hat sich während der Recovery geändert");
            }
            if (!this.database.activateDeploymentRuntime(deployment.id, project.id, previousDeploymentId)) {
              throw new DeploymentActivationError("Deployment konnte während der Recovery nicht aktiviert werden");
            }
          }

          reconcileRouting(this.config, this.database);
          if (!this.database.completeDeploymentActivation(deployment.id, project.id, new Date().toISOString())) {
            throw new DeploymentActivationError("Deployment-Recovery konnte nicht atomar abgeschlossen werden");
          }
          await this.removeObsoleteRuntimeContainers(project, runtimeName, previousDeployment, deployment.previous_image_tag);
          this.log(deployment.id, "system", "Unterbrochenes Umschalten wurde erfolgreich wiederhergestellt.");
          continue;
        } catch (error) {
          const latestProject = this.database.getProject(project.id);
          const restored = latestProject?.active_deployment_id === deployment.id
            ? this.database.restoreProjectActiveDeployment(
                project.id,
                deployment.id,
                previousDeploymentId,
                project.static_base_path
              )
            : latestProject?.active_deployment_id === previousDeploymentId;
          try {
            if (!restored) throw new Error("Aktives Deployment konnte nicht auf die vorige Version zurückgesetzt werden");
            const previousRuntime = previousDeployment
              ? await this.ensureDeploymentRuntime(project, previousDeployment, deployment.id)
              : null;
            if (previousDeploymentId && !previousRuntime) {
              throw new Error("Vorige Runtime ist nicht mehr verfügbar");
            }
            reconcileRouting(this.config, this.database);
            rollbackStatus = previousDeploymentId ? "automatic_succeeded" : "not_required";
          } catch (rollbackError) {
            rollbackStatus = "automatic_failed";
            this.safeLog(
              deployment.id,
              "stderr",
              `Automatischer Recovery-Rollback fehlgeschlagen: ${rollbackError instanceof Error ? rollbackError.message : "unbekannter Fehler"}`
            );
          }
          this.database.updateDeployment(deployment.id, {
            status: "failed",
            failure_kind: candidateHealthy ? "activation" : "healthcheck",
            rollback_status: rollbackStatus,
            rollback_deployment_id: previousDeploymentId,
            error: error instanceof Error ? error.message : "Recovery-Aktivierung fehlgeschlagen",
            finished_at: new Date().toISOString()
          });
          if (rollbackStatus !== "automatic_failed") await this.removeContainer(runtimeName);
          this.safeLog(deployment.id, "stderr", error instanceof Error ? error.message : "Recovery-Aktivierung fehlgeschlagen");
          continue;
        }
      }

      if (runtimeDeploymentId === deployment.id) await this.removeContainer(runtimeName);
      let interruptionRollbackStatus: DeploymentRollbackStatus = previousDeploymentId
        ? "automatic_failed"
        : "not_required";
      if (deployment.status === "switching" || previousDeploymentId) {
        try {
          const latestProject = this.database.getProject(project.id);
          if (!latestProject) throw new Error("Projekt ist während der Recovery nicht mehr verfügbar");
          if (latestProject.active_deployment_id === deployment.id) {
            if (!this.database.restoreProjectActiveDeployment(
              project.id,
              deployment.id,
              previousDeploymentId,
              project.static_base_path
            )) throw new Error("Aktives Deployment konnte nicht zurückgesetzt werden");
          } else if (latestProject.active_deployment_id !== previousDeploymentId) {
            throw new Error("Aktives Deployment hat sich während der Recovery geändert");
          }
          const previousRuntime = previousDeployment
            ? await this.ensureDeploymentRuntime(project, previousDeployment, deployment.id)
            : null;
          if (previousDeploymentId && !previousRuntime) throw new Error("Vorige Runtime ist nicht mehr verfügbar");
          reconcileRouting(this.config, this.database);
          interruptionRollbackStatus = previousDeploymentId ? "automatic_succeeded" : "not_required";
        } catch (rollbackError) {
          interruptionRollbackStatus = "automatic_failed";
          this.safeLog(
            deployment.id,
            "stderr",
            `Recovery-Rollback fehlgeschlagen: ${rollbackError instanceof Error ? rollbackError.message : "unbekannter Fehler"}`
          );
        }
      }
      if (deployment.cancel_requested_at) {
        this.database.finalizeDeploymentCancellation(
          deployment.id,
          interruptionRollbackStatus,
          previousDeploymentId
        );
        this.safeLog(deployment.id, "system", "Angefordertes Deployment wurde nach dem Worker-Neustart abgebrochen.");
        continue;
      }

      this.database.updateDeployment(deployment.id, {
        status: "failed",
        failure_kind: deployment.status === "switching" ? "activation" : "worker",
        rollback_status: interruptionRollbackStatus,
        rollback_deployment_id: previousDeploymentId,
        error: "Deployment wurde durch einen Worker-Neustart unterbrochen",
        finished_at: new Date().toISOString()
      });
      this.safeLog(deployment.id, "stderr", "Deployment wurde durch einen Worker-Neustart beendet; die vorige aktive Version bleibt online.");
    }
  }

  private async ensureDeploymentRuntime(
    project: ProjectRow,
    deployment: DeploymentRow,
    recoveryDeploymentId: string
  ): Promise<string | null> {
    const names = [
      ...deploymentContainerNames(project.slug, deployment.id, deployment.runtime_container),
      ...stableContainerNames(project.slug, deployment.image_tag)
    ];
    for (const name of new Set(names)) {
      if (await this.containerExists(name)) {
        if (isManagedVersionedRuntimeName(name) && !isDockerDnsLabel(name)) {
          await this.removeContainer(name);
          continue;
        }
        if (isManagedVersionedRuntimeName(name) && deployment.runtime_container !== name) {
          this.database.updateDeployment(deployment.id, { runtime_container: name });
        }
        return name;
      }
    }
    if (!deployment.image_tag || !deployment.internal_port) return null;

    const name = deploymentContainerName(project.slug, deployment.id);
    await this.startContainer(name, deployment.image_tag, project, deployment.internal_port, true, deployment.id);
    await this.waitForHealth(
      name,
      deployment.internal_port,
      healthcheckPathFor(project, deployment),
      recoveryDeploymentId
    );
    if (deployment.runtime_container !== name) this.database.updateDeployment(deployment.id, { runtime_container: name });
    return name;
  }

  private async removeObsoleteRuntimeContainers(
    project: ProjectRow,
    activeRuntimeName: string,
    previousDeployment?: DeploymentRow,
    previousImage?: string | null,
    observedRuntimeName?: string
  ): Promise<void> {
    const names = new Set([
      ...(observedRuntimeName ? [observedRuntimeName] : []),
      ...(previousDeployment
        ? deploymentContainerNames(project.slug, previousDeployment.id, previousDeployment.runtime_container)
        : []),
      ...stableContainerNames(project.slug, previousDeployment?.image_tag ?? previousImage)
    ]);
    names.delete(activeRuntimeName);
    for (const name of names) await this.removeContainer(name);
  }

  private async cleanupInactiveRuntimeContainers(): Promise<void> {
    for (const containerId of await this.managedContainerIds()) {
      const [projectId, deploymentId] = await Promise.all([
        this.containerManagedLabel(containerId, "project"),
        this.containerManagedLabel(containerId, "deployment")
      ]);
      if (!projectId || !deploymentId) continue;
      const project = this.database.getProject(projectId);
      const preview = this.database.getPullRequestPreviewByDeployment(deploymentId);
      const isActivePreview = preview?.active_deployment_id === deploymentId;
      if (project && project.active_deployment_id !== deploymentId && !isActivePreview) {
        await this.removeContainer(containerId);
      }
    }
  }

  private async reconcileCloudflaredRestart(): Promise<void> {
    const requested = this.database.getSetting("worker.cloudflared_restart_requested");
    if (!requested || requested === this.database.getSetting("worker.cloudflared_restart_completed")) return;
    const ids = new Set<string>();
    for (const projectName of COMPOSE_PROJECT_NAMES) {
      const containers = await runCommand("docker", [
        "ps", "-aq",
        "--filter", `label=com.docker.compose.project=${projectName}`,
        "--filter", "label=com.docker.compose.service=cloudflared"
      ], { allowFailure: true });
      for (const id of containers.stdout.split("\n").map((value) => value.trim()).filter(Boolean)) ids.add(id);
    }
    if (ids.size === 0) return;
    for (const id of ids) await runCommand("docker", ["restart", id]);
    this.database.setSetting("worker.cloudflared_restart_completed", requested);
  }

  private async resetWorkspaces(): Promise<void> {
    await fs.promises.rm(this.config.workspacesDir, { recursive: true, force: true });
    await fs.promises.mkdir(this.config.workspacesDir, { recursive: true, mode: 0o700 });
  }

  private async maintainDockerStorage(deploymentId: string): Promise<void> {
    try {
      await this.command("docker", [
        "buildx", "prune",
        "--builder", BUILDX_BUILDER_NAME,
        "-f",
        "--max-used-space", `${this.config.BUILD_CACHE_MAX_GB}gb`
      ], {
        env: this.buildxEnvironment(),
        timeoutMs: 5 * 60_000
      });
      for (const namespace of MANAGED_LABEL_NAMESPACES) {
        await this.command("docker", ["image", "prune", "-f", "--filter", `label=${namespace}.managed=true`], {
          timeoutMs: 5 * 60_000
        });
      }
      this.database.setSetting("worker.storage_maintenance", new Date().toISOString());
    } catch (error) {
      this.safeLog(deploymentId, "stderr", `Docker-Speicherbereinigung fehlgeschlagen: ${error instanceof Error ? error.message : "unbekannter Fehler"}`);
    }
  }
}

export function findContentRoot(sourceRoot: string, projectRoot = "."): string {
  const ignoredRootMetadata = new Set([".ds_store", "__macosx", "desktop.ini", "thumbs.db"]);
  const entries = fs.readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => !ignoredRootMetadata.has(entry.name.toLowerCase()));
  if (entries.length !== 1 || !entries[0]?.isDirectory()) return sourceRoot;
  const wrapper = resolveWithin(sourceRoot, entries[0].name);
  if (projectRoot === ".") return wrapper;
  const rawProjectRoot = resolveWithin(sourceRoot, projectRoot);
  const wrappedProjectRoot = resolveWithin(wrapper, projectRoot);
  // Preserve explicit archive-level paths. If both interpretations happen to
  // exist, the manual/raw meaning wins deterministically.
  if (fs.existsSync(rawProjectRoot)) return sourceRoot;
  if (fs.existsSync(wrappedProjectRoot)) return wrapper;
  return sourceRoot;
}

export function refreshProjectSourceAnalysis(
  database: Database,
  projectId: string,
  sourceDirectory: string
): ProjectAnalysis | null {
  try {
    const analysis = analyzeProjectDirectory(sourceDirectory);
    return database.updateProjectSourceAnalysis(projectId, JSON.stringify(analysis)) ? analysis : null;
  } catch {
    return null;
  }
}

function safeAnalyzeProjectDirectory(sourceDirectory: string): ProjectAnalysis | null {
  try {
    return analyzeProjectDirectory(sourceDirectory);
  } catch {
    return null;
  }
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DeploymentCancelledError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abortHandler);
      resolve();
    }, milliseconds);
    const abortHandler = (): void => {
      clearTimeout(timer);
      reject(new DeploymentCancelledError());
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
  });
}

export function hasActiveDeployment(database: Database, projectId: string): boolean {
  return database.listDeployments(projectId, 10).some((deployment) => activeStatuses.has(deployment.status));
}
