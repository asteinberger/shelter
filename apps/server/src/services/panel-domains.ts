import type { Database } from "../lib/database.js";
import { invalidateCloudflareAccessConfirmationForHostname } from "./cloudflare-access.js";

const PANEL_ALIASES_SETTING = "cloudflare.panel_domain_aliases";

export interface PanelDomainAlias {
  hostname: string;
  zoneId: string | null;
  recordId: string | null;
}

function validHostname(value: unknown): value is string {
  return typeof value === "string" && value.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

export function panelDomainAliases(database: Pick<Database, "getSetting">): PanelDomainAlias[] {
  const aliases: PanelDomainAlias[] = [];
  const stored = database.getSetting(PANEL_ALIASES_SETTING);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as unknown;
      if (Array.isArray(parsed)) {
        for (const candidate of parsed) {
          if (!candidate || typeof candidate !== "object") continue;
          const row = candidate as Record<string, unknown>;
          if (!validHostname(row.hostname)) continue;
          aliases.push({
            hostname: row.hostname,
            zoneId: typeof row.zoneId === "string" ? row.zoneId : null,
            recordId: typeof row.recordId === "string" ? row.recordId : null
          });
        }
      }
    } catch {
      // A malformed optional alias list must not make the panel unavailable.
    }
  }

  // Compatibility with an early single-alias transition format.
  const legacyHostname = database.getSetting("cloudflare.panel_legacy_domain");
  if (validHostname(legacyHostname)) {
    aliases.push({
      hostname: legacyHostname,
      zoneId: database.getSetting("cloudflare.panel_legacy_zone_id") ?? null,
      recordId: database.getSetting("cloudflare.panel_legacy_record_id") ?? null
    });
  }

  return [...new Map(aliases.map((alias) => [alias.hostname, alias])).values()];
}

export function panelHostnames(database: Pick<Database, "getSetting">): string[] {
  const current = database.getSetting("cloudflare.panel_domain")?.toLowerCase();
  return [...new Set([
    ...(validHostname(current) ? [current] : []),
    ...panelDomainAliases(database).map((alias) => alias.hostname)
  ])];
}

export function storePanelDomainTransition(
  database: Pick<Database, "getSetting" | "setSetting" | "deleteSetting">,
  hostname: string,
  zoneId: string,
  recordId: string
): void {
  const current = database.getSetting("cloudflare.panel_domain")?.toLowerCase();
  invalidateCloudflareAccessConfirmationForHostname(database, hostname);
  const aliases = panelDomainAliases(database).filter((alias) => alias.hostname !== hostname);
  if (current && current !== hostname) {
    aliases.push({
      hostname: current,
      zoneId: database.getSetting("cloudflare.panel_zone_id") ?? null,
      recordId: database.getSetting("cloudflare.panel_record_id") ?? null
    });
  }
  const deduplicated = [...new Map(aliases.map((alias) => [alias.hostname, alias])).values()];
  database.setSetting(PANEL_ALIASES_SETTING, JSON.stringify(deduplicated));
  database.setSetting("cloudflare.panel_domain", hostname);
  database.setSetting("cloudflare.panel_zone_id", zoneId);
  database.setSetting("cloudflare.panel_record_id", recordId);
  for (const key of [
    "cloudflare.panel_legacy_domain",
    "cloudflare.panel_legacy_zone_id",
    "cloudflare.panel_legacy_record_id"
  ]) database.deleteSetting(key);
}
