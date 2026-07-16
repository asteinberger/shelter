import { createHash } from "node:crypto";
import type { DomainRow, ProjectRow, PullRequestPreviewRow } from "../types/models.js";

const DNS_LABEL_MAX = 63;
const HOSTNAME_MAX = 253;

function dnsSegment(value: string): string {
  return value.toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Preview hosts stay directly below the selected Cloudflare zone. This is
 * important because Universal SSL commonly covers `*.zone`, not nested names.
 */
export function pullRequestPreviewHostname(
  pullRequestNumber: number,
  projectSlug: string,
  zoneName: string
): string {
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1 || pullRequestNumber > 2_147_483_647) {
    throw new Error("Ungültige Pull-Request-Nummer");
  }
  const normalizedZone = zoneName.trim().toLowerCase().replace(/\.$/, "");
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalizedZone)) {
    throw new Error("Ungültige Cloudflare-Zone für Preview-Deployments");
  }
  const prefix = `pr-${pullRequestNumber}--`;
  const hash = createHash("sha256").update(projectSlug).digest("hex").slice(0, 8);
  const available = DNS_LABEL_MAX - prefix.length - hash.length - 1;
  const boundedSlug = dnsSegment(projectSlug).slice(0, Math.max(1, available)).replace(/-+$/g, "") || "app";
  const label = `${prefix}${boundedSlug}-${hash}`;
  const hostname = `${label}.${normalizedZone}`;
  if (hostname.length > HOSTNAME_MAX) throw new Error("Preview-Hostname ist zu lang");
  return hostname;
}

export function activePreviewCount(previews: PullRequestPreviewRow[]): number {
  return previews.filter((preview) => ["queued", "building", "ready"].includes(preview.status)).length;
}

export function previewConfigurationReady(
  project: ProjectRow,
  domains: DomainRow[]
): boolean {
  return project.preview_deployments_enabled === 1
    && Boolean(project.preview_domain_suffix)
    && domains.some((domain) => domain.id === project.preview_domain_id && domain.status === "active");
}

