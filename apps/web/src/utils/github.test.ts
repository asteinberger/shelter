import { describe, expect, it } from 'vitest';
import {
  gitHubRepositoryUrlFromFullName,
  hasGitHubProjectDraftChanges,
  shouldSynchronizeGitHubProjectDraft,
  trustedGitHubAppUrl,
  trustedGitHubManifestRegistrationUrl,
  trustedGitHubRemediationUrl,
  trustedGitHubRepositoryUrl,
} from './github';

describe('GitHub project draft synchronization', () => {
  const baseline = { repositoryKey: '', branch: 'main', autoDeploy: true };

  it('syncs a changed server connection while the local draft is untouched', () => {
    expect(hasGitHubProjectDraftChanges({ ...baseline }, baseline)).toBe(false);
    expect(shouldSynchronizeGitHubProjectDraft({
      projectChanged: false,
      draftDirty: false,
      previousConnectionSignature: 'installation:repo:main:true',
      connectionSignature: 'installation:repo:release:false',
    })).toBe(true);
  });

  it('preserves local edits until they are reverted, except when navigating to another project', () => {
    const dirty = hasGitHubProjectDraftChanges({ ...baseline, branch: 'feature/local' }, baseline);
    expect(dirty).toBe(true);
    expect(shouldSynchronizeGitHubProjectDraft({
      projectChanged: false,
      draftDirty: dirty,
      previousConnectionSignature: 'installation:repo:main:true',
      connectionSignature: 'installation:repo:release:false',
    })).toBe(false);
    expect(shouldSynchronizeGitHubProjectDraft({
      projectChanged: true,
      draftDirty: dirty,
      previousConnectionSignature: 'installation:repo:main:true',
      connectionSignature: 'other-installation:repo:main:true',
    })).toBe(true);
  });
});

describe('GitHub URL allowlists', () => {
  it('accepts only the exact GitHub App manifest endpoint with one state parameter', () => {
    expect(trustedGitHubManifestRegistrationUrl(
      'https://github.com/settings/apps/new?state=abcdefghijklmnop',
    )).toBe('https://github.com/settings/apps/new?state=abcdefghijklmnop');

    for (const value of [
      'https://github.com.evil.test/settings/apps/new?state=abcdefghijklmnop',
      'https://user@github.com/settings/apps/new?state=abcdefghijklmnop',
      'https://github.com:444/settings/apps/new?state=abcdefghijklmnop',
      'https://github.com/settings/apps/new#state=abcdefghijklmnop',
      'https://github.com/settings/apps/new?state=abcdefghijklmnop&next=/apps',
      'https://github.com/settings/apps/new?state=abcdefghijklmnop&state=qrstuvwxyzabcdef',
      'https://github.com/settings/apps/new?state=short',
      'https://github.com/apps/new?state=abcdefghijklmnop',
    ]) expect(trustedGitHubManifestRegistrationUrl(value)).toBeUndefined();
  });

  it('allows only GitHub App management and installation paths', () => {
    expect(trustedGitHubAppUrl('https://github.com/apps/shelter-raum')).toBe('https://github.com/apps/shelter-raum');
    expect(trustedGitHubAppUrl('https://github.com/apps/shelter-raum/installations/new')).toBe(
      'https://github.com/apps/shelter-raum/installations/new',
    );
    expect(trustedGitHubAppUrl('https://github.com/settings/apps/shelter-raum')).toBeUndefined();
    expect(trustedGitHubAppUrl('https://github.com/apps/shelter-raum?state=secret')).toBeUndefined();
    expect(trustedGitHubAppUrl('https://user@github.com/apps/shelter-raum')).toBeUndefined();
    expect(trustedGitHubAppUrl('https://github.com:444/apps/shelter-raum')).toBeUndefined();
    expect(trustedGitHubAppUrl('https://github.com/apps/shelter-raum#settings')).toBeUndefined();
  });

  it('allows only exact GitHub App update and installation approval destinations', () => {
    for (const value of [
      'https://github.com/settings/apps/shelter-raum/permissions',
      'https://github.com/organizations/raum/settings/apps/shelter-raum/permissions',
      'https://github.com/enterprises/raum-cloud/settings/apps/shelter-raum/permissions',
      'https://github.com/settings/installations/123',
      'https://github.com/organizations/raum/settings/installations/123',
      'https://github.com/enterprises/raum-cloud/settings/installations/123',
    ]) expect(trustedGitHubRemediationUrl(value)).toBe(value);

    for (const value of [
      'https://github.com.evil.test/settings/apps/shelter-raum/permissions',
      'https://user@github.com/settings/apps/shelter-raum/permissions',
      'https://github.com:444/settings/apps/shelter-raum/permissions',
      'https://github.com/settings/apps/shelter-raum/permissions?next=/apps',
      'https://github.com/settings/apps/shelter-raum/permissions#events',
      'https://github.com/settings/apps/shelter-raum/permissions/',
      'https://github.com/settings/apps/Shelter-Raum/permissions',
      'https://github.com/settings/apps/shelter-raum',
      'https://github.com/organizations/raum/settings/apps/shelter-raum',
      'https://github.com/organizations/raum/settings/installations/not-a-number',
      'https://github.com/organizations/raum/settings/installations/123/repositories',
      'https://github.com/apps/shelter-raum/installations/new',
      'https://github.com/apps/shelter-raum/installations/new/permissions',
      'https://github.com/apps/shelter-raum',
    ]) expect(trustedGitHubRemediationUrl(value)).toBeUndefined();

    expect(trustedGitHubRemediationUrl(null)).toBeUndefined();
    expect(trustedGitHubRemediationUrl(undefined)).toBeUndefined();
  });

  it('allows repository links only and derives them from safe full names', () => {
    expect(trustedGitHubRepositoryUrl('https://github.com/raum/website')).toBe('https://github.com/raum/website');
    expect(gitHubRepositoryUrlFromFullName('raum/website')).toBe('https://github.com/raum/website');
    expect(gitHubRepositoryUrlFromFullName('../settings/apps')).toBeUndefined();
    expect(trustedGitHubRepositoryUrl('https://github.com/raum/website/issues')).toBeUndefined();
    expect(trustedGitHubRepositoryUrl('https://github.com/raum/website?tab=readme')).toBeUndefined();
    expect(trustedGitHubRepositoryUrl('https://user@github.com/raum/website')).toBeUndefined();
    expect(trustedGitHubRepositoryUrl('https://github.com:444/raum/website')).toBeUndefined();
    expect(trustedGitHubRepositoryUrl('https://github.com/raum/website#readme')).toBeUndefined();
  });
});
