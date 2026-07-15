import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { badRequest, HttpError } from "../lib/errors.js";
import {
  API_TOKEN_PATTERN,
  hashApiToken,
  hashPassword,
  hashToken,
  newId,
  randomToken,
  verifyPassword
} from "../lib/security.js";
import type { ApiTokenScope } from "../types/models.js";
import type { SessionAuthentication } from "../types/fastify.js";
import { panelHostnames } from "./panel-domains.js";

export const SESSION_COOKIE = "shelter_session";
export const LEGACY_SESSION_COOKIE = "portsmith_session";

const API_TOKEN_SCOPES = new Set<ApiTokenScope>([
  "projects:read",
  "projects:write",
  "deployments:write",
  "uploads:write",
  "domains:write",
  "environment:write"
]);

function parseApiTokenScopes(value: string): ApiTokenScope[] | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0 || new Set(parsed).size !== parsed.length) return undefined;
    if (!parsed.every((scope): scope is ApiTokenScope => typeof scope === "string" && API_TOKEN_SCOPES.has(scope as ApiTokenScope))) {
      return undefined;
    }
    return [...new Set(parsed)];
  } catch {
    return undefined;
  }
}

function authorizationHeaderCount(request: FastifyRequest): number {
  let count = 0;
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === "authorization") count += 1;
  }
  return count;
}

function uniqueCookie(request: FastifyRequest, name: string): string | undefined {
  const occurrences = (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (occurrences.length > 1) return undefined;
  return occurrences.length === 1 ? request.cookies[name] : undefined;
}

export async function bootstrapAdmin(config: AppConfig, database: Database): Promise<void> {
  const existingUser = database.sqlite.prepare("SELECT 1 FROM users LIMIT 1").get();
  if (existingUser) return;
  if (!config.ADMIN_PASSWORD) {
    throw new Error("ADMIN_PASSWORD must be set for the initial administrator bootstrap");
  }
  database.createUser({
    id: newId("usr"),
    email: config.ADMIN_EMAIL.toLowerCase(),
    password_hash: await hashPassword(config.ADMIN_PASSWORD),
    created_at: new Date().toISOString()
  });
}

export function installAuthHook(app: FastifyInstance, database: Database): void {
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    request.auth = null;
    const authorization = request.headers.authorization;
    if (authorization !== undefined) {
      if (authorizationHeaderCount(request) !== 1 || authorization.includes(",")) return;
      const match = /^([A-Za-z]+) ([^ ]+)$/.exec(authorization);
      if (match?.[1]?.toLowerCase() !== "bearer" || !match[2] || !API_TOKEN_PATTERN.test(match[2])) return;
      const apiToken = database.getApiTokenByHash(hashApiToken(match[2]));
      if (!apiToken) return;
      const user = database.findUserById(apiToken.user_id);
      const scopes = parseApiTokenScopes(apiToken.scopes_json);
      if (!user || !scopes) return;
      request.auth = {
        kind: "apiToken",
        user,
        apiTokenId: apiToken.id,
        apiTokenName: apiToken.name,
        scopes
      };
      database.touchApiToken(apiToken.id);
      return;
    }
    const token = uniqueCookie(request, SESSION_COOKIE) ?? uniqueCookie(request, LEGACY_SESSION_COOKIE);
    if (!token) return;
    const tokenHash = hashToken(token);
    const session = database.getSession(tokenHash);
    if (!session) return;
    const user = database.findUserById(session.user_id);
    if (!user) return;
    request.auth = {
      kind: "session",
      user,
      sessionTokenHash: tokenHash,
      csrfHash: session.csrf_hash,
      csrfToken: session.csrf_token
    };
  });
}

export function requireScopedAuth(scope: ApiTokenScope) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.auth?.kind === "session" || request.auth?.scopes.includes(scope)) return;
    if (request.auth?.kind === "apiToken") {
      await reply.code(403).send({ error: "API-Token hat nicht die erforderliche Berechtigung", code: "INSUFFICIENT_SCOPE" });
      return;
    }
    await reply.code(401).send({ error: "Nicht angemeldet", code: "UNAUTHORIZED" });
  };
}

export function requireScopedMutation(scope: ApiTokenScope) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.auth?.kind === "apiToken") {
      if (request.auth.scopes.includes(scope)) return;
      await reply.code(403).send({ error: "API-Token hat nicht die erforderliche Berechtigung", code: "INSUFFICIENT_SCOPE" });
      return;
    }
    await requireSessionMutationAuth(request, reply);
  };
}

export async function requireSessionAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.auth?.kind === "session") return;
  if (request.auth?.kind === "apiToken") {
    await reply.code(403).send({ error: "Für diese Aktion ist eine Browser-Sitzung erforderlich", code: "SESSION_REQUIRED" });
    return;
  }
  await reply.code(401).send({ error: "Nicht angemeldet", code: "UNAUTHORIZED" });
}

export async function requireSessionMutationAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.auth?.kind !== "session") {
    if (request.auth?.kind === "apiToken") {
      await reply.code(403).send({ error: "Für diese Aktion ist eine Browser-Sitzung erforderlich", code: "SESSION_REQUIRED" });
      return;
    }
    await reply.code(401).send({ error: "Nicht angemeldet", code: "UNAUTHORIZED" });
    return;
  }
  const csrfToken = request.headers["x-csrf-token"];
  if (typeof csrfToken !== "string" || hashToken(csrfToken) !== request.auth.csrfHash) {
    await reply.code(403).send({ error: "Ungültiger CSRF-Token", code: "CSRF" });
    return;
  }

  const origin = request.headers.origin;
  if (origin) {
    const expectedHost = request.headers.host;
    try {
      if (!expectedHost || new URL(origin).host !== expectedHost) {
        await reply.code(403).send({ error: "Origin stimmt nicht überein", code: "ORIGIN" });
      }
    } catch {
      await reply.code(403).send({ error: "Ungültiger Origin-Header", code: "ORIGIN" });
    }
  }
}

export function sessionAuthentication(request: FastifyRequest): SessionAuthentication {
  if (request.auth?.kind !== "session") {
    throw new HttpError(401, "SESSION_REQUIRED", "Für diese Aktion ist eine Browser-Sitzung erforderlich");
  }
  return request.auth;
}

export function registerAuthRoutes(app: FastifyInstance, config: AppConfig, database: Database): void {
  app.get("/api/auth/session", async (request) => {
    if (request.auth?.kind !== "session") return { user: null, csrfToken: null };
    const csrfToken = request.auth.csrfToken ?? randomToken();
    if (!request.auth.csrfToken) {
      database.sqlite.prepare("UPDATE sessions SET csrf_hash = ?, csrf_token = ? WHERE token_hash = ?").run(
        hashToken(csrfToken), csrfToken, request.auth.sessionTokenHash
      );
    }
    return {
      user: { id: request.auth.user.id, email: request.auth.user.email },
      csrfToken
    };
  });

  app.post<{ Body: { email?: string; username?: string; password?: string } }>("/api/auth/login", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const email = (request.body?.email ?? request.body?.username)?.trim().toLowerCase() ?? "";
    const password = request.body?.password ?? "";
    const user = database.findUserByEmail(email);
    const valid = user ? await verifyPassword(password, user.password_hash) : false;
    if (!user || !valid) {
      await reply.code(401).send({ error: "E-Mail oder Passwort ist falsch", code: "INVALID_CREDENTIALS" });
      return;
    }

    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const now = new Date();
    database.createSession({
      token_hash: hashToken(sessionToken),
      user_id: user.id,
      csrf_hash: hashToken(csrfToken),
      csrf_token: csrfToken,
      expires_at: new Date(now.getTime() + config.SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString(),
      created_at: now.toISOString()
    });

    const forwardedProto = request.headers["x-forwarded-proto"];
    const requestHost = request.headers.host?.split(":")[0]?.toLowerCase();
    const secure =
      (typeof forwardedProto === "string" ? forwardedProto.split(",")[0] : request.protocol) === "https" ||
      (config.NODE_ENV === "production" && Boolean(requestHost) && panelHostnames(database).includes(requestHost!));
    reply.setCookie(SESSION_COOKIE, sessionToken, {
      path: "/",
      httpOnly: true,
      secure,
      sameSite: "strict",
      maxAge: config.SESSION_TTL_HOURS * 60 * 60
    });
    reply.clearCookie(LEGACY_SESSION_COOKIE, { path: "/" });
    return { user: { id: user.id, email: user.email }, csrfToken };
  });

  app.post("/api/auth/logout", { preHandler: requireSessionMutationAuth }, async (request, reply) => {
    const authentication = sessionAuthentication(request);
    database.deleteSession(authentication.sessionTokenHash);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(LEGACY_SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.put<{ Body: unknown }>("/api/auth/password", {
    preHandler: requireSessionMutationAuth,
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request) => {
    const body = request.body as { currentPassword?: unknown; newPassword?: unknown } | null;
    if (typeof body?.currentPassword !== "string" || typeof body.newPassword !== "string") {
      throw badRequest("Aktuelles und neues Passwort sind erforderlich", "PASSWORD_FIELDS_REQUIRED");
    }
    if (body.currentPassword.length > 1024 || body.newPassword.length > 1024) {
      throw badRequest("Das Passwort ist zu lang", "PASSWORD_TOO_LONG");
    }
    if (body.newPassword.length < 16) {
      throw badRequest("Das neue Passwort muss mindestens 16 Zeichen lang sein", "PASSWORD_TOO_SHORT");
    }
    const authentication = sessionAuthentication(request);
    if (!await verifyPassword(body.currentPassword, authentication.user.password_hash)) {
      throw badRequest("Das aktuelle Passwort ist nicht korrekt", "CURRENT_PASSWORD_INVALID");
    }
    if (body.currentPassword === body.newPassword) {
      throw badRequest("Das neue Passwort muss sich vom aktuellen Passwort unterscheiden", "PASSWORD_UNCHANGED");
    }

    const passwordHash = await hashPassword(body.newPassword);
    const invalidated = database.updateUserPasswordAndInvalidateOtherSessions(
      authentication.user.id,
      passwordHash,
      authentication.sessionTokenHash
    );
    return { ok: true, ...invalidated };
  });
}
