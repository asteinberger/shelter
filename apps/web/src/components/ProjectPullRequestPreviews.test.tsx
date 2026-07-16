import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import type { PullRequestPreview } from '../types';
import { GitHubAppUpgradeImpact } from './GitHubPreviewCapabilityNotice';
import {
  isTransitionalPullRequestPreview,
  previewEnvironmentValidation,
  PreviewCapability,
  PullRequestPreviewList,
  trustedPullRequestPreviewUrl,
} from './ProjectPullRequestPreviews';

function setLocale(locale: 'en' | 'de') {
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => key === LOCALE_STORAGE_KEY ? locale : null,
      setItem: vi.fn(),
    },
    navigator: { language: locale, languages: [locale] },
  });
}

function render(node: React.ReactNode, locale: 'en' | 'de' = 'en') {
  setLocale(locale);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><MemoryRouter>{node}</MemoryRouter></I18nProvider>
    </QueryClientProvider>,
  );
}

function preview(overrides: Partial<PullRequestPreview> = {}): PullRequestPreview {
  return {
    id: 'prv_123',
    projectId: 'prj_123',
    pullRequestNumber: 42,
    headSha: '0123456789abcdef0123456789abcdef01234567',
    headRef: 'feature/check-this',
    baseRef: 'main',
    generation: 1,
    deploymentId: 'dep_123',
    activeDeploymentId: 'dep_123',
    hostname: 'pr-42--shelter.example.com',
    url: 'https://pr-42--shelter.example.com',
    status: 'ready',
    error: null,
    expiresAt: '2026-07-18T10:00:00.000Z',
    createdAt: '2026-07-16T08:00:00.000Z',
    updatedAt: '2026-07-16T09:00:00.000Z',
    closedAt: null,
    ...overrides,
  };
}

describe('pull request preview helpers', () => {
  it('polls only lifecycle states that can progress without another user action', () => {
    expect(isTransitionalPullRequestPreview('queued')).toBe(true);
    expect(isTransitionalPullRequestPreview('building')).toBe(true);
    expect(isTransitionalPullRequestPreview('closing')).toBe(true);
    expect(isTransitionalPullRequestPreview('ready')).toBe(false);
    expect(isTransitionalPullRequestPreview('failed')).toBe(false);
  });

  it('only builds HTTPS links for active previews with a valid hostname', () => {
    expect(trustedPullRequestPreviewUrl(preview())).toBe('https://pr-42--shelter.example.com');
    expect(trustedPullRequestPreviewUrl(preview({ status: 'building' }))).toBe('https://pr-42--shelter.example.com');
    expect(trustedPullRequestPreviewUrl(preview({ status: 'building', activeDeploymentId: null }))).toBeUndefined();
    expect(trustedPullRequestPreviewUrl(preview({ status: 'failed' }))).toBe('https://pr-42--shelter.example.com');
    expect(trustedPullRequestPreviewUrl(preview({ status: 'closing' }))).toBeUndefined();
    expect(trustedPullRequestPreviewUrl(preview({ hostname: 'javascript:alert(1)' }))).toBeUndefined();
    expect(trustedPullRequestPreviewUrl(preview({ hostname: 'a..example.com' }))).toBeUndefined();
  });

  it('keeps stored values optional while requiring valid, unique new preview secrets', () => {
    const t = (english: string, _german: string, values?: Record<string, string | number>) => (
      english.replace(/\{([a-zA-Z0-9_]+)\}/g, (placeholder, key: string) => values && Object.hasOwn(values, key) ? String(values[key]) : placeholder)
    );
    const valid = previewEnvironmentValidation([
      { key: 'EXISTING_TOKEN', value: undefined },
      { key: 'NEW_TOKEN', value: 'preview-only' },
    ], ['EXISTING_TOKEN'], t);
    expect(valid.valid).toBe(true);

    const invalid = previewEnvironmentValidation([
      { key: 'DUPLICATE', value: 'one' },
      { key: 'DUPLICATE', value: 'two' },
      { key: 'PORT', value: '3001' },
      { key: 'NEW_EMPTY', value: '' },
    ], [], t);
    expect(invalid.valid).toBe(false);
    expect(invalid.errors).toEqual([
      'This variable name occurs more than once.',
      'This variable name occurs more than once.',
      'PORT is managed by Shelter.',
      'A value is required for a new variable.',
    ]);
  });
});

describe('PullRequestPreviewList', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows branch, commit, isolated preview URL, deployment link, and close action without a production preview', () => {
    const html = render(<PullRequestPreviewList projectId="prj_123" previews={[preview()]} maxActive={3} highlightedId="prv_123" onClose={() => undefined} />);
    expect(html).toContain('#42');
    expect(html).toContain('feature/check-this');
    expect(html).toContain('01234567');
    expect(html).toContain('href="https://pr-42--shelter.example.com"');
    expect(html).toContain('href="/projects/prj_123/deployments/dep_123"');
    expect(html).toContain('Open preview');
    expect(html).toContain('Linked from GitHub');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('Close');
    expect(html).not.toContain('Website preview');
    expect(html).not.toContain('<img');
  });

  it('keeps the last successful preview linked while a rebuild is running', () => {
    const html = render(<PullRequestPreviewList
      projectId="prj_123"
      previews={[preview({ status: 'building', generation: 3, error: 'Build fehlgeschlagen' })]}
      maxActive={3}
      onClose={() => undefined}
    />, 'de');
    expect(html).toContain('Build läuft');
    expect(html).toContain('Neu-Build 3');
    expect(html).toContain('Build fehlgeschlagen');
    expect(html).toContain('href="https://pr-42--shelter.example.com"');
  });

  it('explains the hard max-three state before another pull request is opened', () => {
    const html = render(<PullRequestPreviewList
      projectId="prj_123"
      previews={[
        preview({ id: 'prv_1', pullRequestNumber: 1 }),
        preview({ id: 'prv_2', pullRequestNumber: 2 }),
        preview({ id: 'prv_3', pullRequestNumber: 3 }),
      ]}
      maxActive={3}
      onClose={() => undefined}
    />);
    expect(html).toContain('Active preview limit reached');
    expect(html).toContain('New pull requests stay blocked');
  });
});

describe('PreviewCapability', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('offers a preconfigured replacement without pretending that GitHub can update the existing App', () => {
    const html = render(<PreviewCapability
      capability={{
        ready: false,
        configured: true,
        pullRequestsPermission: false,
        pullRequestEvent: false,
        remediation: 'update_existing_app',
        remediationUrl: 'https://github.com/organizations/shelter/settings/apps/shelter-host/permissions',
        upgradePending: false,
        upgradeInstallUrl: null,
        upgradeExpiresAt: null,
      }}
      onRetry={() => undefined}
    />);
    expect(html).toContain('Preconfigured permissions upgrade');
    expect(html).toContain('GitHub App upgrade required');
    expect(html).toContain('Create preconfigured replacement');
    expect(html).toContain('Update current App manually');
    expect(html).toContain('GitHub manifests cannot modify the connected App');
    expect(html).toContain('href="https://github.com/organizations/shelter/settings/apps/shelter-host/permissions"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('Missing:');
    expect(html).not.toContain('Step 1 of 2');
  });

  it('resumes a pending replacement installation without starting another manifest flow', () => {
    const html = render(<PreviewCapability
      capability={{
        ready: false,
        configured: true,
        pullRequestsPermission: false,
        pullRequestEvent: false,
        remediation: 'update_existing_app',
        remediationUrl: 'https://github.com/organizations/shelter/settings/apps/shelter-host/permissions',
        upgradePending: true,
        upgradeInstallUrl: 'https://github.com/apps/shelter-host-replacement/installations/new',
        upgradeExpiresAt: '2026-07-16T18:30:00.000Z',
      }}
      onRetry={() => undefined}
    />);
    expect(html).toContain('Replacement setup in progress');
    expect(html).toContain('Replacement GitHub App ready to install');
    expect(html).toContain('Continue replacement setup');
    expect(html).toContain('href="https://github.com/apps/shelter-host-replacement/installations/new"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('current GitHub App remains active');
    expect(html).toContain('replacement setup expires');
    expect(html).not.toContain('Create preconfigured replacement');
    expect(html).not.toContain('Update current App manually');
  });

  it('keeps a pending replacement visible when the active GitHub App is already ready', () => {
    const html = render(<PreviewCapability
      capability={{
        ready: true,
        configured: true,
        pullRequestsPermission: true,
        pullRequestEvent: true,
        remediation: 'none',
        remediationUrl: null,
        upgradePending: true,
        upgradeInstallUrl: 'https://github.com/apps/shelter-host-replacement/installations/new',
        upgradeExpiresAt: null,
      }}
      onRetry={() => undefined}
    />);
    expect(html).toContain('Replacement setup in progress');
    expect(html).toContain('Continue replacement setup');
    expect(html).toContain('current GitHub App remains active');
    expect(html).not.toContain('Pull requests can be read and the pull_request webhook is active');
  });

  it('prioritizes a pending replacement over installation approval for the active App', () => {
    const html = render(<PreviewCapability
      capability={{
        ready: false,
        configured: true,
        pullRequestsPermission: true,
        pullRequestEvent: true,
        installationChecked: true,
        installationPullRequestsPermission: false,
        installationPullRequestEvent: false,
        installationSuspended: false,
        remediation: 'approve_installation_update',
        remediationUrl: 'https://github.com/organizations/shelter/settings/installations/123',
        upgradePending: true,
        upgradeInstallUrl: 'https://github.com/apps/shelter-host-replacement/installations/new',
        upgradeExpiresAt: null,
      }}
      onRetry={() => undefined}
    />);
    expect(html).toContain('Replacement setup in progress');
    expect(html).toContain('Continue replacement setup');
    expect(html).not.toContain('Approve the updated GitHub access');
    expect(html).not.toContain('Approve on GitHub');
  });

  it('does not expose or restart a pending replacement when its installation URL is untrusted', () => {
    const html = render(<PreviewCapability
      capability={{
        ready: false,
        configured: true,
        pullRequestsPermission: false,
        pullRequestEvent: false,
        remediation: 'update_existing_app',
        remediationUrl: 'https://github.com/settings/apps/shelter-host/permissions',
        upgradePending: true,
        upgradeInstallUrl: 'https://github.com.evil.test/apps/shelter-host/installations/new',
        upgradeExpiresAt: null,
      }}
      onRetry={() => undefined}
    />);
    expect(html).toContain('Replacement installation unavailable');
    expect(html).not.toContain('github.com.evil.test');
    expect(html).not.toContain('Create preconfigured replacement');
    expect(html).not.toContain('Update current App manually');
  });

  it('explains the atomic migration and the repository selection requirement before replacement', () => {
    const html = render(<GitHubAppUpgradeImpact />);
    expect(html).toContain('Read repository contents and pull requests');
    expect(html).toContain('same accounts and repositories');
    expect(html).toContain('preserves existing project connections, auto-deploy, and previews');
    expect(html).toContain('keeps the current GitHub App active');
    expect(html).toContain('Production deployments stay online');
  });

  it('guides the installation owner through the second reauthorization step', () => {
    const html = render(<PreviewCapability
      capability={{
        ready: false,
        configured: true,
        pullRequestsPermission: true,
        pullRequestEvent: true,
        installationChecked: true,
        installationPullRequestsPermission: false,
        installationPullRequestEvent: false,
        installationSuspended: false,
        remediation: 'approve_installation_update',
        remediationUrl: 'https://github.com/organizations/shelter/settings/installations/123',
        upgradePending: false,
        upgradeInstallUrl: null,
        upgradeExpiresAt: null,
      }}
      onRetry={() => undefined}
    />);
    expect(html).toContain('Step 2 of 2');
    expect(html).toContain('Approve the updated GitHub access');
    expect(html).toContain('Repository installation: Pull requests read access');
    expect(html).toContain('Approve on GitHub');
    expect(html).toContain('href="https://github.com/organizations/shelter/settings/installations/123"');
    expect(html).toContain('Available:');
    expect(html).toContain('Missing:');
  });

  it('hides an untrusted manual-update URL while keeping the safe replacement action', () => {
    const html = render(<PreviewCapability
      capability={{
        ready: false,
        configured: true,
        pullRequestsPermission: false,
        pullRequestEvent: false,
        remediation: 'update_existing_app',
        remediationUrl: 'https://github.example.com/settings/apps/shelter/permissions',
        upgradePending: false,
        upgradeInstallUrl: null,
        upgradeExpiresAt: null,
      }}
      onRetry={() => undefined}
    />);
    expect(html).toContain('Create preconfigured replacement');
    expect(html).not.toContain('Update current App manually');
    expect(html).not.toContain('github.example.com');
  });
});
