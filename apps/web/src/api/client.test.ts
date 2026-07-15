import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';

describe('deployment api', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads a dedicated deployment, unwraps it and normalizes its duration', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      deployment: {
        id: 'dep/42',
        projectId: 'prj_1',
        status: 'ready',
        startedAt: '2026-07-13T18:00:00.000Z',
        finishedAt: '2026-07-13T18:00:30.000Z',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.deployment('dep/42')).resolves.toMatchObject({
      id: 'dep/42',
      projectId: 'prj_1',
      durationSeconds: 30,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/deployments/dep%2F42', expect.objectContaining({
      credentials: 'include',
    }));
  });

  it.each(['building', 'checking'] as const)('preserves the active %s state of an accepted cancellation request', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      deployment: {
        id: 'dep/42',
        projectId: 'prj_1',
        status,
        cancelRequestedAt: '2026-07-14T18:00:00.000Z',
      },
    }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.cancelDeployment('dep/42')).resolves.toMatchObject({
      id: 'dep/42',
      status,
      cancelRequestedAt: '2026-07-14T18:00:00.000Z',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/deployments/dep%2F42/cancel', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
    }));
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('body');
  });

  it('updates project settings and unwraps the normalized project', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      project: {
        id: 'prj/42',
        name: 'Edited project',
        buildType: 'node',
        deployments: [],
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.updateProject('prj/42', {
      name: 'Edited project',
      buildType: 'node',
      port: 3000,
    })).resolves.toMatchObject({
      id: 'prj/42',
      name: 'Edited project',
      buildType: 'node',
      status: 'draft',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/prj%2F42', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ name: 'Edited project', buildType: 'node', port: 3000 }),
    }));
  });

  it('queues a rollback to an immutable ready deployment', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      deployment: {
        id: 'dep_rollback',
        projectId: 'prj/42',
        status: 'queued',
        sourceRef: 'rollback:dep_old',
      },
    }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.rollbackProject('prj/42', 'dep_old')).resolves.toMatchObject({
      id: 'dep_rollback',
      status: 'queued',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/prj%2F42/rollback', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ deploymentId: 'dep_old' }),
    }));
  });

  it('queues the currently configured project source for a manual deployment', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      deployment: {
        id: 'dep_manual',
        projectId: 'prj/42',
        status: 'queued',
        sourceRef: 'release',
        trigger: 'manual',
      },
    }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.deployProject('prj/42')).resolves.toMatchObject({
      id: 'dep_manual',
      projectId: 'prj/42',
      sourceRef: 'release',
      status: 'queued',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/prj%2F42/deploy', expect.objectContaining({
      method: 'POST',
      body: undefined,
    }));
  });
});

describe('github api', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads and unwraps GitHub settings', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      github: {
        configured: true,
        connected: true,
        appName: 'Shelter Raum',
        appSlug: 'shelter-raum',
        appUrl: 'https://github.com/apps/shelter-raum',
        installUrl: 'https://github.com/apps/shelter-raum/installations/new',
        installations: [{ id: 42, accountLogin: 'raum' }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.github()).resolves.toMatchObject({
      connected: true,
      appSlug: 'shelter-raum',
      installations: [{ id: 42 }],
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/github', expect.objectContaining({ credentials: 'include' }));
  });

  it('creates a project from a GitHub App repository', async () => {
    const input = {
      name: 'Website',
      installationId: 12,
      repositoryId: 34,
      branch: 'main',
      autoDeploy: true,
      staticBasePath: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      project: {
        id: 'prj/github',
        name: 'Website',
        sourceType: 'git',
        githubInstallationId: 12,
        githubRepositoryId: 34,
        githubRepositoryFullName: 'raum/website',
        githubRepositoryPrivate: true,
        autoDeploy: true,
      },
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.createGitHubProject(input)).resolves.toMatchObject({
      id: 'prj/github',
      github: {
        installationId: 12,
        repositoryId: 34,
        fullName: 'raum/website',
        htmlUrl: 'https://github.com/raum/website',
        private: true,
        autoDeploy: true,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/github', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ ...input, installationId: '12', repositoryId: '34' }),
    }));
  });

  it('loads branches with safely encoded installation and repository ids', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      branches: [{ name: 'feature/github', sha: 'abc123', protected: false }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.githubBranches('install/12', 'repo/34')).resolves.toEqual([
      { name: 'feature/github', sha: 'abc123', protected: false },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/github/repositories/install%2F12/repo%2F34/branches',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('loads an abortable project analysis for the selected GitHub branch', async () => {
    const analysis = {
      fingerprint: 'sha256:analysis',
      recommendedApplicationId: 'apps/web',
      applications: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ analysis }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await expect(api.githubRepositoryAnalysis('install/12', 'repo/34', 'feature/live detection', controller.signal))
      .resolves.toEqual(analysis);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/github/repositories/install%2F12/repo%2F34/analysis?branch=feature%2Flive%20detection',
      expect.objectContaining({ credentials: 'include', signal: controller.signal }),
    );
  });

  it('submits only sanitized local analysis facts and forwards cancellation', async () => {
    const analysis = { fingerprint: 'local', recommendedApplicationId: null, applications: [] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { analysis } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const files = [
      { path: 'package.json', size: 42, content: '{"dependencies":{"astro":"5.0.0"}}' },
      { path: 'public/hero.jpg', size: 2048 },
    ];

    await expect(api.analyzeProject(files, controller.signal)).resolves.toEqual(analysis);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/analyze', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ files }),
      credentials: 'include',
      signal: controller.signal,
    }));
  });

  it('links an existing git project and serializes numeric GitHub ids as strings', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      project: {
        id: 'prj/existing',
        name: 'Existing',
        sourceType: 'git',
        githubInstallationId: '12',
        githubRepositoryId: '34',
        githubRepositoryFullName: 'raum/existing',
        repositoryBranch: 'production',
        autoDeploy: false,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.updateProjectGitHub('prj/existing', {
      installationId: 12,
      repositoryId: 34,
      branch: 'production',
      autoDeploy: false,
    })).resolves.toMatchObject({
      github: { fullName: 'raum/existing', branch: 'production', autoDeploy: false },
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/prj%2Fexisting/github', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ installationId: '12', repositoryId: '34', branch: 'production', autoDeploy: false }),
    }));
  });
});

describe('access token api', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists, creates, and revokes access tokens without changing the secret payload', async () => {
    const summary = {
      id: 'tok/list',
      name: 'CI deploys',
      displayHint: 'shelter_pat_v1_••••abcd',
      scopes: ['projects:read', 'deployments:write'],
      createdAt: '2026-07-14T10:00:00.000Z',
      lastUsedAt: null,
      expiresAt: '2026-10-12T10:00:00.000Z',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ apiTokens: [summary] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ apiToken: summary, secret: 'shelter_pat_v1_secret' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.apiTokens()).resolves.toEqual([summary]);
    const input = {
      name: 'CI deploys',
      access: 'write' as const,
      expiresInDays: 90,
      currentPassword: 'current password',
    };
    await expect(api.createApiToken(input)).resolves.toEqual({ apiToken: summary, secret: 'shelter_pat_v1_secret' });
    await expect(api.revokeApiToken('tok/list')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/settings/api-tokens', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(input),
      credentials: 'include',
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/settings/api-tokens/tok%2Flist', expect.objectContaining({
      method: 'DELETE',
      credentials: 'include',
    }));
  });
});

describe('server metrics api', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads and unwraps the requested server metric range', async () => {
    const payload = {
      status: 'collecting',
      sampledAt: null,
      intervalSeconds: 15,
      range: '6h',
      current: null,
      activity: {
        projects: 2,
        liveProjects: 1,
        domains: 3,
        deployments: { queued: 0, active: 1, readyLast24Hours: 4, failedLast24Hours: 0 },
      },
      health: [{ id: 'collector', status: 'unknown' }],
      history: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: payload }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.serverMetrics('6h')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/server/metrics?range=6h', expect.objectContaining({
      credentials: 'include',
    }));
  });
});
