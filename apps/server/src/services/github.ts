import {
  createHash,
  createHmac,
  createPrivateKey,
  sign as cryptoSign,
  timingSafeEqual
} from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type {
  Database,
  GithubBufferedWebhookRow,
  GithubStatusOutboxRow
} from "../lib/database.js";
import { badRequest, conflict, HttpError, upstreamError } from "../lib/errors.js";
import { decryptString, encryptString, hashToken, randomToken } from "../lib/security.js";
import type { GithubAppUpgradeFlowRow } from "../types/models.js";
import {
  analyzeProjectFiles,
  isEnvironmentSourceContentPath,
  isProjectConfigurationContentPath,
  MAX_ANALYSIS_CONTENT_BYTES,
  MAX_ANALYSIS_SOURCE_CONTENT_BYTES,
  MAX_ANALYSIS_SOURCE_FILE_BYTES,
  relevantGitHubTreePaths,
  requiresAnalysisContent,
  type ProjectAnalysis,
  type ProjectFileFact
} from "./project-analysis.js";
import { pullRequestPreviewHostname } from "./pull-request-previews.js";
import { reconcileRouting } from "./routing.js";

export const GITHUB_MANIFEST_CALLBACK_PATH = "/api/settings/github/manifest/callback";
export const GITHUB_SETUP_CALLBACK_PATH = "/api/settings/github/setup/callback";
export const GITHUB_MANIFEST_COOKIE = "shelter_github_manifest";
export const LEGACY_GITHUB_MANIFEST_COOKIE = "portsmith_github_manifest";
export const GITHUB_UPGRADE_SETUP_COOKIE = "shelter_github_upgrade_setup";

const GITHUB_API = "https://api.github.com";
const GITHUB_REGISTRATION_URL = "https://github.com/settings/apps/new";
const API_VERSION = "2026-03-10";
const MANIFEST_TTL_MS = 10 * 60_000;
const UPGRADE_SETUP_TTL_MS = 60 * 60_000;
const RETIRED_WEBHOOK_TTL_MS = 10 * 60_000;
const PENDING_WEBHOOK_MAX_COUNT = 100;
const PENDING_WEBHOOK_MAX_BYTES = 5 * 1024 * 1024;
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

const AppUpgradeCandidateSchema = z.object({
  version: z.literal(1),
  metadata: AppMetadataSchema,
  privateKey: z.string().min(100).max(64 * 1024),
  webhookSecret: z.string().min(16).max(1024)
}).strict();

type AppUpgradeCandidate = z.infer<typeof AppUpgradeCandidateSchema>;

interface RetiredWebhookSource {
  appId: string;
  webhookSecret: string;
  previousInstallationId: string | null;
  successorInstallationId: string;
  expiresAt: string;
}

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
  suspended_at: z.string().nullable().optional(),
  permissions: z.record(z.string(), z.string()).optional().default({}),
  events: z.array(z.string()).optional().default([]),
  html_url: z.url().nullable().optional()
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
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
  owner: z.object({
    login: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/),
    type: z.enum(["User", "Organization", "Enterprise"])
  }).passthrough(),
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
    updated_at: z.iso.datetime(),
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
  setup_on_update: true;
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
  htmlUrl: string | null;
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
  installationChecked: boolean;
  installationPullRequestsPermission: boolean | null;
  installationPullRequestEvent: boolean | null;
  installationSuspended: boolean | null;
  remediation: "none" | "configure_app" | "update_existing_app" | "approve_installation_update";
  remediationUrl: string | null;
  upgradePending: boolean;
  upgradeInstallUrl: string | null;
  upgradeExpiresAt: string | null;
}

export interface GitHubWebhookSource {
  kind: "active" | "pending" | "retired";
  appId: string;
  previousInstallationId?: string | null;
  successorInstallationId?: string;
}

interface GitHubWebhookResult {
  duplicate: boolean;
  queued: number;
  pending: number;
  ignored: number;
}

interface GithubFetchOptions {
  method?: "GET" | "POST";
  token?: string;
  appAuthentication?: boolean;
  appCredentials?: Pick<AppUpgradeCandidate, "metadata" | "privateKey">;
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

  async previewCapability(installationId?: string): Promise<GitHubPreviewCapability> {
    const upgrade = this.pendingUpgrade();
    if (!this.state().configured) {
      return {
        ready: false,
        configured: false,
        pullRequestsPermission: false,
        pullRequestEvent: false,
        installationChecked: Boolean(installationId),
        installationPullRequestsPermission: installationId ? false : null,
        installationPullRequestEvent: installationId ? false : null,
        installationSuspended: null,
        remediation: "configure_app",
        remediationUrl: null,
        ...upgrade
      };
    }
    const app = this.parseUpstream(
      AppCapabilitySchema,
      await this.githubRequest<unknown>("/app", { appAuthentication: true })
    );
    const pullRequestsPermission = app.permissions.pull_requests === "read" || app.permissions.pull_requests === "write";
    const pullRequestEvent = app.events.includes("pull_request");
    const appRemediationUrl = this.appPermissionsUrl(app);
    if (installationId) {
      const installation = this.parseUpstream(InstallationSchema, await this.githubRequest<unknown>(
        `/app/installations/${this.installationId(installationId)}`,
        { appAuthentication: true }
      ));
      const installationPullRequestsPermission = installation.permissions.pull_requests === "read"
        || installation.permissions.pull_requests === "write";
      const installationPullRequestEvent = installation.events.includes("pull_request");
      const installationSuspended = Boolean(installation.suspended_at);
      const appReady = pullRequestsPermission && pullRequestEvent;
      const installationReady = installationPullRequestsPermission
        && installationPullRequestEvent
        && !installationSuspended;
      return {
        ready: appReady && installationReady,
        configured: true,
        pullRequestsPermission,
        pullRequestEvent,
        installationChecked: true,
        installationPullRequestsPermission,
        installationPullRequestEvent,
        installationSuspended,
        remediation: !appReady ? "update_existing_app" : installationReady ? "none" : "approve_installation_update",
        remediationUrl: !appReady
          ? appRemediationUrl
          : installationReady
            ? null
            : this.installationSettingsUrl(installation),
        ...upgrade
      };
    }
    return {
      ready: pullRequestsPermission && pullRequestEvent,
      configured: true,
      pullRequestsPermission,
      pullRequestEvent,
      installationChecked: false,
      installationPullRequestsPermission: null,
      installationPullRequestEvent: null,
      installationSuspended: null,
      remediation: pullRequestsPermission && pullRequestEvent ? "none" : "update_existing_app",
      remediationUrl: pullRequestsPermission && pullRequestEvent ? null : appRemediationUrl,
      ...upgrade
    };
  }

  startManifest(userId: string, sessionTokenHash: string): {
    registrationUrl: string;
    manifest: GitHubManifest;
    browserNonce: string;
    secureCookie: true;
  } {
    if (this.hasStoredAppState() || this.database.listGithubProjectBindings().length > 0) {
      throw conflict(
        "Die GitHub App ist bereits verbunden. Verwende den sicheren Upgrade-Flow.",
        "GITHUB_ALREADY_CONFIGURED"
      );
    }
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
    const manifest = this.manifest(
      origin,
      callbackUrl,
      setupState,
      `Shelter ${panelName}`.slice(0, 34)
    );
    return {
      registrationUrl: `${GITHUB_REGISTRATION_URL}?state=${encodeURIComponent(state)}`,
      manifest,
      browserNonce,
      secureCookie: true
    };
  }

  async startUpgradeManifest(userId: string, sessionTokenHash: string): Promise<{
    registrationUrl: string;
    manifest: GitHubManifest;
    browserNonce: string;
    secureCookie: true;
  }> {
    this.cleanupExpiredUpgradeBuffers();
    const metadata = this.requireMetadata();
    if (this.database.hasBufferedGithubWebhooks(metadata.appId)) {
      throw conflict(
        "Vor einem weiteren GitHub-App-Upgrade müssen gepufferte Webhooks verarbeitet werden",
        "GITHUB_UPGRADE_WEBHOOKS_PENDING"
      );
    }
    const app = this.parseUpstream(
      AppCapabilitySchema,
      await this.githubRequest<unknown>("/app", { appAuthentication: true })
    );
    if (app.slug !== metadata.appSlug) {
      throw upstreamError("GitHub hat eine unerwartete App-Identität geliefert", "GITHUB_API_INVALID");
    }
    if (app.owner.type === "Enterprise") {
      throw conflict(
        "Enterprise-eigene GitHub Apps können nicht über ein Manifest ersetzt werden",
        "GITHUB_UPGRADE_ENTERPRISE_UNSUPPORTED"
      );
    }

    const origin = this.panelOrigin();
    const state = randomToken();
    const browserNonce = randomToken();
    const setupState = randomToken();
    const callbackUrl = `${origin}${GITHUB_MANIFEST_CALLBACK_PATH}`;
    const now = new Date();
    const suffix = ` upgrade-${createHash("sha256").update(randomToken()).digest("hex").slice(0, 6)}`;
    const panelName = new URL(origin).hostname.replaceAll(".", "-");
    const baseName = `Shelter ${panelName}`.slice(0, Math.max(1, 34 - suffix.length));
    const manifest = this.manifest(origin, callbackUrl, setupState, `${baseName}${suffix}`);

    this.database.createGithubAppUpgradeFlow({
      id: randomToken(),
      manifest_state_hash: hashToken(state),
      manifest_browser_nonce_hash: hashToken(browserNonce),
      setup_state_hash: hashToken(setupState),
      setup_browser_nonce_hash: null,
      user_id: userId,
      session_token_hash: sessionTokenHash,
      previous_app_id: metadata.appId,
      expected_owner_login: app.owner.login,
      expected_owner_type: app.owner.type,
      candidate_app_id: null,
      encrypted_candidate: null,
      phase: "registering",
      expires_at: new Date(now.getTime() + MANIFEST_TTL_MS).toISOString(),
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    });

    const registrationBase = app.owner.type === "Organization"
      ? `https://github.com/organizations/${encodeURIComponent(app.owner.login)}/settings/apps/new`
      : GITHUB_REGISTRATION_URL;
    return {
      registrationUrl: `${registrationBase}?state=${encodeURIComponent(state)}`,
      manifest,
      browserNonce,
      secureCookie: true
    };
  }

  cancelManifest(state: string, browserNonce: string): void {
    const stateHash = hashToken(state);
    const browserNonceHash = hashToken(browserNonce);
    this.database.consumeGithubManifestFlow(stateHash, browserNonceHash);
    this.database.cancelGithubAppUpgradeManifestFlow(stateHash, browserNonceHash);
  }

  async completeManifest(state: string, browserNonce: string, code: string): Promise<{
    installUrl: string;
    setupBrowserNonce?: string;
  }> {
    const stateHash = hashToken(state);
    const browserNonceHash = hashToken(browserNonce);
    const flow = this.database.consumeGithubManifestFlow(stateHash, browserNonceHash);
    if (!flow) {
      return this.completeUpgradeManifest(stateHash, browserNonceHash, code);
    }
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
      if (this.hasStoredAppState() || this.database.listGithubProjectBindings().length > 0) {
        throw conflict(
          "Während der GitHub-App-Anmeldung wurde bereits eine App verbunden",
          "GITHUB_ALREADY_CONFIGURED"
        );
      }
      this.database.setSetting(APP_METADATA_KEY, JSON.stringify(metadata));
      this.database.setSetting(PRIVATE_KEY_KEY, this.encryptSecret("github.private_key:v1", conversion.pem));
      this.database.setSetting(WEBHOOK_SECRET_KEY, this.encryptSecret("github.webhook_secret:v1", conversion.webhook_secret));
      this.database.setSetting(SETUP_STATE_HASH_KEY, hashToken(setupState));
      this.database.deleteGithubManifestFlows();
    })();
    reconcileRouting(this.config, this.database);
    this.invalidateAllInstallationTokens();
    return { installUrl: `${appUrl}/installations/new` };
  }

  async completeSetup(
    state: string,
    installationId: string,
    upgradeBrowserNonce?: string
  ): Promise<"installed" | "upgraded"> {
    if (upgradeBrowserNonce) {
      const upgrade = this.database.getGithubAppUpgradeSetupFlow(
        hashToken(state),
        hashToken(upgradeBrowserNonce)
      );
      if (upgrade) {
        await this.completeUpgradeSetup(upgrade, installationId);
        return "upgraded";
      }
    }
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
    this.invalidateInstallationTokens(String(installation.id));
    return "installed";
  }

  private async completeUpgradeManifest(
    stateHash: string,
    browserNonceHash: string,
    code: string
  ): Promise<{ installUrl: string; setupBrowserNonce: string }> {
    const flow = this.database.claimGithubAppUpgradeManifestFlow(stateHash, browserNonceHash);
    if (!flow) {
      throw conflict("Die GitHub-App-Anmeldung ist abgelaufen oder ungültig", "GITHUB_MANIFEST_STATE_INVALID");
    }
    let candidatePersisted = false;
    try {
      const current = this.requireMetadata();
      if (current.appId !== flow.previous_app_id) {
        throw conflict(
          "Die aktive GitHub App hat sich während des Upgrades geändert",
          "GITHUB_UPGRADE_STALE"
        );
      }
      const raw = await this.githubRequest<unknown>(`/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: "POST"
      });
      const conversion = this.parseUpstream(ManifestConversionSchema, raw);
      const appUrl = this.validatedAppUrl(conversion.html_url, conversion.slug);
      this.validatePrivateKey(conversion.pem);
      const candidate: AppUpgradeCandidate = {
        version: 1,
        metadata: {
          version: 1,
          appId: String(conversion.id),
          appName: conversion.name,
          appSlug: conversion.slug,
          appUrl,
          createdAt: new Date().toISOString()
        },
        privateKey: conversion.pem,
        webhookSecret: conversion.webhook_secret
      };
      const setupBrowserNonce = randomToken();
      const encryptedCandidate = this.encryptSecret(
        "github.upgrade_candidate:v1",
        JSON.stringify(candidate)
      );
      const completed = this.database.completeGithubAppUpgradeManifestFlow(
        flow.id,
        candidate.metadata.appId,
        encryptedCandidate,
        hashToken(setupBrowserNonce),
        new Date(Date.now() + UPGRADE_SETUP_TTL_MS).toISOString()
      );
      if (!completed) {
        throw conflict(
          "Der GitHub-App-Upgradezustand hat sich unerwartet geändert",
          "GITHUB_UPGRADE_STALE"
        );
      }
      candidatePersisted = true;
      return {
        installUrl: `${candidate.metadata.appUrl}/installations/new`,
        setupBrowserNonce
      };
    } catch (error) {
      // A manifest conversion code can only be exchanged once. Once GitHub has
      // returned the candidate credentials and they have been encrypted, never
      // discard them because a later GitHub API request failed. All remote
      // identity/capability checks deliberately happen in completeUpgradeSetup.
      if (!candidatePersisted) this.database.deleteGithubAppUpgradeFlow(flow.id);
      throw error;
    }
  }

  private async completeUpgradeSetup(flow: GithubAppUpgradeFlowRow, installationId: string): Promise<void> {
    const current = this.requireMetadata();
    if (current.appId !== flow.previous_app_id) {
      throw conflict(
        "Die aktive GitHub App hat sich während des Upgrades geändert",
        "GITHUB_UPGRADE_STALE"
      );
    }
    const candidate = this.upgradeCandidate(flow);
    const candidateApp = this.parseUpstream(
      AppCapabilitySchema,
      await this.githubRequest<unknown>("/app", { appCredentials: candidate })
    );
    if (
      candidateApp.slug !== candidate.metadata.appSlug
      || candidateApp.owner.login !== flow.expected_owner_login
      || candidateApp.owner.type !== flow.expected_owner_type
    ) {
      throw conflict(
        "Die neue GitHub App gehört nicht zum erwarteten Account",
        "GITHUB_UPGRADE_OWNER_MISMATCH"
      );
    }
    this.requirePreviewCapabilities(candidateApp.permissions, candidateApp.events, "GITHUB_UPGRADE_APP_CAPABILITIES");

    const normalizedInstallationId = this.installationId(installationId);
    const candidateInstallation = this.parseUpstream(InstallationSchema, await this.githubRequest<unknown>(
      `/app/installations/${normalizedInstallationId}`,
      { appCredentials: candidate }
    ));
    if (String(candidateInstallation.app_id) !== candidate.metadata.appId) {
      throw conflict(
        "Die Installation gehört nicht zur neuen GitHub App",
        "GITHUB_INSTALLATION_MISMATCH"
      );
    }
    if (candidateInstallation.suspended_at) {
      throw conflict(
        "Die neue GitHub-Installation ist pausiert",
        "GITHUB_UPGRADE_INSTALLATION_SUSPENDED"
      );
    }
    this.requirePreviewCapabilities(
      candidateInstallation.permissions,
      candidateInstallation.events,
      "GITHUB_UPGRADE_INSTALLATION_CAPABILITIES"
    );

    const bindings = this.database.listGithubProjectBindings();
    const referencedInstallationIds = [...new Set(bindings.map((binding) => binding.installation_id))];
    if (referencedInstallationIds.length > 1) {
      throw conflict(
        "Mehrere GitHub-Installationen können nicht automatisch ersetzt werden",
        "GITHUB_UPGRADE_MULTIPLE_INSTALLATIONS"
      );
    }
    const activeInstallations = await this.installations();
    if (activeInstallations.length > 1) {
      throw conflict(
        "Mehrere GitHub-Installationen können nicht automatisch ersetzt werden",
        "GITHUB_UPGRADE_MULTIPLE_INSTALLATIONS"
      );
    }
    const previousInstallation = activeInstallations[0] ?? null;
    if (
      previousInstallation
      && (
        candidateInstallation.account.login !== previousInstallation.accountLogin
        || candidateInstallation.account.type !== previousInstallation.accountType
      )
    ) {
      throw conflict(
        "Die neue GitHub-Installation gehört nicht zum bisherigen Installations-Account",
        "GITHUB_UPGRADE_OWNER_MISMATCH"
      );
    }
    if (
      referencedInstallationIds.length === 1
      && previousInstallation?.id !== referencedInstallationIds[0]
    ) {
      throw conflict(
        "Die verknüpften Projekte gehören nicht zur bisherigen GitHub-Installation",
        "GITHUB_UPGRADE_INSTALLATION_MISMATCH"
      );
    }

    const tokenResponse = this.parseUpstream(InstallationTokenSchema, await this.githubRequest<unknown>(
      `/app/installations/${normalizedInstallationId}/access_tokens`,
      { method: "POST", appCredentials: candidate }
    ));
    const candidateRepositories: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = this.parseUpstream(
        z.object({ repositories: z.array(z.unknown()) }).passthrough(),
        await this.githubRequest<unknown>(
          `/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`,
          { token: tokenResponse.token }
        )
      );
      candidateRepositories.push(...response.repositories);
      if (response.repositories.length < PAGE_SIZE) break;
    }
    const accessibleRepositoryIds = new Set(candidateRepositories.map((repository) => (
      String(this.parseUpstream(RepositorySchema, repository).id)
    )));
    const requiredRepositoryIds = previousInstallation
      ? this.database.listGithubRepositoryIdsForInstallation(previousInstallation.id)
      : [...new Set(bindings.map((binding) => binding.repository_id))];
    const missingRepositoryIds = requiredRepositoryIds
      .filter((repositoryId) => !accessibleRepositoryIds.has(repositoryId));
    if (missingRepositoryIds.length > 0) {
      throw conflict(
        "Die neue GitHub-Installation hat noch nicht auf alle verknüpften Repositories Zugriff",
        "GITHUB_UPGRADE_REPOSITORIES_MISSING"
      );
    }

    const retiredAt = new Date();
    const encryptedRetiredWebhookSecret = this.encryptSecret(
      "github.retired_webhook_secret:v1",
      this.secret(WEBHOOK_SECRET_KEY, "github.webhook_secret:v1")
    );
    this.database.sqlite.transaction(() => {
      const latest = this.metadata();
      if (!latest || latest.appId !== flow.previous_app_id) {
        throw conflict(
          "Die aktive GitHub App hat sich während des Upgrades geändert",
          "GITHUB_UPGRADE_STALE"
        );
      }
      this.database.remapGithubInstallation(
        previousInstallation?.id ?? null,
        normalizedInstallationId,
        bindings
      );
      this.database.setSetting(APP_METADATA_KEY, JSON.stringify(candidate.metadata));
      this.database.setSetting(
        PRIVATE_KEY_KEY,
        this.encryptSecret("github.private_key:v1", candidate.privateKey)
      );
      this.database.setSetting(
        WEBHOOK_SECRET_KEY,
        this.encryptSecret("github.webhook_secret:v1", candidate.webhookSecret)
      );
      if (previousInstallation) {
        this.database.retargetGithubRetiredWebhookSources(
          previousInstallation.id,
          normalizedInstallationId
        );
      }
      this.database.saveGithubRetiredWebhookSource({
        app_id: current.appId,
        encrypted_webhook_secret: encryptedRetiredWebhookSecret,
        previous_installation_id: previousInstallation?.id ?? null,
        successor_installation_id: normalizedInstallationId,
        expires_at: new Date(retiredAt.getTime() + RETIRED_WEBHOOK_TTL_MS).toISOString(),
        created_at: retiredAt.toISOString(),
        updated_at: retiredAt.toISOString()
      });
      this.database.setSetting(SETUP_STATE_HASH_KEY, flow.setup_state_hash);
      this.database.deleteGithubAppUpgradeFlow(flow.id);
    })();
    this.invalidateAllInstallationTokens();
  }

  async disconnect(): Promise<GitHubState> {
    this.database.sqlite.transaction(() => {
      for (const key of [
        APP_METADATA_KEY,
        PRIVATE_KEY_KEY,
        WEBHOOK_SECRET_KEY,
        SETUP_STATE_HASH_KEY
      ]) {
        this.database.deleteSetting(key);
      }
      this.database.deleteGithubManifestFlows();
      this.database.deleteGithubAppUpgradeFlows();
      this.database.deleteGithubRetiredWebhookSources();
      this.database.deleteGithubWebhookDeliveries();
      this.database.disconnectGithubProjects();
    })();
    reconcileRouting(this.config, this.database);
    this.invalidateAllInstallationTokens();
    return this.state();
  }

  resultUrl(result: "connected" | "installed" | "upgraded" | "upgrade_incomplete" | "error"): string {
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
        suspendedAt: parsed.suspended_at ?? null,
        htmlUrl: this.installationSettingsUrl(parsed)
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

  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): GitHubWebhookSource {
    this.cleanupExpiredUpgradeBuffers();
    if (!signatureHeader || !/^sha256=[a-f0-9]{64}$/i.test(signatureHeader)) {
      throw new HttpError(401, "GITHUB_SIGNATURE_INVALID", "Ungültige GitHub-Webhook-Signatur");
    }
    const supplied = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
    const active = this.requireMetadata();
    const candidates: Array<{ source: GitHubWebhookSource; secret: string }> = [{
      source: { kind: "active", appId: active.appId },
      secret: this.secret(WEBHOOK_SECRET_KEY, "github.webhook_secret:v1")
    }];
    const pending = this.database.getPendingGithubAppUpgradeFlow();
    if (pending) {
      try {
        const candidate = this.upgradeCandidate(pending);
        candidates.push({
          source: { kind: "pending", appId: candidate.metadata.appId },
          secret: candidate.webhookSecret
        });
      } catch {
        // A damaged pending upgrade must not prevent the active app's webhook
        // from being authenticated.
      }
    }
    for (const retired of this.retiredWebhookSources()) {
      candidates.push({
        source: {
          kind: "retired",
          appId: retired.appId,
          previousInstallationId: retired.previousInstallationId,
          successorInstallationId: retired.successorInstallationId
        },
        secret: retired.webhookSecret
      });
    }

    for (const candidate of candidates) {
      const expected = createHmac("sha256", candidate.secret).update(rawBody).digest();
      if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
        return candidate.source;
      }
    }
    throw new HttpError(401, "GITHUB_SIGNATURE_INVALID", "Ungültige GitHub-Webhook-Signatur");
  }

  async handleWebhook(
    eventName: string,
    deliveryId: string,
    rawBody: Buffer,
    source?: GitHubWebhookSource
  ): Promise<GitHubWebhookResult> {
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
    let handledSourceKind: GitHubWebhookSource["kind"] | null = null;
    const accept = this.database.sqlite.transaction(() => {
      const currentSource = this.currentWebhookSource(source);
      if (!currentSource) {
        return { duplicate: false, queued: 0, pending: 0, ignored: 1 };
      }
      handledSourceKind = currentSource.kind;
      if (
        currentSource.kind === "pending"
        && (eventName === "push" || eventName === "pull_request")
      ) {
        this.validateBufferedWebhook(eventName, payload);
        const buffered = this.database.bufferGithubWebhookDelivery(
          currentSource.appId,
          deliveryId,
          eventName,
          payloadHash,
          rawBody,
          {
            maxCount: PENDING_WEBHOOK_MAX_COUNT,
            maxBytes: PENDING_WEBHOOK_MAX_BYTES
          }
        );
        if (buffered === "duplicate") {
          return { duplicate: true, queued: 0, pending: 0, ignored: 0 };
        }
        if (buffered === "mismatch") {
          throw conflict(
            "GitHub-Delivery-ID wurde mit abweichendem Inhalt wiederverwendet",
            "GITHUB_DELIVERY_MISMATCH"
          );
        }
        if (buffered === "full") {
          throw new HttpError(
            503,
            "GITHUB_WEBHOOK_BUFFER_FULL",
            "Der GitHub-Webhook-Puffer ist ausgelastet; GitHub soll die Delivery erneut senden"
          );
        }
        return { duplicate: false, queued: 0, pending: 1, ignored: 0 };
      }
      const claimed = this.database.claimGithubWebhookDelivery(
        currentSource.appId,
        deliveryId,
        eventName,
        payloadHash
      );
      if (claimed === "duplicate") return { duplicate: true, queued: 0, pending: 0, ignored: 0 };
      if (claimed === "mismatch") {
        throw conflict("GitHub-Delivery-ID wurde mit abweichendem Inhalt wiederverwendet", "GITHUB_DELIVERY_MISMATCH");
      }
      const result = this.acceptWebhookPayload(eventName, deliveryId, payload, currentSource);
      const status = result.pending > 0 || result.queued > 0 ? "processed" : "ignored";
      this.database.finishGithubWebhookDelivery(currentSource.appId, deliveryId, status);
      return { duplicate: false, ...result };
    });
    const result = accept.immediate();
    // A close or GitHub-App/repository revocation must unpublish the route even
    // when the worker is offline. Reconcile duplicates as well: if the atomic
    // file replacement failed, GitHub's retry gets another safe attempt.
    if (
      (eventName === "pull_request" && handledSourceKind !== "pending")
      || (
        handledSourceKind === "active"
        && ["installation", "installation_repositories"].includes(eventName)
      )
    ) {
      reconcileRouting(this.config, this.database);
    }
    return result;
  }

  async processNextWebhookJob(): Promise<boolean> {
    const buffered = this.processNextBufferedWebhook();
    if (buffered) {
      if (buffered.eventName === "pull_request") {
        reconcileRouting(this.config, this.database);
      }
      return true;
    }
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

  private processNextBufferedWebhook(): { eventName: "push" | "pull_request" } | null {
    const active = this.metadata();
    if (!active) return null;
    let attempted: GithubBufferedWebhookRow | undefined;
    try {
      const process = this.database.sqlite.transaction(() => {
        const buffered = this.database.claimNextBufferedGithubWebhook(active.appId);
        if (!buffered) return null;
        attempted = buffered;
        const currentSource = this.currentWebhookSource({
          kind: "active",
          appId: buffered.source_app_id
        });
        if (!currentSource || currentSource.kind !== "active") {
          throw conflict(
            "Die gepufferte GitHub-Delivery gehört nicht mehr zur aktiven App",
            "GITHUB_WEBHOOK_SOURCE_STALE"
          );
        }
        let payload: unknown;
        try {
          payload = JSON.parse(buffered.raw_body.toString("utf8"));
        } catch {
          throw new HttpError(400, "GITHUB_PAYLOAD_INVALID", "GitHub-Webhook enthält kein gültiges JSON");
        }
        const result = this.acceptWebhookPayload(
          buffered.event_name,
          buffered.delivery_id,
          payload,
          currentSource
        );
        const status = result.pending > 0 || result.queued > 0 ? "processed" : "ignored";
        this.database.finishGithubWebhookDelivery(
          buffered.source_app_id,
          buffered.delivery_id,
          status
        );
        return { eventName: buffered.event_name };
      });
      return process.immediate();
    } catch (error) {
      if (!attempted) throw error;
      const code = error instanceof HttpError
        ? error.code
        : error instanceof Error
          ? error.name
          : "GITHUB_BUFFER_PROCESSING_FAILED";
      // Claim, materialization and acknowledgement share one immediate
      // transaction. A crash or exception rolls the claim back to "buffered".
      // Repeated deterministic failures are quarantined after a bounded retry
      // count so one damaged row cannot stop the worker forever.
      const terminal = this.database.bufferedGithubWebhookAttempts(
        attempted.source_app_id,
        attempted.delivery_id
      ) >= 2;
      this.database.failGithubWebhookDelivery(
        attempted.source_app_id,
        attempted.delivery_id,
        code,
        terminal
      );
      return { eventName: attempted.event_name };
    }
  }

  private validateBufferedWebhook(eventName: "push" | "pull_request", payload: unknown): void {
    if (eventName === "push") PushSchema.parse(payload);
    else PullRequestEventSchema.parse(payload);
  }

  private acceptWebhookPayload(
    eventName: string,
    deliveryId: string,
    payload: unknown,
    source: GitHubWebhookSource
  ): Omit<GitHubWebhookResult, "duplicate"> {
    if (eventName === "push") return this.acceptPush(deliveryId, payload, source);
    if (eventName === "pull_request") {
      return this.acceptPullRequest(deliveryId, payload, source);
    }
    if (source.kind !== "active") return { queued: 0, pending: 0, ignored: 1 };
    if (eventName === "installation") return this.handleInstallation(payload);
    if (eventName === "installation_repositories") return this.handleInstallationRepositories(payload);
    return { queued: 0, pending: 0, ignored: 1 };
  }

  private acceptPush(
    deliveryId: string,
    rawPayload: unknown,
    source: GitHubWebhookSource
  ): {
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
    const repositoryId = String(payload.repository.id);
    const installationId = this.webhookInstallationId(
      source,
      String(payload.installation.id),
      repositoryId
    );
    if (!installationId) return { queued: 0, pending: 0, ignored: 1 };
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

  private acceptPullRequest(
    deliveryId: string,
    rawPayload: unknown,
    source: GitHubWebhookSource
  ): {
    queued: number;
    pending: number;
    ignored: number;
  } {
    const payload = PullRequestEventSchema.parse(rawPayload);
    const repositoryId = String(payload.repository.id);
    const installationId = this.webhookInstallationId(
      source,
      String(payload.installation.id),
      repositoryId
    );
    if (!installationId) return { queued: 0, pending: 0, ignored: 1 };
    const pullRequest = payload.pull_request;

    // GitHub's outer repository and PR base repository must describe the exact
    // installation repository. Never trust head metadata for project lookup.
    if (
      String(pullRequest.base.repo.id) !== repositoryId ||
      pullRequest.base.repo.full_name.toLowerCase() !== payload.repository.full_name.toLowerCase()
    ) return { queued: 0, pending: 0, ignored: 1 };

    const projects = this.database.listGithubPullRequestProjects(
      installationId,
      repositoryId
    );
    if (projects.length === 0) return { queued: 0, pending: 0, ignored: 1 };

    if (payload.action === "closed") {
      let closed = 0;
      let ignored = 0;
      for (const project of projects) {
        const claimed = this.database.claimGithubPullRequestEventWatermark({
          projectId: project.id,
          repositoryId,
          pullRequestNumber: pullRequest.number,
          githubUpdatedAt: pullRequest.updated_at,
          action: payload.action,
          deliveryId
        });
        if (claimed === "ignored") {
          ignored += 1;
          continue;
        }
        const preview = this.database.findPullRequestPreview(project.id, pullRequest.number);
        if (preview && this.database.requestPullRequestPreviewClose(project.id, preview.id)) closed += 1;
        else ignored += 1;
      }
      return { queued: 0, pending: closed, ignored };
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
      const claimed = this.database.claimGithubPullRequestEventWatermark({
        projectId: project.id,
        repositoryId,
        pullRequestNumber: pullRequest.number,
        githubUpdatedAt: pullRequest.updated_at,
        action: payload.action,
        deliveryId
      });
      if (claimed === "ignored") {
        ignored += 1;
        continue;
      }
      if (
        project.repository_branch !== pullRequest.base.ref
        || project.preview_deployments_enabled !== 1
        || !project.preview_domain_suffix
        || project.github_connection_error
      ) {
        ignored += 1;
        continue;
      }
      const suffix = project.preview_domain_suffix;
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
    if (payload.action === "new_permissions_accepted") {
      this.invalidateInstallationTokens(String(payload.installation.id));
      return { queued: 0, pending: 0, ignored: 0 };
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
    const configurationFiles = limited.files.filter((file) => (
      requiresAnalysisContent(file.path) && isProjectConfigurationContentPath(file.path)
    ));
    if (configurationFiles.length > ANALYSIS_MAX_CONTENT_FILES) {
      throw badRequest(
        "GitHub repository contains too many project manifests to analyze safely",
        "GITHUB_ANALYSIS_TOO_LARGE"
      );
    }
    const sourceCandidates = limited.files
      .filter((file) => requiresAnalysisContent(file.path) && !isProjectConfigurationContentPath(file.path))
      .sort((left, right) => left.path.localeCompare(right.path));
    const sourceFiles = sourceCandidates
      .filter((file) => file.size === undefined || file.size <= MAX_ANALYSIS_SOURCE_FILE_BYTES)
      .slice(0, ANALYSIS_MAX_CONTENT_FILES - configurationFiles.length);
    const contentFiles = [...configurationFiles, ...sourceFiles];
    let analysisPartial = limited.partial
      || sourceFiles.length < sourceCandidates.length;

    let totalContentBytes = 0;
    let sourceContentBytes = 0;
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
        const sourceFile = isEnvironmentSourceContentPath(file.path)
          && !isProjectConfigurationContentPath(file.path);
        if (content.length !== response.size || totalContentBytes + content.length > MAX_ANALYSIS_CONTENT_BYTES) {
          throw badRequest(
            "GitHub project configuration is too large to analyze safely",
            "GITHUB_ANALYSIS_TOO_LARGE"
          );
        }
        if (sourceFile && (
          content.length > MAX_ANALYSIS_SOURCE_FILE_BYTES
          || sourceContentBytes + content.length > MAX_ANALYSIS_SOURCE_CONTENT_BYTES
        )) {
          analysisPartial = true;
          continue;
        }
        totalContentBytes += content.length;
        if (sourceFile) sourceContentBytes += content.length;
        file.content = content.toString("utf8");
      }
    });
    await Promise.all(workers);
    return analyzeProjectFiles(limited.files, { partial: analysisPartial });
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
    const authorization = options.appCredentials
      ? `Bearer ${this.appJwt(options.appCredentials)}`
      : options.appAuthentication
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

  private appJwt(credentials?: Pick<AppUpgradeCandidate, "metadata" | "privateKey">): string {
    const metadata = credentials?.metadata ?? this.requireMetadata();
    const privateKey = credentials?.privateKey ?? this.secret(PRIVATE_KEY_KEY, "github.private_key:v1");
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

  private manifest(
    origin: string,
    callbackUrl: string,
    setupState: string,
    name: string
  ): GitHubManifest {
    return {
      name,
      url: origin,
      hook_attributes: { url: `${origin}/api/webhooks/github`, active: true },
      redirect_url: callbackUrl,
      setup_url: `${origin}${GITHUB_SETUP_CALLBACK_PATH}?state=${encodeURIComponent(setupState)}`,
      public: false,
      request_oauth_on_install: false,
      setup_on_update: true,
      default_permissions: { contents: "read", statuses: "write", metadata: "read", pull_requests: "read" },
      // GitHub Apps always receive installation and installation_repositories.
      // GitHub rejects manifests that try to subscribe to those implicit events.
      default_events: ["push", "pull_request"]
    };
  }

  private requirePreviewCapabilities(
    permissions: Record<string, string>,
    events: string[],
    code: string
  ): void {
    const requiredPermissions = {
      contents: "read",
      metadata: "read",
      pull_requests: "read",
      statuses: "write"
    } as const;
    const activePermissions = Object.entries(permissions)
      .filter(([, permission]) => permission !== "none");
    const exactPermissions = activePermissions.length === Object.keys(requiredPermissions).length
      && Object.entries(requiredPermissions).every(
        ([name, permission]) => permissions[name] === permission
      );
    const eventSet = new Set(events);
    const exactEvents = events.length === 2
      && eventSet.size === 2
      && eventSet.has("push")
      && eventSet.has("pull_request");
    if (
      !exactPermissions
      || !exactEvents
    ) {
      throw conflict(
        "Die neue GitHub App muss exakt die von Shelter angeforderten Berechtigungen und Events enthalten",
        code
      );
    }
  }

  private upgradeCandidate(flow: GithubAppUpgradeFlowRow): AppUpgradeCandidate {
    if (!flow.encrypted_candidate) {
      throw conflict(
        "Die neue GitHub App wurde noch nicht vollständig registriert",
        "GITHUB_UPGRADE_CANDIDATE_MISSING"
      );
    }
    try {
      const candidate = AppUpgradeCandidateSchema.parse(JSON.parse(
        this.decryptSecret("github.upgrade_candidate:v1", flow.encrypted_candidate)
      ));
      this.validatePrivateKey(candidate.privateKey);
      return candidate;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        503,
        "GITHUB_UPGRADE_CANDIDATE_INVALID",
        "Die zwischengespeicherte GitHub App ist beschädigt"
      );
    }
  }

  private pendingUpgrade(): Pick<
    GitHubPreviewCapability,
    "upgradePending" | "upgradeInstallUrl" | "upgradeExpiresAt"
  > {
    const flow = this.database.getPendingGithubAppUpgradeFlow();
    if (!flow) {
      return {
        upgradePending: false,
        upgradeInstallUrl: null,
        upgradeExpiresAt: null
      };
    }
    const candidate = this.upgradeCandidate(flow);
    return {
      upgradePending: true,
      upgradeInstallUrl: `${candidate.metadata.appUrl}/installations/new`,
      upgradeExpiresAt: flow.expires_at
    };
  }

  private cleanupExpiredUpgradeBuffers(): void {
    for (const flow of this.database.listExpiredGithubAppUpgradeFlows()) {
      // The database trigger owns candidate buffer cleanup. It also covers
      // session cascades caused by logout, password rotation and startup prune.
      this.database.deleteGithubAppUpgradeFlow(flow.id);
    }
  }

  private retiredWebhookSources(): RetiredWebhookSource[] {
    const sources: RetiredWebhookSource[] = [];
    for (const row of this.database.listGithubRetiredWebhookSources()) {
      try {
        sources.push({
          appId: row.app_id,
          webhookSecret: this.decryptSecret(
            "github.retired_webhook_secret:v1",
            row.encrypted_webhook_secret
          ),
          previousInstallationId: row.previous_installation_id,
          successorInstallationId: row.successor_installation_id,
          expiresAt: row.expires_at
        });
      } catch {
        // A corrupt grace-period credential must never block the active app.
      }
    }
    return sources;
  }

  private webhookInstallationId(
    source: GitHubWebhookSource,
    payloadInstallationId: string,
    repositoryId: string
  ): string | null {
    if (source.kind === "active") return payloadInstallationId;
    if (source.kind !== "retired") return null;
    const currentInstallationId = this.database.currentGithubInstallationIdForRepository(repositoryId);
    if (
      !source.previousInstallationId
      || source.previousInstallationId !== payloadInstallationId
      || !source.successorInstallationId
      || source.successorInstallationId !== currentInstallationId
    ) return null;
    return currentInstallationId;
  }

  private currentWebhookSource(source?: GitHubWebhookSource): GitHubWebhookSource | null {
    const active = this.metadata();
    if (!source) {
      // Direct service callers (workers/tests) predate signature-source
      // routing. HTTP webhook requests always pass the verified source.
      return { kind: "active", appId: active?.appId ?? "direct" };
    }
    if (active?.appId === source.appId) {
      return { kind: "active", appId: source.appId };
    }
    const pending = this.database.getPendingGithubAppUpgradeFlow();
    if (pending) {
      try {
        const candidate = this.upgradeCandidate(pending);
        if (candidate.metadata.appId === source.appId) {
          return { kind: "pending", appId: source.appId };
        }
      } catch {
        // A corrupt candidate cannot be trusted as a current webhook source.
      }
    }
    const retired = this.database.getGithubRetiredWebhookSource(source.appId);
    if (retired) {
      return {
        kind: "retired",
        appId: source.appId,
        previousInstallationId: retired.previous_installation_id,
        successorInstallationId: retired.successor_installation_id
      };
    }
    return null;
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

  private hasStoredAppState(): boolean {
    return Boolean(
      this.database.getSetting(APP_METADATA_KEY)
      || this.database.getSetting(PRIVATE_KEY_KEY)
      || this.database.getSetting(WEBHOOK_SECRET_KEY)
    );
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

  private appPermissionsUrl(app: z.infer<typeof AppCapabilitySchema>): string {
    const metadata = this.requireMetadata();
    if (app.slug !== metadata.appSlug) {
      throw upstreamError("GitHub hat eine unerwartete App-Identität geliefert", "GITHUB_API_INVALID");
    }
    const owner = app.owner.login;
    const path = app.owner.type === "Organization"
      ? `/organizations/${owner}/settings/apps/${metadata.appSlug}/permissions`
      : app.owner.type === "Enterprise"
        ? `/enterprises/${owner}/settings/apps/${metadata.appSlug}/permissions`
        : `/settings/apps/${metadata.appSlug}/permissions`;
    return `https://github.com${path}`;
  }

  private installationSettingsUrl(installation: z.infer<typeof InstallationSchema>): string {
    if (!installation.html_url) {
      const id = String(installation.id);
      const login = installation.account.login;
      const path = installation.account.type === "Organization"
        ? `/organizations/${login}/settings/installations/${id}`
        : installation.account.type === "Enterprise"
          ? `/enterprises/${login}/settings/installations/${id}`
          : `/settings/installations/${id}`;
      return `https://github.com${path}`;
    }
    const url = new URL(installation.html_url);
    const id = String(installation.id);
    const login = installation.account.login;
    const allowedPaths = new Set([
      `/settings/installations/${id}`,
      `/organizations/${login}/settings/installations/${id}`,
      `/enterprises/${login}/settings/installations/${id}`
    ]);
    if (
      url.protocol !== "https:" || url.hostname !== "github.com" || url.port ||
      url.username || url.password || url.search || url.hash || !allowedPaths.has(url.pathname)
    ) {
      throw upstreamError("GitHub hat eine ungültige Installations-URL geliefert", "GITHUB_API_INVALID");
    }
    return url.toString();
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
