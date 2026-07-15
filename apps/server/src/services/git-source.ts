import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { runCommand, type CommandOptions, type CommandResult } from "../lib/command.js";
import type { DeploymentRow, ProjectRow } from "../types/models.js";

type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions
) => Promise<CommandResult>;

export interface GitHubInstallationTokenProvider {
  installationToken(installationId: string, repositoryId?: string): Promise<string>;
}

interface GitSourceProject extends Pick<ProjectRow, "repository_url" | "repository_branch"> {
  github_installation_id?: string | null;
  github_repository_id?: string | null;
  github_repository_full_name?: string | null;
}

interface GitSourceDeployment extends Pick<DeploymentRow, "source_ref" | "commit_sha" | "trigger"> {}

interface PrepareGitSourceOptions {
  config: Pick<AppConfig, "GIT_TIMEOUT_MINUTES">;
  project: GitSourceProject;
  deployment: GitSourceDeployment;
  workspace: string;
  github: GitHubInstallationTokenProvider;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  signal?: AbortSignal;
  command?: CommandRunner;
}

const commitPattern = /^[0-9a-f]{40,64}$/i;

function repositoryUrl(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.port && parsed.port !== "443")
  ) {
    throw new Error("Git-Repository muss eine einfache HTTPS-URL über Port 443 ohne Zugangsdaten verwenden");
  }
  return parsed.toString();
}

function canonicalGithubRepository(fullName: string | null | undefined): string {
  const normalized = fullName?.trim() ?? "";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(normalized)) {
    throw new Error("Die verknüpfte GitHub-Repository-ID ist ungültig");
  }
  return `https://github.com/${normalized}.git`;
}

function branchRef(value: string): string {
  const branch = value.trim();
  if (
    branch.length < 1 ||
    branch.length > 160 ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    /[\u0000-\u0020~^:?*[\\]/.test(branch)
  ) {
    throw new Error("Der Git-Branch ist ungültig");
  }
  return `+refs/heads/${branch}:refs/remotes/origin/shelter`;
}

function gitEnvironment(askpassPath?: string, token?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "GIT_ASKPASS", "GIT_ASKPASS_REQUIRE", "GIT_CONFIG_COUNT", "GIT_CURL_VERBOSE",
    "GIT_PROXY_COMMAND", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_TRACE", "GIT_TRACE_CURL",
    "GIT_TRACE_PACKET", "GIT_TRACE_PERFORMANCE", "SHELTER_GIT_PASSWORD",
    "SHELTER_GIT_USERNAME", "PORTSMITH_GIT_PASSWORD", "PORTSMITH_GIT_USERNAME", "SSH_ASKPASS"
  ]) delete environment[key];
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...(askpassPath && token
      ? {
          GIT_ASKPASS: askpassPath,
          GIT_ASKPASS_REQUIRE: "force",
          SHELTER_GIT_USERNAME: "x-access-token",
          SHELTER_GIT_PASSWORD: token
        }
      : {})
  };
}

/**
 * Fetches an immutable Git snapshot without ever placing credentials in a URL,
 * command argument, or deployment log. GitHub installation tokens only live in
 * the child process environment and the short-lived askpass process.
 */
export async function prepareGitSource(options: PrepareGitSourceOptions): Promise<string> {
  const command = options.command ?? runCommand;
  const sourceRoot = path.join(options.workspace, "source");
  const remote = options.project.github_installation_id
    ? canonicalGithubRepository(options.project.github_repository_full_name)
    : repositoryUrl(options.project.repository_url ?? "");
  const branch = options.deployment.source_ref ?? options.project.repository_branch;
  if (!branch) throw new Error("Git-Branch fehlt");

  // GitHub push deployments are immutable snapshots. Manual deployments must
  // always resolve the configured branch again, even if stale commit metadata
  // is present on a recovered or legacy row.
  const requestedCommit = options.deployment.trigger === "github_push"
    ? options.deployment.commit_sha
    : null;
  const exactCommit = requestedCommit && commitPattern.test(requestedCommit)
    ? requestedCommit
    : null;
  if (requestedCommit && !exactCommit) {
    throw new Error("Die angeforderte Git-Commit-ID ist ungültig");
  }
  const fetchRef = exactCommit ?? branchRef(branch);

  let askpassPath: string | undefined;
  let token: string | undefined;
  try {
    if (options.project.github_installation_id) {
      if (!options.project.github_repository_id) throw new Error("Die verknüpfte GitHub-Repository-ID fehlt");
      token = await options.github.installationToken(
        options.project.github_installation_id,
        options.project.github_repository_id
      );
      askpassPath = path.join(options.workspace, ".shelter-git-askpass");
      await fs.promises.writeFile(
        askpassPath,
        "#!/bin/sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' \"$SHELTER_GIT_USERNAME\" ;;\n  *) printf '%s\\n' \"$SHELTER_GIT_PASSWORD\" ;;\nesac\n",
        { mode: 0o700, flag: "wx" }
      );
    }

    const timeoutMs = options.config.GIT_TIMEOUT_MINUTES * 60_000;
    const output = (env: NodeJS.ProcessEnv): CommandOptions => ({
      env,
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onStdout ? { onStdout: options.onStdout } : {}),
      ...(options.onStderr ? { onStderr: options.onStderr } : {})
    });
    const unauthenticated = output(gitEnvironment());

    await command("git", ["init", "--initial-branch=shelter", "--", sourceRoot], unauthenticated);
    await command("git", [
      "-C", sourceRoot,
      "-c", "credential.helper=",
      "remote", "add", "origin", remote
    ], unauthenticated);
    await command("git", [
      "-C", sourceRoot,
      "-c", "protocol.file.allow=never",
      "-c", "credential.helper=",
      "fetch", "--depth=1", "--no-tags", "origin",
      fetchRef
    ], output(gitEnvironment(askpassPath, token)));
    token = undefined;
    if (askpassPath) {
      await fs.promises.rm(askpassPath, { force: true });
      askpassPath = undefined;
    }
    await command("git", ["-C", sourceRoot, "checkout", "--detach", "FETCH_HEAD"], unauthenticated);
    return sourceRoot;
  } finally {
    token = undefined;
    if (askpassPath) await fs.promises.rm(askpassPath, { force: true });
  }
}
