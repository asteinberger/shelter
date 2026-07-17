import type {
  ProjectAnalysisApplication,
  ProjectEnvironmentRequirement,
  ProjectSourceAnalysis,
} from '../types';

export interface DetectableBuildConfig {
  rootDirectory: string;
  buildType: 'auto' | 'dockerfile' | 'node' | 'static';
  dockerfilePath: string;
  healthcheckPath: string;
  port: string;
}

export type DetectableBuildConfigField = keyof DetectableBuildConfig;

export function recommendedAnalysisApplicationId(analysis: ProjectSourceAnalysis) {
  if (
    analysis.recommendedApplicationId
    && analysis.applications.some((application) => application.id === analysis.recommendedApplicationId)
  ) {
    return analysis.recommendedApplicationId;
  }
  return analysis.applications[0]?.id ?? '';
}

export function analysisApplication(
  analysis: ProjectSourceAnalysis | null | undefined,
  applicationId: string,
) {
  return analysis?.applications.find((application) => application.id === applicationId) ?? null;
}

export function detectedBuildConfig(application: ProjectAnalysisApplication): DetectableBuildConfig {
  return {
    rootDirectory: application.rootDirectory === '.' ? '' : application.rootDirectory,
    buildType: application.buildType,
    dockerfilePath: 'Dockerfile',
    healthcheckPath: application.healthcheckPath || '/',
    port: application.port ? String(application.port) : application.buildType === 'static' ? '80' : '3000',
  };
}

export function mergeDetectedBuildConfig<T extends DetectableBuildConfig>(
  current: T,
  application: ProjectAnalysisApplication,
  manuallyEdited: ReadonlySet<DetectableBuildConfigField>,
): T {
  const detected = detectedBuildConfig(application);
  return {
    ...current,
    ...(!manuallyEdited.has('rootDirectory') ? { rootDirectory: detected.rootDirectory } : {}),
    ...(!manuallyEdited.has('buildType') ? { buildType: detected.buildType } : {}),
    ...(!manuallyEdited.has('dockerfilePath') ? { dockerfilePath: detected.dockerfilePath } : {}),
    ...(!manuallyEdited.has('healthcheckPath') ? { healthcheckPath: detected.healthcheckPath } : {}),
    ...(!manuallyEdited.has('port') ? { port: detected.port } : {}),
  };
}

export function missingDetectedEnvironmentKeys(
  detectedKeys: readonly string[],
  existingKeys: readonly string[],
  reservedKeys: ReadonlySet<string> = new Set(),
) {
  const existing = new Set(existingKeys.map((key) => key.trim().toUpperCase()));
  const seen = new Set<string>();
  return detectedKeys
    .map((key) => key.trim().toUpperCase())
    .filter((key) => (
      /^[A-Z_][A-Z0-9_]*$/.test(key)
      && !existing.has(key)
      && !reservedKeys.has(key)
      && !seen.has(key)
      && Boolean(seen.add(key))
    ));
}

function legacyEnvironmentRequirement(key: string): ProjectEnvironmentRequirement {
  const publicVariable = /^(?:NEXT_PUBLIC_|NUXT_PUBLIC_|PUBLIC_|REACT_APP_|VITE_)/.test(key);
  return {
    key,
    required: false,
    secret: !publicVariable && /(?:API_?KEY|ACCESS_?KEY|AUTH|CREDENTIAL|DATABASE_URL|DB_URL|PASS(?:WORD)?|PRIVATE|SECRET|TOKEN)/.test(key),
    scope: publicVariable ? 'build' : 'runtime',
    visibility: publicVariable ? 'public' : 'server',
    confidence: 'medium',
    sources: [],
  };
}

export function detectedEnvironmentRequirements(
  application: ProjectAnalysisApplication | null | undefined,
): ProjectEnvironmentRequirement[] {
  const requirements = application?.environmentRequirements;
  if (Array.isArray(requirements)) {
    return requirements.filter((requirement) => (
      /^[A-Z_][A-Z0-9_]*$/.test(requirement.key)
      && (requirement.confidence === 'high' || requirement.confidence === 'medium')
      && (requirement.visibility === 'server' || requirement.visibility === 'public')
      && Array.isArray(requirement.sources)
    ));
  }
  return (application?.environmentKeys ?? []).map(legacyEnvironmentRequirement);
}

export class AnalysisRequestCoordinator {
  private version = 0;
  private controller: AbortController | null = null;

  begin() {
    this.controller?.abort();
    this.version += 1;
    this.controller = new AbortController();
    return { version: this.version, signal: this.controller.signal };
  }

  isCurrent(version: number) {
    return version === this.version && !this.controller?.signal.aborted;
  }

  cancel() {
    this.controller?.abort();
    this.controller = null;
    this.version += 1;
  }
}
