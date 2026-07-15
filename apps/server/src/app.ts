import fs from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import { Database } from "./lib/database.js";
import { HttpError } from "./lib/errors.js";
import { registerDeploymentRoutes } from "./routes/deployments.js";
import { registerApiTokenRoutes } from "./routes/api-tokens.js";
import { registerOpenApiRoutes } from "./routes/openapi.js";
import { registerGithubRoutes } from "./routes/github.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerServerMetricsRoutes } from "./routes/server-metrics.js";
import { bootstrapAdmin, installAuthHook, registerAuthRoutes } from "./services/auth.js";
import { CloudflareService } from "./services/cloudflare.js";
import { GitHubService } from "./services/github.js";
import { panelHostnames } from "./services/panel-domains.js";
import { reconcileRouting } from "./services/routing.js";
import { registerUploadRoutes, UploadService } from "./services/uploads.js";

export async function createApp(config: AppConfig, database = new Database(config)): Promise<FastifyInstance> {
  await bootstrapAdmin(config, database);
  const redact = {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "request.headers.authorization",
      "request.headers.cookie"
    ],
    remove: true
  };
  const app = Fastify({
    logger: config.NODE_ENV === "development"
      ? { level: config.LOG_LEVEL, redact, transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } } }
      : { level: config.LOG_LEVEL, redact },
    trustProxy: [config.TRUSTED_PROXY_IP, config.TRUSTED_CLOUDFLARED_IP],
    bodyLimit: 11 * 1024 * 1024,
    requestTimeout: 30_000
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, {
    limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 30 }
  });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: 11 * 1024 * 1024 }, (_request, body, done) => {
    done(null, body);
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("server", "Shelter");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    reply.header("x-frame-options", "DENY");
    reply.header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://github.com");
    const requestHost = _request.headers.host?.split(":")[0]?.toLowerCase();
    if (requestHost && panelHostnames(database).includes(requestHost)) {
      reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    return payload;
  });

  installAuthHook(app, database);
  const uploads = new UploadService(config, database);
  const cloudflare = new CloudflareService(config, database);
  const github = new GitHubService(config, database);
  registerAuthRoutes(app, config, database);
  registerOpenApiRoutes(app);
  registerApiTokenRoutes(app, database);
  registerUploadRoutes(app, uploads);
  registerProjectRoutes(app, config, database, uploads, cloudflare, github);
  registerDeploymentRoutes(app, database);
  registerSettingsRoutes(app, cloudflare);
  registerGithubRoutes(app, github);
  registerServerMetricsRoutes(app, config, database);

  app.get("/api/healthz", async () => {
    const heartbeat = database.getSetting("worker.heartbeat");
    return {
      status: "ok",
      worker: heartbeat && Date.now() - new Date(heartbeat).getTime() < 15_000 ? "online" : "offline"
    };
  });

  const staticAvailable = fs.existsSync(path.join(config.WEB_DIST, "index.html"));
  if (staticAvailable) {
    await app.register(fastifyStatic, {
      root: config.WEB_DIST,
      prefix: "/",
      maxAge: "365d",
      immutable: true,
      setHeaders(reply, filePath) {
        const relativePath = path.relative(config.WEB_DIST, filePath);
        const isHashedAsset = relativePath.startsWith(`assets${path.sep}`)
          && /-[A-Za-z0-9_-]{8,}\.[^.]+(?:\.map)?$/.test(path.basename(relativePath));
        if (relativePath === "index.html") reply.header("cache-control", "no-store");
        else if (!isHashedAsset) reply.header("cache-control", "no-cache");
      }
    });
    app.setNotFoundHandler(async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API-Endpunkt nicht gefunden", code: "NOT_FOUND" });
      }
      if (request.method === "GET" && request.headers.accept?.includes("text/html")) {
        reply.header("cache-control", "no-store");
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "Nicht gefunden", code: "NOT_FOUND" });
    });
  }

  app.setErrorHandler(async (error, request, reply) => {
    if (reply.sent) return;
    const normalizedError = error instanceof Error ? error : new Error("Unknown error");
    if (normalizedError instanceof ZodError) {
      return reply.code(400).send({
        error: "Eingaben sind ungültig",
        code: "VALIDATION",
        details: normalizedError.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    if (normalizedError instanceof HttpError) {
      return reply.code(normalizedError.statusCode).send({ error: normalizedError.message, code: normalizedError.code });
    }
    const sqliteCode = (normalizedError as Error & { code?: string }).code;
    if (sqliteCode?.startsWith("SQLITE_CONSTRAINT")) {
      return reply.code(409).send({ error: "Der Eintrag existiert bereits oder verletzt eine Einschränkung", code: "CONFLICT" });
    }
    request.log.error({ err: normalizedError }, "request failed");
    const maybeStatus = (normalizedError as Error & { statusCode?: number }).statusCode;
    const statusCode = typeof maybeStatus === "number" && maybeStatus >= 400 ? maybeStatus : 500;
    const expose = statusCode < 500 || config.NODE_ENV !== "production";
    return reply.code(statusCode).send({
      error: expose ? normalizedError.message : "Interner Serverfehler",
      code: statusCode >= 500 ? "INTERNAL" : "REQUEST_FAILED"
    });
  });

  reconcileRouting(config, database);
  app.addHook("onClose", async () => {
    uploads.close();
    database.close();
  });
  return app;
}
