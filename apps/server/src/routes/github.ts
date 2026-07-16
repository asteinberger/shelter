import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError } from "../lib/errors.js";
import { requireSessionAuth, requireSessionMutationAuth, sessionAuthentication } from "../services/auth.js";
import {
  GITHUB_MANIFEST_CALLBACK_PATH,
  GITHUB_MANIFEST_COOKIE,
  GITHUB_SETUP_CALLBACK_PATH,
  LEGACY_GITHUB_MANIFEST_COOKIE,
  type GitHubService
} from "../services/github.js";

const NumericId = z.string().regex(/^\d{1,20}$/);
const AnalysisBranch = z.string().trim().min(1).max(160).refine((branch) => (
  !branch.startsWith("-")
  && !branch.startsWith("/")
  && !branch.endsWith("/")
  && !branch.endsWith(".")
  && !branch.includes("..")
  && !branch.includes("@{")
  && !/[\u0000-\u0020~^:?*[\\]/.test(branch)
), "Git branch is invalid");

function queryValues(rawUrl: string | undefined, key: string): string[] {
  return new URL(rawUrl ?? "/", "http://shelter.invalid").searchParams.getAll(key);
}

function cookieOccurrences(header: string, cookieName: string): number {
  return header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`)).length;
}

function manifestCookie(request: Pick<FastifyRequest, "headers" | "cookies">): string | undefined {
  const header = request.headers.cookie ?? "";
  const currentCount = cookieOccurrences(header, GITHUB_MANIFEST_COOKIE);
  const legacyCount = cookieOccurrences(header, LEGACY_GITHUB_MANIFEST_COOKIE);
  if (currentCount + legacyCount !== 1) return undefined;
  return currentCount === 1
    ? request.cookies[GITHUB_MANIFEST_COOKIE]
    : request.cookies[LEGACY_GITHUB_MANIFEST_COOKIE];
}

function callbackHeaders(reply: { header(name: string, value: string): unknown }): void {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("referrer-policy", "no-referrer");
}

export function registerGithubRoutes(app: FastifyInstance, github: GitHubService): void {
  app.get("/api/settings/github", { preHandler: requireSessionAuth }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const state = github.state();
    if (!state.configured) return {
      github: {
        ...state,
        installations: [],
        previewCapability: {
          ready: false,
          configured: false,
          pullRequestsPermission: false,
          pullRequestEvent: false,
          remediation: "configure_app"
        },
        error: null
      }
    };
    try {
      const [installations, previewCapability] = await Promise.all([
        github.installations(),
        github.previewCapability()
      ]);
      return {
        github: {
          ...state,
          connected: installations.some((installation) => !installation.suspendedAt),
          installations,
          previewCapability,
          error: null
        }
      };
    } catch {
      return {
        github: {
          ...state,
          connected: false,
          installations: [],
          previewCapability: null,
          error: "GitHub konnte gerade nicht erreicht werden. Die App-Verbindung bleibt gespeichert."
        }
      };
    }
  });

  app.get("/api/settings/github/preview-capability", {
    preHandler: requireSessionAuth,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { previewCapability: await github.previewCapability() };
  });

  app.post("/api/settings/github/manifest/start", {
    preHandler: requireSessionMutationAuth,
    config: { rateLimit: { max: 5, timeWindow: "10 minutes" } }
  }, async (request, reply) => {
    if (request.body !== undefined && request.body !== null) {
      throw new HttpError(400, "UNEXPECTED_BODY", "Diese Anfrage akzeptiert keinen Body");
    }
    const authentication = sessionAuthentication(request);
    const started = github.startManifest(authentication.user.id, authentication.sessionTokenHash);
    reply.setCookie(GITHUB_MANIFEST_COOKIE, started.browserNonce, {
      path: GITHUB_MANIFEST_CALLBACK_PATH,
      httpOnly: true,
      secure: started.secureCookie,
      sameSite: "lax",
      maxAge: 10 * 60
    });
    reply.clearCookie(LEGACY_GITHUB_MANIFEST_COOKIE, { path: GITHUB_MANIFEST_CALLBACK_PATH });
    reply.header("cache-control", "no-store");
    return { registrationUrl: started.registrationUrl, manifest: started.manifest };
  });

  app.get(GITHUB_MANIFEST_CALLBACK_PATH, {
    logLevel: "silent",
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    onSend: async (_request, reply, payload) => {
      callbackHeaders(reply);
      return payload;
    }
  }, async (request, reply) => {
    callbackHeaders(reply);
    reply.clearCookie(GITHUB_MANIFEST_COOKIE, { path: GITHUB_MANIFEST_CALLBACK_PATH });
    reply.clearCookie(LEGACY_GITHUB_MANIFEST_COOKIE, { path: GITHUB_MANIFEST_CALLBACK_PATH });
    const fail = (): ReturnType<typeof reply.redirect> => reply.redirect(github.resultUrl("error"), 303);
    try {
      const states = queryValues(request.raw.url, "state");
      const codes = queryValues(request.raw.url, "code");
      const errors = queryValues(request.raw.url, "error");
      const browserNonce = manifestCookie(request);
      if (
        states.length !== 1 || states[0]!.length < 16 || states[0]!.length > 512 ||
        !browserNonce || browserNonce.length > 512 ||
        codes.length > 1 || errors.length > 1 ||
        (codes.length === 1) === (errors.length === 1)
      ) return fail();
      if (errors.length === 1) {
        github.cancelManifest(states[0]!, browserNonce);
        return fail();
      }
      const code = codes[0]!;
      if (code.length < 1 || code.length > 4096) return fail();
      const completed = await github.completeManifest(states[0]!, browserNonce, code);
      return reply.redirect(completed.installUrl, 303);
    } catch (error) {
      app.log.warn({
        githubError: error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownError" }
      }, "GitHub App manifest callback failed");
      return fail();
    }
  });

  app.get(GITHUB_SETUP_CALLBACK_PATH, {
    logLevel: "silent",
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    onSend: async (_request, reply, payload) => {
      callbackHeaders(reply);
      return payload;
    }
  }, async (request, reply) => {
    callbackHeaders(reply);
    const fail = (): ReturnType<typeof reply.redirect> => reply.redirect(github.resultUrl("error"), 303);
    try {
      const states = queryValues(request.raw.url, "state");
      const installations = queryValues(request.raw.url, "installation_id");
      const actions = queryValues(request.raw.url, "setup_action");
      if (
        states.length !== 1 || states[0]!.length < 16 || states[0]!.length > 512 ||
        installations.length !== 1 || !/^\d{1,20}$/.test(installations[0]!) ||
        actions.length > 1 || (actions.length === 1 && !["install", "update"].includes(actions[0]!))
      ) return fail();
      await github.completeSetup(states[0]!, installations[0]!);
      return reply.redirect(github.resultUrl("installed"), 303);
    } catch (error) {
      app.log.warn({
        githubError: error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownError" }
      }, "GitHub App setup callback failed");
      return fail();
    }
  });

  app.delete("/api/settings/github/connection", {
    preHandler: requireSessionMutationAuth,
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async () => ({ github: await github.disconnect() }));

  app.get("/api/settings/github/repositories", {
    preHandler: requireSessionAuth,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return github.repositories();
  });

  app.get<{ Params: { installationId: string; repositoryId: string } }>(
    "/api/settings/github/repositories/:installationId/:repositoryId/branches",
    {
      preHandler: requireSessionAuth,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
    },
    async (request, reply) => {
      const params = z.object({ installationId: NumericId, repositoryId: NumericId }).strict().parse(request.params);
      reply.header("cache-control", "no-store");
      return { branches: await github.branches(params.installationId, params.repositoryId) };
    }
  );

  app.get<{
    Params: { installationId: string; repositoryId: string };
    Querystring: { branch?: string };
  }>(
    "/api/settings/github/repositories/:installationId/:repositoryId/analysis",
    {
      preHandler: requireSessionAuth,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
    },
    async (request, reply) => {
      const params = z.object({ installationId: NumericId, repositoryId: NumericId }).strict().parse(request.params);
      const query = z.object({ branch: AnalysisBranch }).strict().parse(request.query);
      reply.header("cache-control", "no-store");
      return {
        analysis: await github.analyzeRepository(params.installationId, params.repositoryId, query.branch)
      };
    }
  );

  void app.register(async (webhookApp) => {
    webhookApp.removeContentTypeParser("application/json");
    webhookApp.addContentTypeParser("application/json", {
      parseAs: "buffer",
      bodyLimit: 25 * 1024 * 1024
    }, (_request, body, done) => done(null, body));
    webhookApp.post<{ Body: Buffer }>("/api/webhooks/github", {
      bodyLimit: 25 * 1024 * 1024,
      config: { rateLimit: { max: 300, timeWindow: "1 minute" } }
    }, async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) {
        throw new HttpError(400, "GITHUB_PAYLOAD_INVALID", "GitHub-Webhook muss JSON enthalten");
      }
      const signature = request.headers["x-hub-signature-256"];
      const eventName = request.headers["x-github-event"];
      const deliveryId = request.headers["x-github-delivery"];
      github.verifyWebhook(request.body, typeof signature === "string" ? signature : undefined);
      if (typeof eventName !== "string" || typeof deliveryId !== "string") {
        throw new HttpError(400, "GITHUB_HEADERS_REQUIRED", "GitHub-Webhook-Header fehlen");
      }
      const result = await github.handleWebhook(eventName, deliveryId, request.body);
      return reply.code(202).send({ ok: true, ...result });
    });
  });
}
