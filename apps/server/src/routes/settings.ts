import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  requireScopedAuth,
  requireSessionAuth,
  requireSessionMutationAuth,
  sessionAuthentication
} from "../services/auth.js";
import type { CloudflareService } from "../services/cloudflare.js";
import {
  CLOUDFLARE_OAUTH_CALLBACK_PATH,
  CLOUDFLARE_OAUTH_COOKIE,
  LEGACY_CLOUDFLARE_OAUTH_COOKIE
} from "../services/cloudflare-oauth.js";

const CloudflareSetupSchema = z.object({
  accountId: z.string().trim().min(1),
  apiToken: z.string().trim().optional().transform((value) => value || undefined),
  tunnelName: z.string().trim().optional(),
  panelDomain: z.string().trim().optional().transform((value) => value || undefined)
});

const CloudflareAccountIdSchema = z.string().trim().regex(/^[a-f0-9]{32}$/i);
const CloudflareZoneIdSchema = z.string().trim().min(1).max(128);

const CloudflareZonesQuerySchema = z.object({
  accountId: CloudflareAccountIdSchema.optional()
}).strict();

const CloudflareHostnameCheckSchema = z.object({
  hostname: z.string().max(2048),
  accountId: CloudflareAccountIdSchema.optional(),
  zoneId: CloudflareZoneIdSchema.optional()
}).strict();

export function registerSettingsRoutes(app: FastifyInstance, cloudflare: CloudflareService): void {
  app.get("/api/settings/cloudflare", { preHandler: requireSessionAuth }, async (request) => ({
    cloudflare: cloudflare.state(request.auth?.user.id)
  }));

  app.put<{ Body: unknown }>("/api/settings/cloudflare", { preHandler: requireSessionMutationAuth }, async (request) => {
    const input = CloudflareSetupSchema.parse(request.body);
    const setupInput: Parameters<CloudflareService["setup"]>[0] = { accountId: input.accountId };
    if (input.apiToken !== undefined) setupInput.apiToken = input.apiToken;
    if (input.tunnelName !== undefined) setupInput.tunnelName = input.tunnelName;
    if (input.panelDomain !== undefined) setupInput.panelDomain = input.panelDomain;
    const state = await cloudflare.setup(setupInput, request.auth?.user.id);
    return { cloudflare: state };
  });

  app.post("/api/settings/cloudflare/test", { preHandler: requireSessionMutationAuth }, async () => cloudflare.test());

  app.get<{ Querystring: unknown }>("/api/settings/cloudflare/zones", {
    preHandler: requireScopedAuth("domains:write"),
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const query = CloudflareZonesQuerySchema.parse(request.query);
    reply.header("cache-control", "no-store");
    return {
      zones: await cloudflare.listZones({
        userId: request.auth!.user.id,
        ...(query.accountId ? { accountId: query.accountId } : {})
      })
    };
  });

  app.post<{ Body: unknown }>("/api/settings/cloudflare/hostname/check", {
    preHandler: requireScopedAuth("domains:write"),
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const input = CloudflareHostnameCheckSchema.parse(request.body);
    reply.header("cache-control", "no-store");
    return cloudflare.checkHostname(input.hostname, {
      userId: request.auth!.user.id,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.zoneId ? { zoneId: input.zoneId } : {})
    });
  });

  app.post("/api/settings/cloudflare/oauth/start", {
    preHandler: requireSessionMutationAuth,
    config: { rateLimit: { max: 5, timeWindow: "10 minutes" } }
  }, async (request, reply) => {
    if (request.body !== undefined && request.body !== null) {
      return reply.code(400).send({ error: "Diese Anfrage akzeptiert keinen Body", code: "UNEXPECTED_BODY" });
    }
    const authentication = sessionAuthentication(request);
    const started = cloudflare.startOAuth(authentication.user.id, authentication.sessionTokenHash);
    reply.setCookie(CLOUDFLARE_OAUTH_COOKIE, started.browserNonce, {
      path: CLOUDFLARE_OAUTH_CALLBACK_PATH,
      httpOnly: true,
      secure: started.secureCookie,
      sameSite: "lax",
      maxAge: 10 * 60
    });
    reply.clearCookie(LEGACY_CLOUDFLARE_OAUTH_COOKIE, { path: CLOUDFLARE_OAUTH_CALLBACK_PATH });
    reply.header("cache-control", "no-store");
    return { authorizationUrl: started.authorizationUrl };
  });

  app.get(CLOUDFLARE_OAUTH_CALLBACK_PATH, {
    logLevel: "silent",
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    onSend: async (_request, callbackReply, payload) => {
      callbackReply.header("referrer-policy", "no-referrer");
      return payload;
    }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("pragma", "no-cache");
    reply.header("referrer-policy", "no-referrer");
    reply.clearCookie(CLOUDFLARE_OAUTH_COOKIE, { path: CLOUDFLARE_OAUTH_CALLBACK_PATH });
    reply.clearCookie(LEGACY_CLOUDFLARE_OAUTH_COOKIE, { path: CLOUDFLARE_OAUTH_CALLBACK_PATH });

    const fail = () => reply.redirect(cloudflare.oauthResultUrl("error"), 303);
    try {
      const query = new URL(request.raw.url ?? CLOUDFLARE_OAUTH_CALLBACK_PATH, "http://shelter.invalid").searchParams;
      const states = query.getAll("state");
      const codes = query.getAll("code");
      const errors = query.getAll("error");
      const rawCookieHeader = request.headers.cookie ?? "";
      const nonceCookies = rawCookieHeader
        .split(";")
        .map((part) => part.trim())
        .filter((part) => (
          part.startsWith(`${CLOUDFLARE_OAUTH_COOKIE}=`) ||
          part.startsWith(`${LEGACY_CLOUDFLARE_OAUTH_COOKIE}=`)
        ));
      const browserNonce = request.cookies[CLOUDFLARE_OAUTH_COOKIE]
        ?? request.cookies[LEGACY_CLOUDFLARE_OAUTH_COOKIE];
      if (
        states.length !== 1 ||
        states[0]!.length < 16 ||
        states[0]!.length > 512 ||
        nonceCookies.length !== 1 ||
        !browserNonce ||
        browserNonce.length > 512 ||
        codes.length > 1 ||
        errors.length > 1 ||
        (codes.length === 1) === (errors.length === 1)
      ) {
        return fail();
      }

      const state = states[0]!;
      if (errors.length === 1) {
        cloudflare.cancelOAuth(state, browserNonce);
        return fail();
      }
      const code = codes[0]!;
      if (code.length < 1 || code.length > 4096) return fail();
      await cloudflare.completeOAuth(state, browserNonce, code);
      return reply.redirect(cloudflare.oauthResultUrl("connected"), 303);
    } catch (error) {
      const oauthError = error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            code: "code" in error && typeof error.code === "string" ? error.code : undefined
          }
        : { name: "UnknownError", message: "Unbekannter Cloudflare-OAuth-Fehler" };
      app.log.warn({ oauthError }, "Cloudflare OAuth callback failed");
      return fail();
    }
  });

  app.delete("/api/settings/cloudflare/connection", {
    preHandler: requireSessionMutationAuth,
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request) => ({
    cloudflare: await cloudflare.disconnect(request.auth!.user.id)
  }));
}
