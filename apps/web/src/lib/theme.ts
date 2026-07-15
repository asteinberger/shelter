export type Theme = 'light' | 'dark' | 'system';

export type ResolvedTheme = Exclude<Theme, 'system'>;

export const THEME_STORAGE_KEY = 'shelter-theme';

const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: '#ffffff',
  dark: '#0a0a0a',
};

type ThemeStorageReader = Pick<Storage, 'getItem'>;
type ThemeStorageWriter = Pick<Storage, 'setItem'>;

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function browserDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

export function normalizeTheme(value: unknown): Theme | null {
  return value === 'light' || value === 'dark' || value === 'system' ? value : null;
}

export function readStoredTheme(storage: ThemeStorageReader | null = browserStorage()): Theme | null {
  if (!storage) return null;

  try {
    return normalizeTheme(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeStoredTheme(theme: Theme, storage: ThemeStorageWriter | null = browserStorage()): boolean {
  const normalized = normalizeTheme(theme);
  if (!storage || !normalized) return false;

  try {
    storage.setItem(THEME_STORAGE_KEY, normalized);
    return true;
  } catch {
    return false;
  }
}

export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === 'dark' || (theme === 'system' && prefersDark)) return 'dark';
  return 'light';
}

export function applyResolvedTheme(
  resolved: ResolvedTheme,
  targetDocument: Document | null = browserDocument(),
): ResolvedTheme {
  if (!targetDocument) return resolved;

  const root = targetDocument.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
  root.dataset.resolvedTheme = resolved;

  targetDocument
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', THEME_COLORS[resolved]);

  return resolved;
}
