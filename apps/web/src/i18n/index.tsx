import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export const LOCALE_STORAGE_KEY = 'shelter.locale';

export type Locale = 'en' | 'de';
export type TranslationValues = Record<string, string | number>;
export type Translate = (english: string, german: string, values?: TranslationValues) => string;

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'de';
}

export function detectLocale(
  storedLocale?: string | null,
  browserLocales: readonly string[] = [],
): Locale {
  if (isLocale(storedLocale)) return storedLocale;
  return browserLocales.some((locale) => locale.toLowerCase().startsWith('de')) ? 'de' : 'en';
}

export function interpolate(message: string, values?: TranslationValues) {
  if (!values) return message;
  return message.replace(/\{([a-zA-Z0-9_]+)\}/g, (placeholder, key: string) => (
    Object.hasOwn(values, key) ? String(values[key]) : placeholder
  ));
}

export function currentLocale(): Locale {
  if (typeof document === 'undefined') return 'en';
  return document.documentElement.lang.toLowerCase().startsWith('de') ? 'de' : 'en';
}

export function localize(
  english: string,
  german: string,
  values?: TranslationValues,
  locale: Locale = currentLocale(),
) {
  return interpolate(locale === 'de' ? german : english, values);
}

function initialLocale(): Locale {
  if (typeof window === 'undefined') return 'en';

  let storedLocale: string | null = null;
  try {
    storedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    // A blocked storage API should not prevent the panel from starting.
  }

  return detectLocale(storedLocale, window.navigator.languages ?? [window.navigator.language]);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, updateLocale] = useState<Locale>(initialLocale);

  const setLocale = useCallback((nextLocale: Locale) => {
    updateLocale(nextLocale);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    const syncLocale = (event: StorageEvent) => {
      if (event.key === LOCALE_STORAGE_KEY && isLocale(event.newValue)) {
        updateLocale(event.newValue);
      }
    };
    window.addEventListener('storage', syncLocale);
    return () => window.removeEventListener('storage', syncLocale);
  }, []);

  const t = useCallback<Translate>((english, german, values) => (
    localize(english, german, values, locale)
  ), [locale]);

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used within an I18nProvider');
  return value;
}
