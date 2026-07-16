import { describe, expect, it } from 'vitest';
import type { Translate } from '@/i18n';
import { githubCallbackNotice } from './github-callback';

const english: Translate = (value) => value;

describe('GitHub callback notices', () => {
  it('keeps an incomplete replacement actionable without reporting the active App as broken', () => {
    expect(githubCallbackNotice('upgrade_incomplete', null, english)).toEqual({
      tone: 'warning',
      title: 'Replacement setup is incomplete',
      description: 'The replacement App is still missing required permissions or access to one or more linked repositories. Your current GitHub App remains active. Continue setup and grant access to the same repositories.',
    });
  });

  it('preserves upstream error details for actual callback failures', () => {
    expect(githubCallbackNotice('error', 'GitHub rejected the request.', english)).toEqual({
      tone: 'error',
      title: 'GitHub could not be connected',
      description: 'GitHub rejected the request.',
    });
  });
});
