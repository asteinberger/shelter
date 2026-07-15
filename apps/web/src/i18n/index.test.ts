import { describe, expect, it } from 'vitest';
import { detectLocale, interpolate, isLocale, localize } from './index';

describe('i18n helpers', () => {
  it('uses a saved locale before browser preferences', () => {
    expect(detectLocale('en', ['de-DE'])).toBe('en');
    expect(detectLocale('de', ['en-US'])).toBe('de');
  });

  it('detects German browsers and otherwise defaults to English', () => {
    expect(detectLocale(null, ['fr-FR', 'de-CH'])).toBe('de');
    expect(detectLocale(null, ['fr-FR', 'en-US'])).toBe('en');
    expect(detectLocale()).toBe('en');
  });

  it('validates supported locale values', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('de')).toBe(true);
    expect(isLocale('fr')).toBe(false);
  });

  it('interpolates known values without removing unknown placeholders', () => {
    expect(interpolate('Deploy {project} on {branch}', { project: 'Docs' }))
      .toBe('Deploy Docs on {branch}');
  });

  it('selects and interpolates a message for an explicit locale', () => {
    expect(localize('Hello {name}', 'Hallo {name}', { name: 'Shelter' }, 'en')).toBe('Hello Shelter');
    expect(localize('Hello {name}', 'Hallo {name}', { name: 'Shelter' }, 'de')).toBe('Hallo Shelter');
  });
});
