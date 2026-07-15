import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const temporaryDirectories: string[] = [];

async function context() {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-analysis-api-"));
  temporaryDirectories.push(dataDirectory);
  const app = await createApp(loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDirectory,
    WEB_DIST: path.join(dataDirectory, "missing-web"),
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "correct horse battery staple",
    APP_SECRET: "a".repeat(64)
  }));
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin@example.com", password: "correct horse battery staple" }
  });
  const session = login.cookies.find((cookie) => cookie.name === "shelter_session")!;
  return {
    app,
    auth: {
      cookie: `shelter_session=${session.value}`,
      "x-csrf-token": login.json().csrfToken as string,
      origin: "http://localhost:7080",
      host: "localhost:7080"
    }
  };
}

async function uploadArchive(
  app: Awaited<ReturnType<typeof createApp>>,
  auth: Record<string, string>,
  archive: Buffer
): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: auth,
    payload: { filename: "project.zip", size: archive.length }
  });
  expect(created.statusCode).toBe(201);
  const uploadId = created.json().uploadId as string;
  const chunk = await app.inject({
    method: "PUT",
    url: `/api/uploads/${uploadId}/chunks/0`,
    headers: { ...auth, "content-type": "application/octet-stream" },
    payload: archive
  });
  expect(chunk.statusCode).toBe(200);
  const completed = await app.inject({ method: "POST", url: `/api/uploads/${uploadId}/complete`, headers: auth });
  expect(completed.statusCode).toBe(200);
  return uploadId;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("project analysis API", () => {
  it("requires authentication, accepts bounded file facts and rejects route bodies above 4 MiB", async () => {
    const { app, auth } = await context();
    const anonymous = await app.inject({
      method: "POST",
      url: "/api/projects/analyze",
      payload: { files: [{ path: "package.json", content: "{}" }] }
    });
    expect(anonymous.statusCode).toBe(401);

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/analyze",
      headers: auth,
      payload: {
        files: [{
          path: "package.json",
          content: JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "19.1.0", vite: "7.0.0" } })
        }, { path: "index.html", content: "<!doctype html><main id=\"root\"></main>" }, { path: "tsconfig.json", content: "{}" }]
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().analysis.applications[0]).toMatchObject({ framework: "react", rendering: "spa" });
    expect(response.headers["cache-control"]).toBe("no-store");

    const secretContent = await app.inject({
      method: "POST",
      url: "/api/projects/analyze",
      headers: auth,
      payload: { files: [{ path: ".env", content: "SECRET=must-never-be-accepted" }] }
    });
    expect(secretContent.statusCode).toBe(400);
    expect(secretContent.json()).toMatchObject({ code: "VALIDATION" });
    expect(JSON.stringify(secretContent.json())).not.toContain("must-never-be-accepted");

    const oversized = await app.inject({
      method: "POST",
      url: "/api/projects/analyze",
      headers: { ...auth, "content-type": "application/json" },
      payload: JSON.stringify({ files: [{ path: "package.json", content: "x".repeat(4 * 1024 * 1024) }] })
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("persists a server-validated, wrapper-normalized ZIP analysis on project creation", async () => {
    const { app, auth } = await context();
    const archive = Buffer.from(zipSync({
      "selected-folder/package.json": strToU8(JSON.stringify({
        name: "frog-site",
        scripts: { build: "vite build" },
        dependencies: { react: "19.1.0" },
        devDependencies: { vite: "7.0.0" }
      })),
      "selected-folder/package-lock.json": strToU8("{}"),
      "selected-folder/src/main.tsx": strToU8("export {}")
    }));
    const uploadId = await uploadArchive(app, auth, archive);
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/upload",
      headers: auth,
      payload: { name: "Frog Site", uploadId }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().project.sourceAnalysis.applications[0]).toMatchObject({
      rootDirectory: ".",
      framework: "react",
      outputDirectory: "dist"
    });
    const detail = await app.inject({
      method: "GET",
      url: `/api/projects/${created.json().project.id as string}`,
      headers: auth
    });
    expect(detail.json().project.sourceAnalysis.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await app.close();
  });

  it("does not block a valid upload when ignored generated trees exceed the live-analysis path budget", async () => {
    const { app, auth } = await context();
    const entries: Record<string, Uint8Array> = {
      "folder/package.json": strToU8(JSON.stringify({ scripts: { start: "node server.js" } })),
      "folder/server.js": strToU8("setInterval(() => {}, 1000)")
    };
    for (let index = 0; index < 10_050; index += 1) {
      entries[`folder/node_modules/pkg-${index}/index.js`] = new Uint8Array();
    }
    const uploadId = await uploadArchive(app, auth, Buffer.from(zipSync(entries)));
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/upload",
      headers: auth,
      payload: { name: "Large Node Upload", uploadId }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().project.sourceAnalysis.applications[0]).toMatchObject({ framework: "node" });
    await app.close();
  }, 30_000);
});
