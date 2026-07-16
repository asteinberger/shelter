import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import { DomainAccessSettings } from './DomainAccessSettings';

function render(locale: 'en' | 'de', protectedSite: boolean, seoIndexing: boolean) {
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => key === LOCALE_STORAGE_KEY ? locale : null,
      setItem: vi.fn(),
    },
    navigator: { language: locale, languages: [locale] },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <DomainAccessSettings
          projectId="prj_1"
          domains={[{
            id: 'dom_1',
            hostname: 'preview.example.com',
            status: 'active',
            passwordProtectionEnabled: protectedSite,
            passwordConfigured: protectedSite,
            accessSessionTtlHours: 168,
            seoIndexing,
          }]}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('DomainAccessSettings', () => {
  it('explains independent site sharing without referring visitors to the Shelter account', () => {
    const markup = render('en', true, false);
    expect(markup).toContain('Access &amp; visibility');
    expect(markup).toContain('Visitors do not need a Shelter account');
    expect(markup).toContain('Password protected');
    expect(markup).toContain('noindex');
    expect(markup).toContain('Sign out all visitors');
  });

  it('shows the public SEO control in German', () => {
    const markup = render('de', false, true);
    expect(markup).toContain('Zugriff &amp; Sichtbarkeit');
    expect(markup).toContain('Öffentlich · indexierbar');
    expect(markup).toContain('Suchmaschinen-Indexierung');
    expect(markup).not.toContain('Geteiltes Passwort');
  });
});
