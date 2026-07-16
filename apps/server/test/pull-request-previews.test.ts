import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { GitHubService } from "../src/services/github.js";
import { PreviewDnsReconciler } from "../src/services/preview-dns-reconciler.js";
import { pullRequestPreviewHostname } from "../src/services/pull-request-previews.js";
import type { DomainRow, ProjectRow } from "../src/types/models.js";

const directories: string[] = [];

function context() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-pr-preview-"));
  directories.push(directory);
  const config = loadConfig({ NODE_ENV: "test", DATA_DIR: directory, APP_SECRET: "p".repeat(64) });
  const database = new Database(config);
  const now = new Date().toISOString();
  const project: ProjectRow = {
    id: "prj_preview",
    name: "Preview App",
    slug: "preview-app",
    source_type: "git",
    repository_url: "https://github.com/example/app.git",
    repository_branch: "main",
    source_archive: null,
    static_base_path: null,
    root_directory: ".",
    build_type: "auto",
    dockerfile_path: "Dockerfile",
    port: 3000,
    healthcheck_path: "/",
    memory_limit: "512m",
    cpu_limit: "0.5",
    active_deployment_id: null,
    github_repository_id: "99",
    github_repository_full_name: "example/app",
    github_installation_id: "123",
    auto_deploy: 0,
    preview_deployments_enabled: 1,
    preview_domain_id: "dom_preview",
    preview_domain_suffix: "example.com",
    preview_ttl_hours: 24,
    github_connection_error: null,
    created_at: now,
    updated_at: now
  };
  const domain: DomainRow = {
    id: "dom_preview",
    project_id: project.id,
    hostname: "app.example.com",
    zone_id: "zone-id",
    dns_record_id: "production-record",
    status: "active",
    error: null,
    created_at: now
  };
  database.createProject(project);
  database.createDomain(domain);
  return { config, database, github: new GitHubService(config, database, vi.fn() as unknown as typeof fetch), project };
}

function payload(number: number, overrides: Record<string, unknown> = {}) {
  const sha = number.toString(16).padStart(40, "a").slice(-40);
  return {
    action: "opened",
    installation: { id: 123 },
    repository: { id: 99, full_name: "example/app" },
    sender: { login: "ada" },
    pull_request: {
      number,
      title: `PR ${number}`,
      html_url: `https://github.com/example/app/pull/${number}`,
      head: { sha, ref: `feature-${number}`, repo: { id: 99, full_name: "example/app" } },
      base: { ref: "main", repo: { id: 99, full_name: "example/app" } }
    },
    ...overrides
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("pull-request preview safety", () => {
  it("uses one bounded zone-level DNS label", () => {
    const hostname = pullRequestPreviewHostname(123, "A very long Project Slug ".repeat(8), "example.com");
    expect(hostname.endsWith(".example.com")).toBe(true);
    expect(hostname.split(".")[0]!.length).toBeLessThanOrEqual(63);
    expect(hostname).toMatch(/^pr-123--/);
  });

  it("fails closed for forks and branch mismatches", async () => {
    const { database, github } = context();
    const forked = payload(1);
    forked.pull_request.head.repo = { id: 777, full_name: "attacker/app" };
    expect(await github.handleWebhook("pull_request", "fork-delivery", Buffer.from(JSON.stringify(forked))))
      .toMatchObject({ queued: 0, ignored: 1 });
    const wrongBase = payload(2);
    wrongBase.pull_request.base.ref = "develop";
    expect(await github.handleWebhook("pull_request", "branch-delivery", Buffer.from(JSON.stringify(wrongBase))))
      .toMatchObject({ queued: 0, ignored: 1 });
    expect(database.listPullRequestPreviews("prj_preview")).toEqual([]);
    database.close();
  });

  it("rejects malformed pull-request events before persistence", async () => {
    const { database, github } = context();
    const malformed = payload(9);
    malformed.pull_request.head.sha = "not-a-commit";
    await expect(github.handleWebhook(
      "pull_request",
      "malformed-delivery",
      Buffer.from(JSON.stringify(malformed))
    )).rejects.toThrow();
    expect(database.listPullRequestPreviews("prj_preview")).toEqual([]);
    database.close();
  });

  it("queues an isolated preview only after DNS and never activates production", async () => {
    const { database, github, project } = context();
    const event = payload(3);
    expect(await github.handleWebhook("pull_request", "preview-delivery", Buffer.from(JSON.stringify(event))))
      .toMatchObject({ queued: 1 });
    const preview = database.findPullRequestPreview(project.id, 3)!;
    const deployment = database.getDeployment(preview.deployment_id!)!;
    expect(deployment).toMatchObject({ deployment_scope: "preview", preview_id: preview.id });
    expect(database.listDeployments(project.id)).toEqual([]);
    expect(database.nextQueuedDeployment()).toBeUndefined();
    expect(database.updatePullRequestPreviewDns(preview.id, deployment.id, "zone-id", "preview-record")).toBe(true);
    expect(database.nextQueuedDeployment()?.id).toBe(deployment.id);
    expect(database.getProject(project.id)?.active_deployment_id).toBeNull();
    expect(database.listEnvironment(project.id)).toEqual([]);
    expect(database.listPreviewEnvironment(project.id)).toEqual([]);
    database.close();
  });

  it("coalesces synchronize events without two active builds", async () => {
    const { database, github, project } = context();
    await github.handleWebhook("pull_request", "coalesce-1", Buffer.from(JSON.stringify(payload(4))));
    const first = database.findPullRequestPreview(project.id, 4)!;
    database.updateDeployment(first.deployment_id!, { status: "building" });
    const secondEvent = payload(4);
    secondEvent.action = "synchronize";
    secondEvent.pull_request.head.sha = "b".repeat(40);
    expect(await github.handleWebhook("pull_request", "coalesce-2", Buffer.from(JSON.stringify(secondEvent))))
      .toMatchObject({ pending: 1 });
    const desired = database.findPullRequestPreview(project.id, 4)!;
    expect(desired.deployment_id).toBe(first.deployment_id);
    expect(database.getDeployment(first.deployment_id!)?.cancel_requested_at).not.toBeNull();
    expect(database.listAllDeployments(project.id, 100).filter((row) => ["queued", "preparing", "building", "checking", "switching"].includes(row.status))).toHaveLength(1);
    database.finalizeDeploymentCancellation(first.deployment_id!);
    const materialized = database.materializePullRequestPreview(desired.id)!;
    expect(materialized.commit_sha).toBe("b".repeat(40));
    expect(database.listAllDeployments(project.id, 100).filter((row) => ["queued", "preparing", "building", "checking", "switching"].includes(row.status))).toHaveLength(1);
    database.close();
  });

  it("caps active previews at three and closes DNS through the API reconciler", async () => {
    const { database, github } = context();
    for (let number = 10; number <= 13; number += 1) {
      await github.handleWebhook("pull_request", `limit-${number}`, Buffer.from(JSON.stringify(payload(number))));
    }
    expect(database.findPullRequestPreview("prj_preview", 13)?.status).toBe("blocked");
    const preview = database.findPullRequestPreview("prj_preview", 10)!;
    database.sqlite.prepare("UPDATE pull_request_previews SET expires_at=? WHERE id=?")
      .run(new Date(Date.now() - 1_000).toISOString(), preview.id);
    expect(database.nextPullRequestPreviewCleanup()?.id).toBe(preview.id);
    database.updatePullRequestPreviewDns(preview.id, preview.deployment_id!, "zone-id", "record-10");
    database.requestPullRequestPreviewClose("prj_preview", preview.id);
    const cloudflare = {
      deleteDnsRecord: vi.fn(async () => undefined),
      checkHostname: vi.fn(),
      ensureDnsRecord: vi.fn()
    };
    const reconciler = new PreviewDnsReconciler(database, cloudflare as never);
    expect(await reconciler.processNext()).toBe(true);
    expect(cloudflare.deleteDnsRecord).toHaveBeenCalledWith("zone-id", "record-10", preview.hostname);
    expect(database.getPullRequestPreview(preview.id)).toMatchObject({ status: "closing", zone_id: null, dns_record_id: null });
    database.close();
  });
});
