import { describe, expect, it } from 'vitest';
import type { Deployment, Project } from '../types';
import {
  canRequestDeploymentCancellation,
  canRollbackToDeployment,
  configuredGitBranch,
  deploymentAutomaticRecovery,
  deploymentFailureKind,
  deploymentRefetchInterval,
  withQueuedDeployment,
} from './deployment';

const project: Project = {
  id: 'prj_1',
  name: 'Website',
  status: 'live',
  sourceType: 'git',
  branch: 'legacy',
  repositoryBranch: 'release',
  deployments: [{ id: 'dep_old', status: 'ready' }],
};

describe('manual Git deployments', () => {
  it('uses the saved GitHub branch before legacy project branch fields', () => {
    expect(configuredGitBranch({
      ...project,
      github: {
        installationId: '12',
        repositoryId: '34',
        fullName: 'raum/website',
        branch: 'production',
        autoDeploy: false,
      },
    })).toBe('production');
    expect(configuredGitBranch(project)).toBe('release');
    expect(configuredGitBranch({ ...project, repositoryBranch: undefined, branch: undefined })).toBe('main');
  });

  it('shows a queued manual deployment immediately without duplicating it', () => {
    const queued: Deployment = {
      id: 'dep_new',
      projectId: project.id,
      status: 'queued',
      sourceRef: 'release',
      trigger: 'manual',
    };

    const updated = withQueuedDeployment({
      ...project,
      deployments: [queued, ...(project.deployments ?? [])],
    }, queued);

    expect(updated.status).toBe('deploying');
    expect(updated.currentDeployment).toEqual(queued);
    expect(updated.deployments?.map((deployment) => deployment.id)).toEqual(['dep_new', 'dep_old']);
  });
});

describe('deployment safety', () => {
  it('only allows cancellation before traffic switching begins', () => {
    for (const status of ['queued', 'preparing', 'building', 'checking']) {
      expect(canRequestDeploymentCancellation({ id: `dep_${status}`, status })).toBe(true);
    }
    for (const status of ['switching', 'ready', 'failed', 'cancelled']) {
      expect(canRequestDeploymentCancellation({ id: `dep_${status}`, status })).toBe(false);
    }
    expect(canRequestDeploymentCancellation({
      id: 'dep_requested',
      status: 'building',
      cancelRequestedAt: '2026-07-14T18:00:00.000Z',
    })).toBe(false);
  });

  it('keeps polling while a running cancellation request is being processed', () => {
    expect(deploymentRefetchInterval({
      id: 'dep_requested',
      status: 'checking',
      cancelRequestedAt: '2026-07-14T18:00:00.000Z',
    })).toBe(4_000);
    expect(deploymentRefetchInterval({ id: 'dep_done', status: 'cancelled' })).toBe(false);
  });

  it('normalizes structured failure and automatic recovery metadata', () => {
    expect(deploymentFailureKind({ id: 'dep_timeout', status: 'failed', failureCode: 'build_timeout' })).toBe('timeout');
    expect(deploymentFailureKind({ id: 'dep_health', status: 'failed', failureKind: 'healthcheck' })).toBe('healthcheck');
    expect(deploymentAutomaticRecovery({
      id: 'dep_health',
      status: 'failed',
      rollbackStatus: 'automatic_succeeded',
      rollbackDeploymentId: 'dep_previous',
    })).toEqual({ status: 'succeeded', deploymentId: 'dep_previous' });
    expect(deploymentAutomaticRecovery({
      id: 'dep_alias',
      status: 'failed',
      automaticRollback: true,
      recoveryDeploymentId: 'dep_previous_alias',
    })).toEqual({ status: 'succeeded', deploymentId: 'dep_previous_alias' });
  });

  it('only offers rollback for an earlier ready version', () => {
    const currentProject = { ...project, activeDeploymentId: 'dep_live' };
    expect(canRollbackToDeployment({ id: 'dep_old', status: 'ready' }, currentProject)).toBe(true);
    expect(canRollbackToDeployment({ id: 'dep_live', status: 'ready' }, currentProject)).toBe(false);
    expect(canRollbackToDeployment({ id: 'dep_failed', status: 'failed' }, currentProject)).toBe(false);
  });

  it('never offers rollback while project deletion or failed cleanup is recorded', () => {
    const ready = { id: 'dep_old', status: 'ready' } satisfies Deployment;
    const currentProject = { ...project, activeDeploymentId: 'dep_live' };

    for (const deletionStatus of ['queued', 'preparing', 'running', 'failed']) {
      expect(canRollbackToDeployment(ready, { ...currentProject, deletionStatus })).toBe(false);
    }
    expect(canRollbackToDeployment(ready, {
      ...currentProject,
      status: 'deletion_failed',
      deletionStatus: null,
    })).toBe(false);
  });
});
