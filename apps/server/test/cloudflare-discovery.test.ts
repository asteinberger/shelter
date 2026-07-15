import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { decryptString, encryptString } from "../src/lib/security.js";

const temporaryDirectories: string[] = [];
const openApps: FastifyInstance[] = [];

async function discoveryApp(overrides: NodeJS.ProcessEnv = {}): Promise<{
  app: FastifyInstance;
  config: AppConfig;
  database: Database;
  sessionCookie: string;
  csrfToken: string;
  userId: string;
}> {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-cloudflare-discovery-"));
  temporaryDirectories.push(dataDirectory);
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDirectory,
    WEB_DIST: path.join(dataDirectory, "missing-web"),
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "correct horse battery staple",
    APP_SECRET: "d".repeat(64),
    LOG_LEVEL: "silent",
    ...overrides
  });
  const database = new Database(config);
  const app = await createApp(config, database);
  openApps.push(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin@example.com", password: "correct horse battery staple" }
  });
  return {
    app,
    config,
    database,
    sessionCookie: login.cookies.find((cookie) => cookie.name === "shelter_session")?.value ?? "",
    csrfToken: login.json().csrfToken as string,
    userId: login.json().user.id as string
  };
}

afterEach(async () => {
  for (const app of openApps.splice(0)) await app.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Cloudflare zone and hostname discovery", () => {
  it("refreshes OAuth and paginates active zones with at most 50 items per request", async () => {
    const accountId = "a".repeat(32);
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: `zone-${index}`,
      name: `zone-${String(index).padStart(2, "0")}.example`,
      status: index === 49 ? "pending" : "active"
    }));
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect(init?.redirect).toBe("error");
      if (url === "https://dash.cloudflare.com/oauth2/token") {
        expect((init?.body as URLSearchParams).get("grant_type")).toBe("refresh_token");
        return Response.json({
          access_token: "fresh-oauth-access-token",
          refresh_token: "rotated-oauth-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "account-settings.read zone.read dns.write offline_access"
        });
      }
      const parsed = new URL(url);
      if (parsed.origin + parsed.pathname === "https://api.cloudflare.com/client/v4/zones") {
        expect(init?.method).toBe("GET");
        expect(init?.headers).toMatchObject({ authorization: "Bearer fresh-oauth-access-token" });
        expect(parsed.searchParams.get("account.id")).toBe(accountId);
        expect(parsed.searchParams.get("status")).toBe("active");
        expect(parsed.searchParams.get("per_page")).toBe("50");
        if (parsed.searchParams.get("page") === "1") {
          return Response.json({ success: true, result: firstPage });
        }
        if (parsed.searchParams.get("page") === "2") {
          return Response.json({
            success: true,
            result: [
              { id: "zone-50", name: "second.example", status: "active" },
              { id: "zone-51", name: "first.example", status: "active" }
            ]
          });
        }
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", providerFetch);

    const { app, config, database, sessionCookie } = await discoveryApp({
      CLOUDFLARE_OAUTH_CLIENT_ID: "client-id",
      CLOUDFLARE_OAUTH_CLIENT_SECRET: "client-secret",
      CLOUDFLARE_OAUTH_REDIRECT_URI: "https://panel.example.com/api/settings/cloudflare/oauth/callback"
    });
    database.setSetting("cloudflare.account_id", accountId);
    database.setSetting("cloudflare.auth_method", "oauth");
    database.setSetting("cloudflare.oauth_credentials", encryptString(JSON.stringify({
      accessToken: "expired-oauth-access-token",
      refreshToken: "old-oauth-refresh-token",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      scopes: ["account-settings.read", "zone.read", "dns.write", "offline_access"],
      clientId: "client-id",
      redirectUri: "https://panel.example.com/api/settings/cloudflare/oauth/callback",
      accounts: [{ id: accountId, name: "Example Account" }]
    }), config.APP_SECRET));

    const anonymous = await app.inject({ method: "GET", url: "/api/settings/cloudflare/zones" });
    expect(anonymous.statusCode).toBe(401);
    const response = await app.inject({
      method: "GET",
      url: "/api/settings/cloudflare/zones",
      headers: { cookie: `portsmith_session=${sessionCookie}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const zones = response.json().zones as Array<Record<string, unknown>>;
    expect(zones).toHaveLength(51);
    expect(zones[0]).toEqual({ id: "zone-51", name: "first.example" });
    expect(zones.some((zone) => zone.id === "zone-49")).toBe(false);
    expect(zones.every((zone) => Object.keys(zone).sort().join(",") === "id,name")).toBe(true);
    expect(response.body).not.toContain("fresh-oauth-access-token");
    expect(providerFetch).toHaveBeenCalledTimes(3);

    const stored = JSON.parse(decryptString(
      database.getSetting("cloudflare.oauth_credentials")!,
      config.APP_SECRET
    )) as { accessToken: string; refreshToken: string };
    expect(stored).toMatchObject({
      accessToken: "fresh-oauth-access-token",
      refreshToken: "rotated-oauth-refresh-token"
    });
  });

  it("checks syntax, authorized zone, local reservations and Cloudflare DNS without mutations", async () => {
    const accountId = "b".repeat(32);
    const apiToken = "fallback-api-token-secret";
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${apiToken}` });
      if (url.pathname === "/client/v4/zones") {
        expect(url.searchParams.get("account.id")).toBe(accountId);
        expect(url.searchParams.get("status")).toBe("active");
        expect(url.searchParams.get("per_page")).toBe("50");
        return Response.json({
          success: true,
          result: [
            { id: "zone-id", name: "example.com", status: "active" },
            { id: "sub-zone-id", name: "sub.example.com", status: "active" }
          ]
        });
      }
      if (
        url.pathname === "/client/v4/zones/zone-id/dns_records" ||
        url.pathname === "/client/v4/zones/sub-zone-id/dns_records"
      ) {
        expect(url.searchParams.get("per_page")).toBe("50");
        expect(url.searchParams.get("page")).toBe("1");
        const hostname = url.searchParams.get("name");
        return Response.json({
          success: true,
          result: hostname === "taken.example.com"
            ? [{ id: "existing-record", name: hostname, type: "A", content: "192.0.2.10", proxied: true }]
            : []
        });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal("fetch", providerFetch);

    const { app, database, sessionCookie } = await discoveryApp({
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_API_TOKEN: apiToken
    });
    database.setSetting("cloudflare.panel_domain", "panel.example.com");
    const now = new Date().toISOString();
    database.createProject({
      id: "project-id",
      name: "Existing Project",
      slug: "existing-project",
      source_type: "git",
      repository_url: "https://github.com/example/project.git",
      repository_branch: "main",
      source_archive: null,
      static_base_path: null,
      root_directory: ".",
      build_type: "auto",
      dockerfile_path: "Dockerfile",
      port: 3000,
      healthcheck_path: "/",
      memory_limit: "1g",
      cpu_limit: "1.0",
      active_deployment_id: null,
      created_at: now,
      updated_at: now
    });
    database.createDomain({
      id: "domain-id",
      project_id: "project-id",
      hostname: "app.example.com",
      zone_id: "zone-id",
      dns_record_id: "managed-record",
      status: "active",
      error: null,
      created_at: now
    });
    const beforeDomains = database.listDomains();

    const check = (hostname: string, zoneId?: string) => app.inject({
      method: "POST",
      url: "/api/settings/cloudflare/hostname/check",
      headers: {
        cookie: `portsmith_session=${sessionCookie}`,
        "content-type": "application/json"
      },
      payload: { hostname, ...(zoneId ? { zoneId } : {}) }
    });

    const invalid = await check("not a hostname");
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json()).toEqual({
      hostname: null,
      availability: false,
      reason: "INVALID_HOSTNAME",
      zone: null
    });

    const outside = await check("outside.test");
    expect(outside.json()).toMatchObject({ availability: false, reason: "ZONE_NOT_FOUND", zone: null });

    const apex = await check("example.com", "zone-id");
    expect(apex.json()).toEqual({
      hostname: "example.com",
      availability: true,
      reason: "AVAILABLE",
      zone: { id: "zone-id", name: "example.com" }
    });

    const mismatchedParent = await check("service.sub.example.com", "zone-id");
    expect(mismatchedParent.json()).toEqual({
      hostname: "service.sub.example.com",
      availability: false,
      reason: "ZONE_MISMATCH",
      zone: { id: "sub-zone-id", name: "sub.example.com" }
    });

    const unknownZone = await check("service.sub.example.com", "unknown-zone-id");
    expect(unknownZone.json()).toMatchObject({
      availability: false,
      reason: "ZONE_MISMATCH",
      zone: { id: "sub-zone-id", name: "sub.example.com" }
    });

    const matchingZone = await check("service.sub.example.com", "sub-zone-id");
    expect(matchingZone.json()).toEqual({
      hostname: "service.sub.example.com",
      availability: true,
      reason: "AVAILABLE",
      zone: { id: "sub-zone-id", name: "sub.example.com" }
    });

    const panel = await check("PANEL.example.com.");
    expect(panel.json()).toMatchObject({
      hostname: "panel.example.com",
      availability: false,
      reason: "PANEL_DOMAIN_RESERVED",
      zone: { id: "zone-id", name: "example.com" }
    });

    const local = await check("app.example.com");
    expect(local.json()).toMatchObject({ availability: false, reason: "SHELTER_DOMAIN_ASSIGNED" });

    const existingDns = await check("taken.example.com");
    expect(existingDns.json()).toMatchObject({ availability: false, reason: "CLOUDFLARE_DNS_RECORD_EXISTS" });

    const available = await check("FREE.Example.com.");
    expect(available.statusCode).toBe(200);
    expect(available.headers["cache-control"]).toBe("no-store");
    expect(available.json()).toEqual({
      hostname: "free.example.com",
      availability: true,
      reason: "AVAILABLE",
      zone: { id: "zone-id", name: "example.com" }
    });
    expect(available.body).not.toContain(apiToken);
    expect(database.listDomains()).toEqual(beforeDomains);
    expect(providerFetch.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method === "GET")).toBe(true);
  });

  it("binds project DNS creation to the selected authoritative active zone and keeps zoneId optional", async () => {
    const accountId = "e".repeat(32);
    const apiToken = "project-domain-api-token";
    const dnsWrites: Array<{ pathname: string; body: Record<string, unknown> }> = [];
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${apiToken}` });
      if (init?.method === "GET" && url.pathname === "/client/v4/zones") {
        expect(url.searchParams.get("account.id")).toBe(accountId);
        return Response.json({
          success: true,
          result: [
            { id: "parent-zone-id", name: "example.com", status: "active" },
            { id: "authoritative-zone-id", name: "sub.example.com", status: "active" },
            { id: "inactive-zone-id", name: "inactive.example.com", status: "pending" }
          ]
        });
      }
      if (init?.method === "GET" && url.pathname.endsWith("/dns_records")) {
        return Response.json({ success: true, result: [] });
      }
      if (init?.method === "POST" && url.pathname.endsWith("/dns_records")) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        dnsWrites.push({ pathname: url.pathname, body });
        return Response.json({
          success: true,
          result: {
            id: `record-${dnsWrites.length}`,
            name: body.name,
            type: "CNAME",
            content: body.content,
            proxied: true
          }
        });
      }
      throw new Error(`Unexpected request: ${init?.method} ${url.toString()}`);
    });
    vi.stubGlobal("fetch", providerFetch);

    const { app, database, sessionCookie, csrfToken } = await discoveryApp({
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_API_TOKEN: apiToken
    });
    database.setSetting("cloudflare.tunnel_id", "managed-tunnel-id");
    const now = new Date().toISOString();
    database.createProject({
      id: "domain-project-id",
      name: "Domain Project",
      slug: "domain-project",
      source_type: "git",
      repository_url: "https://github.com/example/domain-project.git",
      repository_branch: "main",
      source_archive: null,
      static_base_path: null,
      root_directory: ".",
      build_type: "auto",
      dockerfile_path: "Dockerfile",
      port: 3000,
      healthcheck_path: "/",
      memory_limit: "1g",
      cpu_limit: "1.0",
      active_deployment_id: null,
      created_at: now,
      updated_at: now
    });
    const mutationHeaders = {
      cookie: `portsmith_session=${sessionCookie}`,
      "x-csrf-token": csrfToken,
      origin: "http://localhost:7080",
      host: "localhost:7080"
    };
    const addDomain = (payload: { hostname: string; zoneId?: string }) => app.inject({
      method: "POST",
      url: "/api/projects/domain-project-id/domains",
      headers: mutationHeaders,
      payload
    });

    const mismatched = await addDomain({
      hostname: "app.sub.example.com",
      zoneId: "parent-zone-id"
    });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json()).toMatchObject({ code: "ZONE_MISMATCH" });
    expect(database.listDomains("domain-project-id")).toEqual([]);
    expect(dnsWrites).toEqual([]);
    expect(providerFetch.mock.calls.filter(([input]) => new URL(String(input)).pathname.endsWith("/dns_records"))).toEqual([]);

    const matching = await addDomain({
      hostname: "app.sub.example.com",
      zoneId: "authoritative-zone-id"
    });
    expect(matching.statusCode).toBe(201);
    expect(matching.json().domain).toMatchObject({ hostname: "app.sub.example.com", status: "active" });
    expect(database.listDomains("domain-project-id")[0]).toMatchObject({
      hostname: "app.sub.example.com",
      zone_id: "authoritative-zone-id",
      status: "active"
    });
    expect(dnsWrites[0]).toMatchObject({
      pathname: "/client/v4/zones/authoritative-zone-id/dns_records",
      body: { name: "app.sub.example.com", content: "managed-tunnel-id.cfargotunnel.com" }
    });

    const legacy = await addDomain({ hostname: "legacy.example.com" });
    expect(legacy.statusCode).toBe(201);
    expect(legacy.json().domain).toMatchObject({ hostname: "legacy.example.com", status: "active" });
    expect(database.listDomains("domain-project-id")).toEqual(expect.arrayContaining([
      expect.objectContaining({ hostname: "legacy.example.com", zone_id: "parent-zone-id", status: "active" })
    ]));
    expect(dnsWrites[1]).toMatchObject({
      pathname: "/client/v4/zones/parent-zone-id/dns_records",
      body: { name: "legacy.example.com", content: "managed-tunnel-id.cfargotunnel.com" }
    });
  });

  it("uses a user-selected account from a pending OAuth login", async () => {
    const selectedAccountId = "c".repeat(32);
    const otherAccountId = "d".repeat(32);
    const pendingToken = "pending-oauth-access-token";
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${pendingToken}` });
      expect(url.searchParams.get("account.id")).toBe(selectedAccountId);
      expect(url.searchParams.get("per_page")).toBe("50");
      return Response.json({
        success: true,
        result: [{ id: "selected-zone", name: "selected.example", status: "active" }]
      });
    });
    vi.stubGlobal("fetch", providerFetch);

    const { app, config, database, sessionCookie, userId } = await discoveryApp();
    database.upsertCloudflareOAuthPending({
      user_id: userId,
      encrypted_payload: encryptString(JSON.stringify({
        accessToken: pendingToken,
        refreshToken: "pending-refresh-token",
        tokenType: "Bearer",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: ["zone.read", "dns.write", "offline_access"],
        clientId: "client-id",
        redirectUri: "https://panel.example.com/api/settings/cloudflare/oauth/callback",
        accounts: [
          { id: selectedAccountId, name: "Selected Account" },
          { id: otherAccountId, name: "Other Account" }
        ]
      }), config.APP_SECRET),
      expires_at: new Date(Date.now() + 1_800_000).toISOString(),
      created_at: new Date().toISOString()
    });

    const missingSelection = await app.inject({
      method: "GET",
      url: "/api/settings/cloudflare/zones",
      headers: { cookie: `portsmith_session=${sessionCookie}` }
    });
    expect(missingSelection.statusCode).toBe(400);
    expect(missingSelection.json().code).toBe("CLOUDFLARE_ACCOUNT_REQUIRED");

    const selected = await app.inject({
      method: "GET",
      url: `/api/settings/cloudflare/zones?accountId=${selectedAccountId}`,
      headers: { cookie: `portsmith_session=${sessionCookie}` }
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toEqual({ zones: [{ id: "selected-zone", name: "selected.example" }] });
    expect(selected.body).not.toContain(pendingToken);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });
});
