import type { FastifyInstance } from "fastify";
import type { Database } from "../lib/database.js";
import { presentDeployment } from "../lib/presenters.js";
import { requireScopedAuth, requireScopedMutation } from "../services/auth.js";

const terminalStatuses = new Set(["ready", "failed", "cancelled"]);

export function registerDeploymentRoutes(app: FastifyInstance, database: Database): void {
  app.get<{ Params: { id: string } }>("/api/deployments/:id", { preHandler: requireScopedAuth("projects:read") }, async (request, reply) => {
    const deployment = database.getDeployment(request.params.id);
    if (!deployment) return reply.code(404).send({ error: "Deployment nicht gefunden", code: "NOT_FOUND" });
    return { deployment: presentDeployment(deployment) };
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/deployments/:id/logs", { preHandler: requireScopedAuth("projects:read") }, async (request, reply) => {
    const deployment = database.getDeployment(request.params.id);
    if (!deployment) return reply.code(404).send({ error: "Deployment nicht gefunden", code: "NOT_FOUND" });
    const after = Math.max(0, Number(request.query.after ?? 0) || 0);
    return {
      logs: database.listLogs(deployment.id, after).map((log) => ({
        id: log.id,
        stream: log.stream,
        message: log.message,
        createdAt: log.created_at
      })),
      status: deployment.status
    };
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/deployments/:id/logs/stream", { preHandler: requireScopedAuth("projects:read") }, async (request, reply) => {
    const initial = database.getDeployment(request.params.id);
    if (!initial) return reply.code(404).send({ error: "Deployment nicht gefunden", code: "NOT_FOUND" });
    let cursor = Math.max(0, Number(request.query.after ?? 0) || 0);
    let closed = false;
    request.raw.once("close", () => { closed = true; });
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    reply.raw.write(": connected\n\n");

    while (!closed) {
      const logs = database.listLogs(initial.id, cursor, 500);
      for (const log of logs) {
        cursor = log.id;
        reply.raw.write(`id: ${log.id}\nevent: log\ndata: ${JSON.stringify({
          id: log.id,
          stream: log.stream,
          message: log.message,
          createdAt: log.created_at
        })}\n\n`);
      }
      const deployment = database.getDeployment(initial.id);
      if (deployment && terminalStatuses.has(deployment.status) && logs.length === 0) {
        reply.raw.write(`event: complete\ndata: ${JSON.stringify({ status: deployment.status })}\n\n`);
        break;
      }
      if (logs.length === 0) reply.raw.write(": keepalive\n\n");
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    reply.raw.end();
  });

  app.post<{ Params: { id: string } }>("/api/deployments/:id/cancel", { preHandler: requireScopedMutation("deployments:write") }, async (request, reply) => {
    const result = database.requestDeploymentCancellation(request.params.id);
    if (result.kind === "not_found") {
      return reply.code(404).send({ error: "Deployment nicht gefunden", code: "NOT_FOUND" });
    }
    if (result.kind === "activating") {
      return reply.code(409).send({
        error: "Deployment wird gerade atomar aktiviert und kann in dieser Phase nicht abgebrochen werden",
        code: "DEPLOYMENT_ACTIVATING"
      });
    }
    if (result.kind === "terminal") {
      return reply.code(409).send({
        error: "Abgeschlossene Deployments können nicht abgebrochen werden",
        code: "DEPLOYMENT_TERMINAL"
      });
    }
    if (result.kind === "already_cancelled") {
      return { deployment: presentDeployment(result.deployment) };
    }
    return reply.code(202).send({ deployment: presentDeployment(result.deployment) });
  });

  app.post<{ Params: { id: string } }>("/api/deployments/:id/rollback", { preHandler: requireScopedMutation("deployments:write") }, async (request, reply) => {
    const result = database.queueRollbackDeployment(request.params.id);
    if (result.kind === "invalid_target") {
      return reply.code(400).send({
        error: "Deployment ist nicht für einen Rollback verfügbar",
        code: "INVALID_ROLLBACK"
      });
    }
    if (result.kind === "project_unavailable") {
      return reply.code(409).send({
        error: "Projekt ist derzeit nicht für einen Rollback verfügbar",
        code: "PROJECT_UNAVAILABLE"
      });
    }
    if (result.kind === "deployment_active") {
      return reply.code(409).send({
        error: "Für dieses Projekt läuft bereits ein Deployment",
        code: "DEPLOYMENT_ACTIVE"
      });
    }
    return reply.code(202).send({ deployment: presentDeployment(result.deployment) });
  });
}
