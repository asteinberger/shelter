import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandOptions, CommandResult } from "../src/lib/command.js";
import { prepareGitSource } from "../src/services/git-source.js";

const temporaryDirectories: string[] = [];

function workspace(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-git-source-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Git deployment source preparation", () => {
  it("keeps a GitHub installation token out of command arguments and temporary files", async () => {
    const directory = workspace();
    const secret = "ghs_secret_installation_token";
    const installationToken = vi.fn(async () => secret);
    const calls: Array<{ command: string; args: string[]; options?: CommandOptions }> = [];
    const command = vi.fn(async (
      executable: string,
      args: string[],
      options?: CommandOptions
    ): Promise<CommandResult> => {
      calls.push({ command: executable, args, ...(options ? { options } : {}) });
      if (args.includes("fetch")) {
        const askpass = options?.env?.GIT_ASKPASS;
        expect(typeof askpass).toBe("string");
        expect(fs.readFileSync(askpass as string, "utf8")).not.toContain(secret);
        expect(options?.env?.SHELTER_GIT_PASSWORD).toBe(secret);
      } else {
        expect(options?.env?.GIT_ASKPASS).toBeUndefined();
        expect(options?.env?.SHELTER_GIT_PASSWORD).toBeUndefined();
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const source = await prepareGitSource({
      config: { GIT_TIMEOUT_MINUTES: 2 },
      project: {
        repository_url: "https://github.com/example/private.git",
        repository_branch: "main",
        github_installation_id: "123",
        github_repository_id: "456",
        github_repository_full_name: "example/private"
      },
      deployment: {
        source_ref: "main",
        commit_sha: "a".repeat(40),
        trigger: "github_push"
      },
      workspace: directory,
      github: { installationToken },
      command
    });

    expect(source).toBe(path.join(directory, "source"));
    expect(calls).toHaveLength(4);
    expect(installationToken).toHaveBeenCalledWith("123", "456");
    expect(calls.flatMap((call) => call.args).join(" ")).not.toContain(secret);
    expect(calls[2]?.args).toContain("a".repeat(40));
    expect(fs.existsSync(path.join(directory, ".shelter-git-askpass"))).toBe(false);
  });

  it("fetches a validated branch snapshot for manual repositories without requesting a token", async () => {
    const directory = workspace();
    const args: string[][] = [];
    const installationToken = vi.fn(async () => "unused");
    await prepareGitSource({
      config: { GIT_TIMEOUT_MINUTES: 1 },
      project: {
        repository_url: "https://git.example.com/team/site.git",
        repository_branch: "release/production"
      },
      deployment: {
        source_ref: "release/production",
        commit_sha: "b".repeat(40),
        trigger: "manual"
      },
      workspace: directory,
      github: { installationToken },
      command: async (_command, commandArgs) => {
        args.push(commandArgs);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });

    expect(installationToken).not.toHaveBeenCalled();
    expect(args[2]).toContain("+refs/heads/release/production:refs/remotes/origin/shelter");
    expect(args[2]).not.toContain("b".repeat(40));
  });

  it("fetches the current branch for a manual GitHub redeploy instead of a stale commit", async () => {
    const directory = workspace();
    const args: string[][] = [];
    const installationToken = vi.fn(async () => "ghs_fresh_branch_token");
    await prepareGitSource({
      config: { GIT_TIMEOUT_MINUTES: 1 },
      project: {
        repository_url: "https://github.com/example/private.git",
        repository_branch: "main",
        github_installation_id: "123",
        github_repository_id: "456",
        github_repository_full_name: "example/private"
      },
      deployment: {
        source_ref: "main",
        commit_sha: "c".repeat(40),
        trigger: "manual"
      },
      workspace: directory,
      github: { installationToken },
      command: async (_command, commandArgs) => {
        args.push(commandArgs);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });

    expect(installationToken).toHaveBeenCalledWith("123", "456");
    expect(args[2]).toContain("+refs/heads/main:refs/remotes/origin/shelter");
    expect(args[2]).not.toContain("c".repeat(40));
  });

  it("rejects invalid revisions before invoking Git or requesting credentials", async () => {
    const directory = workspace();
    const command = vi.fn();
    const installationToken = vi.fn();

    await expect(prepareGitSource({
      config: { GIT_TIMEOUT_MINUTES: 1 },
      project: {
        repository_url: "https://github.com/example/private.git",
        repository_branch: "--upload-pack=attacker",
        github_installation_id: "123",
        github_repository_id: "456",
        github_repository_full_name: "example/private"
      },
      deployment: { source_ref: "--upload-pack=attacker", commit_sha: null },
      workspace: directory,
      github: { installationToken },
      command
    })).rejects.toThrow(/Branch ist ungültig/);

    expect(command).not.toHaveBeenCalled();
    expect(installationToken).not.toHaveBeenCalled();
  });

  it("removes askpass material when Git fails", async () => {
    const directory = workspace();
    await expect(prepareGitSource({
      config: { GIT_TIMEOUT_MINUTES: 1 },
      project: {
        repository_url: "https://github.com/example/private.git",
        repository_branch: "main",
        github_installation_id: "123",
        github_repository_id: "456",
        github_repository_full_name: "example/private"
      },
      deployment: { source_ref: "main", commit_sha: null },
      workspace: directory,
      github: { installationToken: async () => "ghs_short_lived" },
      command: async () => { throw new Error("git failed"); }
    })).rejects.toThrow("git failed");

    expect(fs.existsSync(path.join(directory, ".shelter-git-askpass"))).toBe(false);
  });
});
