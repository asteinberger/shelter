import {
  createHash,
  createHmac,
  createPrivateKey,
  sign as cryptoSign,
  timingSafeEqual
} from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database, GithubStatusOutboxRow } from "../lib/database.js";
import { badRequest, conflict, HttpError, upstreamError } from "../lib/errors.js";
import { decryptString, encryptString, hashToken, randomToken } from "../lib/security.js";
import {
  analyzeProjectFiles,
  MAX_ANALYSIS_CONTENT_BYTES,
  relevantGitHubTreePaths,
  requiresAnalysisContent,
  type ProjectAnalysis,
  type ProjectFileFact
} from "./project-analysis.js";
import { pullRequestPreviewHostname } from "./pull-request-previews.js";

export const GITHUB_MANIFEST_CALLBACK_PATH = "/api/settings/github/manifest/callback";
export const GITHUB_SETUP_CALLBACK_PATH = "/api/settings/github/setup/callback";
export const GITHUB_MANIFEST_COOKIE = "shelter_github_manifest";
export const LEGACY_GITHUB_MANIFEST_COOKIE = "portsmith_github_manifest";

const GITHUB_API = "https://api.github.com";
const GITHUB_REGISTRATION_URL = "https://github.com/settings/apps/new";
const API_VERSION = "2026-03-10";
const MANIFEST_TTL_MS = 10 * 60_000;
const MAX_PAGES = 20;
const PAGE_SIZE = 100;
const ANALYSIS_CACHE_TTL_MS = 10 * 60_000;
const ANALYSIS_CACHE_MAX_ENTRIES = 128;
const ANALYSIS_MAX_CONTENT_FILES = 128;
const ANALYSIS_CONTENT_CONCURRENCY = 4;

const APP_METADATA_KEY = "github.app_metadata";
const PRIVATE_KEY_KEY = "github.private_key";
const WEBHOOK_SECRET_KEY = "github.webhook_secret";
const SETUP_STATE_HASH_KEY = "github.setup_state_hash";

const AppMetadataSchema = z.object({
  version: z.literal(1),
  appId: z.string().regex(/^\d+$/),
  appName: z.string().min(1).max(255),
  appSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
  appUrl: z.url(),
  createdAt: z.iso.datetime()
}).strict();

type AppMetadata = z.infer<typeof AppMetadataSchema>;

const ManifestConversionSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  name: z.string().min(1).max(255),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
  html_url: z.url(),
  pem: z.string().min(100).max(64 * 1024),
  webhook_secret: z.string().min(16).max(1024)
}).passthrough();

const InstallationSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  app_id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  account: z.object({
    login: z.string().min(1).max(255),
    type: z.string().min(1).max(64),
    avatar_url: z.url().nullable().optional()
  }),
  repository_selection: z.enum(["all", "selected"]).optional().default("selected"),
  suspended_at: z.string().nullable().optional()
}).passthrough();

const RepositorySchema = z.object({
  id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  name: z.string().min(1).max(255),
  full_name: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/),
  private: z.boolean(),
  default_branch: z.string().min(1).max(255),
  html_url: z.url(),
  clone_url: z.url(),
  owner: z.object({ login: z.string().min(1).max(255) })
}).passthrough();

const BranchSchema = z.object({
  name: z.string().min(1).max(255),
  protected: z.boolean().optional().default(false),
  commit: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/i) })
}).passthrough();

const CommitSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  html_url: z.url(),
  commit: z.object({
    message: z.string().max(1_000_000),
    author: z.object({ name: z.string().max(255) }).nullable().optional(),
    committer: z.object({ name: z.string().max(255) }).nullable().optional()
  })
}).passthrough();

const InstallationTokenSchema = z.object({
  token: z.string().min(20).max(4096),
  expires_at: z.iso.datetime()
}).passthrough();

const AppCapabilitySchema = z.object({
  permissions: z.record(z.string(), z.string()).default({}),
  events: z.array(z.string()).default([])
}).passthrough();

const GitTreeSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  truncated: z.boolean().optional().default(false),
  tree: z.array(z.object({
    path: z.string().min(1).max(4096),
    type: z.enum(["blob", "tree", "commit"]),
    size: z.number().int().min(0).optional()
  }).passthrough())
}).passthrough();

const RepositoryContentSchema = z.object({
  type: z.literal("file"),
  encoding: z.literal("base64"),
  content: z.string(),
  size: z.number().int().min(0)
}).passthrough();

const PushSchema = z.object({
  ref: z.string().min(1).max(1024),
  deleted: z.boolean().optional().default(false),
  installation: z.object({ id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]) }),
  repository: z.object({
    id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
    full_name: z.string().min(3).max(512)
  })
}).passthrough();

const PullRequestEventSchema = z.object({
  action: z.enum(["opened", "reopened", "synchronize", "closed"]),
  installation: z.object({ id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]) }),
  repository: z.object({
    id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
    full_name: z.string().min(3).max(512)
  }),
  sender: z.object({ login: z.string().min(1).max(255) }),
  pull_request: z.object({
    number: z.number().int().positive().max(2_147_483_647),
    title: z.string().max(4096),
    html_url: z.url(),
    head: z.object({
      sha: z.string().regex(/^[a-f0-9]{40,64}$/i),
      ref: z.string().min(1).max(255),
      repo: z.object({
        id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
        full_name: z.string().min(3).max(512)
      }).nullable()
    }),
    base: z.object({
      ref: z.string().min(1).max(255),
      repo: z.object({
        id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
        full_name: z.string().min(3).max(512)
      })
    })
  })
}).passthrough();

const InstallationEventSchema = z.object({
  action: z.string().min(1).max(64),
  installation: z.object({ id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]) })
}).passthrough();

const InstallationRepositoriesEventSchema = z.object({
  action: z.string().min(1).max(64),
  installation: z.object({ id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]) }),
  repositories_removed: z.array(z.object({
    id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)])
  })).max(10_000).optional().default([]),
  repositories_added: z.array(z.object({
    id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)])
  })).max(10_000).optional().default([])
}).passthrough();

export interface GitHubManifest {
  name: string;
  url: string;
  hook_attributes: { url: string; active: true };
  redirect_url: string;
  setup_url: string;
  public: false;
  request_oauth_on_install: false;
  default_permissions: { contents: "read"; statuses: "write"; metadata: "read"; pull_requests: "read" };
  default_events: ["push", "pull_request"];
}

export interface GitHubInstallation {
  id: string;
  accountLogin: string;
  accountType: string;
  accountAvatarUrl: string | null;
  repositorySelection: "all" | "selected";
  suspendedAt: string | null;
}

export interface GitHubRepository {
  id: string;
  installationId: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
  owner: string;
  ownerLogin: string;
}

export interface GitHubBranch {
  name: string;
  protected: boolean;
  sha: string;
  commitSha: string;
}

export interface GitHubState {
  configured: boolean;
  connected: boolean;
  appId: string | null;
  appName: string | null;
  appSlug: string | null;
  appUrl: string | null;
  htmlUrl: string | null;
  installUrl: string | null;
}

export interface GitHubPreviewCapability {
  ready: boolean;
  configured: boolean;
  pullRequestsPermission: boolean;
  pullRequestEvent: boolean;
  remediation: "none" | "configure_app" | "update_existing_app";
}

interface GithubFetchOptions {
  method?: "GET" | "POST";
  token?: string;
  appAuthentication?: boolean;
  body?: unknown;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

interface InstallationTokenRequest {
  epoch: number;
  generation: number;
  promise: Promise<string>;
}

export class GitHubService {
  private readonly installationTokens = new Map<string, CachedToken>();
  private readonly installationTokenRequests = new Map<string, InstallationTokenRequest>();
  private readonly installationTokenGenerations = new Map<string, number>();
  private installationTokenEpoch = 0;
  private readonly analysisCache = new Map<string, { expiresAt: number; analysis: ProjectAnalysis }>();
  private readonly analysisRequests = new Map<string, Promise<ProjectAnalysis>>();

  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  state(): GitHubState {
    const metadata = this.metadata();
    const configured = Boolean(metadata && this.hasStoredSecrets());
    const appUrl = configured ? metadata!.appUrl : null;
    return {
      configured,
      connected: configured,
      appId: configured ? metadata!.appId : null,
      appName: configured ? metadata!.appName : null,
      appSlug: configured ? metadata!.appSlug : null,
      appUrl,
      htmlUrl: appUrl,
      installUrl: appUrl ? `${appUrl}/installations/new` : null
    };
  }

  async previewCapability(): Promise<GitHubPreviewCapability> {
    if (!this.state().configured) {
      return {
        ready: false,
        configured: false,
        pullRequestsPermission: false,
        pullRequestEvent: false,
        remediation: "configure_app"
      };
    }
    const app = this.parseUpstream(
      AppCapabilitySchema,
      await this.githubRequest<unknown>("/app", { appAuthentication: true })
    );
    const pullRequestsPermission = app.permissions.pull_requests === "read" || app.permissions.pull_requests === "write";
    const pullRequestEvent = app.events.includes("pull_request");
    return {
      ready: pullRequestsPermission && pullRequestEvent,
      configured: true,
      pullRequestsPermission,
      pullRequestEvent,
      remediation: pullRequestsPermission && pullRequestEvent ? "none" : "update_existing_app"
    };
  }

  startManifest(userId: string, sessionTokenHash: string): {
    registrationUrl: string;
    manifest: GitHubManifest;
    browserNonce: string;
    secureCookie: true;
  } {
    const origin = this.panelOrigin();
    const state = randomToken();
    const browserNonce = randomToken();
    const setupState = randomToken();
    const callbackUrl = `${origin}${GITHUB_MANIFEST_CALLBACK_PATH}`;
    const now = new Date();
    this.database.createGithubManifestFlow({
      state_hash: hashToken(state),
      browser_nonce_hash: hashToken(browserNonce),
      user_id: userId,
      session_token_hash: sessionTokenHash,
      encrypted_setup_state: this.encryptSecret("github.setup_state:v1", setupState),
      redirect_uri: callbackUrl,
      expires_at: new Date(now.getTime() + MANIFEST_TTL_MS).toISOString(),
      created_at: now.toISOString()
    });

    const panelName = new URL(origin).hostname.replaceAll(".", "-");
    const manifest: GitHubManifest = {
      name: `Shelter ${panelName}`.slice(0, 34),
      url: origin,
      hook_attributes: { url: `${origin}/api/webhooks/github`, active: true },
      redirect_url: callbackUrl,
      setup_url: `${origin}${GITHUB_SETUP_CALLBACK_PATH}?state=${encodeURIComponent(setupState)}`,
      public: false,
      request_oauth_on_install: false,
      default_permissions: { contents: "read", statuses: "write", metadata: "read", pull_requests: "read" },
      // GitHub Apps always receive installation and installation_repositories.
      // GitHub rejects manifests that try to subscribe to those implicit events.
      default_events: ["push", "pull_request"]
    };
    return {
      registrationUrl: `${GITHUB_REGISTRATION_URL}?state=${encodeURIComponent(state)}`,
      manifest,
      browserNonce,
      secureCookie: true
    };
  }

  cancelManifest(state: string, browserNonce: string): void {
    this.database.consumeGithubManifestFlow(hashToken(state), hashToken(browserNonce));
  }

  async completeManifest(state: string, browserNonce: string, code: string): Promise<{ installUrl: string }> {
    const flow = this.database.consumeGithubManifestFlow(hashToken(state), hashToken(browserNonce));
    if (!flow) throw conflict("Die GitHub-App-Anmeldung ist abgelaufen oder ungültig", "GITHUB_MANIFEST_STATE_INVALID");
    const setupState = this.decryptSecret("github.setup_state:v1", flow.encrypted_setup_state);
    const raw = await this.githubRequest<unknown>(`/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST"
    });
    const conversion = this.parseUpstream(ManifestConversionSchema, raw);
    const appId = String(conversion.id);
    const appUrl = this.validatedAppUrl(conversion.html_url, conversion.slug);
    this.validatePrivateKey(conversion.pem);
    const metadata: AppMetadata = {
      version: 1,
      appId,
      appName: conversion.name,
      appSlug: conversion.slug,
      appUrl,
      createdAt: new Date().toISOString()
    };
    this.database.sqlite.transaction(() => {
      const previousAppId = this.metadata()?.appId;
      if (previousAppId && previousAppId !== appId) this.database.disconnectGithubProjects();
      this.database.setSetting(APP_METADATA_KEY, JSON.stringify(metadata));
      this.database.setSetting(PRIVATE_KEY_KEY, this.encryptSecret("github.private_key:v1", conversion.pem));
      this.database.setSetting(WEBHOOK_SECRET_KEY, this.encryptSecret("github.webhook_secret:v1", conversion.webhook_secret));
      this.database.setSetting(SETUP_STATE_HASH_KEY, hashToken(setupState));
      this.database.deleteGithubManifestFlows();
    })();
    this.invalidateAllInstallationTokens();
    return { installUrl: `${appUrl}/installations/new` };
  }

  async completeSetup(state: string, installationId: string): Promise<void> {
    const expectedHash = this.database.getSetting(SETUP_STATE_HASH_KEY);
    if (!expectedHash || !this.safeEqualHex(expectedHash, hashToken(state))) {
      throw conflict("Die GitHub-Installation konnte nicht sicher zugeordnet werden", "GITHUB_SETUP_STATE_INVALID");
    }
    const metadata = this.requireMetadata();
    const installation = this.parseUpstream(InstallationSchema, await this.githubRequest<unknown>(
      `/app/installations/${this.installationId(installationId)}`,
      { appAuthentication: true }
    ));
    if (String(installation.app_id) !== metadata.appId) {
      throw conflict("Die Installation gehört nicht zu dieser GitHub App", "GITHUB_INSTALLATION_MISMATCH");
    }
  }

  async disconnect(): Promise<GitHubState> {
    this.database.sqlite.transaction(() => {
      for (const key of [APP_METADATA_KEY, PRIVATE_KEY_KEY, WEBHOOK_SECRET_KEY, SETUP_STATE_HASH_KEY]) {
        this.database.deleteSetting(key);
      }
      this.database.deleteGithubManifestFlows();
      this.database.disconnectGithubProjects();
    })();
    this.invalidateAllInstallationTokens();
    return this.state();
  }

  resultUrl(result: "connected" | "installed" | "error"): string {
    return `${this.panelOrigin()}/settings/github?github=${result}`;
  }

  async installations(): Promise<GitHubInstallation[]> {
    const rows = await this.paginate<unknown>("/app/installations", { appAuthentication: true });
    return rows.map((row) => {
      const parsed = this.parseUpstream(InstallationSchema, row);
      return {
        id: String(parsed.id),
        accountLogin: parsed.account.login,
        accountType: parsed.account.type,
        accountAvatarUrl: parsed.account.avatar_url ?? null,
        repositorySelection: parsed.repository_selection,
        suspendedAt: parsed.suspended_at ?? null
      };
    });
  }

  async repositories(): Promise<{ installations: GitHubInstallation[]; repositories: GitHubRepository[] }> {
    const installations = await this.installations();
    const active = installations.filter((installation) => !installation.suspendedAt);
    const repositories = (await Promise.all(active.map(async (installation) => {
      const token = await this.installationToken(installation.id);
      const pages: unknown[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const response = this.parseUpstream(z.object({ repositories: z.array(z.unknown()) }).passthrough(),
          await this.githubRequest<unknown>(`/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`, { token })
        );
        pages.push(...response.repositories);
        if (response.repositories.length < PAGE_SIZE) break;
      }
      return pages.map((repository) => this.presentRepository(
        installation.id,
        this.parseUpstream(RepositorySchema, repository)
      ));
    }))).flat();
    return { installations, repositories };
  }

  async repository(installationId: string, repositoryId: string): Promise<GitHubRepository> {
    const normalizedInstallation = this.installationId(installationId);
    const normalizedRepository = this.repositoryId(repositoryId);
    const token = await this.installationToken(normalizedInstallation, normalizedRepository);
    const repository = this.parseUpstream(RepositorySchema, await this.githubRequest<unknown>(
      `/repositories/${normalizedRepository}`,
      { token }
    ));
    return this.presentRepository(normalizedInstallation, repository);
  }

  async branches(installationId: string, repositoryId: string): Promise<GitHubBranch[]> {
    const repository = await this.repository(installationId, repositoryId);
    const token = await this.installationToken(repository.installationId, repository.id);
    const rows = await this.paginate<unknown>(
      `/repos/${this.repositoryPath(repository.fullName)}/branches`,
      { token }
    );
    return rows.map((row) => this.presentBranch(this.parseUpstream(BranchSchema, row)));
  }

  async resolveRepository(
    installationId: string,
    repositoryId: string,
    branchName?: string
  ): Promise<{ repository: GitHubRepository; branch: GitHubBranch }> {
    const repository = await this.repository(installationId, repositoryId);
    const branch = (branchName ?? repository.defaultBranch).trim();
    if (!branch || branch.length > 255) {
      throw new HttpError(400, "GITHUB_BRANCH_INVALID", "Der GitHub-Branch ist ungültig");
    }
    const token = await this.installationToken(repository.installationId, repository.id);
    const parsed = this.parseUpstream(BranchSchema, await this.githubRequest<unknown>(
      `/repos/${this.repositoryPath(repository.fullName)}/branches/${encodeURIComponent(branch)}`,
      { token }
    ));
    return { repository, branch: this.presentBranch(parsed) };
  }

  async analyzeRepository(
    installationId: string,
    repositoryId: string,
    branchName?: string,
    alreadyResolved?: { repository: GitHubRepository; branch: GitHubBranch }
  ): Promise<ProjectAnalysis> {
    const resolved = alreadyResolved ?? await this.resolveRepository(installationId, repositoryId, branchName);
    const cacheKey = `${resolved.repository.id}:${resolved.branch.sha}`;
    const cached = this.analysisCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      this.analysisCache.delete(cacheKey);
      this.analysisCache.set(cacheKey, cached);
      return cached.analysis;
    }
    if (cached) this.analysisCache.delete(cacheKey);
    const inFlight = this.analysisRequests.get(cacheKey);
    if (inFlight) return inFlight;

    let request!: Promise<ProjectAnalysis>;
    request = this.fetchRepositoryAnalysis(resolved).then((analysis) => {
      this.cacheAnalysis(cacheKey, analysis);
      return analysis;
    }).finally(() => {
      if (this.analysisRequests.get(cacheKey) === request) this.analysisRequests.delete(cacheKey);
    });
    this.analysisRequests.set(cacheKey, request);
    return request;
  }

  async installationToken(installationId: string, repositoryId?: string): Promise<string> {
    const id = this.installationId(installationId);
    const scopedRepositoryId = repositoryId === undefined ? undefined : this.repositoryId(repositoryId);
    const cacheKey = `${id}:${scopedRepositoryId ?? "*"}`;
    const epoch = this.installationTokenEpoch;
    const generation = this.installationTokenGenerations.get(id) ?? 0;
    const cached = this.installationTokens.get(cacheKey);
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
    const existingRequest = this.installationTokenRequests.get(cacheKey);
    if (existingRequest?.epoch === epoch && existingRequest.generation === generation) {
      return existingRequest.promise;
    }
    let request!: Promise<string>;
    request = (async () => {
      const parsed = this.parseUpstream(InstallationTokenSchema, await this.githubRequest<unknown>(
        `/app/installations/${id}/access_tokens`,
        {
          method: "POST",
          appAuthentication: true,
          ...(scopedRepositoryId
            ? { body: { repository_ids: [this.repositoryIdNumber(scopedRepositoryId)], permissions: { contents: "read", statuses: "write" } } }
            : {})
        }
      ));
      const expiresAt = new Date(parsed.expires_at).getTime();
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000) {
        throw upstreamError("GitHub hat ein ungültiges Installation-Token geliefert", "GITHUB_TOKEN_INVALID");
      }
      if (
        this.installationTokenEpoch !== epoch ||
        (this.installationTokenGenerations.get(id) ?? 0) !== generation
      ) {
        throw conflict(
          "Die GitHub-Installation hat sich während der Token-Anfrage geändert",
          "GITHUB_TOKEN_INVALIDATED"
        );
      }
      this.installationTokens.set(cacheKey, { token: parsed.token, expiresAt });
      return parsed.token;
    })().finally(() => {
      if (this.installationTokenRequests.get(cacheKey)?.promise === request) {
        this.installationTokenRequests.delete(cacheKey);
      }
    });
    this.installationTokenRequests.set(cacheKey, { epoch, generation, promise: request });
    return request;
  }

  async reportCommitStatus(
    status: GithubStatusOutboxRow,
    projectId: string
  ): Promise<void> {
    const token = await this.installationToken(status.installation_id, status.repository_id);
    const deployment = this.database.getDeployment(status.deployment_id);
    const preview = deployment?.deployment_scope === "preview" && deployment.preview_id
      ? this.database.getPullRequestPreview(deployment.preview_id)
      : undefined;
    const panelDomain = this.database.getSetting("cloudflare.panel_domain");
    const targetUrl = preview?.status === "ready"
      ? `https://${preview.hostname}`
      : panelDomain
        ? deployment?.deployment_scope === "preview"
          ? `https://${panelDomain}/projects/${encodeURIComponent(projectId)}?tab=previews&preview=${encodeURIComponent(preview?.id ?? "")}`
          : `https://${panelDomain}/projects/${encodeURIComponent(projectId)}?tab=deployments&deployment=${encodeURIComponent(status.deployment_id)}`
        : undefined;
    await this.githubRequest(`/repos/${this.repositoryPath(status.repository_full_name)}/statuses/${encodeURIComponent(status.commit_sha)}`, {
      method: "POST",
      token,
      body: {
        state: status.desired_state,
        description: status.description,
        context: deployment?.deployment_scope === "preview" ? "shelter/preview" : "shelter/deploy",
        ...(targetUrl ? { target_url: targetUrl } : {})
      }
    });
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): void {
    if (!signatureHeader || !/^sha256=[a-f0-9]{64}$/i.test(signatureHeader)) {
      throw new HttpError(401, "GITHUB_SIGNATURE_INVALID", "Ungültige GitHub-Webhook-Signatur");
    }
    const secret = this.secret(WEBHOOK_SECRET_KEY, "github.webhook_secret:v1");
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    const supplied = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new HttpError(401, "GITHUB_SIGNATURE_INVALID", "Ungültige GitHub-Webhook-Signatur");
    }
  }

  async handleWebhook(eventName: string, deliveryId: string, rawBody: Buffer): Promise<{
    duplicate: boolean;
    queued: number;
    pending: number;
    ignored: number;
  }> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(deliveryId)) {
      throw new HttpError(400, "GITHUB_DELIVERY_INVALID", "Ungültige GitHub-Delivery-ID");
    }
    if (!/^[a-z_]{1,64}$/.test(eventName)) {
      throw new HttpError(400, "GITHUB_EVENT_INVALID", "Ungültiger GitHub-Event-Name");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new HttpError(400, "GITHUB_PAYLOAD_INVALID", "GitHub-Webhook enthält kein gültiges JSON");
    }
    const payloadHash = createHash("sha256").update(rawBody).digest("hex");
    const accept = this.database.sqlite.transaction(() => {
      const claimed = this.database.claimGithubWebhookDelivery(deliveryId, eventName, payloadHash);
      if (claimed === "duplicate") return { duplicate: true, queued: 0, pending: 0, ignored: 0 };
      if (claimed === "mismatch") {
        throw conflict("GitHub-Delivery-ID wurde mit abweichendem Inhalt wiederverwendet", "GITHUB_DELIVERY_MISMATCH");
      }
      const result = eventName === "push"
        ? this.acceptPush(deliveryId, payload)
        : eventName === "pull_request"
          ? this.acceptPullRequest(deliveryId, payload)
        : eventName === "installation"
          ? this.handleInstallation(payload)
          : eventName === "installation_repositories"
            ? this.handleInstallationRepositories(payload)
            : { queued: 0, pending: 0, ignored: 1 };
      const status = result.pending > 0 || result.queued > 0 ? "processed" : "ignored";
      this.database.finishGithubWebhookDelivery(deliveryId, status);
      return { duplicate: false, ...result };
    });
    return accept.immediate();
  }

  async processNextWebhookJob(): Promise<boolean> {
    const dirty = this.database.claimNextGithubDirtyRef();
    if (!dirty) return false;
    try {
      const linked = this.database.listGithubProjects(
        dirty.installation_id,
        dirty.repository_id,
        dirty.branch
      );
      if (linked.length === 0) {
        this.database.discardGithubDirtyRef(dirty);
        return true;
      }
      const repository = await this.repository(dirty.installation_id, dirty.repository_id);
      const token = await this.installationToken(dirty.installation_id, dirty.repository_id);
      const commit = this.parseUpstream(CommitSchema, await this.githubRequest<unknown>(
        `/repos/${this.repositoryPath(repository.fullName)}/commits/${encodeURIComponent(dirty.branch)}`,
        { token }
      ));
      this.database.applyResolvedGithubRef(dirty, {
        deliveryId: dirty.latest_delivery_id,
        installationId: dirty.installation_id,
        repositoryId: dirty.repository_id,
        repositoryFullName: repository.fullName,
        branch: dirty.branch,
        commitSha: commit.sha,
        commitMessage: commit.commit.message.slice(0, 4_096),
        commitAuthor: (commit.commit.author?.name ?? commit.commit.committer?.name ?? "GitHub").slice(0, 255),
        commitUrl: this.validatedGithubUrl(commit.html_url),
        receivedAt: new Date().toISOString()
      }, repository.cloneUrl);
      return true;
    } catch (error) {
      const safeError = error instanceof HttpError ? error.code : error instanceof Error ? error.name : "UNKNOWN";
      this.database.failGithubDirtyRef(dirty, safeError);
      return true;
    }
  }

  async processNextCommitStatus(deploymentId?: string): Promise<boolean> {
    const pending = this.database.listDueGithubStatuses(1, deploymentId)[0];
    if (!pending) return false;
    const deployment = this.database.getDeployment(pending.deployment_id);
    if (!deployment) {
      this.database.completeGithubStatus(pending.deployment_id, pending.desired_state);
      return true;
    }
    try {
      await this.reportCommitStatus(pending, deployment.project_id);
      this.database.completeGithubStatus(pending.deployment_id, pending.desired_state);
    } catch (error) {
      this.database.failGithubStatus(
        pending.deployment_id,
        pending.desired_state,
        error instanceof HttpError ? error.code : error instanceof Error ? error.name : "GITHUB_STATUS_FAILED"
      );
    }
    return true;
  }

  private acceptPush(deliveryId: string, rawPayload: unknown): {
    queued: number;
    pending: number;
    ignored: number;
  } {
    const payload = PushSchema.parse(rawPayload);
    if (payload.deleted || !payload.ref.startsWith("refs/heads/")) {
      return { queued: 0, pending: 0, ignored: 1 };
    }
    const branch = payload.ref.slice("refs/heads/".length);
    if (!branch || branch.length > 255) return { queued: 0, pending: 0, ignored: 1 };
    const installationId = String(payload.installation.id);
    const repositoryId = String(payload.repository.id);
    const linked = this.database.listGithubProjects(installationId, repositoryId, branch);
    if (linked.length === 0) return { queued: 0, pending: 0, ignored: 1 };
    this.database.enqueueGithubDirtyRef({
      installationId,
      repositoryId,
      repositoryFullName: payload.repository.full_name,
      branch,
      deliveryId
    });
    return { queued: 0, pending: linked.length, ignored: 0 };
  }

  private acceptPullRequest(deliveryId: string, rawPayload: unknown): {
    queued: number;
    pending: number;
    ignored: number;
  } {
    const payload = PullRequestEventSchema.parse(rawPayload);
    const installationId = String(payload.installation.id);
    const repositoryId = String(payload.repository.id);
    const pullRequest = payload.pull_request;

    // GitHub's outer repository and PR base repository must describe the exact
    // installation repository. Never trust head metadata for project lookup.
    if (
      String(pullRequest.base.repo.id) !== repositoryId ||
      pullRequest.base.repo.full_name.toLowerCase() !== payload.repository.full_name.toLowerCase()
    ) return { queued: 0, pending: 0, ignored: 1 };

    const projects = this.database.listGithubPreviewProjects(
      installationId,
      repositoryId,
      pullRequest.base.ref
    );
    if (projects.length === 0) return { queued: 0, pending: 0, ignored: 1 };

    if (payload.action === "closed") {
      let closed = 0;
      for (const project of projects) {
        const preview = this.database.findPullRequestPreview(project.id, pullRequest.number);
        if (preview && this.database.requestPullRequestPreviewClose(project.id, preview.id)) closed += 1;
      }
      return { queued: 0, pending: closed, ignored: closed === 0 ? 1 : 0 };
    }

    // A fork (including a deleted/null head repository) is untrusted. Shelter
    // deliberately has no opt-out for this guard because builds can execute a
    // repository-controlled Dockerfile.
    if (
      !pullRequest.head.repo ||
      String(pullRequest.head.repo.id) !== repositoryId ||
      pullRequest.head.repo.full_name.toLowerCase() !== payload.repository.full_name.toLowerCase()
    ) return { queued: 0, pending: 0, ignored: projects.length };

    let queued = 0;
    let pending = 0;
    let ignored = 0;
    for (const project of projects) {
      const suffix = project.preview_domain_suffix;
      if (!suffix) {
        ignored += 1;
        continue;
      }
      const hostname = pullRequestPreviewHostname(pullRequest.number, project.slug, suffix);
      const result = this.database.queuePullRequestPreview({
        projectId: project.id,
        pullRequestNumber: pullRequest.number,
        headSha: pullRequest.head.sha.toLowerCase(),
        headRef: pullRequest.head.ref,
        baseRef: pullRequest.base.ref,
        repositoryId,
        repositoryFullName: payload.repository.full_name,
        deliveryId,
        hostname,
        expiresAt: new Date(Date.now() + (project.preview_ttl_hours ?? 72) * 60 * 60_000).toISOString(),
        commitMessage: pullRequest.title.slice(0, 4096),
        commitAuthor: payload.sender.login.slice(0, 255),
        commitUrl: this.validatedGithubUrl(pullRequest.html_url)
      });
      if (result.kind === "queued") queued += 1;
      else if (result.kind === "coalesced") pending += 1;
      else ignored += 1;
    }
    return { queued, pending, ignored };
  }

  private handleInstallation(rawPayload: unknown): { queued: 0; pending: 0; ignored: number } {
    const payload = InstallationEventSchema.parse(rawPayload);
    if (payload.action === "deleted" || payload.action === "suspend") {
      const reason = payload.action === "deleted"
        ? "Die GitHub-App-Installation wurde gelöscht. Auto-Deploy ist pausiert."
        : "Die GitHub-App-Installation wurde pausiert. Auto-Deploy ist pausiert.";
      const installationId = String(payload.installation.id);
      const changed = this.database.disableGithubInstallation(installationId, reason);
      this.invalidateInstallationTokens(installationId);
      return { queued: 0, pending: 0, ignored: changed === 0 ? 1 : 0 };
    }
    if (payload.action === "unsuspend" || payload.action === "created") {
      const changed = this.database.enableGithubInstallation(String(payload.installation.id));
      return { queued: 0, pending: 0, ignored: changed === 0 ? 1 : 0 };
    }
    return { queued: 0, pending: 0, ignored: 1 };
  }

  private handleInstallationRepositories(rawPayload: unknown): { queued: 0; pending: 0; ignored: number } {
    const payload = InstallationRepositoriesEventSchema.parse(rawPayload);
    const installationId = String(payload.installation.id);
    if (payload.action === "removed") this.invalidateInstallationTokens(installationId);
    const changed = payload.action === "removed"
      ? this.database.disableGithubRepositories(
          installationId,
          payload.repositories_removed.map((repository) => String(repository.id)),
          "Der Repository-Zugriff wurde aus der GitHub-App-Installation entfernt. Auto-Deploy ist pausiert."
        )
      : payload.action === "added"
        ? this.database.enableGithubRepositories(
            installationId,
            payload.repositories_added.map((repository) => String(repository.id))
          )
        : 0;
    return { queued: 0, pending: 0, ignored: changed === 0 ? 1 : 0 };
  }

  private invalidateInstallationTokens(installationId: string): void {
    this.installationTokenGenerations.set(
      installationId,
      (this.installationTokenGenerations.get(installationId) ?? 0) + 1
    );
    const prefix = `${installationId}:`;
    for (const key of this.installationTokens.keys()) {
      if (key.startsWith(prefix)) this.installationTokens.delete(key);
    }
    for (const key of this.installationTokenRequests.keys()) {
      if (key.startsWith(prefix)) this.installationTokenRequests.delete(key);
    }
  }

  private invalidateAllInstallationTokens(): void {
    this.installationTokenEpoch += 1;
    this.installationTokens.clear();
    this.installationTokenRequests.clear();
    this.installationTokenGenerations.clear();
    this.analysisCache.clear();
    this.analysisRequests.clear();
  }

  private async fetchRepositoryAnalysis(
    resolved: { repository: GitHubRepository; branch: GitHubBranch }
  ): Promise<ProjectAnalysis> {
    const token = await this.installationToken(resolved.repository.installationId, resolved.repository.id);
    const repositoryPath = this.repositoryPath(resolved.repository.fullName);
    const tree = this.parseUpstream(GitTreeSchema, await this.githubRequest<unknown>(
      `/repos/${repositoryPath}/git/trees/${encodeURIComponent(resolved.branch.sha)}?recursive=1`,
      { token }
    ));
    const treeFacts: ProjectFileFact[] = [];
    let droppedUnsafePath = false;
    for (const item of tree.tree) {
      if (item.type !== "blob") continue;
      if (
        item.path.length > 240
        || item.path.includes("\\")
        || item.path.startsWith("/")
        || item.path.split("/").some((segment) => !segment || segment === "." || segment === "..")
      ) {
        droppedUnsafePath = true;
        continue;
      }
      treeFacts.push({ path: item.path, ...(item.size === undefined ? {} : { size: item.size }) });
    }
    const limited = relevantGitHubTreePaths(treeFacts, tree.truncated || droppedUnsafePath);
    const contentFiles = limited.files.filter((file) => requiresAnalysisContent(file.path));
    if (contentFiles.length > ANALYSIS_MAX_CONTENT_FILES) {
      throw badRequest(
        "GitHub repository contains too many project manifests to analyze safely",
        "GITHUB_ANALYSIS_TOO_LARGE"
      );
    }

    let totalContentBytes = 0;
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(ANALYSIS_CONTENT_CONCURRENCY, contentFiles.length) }, async () => {
      while (nextIndex < contentFiles.length) {
        const file = contentFiles[nextIndex++];
        if (!file) return;
        const encodedPath = file.path.split("/").map(encodeURIComponent).join("/");
        const response = this.parseUpstream(RepositoryContentSchema, await this.githubRequest<unknown>(
          `/repos/${repositoryPath}/contents/${encodedPath}?ref=${encodeURIComponent(resolved.branch.sha)}`,
          { token }
        ));
        const content = Buffer.from(response.content.replaceAll(/\s/g, ""), "base64");
        if (content.length !== response.size || totalContentBytes + content.length > MAX_ANALYSIS_CONTENT_BYTES) {
          throw badRequest(
            "GitHub project configuration is too large to analyze safely",
            "GITHUB_ANALYSIS_TOO_LARGE"
          );
        }
        totalContentBytes += content.length;
        file.content = content.toString("utf8");
      }
    });
    await Promise.all(workers);
    return analyzeProjectFiles(limited.files, { partial: limited.partial });
  }

  private cacheAnalysis(key: string, analysis: ProjectAnalysis): void {
    const now = Date.now();
    for (const [candidate, entry] of this.analysisCache) {
      if (entry.expiresAt <= now) this.analysisCache.delete(candidate);
    }
    while (this.analysisCache.size >= ANALYSIS_CACHE_MAX_ENTRIES) {
      const oldest = this.analysisCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.analysisCache.delete(oldest);
    }
    this.analysisCache.set(key, { expiresAt: now + ANALYSIS_CACHE_TTL_MS, analysis });
  }

  private async paginate<T>(endpoint: string, options: Omit<GithubFetchOptions, "method" | "body">): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const separator = endpoint.includes("?") ? "&" : "?";
      const pageRows = this.parseUpstream(z.array(z.unknown()), await this.githubRequest<unknown>(
        `${endpoint}${separator}per_page=${PAGE_SIZE}&page=${page}`,
        options
      )) as T[];
      rows.push(...pageRows);
      if (pageRows.length < PAGE_SIZE) break;
    }
    return rows;
  }

  private async githubRequest<T>(endpoint: string, options: GithubFetchOptions = {}): Promise<T> {
    if (!endpoint.startsWith("/")) throw new Error("GitHub endpoint must be relative");
    const authorization = options.appAuthentication
      ? `Bearer ${this.appJwt()}`
      : options.token
        ? `Bearer ${options.token}`
        : undefined;
    let response: Response;
    try {
      response = await this.fetcher(`${GITHUB_API}${endpoint}`, {
        method: options.method ?? "GET",
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": API_VERSION,
          "user-agent": "Shelter",
          ...(authorization ? { authorization } : {}),
          ...(options.body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        redirect: "error",
        signal: AbortSignal.timeout(20_000)
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw upstreamError("GitHub ist derzeit nicht erreichbar", "GITHUB_UNREACHABLE");
    }
    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw upstreamError(`GitHub antwortet mit HTTP ${response.status}`, "GITHUB_API");
      }
    }
    if (!response.ok) {
      const message = z.object({ message: z.string().max(1000) }).passthrough().safeParse(data);
      const detail = message.success ? message.data.message : `HTTP ${response.status}`;
      throw new HttpError(502, "GITHUB_API", `GitHub: ${detail}`);
    }
    return data as T;
  }

  private appJwt(): string {
    const metadata = this.requireMetadata();
    const privateKey = this.secret(PRIVATE_KEY_KEY, "github.private_key:v1");
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: metadata.appId })).toString("base64url");
    const unsigned = `${header}.${payload}`;
    const signature = cryptoSign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
    return `${unsigned}.${signature}`;
  }

  private parseUpstream<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw upstreamError("GitHub hat eine unerwartete API-Antwort geliefert", "GITHUB_API_INVALID");
    }
    return parsed.data;
  }

  private metadata(): AppMetadata | null {
    const encoded = this.database.getSetting(APP_METADATA_KEY);
    if (!encoded) return null;
    try {
      return AppMetadataSchema.parse(JSON.parse(encoded));
    } catch {
      return null;
    }
  }

  private requireMetadata(): AppMetadata {
    const metadata = this.metadata();
    if (!metadata || !this.hasStoredSecrets()) {
      throw conflict("GitHub App ist nicht verbunden", "GITHUB_NOT_CONFIGURED");
    }
    return metadata;
  }

  private hasStoredSecrets(): boolean {
    return Boolean(this.database.getSetting(PRIVATE_KEY_KEY) && this.database.getSetting(WEBHOOK_SECRET_KEY));
  }

  private panelOrigin(): string {
    const panelDomain = this.database.getSetting("cloudflare.panel_domain")?.trim().toLowerCase();
    if (!panelDomain || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(panelDomain)) {
      throw conflict(
        "Für die GitHub-App muss zuerst eine gültige Cloudflare-Panel-Domain eingerichtet sein",
        "GITHUB_PANEL_DOMAIN_REQUIRED"
      );
    }
    return `https://${panelDomain}`;
  }

  private encryptSecret(label: string, value: string): string {
    return encryptString(`${label}\0${value}`, this.config.APP_SECRET);
  }

  private decryptSecret(label: string, encrypted: string): string {
    const clear = decryptString(encrypted, this.config.APP_SECRET);
    const prefix = `${label}\0`;
    if (!clear.startsWith(prefix)) throw new Error("GitHub secret purpose mismatch");
    return clear.slice(prefix.length);
  }

  private secret(key: string, label: string): string {
    const encrypted = this.database.getSetting(key);
    if (!encrypted) throw conflict("GitHub App ist nicht verbunden", "GITHUB_NOT_CONFIGURED");
    try {
      return this.decryptSecret(label, encrypted);
    } catch {
      throw new HttpError(503, "GITHUB_CREDENTIALS_INVALID", "Die gespeicherten GitHub-Zugangsdaten sind beschädigt");
    }
  }

  private validatePrivateKey(pem: string): void {
    try {
      const key = createPrivateKey(pem);
      if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
        throw new Error("not a sufficiently strong RSA key");
      }
    } catch {
      throw upstreamError("GitHub hat keinen gültigen privaten App-Schlüssel geliefert", "GITHUB_MANIFEST_INVALID");
    }
  }

  private validatedAppUrl(value: string, slug: string): string {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password ||
        url.pathname !== `/apps/${slug}` || url.search || url.hash) {
      throw upstreamError("GitHub hat eine ungültige App-URL geliefert", "GITHUB_MANIFEST_INVALID");
    }
    return url.toString().replace(/\/$/, "");
  }

  private validatedGithubUrl(value: string): string {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) {
      throw upstreamError("GitHub hat eine ungültige URL geliefert", "GITHUB_API_INVALID");
    }
    return url.toString();
  }

  private presentRepository(installationId: string, repository: z.infer<typeof RepositorySchema>): GitHubRepository {
    const cloneUrl = new URL(repository.clone_url);
    if (
      cloneUrl.protocol !== "https:" || cloneUrl.hostname !== "github.com" || cloneUrl.port ||
      cloneUrl.username || cloneUrl.password || cloneUrl.search || cloneUrl.hash ||
      cloneUrl.pathname !== `/${repository.full_name}.git`
    ) {
      throw upstreamError("GitHub hat eine ungültige Clone-URL geliefert", "GITHUB_API_INVALID");
    }
    return {
      id: String(repository.id),
      installationId,
      name: repository.name,
      fullName: repository.full_name,
      private: repository.private,
      defaultBranch: repository.default_branch,
      htmlUrl: this.validatedGithubUrl(repository.html_url),
      cloneUrl: cloneUrl.toString(),
      owner: repository.owner.login,
      ownerLogin: repository.owner.login
    };
  }

  private presentBranch(branch: z.infer<typeof BranchSchema>): GitHubBranch {
    return {
      name: branch.name,
      protected: branch.protected,
      sha: branch.commit.sha,
      commitSha: branch.commit.sha
    };
  }

  private repositoryPath(fullName: string): string {
    const [owner, repository, extra] = fullName.split("/");
    if (!owner || !repository || extra) throw new HttpError(400, "GITHUB_REPOSITORY_INVALID", "GitHub-Repository ist ungültig");
    return `${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  }

  private installationId(value: string): string {
    if (!/^\d{1,20}$/.test(value)) throw new HttpError(400, "GITHUB_INSTALLATION_INVALID", "GitHub-Installation ist ungültig");
    return value;
  }

  private repositoryId(value: string): string {
    if (!/^\d{1,20}$/.test(value)) throw new HttpError(400, "GITHUB_REPOSITORY_INVALID", "GitHub-Repository ist ungültig");
    return value;
  }

  private repositoryIdNumber(value: string): number {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new HttpError(400, "GITHUB_REPOSITORY_INVALID", "GitHub-Repository ist ungültig");
    }
    return number;
  }

  private safeEqualHex(left: string, right: string): boolean {
    if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
    return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
  }
}
