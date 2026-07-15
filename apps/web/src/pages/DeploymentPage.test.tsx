import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../api/client';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import type { Deployment, Project } from '../types';
import { deploymentRefetchInterval } from '../utils/deployment';
import {
  cancelDialogBlock,
  DeploymentPage,
  localizedPageError,
  rollbackDialogBlock,
} from './DeploymentPage';

vi.mock('../components/DeploymentLogsPanel', () => ({
  DeploymentLogsPanel: () => <div data-testid="deployment-logs" />,
}));

function renderDeploymentPage(project: Project, deployment: Deployment, locale: 'en' | 'de') {
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => key === LOCALE_STORAGE_KEY ? locale : null,
    },
    navigator: { language: locale, languages: [locale] },
  });

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(['project', project.id], project);
  queryClient.setQueryData(['deployment', deployment.id], deployment);

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MemoryRouter initialEntries={[`/projects/${project.id}/deployments/${deployment.id}`]}>
          <Routes>
            <Route path="/projects/:id/deployments/:deploymentId" element={<DeploymentPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function buttonMarkup(label: string, html: string) {
  const labelIndex = html.indexOf(label);
  const buttonStart = html.lastIndexOf('<button', labelIndex);
  const buttonEnd = html.indexOf('</button>', labelIndex);
  return buttonStart >= 0 && buttonEnd >= 0 ? html.slice(buttonStart, buttonEnd + 9) : '';
}

describe('DeploymentPage cancellation safety', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { status: 'building' as const, activeDeploymentId: 'dep_live', expected: 'Die aktive Produktionsversion bleibt online.' },
    { status: 'checking' as const, activeDeploymentId: null, expected: 'Es ist noch keine Version live und dieses Deployment wird nicht aktiviert.' },
  ])('renders an accepted 202 request that remains $status as requested, disabled, and polling', async ({ status, activeDeploymentId, expected }) => {
    const acceptedAt = '2026-07-14T18:00:00.000Z';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      deployment: {
        id: 'dep_202',
        projectId: 'prj_1',
        status,
        cancelRequestedAt: acceptedAt,
        sourceRef: 'main',
      },
    }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const accepted = await api.cancelDeployment('dep_202');
    expect(accepted).toMatchObject({ status, cancelRequestedAt: acceptedAt });
    expect(deploymentRefetchInterval(accepted)).toBe(4_000);

    const project: Project = {
      id: 'prj_1',
      name: 'Website',
      status: 'deploying',
      sourceType: 'git',
      branch: 'main',
      activeDeploymentId,
      currentDeployment: accepted,
      deployments: [accepted],
    };
    const html = renderDeploymentPage(project, accepted, 'de');
    const requestedButton = buttonMarkup('Abbruch angefordert', html);

    expect(fetchMock).toHaveBeenCalledWith('/api/deployments/dep_202/cancel', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
    }));
    expect(requestedButton).toContain('disabled=""');
    expect(requestedButton).toContain('Der Abbruch wurde bereits angefordert.');
    expect(html).toContain('Abbruch angefordert');
    expect(html).toContain('Der Worker stoppt am nächsten sicheren Kontrollpunkt.');
    expect(html).toContain(expected);
  });

  it('uses localized first-deployment fallback copy and never echoes a raw backend error', () => {
    const failed: Deployment = {
      id: 'dep_failed',
      projectId: 'prj_1',
      status: 'failed',
      failureKind: 'timeout',
      error: 'Zeitlimit für Deployment überschritten.',
      sourceRef: 'main',
    };
    const project: Project = {
      id: 'prj_1',
      name: 'Website',
      status: 'failed',
      sourceType: 'git',
      branch: 'main',
      activeDeploymentId: null,
      currentDeployment: failed,
      deployments: [failed],
    };

    const html = renderDeploymentPage(project, failed, 'en');

    expect(html).toContain('Deployment timed out');
    expect(html).toContain('No version was activated, so this project still has no production deployment.');
    expect(html).not.toContain('Zeitlimit für Deployment überschritten.');
  });

  it.each(['running', 'failed'] as const)('does not present rollback while project deletion is %s', (deletionStatus) => {
    const previous: Deployment = {
      id: 'dep_previous',
      projectId: 'prj_1',
      status: 'ready',
      sourceRef: 'main',
    };
    const project: Project = {
      id: 'prj_1',
      name: 'Website',
      status: deletionStatus === 'failed' ? 'deletion_failed' : 'live',
      sourceType: 'git',
      activeDeploymentId: 'dep_live',
      deletionStatus,
      deployments: [previous],
    };

    const html = renderDeploymentPage(project, previous, 'en');

    expect(html).not.toContain('Roll back to this version');
    expect(html).not.toContain('Start rollback');
  });

  it('exposes a concrete dialog reason whenever polling invalidates an open confirmation', () => {
    expect(cancelDialogBlock({
      id: 'dep_requested',
      status: 'building',
      cancelRequestedAt: '2026-07-14T18:00:00.000Z',
    })).toBe('requested');
    expect(cancelDialogBlock({ id: 'dep_switching', status: 'switching' })).toBe('switching');
    expect(cancelDialogBlock({ id: 'dep_ready', status: 'ready' })).toBe('finished');

    const ready = { id: 'dep_old', status: 'ready' };
    const project = { id: 'prj_1', name: 'Website', status: 'live', activeDeploymentId: 'dep_live' };
    expect(rollbackDialogBlock(ready, { ...project, deletionStatus: 'running' }, false, false)).toBe('deletion');
    expect(rollbackDialogBlock(ready, project, true, false)).toBe('deployment-active');
    expect(rollbackDialogBlock(ready, { ...project, activeDeploymentId: ready.id }, false, false)).toBe('target-active');
  });

  it('localizes stable API error codes and replaces unknown raw messages with a contextual fallback', () => {
    const english = (value: string) => value;

    expect(localizedPageError(
      new ApiError('Aktivierung läuft bereits.', 409, { code: 'DEPLOYMENT_ACTIVATING' }),
      'cancel',
      english,
    )).toBe('Final activation has already started, so cancellation is no longer safe.');
    expect(localizedPageError(
      new ApiError('Unbekannter deutscher Serverfehler.', 500),
      'rollback',
      english,
    )).toBe('The rollback could not be started. Refresh the status and try again.');
  });
});
