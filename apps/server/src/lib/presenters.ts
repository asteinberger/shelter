import type { DeploymentRow, DomainRow, ProjectDeletionRow, ProjectRow, PublicDeployment, PublicProject } from "../types/models.js";
import { parseStoredProjectAnalysis } from "../services/project-analysis.js";

export function presentDeployment(row: DeploymentRow): PublicDeployment {
  const started = row.started_at ? new Date(row.started_at).getTime() : null;
  const finished = row.finished_at ? new Date(row.finished_at).getTime() : null;
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    sourceRef: row.source_ref,
    imageTag: row.image_tag,
    internalPort: row.internal_port,
    runtimeKind: row.runtime_kind,
    runtimeDescription: row.runtime_description,
    failureKind: row.failure_kind ?? null,
    rollbackStatus: row.rollback_status ?? "not_required",
    rollbackDeploymentId: row.rollback_deployment_id ?? null,
    cancelRequestedAt: row.cancel_requested_at ?? null,
    commitSha: row.commit_sha,
    commitMessage: row.commit_message ?? null,
    commitAuthor: row.commit_author ?? null,
    commitUrl: row.commit_url ?? null,
    trigger: row.trigger ?? "manual",
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    durationSeconds: started && finished ? Math.max(0, Math.round((finished - started) / 1000)) : null
  };
}

export function presentProject(
  row: ProjectRow,
  domains?: DomainRow[],
  deployments?: DeploymentRow[],
  environmentKeys?: string[],
  deletion?: ProjectDeletionRow
): PublicProject {
  const currentDeployment = deployments?.[0];
  const deploying = currentDeployment && ["queued", "preparing", "building", "checking", "switching"].includes(currentDeployment.status);
  const status = deletion?.status === "failed"
    ? "deletion_failed"
    : deploying
      ? "deploying"
      : row.active_deployment_id
        ? "live"
        : currentDeployment?.status === "failed"
          ? "failed"
          : "draft";
  const project: PublicProject = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status,
    deletionStatus: deletion?.status ?? null,
    deletionError: deletion?.error ?? null,
    sourceType: row.source_type,
    repositoryUrl: row.repository_url,
    repositoryBranch: row.repository_branch,
    branch: row.repository_branch,
    staticBasePath: row.static_base_path,
    rootDirectory: row.root_directory,
    buildType: row.build_type,
    dockerfilePath: row.dockerfile_path,
    port: row.port,
    healthcheckPath: row.healthcheck_path,
    memoryLimit: row.memory_limit,
    cpuLimit: row.cpu_limit,
    activeDeploymentId: row.active_deployment_id,
    githubRepositoryId: row.github_repository_id ?? null,
    githubRepositoryFullName: row.github_repository_full_name ?? null,
    githubInstallationId: row.github_installation_id ?? null,
    githubConnectionError: row.github_connection_error ?? null,
    autoDeploy: row.auto_deploy === 1,
    sourceAnalysis: parseStoredProjectAnalysis(row.source_analysis_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };

  if (domains) {
    project.domains = domains.map((domain) => ({
      id: domain.id,
      hostname: domain.hostname,
      status: domain.status,
      error: domain.error
    }));
  }
  if (deployments) {
    project.deployments = deployments.map(presentDeployment);
    project.currentDeployment = currentDeployment ? presentDeployment(currentDeployment) : null;
  }
  if (environmentKeys) project.environmentKeys = environmentKeys;
  return project;
}
