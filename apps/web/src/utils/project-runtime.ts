import type { Deployment, Project } from '../types';

export type ProjectRuntimeKind = NonNullable<Deployment['runtimeKind']>;

export function projectRuntimeKind(project: Project): ProjectRuntimeKind | null {
  const activeDeployment = project.deployments?.find((deployment) => deployment.id === project.activeDeploymentId);
  if (activeDeployment?.runtimeKind) return activeDeployment.runtimeKind;
  if (
    project.currentDeployment?.runtimeKind
    && (!project.activeDeploymentId || project.currentDeployment.id === project.activeDeploymentId)
  ) return project.currentDeployment.runtimeKind;
  return null;
}

export function isFileStorageProject(project: Project): boolean {
  return projectRuntimeKind(project) === 'files';
}

export function usesManagedFileStorageRuntime(
  project: Project,
  selectedBuildType: Project['buildType'],
): boolean {
  return isFileStorageProject(project)
    && (selectedBuildType === 'auto' || selectedBuildType === 'static');
}

export function projectRuntimeSearchTerms(project: Project): string[] {
  const runtimeKind = projectRuntimeKind(project);
  if (runtimeKind === 'files') {
    return ['files', 'file storage', 'dateiablage', 'dateien'];
  }
  return runtimeKind ? [runtimeKind] : [];
}
