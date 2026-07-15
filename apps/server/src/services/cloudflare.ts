import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { badRequest, conflict, HttpError, upstreamError } from "../lib/errors.js";
import { decryptString, encryptString, normalizeHostname } from "../lib/security.js";
import {
  CloudflareOAuthService,
  type CloudflareOAuthAccount
} from "./cloudflare-oauth.js";
import { panelHostnames, storePanelDomainTransition } from "./panel-domains.js";
import { reconcileRouting } from "./routing.js";

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
  messages?: Array<{ code: number; message: string }>;
}

interface CloudflareZone {
  id: string;
  name: string;
  status: string;
}

interface CloudflareTunnel {
  id: string;
  name: string;
  status?: string;
  deleted_at?: string | null;
}

interface CloudflareDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  comment?: string | null;
}

interface CloudflareAccount {
  id: string;
  name: string;
}

const CLOUDFLARE_PAGE_SIZE = 50;
const MAX_CLOUDFLARE_PAGES = 100;

function canonicalDnsName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

class CloudflareApiError extends HttpError {
  constructor(readonly upstreamStatus: number, message: string) {
    super(502, "CLOUDFLARE_API", message);
  }
}

class CloudflareClient {
  private readonly baseUrl = "https://api.cloudflare.com/client/v4";

  constructor(private readonly token: string) {}

  async request<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(20_000)
      });
    } catch {
      throw upstreamError("Cloudflare API ist derzeit nicht erreichbar", "CLOUDFLARE_UNREACHABLE");
    }

    let envelope: CloudflareEnvelope<T>;
    try {
      envelope = (await response.json()) as CloudflareEnvelope<T>;
    } catch {
      if (response.status === 404) {
        throw new CloudflareApiError(404, "Cloudflare: Ressource nicht gefunden");
      }
      throw upstreamError(`Cloudflare API antwortet mit HTTP ${response.status}`, "CLOUDFLARE_API");
    }

    if (!response.ok || !envelope.success) {
      const detail = envelope.errors?.map((error) => error.message).join(", ") || `HTTP ${response.status}`;
      if (response.status === 404) throw new CloudflareApiError(404, `Cloudflare: ${detail}`);
      throw upstreamError(`Cloudflare: ${detail}`, "CLOUDFLARE_API");
    }
    return envelope.result;
  }
}

export interface CloudflareSetupInput {
  accountId: string;
  apiToken?: string;
  tunnelName?: string;
  panelDomain?: string;
}

export interface CloudflareState {
  configured: boolean;
  connected: boolean;
  authorized: boolean;
  authMethod: "oauth" | "api_token" | null;
  accountId: string | null;
  tunnelId: string | null;
  tunnelName: string | null;
  panelDomain: string | null;
  hasApiToken: boolean;
  oauthAvailable: boolean;
  oauthRedirectUri: string | null;
  oauthPending: boolean;
  accounts: CloudflareOAuthAccount[];
  oauthExpiresAt: string | null;
  reconnectRequired: boolean;
}

export interface CloudflareZoneSummary {
  id: string;
  name: string;
}

export type CloudflareHostnameAvailabilityReason =
  | "AVAILABLE"
  | "INVALID_HOSTNAME"
  | "ZONE_NOT_FOUND"
  | "ZONE_MISMATCH"
  | "PANEL_DOMAIN_RESERVED"
  | "SHELTER_DOMAIN_ASSIGNED"
  | "CLOUDFLARE_DNS_RECORD_EXISTS";

export interface CloudflareHostnameAvailability {
  hostname: string | null;
  availability: boolean;
  reason: CloudflareHostnameAvailabilityReason;
  zone: CloudflareZoneSummary | null;
}

export class CloudflareService {
  private readonly oauth: CloudflareOAuthService;
  private setupInProgress = false;
  private disconnectInProgress = false;

  constructor(
    private readonly config: AppConfig,
    private readonly database: Database
  ) {
    this.oauth = new CloudflareOAuthService(config, database);
  }

  startOAuth(userId: string, sessionTokenHash: string): {
    authorizationUrl: string;
    browserNonce: string;
    secureCookie: boolean;
  } {
    return this.oauth.start({ userId, sessionTokenHash });
  }

  async completeOAuth(state: string, browserNonce: string, code: string): Promise<void> {
    await this.oauth.complete(state, browserNonce, code);
  }

  cancelOAuth(state: string, browserNonce: string): void {
    this.oauth.cancel(state, browserNonce);
  }

  oauthResultUrl(result: "connected" | "error"): string {
    return this.oauth.resultUrl(result);
  }

  async disconnect(userId: string): Promise<CloudflareState> {
    if (this.setupInProgress) {
      throw conflict("Die laufende Cloudflare-Einrichtung muss zuerst abgeschlossen werden", "CLOUDFLARE_SETUP_IN_PROGRESS");
    }
    if (this.disconnectInProgress) {
      throw conflict("Die Cloudflare-Verbindung wird bereits getrennt", "CLOUDFLARE_DISCONNECTING");
    }
    this.disconnectInProgress = true;
    try {
      await this.oauth.disconnect(userId);
      return this.state(userId);
    } finally {
      this.disconnectInProgress = false;
    }
  }

  state(userId?: string): CloudflareState {
    const disabled = this.database.getSetting("cloudflare.credentials_disabled") === "1";
    const configuredMethod = this.database.getSetting("cloudflare.auth_method");
    const oauthConnection = disabled ? null : this.oauth.active();
    const pending = userId ? this.oauth.pending(userId) : null;
    const accountId = this.database.getSetting("cloudflare.account_id") ?? this.config.CLOUDFLARE_ACCOUNT_ID ?? null;
    const hasApiToken = !disabled && configuredMethod !== "oauth" && Boolean(
      this.database.getSetting("cloudflare.api_token") ?? this.config.CLOUDFLARE_API_TOKEN
    );
    const authMethod: CloudflareState["authMethod"] = oauthConnection
      ? "oauth"
      : hasApiToken
        ? "api_token"
        : null;
    const connected = Boolean(authMethod);
    return {
      configured: Boolean(accountId && connected && this.database.getSetting("cloudflare.tunnel_id")),
      connected,
      authorized: connected || Boolean(pending),
      authMethod,
      accountId,
      tunnelId: this.database.getSetting("cloudflare.tunnel_id") ?? null,
      tunnelName: this.database.getSetting("cloudflare.tunnel_name") ?? null,
      panelDomain: this.database.getSetting("cloudflare.panel_domain") ?? null,
      hasApiToken,
      oauthAvailable: this.oauth.available(),
      oauthRedirectUri: this.oauth.redirectUri(),
      oauthPending: Boolean(pending),
      accounts: pending?.accounts ?? oauthConnection?.accounts ?? [],
      oauthExpiresAt: oauthConnection?.expiresAt ?? null,
      reconnectRequired: disabled ? false : this.oauth.reconnectRequired()
    };
  }

  private async credentials(override?: { accountId?: string; apiToken?: string }): Promise<{
    accountId: string;
    apiToken: string;
    authMethod: "oauth" | "api_token";
  }> {
    const accountId = override?.accountId || this.database.getSetting("cloudflare.account_id") || this.config.CLOUDFLARE_ACCOUNT_ID;
    const authMethod = this.database.getSetting("cloudflare.auth_method");
    const disabled = this.database.getSetting("cloudflare.credentials_disabled") === "1";
    if (!override?.apiToken && !disabled && (authMethod === "oauth" || this.oauth.active())) {
      if (!accountId) throw badRequest("Cloudflare ist noch nicht konfiguriert", "CLOUDFLARE_NOT_CONFIGURED");
      return { accountId, apiToken: await this.oauth.accessToken(), authMethod: "oauth" };
    }
    const storedToken = this.database.getSetting("cloudflare.api_token");
    const apiToken = override?.apiToken || (disabled
      ? undefined
      : storedToken
        ? decryptString(storedToken, this.config.APP_SECRET)
        : this.config.CLOUDFLARE_API_TOKEN);
    if (!accountId || !apiToken) throw badRequest("Cloudflare ist noch nicht konfiguriert", "CLOUDFLARE_NOT_CONFIGURED");
    return { accountId, apiToken, authMethod: "api_token" };
  }

  private async discoveryCredentials(userId?: string, requestedAccountId?: string): Promise<{
    accountId: string;
    apiToken: string;
  }> {
    const accountId = requestedAccountId?.trim().toLowerCase();
    if (accountId && !/^[a-f0-9]{32}$/.test(accountId)) {
      throw badRequest("Ungültige Cloudflare Account-ID", "INVALID_ACCOUNT_ID");
    }

    const pending = userId ? this.oauth.pendingCandidate(userId)?.connection ?? null : null;
    if (accountId && pending?.accounts.some((account) => account.id.toLowerCase() === accountId)) {
      return { accountId, apiToken: pending.accessToken };
    }

    const state = this.state(userId);
    if (state.connected && state.accountId) {
      const active = await this.credentials();
      if (accountId && active.accountId.toLowerCase() !== accountId) {
        throw badRequest(
          "Der gewählte Cloudflare-Account gehört nicht zur aktuellen Verbindung",
          "CLOUDFLARE_ACCOUNT_NOT_AUTHORIZED"
        );
      }
      return { accountId: active.accountId, apiToken: active.apiToken };
    }

    if (pending) {
      const selectedAccountId = accountId ?? (pending.accounts.length === 1 ? pending.accounts[0]!.id.toLowerCase() : undefined);
      if (!selectedAccountId) {
        throw badRequest("Bitte zuerst einen Cloudflare-Account auswählen", "CLOUDFLARE_ACCOUNT_REQUIRED");
      }
      if (!pending.accounts.some((account) => account.id.toLowerCase() === selectedAccountId)) {
        throw badRequest(
          "Der gewählte Cloudflare-Account gehört nicht zur aktuellen Anmeldung",
          "CLOUDFLARE_ACCOUNT_NOT_AUTHORIZED"
        );
      }
      return { accountId: selectedAccountId, apiToken: pending.accessToken };
    }

    throw badRequest("Cloudflare ist noch nicht verbunden", "CLOUDFLARE_NOT_CONFIGURED");
  }

  async listZones(input: { userId?: string; accountId?: string } = {}): Promise<CloudflareZoneSummary[]> {
    const { accountId, apiToken } = await this.discoveryCredentials(input.userId, input.accountId);
    return this.listActiveZonesWith(new CloudflareClient(apiToken), accountId);
  }

  async checkHostname(
    hostnameInput: string,
    input: { userId?: string; accountId?: string; zoneId?: string } = {}
  ): Promise<CloudflareHostnameAvailability> {
    let hostname: string;
    try {
      hostname = normalizeHostname(hostnameInput);
    } catch (error) {
      if (error instanceof HttpError && error.code === "INVALID_HOSTNAME") {
        return { hostname: null, availability: false, reason: "INVALID_HOSTNAME", zone: null };
      }
      throw error;
    }

    const { accountId, apiToken } = await this.discoveryCredentials(input.userId, input.accountId);
    const client = new CloudflareClient(apiToken);
    const zones = await this.listActiveZonesWith(client, accountId);
    const zone = this.authoritativeZone(zones, hostname);
    const requestedZoneId = input.zoneId?.trim().toLowerCase();

    if (requestedZoneId && zone?.id.toLowerCase() !== requestedZoneId) {
      return { hostname, availability: false, reason: "ZONE_MISMATCH", zone };
    }
    if (!zone) {
      return { hostname, availability: false, reason: "ZONE_NOT_FOUND", zone: null };
    }
    if (panelHostnames(this.database).includes(hostname)) {
      return { hostname, availability: false, reason: "PANEL_DOMAIN_RESERVED", zone };
    }
    if (this.database.listDomains().some((domain) => domain.hostname.toLowerCase() === hostname)) {
      return { hostname, availability: false, reason: "SHELTER_DOMAIN_ASSIGNED", zone };
    }

    if (await this.dnsRecordExistsWith(client, zone.id, hostname)) {
      return { hostname, availability: false, reason: "CLOUDFLARE_DNS_RECORD_EXISTS", zone };
    }
    return { hostname, availability: true, reason: "AVAILABLE", zone };
  }

  async setup(input: CloudflareSetupInput, userId?: string): Promise<CloudflareState> {
    if (this.disconnectInProgress) {
      throw conflict("Die Cloudflare-Verbindung wird gerade getrennt", "CLOUDFLARE_DISCONNECTING");
    }
    if (this.setupInProgress) {
      throw conflict("Eine Cloudflare-Einrichtung läuft bereits", "CLOUDFLARE_SETUP_IN_PROGRESS");
    }
    this.setupInProgress = true;
    try {
      return await this.performSetup(input, userId);
    } finally {
      this.setupInProgress = false;
    }
  }

  private async performSetup(input: CloudflareSetupInput, userId?: string): Promise<CloudflareState> {
    const existingStoredToken = this.database.getSetting("cloudflare.api_token");
    const accountId = input.accountId.trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/i.test(accountId)) throw badRequest("Ungültige Cloudflare Account-ID", "INVALID_ACCOUNT_ID");
    const tunnelName = (input.tunnelName || this.database.getSetting("cloudflare.tunnel_name") || "shelter-vps").trim();
    if (!/^[a-zA-Z0-9_.-]{2,64}$/.test(tunnelName)) throw badRequest("Ungültiger Tunnelname", "INVALID_TUNNEL_NAME");
    const requestedPanelDomain = input.panelDomain ? normalizeHostname(input.panelDomain) : undefined;
    if (requestedPanelDomain && this.database.listDomains().some((domain) => domain.hostname === requestedPanelDomain)) {
      throw conflict("Die Panel-Domain ist bereits einem Projekt zugeordnet", "PANEL_DOMAIN_CONFLICT");
    }

    const pendingOAuthCandidate = userId && !input.apiToken ? this.oauth.pendingCandidate(userId) : null;
    const pendingOAuth = pendingOAuthCandidate?.connection ?? null;
    let apiToken: string;
    let candidateMethod: "oauth" | "api_token";
    let activatesPendingOAuth = false;
    if (pendingOAuth) {
      if (!pendingOAuth.accounts.some((account) => account.id.toLowerCase() === accountId.toLowerCase())) {
        throw badRequest("Der gewählte Cloudflare-Account gehört nicht zur aktuellen Anmeldung", "CLOUDFLARE_ACCOUNT_NOT_AUTHORIZED");
      }
      apiToken = pendingOAuth.accessToken;
      candidateMethod = "oauth";
      activatesPendingOAuth = true;
    } else if (input.apiToken) {
      apiToken = input.apiToken;
      candidateMethod = "api_token";
    } else if (this.database.getSetting("cloudflare.auth_method") === "oauth" || this.oauth.active()) {
      apiToken = await this.oauth.accessToken();
      candidateMethod = "oauth";
    } else {
      const disabled = this.database.getSetting("cloudflare.credentials_disabled") === "1";
      const token = disabled
        ? undefined
        : existingStoredToken
          ? decryptString(existingStoredToken, this.config.APP_SECRET)
          : this.config.CLOUDFLARE_API_TOKEN;
      if (!token) throw badRequest("Ein Cloudflare Login oder API-Token ist erforderlich", "CLOUDFLARE_TOKEN_REQUIRED");
      apiToken = token;
      candidateMethod = "api_token";
    }

    const client = new CloudflareClient(apiToken);
    if (candidateMethod === "api_token") {
      await client.request<{ status: string }>("GET", "/user/tokens/verify");
    } else {
      await client.request<CloudflareAccount>("GET", `/accounts/${accountId}`);
    }

    const storedAccountId = this.database.getSetting("cloudflare.account_id");
    const storedTunnelId = this.database.getSetting("cloudflare.tunnel_id");
    if (storedTunnelId && storedAccountId && storedAccountId.toLowerCase() !== accountId) {
      throw conflict("Der Cloudflare-Account kann nach dem ersten Tunnel-Setup nicht gewechselt werden", "ACCOUNT_IMMUTABLE");
    }

    let tunnel: CloudflareTunnel | undefined;
    if (storedTunnelId) {
      tunnel = await client.request<CloudflareTunnel>("GET", `/accounts/${accountId}/cfd_tunnel/${storedTunnelId}`);
      if (tunnel.id !== storedTunnelId) {
        throw upstreamError("Cloudflare hat einen unerwarteten Tunnel geliefert", "CLOUDFLARE_TUNNEL_MISMATCH");
      }
      if (tunnel.deleted_at) throw conflict("Der von Shelter verwaltete Cloudflare-Tunnel wurde gelöscht", "TUNNEL_DELETED");
      if (tunnel.name !== tunnelName) {
        const query = new URLSearchParams({ name: tunnelName, is_deleted: "false", per_page: String(CLOUDFLARE_PAGE_SIZE) });
        const collisions = await client.request<CloudflareTunnel[]>("GET", `/accounts/${accountId}/cfd_tunnel?${query.toString()}`);
        if (collisions.some((candidate) => candidate.id !== storedTunnelId && candidate.name === tunnelName && !candidate.deleted_at)) {
          throw conflict("Ein fremder Tunnel mit diesem Namen existiert bereits. Bitte einen eindeutigen Namen wählen.", "TUNNEL_NAME_EXISTS");
        }
        const renamed = await client.request<CloudflareTunnel>(
          "PATCH",
          `/accounts/${accountId}/cfd_tunnel/${storedTunnelId}`,
          { name: tunnelName }
        );
        if (renamed.id !== storedTunnelId || renamed.name !== tunnelName || renamed.deleted_at) {
          throw upstreamError("Cloudflare hat die Tunnel-Umbenennung nicht bestätigt", "CLOUDFLARE_TUNNEL_RENAME_INVALID");
        }
        tunnel = renamed;
        // Persist the new remote identity immediately after Cloudflare confirms
        // it. A later configuration failure can then resume the renamed tunnel
        // instead of trying to rename it back from stale local state.
        this.database.setSetting("cloudflare.tunnel_name", tunnelName);
      }
    } else {
      const query = new URLSearchParams({ name: tunnelName, is_deleted: "false", per_page: String(CLOUDFLARE_PAGE_SIZE) });
      const tunnels = await client.request<CloudflareTunnel[]>("GET", `/accounts/${accountId}/cfd_tunnel?${query.toString()}`);
      if (tunnels.some((candidate) => candidate.name === tunnelName && !candidate.deleted_at)) {
        throw conflict("Ein fremder Tunnel mit diesem Namen existiert bereits. Bitte einen eindeutigen Namen wählen.", "TUNNEL_NAME_EXISTS");
      }
    }

    // Commit exactly the credential candidate that was validated above before
    // creating an external tunnel. This prevents a replaced pending login or a
    // parallel setup from creating a tunnel with uncommitted credentials.
    this.database.sqlite.transaction(() => {
      this.database.setSetting("cloudflare.account_id", accountId);
      if (activatesPendingOAuth && userId && pendingOAuthCandidate) {
        this.oauth.activatePending(userId, pendingOAuthCandidate.version);
      } else if (input.apiToken) {
        this.database.setSetting("cloudflare.api_token", encryptString(apiToken, this.config.APP_SECRET));
        this.database.setSetting("cloudflare.auth_method", "api_token");
        this.database.deleteSetting("cloudflare.oauth_credentials");
        this.database.deleteSetting("cloudflare.oauth_reconnect_required");
        this.database.deleteSetting("cloudflare.credentials_disabled");
        this.database.deleteCloudflareOAuthPending();
      }
    })();

    if (!tunnel) {
      tunnel = await client.request<CloudflareTunnel>("POST", `/accounts/${accountId}/cfd_tunnel`, {
        name: tunnelName,
        config_src: "cloudflare"
      });
      if (!tunnel.id || tunnel.name !== tunnelName || tunnel.deleted_at) {
        throw upstreamError("Cloudflare hat einen ungültigen Tunnel geliefert", "CLOUDFLARE_TUNNEL_INVALID");
      }
    }

    const ownedTunnel = tunnel;
    // Persist tunnel ownership immediately after creation so a later setup retry
    // resumes the same tunnel instead of treating it as a foreign name collision.
    this.database.sqlite.transaction(() => {
      this.database.setSetting("cloudflare.tunnel_id", ownedTunnel.id);
      this.database.setSetting("cloudflare.tunnel_name", tunnelName);
    })();

    await client.request("PUT", `/accounts/${accountId}/cfd_tunnel/${ownedTunnel.id}/configurations`, {
      config: { ingress: [{ service: this.config.TRAEFIK_SERVICE_URL }] }
    });
    const tunnelToken = await client.request<string>("GET", `/accounts/${accountId}/cfd_tunnel/${ownedTunnel.id}/token`);

    this.writeTunnelToken(tunnelToken);
    this.database.setSetting("worker.cloudflared_restart_requested", new Date().toISOString());

    if (requestedPanelDomain) {
      const panelDomain = requestedPanelDomain;
      const dns = await this.ensureDnsRecordWith(client, accountId, panelDomain, ownedTunnel.id);
      this.database.sqlite.transaction(() => {
        storePanelDomainTransition(this.database, panelDomain, dns.zoneId, dns.recordId);
      })();
    }
    reconcileRouting(this.config, this.database);
    return this.state(userId);
  }

  async test(): Promise<{ ok: true; tunnelStatus: string; connections: number }> {
    const { accountId, apiToken, authMethod } = await this.credentials();
    const tunnelId = this.database.getSetting("cloudflare.tunnel_id");
    if (!tunnelId) throw badRequest("Kein Tunnel konfiguriert", "TUNNEL_NOT_CONFIGURED");
    const client = new CloudflareClient(apiToken);
    if (authMethod === "api_token") {
      await client.request<{ status: string }>("GET", "/user/tokens/verify");
    } else {
      await client.request<CloudflareAccount>("GET", `/accounts/${accountId}`);
    }
    const tunnel = await client.request<CloudflareTunnel>("GET", `/accounts/${accountId}/cfd_tunnel/${tunnelId}`);
    const connections = await client.request<unknown[]>("GET", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`);
    return { ok: true, tunnelStatus: tunnel.status ?? (connections.length > 0 ? "healthy" : "inactive"), connections: connections.length };
  }

  async ensureDnsRecord(hostnameInput: string, zoneIdInput?: string): Promise<{ zoneId: string; recordId: string }> {
    const hostname = normalizeHostname(hostnameInput);
    const { accountId, apiToken } = await this.credentials();
    const tunnelId = this.database.getSetting("cloudflare.tunnel_id");
    if (!tunnelId) throw badRequest("Kein Cloudflare-Tunnel konfiguriert", "TUNNEL_NOT_CONFIGURED");
    return this.ensureDnsRecordWith(
      new CloudflareClient(apiToken),
      accountId,
      hostname,
      tunnelId,
      zoneIdInput?.trim()
    );
  }

  private async ensureDnsRecordWith(
    client: CloudflareClient,
    accountId: string,
    hostname: string,
    tunnelId: string,
    requestedZoneId?: string
  ): Promise<{ zoneId: string; recordId: string }> {
    const zone = await this.findZone(client, accountId, hostname, requestedZoneId);
    const target = `${tunnelId}.cfargotunnel.com`;
    const query = new URLSearchParams({
      type: "CNAME",
      name: hostname,
      per_page: String(CLOUDFLARE_PAGE_SIZE),
      page: "1"
    });
    const existing = await client.request<CloudflareDnsRecord[]>("GET", `/zones/${zone.id}/dns_records?${query.toString()}`);
    const matching = existing.find((record) => record.name === hostname);
    if (matching) {
      if (matching.type !== "CNAME" || matching.content.toLowerCase() !== target.toLowerCase()) {
        throw conflict(`DNS-Eintrag für ${hostname} existiert bereits und wird nicht überschrieben`, "DNS_RECORD_EXISTS");
      }
      if (!matching.proxied || matching.comment === "Managed by Portsmith") {
        await client.request<CloudflareDnsRecord>("PATCH", `/zones/${zone.id}/dns_records/${matching.id}`, {
          proxied: true,
          ...(matching.comment === "Managed by Portsmith" ? { comment: "Managed by Shelter" } : {})
        });
      }
      return { zoneId: zone.id, recordId: matching.id };
    }

    const record = await client.request<CloudflareDnsRecord>("POST", `/zones/${zone.id}/dns_records`, {
      type: "CNAME",
      name: hostname,
      content: target,
      proxied: true,
      ttl: 1,
      comment: "Managed by Shelter"
    });
    return { zoneId: zone.id, recordId: record.id };
  }

  async deleteDnsRecord(
    zoneId: string | null,
    recordId: string | null,
    expectedHostnameInput: string
  ): Promise<void> {
    const expectedHostname = normalizeHostname(expectedHostnameInput);
    const { accountId, apiToken } = await this.credentials();
    const client = new CloudflareClient(apiToken);
    const tunnelId = this.database.getSetting("cloudflare.tunnel_id");
    if (!tunnelId) throw badRequest("Kein Cloudflare-Tunnel konfiguriert", "TUNNEL_NOT_CONFIGURED");
    await this.deleteDnsRecordWith(client, accountId, tunnelId, zoneId, recordId, expectedHostname);
  }

  private async deleteDnsRecordWith(
    client: CloudflareClient,
    accountId: string,
    tunnelId: string,
    zoneId: string | null,
    recordId: string | null,
    expectedHostname: string
  ): Promise<void> {
    const effectiveZoneId = zoneId ?? (await this.findZone(client, accountId, expectedHostname)).id;
    let record: CloudflareDnsRecord | undefined;
    if (recordId) {
      try {
        record = await client.request<CloudflareDnsRecord>(
          "GET",
          `/zones/${encodeURIComponent(effectiveZoneId)}/dns_records/${encodeURIComponent(recordId)}`
        );
      } catch (error) {
        if (error instanceof CloudflareApiError && error.upstreamStatus === 404) return;
        throw error;
      }
      if (record.id !== recordId) {
        throw conflict("DNS-Eintrag hat sich geändert und wurde deshalb nicht gelöscht", "DNS_RECORD_DRIFT");
      }
    } else {
      const query = new URLSearchParams({
        type: "CNAME",
        name: expectedHostname,
        per_page: String(CLOUDFLARE_PAGE_SIZE),
        page: "1"
      });
      const records = await client.request<CloudflareDnsRecord[]>(
        "GET",
        `/zones/${encodeURIComponent(effectiveZoneId)}/dns_records?${query.toString()}`
      );
      const matching = records.filter((candidate) => canonicalDnsName(candidate.name) === expectedHostname);
      if (matching.length === 0) return;
      if (matching.length !== 1) {
        throw conflict("DNS-Eintrag ist nicht mehr eindeutig und wurde deshalb nicht gelöscht", "DNS_RECORD_DRIFT");
      }
      record = matching[0];
    }

    if (!record) return;
    const target = canonicalDnsName(`${tunnelId}.cfargotunnel.com`);
    if (
      canonicalDnsName(record.name) !== expectedHostname ||
      record.type.toUpperCase() !== "CNAME" ||
      canonicalDnsName(record.content) !== target
    ) {
      throw conflict("DNS-Eintrag hat sich geändert und wurde deshalb nicht gelöscht", "DNS_RECORD_DRIFT");
    }
    try {
      await client.request(
        "DELETE",
        `/zones/${encodeURIComponent(effectiveZoneId)}/dns_records/${encodeURIComponent(record.id)}`
      );
    } catch (error) {
      if (error instanceof CloudflareApiError && error.upstreamStatus === 404) return;
      throw error;
    }
  }

  private authoritativeZone(zones: CloudflareZoneSummary[], hostname: string): CloudflareZoneSummary | null {
    let authoritative: CloudflareZoneSummary | null = null;
    for (const candidate of zones) {
      if (
        (hostname === candidate.name || hostname.endsWith(`.${candidate.name}`)) &&
        (!authoritative || candidate.name.length > authoritative.name.length)
      ) {
        authoritative = candidate;
      }
    }
    return authoritative;
  }

  private async findZone(
    client: CloudflareClient,
    accountId: string,
    hostname: string,
    requestedZoneId?: string
  ): Promise<CloudflareZoneSummary> {
    const zones = await this.listActiveZonesWith(client, accountId);
    const zone = this.authoritativeZone(zones, hostname);
    const normalizedRequestedZoneId = requestedZoneId?.trim().toLowerCase();
    if (normalizedRequestedZoneId && zone?.id.toLowerCase() !== normalizedRequestedZoneId) {
      throw badRequest(
        `Die gewählte Cloudflare-Zone ist nicht die autoritative aktive Zone für ${hostname}`,
        "ZONE_MISMATCH"
      );
    }
    if (!zone) throw badRequest(`Keine aktive Cloudflare-Zone für ${hostname} gefunden`, "ZONE_NOT_FOUND");
    return zone;
  }

  private async listActiveZonesWith(client: CloudflareClient, accountId: string): Promise<CloudflareZoneSummary[]> {
    const zones = new Map<string, CloudflareZoneSummary>();
    for (let page = 1; page <= MAX_CLOUDFLARE_PAGES; page += 1) {
      const query = new URLSearchParams({
        "account.id": accountId,
        status: "active",
        per_page: String(CLOUDFLARE_PAGE_SIZE),
        page: String(page)
      });
      const batch = await client.request<CloudflareZone[]>("GET", `/zones?${query.toString()}`);
      if (!Array.isArray(batch)) {
        throw upstreamError("Cloudflare hat eine ungültige Zonen-Antwort geliefert", "CLOUDFLARE_API");
      }
      for (const candidate of batch) {
        if (
          candidate?.status !== "active" ||
          typeof candidate.id !== "string" ||
          !candidate.id ||
          typeof candidate.name !== "string" ||
          !candidate.name
        ) {
          continue;
        }
        zones.set(candidate.id, { id: candidate.id, name: candidate.name.toLowerCase().replace(/\.$/, "") });
      }
      if (batch.length < CLOUDFLARE_PAGE_SIZE) {
        return [...zones.values()].sort((left, right) => left.name.localeCompare(right.name));
      }
    }
    throw upstreamError(
      `Cloudflare liefert mehr als ${MAX_CLOUDFLARE_PAGES * CLOUDFLARE_PAGE_SIZE} aktive Zonen für diesen Account`,
      "CLOUDFLARE_ZONE_LIMIT"
    );
  }

  private async dnsRecordExistsWith(client: CloudflareClient, zoneId: string, hostname: string): Promise<boolean> {
    for (let page = 1; page <= MAX_CLOUDFLARE_PAGES; page += 1) {
      const query = new URLSearchParams({
        name: hostname,
        per_page: String(CLOUDFLARE_PAGE_SIZE),
        page: String(page)
      });
      const records = await client.request<CloudflareDnsRecord[]>(
        "GET",
        `/zones/${zoneId}/dns_records?${query.toString()}`
      );
      if (!Array.isArray(records)) {
        throw upstreamError("Cloudflare hat eine ungültige DNS-Antwort geliefert", "CLOUDFLARE_API");
      }
      if (records.some((record) => (
        typeof record?.name === "string" && record.name.toLowerCase().replace(/\.$/, "") === hostname
      ))) {
        return true;
      }
      if (records.length < CLOUDFLARE_PAGE_SIZE) return false;
    }
    throw upstreamError("Cloudflare liefert zu viele DNS-Einträge für diesen Hostnamen", "CLOUDFLARE_DNS_LIMIT");
  }

  private writeTunnelToken(token: string): void {
    const directory = path.dirname(this.config.tunnelTokenPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = this.config.tunnelTokenPath;
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${token.trim()}\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
  }
}
