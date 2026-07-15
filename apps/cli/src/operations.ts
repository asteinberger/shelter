import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { ShelterClient } from "./api.js";
import type { Deployment, DeploymentLog, Project } from "./types.js";

const terminalStatuses = new Set(["ready", "failed", "cancelled"]);

export function isTerminalStatus(status: string): boolean {
  return terminalStatuses.has(status);
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForDeployment(
  client: ShelterClient,
  deploymentId: string,
  onStatus?: (deployment: Deployment) => void,
  intervalMilliseconds = 1_000
): Promise<Deployment> {
  let previousStatus: string | undefined;
  for (;;) {
    const { deployment } = await client.request<{ deployment: Deployment }>(`/api/deployments/${encodeURIComponent(deploymentId)}`);
    if (deployment.status !== previousStatus) {
      onStatus?.(deployment);
      previousStatus = deployment.status;
    }
    if (isTerminalStatus(deployment.status)) return deployment;
    await pause(intervalMilliseconds);
  }
}

export async function followDeploymentLogs(
  client: ShelterClient,
  deploymentId: string,
  onLogs: (logs: DeploymentLog[]) => void,
  onComplete?: (status: string) => void,
  intervalMilliseconds = 750
): Promise<string> {
  let cursor = 0;
  for (;;) {
    const response = await client.request<{ logs: DeploymentLog[]; status: string }>(
      `/api/deployments/${encodeURIComponent(deploymentId)}/logs?after=${cursor}`
    );
    if (response.logs.length > 0) {
      cursor = Math.max(cursor, ...response.logs.map((log) => log.id));
      onLogs(response.logs);
    }
    if (isTerminalStatus(response.status) && response.logs.length === 0) {
      onComplete?.(response.status);
      return response.status;
    }
    await pause(intervalMilliseconds);
  }
}

export interface UploadResult {
  project: Project;
  deployment: Deployment;
}

export async function uploadArchive(
  client: ShelterClient,
  projectId: string,
  archivePath: string,
  onProgress?: (uploadedChunks: number, totalChunks: number) => void
): Promise<UploadResult> {
  const file = await stat(archivePath).catch(() => null);
  if (!file?.isFile()) throw new Error(`ZIP archive not found: ${archivePath}`);
  if (file.size <= 0) throw new Error("The ZIP archive is empty.");
  if (!archivePath.toLowerCase().endsWith(".zip")) throw new Error("Shelter source uploads must be ZIP archives.");

  const allocation = await client.request<{
    uploadId: string;
    chunkSize: number;
    totalChunks: number;
  }>("/api/uploads", {
    method: "POST",
    body: { filename: basename(archivePath), size: file.size }
  });

  let attached = false;
  try {
    const handle = await open(archivePath, "r");
    try {
      for (let index = 0; index < allocation.totalChunks; index += 1) {
        const offset = index * allocation.chunkSize;
        const expected = Math.min(allocation.chunkSize, file.size - offset);
        const buffer = Buffer.allocUnsafe(expected);
        let bytesRead = 0;
        while (bytesRead < expected) {
          const result = await handle.read(buffer, bytesRead, expected - bytesRead, offset + bytesRead);
          if (result.bytesRead === 0) throw new Error("The ZIP archive ended before all chunks were read.");
          bytesRead += result.bytesRead;
        }
        await client.request<{ ok: true }>(
          `/api/uploads/${encodeURIComponent(allocation.uploadId)}/chunks/${index}`,
          {
            method: "PUT",
            headers: {
              "content-type": "application/octet-stream",
              "x-chunk-count": String(allocation.totalChunks)
            },
            body: buffer
          }
        );
        onProgress?.(index + 1, allocation.totalChunks);
      }
    } finally {
      await handle.close();
    }

    await client.request(`/api/uploads/${encodeURIComponent(allocation.uploadId)}/complete`, { method: "POST" });
    const result = await client.request<UploadResult>(
      `/api/projects/${encodeURIComponent(projectId)}/source`,
      { method: "PUT", body: { uploadId: allocation.uploadId } }
    );
    attached = true;
    return result;
  } catch (error) {
    if (!attached) {
      await client.request(`/api/uploads/${encodeURIComponent(allocation.uploadId)}`, { method: "DELETE" })
        .catch(() => undefined);
    }
    throw error;
  }
}
