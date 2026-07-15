import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import type { CloudflareAccessProtection } from '../types';
import { CloudflareAccessProtectionCard, cloudflareAccessApplicationsUrl } from './CloudflareAccessProtectionCard';
import { ProductionSafetyAlert } from './ProductionSafetyAlert';

function setLocale(locale: 'en' | 'de') {
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => key === LOCALE_STORAGE_KEY ? locale : null,
      setItem: vi.fn(),
    },
    navigator: { language: locale, languages: [locale] },
  });
}

function render(card: React.ReactNode, locale: 'en' | 'de' = 'en') {
  setLocale(locale);
  return renderToStaticMarkup(
    <I18nProvider>
      <MemoryRouter>{card}</MemoryRouter>
    </I18nProvider>,
  );
}

const unconfirmed: CloudflareAccessProtection = {
  status: 'action_required',
  panelDomain: 'hosting.example.com',
  confirmedHostname: null,
  confirmedAt: null,
};

describe('CloudflareAccessProtectionCard', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the exact hostname, manual-verification boundary, checklist, and account-specific dashboard link', () => {
    const html = render(
      <CloudflareAccessProtectionCard
        accessProtection={unconfirmed}
        accountId={'a'.repeat(32)}
        onConfirm={() => undefined}
        onRevoke={() => undefined}
      />,
    );

    expect(html).toContain('Step 4 · Production security');
    expect(html).toContain('Production unsafe');
    expect(html).toContain('hosting.example.com');
    expect(html).toContain('Self-hosted Access application for exactly hosting.example.com');
    expect(html).toContain('Shelter does not inspect your Access application or policies automatically');
    expect(html).toContain(`href="https://dash.cloudflare.com/${'a'.repeat(32)}/one/access/apps"`);
    expect(html).toContain('I configured these protections');
  });

  it('renders localized confirmed, loading, success, and error states accessibly', () => {
    const confirmed: CloudflareAccessProtection = {
      status: 'confirmed_by_admin',
      panelDomain: 'hosting.example.com',
      confirmedHostname: 'hosting.example.com',
      confirmedAt: '2026-07-15T08:30:00.000Z',
    };
    const html = render(
      <CloudflareAccessProtectionCard
        accessProtection={confirmed}
        pending
        error="Die Anfrage ist fehlgeschlagen."
        success="confirmed"
        onConfirm={() => undefined}
        onRevoke={() => undefined}
      />,
      'de',
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Vom Administrator bestätigt');
    expect(html).toContain('Bestätigung wird widerrufen');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Die Anfrage ist fehlgeschlagen.');
    expect(html).toContain('role="status"');
    expect(html).toContain('Administrator-Bestätigung gespeichert');
  });

  it('does not render before a panel hostname exists', () => {
    const html = render(
      <CloudflareAccessProtectionCard
        accessProtection={{ status: 'not_applicable', panelDomain: null, confirmedHostname: null, confirmedAt: null }}
        onConfirm={() => undefined}
        onRevoke={() => undefined}
      />,
    );
    expect(html).toBe('');
  });

  it('only builds account-specific links from valid Cloudflare account IDs', () => {
    expect(cloudflareAccessApplicationsUrl('not/an/account')).toBe('https://dash.cloudflare.com/?to=/:account/one/access/apps');
    expect(cloudflareAccessApplicationsUrl('B'.repeat(32))).toBe(`https://dash.cloudflare.com/${'B'.repeat(32)}/one/access/apps`);
  });
});

describe('ProductionSafetyAlert', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('warns without blocking deployment actions and links to the protection settings', () => {
    const html = render(<ProductionSafetyAlert accessProtection={unconfirmed} />);
    expect(html).toContain('Production unsafe');
    expect(html).toContain('hosting.example.com');
    expect(html).toContain('Deployments remain available');
    expect(html).toContain('href="/settings/cloudflare"');
  });

  it('stays hidden after administrator confirmation', () => {
    const html = render(<ProductionSafetyAlert accessProtection={{
      ...unconfirmed,
      status: 'confirmed_by_admin',
      confirmedHostname: unconfirmed.panelDomain,
      confirmedAt: '2026-07-15T08:30:00.000Z',
    }} />);
    expect(html).toBe('');
  });
});
