import { describe, expect, it } from 'vitest';
import type { ProjectAnalysisApplication, ProjectSourceAnalysis } from '../types';
import {
  AnalysisRequestCoordinator,
  mergeDetectedBuildConfig,
  missingDetectedEnvironmentKeys,
  recommendedAnalysisApplicationId,
} from './project-analysis';

function application(overrides: Partial<ProjectAnalysisApplication> = {}): ProjectAnalysisApplication {
  return {
    id: 'apps/web',
    rootDirectory: 'apps/web',
    name: 'Website',
    framework: 'next',
    frameworkVersion: '16.0.0',
    rendering: 'ssr',
    packageManager: 'pnpm',
    buildType: 'node',
    buildCommand: 'pnpm build',
    startCommand: 'pnpm start',
    outputDirectory: '.next',
    port: 3000,
    healthcheckPath: '/api/health',
    spaFallback: false,
    environmentKeys: ['DATABASE_URL'],
    confidence: 0.98,
    evidence: ['apps/web/package.json'],
    ...overrides,
  };
}

describe('project analysis selection', () => {
  it('uses the recommended app in a monorepo and safely falls back to the first app', () => {
    const analysis: ProjectSourceAnalysis = {
      fingerprint: 'one',
      applications: [application(), application({ id: 'apps/docs', name: 'Docs', framework: 'astro' })],
      recommendedApplicationId: 'apps/docs',
    };
    expect(recommendedAnalysisApplicationId(analysis)).toBe('apps/docs');
    expect(recommendedAnalysisApplicationId({ ...analysis, recommendedApplicationId: 'missing' })).toBe('apps/web');
  });

  it('updates detected values while preserving every manual override', () => {
    const current = {
      name: 'My project',
      rootDirectory: 'custom/root',
      buildType: 'auto' as const,
      dockerfilePath: 'ops/Dockerfile',
      healthcheckPath: '/',
      port: '8080',
    };
    const merged = mergeDetectedBuildConfig(current, application(), new Set(['rootDirectory', 'port']));

    expect(merged).toEqual({
      ...current,
      buildType: 'node',
      healthcheckPath: '/api/health',
      dockerfilePath: 'Dockerfile',
    });
    expect(merged.rootDirectory).toBe('custom/root');
    expect(merged.port).toBe('8080');
  });

  it('adds only valid, missing environment keys and excludes Shelter-managed keys', () => {
    expect(missingDetectedEnvironmentKeys(
      ['DATABASE_URL', 'port', 'PUBLIC_KEY', 'DATABASE_URL', 'NOT-A-KEY'],
      ['PUBLIC_KEY'],
      new Set(['PORT']),
    )).toEqual(['DATABASE_URL']);
  });
});

describe('project analysis request coordination', () => {
  it('aborts an older request and rejects its stale result', () => {
    const coordinator = new AnalysisRequestCoordinator();
    const first = coordinator.begin();
    const second = coordinator.begin();

    expect(first.signal.aborted).toBe(true);
    expect(coordinator.isCurrent(first.version)).toBe(false);
    expect(coordinator.isCurrent(second.version)).toBe(true);

    coordinator.cancel();
    expect(second.signal.aborted).toBe(true);
    expect(coordinator.isCurrent(second.version)).toBe(false);
  });
});
