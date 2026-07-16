import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { GitHubService } from "../src/services/github.js";
import { PreviewDnsReconciler } from "../src/services/preview-dns-reconciler.js";
import { pullRequestPreviewHostname } from "../src/services/pull-request-previews.js";
import { reconcileRouting } from "../src/services/routing.js";
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

function activatePreview(database: Database, projectId: string, pullRequestNumber: number): string {
  const preview = database.findPullRequestPreview(projectId, pullRequestNumber)!;
  const deploymentId = preview.deployment_id!;
  expect(database.updatePullRequestPreviewDns(preview.id, deploymentId, "zone-id", `record-${pullRequestNumber}`)).toBe(true);
  expect(database.beginPullRequestPreviewBuild(preview.id, deploymentId)).toBe(true);
  database.updateDeployment(deploymentId, {
    status: "checking",
    image_tag: `shelter/preview:${pullRequestNumber}`,
    runtime_container: `shelter-preview-${pullRequestNumber}`,
    internal_port: 3000
  });
  expect(database.completePullRequestPreview(preview.id, deploymentId)).toBe(true);
  return preview.id;
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
    expect(database.listDueGithubStatuses(20).find((row) => row.deployment_id === deployment.id))
      .toMatchObject({ desired_state: "pending", commit_sha: event.pull_request.head.sha });
    expect(database.getProject(project.id)?.active_deployment_id).toBeNull();
    expect(database.listEnvironment(project.id)).toEqual([]);
    expect(database.listPreviewEnvironment(project.id)).toEqual([]);
    database.close();
  });

  it("provisions preview DNS only through the ownership-enforcing Cloudflare methods", async () => {
    const { database, github, project } = context();
    await github.handleWebhook("pull_request", "preview-dns-delivery", Buffer.from(JSON.stringify(payload(15))));
    const preview = database.findPullRequestPreview(project.id, 15)!;
    const cloudflare = {
      checkHostname: vi.fn(async () => ({
        hostname: preview.hostname,
        availability: false,
        reason: "CLOUDFLARE_DNS_RECORD_EXISTS",
        zone: { id: "zone-id", name: "example.com" }
      })),
      ensurePreviewDnsRecord: vi.fn(async () => ({ zoneId: "zone-id", recordId: "managed-preview-record" })),
      deletePreviewDnsRecord: vi.fn(async () => undefined)
    };
    const reconciler = new PreviewDnsReconciler(database, cloudflare as never);

    expect(await reconciler.processNext()).toBe(true);
    expect(cloudflare.ensurePreviewDnsRecord).toHaveBeenCalledWith(preview.hostname, "zone-id");
    expect(database.getPullRequestPreview(preview.id)).toMatchObject({
      zone_id: "zone-id",
      dns_record_id: "managed-preview-record"
    });
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

  it("routes the last-known-good build until an atomic generation switch and supports rollback", async () => {
    const { config, database, github, project } = context();
    await github.handleWebhook("pull_request", "generation-1", Buffer.from(JSON.stringify(payload(5))));
    const firstPreview = database.findPullRequestPreview(project.id, 5)!;
    const firstDeployment = database.getDeployment(firstPreview.deployment_id!)!;
    database.updatePullRequestPreviewDns(firstPreview.id, firstDeployment.id, "zone-id", "preview-record");
    expect(database.beginPullRequestPreviewBuild(firstPreview.id, firstDeployment.id)).toBe(true);
    database.updateDeployment(firstDeployment.id, {
      status: "checking",
      image_tag: "shelter/preview:first",
      runtime_container: "shelter-preview-first",
      internal_port: 3000
    });
    expect(database.completePullRequestPreview(firstPreview.id, firstDeployment.id)).toBe(true);
    expect(database.getPullRequestPreview(firstPreview.id)).toMatchObject({
      deployment_id: firstDeployment.id,
      active_deployment_id: firstDeployment.id,
      status: "ready"
    });

    const synchronize = payload(5);
    synchronize.action = "synchronize";
    synchronize.pull_request.head.sha = "c".repeat(40);
    await github.handleWebhook("pull_request", "generation-2", Buffer.from(JSON.stringify(synchronize)));
    const secondPreview = database.findPullRequestPreview(project.id, 5)!;
    const secondDeployment = database.getDeployment(secondPreview.deployment_id!)!;
    expect(secondPreview).toMatchObject({
      deployment_id: secondDeployment.id,
      active_deployment_id: firstDeployment.id,
      status: "queued"
    });
    reconcileRouting(config, database);
    let routing = fs.readFileSync(config.traefikConfigPath, "utf8");
    expect(routing).toContain("http://shelter-preview-first:3000");

    expect(database.beginPullRequestPreviewBuild(secondPreview.id, secondDeployment.id)).toBe(true);
    database.updateDeployment(secondDeployment.id, {
      status: "checking",
      image_tag: "shelter/preview:second",
      runtime_container: "shelter-preview-second",
      internal_port: 3000
    });
    reconcileRouting(config, database);
    routing = fs.readFileSync(config.traefikConfigPath, "utf8");
    expect(routing).toContain("http://shelter-preview-first:3000");
    expect(routing).not.toContain("http://shelter-preview-second:3000");

    expect(database.completePullRequestPreview(secondPreview.id, secondDeployment.id)).toBe(true);

    expect(database.getDeployment(firstDeployment.id)).toMatchObject({
      status: "cancelled",
      failure_kind: "superseded"
    });
    expect(database.getDeployment(secondDeployment.id)?.status).toBe("ready");
    expect(database.getPullRequestPreview(secondPreview.id)).toMatchObject({
      deployment_id: secondDeployment.id,
      active_deployment_id: secondDeployment.id
    });
    reconcileRouting(config, database);
    routing = fs.readFileSync(config.traefikConfigPath, "utf8");
    expect(routing).toContain("http://shelter-preview-second:3000");
    expect(routing).not.toContain("http://shelter-preview-first:3000");

    expect(database.restorePullRequestPreviewActive(
      secondPreview.id,
      secondDeployment.id,
      firstDeployment.id
    )).toBe(true);
    expect(database.restorePullRequestPreviewActive(
      secondPreview.id,
      secondDeployment.id,
      firstDeployment.id
    )).toBe(false);
    expect(database.getDeployment(firstDeployment.id)).toMatchObject({
      status: "ready",
      failure_kind: null,
      error: null
    });
    expect(database.getPullRequestPreview(secondPreview.id)?.active_deployment_id).toBe(firstDeployment.id);
    database.updateDeployment(secondDeployment.id, { status: "failed", failure_kind: "activation" });
    database.failPullRequestPreview(secondPreview.id, secondDeployment.id, "Routing failed");
    reconcileRouting(config, database);
    routing = fs.readFileSync(config.traefikConfigPath, "utf8");
    expect(routing).toContain("http://shelter-preview-first:3000");
    expect(routing).not.toContain("http://shelter-preview-second:3000");

    database.closePullRequestPreview(secondPreview.id);
    expect(database.getPullRequestPreview(secondPreview.id)).toMatchObject({
      deployment_id: null,
      active_deployment_id: null,
      status: "closed"
    });
    reconcileRouting(config, database);
    routing = fs.readFileSync(config.traefikConfigPath, "utf8");
    expect(routing).not.toContain(secondPreview.hostname);
    database.close();
  });

  it("retries a worker-interrupted SHA only once per preview generation", async () => {
    const { database, github, project } = context();
    await github.handleWebhook("pull_request", "recovery-1", Buffer.from(JSON.stringify(payload(8))));
    const firstPreview = database.findPullRequestPreview(project.id, 8)!;
    const firstDeployment = database.getDeployment(firstPreview.deployment_id!)!;
    database.updatePullRequestPreviewDns(firstPreview.id, firstDeployment.id, "zone-id", "preview-record");
    database.beginPullRequestPreviewBuild(firstPreview.id, firstDeployment.id);
    database.updateDeployment(firstDeployment.id, {
      status: "checking",
      runtime_container: "shelter-preview-recovery-active",
      internal_port: 3000
    });
    expect(database.completePullRequestPreview(firstPreview.id, firstDeployment.id)).toBe(true);

    const synchronize = payload(8);
    synchronize.action = "synchronize";
    synchronize.pull_request.head.sha = "d".repeat(40);
    await github.handleWebhook("pull_request", "recovery-2", Buffer.from(JSON.stringify(synchronize)));
    const failedCandidate = database.findPullRequestPreview(project.id, 8)!;
    const failedDeploymentId = failedCandidate.deployment_id!;
    database.updateDeployment(failedDeploymentId, {
      status: "failed",
      failure_kind: "worker",
      error: "Worker restarted"
    });
    database.failPullRequestPreview(failedCandidate.id, failedDeploymentId, "Worker restarted");

    expect(database.materializePullRequestPreview(failedCandidate.id)).toBeUndefined();
    const recovered = database.materializePullRequestPreview(
      failedCandidate.id,
      { allowWorkerRetry: true }
    )!;
    expect(recovered.id).not.toBe(failedDeploymentId);
    expect(recovered.commit_sha).toBe("d".repeat(40));
    expect(recovered.github_delivery_id).toBe("recovery-2");
    expect(database.getPullRequestPreview(failedCandidate.id)).toMatchObject({
      deployment_id: recovered.id,
      active_deployment_id: firstDeployment.id,
      status: "queued"
    });
    expect(database.getPullRequestPreviewByDeployment(firstDeployment.id)?.id).toBe(failedCandidate.id);

    database.updateDeployment(recovered.id, {
      status: "failed",
      failure_kind: "worker",
      error: "Worker restarted again"
    });
    database.failPullRequestPreview(failedCandidate.id, recovered.id, "Worker restarted again");
    expect(database.materializePullRequestPreview(
      failedCandidate.id,
      { allowWorkerRetry: true }
    )).toBeUndefined();
    expect(database.getPullRequestPreview(failedCandidate.id)?.worker_retry_generation)
      .toBe(failedCandidate.generation);

    const nextGeneration = payload(8);
    nextGeneration.action = "synchronize";
    nextGeneration.pull_request.head.sha = "f".repeat(40);
    await github.handleWebhook(
      "pull_request",
      "recovery-3",
      Buffer.from(JSON.stringify(nextGeneration))
    );
    const nextPreview = database.findPullRequestPreview(project.id, 8)!;
    expect(nextPreview.generation).toBeGreaterThan(failedCandidate.generation);
    const nextFailedDeploymentId = nextPreview.deployment_id!;
    database.updateDeployment(nextFailedDeploymentId, {
      status: "failed",
      failure_kind: "worker",
      error: "New generation interrupted"
    });
    database.failPullRequestPreview(nextPreview.id, nextFailedDeploymentId, "New generation interrupted");
    const nextRetry = database.materializePullRequestPreview(
      nextPreview.id,
      { allowWorkerRetry: true }
    );
    expect(nextRetry?.commit_sha).toBe("f".repeat(40));
    expect(database.getPullRequestPreview(nextPreview.id)?.worker_retry_generation)
      .toBe(nextPreview.generation);
    database.close();
  });

  it("does not revive or retarget a preview while its DNS record is closing", async () => {
    const { database, github, project } = context();
    await github.handleWebhook("pull_request", "closing-1", Buffer.from(JSON.stringify(payload(9))));
    const preview = database.findPullRequestPreview(project.id, 9)!;
    database.updatePullRequestPreviewDns(preview.id, preview.deployment_id!, "zone-id", "record-9");
    database.requestPullRequestPreviewClose(project.id, preview.id);
    const before = database.getPullRequestPreview(preview.id)!;
    const deploymentCount = database.listPreviewDeployments(preview.id).length;

    const queued = database.queuePullRequestPreview({
      projectId: project.id,
      pullRequestNumber: 9,
      headSha: "e".repeat(40),
      headRef: "late-update",
      baseRef: "main",
      repositoryId: "99",
      repositoryFullName: "example/app",
      deliveryId: "closing-2",
      hostname: "retargeted.example.net",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      commitMessage: "late update",
      commitAuthor: "ada",
      commitUrl: null
    });

    expect(queued.kind).toBe("deduplicated");
    expect(database.getPullRequestPreview(preview.id)).toMatchObject({
      status: "closing",
      hostname: before.hostname,
      zone_id: "zone-id",
      dns_record_id: "record-9",
      deployment_id: before.deployment_id
    });
    expect(database.listPreviewDeployments(preview.id)).toHaveLength(deploymentCount);
    database.close();
  });

  it("migrates a legacy ready preview to the active deployment pointer", async () => {
    const { config, database, github, project } = context();
    await github.handleWebhook("pull_request", "migration-1", Buffer.from(JSON.stringify(payload(14))));
    const preview = database.findPullRequestPreview(project.id, 14)!;
    database.updatePullRequestPreviewDns(preview.id, preview.deployment_id!, "zone-id", "record-14");
    database.beginPullRequestPreviewBuild(preview.id, preview.deployment_id!);
    database.updateDeployment(preview.deployment_id!, {
      status: "checking",
      runtime_container: "shelter-preview-migration",
      internal_port: 3000
    });
    database.completePullRequestPreview(preview.id, preview.deployment_id!);
    database.close();

    const legacy = new BetterSqlite3(config.databasePath);
    legacy.exec("ALTER TABLE pull_request_previews DROP COLUMN active_deployment_id");
    legacy.exec("ALTER TABLE pull_request_previews DROP COLUMN worker_retry_generation");
    legacy.close();

    const migrated = new Database(config);
    expect(migrated.getPullRequestPreview(preview.id)).toMatchObject({
      deployment_id: preview.deployment_id,
      active_deployment_id: preview.deployment_id,
      worker_retry_generation: null,
      status: "ready"
    });
    migrated.close();
  });

  it("immediately closes previews when installation or repository access is revoked", async () => {
    const installation = context();
    await installation.github.handleWebhook(
      "pull_request",
      "revoked-installation",
      Buffer.from(JSON.stringify(payload(6)))
    );
    const installationPreview = installation.database.findPullRequestPreview(installation.project.id, 6)!;
    expect(installation.database.disableGithubInstallation("123", "Installation suspended")).toBe(1);
    expect(installation.database.getPullRequestPreview(installationPreview.id)?.status).toBe("closing");
    expect(installation.database.getDeployment(installationPreview.deployment_id!)).toMatchObject({
      status: "cancelled",
      failure_kind: "cancelled"
    });
    installation.database.close();

    const repository = context();
    await repository.github.handleWebhook(
      "pull_request",
      "revoked-repository",
      Buffer.from(JSON.stringify(payload(7)))
    );
    const repositoryPreview = repository.database.findPullRequestPreview(repository.project.id, 7)!;
    expect(repository.database.disableGithubRepositories("123", ["99"], "Repository removed")).toBe(1);
    expect(repository.database.getPullRequestPreview(repositoryPreview.id)?.status).toBe("closing");
    expect(repository.database.getDeployment(repositoryPreview.deployment_id!)).toMatchObject({
      status: "cancelled",
      failure_kind: "cancelled"
    });
    repository.database.close();
  });

  it("unpublishes routes synchronously for PR close, installation revoke, and global disconnect", async () => {
    const closed = context();
    await closed.github.handleWebhook("pull_request", "close-open", Buffer.from(JSON.stringify(payload(16))));
    const closedPreviewId = activatePreview(closed.database, closed.project.id, 16);
    reconcileRouting(closed.config, closed.database);
    expect(fs.readFileSync(closed.config.traefikConfigPath, "utf8")).toContain("pr-16--");
    const closePayload = payload(16);
    closePayload.action = "closed";
    await closed.github.handleWebhook("pull_request", "close-event", Buffer.from(JSON.stringify(closePayload)));
    expect(closed.database.getPullRequestPreview(closedPreviewId)?.status).toBe("closing");
    expect(fs.readFileSync(closed.config.traefikConfigPath, "utf8")).not.toContain("pr-16--");
    closed.database.close();

    const revoked = context();
    await revoked.github.handleWebhook("pull_request", "revoke-open", Buffer.from(JSON.stringify(payload(17))));
    const revokedPreviewId = activatePreview(revoked.database, revoked.project.id, 17);
    reconcileRouting(revoked.config, revoked.database);
    expect(fs.readFileSync(revoked.config.traefikConfigPath, "utf8")).toContain("pr-17--");
    await revoked.github.handleWebhook("installation", "revoke-event", Buffer.from(JSON.stringify({
      action: "suspend",
      installation: { id: 123 }
    })));
    expect(revoked.database.getPullRequestPreview(revokedPreviewId)?.status).toBe("closing");
    expect(fs.readFileSync(revoked.config.traefikConfigPath, "utf8")).not.toContain("pr-17--");
    revoked.database.close();

    const disconnected = context();
    await disconnected.github.handleWebhook("pull_request", "disconnect-open", Buffer.from(JSON.stringify(payload(18))));
    const disconnectedPreviewId = activatePreview(disconnected.database, disconnected.project.id, 18);
    reconcileRouting(disconnected.config, disconnected.database);
    expect(fs.readFileSync(disconnected.config.traefikConfigPath, "utf8")).toContain("pr-18--");
    await disconnected.github.disconnect();
    expect(disconnected.database.getPullRequestPreview(disconnectedPreviewId)?.status).toBe("closing");
    expect(fs.readFileSync(disconnected.config.traefikConfigPath, "utf8")).not.toContain("pr-18--");
    disconnected.database.close();
  });

  it("caps active previews at three and closes DNS through the API reconciler", async () => {
    const { database, github } = context();
    for (let number = 10; number <= 13; number += 1) {
      await github.handleWebhook("pull_request", `limit-${number}`, Buffer.from(JSON.stringify(payload(number))));
    }
    expect(database.findPullRequestPreview("prj_preview", 13)?.status).toBe("blocked");
    const blocked = database.findPullRequestPreview("prj_preview", 13)!;
    expect(blocked.deployment_id).not.toBeNull();
    expect(database.getDeployment(blocked.deployment_id!)).toMatchObject({
      status: "failed",
      failure_kind: "activation"
    });
    expect(database.listDueGithubStatuses(20).find((row) => row.deployment_id === blocked.deployment_id))
      .toMatchObject({ desired_state: "failure", description: "Preview-Limit erreicht" });
    const preview = database.findPullRequestPreview("prj_preview", 10)!;
    database.sqlite.prepare("UPDATE pull_request_previews SET expires_at=? WHERE id=?")
      .run(new Date(Date.now() - 1_000).toISOString(), preview.id);
    expect(database.nextPullRequestPreviewCleanup()?.id).toBe(preview.id);
    database.updatePullRequestPreviewDns(preview.id, preview.deployment_id!, "zone-id", "record-10");
    database.requestPullRequestPreviewClose("prj_preview", preview.id);
    const cloudflare = {
      deletePreviewDnsRecord: vi.fn(async () => undefined),
      checkHostname: vi.fn(),
      ensurePreviewDnsRecord: vi.fn()
    };
    const reconciler = new PreviewDnsReconciler(database, cloudflare as never);
    expect(await reconciler.processNext()).toBe(true);
    expect(cloudflare.deletePreviewDnsRecord).toHaveBeenCalledWith("zone-id", "record-10", preview.hostname);
    expect(database.getPullRequestPreview(preview.id)).toMatchObject({ status: "closing", zone_id: null, dns_record_id: null });
    database.close();
  });

  it("turns a terminal DNS provisioning failure into a GitHub failure status", async () => {
    const { database, github, project } = context();
    await github.handleWebhook("pull_request", "dns-terminal", Buffer.from(JSON.stringify(payload(15))));
    const preview = database.findPullRequestPreview(project.id, 15)!;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      database.recordPullRequestPreviewDnsFailure(preview.id, "Cloudflare collision");
    }
    expect(database.getPullRequestPreview(preview.id)?.status).toBe("failed");
    expect(database.getDeployment(preview.deployment_id!)).toMatchObject({
      status: "failed",
      failure_kind: "activation"
    });
    expect(database.listDueGithubStatuses(20).find((row) => row.deployment_id === preview.deployment_id))
      .toMatchObject({ desired_state: "failure", description: "Preview-DNS konnte nicht bereitgestellt werden" });
    database.close();
  });
});
