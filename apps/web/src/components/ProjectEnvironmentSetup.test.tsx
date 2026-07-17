import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import type { ProjectEnvironmentRequirement } from '../types';
import { ProjectEnvironmentSetup } from './ProjectEnvironmentSetup';

const requirements: ProjectEnvironmentRequirement[] = [
  {
    key: 'ANTHROPIC_API_KEY',
    required: true,
    secret: true,
    scope: 'runtime',
    visibility: 'server',
    confidence: 'high',
    sources: [{ path: 'src/lib/anthropic.ts', line: 8, kind: 'validation' }],
  },
  {
    key: 'VITE_PUBLIC_ORIGIN',
    required: false,
    secret: false,
    scope: 'build',
    visibility: 'public',
    confidence: 'medium',
    sources: [{ path: 'src/main.tsx', line: 3, kind: 'reference' }],
  },
];

function render(
  locale: 'en' | 'de',
  values: Record<string, string> = {},
  skippedKeys: ReadonlySet<string> = new Set(),
) {
  vi.stubGlobal('window', {
    localStorage: { getItem: (key: string) => key === LOCALE_STORAGE_KEY ? locale : null },
    navigator: { language: locale, languages: [locale] },
  });
  return renderToStaticMarkup(
    <I18nProvider>
      <ProjectEnvironmentSetup
        requirements={requirements}
        values={values}
        skippedKeys={skippedKeys}
        errors={{ ANTHROPIC_API_KEY: locale === 'de' ? 'Wert fehlt' : 'Value missing' }}
        showErrors
        onChange={() => undefined}
        onSkippedChange={() => undefined}
      />
    </I18nProvider>,
  );
}

describe('ProjectEnvironmentSetup', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders detected evidence, secret/public semantics and provider help', () => {
    const html = render('en');
    expect(html).toContain('Configure your environment');
    expect(html).toContain('ANTHROPIC_API_KEY');
    expect(html).toContain('type="password"');
    expect(html).toContain('src/lib/anthropic.ts:8');
    expect(html).toContain('Where do I find this?');
    expect(html).toContain('Skip for now');
    expect(html).toContain('console.anthropic.com/settings/keys');
    expect(html).toContain('VITE_PUBLIC_ORIGIN');
    expect(html).toContain('public client bundle');
    expect(html).toContain('Value missing');
    expect(html).toContain('aria-invalid="true"');
  });

  it('shows a localized ready state once required values are present', () => {
    const html = render('de', {}, new Set(['ANTHROPIC_API_KEY']));
    expect(html).toContain('Umgebung konfigurieren');
    expect(html).toContain('Bereit');
    expect(html).toContain('Übersprungen');
    expect(html).toContain('Nur statische Analyse');
  });
});
