import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Database } from "../lib/database.js";
import { badRequest, notFound } from "../lib/errors.js";
import { hashApiToken, issueApiToken, newId, verifyPassword } from "../lib/security.js";
import {
  requireScopedAuth,
  requireSessionAuth,
  requireSessionMutationAuth,
  sessionAuthentication
} from "../services/auth.js";
import type { ApiTokenMetadataRow, ApiTokenRow, ApiTokenScope } from "../types/models.js";

const CreateApiTokenSchema = z.object({
  name: z.string().trim().min(2).max(80),
  access: z.enum(["read", "write"]).default("write"),
  expiresInDays: z.number().int().min(1).max(365).default(90),
  currentPassword: z.string().min(1).max(1024)
}).strict();

const ApiTokenParamsSchema = z.object({
  id: z.string().regex(/^tok_[a-f0-9]{32}$/)
}).strict();

function scopesForAccess(access: "read" | "write"): ApiTokenScope[] {
  return access === "write"
    ? ["projects:read", "projects:write", "deployments:write", "uploads:write", "domains:write", "environment:write"]
    : ["projects:read"];
}

function parsedScopes(row: ApiTokenRow | ApiTokenMetadataRow): ApiTokenScope[] {
  return JSON.parse(row.scopes_json) as ApiTokenScope[];
}

function presentApiToken(row: ApiTokenRow | ApiTokenMetadataRow) {
  return {
    id: row.id,
    name: row.name,
    displayHint: `shelter_pat_v1_••••${row.token_hint}`,
    scopes: parsedScopes(row),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at
  };
}

function preventCaching(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
}

export function registerApiTokenRoutes(app: FastifyInstance, database: Database): void {
  app.get("/api/settings/api-tokens", { preHandler: requireSessionAuth }, async (request, reply) => {
    const authentication = sessionAuthentication(request);
    preventCaching(reply);
    return { apiTokens: database.listApiTokens(authentication.user.id).map(presentApiToken) };
  });

  app.post<{ Body: unknown }>("/api/settings/api-tokens", {
    preHandler: requireSessionMutationAuth,
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const authentication = sessionAuthentication(request);
    const input = CreateApiTokenSchema.parse(request.body);
    if (!await verifyPassword(input.currentPassword, authentication.user.password_hash)) {
      throw badRequest("Das aktuelle Passwort ist nicht korrekt", "CURRENT_PASSWORD_INVALID");
    }
    const issued = issueApiToken();
    const now = new Date();
    const row: ApiTokenRow = {
      id: newId("tok"),
      user_id: authentication.user.id,
      name: input.name,
      token_hash: hashApiToken(issued.token),
      token_hint: issued.hint,
      scopes_json: JSON.stringify(scopesForAccess(input.access)),
      expires_at: new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60_000).toISOString(),
      last_used_at: null,
      revoked_at: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    };
    database.createApiToken(row);
    preventCaching(reply);
    return reply.code(201).send({ apiToken: presentApiToken(row), secret: issued.token });
  });

  app.delete<{ Params: unknown }>("/api/settings/api-tokens/:id", {
    preHandler: requireSessionMutationAuth
  }, async (request, reply) => {
    const authentication = sessionAuthentication(request);
    const { id } = ApiTokenParamsSchema.parse(request.params);
    if (!database.revokeApiToken(id, authentication.user.id)) {
      throw notFound("API-Token nicht gefunden", "API_TOKEN_NOT_FOUND");
    }
    preventCaching(reply);
    return reply.code(204).send();
  });

  app.get("/api/api-tokens/current", { preHandler: requireScopedAuth("projects:read") }, async (request, reply) => {
    preventCaching(reply);
    if (request.auth?.kind === "apiToken") {
      return {
        authentication: {
          type: "api_token",
          token: {
            id: request.auth.apiTokenId,
            name: request.auth.apiTokenName,
            scopes: request.auth.scopes
          }
        },
        user: { id: request.auth.user.id, email: request.auth.user.email }
      };
    }
    return {
      authentication: { type: "session" },
      user: request.auth ? { id: request.auth.user.id, email: request.auth.user.email } : null
    };
  });
}
