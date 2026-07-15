import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { resolveWithin } from "../lib/security.js";
import type { PublicProjectPreview } from "../types/models.js";
import {
  captureProjectContainerPreview,
  type ProjectRuntimeHelperCommandRunner
} from "./project-runtime-helper.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const MAX_PROJECT_PREVIEW_BYTES = 10 * 1024 * 1024;

type PreviewConfig = Pick<AppConfig, "DATA_DIR" | "CHROMIUM_PATH">;

export interface ProjectPreviewMetadata {
  projectId: string;
  deploymentId: string;
  status: "ready" | "unavailable";
  reason?: "not_html" | "capture_failed";
  capturedAt: string;
}

interface CaptureDependencies {
  command?: ProjectRuntimeHelperCommandRunner;
}

function assertManagedId(id: string, kind: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    throw new Error(`${kind}-ID ist nicht sicher verwaltet`);
  }
}

function previewDirectory(config: PreviewConfig): string {
  return resolveWithin(config.DATA_DIR, "previews");
}

export function projectPreviewImagePath(config: PreviewConfig, projectId: string): string {
  assertManagedId(projectId, "Projekt");
  return resolveWithin(previewDirectory(config), `${projectId}.png`);
}

export function projectPreviewMetadataPath(config: PreviewConfig, projectId: string): string {
  assertManagedId(projectId, "Projekt");
  return resolveWithin(previewDirectory(config), `${projectId}.json`);
}

function validMetadata(value: unknown, projectId: string): value is ProjectPreviewMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Partial<ProjectPreviewMetadata>;
  return metadata.projectId === projectId
    && typeof metadata.deploymentId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(metadata.deploymentId)
    && (metadata.status === "ready" || metadata.status === "unavailable")
    && typeof metadata.capturedAt === "string"
    && Number.isFinite(Date.parse(metadata.capturedAt))
    && (metadata.reason === undefined || metadata.reason === "not_html" || metadata.reason === "capture_failed");
}

function readMetadata(config: PreviewConfig, projectId: string): ProjectPreviewMetadata | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(projectPreviewMetadataPath(config, projectId), "utf8"));
    return validMetadata(parsed, projectId) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function projectPreviewState(
  config: PreviewConfig,
  projectId: string,
  activeDeploymentId: string | null
): PublicProjectPreview | undefined {
  if (!activeDeploymentId) return undefined;
  const metadata = readMetadata(config, projectId);
  if (!metadata || metadata.deploymentId !== activeDeploymentId) {
    return { status: "pending", deploymentId: activeDeploymentId };
  }
  if (metadata.status === "unavailable") {
    return {
      status: "unavailable",
      deploymentId: activeDeploymentId,
      reason: metadata.reason ?? "capture_failed",
      capturedAt: metadata.capturedAt
    };
  }
  try {
    const stat = fs.statSync(projectPreviewImagePath(config, projectId));
    if (!stat.isFile() || stat.size < PNG_SIGNATURE.length || stat.size > MAX_PROJECT_PREVIEW_BYTES) {
      return { status: "pending", deploymentId: activeDeploymentId };
    }
  } catch {
    return { status: "pending", deploymentId: activeDeploymentId };
  }
  return {
    status: "ready",
    deploymentId: activeDeploymentId,
    capturedAt: metadata.capturedAt,
    imageUrl: `/api/projects/${encodeURIComponent(projectId)}/preview?deployment=${encodeURIComponent(activeDeploymentId)}`
  };
}

async function writeMetadata(config: PreviewConfig, metadata: ProjectPreviewMetadata): Promise<void> {
  const directory = previewDirectory(config);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolveWithin(directory, `.${metadata.projectId}.${randomUUID()}.json`);
  try {
    await fs.promises.writeFile(temporary, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    await fs.promises.rename(temporary, projectPreviewMetadataPath(config, metadata.projectId));
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

async function markUnavailable(
  config: PreviewConfig,
  projectId: string,
  deploymentId: string,
  reason: "not_html" | "capture_failed"
): Promise<ProjectPreviewMetadata> {
  await fs.promises.rm(projectPreviewImagePath(config, projectId), { force: true });
  const metadata: ProjectPreviewMetadata = {
    projectId,
    deploymentId,
    status: "unavailable",
    reason,
    capturedAt: new Date().toISOString()
  };
  await writeMetadata(config, metadata);
  return metadata;
}

export async function captureProjectPreview(
  config: PreviewConfig,
  input: {
    projectId: string;
    deploymentId: string;
    url: string;
    networkName: string;
    helperImage: string;
  },
  dependencies: CaptureDependencies = {}
): Promise<ProjectPreviewMetadata> {
  assertManagedId(input.projectId, "Projekt");
  assertManagedId(input.deploymentId, "Deployment");
  const target = new URL(input.url);
  if (target.protocol !== "http:" || !target.hostname || target.username || target.password) {
    throw new Error("Projektvorschauen dürfen nur interne HTTP-Ziele ohne Zugangsdaten verwenden");
  }
  const directory = previewDirectory(config);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const temporaryImage = resolveWithin(directory, `.${input.projectId}.${token}.png`);
  try {
    const capture = await captureProjectContainerPreview({
      projectId: input.projectId,
      deploymentId: input.deploymentId,
      networkName: input.networkName,
      targetContainer: target.hostname,
      port: target.port ? Number.parseInt(target.port, 10) : 80,
      path: `${target.pathname}${target.search}`,
      helperImage: input.helperImage,
      outputPath: temporaryImage,
      chromiumPath: config.CHROMIUM_PATH
    }, dependencies.command);
    if (capture === "not_html") {
      return markUnavailable(config, input.projectId, input.deploymentId, "not_html");
    }
    if (capture !== "ready") {
      return markUnavailable(config, input.projectId, input.deploymentId, "capture_failed");
    }

    const stat = await fs.promises.stat(temporaryImage);
    if (!stat.isFile() || stat.size > MAX_PROJECT_PREVIEW_BYTES) {
      throw new Error("Preview-Helper hat keine zulässige Datei erzeugt");
    }
    // The helper already verifies size and signature before returning. Repeat
    // the small signature check across the Docker copy boundary before publish.
    const file = await fs.promises.open(temporaryImage, "r");
    try {
      const signature = Buffer.alloc(PNG_SIGNATURE.length);
      const { bytesRead } = await file.read(signature, 0, signature.length, 0);
      if (bytesRead !== PNG_SIGNATURE.length || !signature.equals(PNG_SIGNATURE)) {
        throw new Error("Preview-Helper hat keine gültige PNG-Vorschau erzeugt");
      }
    } finally {
      await file.close();
    }
    await fs.promises.chmod(temporaryImage, 0o600);
    await fs.promises.rename(temporaryImage, projectPreviewImagePath(config, input.projectId));
    const metadata: ProjectPreviewMetadata = {
      projectId: input.projectId,
      deploymentId: input.deploymentId,
      status: "ready",
      capturedAt: new Date().toISOString()
    };
    await writeMetadata(config, metadata);
    return metadata;
  } catch {
    return markUnavailable(config, input.projectId, input.deploymentId, "capture_failed");
  } finally {
    await fs.promises.rm(temporaryImage, { force: true });
  }
}

export async function removeProjectPreview(config: PreviewConfig, projectId: string): Promise<void> {
  await Promise.all([
    fs.promises.rm(projectPreviewImagePath(config, projectId), { force: true }),
    fs.promises.rm(projectPreviewMetadataPath(config, projectId), { force: true })
  ]);
}
