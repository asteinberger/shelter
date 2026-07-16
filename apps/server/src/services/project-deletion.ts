import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { CommandOptions, CommandResult } from "../lib/command.js";
import { runCommand } from "../lib/command.js";
import type { Database } from "../lib/database.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { resolveWithin } from "../lib/security.js";
import type { DeploymentRow, ProjectRow } from "../types/models.js";
import type { CloudflareService } from "./cloudflare.js";
import { removeProjectPreview } from "./project-preview.js";
import { removeProjectNetwork } from "./project-network.js";
import { reconcileRouting } from "./routing.js";
import {
  deploymentContainerNames,
  isManagedImage,
  isManagedVersionedRuntimeName,
  managedProjectIdForContainer,
  MANAGED_LABEL_NAMESPACES
} from "./runtime-identity.js";

type CloudflareDnsDeletion = Pick<CloudflareService, "deleteDnsRecord">;
export type ProjectDeletionCommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions
) => Promise<CommandResult>;

interface UploadRow {
  id: string;
  archive_path: string | null;
}

export class ProjectDeletionService {
  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
    private readonly cloudflare: CloudflareDnsDeletion
  ) {
    this.database.recoverPreparingProjectDeletions();
  }

  async request(projectId: string, confirmation: string): Promise<{ status: "queued" | "running" }> {
    const prepared = this.database.prepareProjectDeletion(projectId, confirmation);
    if (prepared.kind === "not_found") throw notFound("Projekt nicht gefunden");
    if (prepared.kind === "confirmation_mismatch") {
      throw badRequest("Der Projektname zur Bestätigung stimmt nicht überein", "PROJECT_CONFIRMATION_MISMATCH");
    }
    if (prepared.kind === "deployment_active") {
      throw conflict("Ein laufendes Deployment muss zuerst abgeschlossen werden", "DEPLOYMENT_ACTIVE");
    }
    if (prepared.kind === "domain_pending") {
      throw conflict("Eine Domain wird gerade eingerichtet oder gelöscht", "DOMAIN_MUTATION_ACTIVE");
    }
    if (prepared.kind === "preparing") {
      throw conflict("Die Projektlöschung wird bereits vorbereitet", "PROJECT_DELETION_ACTIVE");
    }
    if (prepared.kind === "pending") return { status: prepared.status };

    try {
      // Hiding the project from generated routing happens before any destructive
      // worker cleanup, so no new requests are sent to a container being removed.
      reconcileRouting(this.config, this.database);
      for (const preview of this.database.listPullRequestPreviews(projectId)) {
        this.database.requestPullRequestPreviewClose(projectId, preview.id);
        if (preview.zone_id || preview.dns_record_id) {
          await this.cloudflare.deleteDnsRecord(preview.zone_id, preview.dns_record_id, preview.hostname);
          this.database.clearPullRequestPreviewDns(preview.id, preview.dns_record_id);
        }
        this.database.closePullRequestPreview(preview.id);
      }
      for (const domain of this.database.listDomains(projectId)) {
        // CloudflareService verifies that the record still targets this Shelter
        // tunnel. A drifted/foreign record is deliberately left untouched.
        await this.cloudflare.deleteDnsRecord(domain.zone_id, domain.dns_record_id, domain.hostname);
        this.database.deleteDomain(domain.id);
      }
      reconcileRouting(this.config, this.database);
      if (!this.database.queueProjectDeletion(projectId)) {
        throw new Error("Projektlöschung konnte nicht an den Worker übergeben werden");
      }
      return { status: "queued" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Projektlöschung konnte nicht vorbereitet werden";
      this.database.failProjectDeletion(projectId, message);
      // A failed request remains visible/recoverable in the panel.
      try {
        reconcileRouting(this.config, this.database);
      } catch {
        // Preserve the actionable Cloudflare/routing error that caused failure.
      }
      throw error;
    }
  }
}

export class ProjectDeletionWorker {
  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
    private readonly command: ProjectDeletionCommandRunner = runCommand
  ) {}

  recoverInterrupted(): void {
    // Container/file deletion is idempotent. A worker restart can therefore
    // safely continue a job it previously claimed.
    this.database.requeueRunningProjectDeletions();
  }

  async processNext(): Promise<boolean> {
    const deletion = this.database.claimNextProjectDeletion();
    if (!deletion) return false;
    try {
      await this.process(deletion.project_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Projektressourcen konnten nicht gelöscht werden";
      this.database.failProjectDeletion(deletion.project_id, message);
      try {
        reconcileRouting(this.config, this.database);
      } catch {
        // Preserve the original cleanup failure for an explicit retry.
      }
    }
    return true;
  }

  private async process(projectId: string): Promise<void> {
    assertManagedId(projectId, "Projekt");
    const project = this.database.getProjectForDeletion(projectId);
    if (!project) return;
    const deployments = this.database.sqlite.prepare(
      "SELECT * FROM deployments WHERE project_id = ? ORDER BY created_at DESC"
    ).all(projectId) as DeploymentRow[];

    await this.removeProjectContainers(project, deployments);
    await this.removeProjectImages(deployments);
    await this.removeWorkspaces(deployments);
    await removeProjectPreview(this.config, projectId);
    await removeProjectNetwork(projectId, this.command);

    // The project is excluded from listProjects while a deletion row exists.
    // Reconcile once more before the project row and its metadata are removed.
    reconcileRouting(this.config, this.database);
    const finalize = this.database.sqlite.transaction(() => {
      this.removeExclusiveUploadSources(project, deployments);
      this.database.deleteProject(projectId);
    });
    // Hold the SQLite writer lock while checking references and unlinking the
    // archive. An upload cannot be consumed into another project in between.
    finalize.immediate();
  }

  private async removeProjectContainers(project: ProjectRow, deployments: DeploymentRow[]): Promise<void> {
    const containerCandidates = new Set<string>();
    const runtimeNames = new Set<string>();
    for (const namespace of MANAGED_LABEL_NAMESPACES) {
      const result = await this.command("docker", [
        "ps", "-aq",
        "--filter", `label=${namespace}.managed=true`,
        "--filter", `label=${namespace}.project=${project.id}`
      ]);
      for (const id of parseDockerIds(result.stdout, "Container")) containerCandidates.add(id);
    }
    const containerIds = new Set<string>();
    for (const id of containerCandidates) {
      const identity = await this.inspectContainerIdentity(id);
      if (managedProjectIdForContainer(identity.labels, identity.name, identity.image) !== project.id) continue;
      containerIds.add(id);
    }
    for (const deployment of deployments) {
      if (!deployment.runtime_container) continue;
      for (const name of deploymentContainerNames(project.slug, deployment.id, deployment.runtime_container)) {
        if (isManagedVersionedRuntimeName(name)) runtimeNames.add(name);
      }
    }
    for (const id of containerIds) {
      await this.command("docker", ["rm", "-f", "-v", id]);
    }
    // A labelled lookup normally removed these already. The persisted name is
    // a recovery fallback for a Docker daemon whose label index is incomplete.
    for (const name of runtimeNames) {
      await this.command("docker", ["rm", "-f", "-v", name], { allowFailure: true });
    }
  }

  private async removeProjectImages(deployments: DeploymentRow[]): Promise<void> {
    const imageIds = new Set<string>();
    for (const deployment of deployments) {
      assertManagedId(deployment.id, "Deployment");
      if (!deployment.image_tag || !isManagedImage(deployment.image_tag)) continue;
      const result = await this.command("docker", [
        "image", "inspect", "--format", "{{.Id}}", deployment.image_tag
      ], { allowFailure: true });
      if (result.exitCode !== 0) {
        const detail = `${result.stderr}\n${result.stdout}`.trim();
        if (/\bno such image\b/i.test(detail)) continue;
        throw new Error(
          `Image ${deployment.image_tag} konnte vor dem Löschen nicht verifiziert werden: ${detail || `Exit ${result.exitCode}`}`
        );
      }
      for (const id of parseDockerIds(result.stdout, "Image")) imageIds.add(id);
    }
    for (const id of imageIds) await this.command("docker", ["image", "rm", id]);
  }

  private async inspectContainerIdentity(id: string): Promise<{
    name: string;
    image: string;
    labels: Record<string, unknown>;
  }> {
    const result = await this.command("docker", [
      "inspect", "--type", "container", "--format",
      '{"name":{{json .Name}},"image":{{json .Config.Image}},"labels":{{json .Config.Labels}}}', id
    ], { allowFailure: true });
    if (result.exitCode !== 0) {
      throw new Error(`Container ${id} konnte vor dem Löschen nicht verifiziert werden: ${result.stderr || `Exit ${result.exitCode}`}`);
    }
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid identity");
      const identity = parsed as Record<string, unknown>;
      if (
        typeof identity.name !== "string"
        || typeof identity.image !== "string"
        || !identity.labels
        || typeof identity.labels !== "object"
        || Array.isArray(identity.labels)
      ) throw new Error("incomplete identity");
      return {
        name: identity.name,
        image: identity.image,
        labels: identity.labels as Record<string, unknown>
      };
    } catch {
      throw new Error(`Container ${id} hat eine ungültige Docker-Identität`);
    }
  }

  private async removeWorkspaces(deployments: DeploymentRow[]): Promise<void> {
    for (const deployment of deployments) {
      assertManagedId(deployment.id, "Deployment");
      const workspace = resolveWithin(this.config.workspacesDir, deployment.id);
      await fs.promises.rm(workspace, { recursive: true, force: true });
    }
  }

  private removeExclusiveUploadSources(project: ProjectRow, deployments: DeploymentRow[]): void {
    const candidates = new Map<string, string>();
    if (project.source_archive) {
      const current = this.database.sqlite.prepare(
        "SELECT id, archive_path FROM uploads WHERE archive_path = ?"
      ).get(project.source_archive) as UploadRow | undefined;
      if (current?.archive_path) {
        candidates.set(current.id, current.archive_path);
      } else {
        const relative = path.relative(path.resolve(this.config.sourcesDir), path.resolve(project.source_archive));
        const uploadId = relative.split(path.sep)[0];
        if (uploadId) candidates.set(uploadId, project.source_archive);
      }
    }
    for (const deployment of deployments) {
      if (!deployment.source_ref) continue;
      const upload = this.database.sqlite.prepare(
        "SELECT id, archive_path FROM uploads WHERE id = ? AND archive_path IS NOT NULL"
      ).get(deployment.source_ref) as UploadRow | undefined;
      if (upload?.archive_path) candidates.set(upload.id, upload.archive_path);
    }

    for (const [uploadId, archivePath] of candidates) {
      const shared = this.database.sqlite.prepare(`
        SELECT 1 FROM projects WHERE id <> ? AND source_archive = ?
        UNION ALL
        SELECT 1 FROM deployments WHERE project_id <> ? AND source_ref = ?
        LIMIT 1
      `).get(project.id, archivePath, project.id, uploadId);
      if (shared) continue;
      this.removeManagedUpload(uploadId, archivePath);
    }
  }

  private removeManagedUpload(uploadId: string, archivePath: string): void {
    const sourceRoot = path.resolve(this.config.sourcesDir);
    const archive = path.resolve(archivePath);
    const relative = path.relative(sourceRoot, archive);
    const segments = relative.split(path.sep);
    if (relative.startsWith("..") || path.isAbsolute(relative) || segments.length !== 2 || segments[1] !== "source.zip") {
      throw new Error("Quellarchiv liegt nicht in einem verwalteten Upload-Verzeichnis");
    }
    if (segments[0] !== uploadId) throw new Error("Upload-ID passt nicht zum Quellarchiv");
    assertManagedId(uploadId, "Upload");
    const expectedArchive = resolveWithin(sourceRoot, path.join(uploadId, "source.zip"));
    if (archive !== expectedArchive) throw new Error("Quellarchiv-Pfad ist nicht eindeutig verwaltet");

    const upload = this.database.sqlite.prepare(
      "SELECT id, archive_path FROM uploads WHERE id = ?"
    ).get(uploadId) as UploadRow | undefined;
    if (upload && upload.id !== uploadId) throw new Error("Upload-Metadaten passen nicht zum Quellarchiv");
    if (upload?.archive_path && path.resolve(upload.archive_path) !== expectedArchive) {
      throw new Error("Upload-Metadaten verweisen auf ein anderes Quellarchiv");
    }

    fs.rmSync(resolveWithin(sourceRoot, uploadId), { recursive: true, force: true });
    fs.rmSync(resolveWithin(sourceRoot, path.join(".chunks", uploadId)), { recursive: true, force: true });
    if (upload) this.database.sqlite.prepare("DELETE FROM uploads WHERE id = ?").run(upload.id);
  }
}

function assertManagedId(id: string, kind: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    throw new Error(`${kind}-ID ist nicht sicher verwaltet`);
  }
}

function parseDockerIds(output: string, kind: string): string[] {
  const ids = output.split("\n").map((value) => value.trim()).filter(Boolean);
  for (const id of ids) {
    if (!/^(?:sha256:)?[a-f0-9]{12,64}$/i.test(id)) {
      throw new Error(`${kind}-Liste enthält eine ungültige Docker-ID`);
    }
  }
  return [...new Set(ids)];
}
