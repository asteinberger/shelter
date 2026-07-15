import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("upload source replacement", () => {
  it("atomically replaces an upload source, queues one deployment and replays retries", async () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-source-replace-"));
    temporaryDirectories.push(dataDirectory);
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: dataDirectory,
      WEB_DIST: path.join(dataDirectory, "missing-web"),
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: "correct horse battery staple",
      APP_SECRET: "u".repeat(64),
      LOG_LEVEL: "silent"
    });
    const database = new Database(config);
    const app = await createApp(config, database);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });
    const cookie = login.cookies.find((entry) => entry.name === "shelter_session")?.value ?? "";
    const mutationHeaders = {
      cookie: `portsmith_session=${cookie}`,
      "x-csrf-token": login.json().csrfToken as string,
      origin: "http://localhost:7080",
      host: "localhost:7080"
    };

    const completeUpload = async (label: string) => {
      const zip = Buffer.from("UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==", "base64");
      const initialized = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: mutationHeaders,
        payload: { filename: `${label}.zip`, size: zip.length }
      });
      expect(initialized.statusCode).toBe(201);
      const id = initialized.json().id as string;
      const chunk = await app.inject({
        method: "PUT",
        url: `/api/uploads/${id}/chunks/0`,
        headers: { ...mutationHeaders, "content-type": "application/octet-stream" },
        payload: zip
      });
      expect(chunk.statusCode).toBe(200);
      const completed = await app.inject({
        method: "POST",
        url: `/api/uploads/${id}/complete`,
        headers: mutationHeaders
      });
      expect(completed.statusCode).toBe(200);
      const row = database.sqlite.prepare("SELECT archive_path FROM uploads WHERE id = ?")
        .get(id) as { archive_path: string };
      return { id, archivePath: row.archive_path };
    };

    const oldUpload = await completeUpload("old");
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/upload",
      headers: mutationHeaders,
      payload: { name: "Uploaded App", uploadId: oldUpload.id, staticBasePath: "/initial" }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().project.staticBasePath).toBe("/initial");
    const projectId = created.json().project.id as string;
    expect(database.getDeployment(created.json().deployment.id)?.static_base_path).toBe("/initial");
    database.sqlite.prepare(`
      UPDATE deployments SET status = 'ready', image_tag = 'portsmith/test:old', finished_at = ? WHERE id = ?
    `).run(new Date().toISOString(), created.json().deployment.id);

    const newUpload = await completeUpload("new");
    const replaced = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/source`,
      headers: mutationHeaders,
      payload: { uploadId: newUpload.id, staticBasePath: "/replacement" }
    });
    expect(replaced.statusCode).toBe(202);
    expect(replaced.json().deployment.status).toBe("queued");
    expect(replaced.json().deployment.sourceRef).toBe(newUpload.id);
    expect(replaced.json().project.staticBasePath).toBe("/replacement");
    expect(database.getProject(projectId)?.source_archive).toBe(newUpload.archivePath);
    expect(database.getDeployment(replaced.json().deployment.id)?.static_base_path).toBe("/replacement");
    expect(database.listDeployments(projectId, 20)).toHaveLength(2);
    expect(database.sqlite.prepare("SELECT 1 FROM uploads WHERE id = ?").get(oldUpload.id)).toBeDefined();
    expect(fs.existsSync(oldUpload.archivePath)).toBe(true);

    for (let index = 0; index < 101; index += 1) {
      database.createDeployment({
        id: `dep_noise_${index}`,
        project_id: projectId,
        status: "failed",
        source_ref: `noise_${index}`,
        image_tag: null,
        previous_image_tag: null,
        internal_port: null,
        static_base_path: null,
        runtime_kind: null,
        runtime_description: null,
        commit_sha: null,
        error: "test noise",
        started_at: null,
        finished_at: new Date().toISOString(),
        created_at: new Date(Date.now() + index * 1_000).toISOString()
      });
    }

    const replayed = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/source`,
      headers: mutationHeaders,
      payload: { uploadId: newUpload.id, staticBasePath: "/replacement" }
    });
    expect(replayed.statusCode).toBe(202);
    expect(replayed.json().deployment.id).toBe(replaced.json().deployment.id);
    expect(database.listDeployments(projectId, 200)).toHaveLength(103);
    database.sqlite.prepare("DELETE FROM deployments WHERE id LIKE 'dep_noise_%'").run();
    expect(database.listDeployments(projectId, 20)).toHaveLength(2);

    const thirdUpload = await completeUpload("third");
    const activeConflict = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/source`,
      headers: mutationHeaders,
      payload: { uploadId: thirdUpload.id }
    });
    expect(activeConflict.statusCode).toBe(409);
    expect(activeConflict.json().code).toBe("DEPLOYMENT_ACTIVE");
    expect(database.getProject(projectId)?.source_archive).toBe(newUpload.archivePath);
    expect(fs.existsSync(thirdUpload.archivePath)).toBe(true);

    const activePathConflict = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/deploy`,
      headers: mutationHeaders,
      payload: { staticBasePath: "/must-not-persist" }
    });
    expect(activePathConflict.statusCode).toBe(409);
    expect(database.getProject(projectId)?.static_base_path).toBe("/replacement");

    database.sqlite.prepare(`
      UPDATE deployments SET status = 'ready', image_tag = 'portsmith/test:new', finished_at = ? WHERE id = ?
    `).run(new Date().toISOString(), replaced.json().deployment.id);
    const redeployed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/deploy`,
      headers: mutationHeaders,
      payload: { staticBasePath: "/current-files" }
    });
    expect(redeployed.statusCode).toBe(202);
    expect(database.getProject(projectId)?.static_base_path).toBe("/current-files");
    expect(database.getDeployment(redeployed.json().deployment.id)?.static_base_path).toBe("/current-files");

    const changedAfterQueue = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      headers: mutationHeaders,
      payload: { staticBasePath: "/future" }
    });
    expect(changedAfterQueue.statusCode).toBe(409);
    expect(changedAfterQueue.json().code).toBe("DEPLOYMENT_ACTIVE");
    expect(database.getProject(projectId)?.static_base_path).toBe("/current-files");
    expect(database.getDeployment(redeployed.json().deployment.id)?.static_base_path).toBe("/current-files");

    database.sqlite.prepare("UPDATE deployments SET status = 'ready', image_tag = 'portsmith/test:redeployed', finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), redeployed.json().deployment.id);
    const changedAfterCompletion = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      headers: mutationHeaders,
      payload: { staticBasePath: "/future" }
    });
    expect(changedAfterCompletion.statusCode).toBe(200);
    expect(changedAfterCompletion.json().project.staticBasePath).toBe("/future");

    const incompatibleExistingPath = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      headers: mutationHeaders,
      payload: { buildType: "node" }
    });
    expect(incompatibleExistingPath.statusCode).toBe(400);
    expect(incompatibleExistingPath.json().code).toBe("STATIC_BASE_PATH_INCOMPATIBLE");
    expect(database.getProject(projectId)?.build_type).toBe("auto");

    const explicitNodeAtRoot = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      headers: mutationHeaders,
      payload: { buildType: "node", staticBasePath: "/" }
    });
    expect(explicitNodeAtRoot.statusCode).toBe(200);

    const incompatibleRedeploy = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/deploy`,
      headers: mutationHeaders,
      payload: { staticBasePath: "/node-prefix" }
    });
    expect(incompatibleRedeploy.statusCode).toBe(400);
    expect(incompatibleRedeploy.json().code).toBe("STATIC_BASE_PATH_INCOMPATIBLE");
    expect(database.getProject(projectId)?.static_base_path).toBe("/");

    const incompatibleReplacement = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/source`,
      headers: mutationHeaders,
      payload: { uploadId: thirdUpload.id, staticBasePath: "/node-prefix" }
    });
    expect(incompatibleReplacement.statusCode).toBe(400);
    expect(incompatibleReplacement.json().code).toBe("STATIC_BASE_PATH_INCOMPATIBLE");
    expect(database.getProject(projectId)?.source_archive).toBe(newUpload.archivePath);

    const incompatibleUploadCreation = await app.inject({
      method: "POST",
      url: "/api/projects/upload",
      headers: mutationHeaders,
      payload: {
        name: "Docker Upload With Prefix",
        uploadId: thirdUpload.id,
        staticBasePath: "/docker-prefix",
        buildType: "dockerfile"
      }
    });
    expect(incompatibleUploadCreation.statusCode).toBe(400);
    expect(incompatibleUploadCreation.json().code).toBe("STATIC_BASE_PATH_INCOMPATIBLE");
    expect(database.sqlite.prepare("SELECT id FROM projects WHERE source_archive = ?").get(thirdUpload.archivePath)).toBeUndefined();

    const gitProject = await app.inject({
      method: "POST",
      url: "/api/projects/git",
      headers: mutationHeaders,
      payload: {
        name: "Git App",
        repositoryUrl: "https://github.com/example/app.git",
        staticBasePath: "/git-prefix"
      }
    });
    expect(gitProject.statusCode).toBe(201);
    expect(gitProject.json().project.staticBasePath).toBe("/git-prefix");
    const wrongSourceType = await app.inject({
      method: "PUT",
      url: `/api/projects/${gitProject.json().project.id as string}/source`,
      headers: mutationHeaders,
      payload: { uploadId: thirdUpload.id }
    });
    expect(wrongSourceType.statusCode).toBe(400);
    expect(wrongSourceType.json().code).toBe("SOURCE_TYPE_MISMATCH");

    database.sqlite.prepare(`
      UPDATE deployments SET status = 'ready', image_tag = 'portsmith/test:git', finished_at = ? WHERE id = ?
    `).run(new Date().toISOString(), gitProject.json().deployment.id);
    const gitRedeploy = await app.inject({
      method: "POST",
      url: `/api/projects/${gitProject.json().project.id as string}/deploy`,
      headers: mutationHeaders,
      payload: { staticBasePath: "/git-deploy" }
    });
    expect(gitRedeploy.statusCode).toBe(202);
    expect(database.getProject(gitProject.json().project.id)?.static_base_path).toBe("/git-deploy");
    expect(database.getDeployment(gitRedeploy.json().deployment.id)?.static_base_path).toBe("/git-deploy");

    const gitPatch = await app.inject({
      method: "PATCH",
      url: `/api/projects/${gitProject.json().project.id as string}`,
      headers: mutationHeaders,
      payload: { staticBasePath: "/git-patched" }
    });
    expect(gitPatch.statusCode).toBe(409);
    expect(gitPatch.json().code).toBe("DEPLOYMENT_ACTIVE");
    expect(database.getDeployment(gitRedeploy.json().deployment.id)?.static_base_path).toBe("/git-deploy");

    database.sqlite.prepare("UPDATE deployments SET status = 'ready', image_tag = 'portsmith/test:git-redeploy', finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), gitRedeploy.json().deployment.id);
    const gitPatchAfterCompletion = await app.inject({
      method: "PATCH",
      url: `/api/projects/${gitProject.json().project.id as string}`,
      headers: mutationHeaders,
      payload: { staticBasePath: "/git-patched" }
    });
    expect(gitPatchAfterCompletion.statusCode).toBe(200);
    expect(gitPatchAfterCompletion.json().project.staticBasePath).toBe("/git-patched");

    const incompatibleGitCreation = await app.inject({
      method: "POST",
      url: "/api/projects/git",
      headers: mutationHeaders,
      payload: {
        name: "Git App With Prefix",
        repositoryUrl: "https://github.com/example/app.git",
        staticBasePath: "/git-prefix",
        buildType: "node"
      }
    });
    expect(incompatibleGitCreation.statusCode).toBe(400);
    expect(incompatibleGitCreation.json().code).toBe("STATIC_BASE_PATH_INCOMPATIBLE");

    const invalidPath = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      headers: mutationHeaders,
      payload: { staticBasePath: "/invalid.path" }
    });
    expect(invalidPath.statusCode).toBe(400);
    expect(database.getProject(projectId)?.static_base_path).toBe("/");

    await app.close();
  });
});
