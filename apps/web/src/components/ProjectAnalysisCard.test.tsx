import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import type { ProjectSourceAnalysis } from '../types';
import { ProjectAnalysisCard, type ProjectAnalysisStatus } from './ProjectAnalysisCard';

function renderCard(locale: 'en' | 'de', status: ProjectAnalysisStatus, analysis?: ProjectSourceAnalysis) {
  vi.stubGlobal('window', {
    localStorage: { getItem: (key: string) => key === LOCALE_STORAGE_KEY ? locale : null },
    navigator: { language: locale, languages: [locale] },
  });
  return renderToStaticMarkup(
    <I18nProvider>
      <ProjectAnalysisCard
        status={status}
        analysis={analysis}
        selectedApplicationId="apps/docs"
        missingEnvironmentKeys={['PUBLIC_API_URL']}
        onAddEnvironmentKeys={() => undefined}
        onShowAdvanced={() => undefined}
        onRetry={() => undefined}
      />
    </I18nProvider>,
  );
}

const analysis: ProjectSourceAnalysis = {
  fingerprint: 'sha256:test',
  recommendedApplicationId: 'apps/web',
  applications: [
    {
      id: 'apps/web',
      rootDirectory: 'apps/web',
      name: 'Storefront',
      framework: 'next',
      frameworkVersion: '16.0.0',
      rendering: 'ssr',
      packageManager: 'pnpm',
      buildType: 'node',
      buildCommand: 'pnpm build',
      startCommand: 'pnpm start',
      outputDirectory: '.next',
      port: 3000,
      healthcheckPath: '/',
      spaFallback: false,
      environmentKeys: ['DATABASE_URL'],
      confidence: 0.99,
      evidence: ['apps/web/package.json'],
    },
    {
      id: 'apps/docs',
      rootDirectory: 'apps/docs',
      name: 'Documentation',
      framework: 'astro',
      frameworkVersion: '5.2.0',
      rendering: 'static',
      packageManager: 'pnpm',
      buildType: 'static',
      buildCommand: 'pnpm build',
      startCommand: null,
      outputDirectory: 'dist',
      port: null,
      healthcheckPath: '/',
      spaFallback: false,
      environmentKeys: ['PUBLIC_API_URL'],
      confidence: 'high',
      evidence: ['apps/docs/astro.config.mjs'],
    },
  ],
};

describe('ProjectAnalysisCard', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['en' as const, 'Analyzing project', 'You can keep configuring the project'],
    ['de' as const, 'Projekt wird analysiert', 'weiter konfigurieren'],
  ])('renders an accessible localized loading state in %s', (locale, title, detail) => {
    const html = renderCard(locale, 'analyzing');
    expect(html).toContain('role="status"');
    expect(html).toContain(title);
    expect(html).toContain(detail);
  });

  it.each([
    ['en' as const, 'Automatic analysis is unavailable', 'You can still create the project'],
    ['de' as const, 'Automatische Analyse nicht verfügbar', 'trotzdem anlegen'],
  ])('makes analysis errors explicitly non-blocking in %s', (locale, title, detail) => {
    const html = renderCard(locale, 'error');
    expect(html).toContain(title);
    expect(html).toContain(detail);
    expect(html).toContain(locale === 'de' ? 'Erneut analysieren' : 'Analyze again');
  });

  it('renders monorepo selection, selected app facts and env-key CTA without any values', () => {
    const html = renderCard('en', 'ready', analysis);
    expect(html).toContain('2 applications found');
    expect(html).toContain('Storefront');
    expect(html).toContain('Documentation');
    expect(html).toContain('Astro 5.2.0 detected');
    expect(html).toContain('High confidence');
    expect(html).toContain('apps/docs');
    expect(html).toContain('PUBLIC_API_URL');
    expect(html).toContain('Add missing variables');
    expect(html).toContain('Detected · Change');
    expect(html).not.toContain('DATABASE_PASSWORD=');
  });
});
