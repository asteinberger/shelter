import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { presentDeployment, presentProject } from "../lib/presenters.js";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors.js";
import { decryptString, encryptString, newId, normalizeHostname, toSlug, validEnvironmentKey } from "../lib/security.js";
import { isValidStaticBasePath, STATIC_BASE_PATH_ERROR } from "../lib/static-base-path.js";
import type { DeploymentRow, ProjectRow } from "../types/models.js";
import { requireScopedAuth, requireScopedMutation, requireSessionMutationAuth } from "../services/auth.js";
import type { CloudflareService } from "../services/cloudflare.js";
import { ProjectDeletionService } from "../services/project-deletion.js";
import { MAX_PROJECT_PREVIEW_BYTES, projectPreviewImagePath, projectPreviewState } from "../services/project-preview.js";
import { panelHostnames } from "../services/panel-domains.js";
import { reconcileRouting } from "../services/routing.js";
import type { UploadService } from "../services/uploads.js";
import type { GitHubService } from "../services/github.js";
import {
  analyzeProjectFiles,
  analyzeZipProject,
  ProjectAnalysisRequestSchema,
  type ProjectAnalysis
} from "../services/project-analysis.js";

const RelativePath = z.string().min(1).max(240).refine((value) => {
  const normalized = value.replaceAll("\\", "/");
  return !normalized.startsWith("/") && !normalized.split("/").includes("..");
}, "Pfad muss relativ sein und darf kein '..' enthalten");

const reservedEnvironmentKeys = new Set(["PORT", "HOSTNAME", "NODE_ENV"]);
const MAX_ENVIRONMENT_BYTES = 256 * 1024;
const StaticBasePath = z.union([z.string(), z.null()]).refine(isValidStaticBasePath, STATIC_BASE_PATH_ERROR);
const MemoryLimit = z.string().trim().regex(/^\d+(?:\.\d+)?[bkmgBKMG]?$/).refine((value) => {
  const unit = value.at(-1)?.toLowerCase();
  const number = Number(unit && /[bkmg]/.test(unit) ? value.slice(0, -1) : value);
  const multiplier = unit === "g" ? 1024 ** 3 : unit === "m" ? 1024 ** 2 : unit === "k" ? 1024 : 1;
  const bytes = number * multiplier;
  return Number.isFinite(bytes) && bytes >= 64 * 1024 ** 2 && bytes <= 64 * 1024 ** 3;
}, "Arbeitsspeicher-Limit muss zwischen 64 MiB und 64 GiB liegen");
const CpuLimit = z.string().trim().regex(/^\d+(?:\.\d+)?$/).refine((value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0.1 && number <= 64;
}, "CPU-Limit muss zwischen 0.1 und 64 liegen");

function presentApiProject(config: AppConfig, ...args: Parameters<typeof presentProject>): ReturnType<typeof presentProject> {
  const project = presentProject(...args);
  const preview = projectPreviewState(config, args[0].id, args[0].active_deployment_id);
  if (preview) project.preview = preview;
  return project;
}

function projectDeployments(database: Database, project: ProjectRow, limit: number): DeploymentRow[] {
  const deployments = database.listDeployments(project.id, limit);
  if (!project.active_deployment_id || deployments.some((deployment) => deployment.id === project.active_deployment_id)) {
    return deployments;
  }
  const active = database.getDeployment(project.active_deployment_id);
  return active ? [...deployments, active] : deployments;
}
const GitBranch = z.string().trim().min(1).max(160).refine((branch) => (
  !branch.startsWith("-") &&
  !branch.startsWith("/") &&
  !branch.endsWith("/") &&
  !branch.endsWith(".") &&
  !branch.includes("..") &&
  !branch.includes("@{") &&
  !/[\u0000-\u0020~^:?*[\\]/.test(branch)
), "Git-Branch ist ungültig");

function validateGitRepositoryUrl(value: string, context: z.RefinementCtx, path: PropertyKey[] = ["repositoryUrl"]): void {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    context.addIssue({ code: "custom", message: "Für Git-Repositories ist im MVP HTTPS erforderlich", path });
  }
  if (url.username || url.password) {
    context.addIssue({ code: "custom", message: "Zugangsdaten dürfen nicht in der Repository-URL stehen", path });
  }
  if (url.search || url.hash) {
    context.addIssue({ code: "custom", message: "Repository-URLs dürfen keine Query- oder Fragmentwerte enthalten", path });
  }
  if (url.port && url.port !== "443") {
    context.addIssue({ code: "custom", message: "Git über HTTPS darf nur den Standardport 443 verwenden", path });
  }
}

const CommonProjectSchema = z.object({
  name: z.string().trim().min(2).max(80),
  rootDirectory: RelativePath.default("."),
  buildType: z.enum(["auto", "dockerfile", "node", "static"]).default("auto"),
  dockerfilePath: RelativePath.default("Dockerfile"),
  port: z.number().int().min(1).max(65535).default(3000),
  healthcheckPath: z.string().trim().startsWith("/").max(200).default("/"),
  staticBasePath: StaticBasePath.default(null),
  environment: z.array(z.object({
    key: z.string().min(1).max(100),
    value: z.string().max(65_536)
  })).max(200).default([])
});

const GitProjectSchema = CommonProjectSchema.extend({
  repositoryUrl: z.url(),
  branch: GitBranch.default("main")
}).superRefine((value, context) => {
  validateGitRepositoryUrl(value.repositoryUrl, context);
});

const GitHubProjectSchema = CommonProjectSchema.extend({
  installationId: z.string().trim().regex(/^\d+$/),
  repositoryId: z.string().trim().regex(/^\d+$/),
  branch: GitBranch,
  autoDeploy: z.boolean().default(true)
}).strict();

const GitHubLinkSchema = z.object({
  installationId: z.string().trim().regex(/^\d+$/),
  repositoryId: z.string().trim().regex(/^\d+$/),
  branch: GitBranch,
  autoDeploy: z.boolean().default(true)
}).strict();

const UploadProjectSchema = CommonProjectSchema.extend({
  uploadId: z.string().min(1),
  sourceLabel: z.string().max(255).optional()
});

const ReplaceUploadSourceSchema = z.object({
  uploadId: z.string().min(1).max(128),
  staticBasePath: StaticBasePath.optional()
}).strict();

const DeployProjectSchema = z.preprocess(
  (value) => value == null ? {} : value,
  z.object({ staticBasePath: StaticBasePath.optional() }).strict()
);

const UpdateProjectSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  repositoryUrl: z.url().optional(),
  repositoryBranch: GitBranch.optional(),
  autoDeploy: z.boolean().optional(),
  rootDirectory: RelativePath.optional(),
  buildType: z.enum(["auto", "dockerfile", "node", "static"]).optional(),
  dockerfilePath: RelativePath.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  healthcheckPath: z.string().trim().startsWith("/").max(200).optional(),
  staticBasePath: StaticBasePath.optional(),
  memoryLimit: MemoryLimit.optional(),
  cpuLimit: CpuLimit.optional()
}).strict().superRefine((value, context) => {
  if (value.repositoryUrl) validateGitRepositoryUrl(value.repositoryUrl, context);
});

function uniqueSlug(database: Database, name: string): string {
  const base = toSlug(name);
  let candidate = base;
  let counter = 2;
  while (database.getProjectBySlug(candidate)) {
    candidate = `${base.slice(0, 43)}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function assertStaticBasePathCompatible(
  staticBasePath: string | null,
  buildType: ProjectRow["build_type"]
): void {
  if (staticBasePath === null || staticBasePath === "/") return;
  if (buildType === "node" || buildType === "dockerfile") {
    const label = buildType === "node" ? "Node.js" : "Dockerfile";
    throw badRequest(
      `Ein Hosting-Basispfad unterhalb von '/' ist mit dem expliziten Build-Typ ${label} nicht kompatibel. Verwende 'Automatisch' oder 'Statisch'.`,
      "STATIC_BASE_PATH_INCOMPATIBLE"
    );
  }
}

function buildProject(
  config: AppConfig,
  database: Database,
  input: z.infer<typeof CommonProjectSchema>,
  source: Pick<ProjectRow, "source_type" | "repository_url" | "repository_branch" | "source_archive"> &
    Partial<Pick<ProjectRow,
      "github_repository_id" | "github_repository_full_name" | "github_installation_id" | "github_connection_error" | "auto_deploy" |
      "source_analysis_json"
    >>
): ProjectRow {
  const now = new Date().toISOString();
  return {
    id: newId("prj"),
    name: input.name,
    slug: uniqueSlug(database, input.name),
    github_repository_id: null,
    github_repository_full_name: null,
    github_installation_id: null,
    github_connection_error: null,
    source_analysis_json: null,
    auto_deploy: 0,
    ...source,
    static_base_path: input.staticBasePath,
    root_directory: input.rootDirectory,
    build_type: input.buildType,
    dockerfile_path: input.dockerfilePath,
    port: input.port,
    healthcheck_path: input.healthcheckPath,
    memory_limit: config.DEPLOYMENT_MEMORY,
    cpu_limit: config.DEPLOYMENT_CPUS,
    active_deployment_id: null,
    created_at: now,
    updated_at: now
  };
}

function mutableProject(database: Database, projectId: string): ProjectRow {
  const project = database.getProjectForDeletion(projectId);
  if (!project) throw notFound("Projekt nicht gefunden");
  const deletion = database.getProjectDeletion(projectId);
  if (deletion) {
    throw conflict(
      deletion.status === "failed"
        ? "Die fehlgeschlagene Projektlöschung muss erneut versucht werden"
        : "Das Projekt wird gerade gelöscht",
      deletion.status === "failed" ? "PROJECT_DELETION_FAILED" : "PROJECT_DELETION_ACTIVE"
    );
  }
  return project;
}

function assertNoActiveDeployment(database: Database, projectId: string): void {
  const active = database.listDeployments(projectId, 20).some((deployment) => (
    ["queued", "preparing", "building", "checking", "switching"].includes(deployment.status)
  ));
  if (active) {
    throw conflict(
      "Die Projektkonfiguration kann während eines laufenden Deployments nicht geändert werden",
      "DEPLOYMENT_ACTIVE"
    );
  }
}

function requireIdleProjectUpdate(
  database: Database,
  projectId: string,
  result: ReturnType<Database["updateProjectIfIdle"]>,
  conflictMessage: string
): ProjectRow {
  if (result.kind === "updated") return result.project;
  if (result.kind === "deployment_active") {
    throw conflict(
      "Die Projektkonfiguration kann während eines laufenden Deployments nicht geändert werden",
      "DEPLOYMENT_ACTIVE"
    );
  }
  mutableProject(database, projectId);
  throw conflict(conflictMessage, "PROJECT_MUTATION_CONFLICT");
}

function queueDeployment(
  database: Database,
  project: ProjectRow,
  sourceRef: string | null,
  requireMutable = false
): DeploymentRow {
  const deployment: DeploymentRow = {
    id: newId("dep"),
    project_id: project.id,
    status: "queued",
    source_ref: sourceRef,
    image_tag: null,
    previous_image_tag: null,
    internal_port: null,
    static_base_path: project.static_base_path,
    runtime_kind: null,
    runtime_description: null,
    commit_sha: null,
    commit_message: null,
    commit_author: null,
    commit_url: null,
    trigger: sourceRef?.startsWith("rollback:") ? "rollback" : "manual",
    github_delivery_id: null,
    error: null,
    started_at: null,
    finished_at: null,
    created_at: new Date().toISOString()
  };
  if (requireMutable) {
    if (!database.createDeploymentForMutableProject(deployment, project.updated_at)) {
      mutableProject(database, project.id);
      throw conflict("Projekt konnte nicht atomar in die Deployment-Warteschlange gestellt werden", "PROJECT_MUTATION_CONFLICT");
    }
  } else {
    database.createDeployment(deployment);
  }
  database.addLog(deployment.id, "system", "Deployment wurde in die Warteschlange gestellt.");
  return deployment;
}

function initialEnvironmentRows(config: AppConfig, projectId: string, variables: Array<{ key: string; value: string }>) {
  assertEnvironmentSize(variables);
  const seen = new Set<string>();
  const now = new Date().toISOString();
  return variables.map((variable) => {
    if (!validEnvironmentKey(variable.key)) throw badRequest(`Ungültiger Variablenname: ${variable.key}`, "INVALID_ENV_KEY");
    if (reservedEnvironmentKeys.has(variable.key)) throw badRequest(`${variable.key} wird von Shelter verwaltet`, "RESERVED_ENV_KEY");
    if (seen.has(variable.key)) throw badRequest(`Doppelter Variablenname: ${variable.key}`, "DUPLICATE_ENV_KEY");
    seen.add(variable.key);
    return {
      id: newId("env"),
      project_id: projectId,
      key: variable.key,
      encrypted_value: encryptString(variable.value, config.APP_SECRET),
      created_at: now,
      updated_at: now
    };
  });
}

function assertEnvironmentSize(variables: Array<{ key: string; value: string }>): void {
  const total = variables.reduce((bytes, variable) => (
    bytes + Buffer.byteLength(variable.key, "utf8") + Buffer.byteLength(variable.value, "utf8") + 2
  ), 0);
  if (total > MAX_ENVIRONMENT_BYTES) {
    throw badRequest("Umgebungsvariablen dürfen zusammen höchstens 256 KiB groß sein", "ENVIRONMENT_TOO_LARGE");
  }
}

async function analyzeUploadedSource(archivePath: string): Promise<ProjectAnalysis | null> {
  try {
    return await analyzeZipProject(archivePath);
  } catch {
    // Upload validity is decided by the hardened upload validator. Analysis is
    // advisory metadata and must never turn an otherwise valid source into a
    // project-creation blocker.
    return null;
  }
}

export function registerProjectRoutes(
  app: FastifyInstance,
  config: AppConfig,
  database: Database,
  uploads: UploadService,
  cloudflare: CloudflareService,
  github: GitHubService
): void {
  database.recoverPendingDomains();
  const projectDeletion = new ProjectDeletionService(config, database, cloudflare);

  app.get("/api/overview", { preHandler: requireScopedAuth("projects:read") }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const cloudflareState = cloudflare.state();
    const projects = database.listProjects();
    const deletions = new Map(projects.map((project) => [project.id, database.getProjectDeletion(project.id)]));
    const deployments = projects.flatMap((project) => database.listDeployments(project.id, 10));
    const latestByProject = new Map<string, DeploymentRow>();
    for (const deployment of [...deployments].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
      if (!latestByProject.has(deployment.project_id)) latestByProject.set(deployment.project_id, deployment);
    }
    const heartbeat = database.getSetting("worker.heartbeat");
    const workerOnline = heartbeat ? Date.now() - new Date(heartbeat).getTime() < 15_000 : false;
    return {
      stats: {
        projects: projects.length,
        deployments: deployments.length,
        running: projects.filter((project) => project.active_deployment_id && !deletions.get(project.id)).length,
        deploying: [...latestByProject.values()].filter((deployment) => ["queued", "preparing", "building", "checking", "switching"].includes(deployment.status)).length,
        failed: projects.filter((project) => (
          deletions.get(project.id)?.status === "failed" || latestByProject.get(project.id)?.status === "failed"
        )).length,
        domains: database.listDomains().length
      },
      projects: projects.map((project) => presentApiProject(config,
        project,
        database.listDomains(project.id),
        projectDeployments(database, project, 1),
        undefined,
        deletions.get(project.id)
      )),
      recentDeployments: deployments
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 8)
        .map((deployment) => ({
          ...presentDeployment(deployment),
          projectName: projects.find((project) => project.id === deployment.project_id)?.name ?? "Unbekanntes Projekt"
        })),
      system: {
        workerOnline,
        tunnelConfigured: cloudflareState.configured,
        accessProtection: cloudflareState.accessProtection
      }
    };
  });

  app.get("/api/projects", { preHandler: requireScopedAuth("projects:read") }, async () => ({
    projects: database.listProjects().map((project) => presentApiProject(config,
      project,
      database.listDomains(project.id),
      projectDeployments(database, project, 1),
      undefined,
      database.getProjectDeletion(project.id)
    ))
  }));

  app.post<{ Body: unknown }>("/api/projects/analyze", {
    preHandler: requireScopedAuth("projects:read"),
    bodyLimit: 4 * 1024 * 1024,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    // Do not throw Zod's raw parser error here: its production core error is
    // intentionally not guaranteed to extend Error, while Fastify only sends
    // Error instances through the configured application error handler.
    const parsed = ProjectAnalysisRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("Die Angaben für die Projektanalyse sind ungültig", "VALIDATION");
    }
    const input = parsed.data;
    reply.header("cache-control", "no-store");
    return { analysis: analyzeProjectFiles(input.files) };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", { preHandler: requireScopedAuth("projects:read") }, async (request, reply) => {
    const project = database.getProject(request.params.id);
    if (!project) return reply.code(404).send({ error: "Projekt nicht gefunden", code: "NOT_FOUND" });
    return {
      project: presentApiProject(config,
        project,
        database.listDomains(project.id),
        projectDeployments(database, project, 50),
        database.listEnvironment(project.id).map((entry) => entry.key),
        database.getProjectDeletion(project.id)
      )
    };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/preview", { preHandler: requireScopedAuth("projects:read") }, async (request, reply) => {
    const project = database.getProject(request.params.id);
    if (!project) return reply.code(404).send({ error: "Projekt nicht gefunden", code: "NOT_FOUND" });
    const preview = projectPreviewState(config, project.id, project.active_deployment_id);
    if (preview?.status !== "ready") {
      return reply.code(404).send({
        error: preview?.status === "unavailable"
          ? "Für dieses Projekt ist keine visuelle Vorschau verfügbar"
          : "Die Projektvorschau wird noch erzeugt",
        code: preview?.status === "unavailable" ? "PREVIEW_UNAVAILABLE" : "PREVIEW_PENDING"
      });
    }
    const imagePath = projectPreviewImagePath(config, project.id);
    try {
      const stat = await fs.promises.stat(imagePath);
      if (!stat.isFile() || stat.size > MAX_PROJECT_PREVIEW_BYTES) throw new Error("not a bounded preview file");
      reply.type("image/png");
      reply.header("cache-control", "private, max-age=300");
      reply.header("last-modified", stat.mtime.toUTCString());
      reply.header("content-length", String(stat.size));
      return reply.send(fs.createReadStream(imagePath));
    } catch {
      return reply.code(404).send({ error: "Die Projektvorschau wird noch erzeugt", code: "PREVIEW_PENDING" });
    }
  });

  app.post<{ Body: unknown }>("/api/projects/git", { preHandler: requireScopedMutation("projects:write") }, async (request, reply) => {
    const input = GitProjectSchema.parse(request.body);
    assertStaticBasePathCompatible(input.staticBasePath, input.buildType);
    const project = buildProject(config, database, input, {
      source_type: "git",
      repository_url: input.repositoryUrl,
      repository_branch: input.branch,
      source_archive: null
    });
    const environment = initialEnvironmentRows(config, project.id, input.environment);
    const deployment = database.sqlite.transaction(() => {
      database.createProject(project);
      if (environment.length > 0) database.replaceEnvironment(project.id, environment);
      return queueDeployment(database, project, input.branch);
    })();
    await reply.code(201).send({ project: presentApiProject(config, project, [], [deployment]), deployment: presentDeployment(deployment) });
  });

  app.post<{ Body: unknown }>("/api/projects/github", { preHandler: requireSessionMutationAuth }, async (request, reply) => {
    const input = GitHubProjectSchema.parse(request.body);
    assertStaticBasePathCompatible(input.staticBasePath, input.buildType);
    const resolved = await github.resolveRepository(input.installationId, input.repositoryId, input.branch);
    const sourceAnalysis = await github.analyzeRepository(
      input.installationId,
      input.repositoryId,
      input.branch,
      resolved
    ).catch(() => null);
    const project = buildProject(config, database, input, {
      source_type: "git",
      repository_url: resolved.repository.cloneUrl,
      repository_branch: input.branch,
      source_archive: null,
      github_repository_id: resolved.repository.id,
      github_repository_full_name: resolved.repository.fullName,
      github_installation_id: input.installationId,
      github_connection_error: null,
      source_analysis_json: sourceAnalysis ? JSON.stringify(sourceAnalysis) : null,
      auto_deploy: input.autoDeploy ? 1 : 0
    });
    const environment = initialEnvironmentRows(config, project.id, input.environment);
    const deployment = database.sqlite.transaction(() => {
      database.createProject(project);
      if (environment.length > 0) database.replaceEnvironment(project.id, environment);
      return queueDeployment(database, project, input.branch);
    })();
    await reply.code(201).send({
      project: presentApiProject(config, project, [], [deployment]),
      deployment: presentDeployment(deployment)
    });
  });

  app.post<{ Body: unknown }>("/api/projects/upload", { preHandler: requireScopedMutation("uploads:write") }, async (request, reply) => {
    const input = UploadProjectSchema.parse(request.body);
    assertStaticBasePathCompatible(input.staticBasePath, input.buildType);
    const candidateUpload = uploads.consume(input.uploadId);
    const sourceAnalysis = await analyzeUploadedSource(candidateUpload.archive_path!);
    const createUploadedProject = database.sqlite.transaction(() => {
      // Keep consuming the upload and creating its project in one database
      // transaction so cleanup cannot remove the archive in between.
      const upload = uploads.consume(input.uploadId);
      const attached = database.sqlite.prepare("SELECT id FROM projects WHERE source_archive = ? LIMIT 1")
        .get(upload.archive_path) as { id: string } | undefined;
      if (attached) throw conflict("Dieser Upload ist bereits einem Projekt zugeordnet", "UPLOAD_ALREADY_ATTACHED");
      const project = buildProject(config, database, input, {
        source_type: "upload",
        repository_url: null,
        repository_branch: null,
        source_archive: upload.archive_path,
        source_analysis_json: sourceAnalysis ? JSON.stringify(sourceAnalysis) : null
      });
      const environment = initialEnvironmentRows(config, project.id, input.environment);
      database.createProject(project);
      if (environment.length > 0) database.replaceEnvironment(project.id, environment);
      return { project, deployment: queueDeployment(database, project, input.uploadId) };
    });
    const { project, deployment } = createUploadedProject.immediate();
    await reply.code(201).send({ project: presentApiProject(config, project, [], [deployment]), deployment: presentDeployment(deployment) });
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/source", { preHandler: requireScopedMutation("uploads:write") }, async (request, reply) => {
    const input = ReplaceUploadSourceSchema.parse(request.body);
    const candidateUpload = uploads.consume(input.uploadId);
    const sourceAnalysis = await analyzeUploadedSource(candidateUpload.archive_path!);
    const replaceSource = database.sqlite.transaction(() => {
      const project = mutableProject(database, request.params.id);
      if (project.source_type !== "upload") {
        throw badRequest("Quelldateien können nur bei direkt hochgeladenen Projekten ersetzt werden", "SOURCE_TYPE_MISMATCH");
      }

      const staticBasePath = input.staticBasePath === undefined ? project.static_base_path : input.staticBasePath;
      assertStaticBasePathCompatible(staticBasePath, project.build_type);
      const upload = uploads.consume(input.uploadId);
      const existingDeployment = project.source_archive === upload.archive_path && project.static_base_path === staticBasePath
        ? database.findDeploymentBySourceSnapshot(project.id, input.uploadId, staticBasePath)
        : undefined;
      if (existingDeployment) return { project, deployment: existingDeployment };

      if (database.listDeployments(project.id, 20).some((deployment) => ["queued", "preparing", "building", "checking", "switching"].includes(deployment.status))) {
        throw conflict("Für dieses Projekt läuft bereits ein Deployment", "DEPLOYMENT_ACTIVE");
      }

      const attached = database.sqlite.prepare("SELECT id FROM projects WHERE source_archive = ? AND id != ? LIMIT 1")
        .get(upload.archive_path, project.id) as { id: string } | undefined;
      if (attached) throw conflict("Dieser Upload ist bereits einem anderen Projekt zugeordnet", "UPLOAD_ALREADY_ATTACHED");

      const updated = database.updateProject(project.id, {
        source_archive: upload.archive_path,
        static_base_path: staticBasePath,
        source_analysis_json: sourceAnalysis ? JSON.stringify(sourceAnalysis) : null
      });
      if (!updated) {
        mutableProject(database, project.id);
        throw conflict("Projektstatus hat sich während der Änderung geändert", "PROJECT_MUTATION_CONFLICT");
      }
      const deployment = queueDeployment(database, updated, input.uploadId, true);
      return { project: updated, deployment };
    });

    const result = replaceSource.immediate();
    await reply.code(202).send({
      project: presentApiProject(config,
        result.project,
        database.listDomains(result.project.id),
        database.listDeployments(result.project.id, 50),
        database.listEnvironment(result.project.id).map((entry) => entry.key)
      ),
      deployment: presentDeployment(result.deployment)
    });
  });

  app.delete<{ Params: { id: string }; Body: unknown }>("/api/projects/:id", { preHandler: requireScopedMutation("projects:write") }, async (request, reply) => {
    const input = z.object({ confirmation: z.string().max(80) }).parse(request.body);
    const deletion = await projectDeletion.request(request.params.id, input.confirmation);
    await reply.code(202).send({ ok: true, status: deletion.status });
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/api/projects/:id", { preHandler: requireScopedMutation("projects:write") }, async (request, reply) => {
    const current = mutableProject(database, request.params.id);
    const input = UpdateProjectSchema.parse(request.body);
    if ((input.repositoryUrl !== undefined || input.repositoryBranch !== undefined) && current.source_type !== "git") {
      throw badRequest("Repository-Einstellungen können nur bei Git-Projekten geändert werden", "SOURCE_TYPE_MISMATCH");
    }
    if (input.repositoryUrl !== undefined && current.github_repository_id) {
      throw badRequest(
        "Ein mit GitHub verbundenes Repository muss zuerst von GitHub getrennt werden",
        "GITHUB_PROJECT_LINKED"
      );
    }
    if (input.autoDeploy !== undefined && !current.github_repository_id) {
      throw badRequest("Auto-Deploy ist nur für ein verbundenes GitHub-Repository verfügbar", "GITHUB_PROJECT_NOT_LINKED");
    }
    if (
      input.repositoryBranch !== undefined &&
      current.github_installation_id &&
      current.github_repository_id
    ) {
      await github.resolveRepository(
        current.github_installation_id,
        current.github_repository_id,
        input.repositoryBranch
      );
    }
    assertStaticBasePathCompatible(
      input.staticBasePath === undefined ? current.static_base_path : input.staticBasePath,
      input.buildType ?? current.build_type
    );
    const changesDeploymentConfiguration = Object.keys(input).some((key) => key !== "name");
    if (changesDeploymentConfiguration) assertNoActiveDeployment(database, current.id);
    const updates: Parameters<Database["updateProject"]>[1] = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.repositoryUrl !== undefined) updates.repository_url = input.repositoryUrl;
    if (input.repositoryBranch !== undefined) {
      updates.repository_branch = input.repositoryBranch;
      if (current.github_repository_id) updates.github_connection_error = null;
    }
    if (input.autoDeploy !== undefined) updates.auto_deploy = input.autoDeploy ? 1 : 0;
    if (input.rootDirectory !== undefined) updates.root_directory = input.rootDirectory;
    if (input.buildType !== undefined) updates.build_type = input.buildType;
    if (input.dockerfilePath !== undefined) updates.dockerfile_path = input.dockerfilePath;
    if (input.port !== undefined) updates.port = input.port;
    if (input.healthcheckPath !== undefined) updates.healthcheck_path = input.healthcheckPath;
    if (input.staticBasePath !== undefined) updates.static_base_path = input.staticBasePath;
    if (input.memoryLimit !== undefined) updates.memory_limit = input.memoryLimit;
    if (input.cpuLimit !== undefined) updates.cpu_limit = input.cpuLimit;
    const project = changesDeploymentConfiguration
      ? requireIdleProjectUpdate(
          database,
          current.id,
          database.updateProjectIfIdle(current.id, current.updated_at, updates, {
            clearPendingGithubPush: input.repositoryBranch !== undefined || input.autoDeploy === false
          }),
          "Projektstatus hat sich während der Änderung geändert"
        )
      : database.updateProject(current.id, updates);
    if (!project) {
      mutableProject(database, current.id);
      throw conflict("Projektstatus hat sich während der Änderung geändert", "PROJECT_MUTATION_CONFLICT");
    }
    return { project: presentApiProject(config, project, database.listDomains(current.id), database.listDeployments(current.id)) };
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/github", { preHandler: requireSessionMutationAuth }, async (request) => {
    const current = mutableProject(database, request.params.id);
    if (current.source_type !== "git") {
      throw badRequest("Nur Git-Projekte können mit GitHub verbunden werden", "SOURCE_TYPE_MISMATCH");
    }
    assertNoActiveDeployment(database, current.id);
    const input = GitHubLinkSchema.parse(request.body);
    const resolved = await github.resolveRepository(input.installationId, input.repositoryId, input.branch);
    const sourceAnalysis = await github.analyzeRepository(
      input.installationId,
      input.repositoryId,
      input.branch,
      resolved
    ).catch(() => null);
    const project = requireIdleProjectUpdate(
      database,
      current.id,
      database.updateProjectIfIdle(current.id, current.updated_at, {
        repository_url: resolved.repository.cloneUrl,
        repository_branch: input.branch,
        github_repository_id: resolved.repository.id,
        github_repository_full_name: resolved.repository.fullName,
        github_installation_id: input.installationId,
        github_connection_error: null,
        source_analysis_json: sourceAnalysis ? JSON.stringify(sourceAnalysis) : null,
        auto_deploy: input.autoDeploy ? 1 : 0,
        preview_deployments_enabled: 0,
        preview_domain_id: null,
        preview_domain_suffix: null
      }, { clearPendingGithubPush: true }),
      "Projektstatus hat sich während der GitHub-Verknüpfung geändert"
    );
    for (const preview of database.listPullRequestPreviews(project.id)) {
      if (preview.status !== "closed") database.requestPullRequestPreviewClose(project.id, preview.id);
    }
    return {
      project: presentApiProject(config,
        project,
        database.listDomains(project.id),
        database.listDeployments(project.id, 50),
        database.listEnvironment(project.id).map((entry) => entry.key)
      )
    };
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id/github", { preHandler: requireSessionMutationAuth }, async (request) => {
    const current = mutableProject(database, request.params.id);
    if (current.source_type !== "git" || !current.github_repository_id) {
      throw badRequest("Dieses Projekt ist nicht mit GitHub verbunden", "GITHUB_PROJECT_NOT_LINKED");
    }
    assertNoActiveDeployment(database, current.id);
    const project = requireIdleProjectUpdate(
      database,
      current.id,
      database.updateProjectIfIdle(current.id, current.updated_at, {
        github_repository_id: null,
        github_repository_full_name: null,
        github_installation_id: null,
        github_connection_error: null,
        auto_deploy: 0,
        preview_deployments_enabled: 0,
        preview_domain_id: null,
        preview_domain_suffix: null
      }, { clearPendingGithubPush: true }),
      "Projektstatus hat sich während der GitHub-Trennung geändert"
    );
    for (const preview of database.listPullRequestPreviews(project.id)) {
      if (preview.status !== "closed") database.requestPullRequestPreviewClose(project.id, preview.id);
    }
    return {
      project: presentApiProject(config,
        project,
        database.listDomains(project.id),
        database.listDeployments(project.id, 50),
        database.listEnvironment(project.id).map((entry) => entry.key)
      )
    };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/deploy", { preHandler: requireScopedMutation("deployments:write") }, async (request, reply) => {
    const input = DeployProjectSchema.parse(request.body);
    const queueCurrentSource = database.sqlite.transaction(() => {
      let project = mutableProject(database, request.params.id);
      const staticBasePath = input.staticBasePath === undefined ? project.static_base_path : input.staticBasePath;
      assertStaticBasePathCompatible(staticBasePath, project.build_type);
      if (database.listDeployments(project.id, 5).some((deployment) => ["queued", "preparing", "building", "checking", "switching"].includes(deployment.status))) {
        throw conflict("Für dieses Projekt läuft bereits ein Deployment", "DEPLOYMENT_ACTIVE");
      }
      if (input.staticBasePath !== undefined) {
        const updated = database.updateProject(project.id, { static_base_path: staticBasePath });
        if (!updated) {
          mutableProject(database, project.id);
          throw conflict("Projektstatus hat sich während der Änderung geändert", "PROJECT_MUTATION_CONFLICT");
        }
        project = updated;
      }
      const sourceRef = project.source_type === "git" ? project.repository_branch : pathBase(project.source_archive);
      return queueDeployment(database, project, sourceRef, true);
    });
    const deployment = queueCurrentSource.immediate();
    await reply.code(202).send({ deployment: presentDeployment(deployment) });
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/rollback", { preHandler: requireScopedMutation("deployments:write") }, async (request, reply) => {
    const project = mutableProject(database, request.params.id);
    const input = z.object({ deploymentId: z.string() }).parse(request.body);
    const result = database.queueRollbackDeployment(input.deploymentId, project.id);
    if (result.kind === "invalid_target") {
      return reply.code(400).send({ error: "Deployment ist nicht für einen Rollback verfügbar", code: "INVALID_ROLLBACK" });
    }
    if (result.kind === "deployment_active") {
      return reply.code(409).send({ error: "Für dieses Projekt läuft bereits ein Deployment", code: "DEPLOYMENT_ACTIVE" });
    }
    if (result.kind === "project_unavailable") {
      return reply.code(409).send({ error: "Projekt ist derzeit nicht für einen Rollback verfügbar", code: "PROJECT_UNAVAILABLE" });
    }
    await reply.code(202).send({ deployment: presentDeployment(result.deployment) });
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/environment", { preHandler: requireScopedMutation("environment:write") }, async (request, reply) => {
    const project = mutableProject(database, request.params.id);
    assertNoActiveDeployment(database, project.id);
    const input = z.object({
      variables: z.array(z.object({ key: z.string().min(1).max(100), value: z.string().max(65_536).optional() })).max(200)
    }).parse(request.body);
    const existing = new Map(database.listEnvironment(project.id).map((row) => [row.key, row]));
    const seen = new Set<string>();
    const now = new Date().toISOString();
    const effectiveValues: Array<{ key: string; value: string }> = [];
    const rows = input.variables.map((variable) => {
      if (!validEnvironmentKey(variable.key)) throw badRequest(`Ungültiger Variablenname: ${variable.key}`, "INVALID_ENV_KEY");
      if (reservedEnvironmentKeys.has(variable.key)) throw badRequest(`${variable.key} wird von Shelter verwaltet`, "RESERVED_ENV_KEY");
      if (seen.has(variable.key)) throw badRequest(`Doppelter Variablenname: ${variable.key}`, "DUPLICATE_ENV_KEY");
      seen.add(variable.key);
      const previous = existing.get(variable.key);
      if (variable.value === undefined && !previous) throw badRequest(`Wert für ${variable.key} fehlt`, "ENV_VALUE_REQUIRED");
      effectiveValues.push({
        key: variable.key,
        value: variable.value ?? decryptString((previous as NonNullable<typeof previous>).encrypted_value, config.APP_SECRET)
      });
      return {
        id: previous?.id ?? newId("env"),
        project_id: project.id,
        key: variable.key,
        encrypted_value: variable.value === undefined ? (previous as NonNullable<typeof previous>).encrypted_value : encryptString(variable.value, config.APP_SECRET),
        created_at: previous?.created_at ?? now,
        updated_at: now
      };
    });
    assertEnvironmentSize(effectiveValues);
    if (!database.replaceEnvironmentForMutableProject(project.id, rows)) {
      mutableProject(database, project.id);
      throw conflict("Projektstatus hat sich während der Änderung geändert", "PROJECT_MUTATION_CONFLICT");
    }
    return { environmentKeys: rows.map((row) => row.key) };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/domains", { preHandler: requireScopedMutation("domains:write") }, async (request, reply) => {
    const project = mutableProject(database, request.params.id);
    const input = z.object({
      hostname: z.string(),
      zoneId: z.string().trim().min(1).max(128).optional()
    }).strict().parse(request.body);
    const hostname = normalizeHostname(input.hostname);
    if (panelHostnames(database).includes(hostname)) {
      return reply.code(409).send({ error: "Diese Domain ist für das Shelter-Panel reserviert", code: "PANEL_DOMAIN" });
    }
    const pending = database.createOrRetryPendingDomain({
      id: newId("dom"),
      project_id: project.id,
      hostname,
      zone_id: input.zoneId ?? null,
      dns_record_id: null,
      status: "pending" as const,
      error: null,
      created_at: new Date().toISOString()
    });
    if (pending.kind === "project_unavailable") {
      mutableProject(database, project.id);
      throw conflict("Projektstatus hat sich während der Domain-Anlage geändert", "PROJECT_MUTATION_CONFLICT");
    }
    if (pending.kind === "domain_exists") {
      return reply.code(409).send({ error: "Domain ist bereits einem Projekt zugeordnet", code: "DOMAIN_EXISTS" });
    }

    let provisioned: { zoneId: string; recordId: string } | undefined;
    try {
      provisioned = await cloudflare.ensureDnsRecord(hostname, input.zoneId);
      if (!database.activatePendingDomain(pending.domain.id, project.id, {
        zone_id: provisioned.zoneId,
        dns_record_id: provisioned.recordId
      })) {
        // If the local state cannot commit after Cloudflare succeeded, remove
        // only the just-verified owned record instead of orphaning it.
        await cloudflare.deleteDnsRecord(provisioned.zoneId, provisioned.recordId, hostname);
        throw conflict("Domainstatus hat sich während der Einrichtung geändert", "DOMAIN_STATE_CONFLICT");
      }
    } catch (error) {
      if (error instanceof HttpError && error.code === "ZONE_MISMATCH") {
        database.deleteDomain(pending.domain.id);
        throw error;
      }
      const message = error instanceof Error ? error.message : "Cloudflare DNS konnte nicht angelegt werden";
      database.failPendingDomain(pending.domain.id, message, provisioned && {
        zone_id: provisioned.zoneId,
        dns_record_id: provisioned.recordId
      });
    }
    reconcileRouting(config, database);
    const created = database.getDomain(pending.domain.id);
    await reply.code(created?.status === "active" ? 201 : 202).send({
      domain: created && { id: created.id, hostname: created.hostname, status: created.status, error: created.error }
    });
  });

  app.delete<{ Params: { id: string; domainId: string } }>("/api/projects/:id/domains/:domainId", { preHandler: requireScopedMutation("domains:write") }, async (request, reply) => {
    const project = mutableProject(database, request.params.id);
    if (project.preview_deployments_enabled === 1 && project.preview_domain_id === request.params.domainId) {
      throw conflict(
        "Deaktiviere Pull-Request-Previews oder wähle zuerst eine andere Preview-Domain",
        "PREVIEW_DOMAIN_IN_USE"
      );
    }
    const claimed = database.claimDomainDeletion(request.params.id, request.params.domainId);
    if (claimed.kind === "project_unavailable") {
      mutableProject(database, request.params.id);
      throw conflict("Projektstatus hat sich während der Domain-Löschung geändert", "PROJECT_MUTATION_CONFLICT");
    }
    if (claimed.kind === "not_found") {
      return reply.code(404).send({ error: "Domain nicht gefunden", code: "NOT_FOUND" });
    }
    if (claimed.kind === "domain_pending") {
      return reply.code(409).send({ error: "Die Domain wird gerade verändert", code: "DOMAIN_MUTATION_ACTIVE" });
    }
    reconcileRouting(config, database);
    try {
      await cloudflare.deleteDnsRecord(
        claimed.domain.zone_id,
        claimed.domain.dns_record_id,
        claimed.domain.hostname
      );
      database.deleteDomain(claimed.domain.id);
    } catch (error) {
      database.failPendingDomain(
        claimed.domain.id,
        error instanceof Error ? error.message : "Cloudflare DNS konnte nicht gelöscht werden"
      );
      reconcileRouting(config, database);
      throw error;
    }
    reconcileRouting(config, database);
    return { ok: true };
  });
}

function pathBase(value: string | null): string | null {
  if (!value) return null;
  const parts = value.replaceAll("\\", "/").split("/");
  return parts.at(-2) ?? parts.at(-1) ?? null;
}
