import type { Database } from "../lib/database.js";

const ACCESS_CONFIRMATION_SETTING = "cloudflare.access_admin_confirmation";

type SettingsReader = Pick<Database, "getSetting">;
type SettingsWriter = Pick<Database, "getSetting" | "setSetting" | "deleteSetting">;

interface StoredAccessConfirmation {
  panelDomain: string;
  confirmedAt: string;
  confirmedByUserId: string;
}

export interface CloudflareAccessProtectionState {
  status: "not_applicable" | "action_required" | "confirmed_by_admin";
  panelDomain: string | null;
  confirmedHostname: string | null;
  confirmedAt: string | null;
}

function canonicalHostname(value: string | undefined): string | null {
  const hostname = value?.trim().toLowerCase().replace(/\.$/, "");
  return hostname || null;
}

function storedConfirmation(database: SettingsReader): StoredAccessConfirmation | null {
  const value = database.getSetting(ACCESS_CONFIRMATION_SETTING);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredAccessConfirmation>;
    const panelDomain = canonicalHostname(parsed.panelDomain);
    if (
      !panelDomain
      || typeof parsed.confirmedAt !== "string"
      || Number.isNaN(Date.parse(parsed.confirmedAt))
      || typeof parsed.confirmedByUserId !== "string"
      || !parsed.confirmedByUserId
    ) return null;
    return {
      panelDomain,
      confirmedAt: parsed.confirmedAt,
      confirmedByUserId: parsed.confirmedByUserId
    };
  } catch {
    return null;
  }
}

export function cloudflareAccessProtection(database: SettingsReader): CloudflareAccessProtectionState {
  const panelDomain = canonicalHostname(database.getSetting("cloudflare.panel_domain"));
  if (!panelDomain) {
    return {
      status: "not_applicable",
      panelDomain: null,
      confirmedHostname: null,
      confirmedAt: null
    };
  }

  const confirmation = storedConfirmation(database);
  if (confirmation?.panelDomain === panelDomain) {
    return {
      status: "confirmed_by_admin",
      panelDomain,
      confirmedHostname: confirmation.panelDomain,
      confirmedAt: confirmation.confirmedAt
    };
  }

  return {
    status: "action_required",
    panelDomain,
    confirmedHostname: null,
    confirmedAt: null
  };
}

export function storeCloudflareAccessConfirmation(
  database: SettingsWriter,
  panelDomain: string,
  userId: string,
  confirmedAt = new Date().toISOString()
): CloudflareAccessProtectionState {
  const hostname = canonicalHostname(panelDomain);
  if (!hostname) throw new Error("A panel hostname is required for Cloudflare Access confirmation");
  database.setSetting(ACCESS_CONFIRMATION_SETTING, JSON.stringify({
    panelDomain: hostname,
    confirmedAt,
    confirmedByUserId: userId
  } satisfies StoredAccessConfirmation));
  return cloudflareAccessProtection(database);
}

export function revokeCloudflareAccessConfirmation(database: SettingsWriter): CloudflareAccessProtectionState {
  database.deleteSetting(ACCESS_CONFIRMATION_SETTING);
  return cloudflareAccessProtection(database);
}

export function invalidateCloudflareAccessConfirmationForHostname(
  database: SettingsWriter,
  nextPanelDomain: string
): void {
  const confirmation = storedConfirmation(database);
  if (confirmation && confirmation.panelDomain !== canonicalHostname(nextPanelDomain)) {
    database.deleteSetting(ACCESS_CONFIRMATION_SETTING);
  }
}

export const cloudflareAccessConfirmationSetting = ACCESS_CONFIRMATION_SETTING;
