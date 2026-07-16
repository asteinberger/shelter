import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import type { AppConfig } from "../config.js";
import type {
  DeploymentLogRow,
  DeploymentRow,
  DeploymentStatus,
  DomainRow,
  EnvironmentVariableRow,
  ApiTokenRow,
  ApiTokenMetadataRow,
  GithubManifestFlowRow,
  GithubPendingPushRow,
  ProjectMetricHistoryRow,
  ProjectMetricSampleRow,
  ProjectDeletionRow,
  ProjectRow,
  RuntimeLogRow,
  ServerActivityCounts,
  ServerMetricHistoryRow,
  ServerMetricSampleRow,
  SessionRow,
  UserRow
} from "../types/models.js";
import { conflict } from "./errors.js";

type ProjectUpdates = Partial<Pick<ProjectRow,
  "name" | "repository_url" | "repository_branch" | "root_directory" | "build_type" | "dockerfile_path" |
  "port" | "healthcheck_path" | "memory_limit" | "cpu_limit" | "source_archive" | "static_base_path" |
  "active_deployment_id" | "github_repository_id" | "github_repository_full_name" | "github_installation_id" |
  "auto_deploy" | "github_connection_error" | "source_analysis_json"
>>;

type IdleProjectUpdateResult =
  | { kind: "updated"; project: ProjectRow }
  | { kind: "deployment_active" }
  | { kind: "conflict" };

function projectTimestampAfter(previous: string): string {
  const previousTime = Date.parse(previous);
  return new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
}

const GITHUB_STATUS_SNAPSHOT_SINCE_SETTING = "github.status_snapshot_since";

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 80),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
  token_hint TEXT NOT NULL CHECK(length(token_hint) = 4),
  scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json) AND json_type(scopes_json) = 'array'),
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS api_tokens_user_idx ON api_tokens(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS api_tokens_expires_idx ON api_tokens(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS cloudflare_oauth_flows (
  state_hash TEXT PRIMARY KEY,
  browser_nonce_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  encrypted_verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cloudflare_oauth_flows_expires_idx ON cloudflare_oauth_flows(expires_at);

CREATE TABLE IF NOT EXISTS cloudflare_oauth_pending (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_payload TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cloudflare_oauth_pending_expires_idx ON cloudflare_oauth_pending(expires_at);

CREATE TABLE IF NOT EXISTS github_manifest_flows (
  state_hash TEXT PRIMARY KEY,
  browser_nonce_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  encrypted_setup_state TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS github_manifest_flows_expires_idx ON github_manifest_flows(expires_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS server_metric_samples (
  sampled_at INTEGER PRIMARY KEY,
  host_name TEXT NOT NULL,
  host_operating_system TEXT NOT NULL,
  host_kernel TEXT NOT NULL,
  host_architecture TEXT NOT NULL,
  host_uptime_seconds INTEGER NOT NULL CHECK(host_uptime_seconds >= 0),
  cpu_usage_percent REAL NOT NULL CHECK(cpu_usage_percent BETWEEN 0 AND 100),
  cpu_logical_cores INTEGER NOT NULL CHECK(cpu_logical_cores >= 1),
  load_one REAL NOT NULL CHECK(load_one >= 0),
  load_five REAL NOT NULL CHECK(load_five >= 0),
  load_fifteen REAL NOT NULL CHECK(load_fifteen >= 0),
  memory_total_bytes INTEGER NOT NULL CHECK(memory_total_bytes >= 0),
  memory_used_bytes INTEGER NOT NULL CHECK(memory_used_bytes >= 0),
  memory_available_bytes INTEGER NOT NULL CHECK(memory_available_bytes >= 0),
  memory_usage_percent REAL NOT NULL CHECK(memory_usage_percent BETWEEN 0 AND 100),
  swap_total_bytes INTEGER NOT NULL CHECK(swap_total_bytes >= 0),
  swap_used_bytes INTEGER NOT NULL CHECK(swap_used_bytes >= 0),
  storage_total_bytes INTEGER NOT NULL CHECK(storage_total_bytes >= 0),
  storage_used_bytes INTEGER NOT NULL CHECK(storage_used_bytes >= 0),
  storage_available_bytes INTEGER NOT NULL CHECK(storage_available_bytes >= 0),
  storage_usage_percent REAL NOT NULL CHECK(storage_usage_percent BETWEEN 0 AND 100),
  docker_available INTEGER NOT NULL CHECK(docker_available IN (0, 1)),
  docker_version TEXT,
  managed_containers INTEGER NOT NULL CHECK(managed_containers >= 0),
  running_managed_containers INTEGER NOT NULL CHECK(running_managed_containers >= 0),
  application_cpu_usage_percent REAL NOT NULL CHECK(application_cpu_usage_percent >= 0),
  application_memory_used_bytes INTEGER NOT NULL CHECK(application_memory_used_bytes >= 0),
  application_memory_limit_bytes INTEGER NOT NULL CHECK(application_memory_limit_bytes >= 0),
  application_network_received_bytes INTEGER NOT NULL CHECK(application_network_received_bytes >= 0),
  application_network_transmitted_bytes INTEGER NOT NULL CHECK(application_network_transmitted_bytes >= 0),
  application_network_receive_bytes_per_second REAL NOT NULL CHECK(application_network_receive_bytes_per_second >= 0),
  application_network_transmit_bytes_per_second REAL NOT NULL CHECK(application_network_transmit_bytes_per_second >= 0),
  application_block_read_bytes INTEGER NOT NULL CHECK(application_block_read_bytes >= 0),
  application_block_write_bytes INTEGER NOT NULL CHECK(application_block_write_bytes >= 0),
  service_api TEXT NOT NULL CHECK(service_api IN ('online','offline','unknown','not_configured')),
  service_worker TEXT NOT NULL CHECK(service_worker IN ('online','offline','unknown','not_configured')),
  service_traefik TEXT NOT NULL CHECK(service_traefik IN ('online','offline','unknown','not_configured')),
  service_cloudflared TEXT NOT NULL CHECK(service_cloudflared IN ('online','offline','unknown','not_configured')),
  last_storage_maintenance_at TEXT,
  tunnel_configured INTEGER NOT NULL CHECK(tunnel_configured IN (0, 1))
);

CREATE TABLE IF NOT EXISTS project_metric_samples (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  sampled_at INTEGER NOT NULL,
  runtime_status TEXT NOT NULL CHECK(runtime_status IN ('created','running','paused','restarting','removing','exited','dead','missing','unknown')),
  health_status TEXT NOT NULL CHECK(health_status IN ('healthy','unhealthy','starting','none','unknown')),
  started_at TEXT,
  uptime_seconds INTEGER NOT NULL CHECK(uptime_seconds >= 0),
  restart_count INTEGER NOT NULL CHECK(restart_count >= 0),
  oom_killed INTEGER NOT NULL CHECK(oom_killed IN (0, 1)),
  cpu_usage_percent REAL NOT NULL CHECK(cpu_usage_percent >= 0),
  cpu_limit_cores REAL NOT NULL CHECK(cpu_limit_cores > 0),
  memory_used_bytes INTEGER NOT NULL CHECK(memory_used_bytes >= 0),
  memory_limit_bytes INTEGER NOT NULL CHECK(memory_limit_bytes >= 0),
  memory_usage_percent REAL NOT NULL CHECK(memory_usage_percent BETWEEN 0 AND 100),
  network_received_bytes INTEGER NOT NULL CHECK(network_received_bytes >= 0),
  network_transmitted_bytes INTEGER NOT NULL CHECK(network_transmitted_bytes >= 0),
  network_receive_bytes_per_second REAL NOT NULL CHECK(network_receive_bytes_per_second >= 0),
  network_transmit_bytes_per_second REAL NOT NULL CHECK(network_transmit_bytes_per_second >= 0),
  block_read_bytes INTEGER NOT NULL CHECK(block_read_bytes >= 0),
  block_write_bytes INTEGER NOT NULL CHECK(block_write_bytes >= 0),
  PRIMARY KEY(project_id, sampled_at)
);
CREATE INDEX IF NOT EXISTS project_metric_samples_history_idx
  ON project_metric_samples(project_id, sampled_at DESC);
CREATE INDEX IF NOT EXISTS project_metric_samples_retention_idx
  ON project_metric_samples(sampled_at);

CREATE TABLE IF NOT EXISTS runtime_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  stream TEXT NOT NULL CHECK(stream IN ('stdout', 'stderr')),
  message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 4096),
  source_timestamp TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  UNIQUE(deployment_id, stream, source_timestamp, message)
);
CREATE INDEX IF NOT EXISTS runtime_logs_project_cursor_idx ON runtime_logs(project_id, id);
CREATE INDEX IF NOT EXISTS runtime_logs_project_time_idx ON runtime_logs(project_id, source_timestamp DESC);
CREATE INDEX IF NOT EXISTS runtime_logs_retention_idx ON runtime_logs(source_timestamp);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL CHECK(source_type IN ('git', 'upload')),
  repository_url TEXT,
  repository_branch TEXT,
  source_archive TEXT,
  static_base_path TEXT,
  root_directory TEXT NOT NULL DEFAULT '.',
  build_type TEXT NOT NULL DEFAULT 'auto' CHECK(build_type IN ('auto', 'dockerfile', 'node', 'static')),
  dockerfile_path TEXT NOT NULL DEFAULT 'Dockerfile',
  port INTEGER NOT NULL DEFAULT 3000 CHECK(port BETWEEN 1 AND 65535),
  healthcheck_path TEXT NOT NULL DEFAULT '/',
  memory_limit TEXT NOT NULL DEFAULT '1g',
  cpu_limit TEXT NOT NULL DEFAULT '1.0',
  github_repository_id TEXT,
  github_repository_full_name TEXT,
  github_installation_id TEXT,
  auto_deploy INTEGER NOT NULL DEFAULT 0 CHECK(auto_deploy IN (0, 1)),
  github_connection_error TEXT,
  source_analysis_json TEXT,
  active_deployment_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_deletions (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('preparing','queued','running','failed')),
  error TEXT,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS project_deletions_queue_idx ON project_deletions(status, requested_at);

CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL UNIQUE COLLATE NOCASE,
  zone_id TEXT,
  dns_record_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'error')),
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS domains_project_idx ON domains(project_id);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('queued','preparing','building','checking','switching','ready','failed','cancelled')),
  source_ref TEXT,
  image_tag TEXT,
  previous_image_tag TEXT,
  internal_port INTEGER,
  static_base_path TEXT,
  runtime_kind TEXT,
  runtime_description TEXT,
  runtime_container TEXT,
  failure_kind TEXT,
  rollback_status TEXT NOT NULL DEFAULT 'not_required',
  rollback_deployment_id TEXT,
  cancel_requested_at TEXT,
  commit_sha TEXT,
  commit_message TEXT,
  commit_author TEXT,
  commit_url TEXT,
  trigger TEXT NOT NULL DEFAULT 'manual' CHECK(trigger IN ('manual', 'github_push', 'rollback')),
  github_delivery_id TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deployments_queue_idx ON deployments(status, created_at);
CREATE INDEX IF NOT EXISTS deployments_project_idx ON deployments(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deployments_terminal_activity_idx ON deployments(status, finished_at, created_at);
CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  payload_hash TEXT,
  status TEXT NOT NULL CHECK(status IN ('processing', 'processed', 'ignored', 'failed')),
  error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS github_webhook_deliveries_received_idx ON github_webhook_deliveries(received_at);

CREATE TABLE IF NOT EXISTS github_dirty_refs (
  installation_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  repository_full_name TEXT NOT NULL,
  branch TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  latest_delivery_id TEXT NOT NULL,
  claim_token TEXT,
  claimed_generation INTEGER,
  claimed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id, repository_id, branch)
);
CREATE INDEX IF NOT EXISTS github_dirty_refs_due_idx
  ON github_dirty_refs(next_attempt_at, claimed_at);

CREATE TABLE IF NOT EXISTS github_pending_pushes (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  repository_full_name TEXT NOT NULL,
  branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  commit_message TEXT,
  commit_author TEXT,
  commit_url TEXT,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS github_status_outbox (
  deployment_id TEXT PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  repository_full_name TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  desired_state TEXT NOT NULL CHECK(desired_state IN ('pending','success','failure','error')),
  description TEXT NOT NULL,
  delivered_state TEXT CHECK(delivered_state IN ('pending','success','failure','error')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS github_status_outbox_due_idx
  ON github_status_outbox(delivered_state, next_attempt_at);

CREATE TABLE IF NOT EXISTS deployment_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  stream TEXT NOT NULL CHECK(stream IN ('system', 'stdout', 'stderr')),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deployment_logs_cursor_idx ON deployment_logs(deployment_id, id);

CREATE TABLE IF NOT EXISTS environment_variables (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, key)
);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  expected_size INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  total_chunks INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'complete')),
  archive_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS upload_locks (
  upload_id TEXT PRIMARY KEY REFERENCES uploads(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL
);
`;

export interface CloudflareOAuthFlowRow {
  state_hash: string;
  browser_nonce_hash: string;
  user_id: string;
  session_token_hash: string;
  encrypted_verifier: string;
  redirect_uri: string;
  client_id: string;
  scopes: string;
  expires_at: string;
  created_at: string;
}

export interface CloudflareOAuthPendingRow {
  user_id: string;
  encrypted_payload: string;
  expires_at: string;
  created_at: string;
}

export interface GithubPushSnapshot {
  deliveryId: string;
  installationId: string;
  repositoryId: string;
  repositoryFullName: string;
  branch: string;
  commitSha: string;
  commitMessage: string | null;
  commitAuthor: string | null;
  commitUrl: string | null;
  receivedAt: string;
}

export interface GithubStatusOutboxRow {
  deployment_id: string;
  installation_id: string;
  repository_id: string;
  repository_full_name: string;
  commit_sha: string;
  desired_state: "pending" | "success" | "failure" | "error";
  description: string;
  delivered_state: "pending" | "success" | "failure" | "error" | null;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  updated_at: string;
}

export interface GithubDirtyRefRow {
  installation_id: string;
  repository_id: string;
  repository_full_name: string;
  branch: string;
  generation: number;
  latest_delivery_id: string;
  claim_token: string | null;
  claimed_generation: number | null;
  claimed_at: string | null;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  updated_at: string;
}

export class Database {
  readonly sqlite: BetterSqlite3.Database;
  private readonly logWritesSincePrune = new Map<string, number>();

  constructor(config: AppConfig) {
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true, mode: 0o700 });
    this.sqlite = new BetterSqlite3(config.databasePath);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    const apiTokenColumns = this.sqlite.pragma("table_info(api_tokens)") as Array<{ name: string }>;
    const finalApiTokenColumns = [
      "id", "user_id", "name", "token_hash", "token_hint", "scopes_json", "expires_at",
      "last_used_at", "revoked_at", "created_at", "updated_at"
    ];
    if (
      apiTokenColumns.length > 0
      && !finalApiTokenColumns.every((name) => apiTokenColumns.some((column) => column.name === name))
    ) {
      // Personal tokens were experimental before the v1 format. They cannot be
      // converted safely because their bearer format and hash domain changed;
      // dropping only this child table revokes them without touching users or sessions.
      this.sqlite.exec("DROP TABLE api_tokens");
    }
    this.sqlite.exec(schema);
    this.sqlite.prepare(`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY project_id
          ORDER BY CASE status
            WHEN 'switching' THEN 5 WHEN 'checking' THEN 4 WHEN 'building' THEN 3
            WHEN 'preparing' THEN 2 ELSE 1 END DESC,
            created_at ASC
        ) AS position
        FROM deployments
        WHERE status IN ('queued','preparing','building','checking','switching')
      )
      UPDATE deployments
      SET status = 'failed', error = 'Duplicate active deployment removed during queue migration', finished_at = ?
      WHERE id IN (SELECT id FROM ranked WHERE position > 1)
    `).run(new Date().toISOString());
    this.sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS deployments_one_active_project_idx
        ON deployments(project_id)
        WHERE status IN ('queued','preparing','building','checking','switching')
    `);
    const sessionColumns = this.sqlite.pragma("table_info(sessions)") as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "csrf_token")) {
      this.sqlite.exec("ALTER TABLE sessions ADD COLUMN csrf_token TEXT");
    }
    const projectColumns = this.sqlite.pragma("table_info(projects)") as Array<{ name: string }>;
    if (!projectColumns.some((column) => column.name === "static_base_path")) {
      this.sqlite.exec("ALTER TABLE projects ADD COLUMN static_base_path TEXT");
    }
    if (!projectColumns.some((column) => column.name === "github_repository_id")) {
      this.sqlite.exec("ALTER TABLE projects ADD COLUMN github_repository_id TEXT");
    }
    if (!projectColumns.some((column) => column.name === "github_repository_full_name")) {
      this.sqlite.exec("ALTER TABLE projects ADD COLUMN github_repository_full_name TEXT");
    }
    if (!projectColumns.some((column) => column.name === "github_installation_id")) {
      this.sqlite.exec("ALTER TABLE projects ADD COLUMN github_installation_id TEXT");
    }
    if (!projectColumns.some((column) => column.name === "auto_deploy")) {
      this.sqlite.exec("ALTER TABLE projects ADD COLUMN auto_deploy INTEGER NOT NULL DEFAULT 0 CHECK(auto_deploy IN (0, 1))");
    }
    if (!projectColumns.some((column) => column.name === "github_connection_error")) {
      this.sqlite.exec("ALTER TABLE projects ADD COLUMN github_connection_error TEXT");
    }
    if (!projectColumns.some((column) => column.name === "source_analysis_json")) {
      this.sqlite.exec("ALTER TABLE projects ADD COLUMN source_analysis_json TEXT");
    }
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS projects_github_link_idx
        ON projects(github_installation_id, github_repository_id, repository_branch)
    `);
    const deploymentColumns = this.sqlite.pragma("table_info(deployments)") as Array<{ name: string }>;
    if (!deploymentColumns.some((column) => column.name === "static_base_path")) {
      this.sqlite.exec("ALTER TABLE deployments ADD COLUMN static_base_path TEXT");
    }
    if (!deploymentColumns.some((column) => column.name === "runtime_kind")) {
      this.sqlite.exec("ALTER TABLE deployments ADD COLUMN runtime_kind TEXT");
    }
    if (!deploymentColumns.some((column) => column.name === "runtime_description")) {
      this.sqlite.exec("ALTER TABLE deployments ADD COLUMN runtime_description TEXT");
    }
    if (!deploymentColumns.some((column) => column.name === "commit_message")) {
      this.sqlite.exec("ALTER TABLE deployments ADD COLUMN commit_message TEXT");
    }
    if (!deploymentColumns.some((column) => column.name === "commit_author")) {
      this.sqlite.exec("ALTER TABLE deployments ADD COLUMN commit_author TEXT");
    }
    if (!deploymentColumns.some((column) => column.name === "commit_url")) {
      this.sqlite.exec("ALTER TABLE deployments ADD COLUMN commit_url TEXT");
    }
    if (!deploymentColumns.some((column) => column.name === "trigger")) {
      this.sqlite.exec("ALTER TABLE deployments ADD COLUMN trigger TEXT NOT NULL DEFAULT 'manual' CHECK(trigger IN ('manual', 'github_push', 'rollback'))");
    }
    if (!deploymentColumns.some((column) => column.name === "github_delivery_id")) {
      this.sqlite.exec("ALTER TABLE deployments ADD COLUMN github_delivery_id TEXT");
    }
    if (!deploymentColumns.some((column) => column.name === "runtime_container")) {
      this.sqlite.exec("ALTER TABLE deployments ADD COLUMN runtime_container TEXT");
    }
    if (!deploymentColumns.some((column) => column.name === "failure_kind")) {
      this.sqlite.exec("ALTER TABLE deployments ADD COLUMN failure_kind TEXT");
    }
    if (!deploymentColumns.some((column) => column.name === "rollback_status")) {
      this.sqlite.exec("ALTER TABLE deployments ADD COLUMN rollback_status TEXT NOT NULL DEFAULT 'not_required'");
    }
    if (!deploymentColumns.some((column) => column.name === "rollback_deployment_id")) {
      this.sqlite.exec("ALTER TABLE deployments ADD COLUMN rollback_deployment_id TEXT");
    }
    if (!deploymentColumns.some((column) => column.name === "cancel_requested_at")) {
      this.sqlite.exec("ALTER TABLE deployments ADD COLUMN cancel_requested_at TEXT");
    }
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS deployments_source_snapshot_idx
        ON deployments(project_id, source_ref, static_base_path, created_at DESC)
      ;
      CREATE UNIQUE INDEX IF NOT EXISTS deployments_github_delivery_idx
        ON deployments(project_id, github_delivery_id) WHERE github_delivery_id IS NOT NULL
    `);
    const githubDeliveryColumns = this.sqlite.pragma("table_info(github_webhook_deliveries)") as Array<{ name: string }>;
    if (!githubDeliveryColumns.some((column) => column.name === "payload_hash")) {
      this.sqlite.exec("ALTER TABLE github_webhook_deliveries ADD COLUMN payload_hash TEXT");
    }
    const githubStatusColumns = this.sqlite.pragma("table_info(github_status_outbox)") as Array<{ name: string }>;
    for (const column of ["installation_id", "repository_id", "repository_full_name", "commit_sha"] as const) {
      if (!githubStatusColumns.some((candidate) => candidate.name === column)) {
        this.sqlite.exec(`ALTER TABLE github_status_outbox ADD COLUMN ${column} TEXT`);
      }
    }
    // Pre-snapshot rows cannot be safely attributed after a project was unlinked or re-linked.
    this.sqlite.exec(`
      DELETE FROM github_status_outbox
      WHERE installation_id IS NULL OR repository_id IS NULL
        OR repository_full_name IS NULL OR commit_sha IS NULL
    `);
    const snapshotMigrationTime = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    `).run(GITHUB_STATUS_SNAPSHOT_SINCE_SETTING, snapshotMigrationTime, snapshotMigrationTime);
    // Historical deployment logs are immutable evidence and can contain user
    // project names, branches and paths even in the system stream. Keep them
    // byte-for-byte intact; only the bounded status-outbox descriptions below
    // are authored entirely by the control plane.
    this.sqlite.prepare(`
      UPDATE github_status_outbox
      SET description = replace(description, 'Portsmith', 'Shelter')
      WHERE instr(description, 'Portsmith') > 0
    `).run();
    this.pruneExpiredSessions();
    this.pruneExpiredCloudflareOAuthState();
    this.pruneExpiredGithubState();
  }

  close(): void {
    this.sqlite.close();
  }

  pruneExpiredSessions(): void {
    this.sqlite.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
  }

  findUserByEmail(email: string): UserRow | undefined {
    return this.sqlite.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email) as UserRow | undefined;
  }

  findUserById(id: string): UserRow | undefined {
    return this.sqlite.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  }

  createUser(user: UserRow): void {
    this.sqlite.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (@id, @email, @password_hash, @created_at)").run(user);
  }

  updateUserPasswordAndInvalidateOtherSessions(
    userId: string,
    passwordHash: string,
    currentSessionTokenHash: string
  ): { invalidatedSessions: number; invalidatedApiTokens: number } {
    return this.sqlite.transaction(() => {
      const updated = this.sqlite.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
      if (updated.changes !== 1) throw new Error("User not found while updating password");
      const invalidated = this.sqlite.prepare(
        "DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?"
      ).run(userId, currentSessionTokenHash);
      const now = new Date().toISOString();
      const invalidatedTokens = this.sqlite.prepare(`
        UPDATE api_tokens SET revoked_at = ?, updated_at = ?
        WHERE user_id = ? AND revoked_at IS NULL
      `).run(now, now, userId);
      return {
        invalidatedSessions: invalidated.changes,
        invalidatedApiTokens: invalidatedTokens.changes
      };
    })();
  }

  createSession(session: SessionRow): void {
    this.sqlite.prepare(`
      INSERT INTO sessions (token_hash, user_id, csrf_hash, csrf_token, expires_at, created_at)
      VALUES (@token_hash, @user_id, @csrf_hash, @csrf_token, @expires_at, @created_at)
    `).run(session);
  }

  getSession(tokenHash: string): SessionRow | undefined {
    return this.sqlite.prepare("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?").get(tokenHash, new Date().toISOString()) as SessionRow | undefined;
  }

  deleteSession(tokenHash: string): void {
    this.sqlite.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  createApiToken(apiToken: ApiTokenRow): void {
    const create = this.sqlite.transaction(() => {
      const now = new Date().toISOString();
      const active = this.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM api_tokens
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      `).get(apiToken.user_id, now) as { count: number };
      if (active.count >= 25) {
        throw conflict("Maximal 25 aktive API-Token sind erlaubt", "API_TOKEN_LIMIT");
      }
      this.sqlite.prepare(`
        INSERT INTO api_tokens (
          id, user_id, name, token_hash, token_hint, scopes_json, expires_at,
          last_used_at, revoked_at, created_at, updated_at
        ) VALUES (
          @id, @user_id, @name, @token_hash, @token_hint, @scopes_json, @expires_at,
          @last_used_at, @revoked_at, @created_at, @updated_at
        )
      `).run(apiToken);
    });
    create.immediate();
  }

  getApiTokenByHash(tokenHash: string): ApiTokenRow | undefined {
    return this.sqlite.prepare(`
      SELECT * FROM api_tokens
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
    `).get(tokenHash, new Date().toISOString()) as ApiTokenRow | undefined;
  }

  listApiTokens(userId: string): ApiTokenMetadataRow[] {
    return this.sqlite.prepare(`
      SELECT id, user_id, name, token_hint, scopes_json, expires_at, last_used_at,
             revoked_at, created_at, updated_at
      FROM api_tokens
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC
    `).all(userId, new Date().toISOString()) as ApiTokenMetadataRow[];
  }

  touchApiToken(id: string): void {
    const now = new Date();
    const threshold = new Date(now.getTime() - 5 * 60_000).toISOString();
    this.sqlite.prepare(`
      UPDATE api_tokens SET last_used_at = ?, updated_at = ?
      WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)
    `).run(now.toISOString(), now.toISOString(), id, threshold);
  }

  revokeApiToken(id: string, userId: string): boolean {
    const existing = this.sqlite.prepare("SELECT 1 FROM api_tokens WHERE id = ? AND user_id = ?")
      .get(id, userId);
    if (!existing) return false;
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(now, now, id, userId);
    return true;
  }

  revokeAllApiTokensForUser(userId: string): number {
    const now = new Date().toISOString();
    return this.sqlite.prepare(`
      UPDATE api_tokens SET revoked_at = ?, updated_at = ?
      WHERE user_id = ? AND revoked_at IS NULL
    `).run(now, now, userId).changes;
  }

  pruneExpiredCloudflareOAuthState(): void {
    const now = new Date().toISOString();
    this.sqlite.prepare("DELETE FROM cloudflare_oauth_flows WHERE expires_at <= ?").run(now);
    this.sqlite.prepare("DELETE FROM cloudflare_oauth_pending WHERE expires_at <= ?").run(now);
  }

  pruneExpiredGithubState(): void {
    const now = new Date().toISOString();
    this.sqlite.prepare("DELETE FROM github_manifest_flows WHERE expires_at <= ?").run(now);
    this.sqlite.prepare(`
      DELETE FROM github_webhook_deliveries
      WHERE received_at <= ?
        AND status IN ('processed', 'ignored')
    `).run(new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString());
  }

  createGithubManifestFlow(flow: GithubManifestFlowRow): void {
    this.sqlite.prepare(`
      INSERT INTO github_manifest_flows (
        state_hash, browser_nonce_hash, user_id, session_token_hash, encrypted_setup_state,
        redirect_uri, expires_at, created_at
      ) VALUES (
        @state_hash, @browser_nonce_hash, @user_id, @session_token_hash, @encrypted_setup_state,
        @redirect_uri, @expires_at, @created_at
      )
    `).run(flow);
  }

  consumeGithubManifestFlow(stateHash: string, browserNonceHash: string): GithubManifestFlowRow | undefined {
    const now = new Date().toISOString();
    return this.sqlite.prepare(`
      DELETE FROM github_manifest_flows
      WHERE state_hash = ?
        AND browser_nonce_hash = ?
        AND expires_at > ?
        AND EXISTS (
          SELECT 1 FROM sessions
          WHERE sessions.token_hash = github_manifest_flows.session_token_hash
            AND sessions.user_id = github_manifest_flows.user_id
            AND sessions.expires_at > ?
        )
      RETURNING *
    `).get(stateHash, browserNonceHash, now, now) as GithubManifestFlowRow | undefined;
  }

  deleteGithubManifestFlows(): void {
    this.sqlite.prepare("DELETE FROM github_manifest_flows").run();
  }

  createCloudflareOAuthFlow(flow: CloudflareOAuthFlowRow): void {
    this.sqlite.prepare(`
      INSERT INTO cloudflare_oauth_flows (
        state_hash, browser_nonce_hash, user_id, session_token_hash, encrypted_verifier,
        redirect_uri, client_id, scopes, expires_at, created_at
      ) VALUES (
        @state_hash, @browser_nonce_hash, @user_id, @session_token_hash, @encrypted_verifier,
        @redirect_uri, @client_id, @scopes, @expires_at, @created_at
      )
    `).run(flow);
  }

  consumeCloudflareOAuthFlow(stateHash: string, browserNonceHash: string): CloudflareOAuthFlowRow | undefined {
    const now = new Date().toISOString();
    return this.sqlite.prepare(`
      DELETE FROM cloudflare_oauth_flows
      WHERE state_hash = ?
        AND browser_nonce_hash = ?
        AND expires_at > ?
        AND EXISTS (
          SELECT 1
          FROM sessions
          WHERE sessions.token_hash = cloudflare_oauth_flows.session_token_hash
            AND sessions.user_id = cloudflare_oauth_flows.user_id
            AND sessions.expires_at > ?
        )
      RETURNING *
    `).get(stateHash, browserNonceHash, now, now) as CloudflareOAuthFlowRow | undefined;
  }

  upsertCloudflareOAuthPending(pending: CloudflareOAuthPendingRow): void {
    this.sqlite.prepare(`
      INSERT INTO cloudflare_oauth_pending (user_id, encrypted_payload, expires_at, created_at)
      VALUES (@user_id, @encrypted_payload, @expires_at, @created_at)
      ON CONFLICT(user_id) DO UPDATE SET
        encrypted_payload = excluded.encrypted_payload,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at
    `).run(pending);
  }

  getCloudflareOAuthPending(userId: string): CloudflareOAuthPendingRow | undefined {
    return this.sqlite.prepare(
      "SELECT * FROM cloudflare_oauth_pending WHERE user_id = ? AND expires_at > ?"
    ).get(userId, new Date().toISOString()) as CloudflareOAuthPendingRow | undefined;
  }

  deleteCloudflareOAuthPending(userId?: string): void {
    if (userId) {
      this.sqlite.prepare("DELETE FROM cloudflare_oauth_pending WHERE user_id = ?").run(userId);
      return;
    }
    this.sqlite.prepare("DELETE FROM cloudflare_oauth_pending").run();
  }

  deleteCloudflareOAuthFlows(): void {
    this.sqlite.prepare("DELETE FROM cloudflare_oauth_flows").run();
  }

  getSetting(key: string): string | undefined {
    const row = this.sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.sqlite.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString());
  }

  deleteSetting(key: string): void {
    this.sqlite.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  beginGithubWebhookDelivery(deliveryId: string, eventName: string): "claimed" | "duplicate" {
    const begin = this.sqlite.transaction(() => {
      const existing = this.sqlite.prepare(
        "SELECT status, received_at FROM github_webhook_deliveries WHERE delivery_id = ?"
      ).get(deliveryId) as { status: string; received_at: string } | undefined;
      const now = new Date();
      if (!existing) {
        this.sqlite.prepare(`
          INSERT INTO github_webhook_deliveries (
            delivery_id, event_name, status, error, received_at, processed_at
          ) VALUES (?, ?, 'processing', NULL, ?, NULL)
        `).run(deliveryId, eventName, now.toISOString());
        return "claimed" as const;
      }
      const processingIsStale = existing.status === "processing" &&
        now.getTime() - new Date(existing.received_at).getTime() > 5 * 60_000;
      if (existing.status !== "failed" && !processingIsStale) return "duplicate" as const;
      this.sqlite.prepare(`
        UPDATE github_webhook_deliveries
        SET event_name = ?, status = 'processing', error = NULL, received_at = ?, processed_at = NULL
        WHERE delivery_id = ?
      `).run(eventName, now.toISOString(), deliveryId);
      return "claimed" as const;
    });
    return begin.immediate();
  }

  claimGithubWebhookDelivery(
    deliveryId: string,
    eventName: string,
    payloadHash: string
  ): "claimed" | "duplicate" | "mismatch" {
    const existing = this.sqlite.prepare(`
      SELECT event_name, payload_hash FROM github_webhook_deliveries WHERE delivery_id = ?
    `).get(deliveryId) as { event_name: string; payload_hash: string | null } | undefined;
    if (existing) {
      if (existing.event_name !== eventName || (existing.payload_hash !== null && existing.payload_hash !== payloadHash)) {
        return "mismatch";
      }
      return "duplicate";
    }
    this.sqlite.prepare(`
      INSERT INTO github_webhook_deliveries (
        delivery_id, event_name, payload_hash, status, error, received_at, processed_at
      ) VALUES (?, ?, ?, 'processing', NULL, ?, NULL)
    `).run(deliveryId, eventName, payloadHash, new Date().toISOString());
    return "claimed";
  }

  enqueueGithubDirtyRef(input: {
    installationId: string;
    repositoryId: string;
    repositoryFullName: string;
    branch: string;
    deliveryId: string;
  }): void {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO github_dirty_refs (
        installation_id, repository_id, repository_full_name, branch, generation,
        latest_delivery_id, claim_token, claimed_generation, claimed_at, attempts,
        next_attempt_at, last_error, updated_at
      ) VALUES (
        @installation_id, @repository_id, @repository_full_name, @branch, 1,
        @latest_delivery_id, NULL, NULL, NULL, 0, @now, NULL, @now
      )
      ON CONFLICT(installation_id, repository_id, branch) DO UPDATE SET
        repository_full_name = excluded.repository_full_name,
        generation = github_dirty_refs.generation + 1,
        latest_delivery_id = excluded.latest_delivery_id,
        next_attempt_at = excluded.next_attempt_at,
        last_error = NULL,
        updated_at = excluded.updated_at
    `).run({
      installation_id: input.installationId,
      repository_id: input.repositoryId,
      repository_full_name: input.repositoryFullName,
      branch: input.branch,
      latest_delivery_id: input.deliveryId,
      now
    });
  }

  claimNextGithubDirtyRef(): GithubDirtyRefRow | undefined {
    const claim = this.sqlite.transaction(() => {
      const now = new Date();
      const staleBefore = new Date(now.getTime() - 5 * 60_000).toISOString();
      const row = this.sqlite.prepare(`
        SELECT * FROM github_dirty_refs
        WHERE next_attempt_at <= ?
          AND (claim_token IS NULL OR claimed_at <= ?)
        ORDER BY next_attempt_at ASC, updated_at ASC
        LIMIT 1
      `).get(now.toISOString(), staleBefore) as GithubDirtyRefRow | undefined;
      if (!row) return undefined;
      const claimToken = randomUUID();
      const updated = this.sqlite.prepare(`
        UPDATE github_dirty_refs
        SET claim_token = ?, claimed_generation = generation, claimed_at = ?
        WHERE installation_id = ? AND repository_id = ? AND branch = ?
          AND generation = ?
          AND (claim_token IS NULL OR claimed_at <= ?)
      `).run(
        claimToken,
        now.toISOString(),
        row.installation_id,
        row.repository_id,
        row.branch,
        row.generation,
        staleBefore
      );
      if (updated.changes !== 1) return undefined;
      return this.sqlite.prepare(`
        SELECT * FROM github_dirty_refs
        WHERE installation_id = ? AND repository_id = ? AND branch = ?
      `).get(row.installation_id, row.repository_id, row.branch) as GithubDirtyRefRow;
    });
    return claim.immediate();
  }

  applyResolvedGithubRef(
    claimed: GithubDirtyRefRow,
    push: GithubPushSnapshot,
    repositoryUrl?: string
  ): { kind: "applied"; queued: number; pending: number; ignored: number } | { kind: "superseded" | "lost" } {
    const apply = this.sqlite.transaction(() => {
      const current = this.sqlite.prepare(`
        SELECT * FROM github_dirty_refs
        WHERE installation_id = ? AND repository_id = ? AND branch = ?
      `).get(claimed.installation_id, claimed.repository_id, claimed.branch) as GithubDirtyRefRow | undefined;
      if (!current || current.claim_token !== claimed.claim_token) return { kind: "lost" } as const;
      if (current.generation !== claimed.claimed_generation) {
        this.releaseGithubDirtyRefClaim(current, claimed.claim_token!);
        return { kind: "superseded" } as const;
      }
      if (repositoryUrl) {
        this.sqlite.prepare(`
          UPDATE projects
          SET github_repository_full_name = ?, repository_url = ?, updated_at = ?
          WHERE github_installation_id = ? AND github_repository_id = ?
            AND github_connection_error IS NULL
        `).run(
          push.repositoryFullName,
          repositoryUrl,
          new Date().toISOString(),
          current.installation_id,
          current.repository_id
        );
      }
      const counts = { queued: 0, pending: 0, ignored: 0 };
      for (const project of this.listGithubProjects(
        current.installation_id,
        current.repository_id,
        current.branch
      )) {
        const result = this.queueOrPendGithubPush(project.id, push);
        counts[result.kind] += 1;
      }
      this.sqlite.prepare(`
        DELETE FROM github_dirty_refs
        WHERE installation_id = ? AND repository_id = ? AND branch = ?
          AND claim_token = ? AND generation = ?
      `).run(
        current.installation_id,
        current.repository_id,
        current.branch,
        claimed.claim_token,
        current.generation
      );
      return { kind: "applied", ...counts } as const;
    });
    return apply.immediate();
  }

  discardGithubDirtyRef(claimed: GithubDirtyRefRow): "discarded" | "superseded" | "lost" {
    const discard = this.sqlite.transaction(() => {
      const current = this.sqlite.prepare(`
        SELECT * FROM github_dirty_refs
        WHERE installation_id = ? AND repository_id = ? AND branch = ?
      `).get(claimed.installation_id, claimed.repository_id, claimed.branch) as GithubDirtyRefRow | undefined;
      if (!current || current.claim_token !== claimed.claim_token) return "lost" as const;
      if (current.generation !== claimed.claimed_generation) {
        this.releaseGithubDirtyRefClaim(current, claimed.claim_token!);
        return "superseded" as const;
      }
      this.sqlite.prepare(`
        DELETE FROM github_dirty_refs
        WHERE installation_id = ? AND repository_id = ? AND branch = ? AND claim_token = ?
      `).run(current.installation_id, current.repository_id, current.branch, claimed.claim_token);
      return "discarded" as const;
    });
    return discard.immediate();
  }

  failGithubDirtyRef(claimed: GithubDirtyRefRow, errorCode: string): void {
    const current = this.sqlite.prepare(`
      SELECT generation, attempts, claim_token FROM github_dirty_refs
      WHERE installation_id = ? AND repository_id = ? AND branch = ?
    `).get(claimed.installation_id, claimed.repository_id, claimed.branch) as {
      generation: number;
      attempts: number;
      claim_token: string | null;
    } | undefined;
    if (!current || current.claim_token !== claimed.claim_token) return;
    const attempts = current.generation === claimed.claimed_generation ? current.attempts + 1 : 0;
    const delaySeconds = current.generation === claimed.claimed_generation
      ? Math.min(5 * 60, 2 ** Math.min(attempts, 8))
      : 0;
    this.sqlite.prepare(`
      UPDATE github_dirty_refs
      SET claim_token = NULL, claimed_generation = NULL, claimed_at = NULL,
          attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE installation_id = ? AND repository_id = ? AND branch = ? AND claim_token = ?
    `).run(
      attempts,
      new Date(Date.now() + delaySeconds * 1_000).toISOString(),
      errorCode.replaceAll(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100) || "GITHUB_REF_RESOLVE_FAILED",
      new Date().toISOString(),
      claimed.installation_id,
      claimed.repository_id,
      claimed.branch,
      claimed.claim_token
    );
  }

  private releaseGithubDirtyRefClaim(current: GithubDirtyRefRow, claimToken: string): void {
    this.sqlite.prepare(`
      UPDATE github_dirty_refs
      SET claim_token = NULL, claimed_generation = NULL, claimed_at = NULL,
          attempts = 0, next_attempt_at = ?, last_error = NULL, updated_at = ?
      WHERE installation_id = ? AND repository_id = ? AND branch = ? AND claim_token = ?
    `).run(
      new Date().toISOString(),
      new Date().toISOString(),
      current.installation_id,
      current.repository_id,
      current.branch,
      claimToken
    );
  }

  finishGithubWebhookDelivery(deliveryId: string, status: "processed" | "ignored"): void {
    this.sqlite.prepare(`
      UPDATE github_webhook_deliveries
      SET status = ?, error = NULL, processed_at = ?
      WHERE delivery_id = ? AND status = 'processing'
    `).run(status, new Date().toISOString(), deliveryId);
  }

  failGithubWebhookDelivery(deliveryId: string, error: string): void {
    this.sqlite.prepare(`
      UPDATE github_webhook_deliveries
      SET status = 'failed', error = ?, processed_at = ?
      WHERE delivery_id = ? AND status = 'processing'
    `).run(error.slice(0, 1_000), new Date().toISOString(), deliveryId);
  }

  listGithubProjects(installationId: string, repositoryId: string, branch: string): ProjectRow[] {
    return this.sqlite.prepare(`
      SELECT projects.* FROM projects
      WHERE github_installation_id = ?
        AND github_repository_id = ?
        AND repository_branch = ?
        AND auto_deploy = 1
        AND github_connection_error IS NULL
        AND source_type = 'git'
        AND NOT EXISTS (
          SELECT 1 FROM project_deletions WHERE project_deletions.project_id = projects.id
        )
      ORDER BY created_at ASC
    `).all(installationId, repositoryId, branch) as ProjectRow[];
  }

  queueOrPendGithubPush(projectId: string, push: GithubPushSnapshot):
    | { kind: "queued"; deployment: DeploymentRow }
    | { kind: "pending" }
    | { kind: "ignored" } {
    const queue = this.sqlite.transaction(() => {
      const project = this.sqlite.prepare(`
        SELECT projects.* FROM projects
        WHERE id = ?
          AND source_type = 'git'
          AND auto_deploy = 1
          AND github_installation_id = ?
          AND github_repository_id = ?
          AND repository_branch = ?
          AND NOT EXISTS (
            SELECT 1 FROM project_deletions WHERE project_deletions.project_id = projects.id
          )
      `).get(
        projectId,
        push.installationId,
        push.repositoryId,
        push.branch
      ) as ProjectRow | undefined;
      if (!project) return { kind: "ignored" } as const;

      const active = this.sqlite.prepare(`
        SELECT commit_sha FROM deployments
        WHERE project_id = ? AND status IN ('queued','preparing','building','checking','switching')
        LIMIT 1
      `).get(projectId) as { commit_sha: string | null } | undefined;
      if (active) {
        if (active.commit_sha === push.commitSha) return { kind: "ignored" } as const;
        this.upsertPendingGithubPush(projectId, push);
        return { kind: "pending" } as const;
      }

      const latest = this.sqlite.prepare(`
        SELECT commit_sha, status FROM deployments
        WHERE project_id = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(projectId) as { commit_sha: string | null; status: string } | undefined;
      if (latest?.commit_sha === push.commitSha && latest.status === "ready") {
        this.sqlite.prepare("DELETE FROM github_pending_pushes WHERE project_id = ?").run(projectId);
        return { kind: "ignored" } as const;
      }

      this.sqlite.prepare("DELETE FROM github_pending_pushes WHERE project_id = ?").run(projectId);
      const deployment = this.githubDeployment(project, push);
      this.createDeployment(deployment);
      this.queueGithubStatus(
        deployment.id,
        "pending",
        "Deployment wird von Shelter gebaut",
        push
      );
      return { kind: "queued", deployment } as const;
    });
    const result = queue.immediate();
    if (result.kind === "queued") {
      this.addLog(result.deployment.id, "system", "Deployment wurde durch einen GitHub-Push in die Warteschlange gestellt.");
    }
    return result;
  }

  getPendingGithubPush(projectId: string): GithubPendingPushRow | undefined {
    return this.sqlite.prepare(
      "SELECT * FROM github_pending_pushes WHERE project_id = ?"
    ).get(projectId) as GithubPendingPushRow | undefined;
  }

  clearPendingGithubPush(projectId: string): void {
    this.sqlite.prepare("DELETE FROM github_pending_pushes WHERE project_id = ?").run(projectId);
  }

  clearPendingGithubPushIfSha(projectId: string, commitSha: string | null): boolean {
    if (!commitSha) return false;
    return this.sqlite.prepare(
      "DELETE FROM github_pending_pushes WHERE project_id = ? AND commit_sha = ?"
    ).run(projectId, commitSha).changes === 1;
  }

  hasPendingGithubPush(projectId: string, currentSha: string | null): boolean {
    const row = this.getPendingGithubPush(projectId);
    return Boolean(row && row.commit_sha !== currentSha);
  }

  hasPendingGithubWork(projectId: string, currentSha: string | null): boolean {
    const row = this.sqlite.prepare(`
      SELECT EXISTS (
        SELECT 1 FROM github_pending_pushes AS pending
        WHERE pending.project_id = projects.id
          AND (? IS NULL OR pending.commit_sha <> ?)
      ) OR EXISTS (
        SELECT 1 FROM github_dirty_refs AS dirty
        WHERE dirty.installation_id = projects.github_installation_id
          AND dirty.repository_id = projects.github_repository_id
          AND dirty.branch = projects.repository_branch
      ) AS superseded
      FROM projects
      WHERE projects.id = ?
        AND projects.github_repository_id IS NOT NULL
    `).get(currentSha, currentSha, projectId) as { superseded: 0 | 1 } | undefined;
    return row?.superseded === 1;
  }

  beginDeploymentActivation(
    deploymentId: string,
    projectId: string,
    currentSha: string | null
  ): "activation_started" | "superseded" | "invalid" {
    const begin = this.sqlite.transaction(() => {
      const deployment = this.sqlite.prepare(`
        SELECT status, cancel_requested_at FROM deployments WHERE id = ? AND project_id = ?
      `).get(deploymentId, projectId) as { status: DeploymentStatus; cancel_requested_at: string | null } | undefined;
      if (!deployment || deployment.status !== "checking" || deployment.cancel_requested_at) return "invalid" as const;

      if (this.hasPendingGithubWork(projectId, currentSha)) {
        this.sqlite.prepare(`
          UPDATE deployments
          SET status = 'cancelled', failure_kind = 'superseded',
              rollback_status = CASE WHEN rollback_deployment_id IS NULL THEN 'not_required' ELSE 'automatic_succeeded' END,
              error = ?, finished_at = ?
          WHERE id = ? AND project_id = ? AND status = 'checking'
        `).run(
          "Deployment wurde durch einen neueren GitHub-Push ersetzt",
          new Date().toISOString(),
          deploymentId,
          projectId
        );
        return "superseded" as const;
      }

      const updated = this.sqlite.prepare(`
        UPDATE deployments SET status = 'switching'
        WHERE id = ? AND project_id = ? AND status = 'checking'
      `).run(deploymentId, projectId);
      return updated.changes === 1 ? "activation_started" as const : "invalid" as const;
    });
    return begin.immediate();
  }

  activateDeploymentRuntime(
    deploymentId: string,
    projectId: string,
    expectedActiveDeploymentId: string | null
  ): boolean {
    const activate = this.sqlite.transaction(() => {
      const deployment = this.getDeployment(deploymentId);
      const project = this.getMutableProject(projectId);
      if (!deployment || deployment.project_id !== projectId || deployment.status !== "switching" || !project) return false;
      if (deployment.cancel_requested_at) return false;
      if ((project.active_deployment_id ?? null) !== expectedActiveDeploymentId) return false;
      const result = this.sqlite.prepare(`
        UPDATE projects
        SET active_deployment_id = ?, static_base_path = ?, updated_at = ?
        WHERE id = ? AND active_deployment_id IS ?
          AND NOT EXISTS (
            SELECT 1 FROM project_deletions WHERE project_deletions.project_id = projects.id
          )
      `).run(
        deploymentId,
        deployment.static_base_path,
        projectTimestampAfter(project.updated_at),
        projectId,
        expectedActiveDeploymentId
      );
      return result.changes === 1;
    });
    return activate.immediate();
  }

  completeDeploymentActivation(deploymentId: string, projectId: string, finishedAt: string): boolean {
    const complete = this.sqlite.transaction(() => {
      const project = this.getProject(projectId);
      if (project?.active_deployment_id !== deploymentId) return false;
      const result = this.sqlite.prepare(`
        UPDATE deployments
        SET status = 'ready', error = NULL, failure_kind = NULL,
            rollback_status = 'not_required', finished_at = ?
        WHERE id = ? AND project_id = ? AND status = 'switching' AND cancel_requested_at IS NULL
      `).run(finishedAt, deploymentId, projectId);
      return result.changes === 1;
    });
    return complete.immediate();
  }

  restoreProjectActiveDeployment(
    projectId: string,
    failedDeploymentId: string,
    previousDeploymentId: string | null,
    fallbackStaticBasePath: string | null
  ): boolean {
    const restore = this.sqlite.transaction(() => {
      const project = this.getProject(projectId);
      if (!project) return false;
      if (project.active_deployment_id === previousDeploymentId) return true;
      if (project.active_deployment_id !== failedDeploymentId) return false;
      const previous = previousDeploymentId ? this.getDeployment(previousDeploymentId) : undefined;
      const result = this.sqlite.prepare(`
        UPDATE projects
        SET active_deployment_id = ?, static_base_path = ?, updated_at = ?
        WHERE id = ? AND active_deployment_id = ?
      `).run(
        previousDeploymentId,
        previous?.static_base_path ?? fallbackStaticBasePath,
        projectTimestampAfter(project.updated_at),
        projectId,
        failedDeploymentId
      );
      return result.changes === 1;
    });
    return restore.immediate();
  }

  materializePendingGithubPush(projectId?: string): DeploymentRow | undefined {
    const materialize = this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        DELETE FROM github_pending_pushes
        WHERE NOT EXISTS (
          SELECT 1 FROM projects
          WHERE projects.id = github_pending_pushes.project_id
            AND projects.auto_deploy = 1
            AND projects.github_connection_error IS NULL
            AND projects.github_installation_id = github_pending_pushes.installation_id
            AND projects.github_repository_id = github_pending_pushes.repository_id
            AND projects.repository_branch = github_pending_pushes.branch
            AND NOT EXISTS (
              SELECT 1 FROM project_deletions WHERE project_deletions.project_id = projects.id
            )
        )
      `).run();
      const pending = this.sqlite.prepare(`
        SELECT pending.* FROM github_pending_pushes AS pending
        WHERE (? IS NULL OR pending.project_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM deployments
            WHERE deployments.project_id = pending.project_id
              AND deployments.status IN ('queued','preparing','building','checking','switching')
          )
        ORDER BY pending.received_at ASC
        LIMIT 1
      `).get(projectId ?? null, projectId ?? null) as GithubPendingPushRow | undefined;
      if (!pending) return undefined;
      const project = this.getMutableProject(pending.project_id);
      if (!project) {
        this.sqlite.prepare("DELETE FROM github_pending_pushes WHERE project_id = ?").run(pending.project_id);
        return undefined;
      }
      const latest = this.sqlite.prepare(`
        SELECT commit_sha, status FROM deployments
        WHERE project_id = ? ORDER BY created_at DESC LIMIT 1
      `).get(pending.project_id) as { commit_sha: string | null; status: string } | undefined;
      if (latest?.status === "ready" && latest.commit_sha === pending.commit_sha) {
        this.sqlite.prepare("DELETE FROM github_pending_pushes WHERE project_id = ?").run(pending.project_id);
        return undefined;
      }
      const push: GithubPushSnapshot = {
        deliveryId: pending.delivery_id,
        installationId: pending.installation_id,
        repositoryId: pending.repository_id,
        repositoryFullName: pending.repository_full_name,
        branch: pending.branch,
        commitSha: pending.commit_sha,
        commitMessage: pending.commit_message,
        commitAuthor: pending.commit_author,
        commitUrl: pending.commit_url,
        receivedAt: new Date().toISOString()
      };
      const deployment = this.githubDeployment(project, push);
      this.createDeployment(deployment);
      this.queueGithubStatus(
        deployment.id,
        "pending",
        "Deployment wird von Shelter gebaut",
        push
      );
      this.sqlite.prepare("DELETE FROM github_pending_pushes WHERE project_id = ?").run(pending.project_id);
      return deployment;
    });
    const deployment = materialize.immediate();
    if (deployment) {
      this.addLog(deployment.id, "system", "Der neueste GitHub-Push wurde aus der Warteschlange übernommen.");
    }
    return deployment;
  }

  disableGithubInstallation(installationId: string, error: string): number {
    const disable = this.sqlite.transaction(() => {
      const result = this.sqlite.prepare(`
        UPDATE projects
        SET github_connection_error = ?, updated_at = ?
        WHERE github_installation_id = ?
      `).run(error.slice(0, 1_000), new Date().toISOString(), installationId);
      this.sqlite.prepare(`
        DELETE FROM github_pending_pushes
        WHERE project_id IN (SELECT id FROM projects WHERE github_installation_id = ?)
      `).run(installationId);
      this.sqlite.prepare("DELETE FROM github_dirty_refs WHERE installation_id = ?").run(installationId);
      this.sqlite.prepare("DELETE FROM github_status_outbox WHERE installation_id = ?").run(installationId);
      return result.changes;
    });
    return disable.immediate();
  }

  disableGithubRepositories(installationId: string, repositoryIds: string[], error: string): number {
    if (repositoryIds.length === 0) return 0;
    const placeholders = repositoryIds.map(() => "?").join(", ");
    const disable = this.sqlite.transaction(() => {
      const params = [error.slice(0, 1_000), new Date().toISOString(), installationId, ...repositoryIds];
      const result = this.sqlite.prepare(`
        UPDATE projects
        SET github_connection_error = ?, updated_at = ?
        WHERE github_installation_id = ? AND github_repository_id IN (${placeholders})
      `).run(...params);
      this.sqlite.prepare(`
        DELETE FROM github_pending_pushes
        WHERE project_id IN (
          SELECT id FROM projects
          WHERE github_installation_id = ? AND github_repository_id IN (${placeholders})
        )
      `).run(installationId, ...repositoryIds);
      this.sqlite.prepare(`
        DELETE FROM github_dirty_refs
        WHERE installation_id = ? AND repository_id IN (${placeholders})
      `).run(installationId, ...repositoryIds);
      this.sqlite.prepare(`
        DELETE FROM github_status_outbox
        WHERE installation_id = ? AND repository_id IN (${placeholders})
      `).run(installationId, ...repositoryIds);
      return result.changes;
    });
    return disable.immediate();
  }

  enableGithubInstallation(installationId: string): number {
    return this.sqlite.prepare(`
      UPDATE projects SET github_connection_error = NULL, updated_at = ?
      WHERE github_installation_id = ? AND github_connection_error IS NOT NULL
    `).run(new Date().toISOString(), installationId).changes;
  }

  enableGithubRepositories(installationId: string, repositoryIds: string[]): number {
    if (repositoryIds.length === 0) return 0;
    const placeholders = repositoryIds.map(() => "?").join(", ");
    return this.sqlite.prepare(`
      UPDATE projects SET github_connection_error = NULL, updated_at = ?
      WHERE github_installation_id = ? AND github_repository_id IN (${placeholders})
    `).run(new Date().toISOString(), installationId, ...repositoryIds).changes;
  }

  queueGithubStatus(
    deploymentId: string,
    state: GithubStatusOutboxRow["desired_state"],
    description: string,
    snapshot?: Pick<GithubPushSnapshot,
      "installationId" | "repositoryId" | "repositoryFullName" | "commitSha"
    >
  ): boolean {
    const now = new Date().toISOString();
    const result = this.sqlite.prepare(`
      INSERT INTO github_status_outbox (
        deployment_id, installation_id, repository_id, repository_full_name, commit_sha,
        desired_state, description, delivered_state,
        attempts, next_attempt_at, last_error, updated_at
      )
      SELECT existing.deployment_id,
        existing.installation_id,
        existing.repository_id,
        existing.repository_full_name,
        existing.commit_sha,
        @desired_state, @description, NULL, 0, @now, NULL, @now
      FROM github_status_outbox AS existing
      WHERE existing.deployment_id = @deployment_id
      UNION ALL
      SELECT deployments.id,
        COALESCE(@installation_id, projects.github_installation_id),
        COALESCE(@repository_id, projects.github_repository_id),
        COALESCE(@repository_full_name, projects.github_repository_full_name),
        COALESCE(@commit_sha, deployments.commit_sha),
        @desired_state, @description, NULL, 0, @now, NULL, @now
      FROM deployments
      JOIN projects ON projects.id = deployments.project_id
      WHERE deployments.id = @deployment_id
        AND COALESCE(@installation_id, projects.github_installation_id) IS NOT NULL
        AND COALESCE(@repository_id, projects.github_repository_id) IS NOT NULL
        AND COALESCE(@repository_full_name, projects.github_repository_full_name) IS NOT NULL
        AND COALESCE(@commit_sha, deployments.commit_sha) IS NOT NULL
        AND (@installation_id IS NOT NULL OR projects.github_connection_error IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM github_status_outbox WHERE deployment_id = @deployment_id
        )
      ON CONFLICT(deployment_id) DO UPDATE SET
        desired_state = excluded.desired_state,
        description = excluded.description,
        delivered_state = CASE
          WHEN github_status_outbox.desired_state = excluded.desired_state
            THEN github_status_outbox.delivered_state
          ELSE NULL
        END,
        attempts = CASE
          WHEN github_status_outbox.desired_state = excluded.desired_state
            THEN github_status_outbox.attempts
          ELSE 0
        END,
        next_attempt_at = CASE
          WHEN github_status_outbox.desired_state = excluded.desired_state
            THEN github_status_outbox.next_attempt_at
          ELSE excluded.next_attempt_at
        END,
        last_error = CASE
          WHEN github_status_outbox.desired_state = excluded.desired_state
            THEN github_status_outbox.last_error
          ELSE NULL
        END,
        updated_at = excluded.updated_at
    `).run({
      deployment_id: deploymentId,
      installation_id: snapshot?.installationId ?? null,
      repository_id: snapshot?.repositoryId ?? null,
      repository_full_name: snapshot?.repositoryFullName ?? null,
      commit_sha: snapshot?.commitSha ?? null,
      desired_state: state,
      description: description.replaceAll(/[\r\n]+/g, " ").slice(0, 140) || "Shelter deployment",
      now
    });
    return result.changes > 0;
  }

  reconcileGithubStatusOutbox(): number {
    const snapshotSince = this.getSetting(GITHUB_STATUS_SNAPSHOT_SINCE_SETTING);
    if (!snapshotSince) return 0;
    const deployments = this.sqlite.prepare(`
      SELECT deployments.id, deployments.status
      FROM deployments
      LEFT JOIN github_status_outbox AS outbox ON outbox.deployment_id = deployments.id
      JOIN projects ON projects.id = deployments.project_id
      WHERE (
        outbox.deployment_id IS NOT NULL
        OR (
          deployments.created_at >= @snapshot_since
          AND deployments.commit_sha IS NOT NULL
          AND projects.github_installation_id IS NOT NULL
          AND projects.github_repository_id IS NOT NULL
          AND projects.github_repository_full_name IS NOT NULL
          AND projects.github_connection_error IS NULL
        )
      )
        AND deployments.status IN ('queued','preparing','building','checking','switching','ready','failed','cancelled')
    `).all({ snapshot_since: snapshotSince }) as Array<{ id: string; status: DeploymentStatus }>;
    let queued = 0;
    for (const deployment of deployments) {
      const terminal = deployment.status === "ready"
        ? { state: "success" as const, description: "Deployment ist bereit" }
        : deployment.status === "failed"
          ? { state: "failure" as const, description: "Deployment fehlgeschlagen" }
          : deployment.status === "cancelled"
            ? { state: "error" as const, description: "Deployment wurde abgebrochen oder ersetzt" }
            : { state: "pending" as const, description: "Deployment wird von Shelter gebaut" };
      if (this.queueGithubStatus(deployment.id, terminal.state, terminal.description)) queued += 1;
    }
    return queued;
  }

  listDueGithubStatuses(limit = 20, deploymentId?: string): GithubStatusOutboxRow[] {
    return this.sqlite.prepare(`
      SELECT outbox.* FROM github_status_outbox AS outbox
      WHERE outbox.delivered_state IS NULL
        AND outbox.next_attempt_at <= ?
        AND (? IS NULL OR outbox.deployment_id = ?)
        AND outbox.installation_id IS NOT NULL
        AND outbox.repository_id IS NOT NULL
        AND outbox.repository_full_name IS NOT NULL
        AND outbox.commit_sha IS NOT NULL
      ORDER BY outbox.next_attempt_at ASC
      LIMIT ?
    `).all(new Date().toISOString(), deploymentId ?? null, deploymentId ?? null, limit) as GithubStatusOutboxRow[];
  }

  completeGithubStatus(deploymentId: string, state: GithubStatusOutboxRow["desired_state"]): boolean {
    return this.sqlite.prepare(`
      UPDATE github_status_outbox
      SET delivered_state = desired_state, attempts = 0, last_error = NULL, updated_at = ?
      WHERE deployment_id = ? AND desired_state = ? AND delivered_state IS NULL
    `).run(new Date().toISOString(), deploymentId, state).changes === 1;
  }

  failGithubStatus(deploymentId: string, state: GithubStatusOutboxRow["desired_state"], errorCode: string): void {
    const current = this.sqlite.prepare(`
      SELECT attempts FROM github_status_outbox
      WHERE deployment_id = ? AND desired_state = ? AND delivered_state IS NULL
    `).get(deploymentId, state) as { attempts: number } | undefined;
    if (!current) return;
    const attempts = current.attempts + 1;
    const delaySeconds = Math.min(60 * 60, 5 * (2 ** Math.min(attempts - 1, 10)));
    this.sqlite.prepare(`
      UPDATE github_status_outbox
      SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE deployment_id = ? AND desired_state = ? AND delivered_state IS NULL
    `).run(
      attempts,
      new Date(Date.now() + delaySeconds * 1_000).toISOString(),
      errorCode.replaceAll(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100) || "GITHUB_STATUS_FAILED",
      new Date().toISOString(),
      deploymentId,
      state
    );
  }

  disconnectGithubProjects(): void {
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        UPDATE projects SET
          github_repository_id = NULL,
          github_repository_full_name = NULL,
          github_installation_id = NULL,
          auto_deploy = 0,
          github_connection_error = NULL,
          updated_at = ?
        WHERE github_repository_id IS NOT NULL OR github_installation_id IS NOT NULL
      `).run(new Date().toISOString());
      this.sqlite.prepare("DELETE FROM github_pending_pushes").run();
      this.sqlite.prepare("DELETE FROM github_dirty_refs").run();
      this.sqlite.prepare("DELETE FROM github_status_outbox").run();
    })();
  }

  private upsertPendingGithubPush(projectId: string, push: GithubPushSnapshot): void {
    this.sqlite.prepare(`
      INSERT INTO github_pending_pushes (
        project_id, delivery_id, installation_id, repository_id, repository_full_name,
        branch, commit_sha, commit_message, commit_author, commit_url, received_at
      ) VALUES (
        @project_id, @delivery_id, @installation_id, @repository_id, @repository_full_name,
        @branch, @commit_sha, @commit_message, @commit_author, @commit_url, @received_at
      )
      ON CONFLICT(project_id) DO UPDATE SET
        delivery_id = excluded.delivery_id,
        installation_id = excluded.installation_id,
        repository_id = excluded.repository_id,
        repository_full_name = excluded.repository_full_name,
        branch = excluded.branch,
        commit_sha = excluded.commit_sha,
        commit_message = excluded.commit_message,
        commit_author = excluded.commit_author,
        commit_url = excluded.commit_url,
        received_at = excluded.received_at
    `).run({
      project_id: projectId,
      delivery_id: push.deliveryId,
      installation_id: push.installationId,
      repository_id: push.repositoryId,
      repository_full_name: push.repositoryFullName,
      branch: push.branch,
      commit_sha: push.commitSha,
      commit_message: push.commitMessage,
      commit_author: push.commitAuthor,
      commit_url: push.commitUrl,
      received_at: push.receivedAt
    });
  }

  private githubDeployment(project: ProjectRow, push: GithubPushSnapshot): DeploymentRow {
    return {
      id: `dep_${randomUUID().replaceAll("-", "")}`,
      project_id: project.id,
      status: "queued",
      source_ref: push.branch,
      image_tag: null,
      previous_image_tag: null,
      internal_port: null,
      static_base_path: project.static_base_path,
      runtime_kind: null,
      runtime_description: null,
      commit_sha: push.commitSha,
      commit_message: push.commitMessage,
      commit_author: push.commitAuthor,
      commit_url: push.commitUrl,
      trigger: "github_push",
      github_delivery_id: push.deliveryId,
      error: null,
      started_at: null,
      finished_at: null,
      created_at: push.receivedAt
    };
  }

  listProjects(): ProjectRow[] {
    return this.sqlite.prepare(`
      SELECT projects.* FROM projects
      WHERE NOT EXISTS (
        SELECT 1 FROM project_deletions
        WHERE project_deletions.project_id = projects.id
          AND project_deletions.status IN ('preparing','queued','running')
      )
      ORDER BY projects.updated_at DESC
    `).all() as ProjectRow[];
  }

  listRoutableProjects(): ProjectRow[] {
    return this.sqlite.prepare(`
      SELECT projects.* FROM projects
      WHERE NOT EXISTS (
        SELECT 1 FROM project_deletions WHERE project_deletions.project_id = projects.id
      )
      ORDER BY projects.updated_at DESC
    `).all() as ProjectRow[];
  }

  getProject(id: string): ProjectRow | undefined {
    return this.sqlite.prepare(`
      SELECT projects.* FROM projects
      WHERE projects.id = ? AND NOT EXISTS (
        SELECT 1 FROM project_deletions
        WHERE project_deletions.project_id = projects.id
          AND project_deletions.status IN ('preparing','queued','running')
      )
    `).get(id) as ProjectRow | undefined;
  }

  getProjectForDeletion(id: string): ProjectRow | undefined {
    return this.sqlite.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  }

  getMutableProject(id: string): ProjectRow | undefined {
    return this.sqlite.prepare(`
      SELECT projects.* FROM projects
      WHERE projects.id = ? AND NOT EXISTS (
        SELECT 1 FROM project_deletions WHERE project_deletions.project_id = projects.id
      )
    `).get(id) as ProjectRow | undefined;
  }

  getProjectBySlug(slug: string): ProjectRow | undefined {
    return this.sqlite.prepare("SELECT * FROM projects WHERE slug = ?").get(slug) as ProjectRow | undefined;
  }

  createProject(project: ProjectRow): void {
    this.sqlite.prepare(`
      INSERT INTO projects (
        id, name, slug, source_type, repository_url, repository_branch, source_archive,
        static_base_path, root_directory, build_type, dockerfile_path, port, healthcheck_path,
        memory_limit, cpu_limit, github_repository_id, github_repository_full_name,
        github_installation_id, auto_deploy, github_connection_error, source_analysis_json,
        active_deployment_id, created_at, updated_at
      ) VALUES (
        @id, @name, @slug, @source_type, @repository_url, @repository_branch, @source_archive,
        @static_base_path, @root_directory, @build_type, @dockerfile_path, @port, @healthcheck_path,
        @memory_limit, @cpu_limit, @github_repository_id, @github_repository_full_name,
        @github_installation_id, @auto_deploy, @github_connection_error, @source_analysis_json,
        @active_deployment_id, @created_at, @updated_at
      )
    `).run({
      ...project,
      github_repository_id: project.github_repository_id ?? null,
      github_repository_full_name: project.github_repository_full_name ?? null,
      github_installation_id: project.github_installation_id ?? null,
      auto_deploy: project.auto_deploy ?? 0,
      github_connection_error: project.github_connection_error ?? null,
      source_analysis_json: project.source_analysis_json ?? null
    });
  }

  updateProject(id: string, updates: ProjectUpdates): ProjectRow | undefined {
    const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return this.getMutableProject(id);
    const assignments = entries.map(([key]) => `${key} = @${key}`).join(", ");
    const result = this.sqlite.prepare(`
      UPDATE projects SET ${assignments}, updated_at = @updated_at
      WHERE id = @id AND NOT EXISTS (
        SELECT 1 FROM project_deletions WHERE project_deletions.project_id = projects.id
      )
    `).run({
      id,
      ...updates,
      updated_at: new Date().toISOString()
    });
    return result.changes === 1 ? this.getMutableProject(id) : undefined;
  }

  updateProjectSourceAnalysis(id: string, sourceAnalysisJson: string): boolean {
    return this.sqlite.prepare(`
      UPDATE projects SET source_analysis_json = ?
      WHERE id = ? AND NOT EXISTS (
        SELECT 1 FROM project_deletions WHERE project_deletions.project_id = projects.id
      )
    `).run(sourceAnalysisJson, id).changes === 1;
  }

  updateProjectIfIdle(
    id: string,
    expectedUpdatedAt: string,
    updates: ProjectUpdates,
    options: { clearPendingGithubPush?: boolean } = {}
  ): IdleProjectUpdateResult {
    const update = this.sqlite.transaction((): IdleProjectUpdateResult => {
      const current = this.getMutableProject(id);
      if (!current || current.updated_at !== expectedUpdatedAt) return { kind: "conflict" };

      const activeDeployment = this.sqlite.prepare(`
        SELECT 1 FROM deployments
        WHERE project_id = ? AND status IN ('queued','preparing','building','checking','switching')
        LIMIT 1
      `).get(id);
      if (activeDeployment) return { kind: "deployment_active" };

      const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
      if (entries.length === 0) return { kind: "updated", project: current };
      const assignments = entries.map(([key]) => `${key} = @${key}`).join(", ");
      const result = this.sqlite.prepare(`
        UPDATE projects SET ${assignments}, updated_at = @updated_at
        WHERE id = @id
          AND updated_at = @expected_updated_at
          AND NOT EXISTS (
            SELECT 1 FROM project_deletions WHERE project_deletions.project_id = projects.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM deployments
            WHERE deployments.project_id = projects.id
              AND deployments.status IN ('queued','preparing','building','checking','switching')
          )
      `).run({
        id,
        ...updates,
        expected_updated_at: expectedUpdatedAt,
        updated_at: projectTimestampAfter(expectedUpdatedAt)
      });
      if (result.changes !== 1) {
        const becameActive = this.sqlite.prepare(`
          SELECT 1 FROM deployments
          WHERE project_id = ? AND status IN ('queued','preparing','building','checking','switching')
          LIMIT 1
        `).get(id);
        return becameActive ? { kind: "deployment_active" } : { kind: "conflict" };
      }

      if (options.clearPendingGithubPush) {
        this.sqlite.prepare("DELETE FROM github_pending_pushes WHERE project_id = ?").run(id);
      }
      const project = this.getMutableProject(id);
      return project ? { kind: "updated", project } : { kind: "conflict" };
    });
    return update.immediate();
  }

  deleteProject(id: string): void {
    this.sqlite.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  getProjectDeletion(projectId: string): ProjectDeletionRow | undefined {
    return this.sqlite.prepare("SELECT * FROM project_deletions WHERE project_id = ?").get(projectId) as ProjectDeletionRow | undefined;
  }

  prepareProjectDeletion(projectId: string, confirmation: string):
    | { kind: "started"; project: ProjectRow }
    | { kind: "pending"; status: "queued" | "running" }
    | { kind: "preparing" }
    | { kind: "deployment_active" }
    | { kind: "domain_pending" }
    | { kind: "confirmation_mismatch" }
    | { kind: "not_found" } {
    const prepare = this.sqlite.transaction(() => {
      const project = this.getProjectForDeletion(projectId);
      if (!project) return { kind: "not_found" } as const;
      if (confirmation !== project.name) return { kind: "confirmation_mismatch" } as const;

      const existing = this.getProjectDeletion(projectId);
      if (existing?.status === "queued" || existing?.status === "running") {
        return { kind: "pending", status: existing.status } as const;
      }
      if (existing?.status === "preparing") return { kind: "preparing" } as const;

      const pendingDomain = this.sqlite.prepare(`
        SELECT 1 FROM domains WHERE project_id = ? AND status = 'pending' LIMIT 1
      `).get(projectId);
      if (pendingDomain) return { kind: "domain_pending" } as const;

      const active = this.sqlite.prepare(`
        SELECT 1 FROM deployments
        WHERE project_id = ? AND status IN ('preparing','building','checking','switching')
        LIMIT 1
      `).get(projectId);
      if (active) return { kind: "deployment_active" } as const;

      const now = new Date().toISOString();
      this.sqlite.prepare(`
        UPDATE deployments
        SET status = 'cancelled', error = 'Deployment wegen Projektlöschung abgebrochen', finished_at = ?
        WHERE project_id = ? AND status = 'queued'
      `).run(now, projectId);
      this.sqlite.prepare(`
        INSERT INTO project_deletions (project_id, status, error, requested_at, updated_at)
        VALUES (?, 'preparing', NULL, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          status = 'preparing',
          error = NULL,
          requested_at = excluded.requested_at,
          updated_at = excluded.updated_at
      `).run(projectId, now, now);
      return { kind: "started", project } as const;
    });
    // Serialize against a worker claiming a queued deployment. Whichever side
    // obtains the write lock first determines whether it is cancelled or active.
    return prepare.immediate();
  }

  queueProjectDeletion(projectId: string): boolean {
    const result = this.sqlite.prepare(`
      UPDATE project_deletions SET status = 'queued', error = NULL, updated_at = ?
      WHERE project_id = ? AND status = 'preparing'
    `).run(new Date().toISOString(), projectId);
    return result.changes === 1;
  }

  failProjectDeletion(projectId: string, error: string): void {
    this.sqlite.prepare(`
      UPDATE project_deletions SET status = 'failed', error = ?, updated_at = ?
      WHERE project_id = ?
    `).run(error.slice(0, 4_096), new Date().toISOString(), projectId);
  }

  recoverPreparingProjectDeletions(): void {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      UPDATE project_deletions
      SET status = 'failed', error = 'Projektlöschung wurde durch einen API-Neustart unterbrochen', updated_at = ?
      WHERE status = 'preparing'
    `).run(now);
  }

  requeueRunningProjectDeletions(): void {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      UPDATE project_deletions SET status = 'queued', error = NULL, updated_at = ?
      WHERE status = 'running'
    `).run(now);
  }

  claimNextProjectDeletion(): ProjectDeletionRow | undefined {
    const claim = this.sqlite.transaction(() => {
      const next = this.sqlite.prepare(`
        SELECT * FROM project_deletions WHERE status = 'queued' ORDER BY requested_at ASC LIMIT 1
      `).get() as ProjectDeletionRow | undefined;
      if (!next) return undefined;
      const now = new Date().toISOString();
      const result = this.sqlite.prepare(`
        UPDATE project_deletions SET status = 'running', error = NULL, updated_at = ?
        WHERE project_id = ? AND status = 'queued'
      `).run(now, next.project_id);
      return result.changes === 1 ? this.getProjectDeletion(next.project_id) : undefined;
    });
    return claim.immediate();
  }

  listDomains(projectId?: string): DomainRow[] {
    if (projectId) {
      return this.sqlite.prepare("SELECT * FROM domains WHERE project_id = ? ORDER BY hostname").all(projectId) as DomainRow[];
    }
    return this.sqlite.prepare("SELECT * FROM domains ORDER BY hostname").all() as DomainRow[];
  }

  getDomain(id: string): DomainRow | undefined {
    return this.sqlite.prepare("SELECT * FROM domains WHERE id = ?").get(id) as DomainRow | undefined;
  }

  createDomain(domain: DomainRow): void {
    this.sqlite.prepare(`
      INSERT INTO domains (id, project_id, hostname, zone_id, dns_record_id, status, error, created_at)
      VALUES (@id, @project_id, @hostname, @zone_id, @dns_record_id, @status, @error, @created_at)
    `).run(domain);
  }

  createOrRetryPendingDomain(domain: DomainRow):
    | { kind: "created" | "retry"; domain: DomainRow }
    | { kind: "project_unavailable" }
    | { kind: "domain_exists" } {
    const create = this.sqlite.transaction(() => {
      if (!this.getMutableProject(domain.project_id)) return { kind: "project_unavailable" } as const;
      const existing = this.sqlite.prepare(
        "SELECT * FROM domains WHERE hostname = ? COLLATE NOCASE"
      ).get(domain.hostname) as DomainRow | undefined;
      if (existing) {
        if (existing.project_id !== domain.project_id || existing.status !== "error") {
          return { kind: "domain_exists" } as const;
        }
        this.sqlite.prepare(`
          UPDATE domains
          SET zone_id = ?, dns_record_id = NULL, status = 'pending', error = NULL
          WHERE id = ? AND status = 'error'
        `).run(domain.zone_id ?? existing.zone_id, existing.id);
        return { kind: "retry", domain: this.getDomain(existing.id) as DomainRow } as const;
      }
      this.createDomain(domain);
      return { kind: "created", domain } as const;
    });
    return create.immediate();
  }

  activatePendingDomain(
    id: string,
    projectId: string,
    updates: Pick<DomainRow, "zone_id" | "dns_record_id">
  ): boolean {
    const activate = this.sqlite.transaction(() => {
      const result = this.sqlite.prepare(`
        UPDATE domains
        SET zone_id = @zone_id, dns_record_id = @dns_record_id, status = 'active', error = NULL
        WHERE id = @id AND project_id = @project_id AND status = 'pending'
          AND EXISTS (
            SELECT 1 FROM projects
            WHERE projects.id = @project_id AND NOT EXISTS (
              SELECT 1 FROM project_deletions WHERE project_deletions.project_id = projects.id
            )
          )
      `).run({ id, project_id: projectId, ...updates });
      return result.changes === 1;
    });
    return activate.immediate();
  }

  failPendingDomain(
    id: string,
    error: string,
    dns?: Pick<DomainRow, "zone_id" | "dns_record_id">
  ): void {
    this.sqlite.prepare(`
      UPDATE domains
      SET status = 'error', error = @error,
          zone_id = COALESCE(@zone_id, zone_id),
          dns_record_id = COALESCE(@dns_record_id, dns_record_id)
      WHERE id = @id AND status = 'pending'
    `).run({
      id,
      error: error.slice(0, 4_096),
      zone_id: dns?.zone_id ?? null,
      dns_record_id: dns?.dns_record_id ?? null
    });
  }

  recoverPendingDomains(): void {
    this.sqlite.prepare(`
      UPDATE domains
      SET status = 'error', error = 'Domain-Einrichtung wurde durch einen API-Neustart unterbrochen'
      WHERE status = 'pending'
    `).run();
  }

  claimDomainDeletion(projectId: string, domainId: string):
    | { kind: "claimed"; domain: DomainRow }
    | { kind: "project_unavailable" }
    | { kind: "not_found" }
    | { kind: "domain_pending" } {
    const claim = this.sqlite.transaction(() => {
      if (!this.getMutableProject(projectId)) return { kind: "project_unavailable" } as const;
      const domain = this.getDomain(domainId);
      if (!domain || domain.project_id !== projectId) return { kind: "not_found" } as const;
      if (domain.status === "pending") return { kind: "domain_pending" } as const;
      const result = this.sqlite.prepare(`
        UPDATE domains SET status = 'pending', error = NULL
        WHERE id = ? AND project_id = ? AND status <> 'pending'
      `).run(domainId, projectId);
      if (result.changes !== 1) return { kind: "domain_pending" } as const;
      return { kind: "claimed", domain } as const;
    });
    return claim.immediate();
  }

  updateDomain(id: string, updates: Pick<DomainRow, "zone_id" | "dns_record_id" | "status" | "error">): void {
    this.sqlite.prepare(`
      UPDATE domains SET zone_id = @zone_id, dns_record_id = @dns_record_id, status = @status, error = @error WHERE id = @id
    `).run({ id, ...updates });
  }

  deleteDomain(id: string): void {
    this.sqlite.prepare("DELETE FROM domains WHERE id = ?").run(id);
  }

  createDeployment(deployment: DeploymentRow): void {
    this.sqlite.prepare(`
      INSERT INTO deployments (
        id, project_id, status, source_ref, image_tag, previous_image_tag, internal_port, static_base_path,
        runtime_kind, runtime_description, runtime_container, failure_kind, rollback_status,
        rollback_deployment_id, cancel_requested_at, commit_sha, commit_message, commit_author, commit_url,
        trigger, github_delivery_id, error, started_at, finished_at, created_at
      ) VALUES (
        @id, @project_id, @status, @source_ref, @image_tag, @previous_image_tag, @internal_port, @static_base_path,
        @runtime_kind, @runtime_description, @runtime_container, @failure_kind, @rollback_status,
        @rollback_deployment_id, @cancel_requested_at, @commit_sha, @commit_message, @commit_author, @commit_url,
        @trigger, @github_delivery_id, @error, @started_at, @finished_at, @created_at
      )
    `).run(this.deploymentBindings(deployment));
  }

  createDeploymentForMutableProject(deployment: DeploymentRow, expectedProjectUpdatedAt: string): boolean {
    const result = this.sqlite.prepare(`
      INSERT INTO deployments (
        id, project_id, status, source_ref, image_tag, previous_image_tag, internal_port, static_base_path,
        runtime_kind, runtime_description, runtime_container, failure_kind, rollback_status,
        rollback_deployment_id, cancel_requested_at, commit_sha, commit_message, commit_author, commit_url,
        trigger, github_delivery_id, error, started_at, finished_at, created_at
      )
      SELECT
        @id, @project_id, @status, @source_ref, @image_tag, @previous_image_tag, @internal_port, @static_base_path,
        @runtime_kind, @runtime_description, @runtime_container, @failure_kind, @rollback_status,
        @rollback_deployment_id, @cancel_requested_at, @commit_sha, @commit_message, @commit_author, @commit_url,
        @trigger, @github_delivery_id, @error, @started_at, @finished_at, @created_at
      WHERE EXISTS (
        SELECT 1 FROM projects
        WHERE projects.id = @project_id
          AND projects.updated_at = @expected_project_updated_at
          AND NOT EXISTS (
          SELECT 1 FROM project_deletions WHERE project_deletions.project_id = projects.id
        )
      )
    `).run({
      ...this.deploymentBindings(deployment),
      expected_project_updated_at: expectedProjectUpdatedAt
    });
    return result.changes === 1;
  }

  private deploymentBindings(deployment: DeploymentRow): Record<string, unknown> {
    return {
      ...deployment,
      runtime_kind: deployment.runtime_kind ?? null,
      runtime_description: deployment.runtime_description ?? null,
      runtime_container: deployment.runtime_container ?? null,
      failure_kind: deployment.failure_kind ?? null,
      rollback_status: deployment.rollback_status ?? "not_required",
      rollback_deployment_id: deployment.rollback_deployment_id ?? null,
      cancel_requested_at: deployment.cancel_requested_at ?? null,
      commit_message: deployment.commit_message ?? null,
      commit_author: deployment.commit_author ?? null,
      commit_url: deployment.commit_url ?? null,
      trigger: deployment.trigger ?? "manual",
      github_delivery_id: deployment.github_delivery_id ?? null
    };
  }

  getDeployment(id: string): DeploymentRow | undefined {
    return this.sqlite.prepare("SELECT * FROM deployments WHERE id = ?").get(id) as DeploymentRow | undefined;
  }

  requestDeploymentCancellation(id: string):
    | { kind: "not_found" }
    | { kind: "terminal"; deployment: DeploymentRow }
    | { kind: "activating"; deployment: DeploymentRow }
    | { kind: "already_cancelled"; deployment: DeploymentRow }
    | { kind: "requested"; deployment: DeploymentRow } {
    const requestCancellation = this.sqlite.transaction(() => {
      const deployment = this.getDeployment(id);
      if (!deployment) return { kind: "not_found" } as const;
      if (deployment.status === "cancelled") return { kind: "already_cancelled", deployment } as const;
      if (deployment.status === "ready" || deployment.status === "failed") {
        return { kind: "terminal", deployment } as const;
      }
      if (deployment.status === "switching") return { kind: "activating", deployment } as const;
      if (deployment.cancel_requested_at) return { kind: "requested", deployment } as const;

      const now = new Date().toISOString();
      if (deployment.status === "queued") {
        this.sqlite.prepare(`
          UPDATE deployments
          SET status = 'cancelled', failure_kind = 'cancelled', cancel_requested_at = ?,
              error = 'Deployment wurde vom Benutzer abgebrochen', finished_at = ?
          WHERE id = ? AND status = 'queued'
        `).run(now, now, id);
      } else {
        this.sqlite.prepare(`
          UPDATE deployments
          SET failure_kind = 'cancelled', cancel_requested_at = ?,
              error = 'Abbruch angefordert; laufende Prozesse werden beendet'
          WHERE id = ? AND status IN ('preparing','building','checking','switching')
        `).run(now, id);
      }
      return { kind: "requested", deployment: this.getDeployment(id)! } as const;
    });
    return requestCancellation.immediate();
  }

  deploymentCancellationRequested(id: string): boolean {
    const row = this.sqlite.prepare(`
      SELECT 1 FROM deployments WHERE id = ? AND (cancel_requested_at IS NOT NULL OR status = 'cancelled')
    `).get(id);
    return Boolean(row);
  }

  finalizeDeploymentCancellation(
    id: string,
    rollbackStatus: "not_required" | "automatic_succeeded" | "automatic_failed" = "not_required",
    rollbackDeploymentId: string | null = null
  ): DeploymentRow | undefined {
    this.sqlite.prepare(`
      UPDATE deployments
      SET status = 'cancelled', failure_kind = 'cancelled', rollback_status = ?,
          rollback_deployment_id = ?, error = 'Deployment wurde vom Benutzer abgebrochen', finished_at = ?
      WHERE id = ? AND status IN ('preparing','building','checking','switching','cancelled')
    `).run(rollbackStatus, rollbackDeploymentId, new Date().toISOString(), id);
    return this.getDeployment(id);
  }

  failDeploymentIfActive(
    id: string,
    failureKind: NonNullable<DeploymentRow["failure_kind"]>,
    error: string,
    finishedAt: string
  ): DeploymentRow | undefined {
    const result = this.sqlite.prepare(`
      UPDATE deployments
      SET status = 'failed', failure_kind = ?, error = ?, finished_at = ?
      WHERE id = ?
        AND status IN ('preparing','building','checking','switching')
        AND cancel_requested_at IS NULL
    `).run(failureKind, error, finishedAt, id);
    return result.changes === 1 ? this.getDeployment(id) : undefined;
  }

  queueRollbackDeployment(targetDeploymentId: string, expectedProjectId?: string):
    | { kind: "queued"; deployment: DeploymentRow }
    | { kind: "invalid_target" }
    | { kind: "project_unavailable" }
    | { kind: "deployment_active" } {
    const queue = this.sqlite.transaction(() => {
      const target = this.getDeployment(targetDeploymentId);
      if (
        !target || target.status !== "ready" || !target.image_tag || !target.internal_port ||
        (expectedProjectId !== undefined && target.project_id !== expectedProjectId)
      ) return { kind: "invalid_target" } as const;
      const project = this.getMutableProject(target.project_id);
      if (!project) return { kind: "project_unavailable" } as const;
      const active = this.sqlite.prepare(`
        SELECT 1 FROM deployments
        WHERE project_id = ? AND status IN ('queued','preparing','building','checking','switching')
        LIMIT 1
      `).get(project.id);
      if (active) return { kind: "deployment_active" } as const;

      const deployment: DeploymentRow = {
        id: `dep_${randomUUID().replaceAll("-", "")}`,
        project_id: project.id,
        status: "queued",
        source_ref: `rollback:${target.id}`,
        image_tag: null,
        previous_image_tag: null,
        internal_port: null,
        static_base_path: project.static_base_path,
        runtime_kind: null,
        runtime_description: null,
        rollback_deployment_id: project.active_deployment_id,
        commit_sha: null,
        error: null,
        started_at: null,
        finished_at: null,
        created_at: new Date().toISOString(),
        trigger: "rollback"
      };
      this.createDeployment(deployment);
      this.addLog(deployment.id, "system", "Rollback wurde in die Warteschlange gestellt.");
      return { kind: "queued", deployment: this.getDeployment(deployment.id)! } as const;
    });
    return queue.immediate();
  }

  nextQueuedDeployment(): DeploymentRow | undefined {
    return this.sqlite.prepare(`
      SELECT deployments.* FROM deployments
      WHERE deployments.status = 'queued' AND NOT EXISTS (
        SELECT 1 FROM project_deletions WHERE project_deletions.project_id = deployments.project_id
      )
      ORDER BY deployments.created_at ASC LIMIT 1
    `).get() as DeploymentRow | undefined;
  }

  claimNextQueuedDeployment(): DeploymentRow | undefined {
    const claim = this.sqlite.transaction(() => {
      const next = this.nextQueuedDeployment();
      if (!next) return undefined;
      const result = this.sqlite.prepare(`
        UPDATE deployments SET status = 'preparing', started_at = ? WHERE id = ? AND status = 'queued'
      `).run(new Date().toISOString(), next.id);
      return result.changes === 1 ? this.getDeployment(next.id) : undefined;
    });
    return claim.immediate();
  }

  listDeployments(projectId: string, limit = 20): DeploymentRow[] {
    return this.sqlite.prepare("SELECT * FROM deployments WHERE project_id = ? ORDER BY created_at DESC LIMIT ?").all(projectId, limit) as DeploymentRow[];
  }

  findDeploymentBySourceSnapshot(
    projectId: string,
    sourceRef: string,
    staticBasePath: string | null
  ): DeploymentRow | undefined {
    return this.sqlite.prepare(`
      SELECT * FROM deployments
      WHERE project_id = ? AND source_ref = ? AND static_base_path IS ?
      ORDER BY created_at DESC LIMIT 1
    `).get(projectId, sourceRef, staticBasePath) as DeploymentRow | undefined;
  }

  listReadyDeployments(projectId: string, limit = 3): DeploymentRow[] {
    return this.sqlite.prepare("SELECT * FROM deployments WHERE project_id = ? AND status = 'ready' ORDER BY created_at DESC LIMIT ?").all(projectId, limit) as DeploymentRow[];
  }

  listRollbackLeasedImages(projectId: string): string[] {
    const rows = this.sqlite.prepare(`
      SELECT DISTINCT target.image_tag AS image_tag
      FROM deployments AS queued
      JOIN deployments AS target
        ON queued.source_ref = 'rollback:' || target.id
       AND target.project_id = queued.project_id
      WHERE queued.project_id = ?
        AND queued.status IN ('queued','preparing','building','checking','switching')
        AND target.image_tag IS NOT NULL
    `).all(projectId) as Array<{ image_tag: string }>;
    return rows.map((row) => row.image_tag);
  }

  listInterruptedDeployments(): DeploymentRow[] {
    return this.sqlite.prepare(`
      SELECT * FROM deployments WHERE status IN ('preparing','building','checking','switching') ORDER BY created_at ASC
    `).all() as DeploymentRow[];
  }

  updateDeployment(id: string, updates: Partial<Omit<DeploymentRow, "id" | "project_id" | "created_at">>): DeploymentRow | undefined {
    const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return this.getDeployment(id);
    const assignments = entries.map(([key]) => `${key} = @${key}`).join(", ");
    this.sqlite.prepare(`UPDATE deployments SET ${assignments} WHERE id = @id`).run({ id, ...updates });
    return this.getDeployment(id);
  }

  addLog(deploymentId: string, stream: DeploymentLogRow["stream"], message: string): void {
    const statement = this.sqlite.prepare(`
      INSERT INTO deployment_logs (deployment_id, stream, message, created_at) VALUES (?, ?, ?, ?)
    `);
    const timestamp = new Date().toISOString();
    let inserted = 0;
    for (const line of message.replaceAll("\r\n", "\n").split("\n")) {
      if (line.length > 0) {
        statement.run(deploymentId, stream, line.slice(0, 4_096), timestamp);
        inserted += 1;
      }
    }
    const pending = (this.logWritesSincePrune.get(deploymentId) ?? 0) + inserted;
    if (pending >= 100) {
      this.sqlite.prepare(`
        DELETE FROM deployment_logs
        WHERE deployment_id = ? AND id NOT IN (
          SELECT id FROM deployment_logs WHERE deployment_id = ? ORDER BY id DESC LIMIT 5000
        )
      `).run(deploymentId, deploymentId);
      this.logWritesSincePrune.set(deploymentId, 0);
    } else if (inserted > 0) {
      this.logWritesSincePrune.set(deploymentId, pending);
    }
  }

  pruneDeploymentLogs(projectId: string, keepDeployments = 20): void {
    this.sqlite.prepare(`
      DELETE FROM deployment_logs
      WHERE deployment_id IN (
        SELECT id FROM deployments
        WHERE project_id = ?
        ORDER BY created_at DESC
        LIMIT -1 OFFSET ?
      )
    `).run(projectId, keepDeployments);
  }

  listLogs(deploymentId: string, after = 0, limit = 1000): DeploymentLogRow[] {
    return this.sqlite.prepare(`
      SELECT * FROM deployment_logs WHERE deployment_id = ? AND id > ? ORDER BY id ASC LIMIT ?
    `).all(deploymentId, after, limit) as DeploymentLogRow[];
  }

  listEnvironment(projectId: string): EnvironmentVariableRow[] {
    return this.sqlite.prepare("SELECT * FROM environment_variables WHERE project_id = ? ORDER BY key").all(projectId) as EnvironmentVariableRow[];
  }

  replaceEnvironment(projectId: string, variables: EnvironmentVariableRow[]): void {
    this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM environment_variables WHERE project_id = ?").run(projectId);
      const insert = this.sqlite.prepare(`
        INSERT INTO environment_variables (id, project_id, key, encrypted_value, created_at, updated_at)
        VALUES (@id, @project_id, @key, @encrypted_value, @created_at, @updated_at)
      `);
      for (const variable of variables) insert.run(variable);
    })();
  }

  replaceEnvironmentForMutableProject(projectId: string, variables: EnvironmentVariableRow[]): boolean {
    const replace = this.sqlite.transaction(() => {
      if (!this.getMutableProject(projectId)) return false;
      this.sqlite.prepare("DELETE FROM environment_variables WHERE project_id = ?").run(projectId);
      const insert = this.sqlite.prepare(`
        INSERT INTO environment_variables (id, project_id, key, encrypted_value, created_at, updated_at)
        VALUES (@id, @project_id, @key, @encrypted_value, @created_at, @updated_at)
      `);
      for (const variable of variables) insert.run(variable);
      return true;
    });
    return replace.immediate();
  }

  insertServerMetricSample(sample: ServerMetricSampleRow): void {
    this.sqlite.prepare(`
      INSERT OR REPLACE INTO server_metric_samples (
        sampled_at,
        host_name, host_operating_system, host_kernel, host_architecture, host_uptime_seconds,
        cpu_usage_percent, cpu_logical_cores, load_one, load_five, load_fifteen,
        memory_total_bytes, memory_used_bytes, memory_available_bytes, memory_usage_percent,
        swap_total_bytes, swap_used_bytes,
        storage_total_bytes, storage_used_bytes, storage_available_bytes, storage_usage_percent,
        docker_available, docker_version, managed_containers, running_managed_containers,
        application_cpu_usage_percent, application_memory_used_bytes, application_memory_limit_bytes,
        application_network_received_bytes, application_network_transmitted_bytes,
        application_network_receive_bytes_per_second, application_network_transmit_bytes_per_second,
        application_block_read_bytes, application_block_write_bytes,
        service_api, service_worker, service_traefik, service_cloudflared,
        last_storage_maintenance_at, tunnel_configured
      ) VALUES (
        @sampled_at,
        @host_name, @host_operating_system, @host_kernel, @host_architecture, @host_uptime_seconds,
        @cpu_usage_percent, @cpu_logical_cores, @load_one, @load_five, @load_fifteen,
        @memory_total_bytes, @memory_used_bytes, @memory_available_bytes, @memory_usage_percent,
        @swap_total_bytes, @swap_used_bytes,
        @storage_total_bytes, @storage_used_bytes, @storage_available_bytes, @storage_usage_percent,
        @docker_available, @docker_version, @managed_containers, @running_managed_containers,
        @application_cpu_usage_percent, @application_memory_used_bytes, @application_memory_limit_bytes,
        @application_network_received_bytes, @application_network_transmitted_bytes,
        @application_network_receive_bytes_per_second, @application_network_transmit_bytes_per_second,
        @application_block_read_bytes, @application_block_write_bytes,
        @service_api, @service_worker, @service_traefik, @service_cloudflared,
        @last_storage_maintenance_at, @tunnel_configured
      )
    `).run(sample);
  }

  latestServerMetricSample(): ServerMetricSampleRow | undefined {
    return this.sqlite.prepare(`
      SELECT * FROM server_metric_samples ORDER BY sampled_at DESC LIMIT 1
    `).get() as ServerMetricSampleRow | undefined;
  }

  listRecentServerMetricSamples(limit = 3): ServerMetricSampleRow[] {
    const boundedLimit = Math.max(1, Math.min(10, Math.trunc(limit)));
    return this.sqlite.prepare(`
      SELECT * FROM server_metric_samples ORDER BY sampled_at DESC LIMIT ?
    `).all(boundedLimit) as ServerMetricSampleRow[];
  }

  listServerMetricHistory(from: number, to: number, maxPoints = 180): ServerMetricHistoryRow[] {
    const boundedPoints = Math.max(1, Math.min(180, Math.trunc(maxPoints)));
    const span = Math.max(1, Math.trunc(to) - Math.trunc(from));
    const bucketSize = Math.max(1, Math.ceil(span / boundedPoints));
    const bucketOrigin = Math.trunc(from) + 1;
    return this.sqlite.prepare(`
      WITH bucketed AS (
        SELECT
          CAST((sampled_at - @bucket_origin) / @bucket_size AS INTEGER) AS bucket,
          sampled_at,
          cpu_usage_percent,
          memory_usage_percent,
          storage_usage_percent,
          load_one,
          application_network_receive_bytes_per_second,
          application_network_transmit_bytes_per_second
        FROM server_metric_samples
        WHERE sampled_at > @from AND sampled_at <= @to
      )
      SELECT
        MAX(sampled_at) AS sampled_at,
        AVG(cpu_usage_percent) AS cpu_usage_percent,
        AVG(memory_usage_percent) AS memory_usage_percent,
        AVG(storage_usage_percent) AS storage_usage_percent,
        AVG(load_one) AS load_one,
        AVG(application_network_receive_bytes_per_second) AS application_network_receive_bytes_per_second,
        AVG(application_network_transmit_bytes_per_second) AS application_network_transmit_bytes_per_second
      FROM bucketed
      GROUP BY bucket
      ORDER BY bucket ASC
      LIMIT @max_points
    `).all({
      bucket_origin: bucketOrigin,
      bucket_size: bucketSize,
      from: Math.trunc(from),
      to: Math.trunc(to),
      max_points: boundedPoints
    }) as ServerMetricHistoryRow[];
  }

  pruneServerMetricSamples(cutoff: number, hardLimit = 100_000): void {
    const boundedLimit = Math.max(1, Math.min(500_000, Math.trunc(hardLimit)));
    this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM server_metric_samples WHERE sampled_at < ?").run(Math.trunc(cutoff));
      this.sqlite.prepare(`
        DELETE FROM server_metric_samples
        WHERE sampled_at NOT IN (
          SELECT sampled_at FROM server_metric_samples ORDER BY sampled_at DESC LIMIT ?
        )
      `).run(boundedLimit);
    })();
  }

  insertProjectMetricSample(sample: ProjectMetricSampleRow): void {
    this.sqlite.prepare(`
      INSERT OR REPLACE INTO project_metric_samples (
        project_id, deployment_id, sampled_at, runtime_status, health_status,
        started_at, uptime_seconds, restart_count, oom_killed,
        cpu_usage_percent, cpu_limit_cores,
        memory_used_bytes, memory_limit_bytes, memory_usage_percent,
        network_received_bytes, network_transmitted_bytes,
        network_receive_bytes_per_second, network_transmit_bytes_per_second,
        block_read_bytes, block_write_bytes
      ) VALUES (
        @project_id, @deployment_id, @sampled_at, @runtime_status, @health_status,
        @started_at, @uptime_seconds, @restart_count, @oom_killed,
        @cpu_usage_percent, @cpu_limit_cores,
        @memory_used_bytes, @memory_limit_bytes, @memory_usage_percent,
        @network_received_bytes, @network_transmitted_bytes,
        @network_receive_bytes_per_second, @network_transmit_bytes_per_second,
        @block_read_bytes, @block_write_bytes
      )
    `).run(sample);
  }

  latestProjectMetricSample(projectId: string): ProjectMetricSampleRow | undefined {
    return this.sqlite.prepare(`
      SELECT * FROM project_metric_samples WHERE project_id = ? ORDER BY sampled_at DESC LIMIT 1
    `).get(projectId) as ProjectMetricSampleRow | undefined;
  }

  listProjectMetricHistory(
    projectId: string,
    from: number,
    to: number,
    maxPoints = 180
  ): ProjectMetricHistoryRow[] {
    const boundedPoints = Math.max(1, Math.min(180, Math.trunc(maxPoints)));
    const span = Math.max(1, Math.trunc(to) - Math.trunc(from));
    const bucketSize = Math.max(1, Math.ceil(span / boundedPoints));
    const bucketOrigin = Math.trunc(from) + 1;
    return this.sqlite.prepare(`
      WITH bucketed AS (
        SELECT
          CAST((sampled_at - @bucket_origin) / @bucket_size AS INTEGER) AS bucket,
          sampled_at,
          cpu_usage_percent,
          memory_used_bytes,
          memory_limit_bytes,
          memory_usage_percent,
          network_receive_bytes_per_second,
          network_transmit_bytes_per_second,
          block_read_bytes,
          block_write_bytes
        FROM project_metric_samples
        WHERE project_id = @project_id AND sampled_at > @from AND sampled_at <= @to
      )
      SELECT
        MAX(sampled_at) AS sampled_at,
        AVG(cpu_usage_percent) AS cpu_usage_percent,
        AVG(memory_used_bytes) AS memory_used_bytes,
        AVG(memory_limit_bytes) AS memory_limit_bytes,
        AVG(memory_usage_percent) AS memory_usage_percent,
        AVG(network_receive_bytes_per_second) AS network_receive_bytes_per_second,
        AVG(network_transmit_bytes_per_second) AS network_transmit_bytes_per_second,
        MAX(block_read_bytes) AS block_read_bytes,
        MAX(block_write_bytes) AS block_write_bytes
      FROM bucketed
      GROUP BY bucket
      ORDER BY bucket ASC
      LIMIT @max_points
    `).all({
      project_id: projectId,
      bucket_origin: bucketOrigin,
      bucket_size: bucketSize,
      from: Math.trunc(from),
      to: Math.trunc(to),
      max_points: boundedPoints
    }) as ProjectMetricHistoryRow[];
  }

  insertRuntimeLogs(rows: Array<Omit<RuntimeLogRow, "id">>, maxLinesPerProject = 5_000): number {
    if (rows.length === 0) return 0;
    const boundedRows = rows.slice(0, 500);
    const boundedLimit = Math.max(100, Math.min(50_000, Math.trunc(maxLinesPerProject)));
    const insert = this.sqlite.prepare(`
      INSERT OR IGNORE INTO runtime_logs (
        project_id, deployment_id, stream, message, source_timestamp, collected_at
      ) VALUES (
        @project_id, @deployment_id, @stream, @message, @source_timestamp, @collected_at
      )
    `);
    const enforceLimit = this.sqlite.prepare(`
      DELETE FROM runtime_logs
      WHERE project_id = @project_id
        AND id < COALESCE((
          SELECT id FROM runtime_logs
          WHERE project_id = @project_id
          ORDER BY id DESC
          LIMIT 1 OFFSET @last_retained_offset
        ), -1)
    `);
    const persist = this.sqlite.transaction((entries: Array<Omit<RuntimeLogRow, "id">>) => {
      let inserted = 0;
      const projectIds = new Set<string>();
      for (const row of entries) {
        inserted += insert.run(row).changes;
        projectIds.add(row.project_id);
      }
      for (const projectId of projectIds) {
        enforceLimit.run({ project_id: projectId, last_retained_offset: boundedLimit - 1 });
      }
      return inserted;
    });
    return persist.immediate(boundedRows);
  }

  pruneRuntimeLogsForProject(projectId: string, maxLines = 5_000): void {
    const boundedLimit = Math.max(100, Math.min(50_000, Math.trunc(maxLines)));
    this.sqlite.prepare(`
      DELETE FROM runtime_logs
      WHERE project_id = @project_id
        AND id < COALESCE((
          SELECT id FROM runtime_logs
          WHERE project_id = @project_id
          ORDER BY id DESC
          LIMIT 1 OFFSET @last_retained_offset
        ), -1)
    `).run({ project_id: projectId, last_retained_offset: boundedLimit - 1 });
  }

  latestRuntimeLogTimestamp(deploymentId: string): string | undefined {
    const row = this.sqlite.prepare(`
      SELECT source_timestamp FROM runtime_logs
      WHERE deployment_id = ?
      ORDER BY source_timestamp DESC, id DESC LIMIT 1
    `).get(deploymentId) as { source_timestamp: string } | undefined;
    return row?.source_timestamp;
  }

  listRuntimeLogs(projectId: string, deploymentId: string, after = 0, limit = 500): RuntimeLogRow[] {
    const boundedAfter = Math.max(0, Math.trunc(after));
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.sqlite.prepare(`
      SELECT * FROM runtime_logs
      WHERE project_id = ? AND deployment_id = ? AND id > ?
      ORDER BY id ASC LIMIT ?
    `).all(projectId, deploymentId, boundedAfter, boundedLimit) as RuntimeLogRow[];
  }

  latestRuntimeLogs(projectId: string, deploymentId: string, limit = 500): RuntimeLogRow[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.sqlite.prepare(`
      SELECT * FROM (
        SELECT * FROM runtime_logs
        WHERE project_id = ? AND deployment_id = ?
        ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(projectId, deploymentId, boundedLimit) as RuntimeLogRow[];
  }

  pruneProjectObservabilityByAge(cutoff: number): void {
    this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM project_metric_samples WHERE sampled_at < ?").run(Math.trunc(cutoff));
      this.sqlite.prepare("DELETE FROM runtime_logs WHERE source_timestamp < ?")
        .run(new Date(Math.trunc(cutoff)).toISOString());
    })();
  }

  pruneProjectObservabilityHardLimits(maxMetricSamplesPerProject: number, maxLogLinesPerProject = 5_000): void {
    const metricLimit = Math.max(1, Math.min(500_000, Math.trunc(maxMetricSamplesPerProject)));
    const logLimit = Math.max(100, Math.min(50_000, Math.trunc(maxLogLinesPerProject)));
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        DELETE FROM project_metric_samples
        WHERE rowid IN (
          SELECT rowid FROM (
            SELECT rowid, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY sampled_at DESC) AS position
            FROM project_metric_samples
          ) WHERE position > ?
        )
      `).run(metricLimit);
      this.sqlite.prepare(`
        DELETE FROM runtime_logs
        WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY id DESC) AS position
            FROM runtime_logs
          ) WHERE position > ?
        )
      `).run(logLimit);
    })();
  }

  pruneProjectObservability(cutoff: number, maxMetricSamplesPerProject: number, maxLogLinesPerProject = 5_000): void {
    this.pruneProjectObservabilityByAge(cutoff);
    this.pruneProjectObservabilityHardLimits(maxMetricSamplesPerProject, maxLogLinesPerProject);
  }

  serverActivityCounts(now = Date.now()): ServerActivityCounts {
    const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    return this.sqlite.prepare(`
      WITH recent_terminal_deployments AS (
        SELECT status FROM deployments
        WHERE status IN ('ready','failed') AND finished_at >= @since
        UNION ALL
        SELECT status FROM deployments
        WHERE status IN ('ready','failed') AND finished_at IS NULL AND created_at >= @since
      ), terminal_counts AS (
        SELECT
          COUNT(*) FILTER (WHERE status = 'ready') AS ready,
          COUNT(*) FILTER (WHERE status = 'failed') AS failed
        FROM recent_terminal_deployments
      )
      SELECT
        (SELECT COUNT(*) FROM projects
          WHERE NOT EXISTS (
            SELECT 1 FROM project_deletions
            WHERE project_deletions.project_id = projects.id
              AND project_deletions.status IN ('preparing','queued','running')
          )) AS projects,
        (SELECT COUNT(*) FROM projects
          WHERE active_deployment_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM project_deletions
              WHERE project_deletions.project_id = projects.id
                AND project_deletions.status IN ('preparing','queued','running')
            )) AS live_projects,
        (SELECT COUNT(*) FROM domains
          JOIN projects ON projects.id = domains.project_id
          WHERE NOT EXISTS (
            SELECT 1 FROM project_deletions
            WHERE project_deletions.project_id = projects.id
              AND project_deletions.status IN ('preparing','queued','running')
          )) AS domains,
        (SELECT COUNT(*) FROM deployments WHERE status = 'queued') AS deployments_queued,
        (SELECT COUNT(*) FROM deployments WHERE status IN ('preparing','building','checking','switching')) AS deployments_active,
        terminal_counts.ready AS deployments_ready_last_24_hours,
        terminal_counts.failed AS deployments_failed_last_24_hours
      FROM terminal_counts
    `).get({ since }) as ServerActivityCounts;
  }
}
