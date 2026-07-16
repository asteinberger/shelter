import type { FastifyInstance } from "fastify";

const bearerSecurity = [{ bearerAuth: [] }];
const sessionSecurity = [{ sessionCookie: [] }];
const errorResponse = {
  description: "Request failed",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" }
    }
  }
};

export function registerOpenApiRoutes(app: FastifyInstance): void {
  app.get("/api", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return {
      name: "Shelter API",
      version: "1.0.0",
      documentation: "/api/openapi.json",
      authentication: "Bearer shelter_pat_v1_…"
    };
  });

  app.get("/api/openapi.json", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return {
      openapi: "3.1.0",
      info: {
        title: "Shelter API",
        version: "1.0.0",
        description: "Automate projects, deployments, uploads, logs, and domains on a Shelter installation."
      },
      servers: [{ url: "/", description: "This Shelter installation" }],
      tags: [
        { name: "System" },
        { name: "Projects" },
        { name: "Observability" },
        { name: "Deployments" },
        { name: "Uploads" },
        { name: "Domains" }
      ],
      paths: {
        "/api/healthz": {
          get: { tags: ["System"], summary: "Check Shelter and worker health", responses: { "200": { description: "Health state" } } }
        },
        "/api/server/metrics": {
          get: {
            tags: ["System"], summary: "Read bounded server metrics", security: sessionSecurity,
            parameters: [{ name: "range", in: "query", schema: { type: "string", enum: ["1h", "6h", "24h"], default: "1h" } }],
            responses: { "200": { description: "Current metrics, health, activity, and downsampled history" }, "401": errorResponse, "403": errorResponse }
          }
        },
        "/api/api-tokens/current": {
          get: { tags: ["System"], summary: "Verify the current API token", security: bearerSecurity, responses: { "200": { description: "Token identity" }, "401": errorResponse } }
        },
        "/api/projects": {
          get: { tags: ["Projects"], summary: "List projects", security: bearerSecurity, responses: { "200": { description: "Project list" }, "401": errorResponse, "403": errorResponse } }
        },
        "/api/projects/analyze": {
          post: {
            tags: ["Projects"], summary: "Analyze bounded project file facts before deployment", security: bearerSecurity,
            description: "Accepts at most 10,000 safe relative paths and 512 KiB of allowlisted configuration content. Real .env files are never accepted.",
            requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["files"], properties: { files: { type: "array", maxItems: 10000, items: { $ref: "#/components/schemas/ProjectFileFact" } } } } } } },
            responses: { "200": { description: "Detected applications", content: { "application/json": { schema: { type: "object", required: ["analysis"], properties: { analysis: { $ref: "#/components/schemas/ProjectAnalysis" } } } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "413": errorResponse }
          }
        },
        "/api/projects/git": {
          post: {
            tags: ["Projects"], summary: "Create a project from a public HTTPS Git repository", security: bearerSecurity,
            requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/GitProjectInput" } } } },
            responses: { "201": { description: "Project and queued deployment" }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "409": errorResponse }
          }
        },
        "/api/projects/{projectId}": {
          parameters: [{ $ref: "#/components/parameters/ProjectId" }],
          get: { tags: ["Projects"], summary: "Get a project", security: bearerSecurity, responses: { "200": { description: "Project detail" }, "404": errorResponse } },
          patch: { tags: ["Projects"], summary: "Update project settings", security: bearerSecurity, requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": { description: "Updated project" }, "400": errorResponse, "409": errorResponse } },
          delete: { tags: ["Projects"], summary: "Delete a project", security: bearerSecurity, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["confirmation"], properties: { confirmation: { type: "string" } } } } } }, responses: { "200": { description: "Deletion state" }, "409": errorResponse } }
        },
        "/api/projects/{projectId}/deploy": {
          parameters: [{ $ref: "#/components/parameters/ProjectId" }],
          post: { tags: ["Deployments"], summary: "Deploy the current project source", security: bearerSecurity, requestBody: { content: { "application/json": { schema: { type: "object", properties: { staticBasePath: { type: ["string", "null"] } } } } } }, responses: { "202": { description: "Queued deployment" }, "409": errorResponse } }
        },
        "/api/projects/{projectId}/observability": {
          parameters: [
            { $ref: "#/components/parameters/ProjectId" },
            { name: "range", in: "query", schema: { type: "string", enum: ["15m", "1h", "6h", "24h", "48h"], default: "1h" } }
          ],
          get: {
            tags: ["Observability"],
            summary: "Read bounded active-runtime metrics for one project",
            description: "Administrator session only. Returns current container state, actionable warnings, and at most 180 downsampled history points. Docker access remains isolated in the worker.",
            security: sessionSecurity,
            responses: { "200": { description: "Current project runtime metrics and history" }, "401": errorResponse, "403": errorResponse, "404": errorResponse }
          }
        },
        "/api/projects/{projectId}/runtime-logs": {
          parameters: [
            { $ref: "#/components/parameters/ProjectId" },
            { name: "after", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 500 } }
          ],
          get: {
            tags: ["Observability"],
            summary: "Read bounded application output from the active deployment",
            description: "Administrator session only. Runtime output is separate from deployment logs. Shelter stores at most 5,000 lines per project for the configured metrics retention window and returns at most 500 lines. Exact configured environment values are redacted, but applications can still emit other sensitive data.",
            security: sessionSecurity,
            responses: { "200": { description: "Active deployment runtime-log records" }, "401": errorResponse, "403": errorResponse, "404": errorResponse }
          }
        },
        "/api/projects/{projectId}/runtime-logs/stream": {
          parameters: [
            { $ref: "#/components/parameters/ProjectId" },
            { name: "after", in: "query", schema: { type: "integer", minimum: 0, default: 0 } }
          ],
          get: {
            tags: ["Observability"],
            summary: "Follow worker-collected active-runtime output over SSE",
            description: "Administrator session only. The worker polls Docker at the configured metrics interval; this stream forwards persisted records and is near-live rather than instantaneous. Connections rotate after ten minutes and are rate-limited.",
            security: sessionSecurity,
            responses: { "200": { description: "text/event-stream with log, deployment, reconnect, and complete events" }, "401": errorResponse, "403": errorResponse, "404": errorResponse }
          }
        },
        "/api/projects/{projectId}/rollback": {
          parameters: [{ $ref: "#/components/parameters/ProjectId" }],
          post: {
            tags: ["Deployments"], summary: "Queue a rollback to a ready deployment", security: bearerSecurity,
            requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["deploymentId"], properties: { deploymentId: { type: "string", pattern: "^dep_" } } } } } },
            responses: { "202": { description: "Queued rollback deployment" }, "400": errorResponse, "404": errorResponse, "409": errorResponse }
          }
        },
        "/api/projects/{projectId}/source": {
          parameters: [{ $ref: "#/components/parameters/ProjectId" }],
          put: { tags: ["Uploads"], summary: "Replace an upload project's source", security: bearerSecurity, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["uploadId"], properties: { uploadId: { type: "string" }, staticBasePath: { type: ["string", "null"] } } } } } }, responses: { "202": { description: "Project and queued deployment" }, "400": errorResponse, "409": errorResponse } }
        },
        "/api/projects/{projectId}/domains": {
          parameters: [{ $ref: "#/components/parameters/ProjectId" }],
          post: { tags: ["Domains"], summary: "Connect a Cloudflare hostname", security: bearerSecurity, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["hostname", "zoneId"], properties: { hostname: { type: "string" }, zoneId: { type: "string" } } } } } }, responses: { "201": { description: "Connected domain" }, "400": errorResponse, "409": errorResponse, "502": errorResponse } }
        },
        "/api/projects/{projectId}/domains/{domainId}": {
          parameters: [{ $ref: "#/components/parameters/ProjectId" }, { name: "domainId", in: "path", required: true, schema: { type: "string" } }],
          delete: { tags: ["Domains"], summary: "Remove a project domain", security: bearerSecurity, responses: { "204": { description: "Domain removed" }, "404": errorResponse, "502": errorResponse } }
        },
        "/api/uploads": {
          post: { tags: ["Uploads"], summary: "Initialize a chunked ZIP upload", security: bearerSecurity, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["filename", "size"], properties: { filename: { type: "string" }, size: { type: "integer", minimum: 1 } } } } } }, responses: { "201": { description: "Upload allocation" }, "400": errorResponse } }
        },
        "/api/uploads/{uploadId}/chunks/{index}": {
          parameters: [{ name: "uploadId", in: "path", required: true, schema: { type: "string" } }, { name: "index", in: "path", required: true, schema: { type: "integer", minimum: 0 } }],
          put: { tags: ["Uploads"], summary: "Upload one binary chunk", security: bearerSecurity, requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", contentEncoding: "binary" } } } }, responses: { "200": { description: "Chunk accepted" }, "400": errorResponse } }
        },
        "/api/uploads/{uploadId}/complete": {
          parameters: [{ name: "uploadId", in: "path", required: true, schema: { type: "string" } }],
          post: { tags: ["Uploads"], summary: "Validate and complete an upload", security: bearerSecurity, responses: { "200": { description: "Completed upload" }, "400": errorResponse } }
        },
        "/api/deployments/{deploymentId}": {
          parameters: [{ $ref: "#/components/parameters/DeploymentId" }],
          get: { tags: ["Deployments"], summary: "Get deployment state", security: bearerSecurity, responses: { "200": { description: "Deployment detail" }, "404": errorResponse } }
        },
        "/api/deployments/{deploymentId}/logs": {
          parameters: [{ $ref: "#/components/parameters/DeploymentId" }, { name: "after", in: "query", schema: { type: "integer", minimum: 0 } }],
          get: { tags: ["Deployments"], summary: "Read deployment logs", security: bearerSecurity, responses: { "200": { description: "Logs and deployment state" }, "404": errorResponse } }
        },
        "/api/deployments/{deploymentId}/cancel": {
          parameters: [{ $ref: "#/components/parameters/DeploymentId" }],
          post: {
            tags: ["Deployments"], summary: "Cancel a queued or running deployment", security: bearerSecurity,
            description: "Queued work is cancelled immediately. Running Git and Docker processes receive cooperative termination. The atomic switching phase returns DEPLOYMENT_ACTIVATING and cannot be cancelled.",
            responses: { "200": { description: "Deployment was already cancelled" }, "202": { description: "Cancellation accepted" }, "404": errorResponse, "409": errorResponse }
          }
        },
        "/api/deployments/{deploymentId}/rollback": {
          parameters: [{ $ref: "#/components/parameters/DeploymentId" }],
          post: {
            tags: ["Deployments"], summary: "Queue a rollback to this ready deployment", security: bearerSecurity,
            description: "Creates a new immutable deployment from the retained image. The current runtime stays online until the rollback candidate is healthy and routing switches atomically.",
            responses: { "202": { description: "Queued rollback deployment" }, "400": errorResponse, "404": errorResponse, "409": errorResponse }
          }
        },
        "/api/settings/cloudflare/zones": {
          get: { tags: ["Domains"], summary: "List active Cloudflare zones", security: bearerSecurity, responses: { "200": { description: "Zone list" }, "502": errorResponse } }
        },
        "/api/settings/github/repositories/{installationId}/{repositoryId}/analysis": {
          parameters: [
            { name: "installationId", in: "path", required: true, schema: { type: "string", pattern: "^[0-9]+$" } },
            { name: "repositoryId", in: "path", required: true, schema: { type: "string", pattern: "^[0-9]+$" } },
            { name: "branch", in: "query", required: true, schema: { type: "string" } }
          ],
          get: { tags: ["Projects"], summary: "Analyze a GitHub repository at a branch SHA", security: sessionSecurity, responses: { "200": { description: "Detected applications cached by immutable branch SHA" }, "400": errorResponse, "401": errorResponse, "502": errorResponse } }
        }
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "shelter_pat_v1_…",
            description: "Create an expiring token in Settings → API & CLI. Send it only over HTTPS."
          },
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: "shelter_session",
            description: "Administrator browser session; API tokens are intentionally rejected."
          }
        },
        parameters: {
          ProjectId: { name: "projectId", in: "path", required: true, schema: { type: "string", pattern: "^prj_" } },
          DeploymentId: { name: "deploymentId", in: "path", required: true, schema: { type: "string", pattern: "^dep_" } }
        },
        schemas: {
          Error: { type: "object", required: ["error", "code"], properties: { error: { type: "string" }, code: { type: "string" }, details: {} } },
          ProjectFileFact: {
            type: "object", additionalProperties: false, required: ["path"],
            properties: { path: { type: "string", minLength: 1, maxLength: 240 }, size: { type: "integer", minimum: 0 }, content: { type: "string", maxLength: 524288 } }
          },
          ProjectAnalysis: {
            type: "object", required: ["fingerprint", "applications", "recommendedApplicationId"],
            properties: {
              fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
              recommendedApplicationId: { type: ["string", "null"] },
              applications: { type: "array", maxItems: 100, items: {
                type: "object",
                required: ["id", "rootDirectory", "name", "framework", "frameworkVersion", "rendering", "packageManager", "buildType", "buildCommand", "startCommand", "outputDirectory", "port", "healthcheckPath", "spaFallback", "environmentKeys", "confidence", "evidence"],
                properties: {
                  id: { type: "string" }, rootDirectory: { type: "string" }, name: { type: "string" },
                  framework: { type: "string", enum: ["next", "react", "astro", "vite", "static", "node", "dockerfile", "files", "unknown"] },
                  frameworkVersion: { type: ["string", "null"] }, rendering: { type: "string", enum: ["ssr", "spa", "static", "server", "container", "files"] },
                  packageManager: { type: ["string", "null"], enum: ["npm", "pnpm", "yarn", "bun", null] }, buildType: { type: "string", enum: ["auto", "dockerfile", "node", "static"] },
                  buildCommand: { type: ["string", "null"] }, startCommand: { type: ["string", "null"] }, outputDirectory: { type: ["string", "null"] },
                  port: { type: "integer", minimum: 1, maximum: 65535 }, healthcheckPath: { type: "string" }, spaFallback: { type: "boolean" },
                  environmentKeys: { type: "array", items: { type: "string" } }, confidence: { type: "number", minimum: 0, maximum: 1 }, evidence: { type: "array", items: { type: "string" } }
                }
              } }
            }
          },
          GitProjectInput: {
            type: "object", required: ["name", "repositoryUrl"],
            properties: {
              name: { type: "string", minLength: 2, maxLength: 80 }, repositoryUrl: { type: "string", format: "uri" }, branch: { type: "string", default: "main" },
              rootDirectory: { type: "string", default: "." }, buildType: { type: "string", enum: ["auto", "dockerfile", "node", "static"], default: "auto" },
              dockerfilePath: { type: "string", default: "Dockerfile" }, port: { type: "integer", minimum: 1, maximum: 65535, default: 3000 }, healthcheckPath: { type: "string", default: "/" },
              staticBasePath: { type: ["string", "null"], default: null }, environment: { type: "array", items: { type: "object", required: ["key", "value"], properties: { key: { type: "string" }, value: { type: "string" } } } }
            }
          }
        }
      }
    };
  });
}
