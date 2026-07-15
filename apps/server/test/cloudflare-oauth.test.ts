import fs from "node:fs";
import http from "node:http";
import { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { ProxyAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { decryptString, encryptString, hashToken } from "../src/lib/security.js";
import { CloudflareOAuthService } from "../src/services/cloudflare-oauth.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Cloudflare OAuth token refresh", () => {
  it("accepts only HTTP(S) OAuth proxy URLs", () => {
    expect(loadConfig({ NODE_ENV: "test", CLOUDFLARE_OAUTH_PROXY_URL: "https://proxy.example.com:8443" })
      .CLOUDFLARE_OAUTH_PROXY_URL).toBe("https://proxy.example.com:8443");
    expect(loadConfig({ NODE_ENV: "test", CLOUDFLARE_OAUTH_PROXY_URL: "" })
      .CLOUDFLARE_OAUTH_PROXY_URL).toBeUndefined();
    expect(() => loadConfig({ NODE_ENV: "test", CLOUDFLARE_OAUTH_PROXY_URL: "socks5://127.0.0.1:1080" }))
      .toThrow(/must use http or https/);
    expect(() => loadConfig({ NODE_ENV: "test", CLOUDFLARE_OAUTH_PROXY_URL: "http://proxy.example.com:3128/path" }))
      .toThrow(/only a proxy origin/);
    expect(() => loadConfig({ NODE_ENV: "test", CLOUDFLARE_OAUTH_PROXY_URL: "http://proxy.example.com:3128/?tenant=one" }))
      .toThrow(/only a proxy origin/);
    expect(() => loadConfig({ NODE_ENV: "test", CLOUDFLARE_OAUTH_PROXY_URL: "http://proxy.example.com:3128/#fragment" }))
      .toThrow(/only a proxy origin/);
    expect(() => loadConfig({ NODE_ENV: "test", CLOUDFLARE_OAUTH_PROXY_URL: "http://user:p%ss@proxy.example.com:3128" }))
      .toThrow(/percent-encoding/);
  });

  it("uses the real undici default fetcher through a local CONNECT proxy", async () => {
    let connectReceived = false;
    let connectTarget: string | undefined;
    const proxy = http.createServer((_request, response) => {
      response.writeHead(500).end();
    });
    proxy.on("connect", (request, socket) => {
      connectReceived = true;
      connectTarget = request.url;
      socket.end(
        "HTTP/1.1 502 Bad Gateway\r\n" +
        "Connection: close\r\n" +
        "Content-Length: 0\r\n\r\n"
      );
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", () => {
        proxy.off("error", reject);
        resolve();
      });
    });

    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-oauth-connect-proxy-"));
    directories.push(dataDirectory);
    const proxyPort = (proxy.address() as AddressInfo).port;
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: dataDirectory,
      APP_SECRET: "q".repeat(64),
      CLOUDFLARE_OAUTH_CLIENT_ID: "client-id",
      CLOUDFLARE_OAUTH_CLIENT_SECRET: "client-secret",
      CLOUDFLARE_OAUTH_REDIRECT_URI: "https://panel.example.com/api/settings/cloudflare/oauth/callback",
      CLOUDFLARE_OAUTH_PROXY_URL: `http://127.0.0.1:${proxyPort}`
    });
    const database = new Database(config);
    database.setSetting("cloudflare.oauth_credentials", encryptString(JSON.stringify({
      accessToken: "expired-access-token",
      refreshToken: "refresh-token",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      scopes: ["account-settings.read", "offline_access"],
      clientId: "client-id",
      redirectUri: "https://panel.example.com/api/settings/cloudflare/oauth/callback",
      accounts: [{ id: "a".repeat(32), name: "Example Account" }]
    }), config.APP_SECRET));
    // Deliberately omit the injectable fetcher: this exercises the production
    // undici.fetch + ProxyAgent pair and catches cross-version dispatcher drift.
    const oauth = new CloudflareOAuthService(config, database);

    try {
      await expect(oauth.accessToken()).rejects.toMatchObject({ code: "CLOUDFLARE_OAUTH_UNREACHABLE" });
      expect(connectReceived).toBe(true);
      expect(connectTarget).toBe("dash.cloudflare.com:443");
    } finally {
      await (oauth as unknown as { oauthProxyAgent?: ProxyAgent }).oauthProxyAgent?.close();
      database.close();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("single-flights concurrent refreshes and persists refresh-token rotation", async () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-oauth-refresh-"));
    directories.push(dataDirectory);
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: dataDirectory,
      APP_SECRET: "r".repeat(64),
      CLOUDFLARE_OAUTH_CLIENT_ID: "client-id",
      CLOUDFLARE_OAUTH_CLIENT_SECRET: "client-secret",
      CLOUDFLARE_OAUTH_REDIRECT_URI: "https://panel.example.com/api/settings/cloudflare/oauth/callback"
    });
    const database = new Database(config);
    database.setSetting("cloudflare.oauth_credentials", encryptString(JSON.stringify({
      accessToken: "expired-access-token",
      refreshToken: "old-refresh-token",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      scopes: ["account-settings.read", "offline_access"],
      clientId: "client-id",
      redirectUri: "https://panel.example.com/api/settings/cloudflare/oauth/callback",
      accounts: [{ id: "a".repeat(32), name: "Example Account" }]
    }), config.APP_SECRET));

    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init && "dispatcher" in init).toBe(false);
      const body = init?.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("old-refresh-token");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({
        access_token: "fresh-access-token",
        refresh_token: "rotated-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "account-settings.read offline_access"
      });
    });
    const oauth = new CloudflareOAuthService(config, database, fetcher as typeof fetch);

    await expect(Promise.all([oauth.accessToken(), oauth.accessToken(), oauth.accessToken()])).resolves.toEqual([
      "fresh-access-token",
      "fresh-access-token",
      "fresh-access-token"
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(decryptString(
      database.getSetting("cloudflare.oauth_credentials")!,
      config.APP_SECRET
    )) as { accessToken: string; refreshToken: string };
    expect(stored).toMatchObject({
      accessToken: "fresh-access-token",
      refreshToken: "rotated-refresh-token"
    });
    expect(database.getSetting("cloudflare.oauth_reconnect_required")).toBeUndefined();
    database.close();
  });

  it("attaches the configured proxy only to token and revocation requests", async () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-oauth-proxy-"));
    directories.push(dataDirectory);
    const redirectUri = "https://panel.example.com/api/settings/cloudflare/oauth/callback";
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: dataDirectory,
      APP_SECRET: "x".repeat(64),
      CLOUDFLARE_OAUTH_CLIENT_ID: "client-id",
      CLOUDFLARE_OAUTH_CLIENT_SECRET: "client-secret",
      CLOUDFLARE_OAUTH_REDIRECT_URI: redirectUri,
      CLOUDFLARE_OAUTH_PROXY_URL: "http://127.0.0.1:3128"
    });
    const database = new Database(config);
    const userId = "admin-user";
    const sessionTokenHash = hashToken("originating-session-token");
    const state = "oauth-state-value";
    const browserNonce = "oauth-browser-nonce";
    const now = new Date();
    database.createUser({
      id: userId,
      email: "admin@example.com",
      password_hash: "test-only",
      created_at: now.toISOString()
    });
    database.createSession({
      token_hash: sessionTokenHash,
      user_id: userId,
      csrf_hash: hashToken("csrf-token"),
      csrf_token: "csrf-token",
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
      created_at: now.toISOString()
    });
    database.createCloudflareOAuthFlow({
      state_hash: hashToken(state),
      browser_nonce_hash: hashToken(browserNonce),
      user_id: userId,
      session_token_hash: sessionTokenHash,
      encrypted_verifier: encryptString("pkce-verifier", config.APP_SECRET),
      redirect_uri: redirectUri,
      client_id: "client-id",
      scopes: "account-settings.read offline_access",
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
      created_at: now.toISOString()
    });

    const calls: Array<{ url: string; dispatcher: unknown }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        dispatcher: (init as RequestInit & { dispatcher?: unknown } | undefined)?.dispatcher
      });
      if (url === "https://dash.cloudflare.com/oauth2/token") {
        return Response.json({
          access_token: "proxied-access-token",
          refresh_token: "proxied-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "account-settings.read offline_access"
        });
      }
      if (url === "https://api.cloudflare.com/client/v4/accounts?per_page=50&page=1") {
        return Response.json({
          success: true,
          result: [{ id: "a".repeat(32), name: "Example Account" }]
        });
      }
      if (url === "https://dash.cloudflare.com/oauth2/revoke") {
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const oauth = new CloudflareOAuthService(config, database, fetcher as typeof fetch);

    await oauth.complete(state, browserNonce, "authorization-code");
    await oauth.disconnect(userId);

    const tokenCall = calls.find((call) => call.url.endsWith("/oauth2/token"));
    const accountCall = calls.find((call) => call.url.includes("/client/v4/accounts?"));
    const revokeCalls = calls.filter((call) => call.url.endsWith("/oauth2/revoke"));
    expect(tokenCall?.dispatcher).toBeInstanceOf(ProxyAgent);
    expect(accountCall?.dispatcher).toBeUndefined();
    expect(revokeCalls).toHaveLength(2);
    expect(revokeCalls.every((call) => call.dispatcher instanceof ProxyAgent)).toBe(true);
    database.close();
  });

  it("serializes disconnect with an in-flight refresh and revokes the rotated credentials", async () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-oauth-disconnect-"));
    directories.push(dataDirectory);
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: dataDirectory,
      APP_SECRET: "d".repeat(64),
      CLOUDFLARE_OAUTH_CLIENT_ID: "client-id",
      CLOUDFLARE_OAUTH_CLIENT_SECRET: "client-secret",
      CLOUDFLARE_OAUTH_REDIRECT_URI: "https://panel.example.com/api/settings/cloudflare/oauth/callback"
    });
    const database = new Database(config);
    database.setSetting("cloudflare.oauth_credentials", encryptString(JSON.stringify({
      accessToken: "expired-access-token",
      refreshToken: "old-refresh-token",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      scopes: ["account-settings.read", "offline_access"],
      clientId: "client-id",
      redirectUri: "https://panel.example.com/api/settings/cloudflare/oauth/callback",
      accounts: [{ id: "a".repeat(32), name: "Example Account" }]
    }), config.APP_SECRET));

    let announceRefresh!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { announceRefresh = resolve; });
    let releaseRefresh!: () => void;
    const refreshMayFinish = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const revoked = new Set<string>();
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://dash.cloudflare.com/oauth2/token") {
        announceRefresh();
        await refreshMayFinish;
        return Response.json({
          access_token: "fresh-access-token",
          refresh_token: "rotated-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "account-settings.read offline_access"
        });
      }
      if (url === "https://dash.cloudflare.com/oauth2/revoke") {
        revoked.add((init?.body as URLSearchParams).get("token") ?? "");
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const oauth = new CloudflareOAuthService(config, database, fetcher as typeof fetch);

    const refreshing = oauth.accessToken();
    await refreshStarted;
    const disconnecting = oauth.disconnect("admin-user");
    await expect(oauth.accessToken()).rejects.toMatchObject({ code: "CLOUDFLARE_DISCONNECTING" });
    releaseRefresh();
    await expect(refreshing).resolves.toBe("fresh-access-token");
    await disconnecting;

    expect(oauth.active()).toBeNull();
    expect(database.getSetting("cloudflare.credentials_disabled")).toBe("1");
    expect(revoked).toEqual(new Set(["fresh-access-token", "rotated-refresh-token"]));
    database.close();
  });

  it("does not overwrite credentials that changed while a refresh was in flight", async () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-oauth-cas-"));
    directories.push(dataDirectory);
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: dataDirectory,
      APP_SECRET: "e".repeat(64),
      CLOUDFLARE_OAUTH_CLIENT_ID: "client-id",
      CLOUDFLARE_OAUTH_CLIENT_SECRET: "client-secret",
      CLOUDFLARE_OAUTH_REDIRECT_URI: "https://panel.example.com/api/settings/cloudflare/oauth/callback"
    });
    const database = new Database(config);
    database.setSetting("cloudflare.oauth_credentials", encryptString(JSON.stringify({
      accessToken: "expired-access-token",
      refreshToken: "old-refresh-token",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      scopes: ["account-settings.read", "offline_access"],
      clientId: "client-id",
      redirectUri: "https://panel.example.com/api/settings/cloudflare/oauth/callback",
      accounts: [{ id: "a".repeat(32), name: "Example Account" }]
    }), config.APP_SECRET));

    let announceRefresh!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { announceRefresh = resolve; });
    let releaseRefresh!: () => void;
    const refreshMayFinish = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "https://dash.cloudflare.com/oauth2/token") {
        announceRefresh();
        await refreshMayFinish;
        return Response.json({
          access_token: "orphaned-access-token",
          refresh_token: "orphaned-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "account-settings.read offline_access"
        });
      }
      if (String(input) === "https://dash.cloudflare.com/oauth2/revoke") {
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    const oauth = new CloudflareOAuthService(config, database, fetcher as typeof fetch);

    const refreshing = oauth.accessToken();
    await refreshStarted;
    database.sqlite.transaction(() => {
      database.deleteSetting("cloudflare.oauth_credentials");
      database.setSetting("cloudflare.credentials_disabled", "1");
    })();
    releaseRefresh();

    await expect(refreshing).rejects.toMatchObject({ code: "CLOUDFLARE_OAUTH_CONNECTION_CHANGED" });
    expect(oauth.active()).toBeNull();
    expect(database.getSetting("cloudflare.oauth_reconnect_required")).toBeUndefined();
    database.close();
  });

  it("activates only the exact pending connection that was validated", () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-oauth-pending-cas-"));
    directories.push(dataDirectory);
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: dataDirectory,
      APP_SECRET: "p".repeat(64),
      CLOUDFLARE_OAUTH_CLIENT_ID: "client-id",
      CLOUDFLARE_OAUTH_CLIENT_SECRET: "client-secret",
      CLOUDFLARE_OAUTH_REDIRECT_URI: "https://panel.example.com/api/settings/cloudflare/oauth/callback"
    });
    const database = new Database(config);
    const userId = "admin-user";
    database.createUser({
      id: userId,
      email: "admin@example.com",
      password_hash: "test-only",
      created_at: new Date().toISOString()
    });
    const connection = (accessToken: string, refreshToken: string) => ({
      accessToken,
      refreshToken,
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scopes: ["account-settings.read", "offline_access"],
      clientId: "client-id",
      redirectUri: "https://panel.example.com/api/settings/cloudflare/oauth/callback",
      accounts: [{ id: "a".repeat(32), name: "Example Account" }]
    });
    const pendingRow = (payload: string) => ({
      user_id: userId,
      encrypted_payload: encryptString(payload, config.APP_SECRET),
      expires_at: new Date(Date.now() + 1_800_000).toISOString(),
      created_at: new Date().toISOString()
    });
    database.upsertCloudflareOAuthPending(pendingRow(JSON.stringify(connection("first-access", "first-refresh"))));
    const oauth = new CloudflareOAuthService(config, database, vi.fn() as unknown as typeof fetch);
    const validated = oauth.pendingCandidate(userId)!;

    database.upsertCloudflareOAuthPending(pendingRow(JSON.stringify(connection("second-access", "second-refresh"))));

    expect(() => oauth.activatePending(userId, validated.version)).toThrow(/zwischenzeitlich ersetzt/);
    expect(database.getSetting("cloudflare.oauth_credentials")).toBeUndefined();
    expect(oauth.pending(userId)?.accessToken).toBe("second-access");
    database.close();
  });
});
