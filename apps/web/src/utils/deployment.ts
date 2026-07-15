import type { Deployment, DeploymentFailureKind, Project } from '../types';
import { localize } from '../i18n';

export const activeDeploymentStates = new Set([
  'queued',
  'preparing',
  'building',
  'checking',
  'switching',
  'deploying',
  'running',
]);

export const cancellableDeploymentStates = new Set([
  'queued',
  'preparing',
  'building',
  'checking',
  // Kept for compatibility with older API responses. Traffic switching is
  // intentionally excluded because cancellation is no longer safe then.
  'deploying',
  'running',
]);

const failureCodeKinds: Record<string, DeploymentFailureKind> = {
  build_timeout: 'timeout',
  timeout: 'timeout',
  cancelled_by_user: 'cancelled',
  cancelled: 'cancelled',
  build_failed: 'build',
  healthcheck_failed: 'healthcheck',
  activation_failed: 'activation',
  worker_failed: 'worker',
  worker_offline: 'worker',
  superseded: 'superseded',
};

export function deploymentFailureKind(deployment: Deployment): DeploymentFailureKind | null {
  if (deployment.failureKind) return deployment.failureKind;
  const code = deployment.failureCode ?? deployment.errorCode;
  return code ? failureCodeKinds[code] ?? code : null;
}

export function deploymentAutomaticRecovery(deployment: Deployment): {
  status: 'succeeded' | 'failed' | null;
  deploymentId: string | null;
} {
  const deploymentId = deployment.recoveryDeploymentId ?? deployment.rollbackDeploymentId ?? null;
  if (deployment.rollbackStatus === 'automatic_succeeded' || deployment.automaticRollback === true) {
    return { status: 'succeeded', deploymentId };
  }
  if (deployment.rollbackStatus === 'automatic_failed') {
    return { status: 'failed', deploymentId };
  }
  return { status: null, deploymentId };
}

export function canRequestDeploymentCancellation(deployment?: Deployment | null): boolean {
  return Boolean(
    deployment
    && !deployment.cancelRequestedAt
    && cancellableDeploymentStates.has(deployment.status),
  );
}

export function deploymentRefetchInterval(deployment?: Deployment | null): number | false {
  return deployment && activeDeploymentStates.has(deployment.status) ? 4_000 : false;
}

export function canRollbackToDeployment(deployment: Deployment, project: Project): boolean {
  const deletionScheduled = Boolean(project.deletionStatus) || project.status === 'deletion_failed';
  return !deletionScheduled
    && deployment.status === 'ready'
    && project.activeDeploymentId !== deployment.id;
}

export function configuredGitBranch(project: Project) {
  return project.github?.branch?.trim()
    || project.repositoryBranch?.trim()
    || project.branch?.trim()
    || 'main';
}

export function withQueuedDeployment(project: Project, deployment: Deployment): Project {
  return {
    ...project,
    status: 'deploying',
    currentDeployment: deployment,
    deployments: [
      deployment,
      ...(project.deployments ?? []).filter((candidate) => candidate.id !== deployment.id),
    ],
  };
}

export function deploymentSourceLabel(deployment: Deployment, project: Project) {
  if (deployment.sourceRef?.startsWith('rollback:')) {
    return `Rollback · ${deployment.sourceRef.slice('rollback:'.length, 'rollback:'.length + 8)}`;
  }
  if (project.sourceType === 'git') {
    return localize(
      'Branch {branch}',
      'Branch {branch}',
      { branch: deployment.sourceRef ?? configuredGitBranch(project) },
    );
  }
  if (deployment.sourceRef) return localize('Upload · {ref}', 'Upload · {ref}', { ref: deployment.sourceRef.slice(0, 12) });
  return localize('Direct upload', 'Direkt-Upload');
}
