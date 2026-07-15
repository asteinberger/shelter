import type { ProjectAnalysis } from "../services/project-analysis.js";

export type SourceType = "git" | "upload";
export type BuildType = "auto" | "dockerfile" | "node" | "static";
export type DeploymentStatus =
  | "queued"
  | "preparing"
  | "building"
  | "checking"
  | "switching"
  | "ready"
  | "failed"
  | "cancelled";

export type DeploymentTrigger = "manual" | "github_push" | "rollback";

export type DeploymentFailureKind =
  | "timeout"
  | "cancelled"
  | "build"
  | "healthcheck"
  | "activation"
  | "worker"
  | "superseded";

export type DeploymentRollbackStatus =
  | "not_required"
  | "automatic_succeeded"
  | "automatic_failed";

export type ProjectDeletionStatus = "preparing" | "queued" | "running" | "failed";

export type ApiTokenScope =
  | "projects:read"
  | "projects:write"
  | "deployments:write"
  | "uploads:write"
  | "domains:write"
  | "environment:write";

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
}

export interface SessionRow {
  token_hash: string;
  user_id: string;
  csrf_hash: string;
  csrf_token: string | null;
  expires_at: string;
  created_at: string;
}

export interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  token_hint: string;
  scopes_json: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ApiTokenMetadataRow = Omit<ApiTokenRow, "token_hash">;

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  source_type: SourceType;
  repository_url: string | null;
  repository_branch: string | null;
  source_archive: string | null;
  static_base_path: string | null;
  root_directory: string;
  build_type: BuildType;
  dockerfile_path: string;
  port: number;
  healthcheck_path: string;
  memory_limit: string;
  cpu_limit: string;
  active_deployment_id: string | null;
  /** GitHub App linkage. Optional on input for backwards-compatible migrations/tests. */
  github_repository_id?: string | null;
  github_repository_full_name?: string | null;
  github_installation_id?: string | null;
  auto_deploy?: 0 | 1;
  github_connection_error?: string | null;
  /** Last server-validated source analysis. Optional for backwards-compatible tests/migrations. */
  source_analysis_json?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectDeletionRow {
  project_id: string;
  status: ProjectDeletionStatus;
  error: string | null;
  requested_at: string;
  updated_at: string;
}

export interface DomainRow {
  id: string;
  project_id: string;
  hostname: string;
  zone_id: string | null;
  dns_record_id: string | null;
  status: "pending" | "active" | "error";
  error: string | null;
  created_at: string;
}

export interface DeploymentRow {
  id: string;
  project_id: string;
  status: DeploymentStatus;
  source_ref: string | null;
  image_tag: string | null;
  previous_image_tag: string | null;
  internal_port: number | null;
  static_base_path: string | null;
  runtime_kind: "dockerfile" | "next" | "node" | "static" | "files" | null;
  runtime_description: string | null;
  runtime_container?: string | null;
  failure_kind?: DeploymentFailureKind | null;
  rollback_status?: DeploymentRollbackStatus;
  rollback_deployment_id?: string | null;
  cancel_requested_at?: string | null;
  commit_sha: string | null;
  commit_message?: string | null;
  commit_author?: string | null;
  commit_url?: string | null;
  trigger?: DeploymentTrigger;
  github_delivery_id?: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface GithubManifestFlowRow {
  state_hash: string;
  browser_nonce_hash: string;
  user_id: string;
  session_token_hash: string;
  encrypted_setup_state: string;
  redirect_uri: string;
  expires_at: string;
  created_at: string;
}

export interface GithubPendingPushRow {
  project_id: string;
  delivery_id: string;
  installation_id: string;
  repository_id: string;
  repository_full_name: string;
  branch: string;
  commit_sha: string;
  commit_message: string | null;
  commit_author: string | null;
  commit_url: string | null;
  received_at: string;
}

export interface DeploymentLogRow {
  id: number;
  deployment_id: string;
  stream: "system" | "stdout" | "stderr";
  message: string;
  created_at: string;
}

export type ServerServiceStatus = "online" | "offline" | "unknown" | "not_configured";

export interface ServerMetricSampleRow {
  sampled_at: number;
  host_name: string;
  host_operating_system: string;
  host_kernel: string;
  host_architecture: string;
  host_uptime_seconds: number;
  cpu_usage_percent: number;
  cpu_logical_cores: number;
  load_one: number;
  load_five: number;
  load_fifteen: number;
  memory_total_bytes: number;
  memory_used_bytes: number;
  memory_available_bytes: number;
  memory_usage_percent: number;
  swap_total_bytes: number;
  swap_used_bytes: number;
  storage_total_bytes: number;
  storage_used_bytes: number;
  storage_available_bytes: number;
  storage_usage_percent: number;
  docker_available: 0 | 1;
  docker_version: string | null;
  managed_containers: number;
  running_managed_containers: number;
  application_cpu_usage_percent: number;
  application_memory_used_bytes: number;
  application_memory_limit_bytes: number;
  application_network_received_bytes: number;
  application_network_transmitted_bytes: number;
  application_network_receive_bytes_per_second: number;
  application_network_transmit_bytes_per_second: number;
  application_block_read_bytes: number;
  application_block_write_bytes: number;
  service_api: ServerServiceStatus;
  service_worker: ServerServiceStatus;
  service_traefik: ServerServiceStatus;
  service_cloudflared: ServerServiceStatus;
  last_storage_maintenance_at: string | null;
  tunnel_configured: 0 | 1;
}

export interface ServerMetricHistoryRow {
  sampled_at: number;
  cpu_usage_percent: number;
  memory_usage_percent: number;
  storage_usage_percent: number;
  load_one: number;
  application_network_receive_bytes_per_second: number;
  application_network_transmit_bytes_per_second: number;
}

export interface ServerActivityCounts {
  projects: number;
  live_projects: number;
  domains: number;
  deployments_queued: number;
  deployments_active: number;
  deployments_ready_last_24_hours: number;
  deployments_failed_last_24_hours: number;
}

export interface EnvironmentVariableRow {
  id: string;
  project_id: string;
  key: string;
  encrypted_value: string;
  created_at: string;
  updated_at: string;
}

export interface PublicProject {
  id: string;
  name: string;
  slug: string;
  status: "live" | "deploying" | "failed" | "draft" | "deletion_failed";
  deletionStatus: ProjectDeletionStatus | null;
  deletionError: string | null;
  sourceType: SourceType;
  repositoryUrl: string | null;
  repositoryBranch: string | null;
  branch: string | null;
  staticBasePath: string | null;
  rootDirectory: string;
  buildType: BuildType;
  dockerfilePath: string;
  port: number;
  healthcheckPath: string;
  memoryLimit: string;
  cpuLimit: string;
  activeDeploymentId: string | null;
  githubRepositoryId: string | null;
  githubRepositoryFullName: string | null;
  githubInstallationId: string | null;
  githubConnectionError: string | null;
  autoDeploy: boolean;
  sourceAnalysis: ProjectAnalysis | null;
  createdAt: string;
  updatedAt: string;
  domains?: Array<{
    id: string;
    hostname: string;
    status: DomainRow["status"];
    error: string | null;
  }>;
  deployments?: PublicDeployment[];
  currentDeployment?: PublicDeployment | null;
  environmentKeys?: string[];
  preview?: PublicProjectPreview;
}

export interface PublicProjectPreview {
  status: "pending" | "ready" | "unavailable";
  deploymentId: string;
  reason?: "not_html" | "capture_failed";
  capturedAt?: string;
  imageUrl?: string;
}

export interface PublicDeployment {
  id: string;
  projectId: string;
  status: DeploymentStatus;
  sourceRef: string | null;
  imageTag: string | null;
  internalPort: number | null;
  runtimeKind: DeploymentRow["runtime_kind"];
  runtimeDescription: string | null;
  failureKind: DeploymentFailureKind | null;
  rollbackStatus: DeploymentRollbackStatus;
  rollbackDeploymentId: string | null;
  cancelRequestedAt: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  commitUrl: string | null;
  trigger: DeploymentTrigger;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  durationSeconds: number | null;
  projectName?: string;
}
