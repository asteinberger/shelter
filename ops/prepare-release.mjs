import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  compareShelterVersions,
  parseShelterVersion,
  PolicyError,
  readConsistentRepositoryVersion,
  updateRepositoryVersion
} from "./lib/development-policy.mjs";

const root = join(import.meta.dirname, "..");
const packagePath = join(root, "package.json");
const lockPath = join(root, "package-lock.json");

function usage() {
  console.error("Usage: npm run release:prepare -- <MAJOR.MINOR.PATCH[-PRERELEASE]> [--dry-run]");
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (!allowFailure && result.status !== 0) {
    throw new PolicyError(`Git command failed: ${result.stderr.trim() || args.join(" ")}`);
  }
  return result;
}

function gitOutput(args) {
  return git(args).stdout.trim();
}

function fileAt(gitRef, path) {
  return gitOutput(["show", "--no-ext-diff", `${gitRef}:${path}`]);
}

function assertReleaseWorkspace(targetVersion) {
  parseShelterVersion(targetVersion, "target version");
  const branch = gitOutput(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const expectedBranch = `agent/release-${targetVersion}`;
  if (branch !== "dev" && branch !== expectedBranch) {
    throw new PolicyError(
      `Release preparation must start on dev or ${expectedBranch}, not ${branch || "a detached HEAD"}.`
    );
  }
  if (gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
    throw new PolicyError("Release preparation requires a completely clean worktree.");
  }

  git([
    "fetch",
    "--force",
    "--no-tags",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
    "+refs/heads/dev:refs/remotes/origin/dev"
  ]);

  const head = gitOutput(["rev-parse", "HEAD"]);
  const remoteDev = gitOutput(["rev-parse", "refs/remotes/origin/dev"]);
  if (head !== remoteDev) {
    throw new PolicyError(
      `${branch} must exactly match origin/dev before preparing a release; rebase or recreate the release branch.`
    );
  }
  const mainMergeBase = gitOutput(["merge-base", "refs/remotes/origin/main", "HEAD"]);
  if (git(["diff", "--quiet", mainMergeBase, "refs/remotes/origin/main"], { allowFailure: true }).status !== 0) {
    throw new PolicyError(
      "origin/main contains tree changes that are not represented in dev. Reconcile them through a fix branch before releasing."
    );
  }

  const packageJsonText = readFileSync(packagePath, "utf8");
  const packageLockText = readFileSync(lockPath, "utf8");
  const currentVersion = readConsistentRepositoryVersion(packageJsonText, packageLockText, "dev");
  const mainVersion = readConsistentRepositoryVersion(
    fileAt("refs/remotes/origin/main", "package.json"),
    fileAt("refs/remotes/origin/main", "package-lock.json"),
    "origin/main"
  );
  if (currentVersion !== mainVersion) {
    throw new PolicyError(
      `dev is already versioned as ${currentVersion}, while main is ${mainVersion}. Finish or revert that release before preparing another one.`
    );
  }
  if (compareShelterVersions(targetVersion, currentVersion) <= 0) {
    throw new PolicyError(`Target version ${targetVersion} must be greater than ${currentVersion}.`);
  }

  return {
    branch,
    currentVersion,
    expectedBranch,
    packageJsonText,
    packageLockText
  };
}

function writeAtomically(path, content) {
  const temporary = join(dirname(path), `.${basename(path)}.shelter-release-${process.pid}`);
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o644, flag: "wx" });
  renameSync(temporary, path);
}

function runChecks() {
  const result = spawnSync("npm", ["run", "check"], {
    cwd: root,
    env: { ...process.env, CI: "true" },
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new PolicyError(
      result.error
        ? `Could not run the release checks: ${result.error.message}`
        : `Release checks failed${result.signal ? ` with signal ${result.signal}` : ""}.`
    );
  }
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((argument) => argument !== "--dry-run");
  if (positional.length !== 1 || args.some((argument) => argument.startsWith("--") && argument !== "--dry-run")) {
    usage();
    process.exitCode = 2;
    return;
  }

  const targetVersion = positional[0];
  const state = assertReleaseWorkspace(targetVersion);
  if (dryRun) {
    console.log(
      `Release preparation is valid: ${state.currentVersion} -> ${targetVersion} on ${state.expectedBranch}. No branch or files changed.`
    );
    return;
  }

  if (state.branch === "dev") {
    if (git(["show-ref", "--verify", "--quiet", `refs/heads/${state.expectedBranch}`], { allowFailure: true }).status === 0) {
      throw new PolicyError(
        `Local branch ${state.expectedBranch} already exists. Delete it only after verifying it has no work, or rerun from that clean branch if it still matches origin/dev.`
      );
    }
    git(["switch", "--create", state.expectedBranch, "refs/remotes/origin/dev"]);
  }

  const updated = updateRepositoryVersion(
    state.packageJsonText,
    state.packageLockText,
    targetVersion
  );
  try {
    writeAtomically(packagePath, updated.packageJsonText);
    writeAtomically(lockPath, updated.packageLockText);
    runChecks();
  } catch (error) {
    writeAtomically(packagePath, state.packageJsonText);
    writeAtomically(lockPath, state.packageLockText);
    throw error;
  }

  console.log(`\nPrepared Shelter v${targetVersion} on ${state.expectedBranch} and passed npm run check.`);
  console.log(`Review and commit only package.json and package-lock.json on ${state.expectedBranch}.`);
  console.log(`Push that branch and open its PR to dev; do not push directly to dev.`);
  console.log("After that PR merges and dev integration passes, open the single release PR from dev to main.");
  console.log("Do not create the release tag until the release PR is merged and main is synchronized locally.");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Release preparation failed: ${message}`);
  process.exitCode = 1;
}
