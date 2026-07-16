import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { decryptString, encryptString, newId, validEnvironmentKey } from "../lib/security.js";
import { requireScopedAuth, requireScopedMutation } from "../services/auth.js";
import type { CloudflareService } from "../services/cloudflare.js";
import type { GitHubService } from "../services/github.js";
import type { PullRequestPreviewRow } from "../types/models.js";

const reservedEnvironmentKeys = new Set(["PORT", "HOSTNAME", "NODE_ENV"]);
const MAX_ENVIRONMENT_BYTES = 256 * 1024;

function presentPreview(row: PullRequestPreviewRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    pullRequestNumber: row.pull_request_number,
    headSha: row.head_sha,
    headRef: row.head_ref,
    baseRef: row.base_ref,
    generation: row.generation,
    deploymentId: row.deployment_id,
    hostname: row.hostname,
    url: row.status === "ready" ? `https://${row.hostname}` : null,
    status: row.status,
    error: row.error,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at
  };
}

export function registerPullRequestPreviewRoutes(
  app: FastifyInstance,
  config: AppConfig,
  database: Database,
  cloudflare: CloudflareService,
  github: GitHubService
): void {
  app.get<{ Params: { id: string } }>("/api/projects/:id/previews", {
    preHandler: requireScopedAuth("projects:read")
  }, async (request, reply) => {
    const project = database.getProject(request.params.id);
    if (!project) throw notFound("Projekt nicht gefunden");
    reply.header("cache-control", "no-store");
    return {
      settings: {
        enabled: project.preview_deployments_enabled === 1,
        domainId: project.preview_domain_id ?? null,
        domainSuffix: project.preview_domain_suffix ?? null,
        ttlHours: project.preview_ttl_hours ?? 72,
        maxActive: 3,
        inheritsProductionEnvironment: false
      },
      environmentKeys: database.listPreviewEnvironment(project.id).map((row) => row.key),
      previews: database.listPullRequestPreviews(project.id).map(presentPreview)
    };
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/previews/settings", {
    preHandler: requireScopedMutation("projects:write")
  }, async (request) => {
    const project = database.getMutableProject(request.params.id);
    if (!project) throw notFound("Projekt nicht gefunden");
    const input = z.object({
      enabled: z.boolean(),
      domainId: z.string().min(1).max(128).optional(),
      ttlHours: z.number().int().min(1).max(168).default(72)
    }).strict().parse(request.body);

    if (!input.enabled) {
      for (const preview of database.listPullRequestPreviews(project.id)) {
        if (preview.status !== "closed") database.requestPullRequestPreviewClose(project.id, preview.id);
      }
      const updated = database.updateProject(project.id, {
        preview_deployments_enabled: 0,
        preview_domain_id: null,
        preview_domain_suffix: null,
        preview_ttl_hours: input.ttlHours
      });
      if (!updated) throw conflict("Preview-Konfiguration konnte nicht gespeichert werden", "PROJECT_MUTATION_CONFLICT");
      return { enabled: false, domainId: null, domainSuffix: null, ttlHours: input.ttlHours };
    }

    if (!project.github_installation_id || !project.github_repository_id || !project.github_repository_full_name) {
      throw badRequest("Preview-Deployments benötigen ein verbundenes GitHub-App-Repository", "GITHUB_PROJECT_REQUIRED");
    }
    const capability = await github.previewCapability();
    if (!capability.ready) {
      throw conflict(
        "Die bestehende GitHub App benötigt Pull requests: Read und das pull_request-Webhook-Event. Aktualisiere die App-Berechtigungen und versuche es erneut.",
        "GITHUB_PREVIEW_CAPABILITY_MISSING"
      );
    }
    if (!input.domainId) throw badRequest("Bitte eine aktive Projekt-Domain auswählen", "PREVIEW_DOMAIN_REQUIRED");
    const domain = database.getDomain(input.domainId);
    if (!domain || domain.project_id !== project.id || domain.status !== "active" || !domain.zone_id) {
      throw badRequest("Die ausgewählte Projekt-Domain ist nicht aktiv", "PREVIEW_DOMAIN_INVALID");
    }
    const zones = await cloudflare.listZones();
    const zone = zones.find((candidate) => candidate.id.toLowerCase() === domain.zone_id!.toLowerCase());
    if (!zone) throw badRequest("Die Cloudflare-Zone der Domain ist nicht verfügbar", "PREVIEW_ZONE_UNAVAILABLE");

    const updated = database.updateProject(project.id, {
      preview_deployments_enabled: 1,
      preview_domain_id: domain.id,
      preview_domain_suffix: zone.name,
      preview_ttl_hours: input.ttlHours
    });
    if (!updated) throw conflict("Preview-Konfiguration konnte nicht gespeichert werden", "PROJECT_MUTATION_CONFLICT");
    return { enabled: true, domainId: domain.id, domainSuffix: zone.name, ttlHours: input.ttlHours };
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/previews/environment", {
    preHandler: requireScopedMutation("environment:write")
  }, async (request) => {
    const project = database.getMutableProject(request.params.id);
    if (!project) throw notFound("Projekt nicht gefunden");
    const input = z.object({
      variables: z.array(z.object({
        key: z.string().min(1).max(100),
        value: z.string().max(65_536).optional()
      }).strict()).max(200)
    }).strict().parse(request.body);
    const existing = new Map(database.listPreviewEnvironment(project.id).map((row) => [row.key, row]));
    const seen = new Set<string>();
    const now = new Date().toISOString();
    const effective: Array<{ key: string; value: string }> = [];
    const rows = input.variables.map((variable) => {
      if (!validEnvironmentKey(variable.key)) throw badRequest(`Ungültiger Variablenname: ${variable.key}`, "INVALID_ENV_KEY");
      if (reservedEnvironmentKeys.has(variable.key)) throw badRequest(`${variable.key} wird von Shelter verwaltet`, "RESERVED_ENV_KEY");
      if (seen.has(variable.key)) throw badRequest(`Doppelter Variablenname: ${variable.key}`, "DUPLICATE_ENV_KEY");
      seen.add(variable.key);
      const previous = existing.get(variable.key);
      if (variable.value === undefined && !previous) throw badRequest(`Wert für ${variable.key} fehlt`, "ENV_VALUE_REQUIRED");
      const value = variable.value ?? decryptString(previous!.encrypted_value, config.APP_SECRET);
      effective.push({ key: variable.key, value });
      return {
        id: previous?.id ?? newId("penv"),
        project_id: project.id,
        key: variable.key,
        encrypted_value: variable.value === undefined
          ? previous!.encrypted_value
          : encryptString(variable.value, config.APP_SECRET),
        created_at: previous?.created_at ?? now,
        updated_at: now
      };
    });
    const totalBytes = effective.reduce((total, variable) => (
      total + Buffer.byteLength(variable.key) + Buffer.byteLength(variable.value) + 2
    ), 0);
    if (totalBytes > MAX_ENVIRONMENT_BYTES) {
      throw badRequest("Preview-Umgebungsvariablen dürfen zusammen höchstens 256 KiB groß sein", "ENVIRONMENT_TOO_LARGE");
    }
    if (!database.replacePreviewEnvironment(project.id, rows)) {
      throw conflict("Preview-Umgebung konnte nicht gespeichert werden", "PROJECT_MUTATION_CONFLICT");
    }
    return { environmentKeys: rows.map((row) => row.key), inheritsProductionEnvironment: false };
  });

  app.delete<{ Params: { id: string; previewId: string } }>("/api/projects/:id/previews/:previewId", {
    preHandler: requireScopedMutation("deployments:write")
  }, async (request, reply) => {
    const project = database.getMutableProject(request.params.id);
    if (!project) throw notFound("Projekt nicht gefunden");
    const preview = database.requestPullRequestPreviewClose(project.id, request.params.previewId);
    if (!preview) throw notFound("Preview-Deployment nicht gefunden");
    return reply.code(202).send({ preview: presentPreview(preview) });
  });
}
