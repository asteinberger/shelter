import { createHash } from "node:crypto";
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { badRequest, upstreamError } from "../lib/errors.js";
import { decryptString, encryptString, hashToken, randomToken } from "../lib/security.js";

const AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";
const API_BASE_URL = "https://api.cloudflare.com/client/v4";
const FLOW_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 30 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;
const ACCOUNTS_PER_PAGE = 50;
const MAX_OAUTH_ACCOUNTS = 500;

export const CLOUDFLARE_OAUTH_COOKIE = "shelter_cloudflare_oauth_nonce";
export const LEGACY_CLOUDFLARE_OAUTH_COOKIE = "portsmith_cloudflare_oauth_nonce";
export const CLOUDFLARE_OAUTH_CALLBACK_PATH = "/api/settings/cloudflare/oauth/callback";

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.coerce.number().int().positive().max(31_536_000),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional()
});

const OAuthErrorResponseSchema = z.object({
  error: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/)
});

const AccountsEnvelopeSchema = z.object({
  success: z.literal(true),
  result: z.array(z.object({
    id: z.string().regex(/^[a-f0-9]{32}$/i),
    name: z.string().min(1).max(512)
  })).max(ACCOUNTS_PER_PAGE),
  result_info: z.object({
    page: z.coerce.number().int().positive().optional(),
    total_pages: z.coerce.number().int().positive().max(10_000).optional()
  }).optional(),
  errors: z.array(z.object({ code: z.number(), message: z.string() })).optional(),
  messages: z.array(z.object({ code: z.number(), message: z.string() })).optional()
});

const StoredConnectionSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  tokenType: z.literal("Bearer"),
  expiresAt: z.string().datetime(),
  scopes: z.array(z.string().min(1)).min(1),
  clientId: z.string().min(1),
  redirectUri: z.string().url(),
  accounts: z.array(z.object({
    id: z.string().regex(/^[a-f0-9]{32}$/i),
    name: z.string().min(1).max(512)
  })).max(MAX_OAUTH_ACCOUNTS)
});

export type CloudflareOAuthConnection = z.infer<typeof StoredConnectionSchema>;
export type CloudflareOAuthAccount = CloudflareOAuthConnection["accounts"][number];
export interface CloudflareOAuthCandidate {
  connection: CloudflareOAuthConnection;
  version: string;
}

interface StartInput {
  userId: string;
  sessionTokenHash: string;
}

interface OAuthConfiguration {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

function normalizedScopes(value: string): string[] {
  const scopes = [...new Set(value.split(/\s+/).map((scope) => scope.trim()).filter(Boolean))];
  if (!scopes.includes("offline_access")) scopes.push("offline_access");
  return scopes;
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function bearerTokenType(value: string): "Bearer" {
  if (value.toLowerCase() !== "bearer") {
    throw upstreamError("Cloudflare hat einen nicht unterstützten Token-Typ geliefert", "CLOUDFLARE_OAUTH_RESPONSE");
  }
  return "Bearer";
}

export class CloudflareOAuthService {
  private refreshPromise: { expectedCredentials: string; promise: Promise<string> } | undefined;
  private disconnectPromise: Promise<void> | undefined;
  private credentialGeneration = 0;
  private readonly oauthProxyAgent: ProxyAgent | undefined;
  private readonly oauthFetcher: typeof fetch;

  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
    private readonly fetcher: typeof fetch = fetch
  ) {
    this.oauthProxyAgent = config.CLOUDFLARE_OAUTH_PROXY_URL
      ? new ProxyAgent(config.CLOUDFLARE_OAUTH_PROXY_URL)
      : undefined;
    this.oauthFetcher = this.oauthProxyAgent && fetcher === globalThis.fetch
      ? undiciFetch as unknown as typeof fetch
      : fetcher;
  }

  available(): boolean {
    return Boolean(
      this.config.CLOUDFLARE_OAUTH_CLIENT_ID &&
      this.config.CLOUDFLARE_OAUTH_CLIENT_SECRET &&
      this.config.CLOUDFLARE_OAUTH_REDIRECT_URI
    );
  }

  redirectUri(): string | null {
    return this.config.CLOUDFLARE_OAUTH_REDIRECT_URI ?? null;
  }

  start(input: StartInput): { authorizationUrl: string; browserNonce: string; secureCookie: boolean } {
    if (this.disconnectPromise) {
      throw badRequest("Die Cloudflare-Verbindung wird gerade getrennt", "CLOUDFLARE_DISCONNECTING");
    }
    const oauth = this.requireConfiguration();
    const state = randomToken(32);
    const browserNonce = randomToken(32);
    const verifier = randomToken(64);
    const now = new Date();

    this.database.pruneExpiredCloudflareOAuthState();
    this.database.createCloudflareOAuthFlow({
      state_hash: hashToken(state),
      browser_nonce_hash: hashToken(browserNonce),
      user_id: input.userId,
      session_token_hash: input.sessionTokenHash,
      encrypted_verifier: encryptString(verifier, this.config.APP_SECRET),
      redirect_uri: oauth.redirectUri,
      client_id: oauth.clientId,
      scopes: oauth.scopes.join(" "),
      expires_at: new Date(now.getTime() + FLOW_TTL_MS).toISOString(),
      created_at: now.toISOString()
    });

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", oauth.clientId);
    url.searchParams.set("redirect_uri", oauth.redirectUri);
    url.searchParams.set("scope", oauth.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return {
      authorizationUrl: url.toString(),
      browserNonce,
      secureCookie: new URL(oauth.redirectUri).protocol === "https:"
    };
  }

  async complete(state: string, browserNonce: string, code: string): Promise<void> {
    const expectedGeneration = this.credentialGeneration;
    const flow = this.database.consumeCloudflareOAuthFlow(hashToken(state), hashToken(browserNonce));
    if (!flow) {
      throw badRequest("Die Cloudflare-Anmeldung ist abgelaufen oder ungültig", "CLOUDFLARE_OAUTH_FLOW_INVALID");
    }

    const oauth = this.requireConfiguration();
    if (flow.client_id !== oauth.clientId || flow.redirect_uri !== oauth.redirectUri) {
      throw badRequest("Die Cloudflare-OAuth-Konfiguration wurde während der Anmeldung geändert", "CLOUDFLARE_OAUTH_CONFIG_CHANGED");
    }

    const verifier = decryptString(flow.encrypted_verifier, this.config.APP_SECRET);
    const token = await this.requestToken(oauth, {
      grant_type: "authorization_code",
      code,
      redirect_uri: flow.redirect_uri,
      code_verifier: verifier
    });
    let tokenType: "Bearer";
    try {
      tokenType = bearerTokenType(token.token_type);
    } catch (error) {
      await this.revokeTokens(token.access_token, token.refresh_token);
      throw error;
    }
    if (!token.refresh_token) {
      await this.revoke(token.access_token, "access_token").catch(() => undefined);
      throw upstreamError("Cloudflare hat keinen erneuerbaren OAuth-Zugang geliefert", "CLOUDFLARE_OAUTH_RESPONSE");
    }
    if (expectedGeneration !== this.credentialGeneration) {
      await this.revokeTokens(token.access_token, token.refresh_token);
      throw badRequest("Die Cloudflare-Verbindung wurde während der Anmeldung getrennt", "CLOUDFLARE_OAUTH_FLOW_CANCELLED");
    }
    let accounts: CloudflareOAuthAccount[];
    try {
      accounts = await this.listAccounts(token.access_token);
      if (accounts.length === 0) {
        throw badRequest("In diesem Cloudflare-Konto ist kein nutzbarer Account verfügbar", "CLOUDFLARE_NO_ACCOUNTS");
      }
    } catch (error) {
      await this.revokeTokens(token.access_token, token.refresh_token);
      throw error;
    }
    if (expectedGeneration !== this.credentialGeneration) {
      await this.revokeTokens(token.access_token, token.refresh_token);
      throw badRequest("Die Cloudflare-Verbindung wurde während der Anmeldung getrennt", "CLOUDFLARE_OAUTH_FLOW_CANCELLED");
    }
    const now = new Date();
    const tokenExpiresAt = now.getTime() + token.expires_in * 1000;
    const pendingExpiresAt = Math.min(now.getTime() + PENDING_TTL_MS, tokenExpiresAt - TOKEN_REFRESH_SKEW_MS);
    if (pendingExpiresAt <= now.getTime()) {
      await this.revokeTokens(token.access_token, token.refresh_token);
      throw upstreamError("Cloudflare hat einen zu kurz gültigen OAuth-Zugang geliefert", "CLOUDFLARE_OAUTH_RESPONSE");
    }
    const connection: CloudflareOAuthConnection = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenType,
      expiresAt: new Date(tokenExpiresAt).toISOString(),
      scopes: normalizedScopes(token.scope || flow.scopes),
      clientId: flow.client_id,
      redirectUri: flow.redirect_uri,
      accounts
    };
    this.database.upsertCloudflareOAuthPending({
      user_id: flow.user_id,
      encrypted_payload: encryptString(JSON.stringify(connection), this.config.APP_SECRET),
      expires_at: new Date(pendingExpiresAt).toISOString(),
      created_at: now.toISOString()
    });
  }

  cancel(state: string, browserNonce: string): void {
    this.database.consumeCloudflareOAuthFlow(hashToken(state), hashToken(browserNonce));
  }

  pending(userId: string): CloudflareOAuthConnection | null {
    return this.pendingCandidate(userId)?.connection ?? null;
  }

  pendingCandidate(userId: string): CloudflareOAuthCandidate | null {
    const pending = this.database.getCloudflareOAuthPending(userId);
    if (!pending) {
      this.database.pruneExpiredCloudflareOAuthState();
      return null;
    }
    return {
      connection: this.parseConnection(pending.encrypted_payload),
      version: hashToken(pending.encrypted_payload)
    };
  }

  active(): CloudflareOAuthConnection | null {
    return this.activeSnapshot()?.connection ?? null;
  }

  activatePending(userId: string, expectedVersion: string): CloudflareOAuthConnection {
    const pendingRow = this.database.getCloudflareOAuthPending(userId);
    if (!pendingRow) {
      this.database.pruneExpiredCloudflareOAuthState();
      throw badRequest("Die Cloudflare-Anmeldung ist abgelaufen. Bitte erneut verbinden.", "CLOUDFLARE_OAUTH_PENDING_EXPIRED");
    }
    if (hashToken(pendingRow.encrypted_payload) !== expectedVersion) {
      throw badRequest(
        "Die Cloudflare-Anmeldung wurde zwischenzeitlich ersetzt. Bitte die Einrichtung erneut bestätigen.",
        "CLOUDFLARE_OAUTH_PENDING_CHANGED"
      );
    }
    const connection = this.parseConnection(pendingRow.encrypted_payload);
    this.database.setSetting("cloudflare.oauth_credentials", pendingRow.encrypted_payload);
    this.database.setSetting("cloudflare.auth_method", "oauth");
    this.database.deleteSetting("cloudflare.api_token");
    this.database.deleteSetting("cloudflare.oauth_reconnect_required");
    this.database.deleteSetting("cloudflare.credentials_disabled");
    this.database.deleteCloudflareOAuthPending(userId);
    return connection;
  }

  async accessToken(): Promise<string> {
    if (this.disconnectPromise) {
      throw badRequest("Die Cloudflare-Verbindung wird gerade getrennt", "CLOUDFLARE_DISCONNECTING");
    }
    const snapshot = this.activeSnapshot();
    if (!snapshot) {
      throw badRequest("Cloudflare OAuth ist nicht verbunden", "CLOUDFLARE_NOT_CONFIGURED");
    }
    const { connection, encrypted } = snapshot;
    if (new Date(connection.expiresAt).getTime() > Date.now() + TOKEN_REFRESH_SKEW_MS) {
      return connection.accessToken;
    }
    if (!this.refreshPromise || this.refreshPromise.expectedCredentials !== encrypted) {
      const promise = this.refresh(connection, encrypted).finally(() => {
        if (this.refreshPromise?.promise === promise) this.refreshPromise = undefined;
      });
      this.refreshPromise = { expectedCredentials: encrypted, promise };
    }
    return this.refreshPromise.promise;
  }

  reconnectRequired(): boolean {
    const connection = this.active();
    if (!connection) return false;
    if (this.database.getSetting("cloudflare.oauth_reconnect_required") === "1") return true;
    return new Date(connection.expiresAt).getTime() <= Date.now() && !connection.refreshToken;
  }

  expiresAt(): string | null {
    return this.active()?.expiresAt ?? null;
  }

  disconnect(userId: string): Promise<void> {
    if (!this.disconnectPromise) {
      this.credentialGeneration += 1;
      const promise = this.performDisconnect(userId).finally(() => {
        if (this.disconnectPromise === promise) this.disconnectPromise = undefined;
      });
      this.disconnectPromise = promise;
    }
    return this.disconnectPromise;
  }

  private async performDisconnect(userId: string): Promise<void> {
    if (this.refreshPromise) await Promise.allSettled([this.refreshPromise.promise]);
    const tokens: Array<{ token: string; hint: "access_token" | "refresh_token" }> = [];
    let active: CloudflareOAuthConnection | null = null;
    let pending: CloudflareOAuthConnection | null = null;
    try {
      active = this.active();
    } catch {
      // Corrupt local credentials must not prevent a local disconnect.
    }
    try {
      pending = this.pending(userId);
    } catch {
      // Corrupt local pending data is removed below as well.
    }
    if (active?.accessToken) tokens.push({ token: active.accessToken, hint: "access_token" });
    if (active?.refreshToken) tokens.push({ token: active.refreshToken, hint: "refresh_token" });
    if (pending?.accessToken) tokens.push({ token: pending.accessToken, hint: "access_token" });
    if (pending?.refreshToken) tokens.push({ token: pending.refreshToken, hint: "refresh_token" });
    await Promise.allSettled(tokens.map(({ token, hint }) => this.revoke(token, hint)));

    this.database.sqlite.transaction(() => {
      this.database.deleteSetting("cloudflare.api_token");
      this.database.deleteSetting("cloudflare.oauth_credentials");
      this.database.deleteSetting("cloudflare.auth_method");
      this.database.deleteSetting("cloudflare.oauth_reconnect_required");
      this.database.setSetting("cloudflare.credentials_disabled", "1");
      this.database.deleteCloudflareOAuthPending();
      this.database.deleteCloudflareOAuthFlows();
    })();
  }

  resultUrl(result: "connected" | "error"): string {
    const redirectUri = this.redirectUri();
    if (!redirectUri) return `/settings?cloudflare=${result}`;
    const target = new URL("/settings", new URL(redirectUri).origin);
    target.searchParams.set("cloudflare", result);
    return target.toString();
  }

  private requireConfiguration(): OAuthConfiguration {
    if (!this.available()) {
      throw badRequest("Cloudflare OAuth ist auf diesem Server noch nicht vollständig konfiguriert", "CLOUDFLARE_OAUTH_UNAVAILABLE");
    }
    return {
      clientId: this.config.CLOUDFLARE_OAUTH_CLIENT_ID as string,
      clientSecret: this.config.CLOUDFLARE_OAUTH_CLIENT_SECRET as string,
      redirectUri: this.config.CLOUDFLARE_OAUTH_REDIRECT_URI as string,
      scopes: normalizedScopes(this.config.CLOUDFLARE_OAUTH_SCOPES)
    };
  }

  private async refresh(connection: CloudflareOAuthConnection, expectedCredentials: string): Promise<string> {
    if (!connection.refreshToken) {
      this.markReconnectRequiredIfCurrent(expectedCredentials);
      throw badRequest("Die Cloudflare-Verbindung muss erneut autorisiert werden", "CLOUDFLARE_OAUTH_RECONNECT_REQUIRED");
    }
    const oauth = this.requireConfiguration();
    if (connection.clientId !== oauth.clientId) {
      this.markReconnectRequiredIfCurrent(expectedCredentials);
      throw badRequest("Die Cloudflare-OAuth-Konfiguration hat sich geändert", "CLOUDFLARE_OAUTH_RECONNECT_REQUIRED");
    }
    let token: z.infer<typeof TokenResponseSchema>;
    try {
      token = await this.requestToken(oauth, {
        grant_type: "refresh_token",
        refresh_token: connection.refreshToken
      });
    } catch (error) {
      this.markReconnectRequiredIfCurrent(expectedCredentials);
      throw error;
    }

    let updated: CloudflareOAuthConnection;
    try {
      updated = {
        ...connection,
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? connection.refreshToken,
        tokenType: bearerTokenType(token.token_type),
        expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
        scopes: normalizedScopes(token.scope || connection.scopes.join(" "))
      };
    } catch (error) {
      this.markReconnectRequiredIfCurrent(expectedCredentials);
      await this.revokeTokens(token.access_token, token.refresh_token);
      throw error;
    }
    const persisted = this.database.sqlite.transaction(() => {
      if (
        this.database.getSetting("cloudflare.oauth_credentials") !== expectedCredentials ||
        this.database.getSetting("cloudflare.credentials_disabled") === "1"
      ) {
        return false;
      }
      this.database.setSetting(
        "cloudflare.oauth_credentials",
        encryptString(JSON.stringify(updated), this.config.APP_SECRET)
      );
      this.database.deleteSetting("cloudflare.oauth_reconnect_required");
      return true;
    })();
    if (!persisted) {
      await this.revokeTokens(updated.accessToken, updated.refreshToken ?? connection.refreshToken);
      throw badRequest("Die Cloudflare-Verbindung wurde während der Erneuerung geändert", "CLOUDFLARE_OAUTH_CONNECTION_CHANGED");
    }
    return updated.accessToken;
  }

  private async requestToken(
    oauth: OAuthConfiguration,
    parameters: Record<string, string>
  ): Promise<z.infer<typeof TokenResponseSchema>> {
    let response: Response;
    try {
      response = await this.oauthFetcher(TOKEN_URL, this.oauthRequestInit({
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${oauth.clientId}:${oauth.clientSecret}`).toString("base64")}`,
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams(parameters),
        redirect: "error",
        signal: AbortSignal.timeout(20_000)
      }));
    } catch {
      throw upstreamError("Cloudflare OAuth ist derzeit nicht erreichbar", "CLOUDFLARE_OAUTH_UNREACHABLE");
    }
    if (!response.ok) {
      let providerError = "unknown_error";
      try {
        const parsedError = OAuthErrorResponseSchema.safeParse(await response.json());
        if (parsedError.success) providerError = parsedError.data.error;
      } catch {
        // Keep the diagnostic bounded and free of provider response content.
      }
      throw upstreamError(
        `Cloudflare hat die OAuth-Anfrage abgelehnt (${providerError})`,
        "CLOUDFLARE_OAUTH_REJECTED"
      );
    }
    try {
      return TokenResponseSchema.parse(await response.json());
    } catch {
      throw upstreamError("Cloudflare hat eine ungültige OAuth-Antwort geliefert", "CLOUDFLARE_OAUTH_RESPONSE");
    }
  }

  private async listAccounts(accessToken: string): Promise<CloudflareOAuthAccount[]> {
    const accounts: CloudflareOAuthAccount[] = [];
    for (let page = 1; accounts.length < MAX_OAUTH_ACCOUNTS; page += 1) {
      let response: Response;
      try {
        response = await this.fetcher(`${API_BASE_URL}/accounts?per_page=${ACCOUNTS_PER_PAGE}&page=${page}`, {
          headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(20_000)
        });
      } catch {
        throw upstreamError("Cloudflare Accounts sind derzeit nicht erreichbar", "CLOUDFLARE_UNREACHABLE");
      }
      if (!response.ok) {
        throw upstreamError("Cloudflare hat den Account-Zugriff abgelehnt", "CLOUDFLARE_OAUTH_REJECTED");
      }
      let envelope: z.infer<typeof AccountsEnvelopeSchema>;
      try {
        envelope = AccountsEnvelopeSchema.parse(await response.json());
      } catch {
        throw upstreamError("Cloudflare hat eine ungültige Account-Antwort geliefert", "CLOUDFLARE_API");
      }
      accounts.push(...envelope.result);
      const totalPages = envelope.result_info?.total_pages;
      if (envelope.result.length < ACCOUNTS_PER_PAGE || (totalPages !== undefined && page >= totalPages)) {
        return accounts;
      }
    }
    throw badRequest(
      `Die Cloudflare-Anmeldung umfasst mehr als ${MAX_OAUTH_ACCOUNTS} Accounts. Bitte den OAuth-Zugriff enger begrenzen.`,
      "CLOUDFLARE_TOO_MANY_ACCOUNTS"
    );
  }

  private async revoke(token: string, tokenTypeHint: "access_token" | "refresh_token"): Promise<void> {
    if (!this.available()) return;
    const oauth = this.requireConfiguration();
    const response = await this.oauthFetcher(REVOKE_URL, this.oauthRequestInit({
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${oauth.clientId}:${oauth.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ token, token_type_hint: tokenTypeHint }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    }));
    if (!response.ok) throw new Error("Cloudflare token revocation failed");
  }

  private oauthRequestInit(init: RequestInit): RequestInit {
    if (!this.oauthProxyAgent) return init;
    return { ...init, dispatcher: this.oauthProxyAgent } as RequestInit & { dispatcher: Dispatcher };
  }

  private async revokeTokens(accessToken: string, refreshToken?: string): Promise<void> {
    await Promise.allSettled([
      this.revoke(accessToken, "access_token"),
      ...(refreshToken ? [this.revoke(refreshToken, "refresh_token")] : [])
    ]);
  }

  private parseConnection(encrypted: string): CloudflareOAuthConnection {
    try {
      return StoredConnectionSchema.parse(JSON.parse(decryptString(encrypted, this.config.APP_SECRET)));
    } catch {
      throw new Error("Stored Cloudflare OAuth credentials are invalid");
    }
  }

  private activeSnapshot(): { encrypted: string; connection: CloudflareOAuthConnection } | null {
    const encrypted = this.database.getSetting("cloudflare.oauth_credentials");
    return encrypted ? { encrypted, connection: this.parseConnection(encrypted) } : null;
  }

  private markReconnectRequiredIfCurrent(expectedCredentials: string): void {
    this.database.sqlite.transaction(() => {
      if (
        this.database.getSetting("cloudflare.oauth_credentials") === expectedCredentials &&
        this.database.getSetting("cloudflare.credentials_disabled") !== "1"
      ) {
        this.database.setSetting("cloudflare.oauth_reconnect_required", "1");
      }
    })();
  }
}
