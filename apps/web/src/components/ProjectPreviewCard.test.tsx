import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import { I18nProvider } from '../i18n';
import { ProjectPreviewCard } from './ProjectPreviewCard';

function project(preview: Project['preview']): Project {
  return {
    id: 'prj_preview',
    name: 'Frog Website',
    status: 'live',
    sourceType: 'git',
    activeDeploymentId: 'dep_preview',
    preview,
  };
}

function fileStorageProject(): Project {
  return {
    id: 'prj_files',
    name: 'Press kit',
    status: 'live',
    sourceType: 'upload',
    activeDeploymentId: 'dep_files',
    currentDeployment: { id: 'dep_files', status: 'ready', runtimeKind: 'files' },
    deployments: [{ id: 'dep_files', status: 'ready', runtimeKind: 'files' }],
  };
}

function renderPreview(card: React.ReactNode) {
  return renderToStaticMarkup(<I18nProvider>{card}</I18nProvider>);
}

describe('ProjectPreviewCard', () => {
  it('renders the authenticated screenshot endpoint in a browser frame', () => {
    const html = renderPreview(
      <ProjectPreviewCard
        project={project({
          status: 'ready',
          deploymentId: 'dep_preview',
          imageUrl: '/api/projects/prj_preview/preview?deployment=dep_preview',
          capturedAt: '2026-07-14T08:00:00.000Z',
        })}
        publicUrl="https://frog.example.com"
      />,
    );

    expect(html).toContain('Website preview');
    expect(html).toContain('frog.example.com');
    expect(html).toContain('/api/projects/prj_preview/preview?deployment=dep_preview');
    expect(html).toContain('Screenshot of website Frog Website');
  });

  it('explains why an API-only project has no visual preview', () => {
    const html = renderPreview(
      <ProjectPreviewCard project={project({
        status: 'unavailable',
        deploymentId: 'dep_preview',
        reason: 'not_html',
      })} />,
    );

    expect(html).toContain('No visual preview available');
    expect(html).toContain('This is probably an API service');
  });

  it('shows a dedicated file-storage card instead of a website preview', () => {
    const html = renderPreview(
      <ProjectPreviewCard project={fileStorageProject()} publicUrl="https://files.example.com" />,
    );

    expect(html).toContain('File storage');
    expect(html).toContain('Your files have a home');
    expect(html).toContain('Example URL · illustrative only');
    expect(html).toContain('https://files.example.com/path/to/file.ext');
    expect(html).toContain('Replace path/to/file.ext with the real path from your upload.');
    expect(html).toContain('Folder browsing stays private');
    expect(html).not.toContain('Website preview');
  });
});
