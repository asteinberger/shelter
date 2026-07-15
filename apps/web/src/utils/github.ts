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
  if (!url || url.pathname !== '/settings/apps/new') return undefined;
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
