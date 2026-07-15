import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import {
  captureProjectPreview,
  projectPreviewImagePath,
  projectPreviewState
} from "../src/services/project-preview.js";
import type { DeploymentRow, ProjectRow } from "../src/types/models.js";

const temporaryDirectories: string[] = [];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function temporaryConfig() {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-preview-"));
  temporaryDirectories.push(dataDirectory);
  return loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDirectory,
    WEB_DIST: path.join(dataDirectory, "missing-web"),
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "correct horse battery staple",
    APP_SECRET: "p".repeat(64),
    CHROMIUM_PATH: "/fake/chromium",
    LOG_LEVEL: "silent"
  });
}

function project(id = "prj_preview"): ProjectRow {
  const now = new Date().toISOString();
  return {
    id,
    name: "Preview App",
    slug: "preview-app",
    source_type: "git",
    repository_url: "https://github.com/example/preview.git",
    repository_branch: "main",
    source_archive: null,
    static_base_path: null,
    root_directory: ".",
    build_type: "auto",
    dockerfile_path: "Dockerfile",
    port: 3000,
    healthcheck_path: "/",
    memory_limit: "1g",
    cpu_limit: "1.0",
    active_deployment_id: null,
    created_at: now,
    updated_at: now
  };
}

function deployment(projectId: string, id = "dep_preview"): DeploymentRow {
  const now = new Date().toISOString();
  return {
    id,
    project_id: projectId,
    status: "ready",
    source_ref: "main",
    image_tag: "shelter/preview:latest",
    previous_image_tag: null,
    internal_port: 3000,
    static_base_path: null,
    runtime_kind: "node",
    runtime_description: "Node.js",
    commit_sha: null,
    commit_message: null,
    commit_author: null,
    commit_url: null,
    trigger: "manual",
    github_delivery_id: null,
    error: null,
    started_at: now,
    finished_at: now,
    created_at: now
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("project previews", () => {
  it("captures HTML with Chromium and exposes only the active deployment", async () => {
    const config = temporaryConfig();
    const command = vi.fn(async (_binary: string, args: string[]) => {
      const screenshot = args.find((argument) => argument.startsWith("--screenshot="))?.slice("--screenshot=".length);
      if (!screenshot) throw new Error("screenshot path missing");
      await fs.promises.writeFile(screenshot, PNG);
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const metadata = await captureProjectPreview(config, {
      projectId: "prj_preview",
      deploymentId: "dep_one",
      url: "http://shelter-app-preview:3000/"
    }, {
      fetch: vi.fn(async () => new Response("<!doctype html><title>Preview</title>", {
        headers: { "content-type": "text/html; charset=utf-8" }
      })),
      command
    });

    expect(metadata.status).toBe("ready");
    expect(command).toHaveBeenCalledWith("/fake/chromium", expect.arrayContaining([
      "--headless",
      "--window-size=1440,900",
      "http://shelter-app-preview:3000/"
    ]), expect.objectContaining({ timeoutMs: 30_000 }));
    expect(fs.readFileSync(projectPreviewImagePath(config, "prj_preview"))).toEqual(PNG);
    expect(projectPreviewState(config, "prj_preview", "dep_one")).toMatchObject({
      status: "ready",
      deploymentId: "dep_one",
      imageUrl: "/api/projects/prj_preview/preview?deployment=dep_one"
    });
    expect(projectPreviewState(config, "prj_preview", "dep_two")).toEqual({
      status: "pending",
      deploymentId: "dep_two"
    });
  });

  it("marks API responses as unavailable without launching Chromium", async () => {
    const config = temporaryConfig();
    const command = vi.fn();
    const metadata = await captureProjectPreview(config, {
      projectId: "prj_api",
      deploymentId: "dep_api",
      url: "http://shelter-app-api:3000/health"
    }, {
      fetch: vi.fn(async () => new Response('{"ok":true}', {
        headers: { "content-type": "application/json" }
      })),
      command
    });

    expect(command).not.toHaveBeenCalled();
    expect(metadata).toMatchObject({ status: "unavailable", reason: "not_html" });
    expect(projectPreviewState(config, "prj_api", "dep_api")).toMatchObject({
      status: "unavailable",
      reason: "not_html"
    });
  });

  it("serves a preview only to an authenticated administrator", async () => {
    const config = temporaryConfig();
    const database = new Database(config);
    const row = project();
    const active = deployment(row.id);
    database.createProject(row);
    database.createDeployment(active);
    database.updateProject(row.id, { active_deployment_id: active.id });
    await captureProjectPreview(config, {
      projectId: row.id,
      deploymentId: active.id,
      url: "http://shelter-app-preview:3000/"
    }, {
      fetch: async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
      command: async (_binary, args) => {
        const screenshot = args.find((argument) => argument.startsWith("--screenshot="))?.slice("--screenshot=".length);
        if (!screenshot) throw new Error("screenshot path missing");
        await fs.promises.writeFile(screenshot, PNG);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });
    const app = await createApp(config, database);

    const anonymous = await app.inject({ method: "GET", url: `/api/projects/${row.id}/preview` });
    expect(anonymous.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });
    const cookie = login.cookies.find((entry) => entry.name === "shelter_session");
    const detail = await app.inject({
      method: "GET",
      url: `/api/projects/${row.id}`,
      headers: { cookie: `shelter_session=${cookie?.value ?? ""}` }
    });
    expect(detail.json().project.preview).toMatchObject({ status: "ready", deploymentId: active.id });

    const image = await app.inject({
      method: "GET",
      url: `/api/projects/${row.id}/preview`,
      headers: { cookie: `shelter_session=${cookie?.value ?? ""}` }
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toContain("image/png");
    expect(image.rawPayload).toEqual(PNG);
    await app.close();
  });
});

