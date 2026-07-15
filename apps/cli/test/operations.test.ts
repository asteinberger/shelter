import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type FetchImplementation, ShelterClient } from "../src/api.js";
import { uploadArchive, waitForDeployment } from "../src/operations.js";
import type { Deployment, Project } from "../src/types.js";

const temporaryDirectories: string[] = [];

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function deployment(status: Deployment["status"]): Deployment {
  return {
    id: "dep_123",
    projectId: "prj_123",
    status,
    sourceRef: "main",
    runtimeKind: null,
    runtimeDescription: null,
    commitSha: null,
    commitMessage: null,
    commitAuthor: null,
    commitUrl: null,
    trigger: "manual",
    error: null,
    failureKind: null,
    rollbackStatus: "not_required",
    rollbackDeploymentId: null,
    cancelRequestedAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    durationSeconds: null
  };
}

function project(): Project {
  return {
    id: "prj_123",
    name: "Upload project",
    slug: "upload-project",
    status: "deploying",
    sourceType: "upload",
    repositoryUrl: null,
    repositoryBranch: null,
    buildType: "auto",
    rootDirectory: ".",
    staticBasePath: null,
    activeDeploymentId: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z"
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("deployment operations", () => {
  it("polls until a deployment reaches a terminal state", async () => {
    const statuses: Deployment["status"][] = ["building", "ready"];
    const request = (async () => jsonResponse({ deployment: deployment(statuses.shift() ?? "ready") })) as FetchImplementation;
    const client = new ShelterClient({ serverUrl: "https://hosting.example", token: "secret" }, request);
    const observed: string[] = [];

    const result = await waitForDeployment(client, "dep_123", (current) => observed.push(current.status), 0);
    expect(result.status).toBe("ready");
    expect(observed).toEqual(["building", "ready"]);
  });

  it("uploads chunks in order and attaches the completed archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "shelter-upload-"));
    temporaryDirectories.push(root);
    const archivePath = join(root, "release.zip");
    await writeFile(archivePath, Buffer.from("abcde"));
    const paths: string[] = [];
    const chunks: Buffer[] = [];
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/api/uploads") {
        return jsonResponse({ uploadId: "upl_123", chunkSize: 2, totalChunks: 3 }, 201);
      }
      if (url.pathname.includes("/chunks/")) {
        chunks.push(Buffer.from(init?.body as Uint8Array));
        return jsonResponse({ ok: true });
      }
      if (url.pathname.endsWith("/complete")) return jsonResponse({ uploadId: "upl_123" });
      if (url.pathname.endsWith("/source")) {
        return jsonResponse({ project: project(), deployment: deployment("queued") }, 202);
      }
      return jsonResponse({ error: "Unexpected request", code: "TEST" }, 500);
    }) as FetchImplementation;
    const client = new ShelterClient({ serverUrl: "https://hosting.example", token: "secret" }, request);

    const result = await uploadArchive(client, "prj_123", archivePath);
    expect(result.deployment.status).toBe("queued");
    expect(Buffer.concat(chunks).toString()).toBe("abcde");
    expect(paths).toEqual([
      "POST /api/uploads",
      "PUT /api/uploads/upl_123/chunks/0",
      "PUT /api/uploads/upl_123/chunks/1",
      "PUT /api/uploads/upl_123/chunks/2",
      "POST /api/uploads/upl_123/complete",
      "PUT /api/projects/prj_123/source"
    ]);
  });
});
