import { describe, expect, it } from 'vitest';
import {
  THEME_STORAGE_KEY,
  applyResolvedTheme,
  normalizeTheme,
  readStoredTheme,
  resolveTheme,
  writeStoredTheme,
  type Theme,
} from './theme';

describe('theme preferences', () => {
  it('accepts only supported preferences', () => {
    expect(normalizeTheme('light')).toBe('light');
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('system')).toBe('system');
    expect(normalizeTheme('DARK')).toBeNull();
    expect(normalizeTheme(' dark ')).toBeNull();
    expect(normalizeTheme(null)).toBeNull();
  });

  it('reads a valid preference and rejects corrupt storage values', () => {
    expect(readStoredTheme({ getItem: (key) => key === THEME_STORAGE_KEY ? 'dark' : null })).toBe('dark');
    expect(readStoredTheme({ getItem: () => 'sepia' })).toBeNull();
    expect(readStoredTheme({ getItem: () => { throw new Error('storage disabled'); } })).toBeNull();
    expect(readStoredTheme(null)).toBeNull();
  });

  it('writes the normalized preference without surfacing storage failures', () => {
    const writes: Array<[string, string]> = [];
    const storage = {
      setItem(key: string, value: string) {
        writes.push([key, value]);
      },
    };

    expect(writeStoredTheme('system', storage)).toBe(true);
    expect(writes).toEqual([[THEME_STORAGE_KEY, 'system']]);
    expect(writeStoredTheme('sepia' as Theme, storage)).toBe(false);
    expect(writeStoredTheme('dark', { setItem: () => { throw new Error('quota exceeded'); } })).toBe(false);
    expect(writeStoredTheme('light', null)).toBe(false);
  });

  it('resolves the system preference while preserving explicit choices', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });
});

describe('applyResolvedTheme', () => {
  it('updates the root class, native color scheme and browser theme color', () => {
    const classes = new Set(['light', 'app-root']);
    const root = {
      classList: {
        add: (...tokens: string[]) => tokens.forEach((token) => classes.add(token)),
        remove: (...tokens: string[]) => tokens.forEach((token) => classes.delete(token)),
      },
      dataset: {} as Record<string, string>,
      style: {} as { colorScheme?: string },
    };
    const attributes: Record<string, string> = {};
    const targetDocument = {
      documentElement: root,
      querySelector: () => ({
        setAttribute(name: string, value: string) {
          attributes[name] = value;
        },
      }),
    } as unknown as Document;

    expect(applyResolvedTheme('dark', targetDocument)).toBe('dark');
    expect([...classes]).toEqual(['app-root', 'dark']);
    expect(root.style.colorScheme).toBe('dark');
    expect(root.dataset.resolvedTheme).toBe('dark');
    expect(attributes.content).toBe('#0a0a0a');

    applyResolvedTheme('light', targetDocument);
    expect([...classes]).toEqual(['app-root', 'light']);
    expect(root.style.colorScheme).toBe('light');
    expect(attributes.content).toBe('#ffffff');
  });

  it('is a safe no-op when no document exists', () => {
    expect(applyResolvedTheme('dark', null)).toBe('dark');
  });
});
