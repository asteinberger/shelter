import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import {
  projectRuntimeKind,
  projectRuntimeSearchTerms,
  usesManagedFileStorageRuntime,
} from './project-runtime';

describe('projectRuntimeKind', () => {
  it('prefers the active deployment while a newer version is queued', () => {
    const project: Project = {
      id: 'prj_files',
      name: 'Assets',
      status: 'deploying',
      activeDeploymentId: 'dep_active',
      currentDeployment: { id: 'dep_queued', status: 'queued', runtimeKind: null },
      deployments: [
        { id: 'dep_queued', status: 'queued', runtimeKind: null },
        { id: 'dep_active', status: 'ready', runtimeKind: 'files' },
      ],
    };

    expect(projectRuntimeKind(project)).toBe('files');
  });

  it('uses the current deployment when it is active', () => {
    const project: Project = {
      id: 'prj_static',
      name: 'Site',
      status: 'live',
      activeDeploymentId: 'dep_active',
      currentDeployment: { id: 'dep_active', status: 'ready', runtimeKind: 'static' },
    };

    expect(projectRuntimeKind(project)).toBe('static');
  });

  it('exposes localized search terms for file storage', () => {
    const project: Project = {
      id: 'prj_files',
      name: 'Assets',
      status: 'live',
      activeDeploymentId: 'dep_files',
      currentDeployment: { id: 'dep_files', status: 'ready', runtimeKind: 'files' },
    };

    expect(projectRuntimeSearchTerms(project)).toEqual([
      'files',
      'file storage',
      'dateiablage',
      'dateien',
    ]);
  });

  it('uses managed settings only while a file storage keeps auto or static detection', () => {
    const project: Project = {
      id: 'prj_files',
      name: 'Assets',
      status: 'live',
      activeDeploymentId: 'dep_files',
      currentDeployment: { id: 'dep_files', status: 'ready', runtimeKind: 'files' },
    };

    expect(usesManagedFileStorageRuntime(project, 'auto')).toBe(true);
    expect(usesManagedFileStorageRuntime(project, 'static')).toBe(true);
    expect(usesManagedFileStorageRuntime(project, 'node')).toBe(false);
    expect(usesManagedFileStorageRuntime(project, 'dockerfile')).toBe(false);

    expect(usesManagedFileStorageRuntime({
      ...project,
      currentDeployment: { id: 'dep_files', status: 'ready', runtimeKind: 'static' },
    }, 'auto')).toBe(false);
  });
});
