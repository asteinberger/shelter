import type {
  ApiTokenSummary,
  CloudflareInput,
  CloudflareAccessProtection,
  CloudflareOAuthStartResult,
  CloudflareSettings,
  CloudflareTestResult,
  CloudflareZone,
  CreateApiTokenInput,
  CreateApiTokenResult,
  DeleteProjectResult,
  Deployment,
  Domain,
  DomainAccessInput,
  EnvironmentVariable,
  GitHubBranch,
  GitHubPreviewCapability,
  GitHubManifestStartResult,
  GitHubProjectInput,
  GitHubRepository,
  GitHubSettings,
  GitProjectInput,
  HostnameAvailability,
  Overview,
  Project,
  PullRequestPreviewsResponse,
  ProjectObservabilityRange,
  ProjectObservabilityResponse,
  ProjectSourceAnalysis,
  RuntimeLog,
  RuntimeLogsResponse,
  ServerMetricsRange,
  ServerMetricsResponse,
  Session,
  UploadProgress,
  UploadProjectInput,
  UpdateProjectInput,
  UpdateProjectGitHubInput,
} from '../types';
import { gitHubRepositoryUrlFromFullName, trustedGitHubRepositoryUrl } from '../utils/github';
import { SESSION_EXPIRED_EVENT } from '../lib/brand';
import { localize } from '../i18n';

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

let csrfToken = '';

export function setCsrfToken(token?: string | null) {
  csrfToken = token ?? '';
}

function extractMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
  }
  return fallback;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const isFormData = init.body instanceof FormData;
  if (init.body && !isFormData && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const method = (init.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken) {
    headers.set('x-csrf-token', csrfToken);
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'include',
  });

  const contentType = response.headers.get('content-type') ?? '';
  const payload: unknown = response.status === 204
    ? undefined
    : contentType.includes('application/json')
      ? await response.json().catch(() => undefined)
      : await response.text().catch(() => undefined);

  if (!response.ok) {
    if (
      response.status === 401
      && path !== '/api/auth/session'
      && path !== '/api/auth/login'
      && typeof window !== 'undefined'
    ) {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
    }
    throw new ApiError(extractMessage(payload, localize(`Request failed (${response.status})`, `Anfrage fehlgeschlagen (${response.status})`)), response.status, payload);
  }
  return payload as T;
}

function unwrap<T>(payload: T | { data: T }): T {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

function unwrapProject(payload: Project | { data: Project } | { project: Project }): Project {
  if (payload && typeof payload === 'object' && 'project' in payload) return payload.project;
  return unwrap(payload as Project | { data: Project });
}

function unwrapDeployment(payload: Deployment | { data: Deployment } | { deployment: Deployment }): Deployment {
  if (payload && typeof payload === 'object' && 'deployment' in payload) return payload.deployment;
  return unwrap(payload as Deployment | { data: Deployment });
}

function unwrapCloudflare(
  payload: CloudflareSettings | { data: CloudflareSettings } | { cloudflare: CloudflareSettings },
): CloudflareSettings {
  if (payload && typeof payload === 'object' && 'cloudflare' in payload) return payload.cloudflare;
  return unwrap(payload as CloudflareSettings | { data: CloudflareSettings });
}

function unwrapGitHub(
  payload: GitHubSettings | { data: GitHubSettings } | { github: GitHubSettings },
): GitHubSettings {
  if (payload && typeof payload === 'object' && 'github' in payload) return payload.github;
  return unwrap(payload as GitHubSettings | { data: GitHubSettings });
}

const activeDeploymentStatuses = new Set(['queued', 'preparing', 'building', 'checking', 'switching', 'deploying', 'running']);

function normalizeDeployment<T extends { startedAt?: string; finishedAt?: string; durationSeconds?: number }>(deployment: T): T {
  if (deployment.durationSeconds !== undefined || !deployment.startedAt) return deployment;
  const start = new Date(deployment.startedAt).getTime();
  const end = deployment.finishedAt ? new Date(deployment.finishedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return deployment;
  return { ...deployment, durationSeconds: Math.max(0, Math.round((end - start) / 1000)) };
}

function normalizeProject(project: Project): Project {
  const deployments = (project.deployments ?? []).map(normalizeDeployment);
  const currentDeployment = project.currentDeployment ?? deployments[0] ?? null;
  let status = project.status;
  if (!status) {
    if (currentDeployment && activeDeploymentStatuses.has(currentDeployment.status)) status = 'deploying';
    else if (project.activeDeploymentId) status = 'live';
    else if (currentDeployment?.status === 'failed') status = 'failed';
    else status = 'draft';
  }
  const githubInstallationId = project.github?.installationId ?? project.githubInstallationId;
  const githubRepositoryId = project.github?.repositoryId ?? project.githubRepositoryId;
  const githubFullName = project.github?.fullName
    ?? project.githubRepositoryFullName
    ?? project.repositoryUrl?.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  const github = githubInstallationId !== null
    && githubInstallationId !== undefined
    && githubRepositoryId !== null
    && githubRepositoryId !== undefined
      ? {
          installationId: githubInstallationId,
          repositoryId: githubRepositoryId,
          fullName: githubFullName ?? 'GitHub Repository',
          branch: project.github?.branch ?? project.branch ?? project.repositoryBranch ?? 'main',
          autoDeploy: project.github?.autoDeploy ?? project.autoDeploy ?? true,
          htmlUrl: trustedGitHubRepositoryUrl(project.github?.htmlUrl ?? project.githubRepositoryHtmlUrl)
            ?? gitHubRepositoryUrlFromFullName(githubFullName),
          private: project.github?.private ?? project.githubRepositoryPrivate ?? undefined,
        }
      : null;
  return {
    ...project,
    status,
    branch: project.branch ?? project.repositoryBranch,
    deployments,
    currentDeployment,
    github,
  };
}

async function uploadArchive(file: File, onProgress?: (progress: UploadProgress) => void) {
  let uploadId: string | undefined;
  try {
    const initialized = await request<{ id: string; chunkSize?: number }>('/api/uploads', {
      method: 'POST',
      body: JSON.stringify({ filename: file.name, size: file.size }),
    });
    uploadId = initialized.id;
    const chunkSize = initialized.chunkSize || 10 * 1024 * 1024;
    const chunkCount = Math.max(1, Math.ceil(file.size / chunkSize));
    onProgress?.({ phase: 'uploading', uploadedBytes: 0, totalBytes: file.size, chunk: 0, chunks: chunkCount });

    for (let index = 0; index < chunkCount; index += 1) {
      const start = index * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      await request<void>(`/api/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          'x-chunk-count': String(chunkCount),
        },
        body: file.slice(start, end),
      });
      onProgress?.({ phase: 'uploading', uploadedBytes: end, totalBytes: file.size, chunk: index + 1, chunks: chunkCount });
    }

    onProgress?.({ phase: 'verifying', uploadedBytes: file.size, totalBytes: file.size, chunk: chunkCount, chunks: chunkCount });
    const completed = await request<{ uploadId: string }>(
      `/api/uploads/${encodeURIComponent(uploadId)}/complete`,
      { method: 'POST' },
    );
    return { uploadId: completed.uploadId, chunkSize, chunks: chunkCount };
  } catch (error) {
    if (uploadId) {
      await request<void>(`/api/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }).catch(() => undefined);
    }
    throw error;
  }
}

export const api = {
  async session() {
    const session = unwrap(await request<Session | { data: Session }>('/api/auth/session'));
    setCsrfToken(session.csrfToken);
    return session;
  },

  login(input: { email?: string; username?: string; password: string }) {
    return request<Session>('/api/auth/login', { method: 'POST', body: JSON.stringify(input) });
  },

  logout() {
    return request<void>('/api/auth/logout', { method: 'POST' });
  },

  changePassword(input: { currentPassword: string; newPassword: string }) {
    return request<{ ok: true; invalidatedSessions: number; invalidatedApiTokens: number }>('/api/auth/password', {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },

  async overview() {
    const overview = unwrap(await request<Overview | { data: Overview }>('/api/overview'));
    return {
      ...overview,
      projects: overview.projects?.map(normalizeProject),
      recentDeployments: overview.recentDeployments?.map(normalizeDeployment),
    };
  },

  async serverMetrics(range: ServerMetricsRange) {
    return unwrap(await request<ServerMetricsResponse | { data: ServerMetricsResponse }>(
      `/api/server/metrics?range=${encodeURIComponent(range)}`,
    ));
  },

  async projectObservability(id: string, range: ProjectObservabilityRange) {
    return unwrap(await request<ProjectObservabilityResponse | { data: ProjectObservabilityResponse }>(
      `/api/projects/${encodeURIComponent(id)}/observability?range=${encodeURIComponent(range)}`,
    ));
  },

  async runtimeLogs(id: string, after = 0, limit = 500) {
    return unwrap(await request<RuntimeLogsResponse | { data: RuntimeLogsResponse }>(
      `/api/projects/${encodeURIComponent(id)}/runtime-logs?after=${Math.max(0, Math.trunc(after))}&limit=${Math.max(1, Math.min(500, Math.trunc(limit)))}`,
    ));
  },

  async projects() {
    const payload = unwrap(await request<Project[] | { projects: Project[] } | { data: Project[] }>('/api/projects'));
    return (Array.isArray(payload) ? payload : payload.projects ?? []).map(normalizeProject);
  },

  async project(id: string) {
    return normalizeProject(unwrapProject(await request<Project | { data: Project } | { project: Project }>(`/api/projects/${encodeURIComponent(id)}`)));
  },

  async deployment(id: string) {
    return normalizeDeployment(unwrapDeployment(await request<
      Deployment | { data: Deployment } | { deployment: Deployment }
    >(`/api/deployments/${encodeURIComponent(id)}`)));
  },

  async cancelDeployment(id: string) {
    return normalizeDeployment(unwrapDeployment(await request<
      Deployment | { data: Deployment } | { deployment: Deployment }
    >(`/api/deployments/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    })));
  },

  async createGitProject(input: GitProjectInput) {
    return normalizeProject(unwrapProject(await request<Project | { data: Project } | { project: Project }>('/api/projects/git', {
      method: 'POST',
      body: JSON.stringify(input),
    })));
  },

  async createGitHubProject(input: GitHubProjectInput) {
    return normalizeProject(unwrapProject(await request<Project | { data: Project } | { project: Project }>('/api/projects/github', {
      method: 'POST',
      body: JSON.stringify({
        ...input,
        installationId: String(input.installationId),
        repositoryId: String(input.repositoryId),
      }),
    })));
  },

  async createMultipartUploadProject(metadata: UploadProjectInput, file: File) {
    const body = new FormData();
    body.append('metadata', JSON.stringify(metadata));
    body.append('file', file, file.name);
    return normalizeProject(unwrapProject(await request<Project | { data: Project } | { project: Project }>('/api/projects/upload', { method: 'POST', body })));
  },

  async createUploadProject(
    metadata: UploadProjectInput,
    file: File,
    onProgress?: (progress: UploadProgress) => void,
  ) {
    let prepared: Awaited<ReturnType<typeof uploadArchive>>;
    try {
      prepared = await uploadArchive(file, onProgress);
    } catch (error) {
      if (!(error instanceof ApiError && [404, 405, 501].includes(error.status))) throw error;
      return api.createMultipartUploadProject(metadata, file);
    }
    onProgress?.({ phase: 'queueing', uploadedBytes: file.size, totalBytes: file.size, chunk: prepared.chunks, chunks: prepared.chunks });
    try {
      return normalizeProject(unwrapProject(await request<Project | { data: Project } | { project: Project }>('/api/projects/upload', {
        method: 'POST',
        body: JSON.stringify({ ...metadata, uploadId: prepared.uploadId }),
      })));
    } catch (error) {
      await request<void>(`/api/uploads/${encodeURIComponent(prepared.uploadId)}`, { method: 'DELETE' }).catch(() => undefined);
      throw error;
    }
  },

  prepareArchiveUpload(file: File, onProgress?: (progress: UploadProgress) => void) {
    return uploadArchive(file, onProgress);
  },

  async attachUploadProjectSource(id: string, uploadId: string, staticBasePath: string | null = null) {
    try {
      const payload = await request<{ project: Project; deployment: Deployment }>(
        `/api/projects/${encodeURIComponent(id)}/source`,
        { method: 'PUT', body: JSON.stringify({ uploadId, staticBasePath }) },
      );
      return {
        project: normalizeProject(payload.project),
        deployment: normalizeDeployment(payload.deployment),
      };
    } catch (error) {
      await request<void>(`/api/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }).catch(() => undefined);
      throw error;
    }
  },

  async replaceUploadProjectSource(
    id: string,
    file: File,
    onProgress?: (progress: UploadProgress) => void,
    staticBasePath: string | null = null,
  ) {
    const prepared = await uploadArchive(file, onProgress);
    onProgress?.({ phase: 'queueing', uploadedBytes: file.size, totalBytes: file.size, chunk: prepared.chunks, chunks: prepared.chunks });
    return api.attachUploadProjectSource(id, prepared.uploadId, staticBasePath);
  },

  async deployProject(id: string, staticBasePath?: string | null) {
    return normalizeDeployment(unwrapDeployment(await request<
      Deployment | { data: Deployment } | { deployment: Deployment }
    >(`/api/projects/${encodeURIComponent(id)}/deploy`, {
      method: 'POST',
      body: staticBasePath === undefined ? undefined : JSON.stringify({ staticBasePath }),
    })));
  },

  async deleteProject(id: string, confirmation: string) {
    return request<DeleteProjectResult>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmation }),
    });
  },

  async updateProject(id: string, input: UpdateProjectInput) {
    return normalizeProject(unwrapProject(await request<Project | { data: Project } | { project: Project }>(
      `/api/projects/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    )));
  },

  async updateProjectGitHub(id: string, input: UpdateProjectGitHubInput) {
    return normalizeProject(unwrapProject(await request<Project | { data: Project } | { project: Project }>(
      `/api/projects/${encodeURIComponent(id)}/github`,
      {
        method: 'PUT',
        body: JSON.stringify({
          ...input,
          installationId: String(input.installationId),
          repositoryId: String(input.repositoryId),
        }),
      },
    )));
  },

  async disconnectProjectGitHub(id: string) {
    return normalizeProject(unwrapProject(await request<Project | { data: Project } | { project: Project }>(
      `/api/projects/${encodeURIComponent(id)}/github`,
      { method: 'DELETE' },
    )));
  },

  async rollbackProject(id: string, deploymentId: string) {
    return normalizeDeployment(unwrapDeployment(await request<
      Deployment | { data: Deployment } | { deployment: Deployment }
    >(`/api/projects/${encodeURIComponent(id)}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ deploymentId }),
    })));
  },

  async addDomain(id: string, hostname: string, zoneId: string) {
    const payload = await request<{ domain?: Domain }>(`/api/projects/${encodeURIComponent(id)}/domains`, {
      method: 'POST',
      body: JSON.stringify({ hostname, zoneId }),
    });
    if (!payload.domain) throw new ApiError(localize('Cloudflare did not return a domain.', 'Cloudflare hat keine Domain zurückgegeben.'), 502, payload);
    if (payload.domain.status === 'error') {
      throw new ApiError(payload.domain.error || 'Cloudflare DNS konnte nicht angelegt werden.', 502, payload);
    }
    return payload.domain;
  },

  async removeDomain(id: string, domainId: string) {
    return request(`/api/projects/${encodeURIComponent(id)}/domains/${encodeURIComponent(domainId)}`, {
      method: 'DELETE',
    });
  },

  async updateDomainAccess(id: string, domainId: string, input: DomainAccessInput) {
    const payload = await request<{ domain: Domain }>(
      `/api/projects/${encodeURIComponent(id)}/domains/${encodeURIComponent(domainId)}/access`,
      { method: 'PUT', body: JSON.stringify(input) },
    );
    return payload.domain;
  },

  revokeDomainAccessSessions(id: string, domainId: string) {
    return request<{ ok: true }>(
      `/api/projects/${encodeURIComponent(id)}/domains/${encodeURIComponent(domainId)}/access/revoke`,
      { method: 'POST' },
    );
  },

  updateEnvironment(id: string, variables: EnvironmentVariable[]) {
    return request(`/api/projects/${encodeURIComponent(id)}/environment`, {
      method: 'PUT',
      body: JSON.stringify({ variables }),
    });
  },

  async deploymentLogs(id: string) {
    const payload = await request<
      string
      | string[]
      | { logs?: string | string[] | Array<{ id?: number; message?: string; stream?: string; createdAt?: string }>; content?: string; status?: string }
    >(
      `/api/deployments/${encodeURIComponent(id)}/logs`,
    );
    if (typeof payload === 'string') return { content: payload, lastId: 0 };
    if (Array.isArray(payload)) return { content: payload.join('\n'), lastId: 0 };
    if (Array.isArray(payload.logs)) {
      const structured = payload.logs.filter((line) => typeof line !== 'string');
      return {
        content: payload.logs
        .map((line) => typeof line === 'string' ? line : line.message ?? '')
        .filter(Boolean)
        .join('\n'),
        lastId: structured.reduce((maximum, line) => Math.max(maximum, line.id ?? 0), 0),
        status: payload.status,
      };
    }
    return { content: payload.logs ?? payload.content ?? '', lastId: 0, status: payload.status };
  },

  async cloudflare() {
    return unwrapCloudflare(
      await request<CloudflareSettings | { data: CloudflareSettings } | { cloudflare: CloudflareSettings }>('/api/settings/cloudflare'),
    );
  },

  async apiTokens() {
    const payload = await request<{ apiTokens: ApiTokenSummary[] }>('/api/settings/api-tokens');
    return payload.apiTokens;
  },

  createApiToken(input: CreateApiTokenInput) {
    return request<CreateApiTokenResult>('/api/settings/api-tokens', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  revokeApiToken(id: string) {
    return request<void>(`/api/settings/api-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async cloudflareZones(signal?: AbortSignal) {
    const payload = await request<{ zones: CloudflareZone[] }>('/api/settings/cloudflare/zones', { signal });
    return payload.zones;
  },

  checkCloudflareHostname(hostname: string, zoneId: string, signal?: AbortSignal) {
    return request<HostnameAvailability>('/api/settings/cloudflare/hostname/check', {
      method: 'POST',
      body: JSON.stringify({ hostname, zoneId }),
      signal,
    });
  },

  async saveCloudflare(input: CloudflareInput) {
    return unwrapCloudflare(await request<
      CloudflareSettings | { data: CloudflareSettings } | { cloudflare: CloudflareSettings }
    >('/api/settings/cloudflare', {
      method: 'PUT',
      body: JSON.stringify(input),
    }));
  },

  startCloudflareOAuth() {
    return request<CloudflareOAuthStartResult>('/api/settings/cloudflare/oauth/start', { method: 'POST' });
  },

  async disconnectCloudflare() {
    return unwrapCloudflare(await request<
      CloudflareSettings | { data: CloudflareSettings } | { cloudflare: CloudflareSettings }
    >('/api/settings/cloudflare/connection', { method: 'DELETE' }));
  },

  testCloudflare() {
    return request<CloudflareTestResult>('/api/settings/cloudflare/test', { method: 'POST' });
  },

  async confirmCloudflareAccessProtection(panelDomain: string) {
    const payload = await request<{ accessProtection: CloudflareAccessProtection }>(
      '/api/settings/cloudflare/access-protection/confirmation',
      { method: 'POST', body: JSON.stringify({ panelDomain }) },
    );
    return payload.accessProtection;
  },

  async revokeCloudflareAccessProtection() {
    const payload = await request<{ accessProtection: CloudflareAccessProtection }>(
      '/api/settings/cloudflare/access-protection/confirmation',
      { method: 'DELETE' },
    );
    return payload.accessProtection;
  },

  async github() {
    return unwrapGitHub(await request<GitHubSettings | { data: GitHubSettings } | { github: GitHubSettings }>(
      '/api/settings/github',
    ));
  },

  async githubPreviewCapability(installationId?: string | number) {
    const query = installationId === undefined
      ? ''
      : `?installationId=${encodeURIComponent(String(installationId))}`;
    const payload = await request<{ previewCapability: GitHubPreviewCapability }>(
      `/api/settings/github/preview-capability${query}`,
    );
    return payload.previewCapability;
  },

  projectPullRequestPreviews(id: string) {
    return request<PullRequestPreviewsResponse>(`/api/projects/${encodeURIComponent(id)}/previews`);
  },

  updateProjectPullRequestPreviewSettings(
    id: string,
    input: { enabled: boolean; domainId?: string; ttlHours: number },
  ) {
    return request<{ enabled: boolean; domainId: string | null; domainSuffix: string | null; ttlHours: number }>(
      `/api/projects/${encodeURIComponent(id)}/previews/settings`,
      { method: 'PUT', body: JSON.stringify(input) },
    );
  },

  updateProjectPullRequestPreviewEnvironment(id: string, variables: EnvironmentVariable[]) {
    return request<{ environmentKeys: string[]; inheritsProductionEnvironment: false }>(
      `/api/projects/${encodeURIComponent(id)}/previews/environment`,
      { method: 'PUT', body: JSON.stringify({ variables }) },
    );
  },

  closeProjectPullRequestPreview(id: string, previewId: string) {
    return request<{ preview: PullRequestPreviewsResponse['previews'][number] }>(
      `/api/projects/${encodeURIComponent(id)}/previews/${encodeURIComponent(previewId)}`,
      { method: 'DELETE' },
    );
  },

  startGitHubManifest() {
    return request<GitHubManifestStartResult>('/api/settings/github/manifest/start', { method: 'POST' });
  },

  startGitHubUpgradeManifest() {
    return request<GitHubManifestStartResult>('/api/settings/github/manifest/upgrade/start', { method: 'POST' });
  },

  disconnectGitHub() {
    return request<void>('/api/settings/github/connection', { method: 'DELETE' });
  },

  async githubRepositories() {
    const payload = await request<{ repositories: GitHubRepository[] } | { data: { repositories: GitHubRepository[] } }>(
      '/api/settings/github/repositories',
    );
    return unwrap(payload).repositories;
  },

  async githubBranches(installationId: string | number, repositoryId: string | number, signal?: AbortSignal) {
    const payload = await request<{ branches: GitHubBranch[] } | { data: { branches: GitHubBranch[] } }>(
      `/api/settings/github/repositories/${encodeURIComponent(String(installationId))}/${encodeURIComponent(String(repositoryId))}/branches`,
      { signal },
    );
    return unwrap(payload).branches;
  },

  async githubRepositoryAnalysis(
    installationId: string | number,
    repositoryId: string | number,
    branch: string,
    signal?: AbortSignal,
  ) {
    const payload = await request<{ analysis: ProjectSourceAnalysis } | { data: { analysis: ProjectSourceAnalysis } }>(
      `/api/settings/github/repositories/${encodeURIComponent(String(installationId))}/${encodeURIComponent(String(repositoryId))}/analysis?branch=${encodeURIComponent(branch)}`,
      { signal },
    );
    return unwrap(payload).analysis;
  },

  async analyzeProject(
    files: Array<{ path: string; size?: number; content?: string }>,
    signal?: AbortSignal,
  ) {
    const payload = await request<{ analysis: ProjectSourceAnalysis } | { data: { analysis: ProjectSourceAnalysis } }>(
      '/api/projects/analyze',
      {
        method: 'POST',
        body: JSON.stringify({ files }),
        signal,
      },
    );
    return unwrap(payload).analysis;
  },
};

export function streamDeploymentLogs(
  id: string,
  onLine: (line: string, logId?: number) => void,
  onError?: () => void,
  after = 0,
) {
  const source = new EventSource(`/api/deployments/${encodeURIComponent(id)}/logs/stream?after=${after}`, {
    withCredentials: true,
  });
  const handleLine = (event: MessageEvent<string>) => {
    let line = event.data;
    let logId = Number(event.lastEventId) || undefined;
    try {
      const parsed = JSON.parse(event.data) as { id?: number; line?: string; message?: string; log?: string };
      line = parsed.line ?? parsed.log ?? parsed.message ?? event.data;
      logId = parsed.id ?? logId;
    } catch {
      // Plain-text SSE events are valid log lines.
    }
    onLine(line, logId);
  };
  source.onmessage = handleLine;
  source.addEventListener('log', handleLine as EventListener);
  source.addEventListener('complete', () => source.close());
  source.onerror = () => onError?.();
  return () => source.close();
}

export function streamRuntimeLogs(
  projectId: string,
  handlers: {
    onLog: (log: RuntimeLog) => void;
    onDeployment?: (activeDeploymentId: string | null) => void;
    onOpen?: () => void;
    onError?: () => void;
  },
  after = 0,
) {
  const source = new EventSource(
    `/api/projects/${encodeURIComponent(projectId)}/runtime-logs/stream?after=${Math.max(0, Math.trunc(after))}`,
    { withCredentials: true },
  );
  source.addEventListener('log', ((event: MessageEvent<string>) => {
    try {
      const log = JSON.parse(event.data) as RuntimeLog;
      if (typeof log.id === 'number' && typeof log.message === 'string') handlers.onLog(log);
    } catch {
      // The runtime-log protocol only accepts structured, bounded records.
    }
  }) as EventListener);
  source.addEventListener('deployment', ((event: MessageEvent<string>) => {
    try {
      const payload = JSON.parse(event.data) as { activeDeploymentId?: string | null };
      handlers.onDeployment?.(payload.activeDeploymentId ?? null);
    } catch {
      handlers.onDeployment?.(null);
    }
  }) as EventListener);
  source.addEventListener('complete', () => source.close());
  source.onopen = () => handlers.onOpen?.();
  source.onerror = () => handlers.onError?.();
  return () => source.close();
}
