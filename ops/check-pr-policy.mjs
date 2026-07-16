import { spawnSync } from "node:child_process";
import { evaluatePullRequestPolicy, PolicyError } from "./lib/development-policy.mjs";

function argumentsFrom(argv) {
  const allowed = new Set([
    "actor",
    "base-branch",
    "base-ref",
    "base-repository",
    "expected-head-sha",
    "head-branch",
    "head-ref",
    "head-repository"
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new PolicyError("Policy arguments must be provided as --name value pairs.");
    }
    const key = name.slice(2);
    if (!allowed.has(key) || values.has(key)) {
      throw new PolicyError(`Unknown or repeated policy argument: ${name}.`);
    }
    values.set(key, value);
  }
  for (const key of allowed) {
    if (!values.has(key) || values.get(key) === "") {
      throw new PolicyError(`Missing required policy argument: --${key}.`);
    }
  }
  return Object.fromEntries(values);
}

function validateGitObject(value, label) {
  if (!/^(?:[0-9a-f]{40}|refs\/shelter-policy\/[a-z0-9._/-]+)$/.test(value)) {
    throw new PolicyError(`${label} is not an allowed Git object.`);
  }
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new PolicyError(`Git could not inspect the pull request: ${result.stderr.trim() || "unknown error"}`);
  }
  return result.stdout;
}

function fileAt(gitRef, path) {
  return git(["show", "--no-ext-diff", `${gitRef}:${path}`]);
}

function changedPaths(baseRef, headRef) {
  return git([
    "diff",
    "--name-only",
    "--diff-filter=ACDMRT",
    `${baseRef}...${headRef}`
  ]).split("\n").filter(Boolean);
}

function main() {
  const args = argumentsFrom(process.argv.slice(2));
  validateGitObject(args["base-ref"], "Base ref");
  validateGitObject(args["head-ref"], "Head ref");
  if (!/^[0-9a-f]{40}$/.test(args["expected-head-sha"])) {
    throw new PolicyError("Expected head SHA must be a full lowercase commit SHA.");
  }

  const actualHeadSha = git(["rev-parse", `${args["head-ref"]}^{commit}`]).trim();
  if (actualHeadSha !== args["expected-head-sha"]) {
    throw new PolicyError(
      `Fetched pull request head ${actualHeadSha} does not match the event SHA ${args["expected-head-sha"]}.`
    );
  }

  const result = evaluatePullRequestPolicy({
    actor: args.actor,
    baseBranch: args["base-branch"],
    basePackageJson: fileAt(args["base-ref"], "package.json"),
    basePackageLock: fileAt(args["base-ref"], "package-lock.json"),
    baseRepository: args["base-repository"],
    changedPaths: changedPaths(args["base-ref"], args["head-ref"]),
    headBranch: args["head-branch"],
    headPackageJson: fileAt(args["head-ref"], "package.json"),
    headPackageLock: fileAt(args["head-ref"], "package-lock.json"),
    headRepository: args["head-repository"]
  });

  if (result.kind === "release") {
    console.log(`Release PR policy passed: dev promotes ${result.previousVersion} to ${result.version}.`);
  } else if (result.kind === "release-preparation") {
    console.log(`Release preparation PR policy passed: ${result.previousVersion} to ${result.version}.`);
  } else {
    console.log(`Development PR policy passed at version ${result.version}.`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`PR policy failed: ${message}`);
  process.exitCode = 1;
}
