import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { THEME_STORAGE_KEY } from './theme';
import { LOCALE_STORAGE_KEY } from '../i18n';

const themeInitSource = fs.readFileSync(
  new URL('../../public/theme-init.js', import.meta.url),
  'utf8',
);

function runThemeInit({
  storedTheme,
  storedLocale,
  browserLocales = ['en-US'],
  prefersDark = false,
  storageThrows = false,
}: {
  storedTheme?: string | null;
  storedLocale?: string | null;
  browserLocales?: string[];
  prefersDark?: boolean;
  storageThrows?: boolean;
} = {}) {
  const classes = new Set(['existing']);
  const root = {
    classList: {
      add: (...tokens: string[]) => tokens.forEach((token) => classes.add(token)),
      remove: (...tokens: string[]) => tokens.forEach((token) => classes.delete(token)),
    },
    dataset: {} as Record<string, string>,
    style: {} as { colorScheme?: string },
    lang: 'en',
  };
  const attributes: Record<string, string> = {};
  const requestedKeys: string[] = [];
  const browserWindow = {
    navigator: { languages: browserLocales, language: browserLocales[0] ?? 'en-US' },
    matchMedia: (query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' && prefersDark,
    }),
  } as Record<string, unknown>;

  Object.defineProperty(browserWindow, 'localStorage', {
    get() {
      if (storageThrows) throw new Error('storage disabled');
      return {
        getItem(key: string) {
          requestedKeys.push(key);
          if (key === THEME_STORAGE_KEY) return storedTheme ?? null;
          if (key === LOCALE_STORAGE_KEY) return storedLocale ?? null;
          return null;
        },
      };
    },
  });

  vm.runInNewContext(themeInitSource, {
    window: browserWindow,
    document: {
      documentElement: root,
      querySelector: () => ({
        setAttribute(name: string, value: string) {
          attributes[name] = value;
        },
      }),
    },
  });

  return { attributes, classes, requestedKeys, root };
}

describe('theme-init.js', () => {
  it('applies an explicit stored theme before the application starts', () => {
    const result = runThemeInit({ storedTheme: 'dark' });

    expect(result.requestedKeys).toEqual([THEME_STORAGE_KEY, LOCALE_STORAGE_KEY]);
    expect([...result.classes]).toEqual(['existing', 'dark']);
    expect(result.root.dataset).toEqual({ theme: 'dark', resolvedTheme: 'dark' });
    expect(result.root.style.colorScheme).toBe('dark');
    expect(result.attributes.content).toBe('#0a0a0a');
    expect(result.root.lang).toBe('en');
  });

  it('applies the saved locale or detects a German browser before React starts', () => {
    expect(runThemeInit({ storedLocale: 'en', browserLocales: ['de-DE'] }).root.lang).toBe('en');
    expect(runThemeInit({ storedLocale: 'de', browserLocales: ['en-US'] }).root.lang).toBe('de');
    expect(runThemeInit({ browserLocales: ['fr-FR', 'de-CH'] }).root.lang).toBe('de');
  });

  it('defaults to the current system theme when no preference is stored', () => {
    const result = runThemeInit({ prefersDark: true });

    expect([...result.classes]).toEqual(['existing', 'dark']);
    expect(result.root.dataset).toEqual({ theme: 'system', resolvedTheme: 'dark' });
  });

  it('treats invalid or inaccessible storage as a system preference', () => {
    const invalid = runThemeInit({ storedTheme: 'sepia' });
    expect([...invalid.classes]).toEqual(['existing', 'light']);
    expect(invalid.root.dataset).toEqual({ theme: 'system', resolvedTheme: 'light' });
    expect(invalid.attributes.content).toBe('#ffffff');

    const inaccessible = runThemeInit({ storageThrows: true, prefersDark: true });
    expect(inaccessible.requestedKeys).toEqual([]);
    expect([...inaccessible.classes]).toEqual(['existing', 'dark']);
    expect(inaccessible.root.dataset).toEqual({ theme: 'system', resolvedTheme: 'dark' });
  });
});
