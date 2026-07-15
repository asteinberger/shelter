import { describe, expect, it } from 'vitest';
import type { ProjectAnalysisApplication } from '../types';
import { replacementAnalysisDifferences } from './ProjectSourceUpload';

function application(overrides: Partial<ProjectAnalysisApplication> = {}): ProjectAnalysisApplication {
  return {
    id: 'app-site',
    rootDirectory: '.',
    name: 'Site',
    framework: 'next',
    frameworkVersion: '16.0.0',
    rendering: 'ssr',
    packageManager: 'npm',
    buildType: 'node',
    buildCommand: 'npm run build',
    startCommand: 'npm run start',
    outputDirectory: null,
    port: 3000,
    healthcheckPath: '/',
    spaFallback: false,
    environmentKeys: [],
    confidence: 0.98,
    evidence: ['package.json'],
    ...overrides,
  };
}

describe('replacementAnalysisDifferences', () => {
  it('reports root, build type, and port differences without changing either configuration', () => {
    expect(replacementAnalysisDifferences(application({
      rootDirectory: 'apps/site',
      buildType: 'node',
      port: 4321,
    }), {
      rootDirectory: 'apps/legacy',
      buildType: 'static',
      port: 80,
    })).toEqual([
      { field: 'rootDirectory', current: 'apps/legacy', detected: 'apps/site' },
      { field: 'buildType', current: 'static', detected: 'node' },
      { field: 'port', current: '80', detected: '4321' },
    ]);
  });

  it('treats an omitted or dot root as the repository root', () => {
    expect(replacementAnalysisDifferences(application({ rootDirectory: '.' }), {
      rootDirectory: '',
      buildType: 'node',
      port: 3000,
    })).toEqual([]);

    expect(replacementAnalysisDifferences(application({ rootDirectory: './' }), {
      buildType: 'node',
      port: 3000,
    })).toEqual([]);
  });

  it('does not invent a port mismatch when either side has no explicit port', () => {
    expect(replacementAnalysisDifferences(application({ port: null }), {
      buildType: 'node',
      port: 3000,
    })).toEqual([]);

    expect(replacementAnalysisDifferences(application({ port: 3000 }), {
      buildType: 'node',
    })).toEqual([]);
  });

  it('treats automatic detection as compatible and ignores managed static ports', () => {
    expect(replacementAnalysisDifferences(application({
      buildType: 'node',
      port: 3000,
    }), {
      buildType: 'auto',
      port: 3000,
    })).toEqual([]);

    expect(replacementAnalysisDifferences(application({
      framework: 'astro',
      rendering: 'static',
      buildType: 'static',
      port: 8080,
    }), {
      buildType: 'static',
      port: 3000,
    })).toEqual([]);
  });

  it('returns no differences before an application is selected', () => {
    expect(replacementAnalysisDifferences(null, {
      rootDirectory: 'apps/site',
      buildType: 'node',
      port: 3000,
    })).toEqual([]);
  });
});
