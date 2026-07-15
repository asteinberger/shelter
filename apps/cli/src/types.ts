export type DeploymentStatus =
  | "queued"
  | "preparing"
  | "building"
  | "checking"
  | "switching"
  | "ready"
  | "failed"
  | "cancelled";

export interface Domain {
  id: string;
  hostname: string;
  status: "pending" | "active" | "error";
  error: string | null;
}

export interface Deployment {
  id: string;
  projectId: string;
  status: DeploymentStatus;
  sourceRef: string | null;
  runtimeKind: string | null;
  runtimeDescription: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  commitUrl: string | null;
  trigger: string;
  error: string | null;
  failureKind: "timeout" | "cancelled" | "build" | "healthcheck" | "activation" | "worker" | "superseded" | null;
  rollbackStatus: "not_required" | "automatic_succeeded" | "automatic_failed";
  rollbackDeploymentId: string | null;
  cancelRequestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  durationSeconds: number | null;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  status: string;
  sourceType: "git" | "upload";
  repositoryUrl: string | null;
  repositoryBranch: string | null;
  buildType: string;
  rootDirectory: string;
  staticBasePath: string | null;
  activeDeploymentId: string | null;
  createdAt: string;
  updatedAt: string;
  domains?: Domain[];
  deployments?: Deployment[];
  currentDeployment?: Deployment | null;
}

export interface DeploymentLog {
  id: number;
  stream: "system" | "stdout" | "stderr";
  message: string;
  createdAt: string;
}

export interface TokenIdentity {
  authentication: {
    type: "api_token" | "session";
    token?: {
      id: string;
      name: string;
      scopes: string[];
    };
  };
  user: { id: string; email: string } | null;
}
