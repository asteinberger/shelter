import type { GitHubPreviewCapability } from '../types';

function parseExactGithubUrl(value: string) {
  try {
    const url = new URL(value);
    const authority = value.match(/^https:\/\/([^/?#]+)/i)?.[1]?.toLowerCase();
    if (
      authority !== 'github.com'
      || url.origin !== 'https://github.com'
      || url.username
      || url.password
      || url.port
      || url.hash
    ) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export type GitHubPreviewCapabilityStatus = 'ready' | 'update' | 'unavailable';

export function githubPreviewCapabilityStatus(
  capability?: Pick<GitHubPreviewCapability, 'ready' | 'upgradePending'> | null,
): GitHubPreviewCapabilityStatus {
  if (capability?.upgradePending) return 'update';
  if (capability?.ready === true) return 'ready';
  if (capability?.ready === false) return 'update';
  return 'unavailable';
}

export function shouldRefetchGitHubPreviewCapability(
  capability?: Pick<GitHubPreviewCapability, 'ready' | 'upgradePending'> | null,
) {
  return capability?.ready === false || Boolean(capability?.upgradePending);
}

export interface GitHubProjectDraftState {
  repositoryKey: string;
  branch: string;
  autoDeploy: boolean;
}

export function hasGitHubProjectDraftChanges(draft: GitHubProjectDraftState, baseline: GitHubProjectDraftState) {
  return draft.repositoryKey !== baseline.repositoryKey
    || draft.branch !== baseline.branch
    || draft.autoDeploy !== baseline.autoDeploy;
}

export function shouldSynchronizeGitHubProjectDraft({
  projectChanged,
  draftDirty,
  previousConnectionSignature,
  connectionSignature,
}: {
  projectChanged: boolean;
  draftDirty: boolean;
  previousConnectionSignature: string;
  connectionSignature: string;
}) {
  return projectChanged || (!draftDirty && previousConnectionSignature !== connectionSignature);
}

export function trustedGitHubManifestRegistrationUrl(value: string) {
  const url = parseExactGithubUrl(value);
  const owner = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?';
  if (
    !url
    || (
      url.pathname !== '/settings/apps/new'
      && !new RegExp(`^/organizations/${owner}/settings/apps/new$`).test(url.pathname)
    )
  ) return undefined;
  const states = url.searchParams.getAll('state');
  const state = states[0];
  const keys = Array.from(url.searchParams.keys());
  if (
    states.length !== 1
    || !state
    || state.length < 16
    || state.length > 512
    || keys.length !== 1
    || keys[0] !== 'state'
  ) return undefined;
  return url.toString();
}

export function trustedGitHubAppUrl(value?: string | null) {
  if (!value) return undefined;
  const url = parseExactGithubUrl(value);
  if (
    !url
    || url.search
    || !/^\/apps\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?(?:\/installations\/new)?\/?$/.test(url.pathname)
  ) return undefined;
  return url.toString();
}

export function trustedGitHubAppInstallationUrl(value?: string | null) {
  if (!value) return undefined;
  const url = parseExactGithubUrl(value);
  if (
    !url
    || url.search
    || !/^\/apps\/[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?\/installations\/new$/.test(url.pathname)
  ) return undefined;
  return url.toString();
}

export function trustedGitHubRemediationUrl(value?: string | null) {
  if (!value) return undefined;
  const url = parseExactGithubUrl(value);
  if (!url || url.search) return undefined;

  const appSlug = '[a-z0-9][a-z0-9-]{0,99}';
  const owner = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?';
  const installationId = '\\d{1,20}';
  const allowedPaths = [
    new RegExp(`^/settings/apps/${appSlug}/permissions$`),
    new RegExp(`^/organizations/${owner}/settings/apps/${appSlug}/permissions$`),
    new RegExp(`^/enterprises/${owner}/settings/apps/${appSlug}/permissions$`),
    new RegExp(`^/settings/installations/${installationId}$`),
    new RegExp(`^/organizations/${owner}/settings/installations/${installationId}$`),
    new RegExp(`^/enterprises/${owner}/settings/installations/${installationId}$`),
  ];
  if (!allowedPaths.some((pattern) => pattern.test(url.pathname))) return undefined;
  return url.toString();
}

export function trustedGitHubRepositoryUrl(value?: string | null) {
  if (!value) return undefined;
  const url = parseExactGithubUrl(value);
  if (
    !url
    || url.search
    || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)
  ) return undefined;
  return url.toString();
}

export function gitHubRepositoryUrlFromFullName(fullName?: string | null) {
  if (!fullName || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) return undefined;
  return trustedGitHubRepositoryUrl(`https://github.com/${fullName}`);
}
