export type ProjectStatus = 'live' | 'deploying' | 'failed' | 'stopped' | 'draft' | string;
export type DeploymentStatus =
  | 'queued'
  | 'preparing'
  | 'building'
  | 'checking'
  | 'switching'
  | 'deploying'
  | 'running'
  | 'ready'
  | 'success'
  | 'failed'
  | 'cancelled'
  | string;

export type DeploymentFailureKind =
  | 'timeout'
  | 'cancelled'
  | 'build'
  | 'healthcheck'
  | 'activation'
  | 'worker'
  | 'superseded'
  | string;

export type DeploymentRollbackStatus =
  | 'not_required'
  | 'automatic_succeeded'
  | 'automatic_failed'
  | string;

export interface User {
  id?: string;
  email?: string;
  name?: string;
  username?: string;
}

export interface Session {
  user: User | null;
  csrfToken: string | null;
}

export type ApiTokenScope =
  | 'projects:read'
  | 'projects:write'
  | 'deployments:write'
  | 'uploads:write'
  | 'domains:write'
  | 'environment:write';

export interface ApiTokenSummary {
  id: string;
  name: string;
  displayHint: string;
  scopes: ApiTokenScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

export interface CreateApiTokenInput {
  name: string;
  access: 'read' | 'write';
  expiresInDays: number;
  currentPassword: string;
}

export interface CreateApiTokenResult {
  apiToken: ApiTokenSummary;
  secret: string;
}

export interface Domain {
  id: string;
  hostname: string;
  status?: 'active' | 'pending' | 'error' | string;
  error?: string | null;
  url?: string;
  createdAt?: string;
}

export interface Deployment {
  id: string;
  status: DeploymentStatus;
  projectId?: string;
  projectName?: string;
  sourceRef?: string;
  imageTag?: string;
  internalPort?: number;
  runtimeKind?: 'dockerfile' | 'next' | 'node' | 'static' | 'files' | null;
  runtimeDescription?: string | null;
  error?: string | null;
  errorCode?: string | null;
  failureCode?: string | null;
  failureKind?: DeploymentFailureKind | null;
  cancelRequestedAt?: string | null;
  automaticRollback?: boolean | null;
  recoveryDeploymentId?: string | null;
  rollbackStatus?: DeploymentRollbackStatus | null;
  rollbackDeploymentId?: string | null;
  commitSha?: string;
  commitMessage?: string;
  commitAuthor?: string;
  commitUrl?: string;
  trigger?: 'manual' | 'github_push' | 'rollback' | string;
  scope?: 'production' | 'preview';
  pullRequestPreviewId?: string | null;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  durationSeconds?: number;
  url?: string;
}

export interface GitHubInstallation {
  id: string | number;
  accountLogin?: string;
  accountType?: string;
  accountAvatarUrl?: string | null;
  repositorySelection?: 'all' | 'selected' | string;
  suspendedAt?: string | null;
  htmlUrl?: string;
  account?: {
    login?: string;
    type?: string;
    avatarUrl?: string;
  };
}

export interface GitHubSettings {
  configured: boolean;
  connected: boolean;
  appName: string | null;
  appSlug: string | null;
  appUrl: string | null;
  installUrl: string | null;
  installations: GitHubInstallation[];
  previewCapability?: GitHubPreviewCapability | null;
  error?: string | null;
}

export interface GitHubPreviewCapability {
  ready: boolean;
  configured: boolean;
  pullRequestsPermission: boolean;
  pullRequestEvent: boolean;
  installationChecked?: boolean;
  installationPullRequestsPermission?: boolean;
  installationPullRequestEvent?: boolean;
  installationSuspended?: boolean;
  remediation: 'none' | 'configure_app' | 'update_existing_app' | 'approve_installation_update';
}

export interface GitHubRepository {
  id: string | number;
  installationId: string | number;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
  updatedAt?: string;
}

export interface GitHubBranch {
  name: string;
  sha: string;
  protected: boolean;
}

export type ProjectAnalysisRendering = 'ssr' | 'spa' | 'static' | 'server' | 'files' | string;

export interface ProjectAnalysisApplication {
  id: string;
  rootDirectory: string;
  name: string;
  framework: string;
  frameworkVersion: string | null;
  rendering: ProjectAnalysisRendering;
  packageManager: string | null;
  buildType: 'auto' | 'dockerfile' | 'node' | 'static';
  buildCommand: string | null;
  startCommand: string | null;
  outputDirectory: string | null;
  port: number | null;
  healthcheckPath: string;
  spaFallback: boolean;
  environmentKeys: string[];
  confidence: number | 'high' | 'medium' | 'low';
  evidence: string[];
}

export interface ProjectSourceAnalysis {
  fingerprint: string;
  applications: ProjectAnalysisApplication[];
  recommendedApplicationId: string | null;
}

export interface ProjectGitHubConnection {
  installationId: string | number;
  repositoryId: string | number;
  fullName: string;
  htmlUrl?: string;
  branch: string;
  autoDeploy: boolean;
  private?: boolean;
}

export interface ProjectPreview {
  status: 'pending' | 'ready' | 'unavailable';
  deploymentId: string;
  reason?: 'not_html' | 'capture_failed';
  capturedAt?: string;
  imageUrl?: string;
}

export interface Project {
  id: string;
  name: string;
  slug?: string;
  status: ProjectStatus;
  framework?: string;
  sourceType?: 'git' | 'upload' | string;
  repositoryUrl?: string;
  branch?: string;
  repositoryBranch?: string;
  rootDirectory?: string;
  buildType?: 'auto' | 'dockerfile' | 'node' | 'static' | string;
  dockerfilePath?: string;
  healthcheckPath?: string;
  staticBasePath?: string | null;
  port?: number;
  environmentKeys?: string[];
  createdAt?: string;
  updatedAt?: string;
  url?: string;
  domains?: Domain[];
  deployments?: Deployment[];
  currentDeployment?: Deployment | null;
  activeDeploymentId?: string | null;
  memoryLimit?: string;
  cpuLimit?: string;
  github?: ProjectGitHubConnection | null;
  githubInstallationId?: string | number | null;
  githubRepositoryId?: string | number | null;
  githubRepositoryFullName?: string | null;
  githubRepositoryHtmlUrl?: string | null;
  githubRepositoryPrivate?: boolean | null;
  githubConnectionError?: string | null;
  autoDeploy?: boolean;
  previewDeploymentsEnabled?: boolean;
  previewDomainId?: string | null;
  previewDomainSuffix?: string | null;
  previewTtlHours?: number;
  deletionStatus?: 'failed' | 'preparing' | 'queued' | 'running' | string | null;
  deletionError?: string | null;
  preview?: ProjectPreview;
  sourceAnalysis?: ProjectSourceAnalysis | null;
}

export type PullRequestPreviewStatus =
  | 'queued'
  | 'building'
  | 'ready'
  | 'failed'
  | 'closing'
  | 'closed'
  | 'blocked';

export interface PullRequestPreview {
  id: string;
  projectId: string;
  pullRequestNumber: number;
  headSha: string;
  headRef: string;
  baseRef: string;
  generation: number;
  deploymentId: string | null;
  activeDeploymentId: string | null;
  hostname: string;
  url: string | null;
  status: PullRequestPreviewStatus;
  error: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRequestPreviewSettings {
  enabled: boolean;
  domainId: string | null;
  domainSuffix: string | null;
  ttlHours: number;
  maxActive: number;
  inheritsProductionEnvironment: false;
}

export interface PullRequestPreviewsResponse {
  settings: PullRequestPreviewSettings;
  environmentKeys: string[];
  previews: PullRequestPreview[];
}

export interface OverviewStats {
  projects?: number;
  liveProjects?: number;
  running?: number;
  deploying?: number;
  deployments?: number;
  failedDeployments?: number;
  failed?: number;
  domains?: number;
}

export interface Overview {
  stats?: OverviewStats;
  projects?: Project[];
  recentDeployments?: Deployment[];
  cloudflare?: {
    configured?: boolean;
    connected?: boolean;
    tunnelName?: string;
  };
  system?: {
    workerOnline?: boolean;
    tunnelConfigured?: boolean;
    accessProtection?: CloudflareAccessProtection;
  };
}

export type ServerMetricsRange = '1h' | '6h' | '24h';
export type ServerMetricsStatus = 'healthy' | 'warning' | 'critical' | 'collecting';
export type ServerHealthStatus = 'healthy' | 'warning' | 'critical' | 'unknown';
export type ServerHealthId =
  | 'collector'
  | 'worker'
  | 'docker'
  | 'cpu'
  | 'memory'
  | 'storage'
  | 'traefik'
  | 'cloudflared';

export interface ServerMetricsCurrent {
  host: {
    name: string;
    operatingSystem: string;
    kernel: string;
    architecture: string;
    uptimeSeconds: number;
  };
  cpu: {
    usagePercent: number;
    logicalCores: number;
    loadAverage: {
      one: number;
      five: number;
      fifteen: number;
    };
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usagePercent: number;
    swapTotalBytes: number;
    swapUsedBytes: number;
  };
  storage: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usagePercent: number;
  };
  runtime: {
    dockerAvailable: boolean;
    dockerVersion: string | null;
    managedContainers: number;
    runningManagedContainers: number;
    applicationCpuUsagePercent: number;
    applicationMemoryUsedBytes: number;
    applicationMemoryLimitBytes: number;
    applicationNetworkReceivedBytes: number;
    applicationNetworkTransmittedBytes: number;
    applicationNetworkReceiveBytesPerSecond: number;
    applicationNetworkTransmitBytesPerSecond: number;
    applicationBlockReadBytes: number;
    applicationBlockWriteBytes: number;
    services: {
      api: string;
      worker: string;
      traefik: string;
      cloudflared: string;
    };
    lastStorageMaintenanceAt: string | null;
    tunnelConfigured: boolean;
  };
}

export interface ServerMetricsHistoryPoint {
  sampledAt: string;
  cpuUsagePercent: number;
  memoryUsagePercent: number;
  storageUsagePercent: number;
  loadOne: number;
  applicationNetworkReceiveBytesPerSecond: number;
  applicationNetworkTransmitBytesPerSecond: number;
}

export interface ServerMetricsResponse {
  status: ServerMetricsStatus;
  sampledAt: string | null;
  intervalSeconds: number;
  range: ServerMetricsRange;
  current: ServerMetricsCurrent | null;
  activity: {
    projects: number;
    liveProjects: number;
    domains: number;
    deployments: {
      queued: number;
      active: number;
      readyLast24Hours: number;
      failedLast24Hours: number;
    };
  };
  health: Array<{
    id: ServerHealthId;
    status: ServerHealthStatus;
  }>;
  history: ServerMetricsHistoryPoint[];
}

export type ProjectObservabilityRange = '15m' | '1h' | '6h' | '24h' | '48h';
export type ProjectObservabilityStatus = 'collecting' | 'healthy' | 'warning' | 'critical' | 'stale';
export type ProjectRuntimeStatus = 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead' | 'missing' | 'unknown';
export type ProjectRuntimeHealth = 'healthy' | 'unhealthy' | 'starting' | 'none' | 'unknown';

export interface ProjectObservabilityCurrent {
  deploymentId: string;
  runtime: {
    status: ProjectRuntimeStatus;
    health: ProjectRuntimeHealth;
    startedAt: string | null;
    uptimeSeconds: number;
    restartCount: number;
    oomKilled: boolean;
  };
  cpu: {
    usagePercent: number;
    limitCores: number;
    limitUsagePercent: number;
  };
  memory: {
    usedBytes: number;
    limitBytes: number;
    usagePercent: number;
  };
  network: {
    receivedBytes: number;
    transmittedBytes: number;
    receiveBytesPerSecond: number;
    transmitBytesPerSecond: number;
  };
  blockIo: {
    readBytes: number;
    writeBytes: number;
  };
}

export interface ProjectObservabilityHistoryPoint {
  sampledAt: string;
  cpuUsagePercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  memoryUsagePercent: number;
  networkReceiveBytesPerSecond: number;
  networkTransmitBytesPerSecond: number;
  blockReadBytes: number;
  blockWriteBytes: number;
}

export interface ProjectObservabilityWarning {
  id: 'runtime' | 'health' | 'oom' | 'restarts' | 'cpu' | 'memory';
  severity: 'warning' | 'critical';
  value?: number;
}

export interface ProjectObservabilityResponse {
  status: ProjectObservabilityStatus;
  sampledAt: string | null;
  intervalSeconds: number;
  retentionHours: number;
  range: ProjectObservabilityRange;
  activeDeploymentId: string | null;
  current: ProjectObservabilityCurrent | null;
  warnings: ProjectObservabilityWarning[];
  history: ProjectObservabilityHistoryPoint[];
}

export interface RuntimeLog {
  id: number;
  deploymentId: string;
  stream: 'stdout' | 'stderr';
  message: string;
  timestamp: string;
  collectedAt: string;
}

export interface RuntimeLogsResponse {
  activeDeploymentId: string | null;
  logs: RuntimeLog[];
}

export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface CloudflareZone {
  id: string;
  name: string;
}

export interface HostnameAvailability {
  hostname: string | null;
  availability: boolean;
  reason: string;
  zone: CloudflareZone | null;
  message?: string;
}

export interface DeleteProjectResult {
  ok: true;
  status?: 'queued' | 'deleted' | string;
}

export interface CloudflareSettings {
  configured: boolean;
  connected: boolean;
  authorized: boolean;
  authMethod: 'oauth' | 'api_token' | null;
  oauthAvailable: boolean;
  oauthRedirectUri: string | null;
  oauthPending: boolean;
  accounts: CloudflareAccount[];
  oauthExpiresAt: string | null;
  reconnectRequired: boolean;
  accountId: string | null;
  tunnelId: string | null;
  tunnelName: string | null;
  panelDomain: string | null;
  hasApiToken: boolean;
  accessProtection: CloudflareAccessProtection;
}

export interface CloudflareAccessProtection {
  status: 'not_applicable' | 'action_required' | 'confirmed_by_admin';
  panelDomain: string | null;
  confirmedHostname: string | null;
  confirmedAt: string | null;
}

export interface CloudflareTestResult {
  ok: true;
  tunnelStatus: string;
  connections: number;
}

export interface CloudflareOAuthStartResult {
  authorizationUrl: string;
}

export interface GitProjectInput {
  name: string;
  repositoryUrl: string;
  branch: string;
  staticBasePath: string | null;
  rootDirectory?: string;
  buildType?: 'auto' | 'dockerfile' | 'node' | 'static';
  dockerfilePath?: string;
  port?: number;
  healthcheckPath?: string;
  environment?: NewProjectEnvironmentVariable[];
}

export interface UploadProjectInput extends Omit<GitProjectInput, 'repositoryUrl' | 'branch'> {
  sourceLabel?: string;
}

export interface UpdateProjectInput {
  name?: string;
  repositoryUrl?: string;
  repositoryBranch?: string;
  rootDirectory?: string;
  buildType?: 'auto' | 'dockerfile' | 'node' | 'static';
  dockerfilePath?: string;
  port?: number;
  healthcheckPath?: string;
  staticBasePath?: string | null;
  memoryLimit?: string;
  cpuLimit?: string;
  autoDeploy?: boolean;
}

export interface GitHubProjectInput extends Omit<GitProjectInput, 'repositoryUrl'> {
  repositoryId: string | number;
  installationId: string | number;
  autoDeploy: boolean;
}

export interface UpdateProjectGitHubInput {
  repositoryId: string | number;
  installationId: string | number;
  branch: string;
  autoDeploy: boolean;
}

export interface GitHubManifestStartResult {
  registrationUrl: string;
  manifest: string | Record<string, unknown>;
}

export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  chunk: number;
  chunks: number;
  phase: 'uploading' | 'verifying' | 'queueing';
}

export interface CloudflareInput {
  accountId: string;
  apiToken?: string;
  tunnelName: string;
  panelDomain: string;
}

export interface EnvironmentVariable {
  key: string;
  value?: string;
}

export interface NewProjectEnvironmentVariable {
  key: string;
  value: string;
}
