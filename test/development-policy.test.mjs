import assert from "node:assert/strict";
import test from "node:test";
import {
  compareShelterVersions,
  evaluatePullRequestPolicy,
  isContributionBranch,
  parseShelterVersion,
  readConsistentRepositoryVersion,
  updateRepositoryVersion
} from "../ops/lib/development-policy.mjs";

const files = (version) => ({
  packageJson: JSON.stringify({ name: "shelter", version }),
  packageLock: JSON.stringify({ version, packages: { "": { name: "shelter", version } } })
});

function pullRequest(overrides = {}) {
  const base = files("0.2.1");
  const head = files("0.2.1");
  return {
    actor: "contributor",
    baseBranch: "dev",
    basePackageJson: base.packageJson,
    basePackageLock: base.packageLock,
    baseRepository: "shelter/shelter",
    changedPaths: ["apps/server/src/index.ts"],
    headBranch: "agent/runtime-logs",
    headPackageJson: head.packageJson,
    headPackageLock: head.packageLock,
    headRepository: "contributor/shelter",
    ...overrides
  };
}

test("accepts strict release SemVer and orders prereleases", () => {
  assert.equal(parseShelterVersion("1.2.3-rc.1").raw, "1.2.3-rc.1");
  assert.equal(compareShelterVersions("1.2.3", "1.2.3-rc.9"), 1);
  assert.equal(compareShelterVersions("1.2.3-rc.10", "1.2.3-rc.2"), 1);
  assert.equal(compareShelterVersions("2.0.0", "1.99.99"), 1);
  assert.throws(() => parseShelterVersion("1.2.3+rebuilt"), /no build metadata/);
  assert.throws(() => parseShelterVersion("01.2.3"), /must use SemVer/);
  assert.throws(() => parseShelterVersion("1.2.3-01"), /must use SemVer/);
  assert.throws(
    () => parseShelterVersion(`1.2.3-${"a.".repeat(100_000)}`),
    /must not exceed 127 characters/
  );
});

test("recognizes only the documented contribution branch families", () => {
  assert.equal(isContributionBranch("agent/runtime-logs"), true);
  assert.equal(isContributionBranch("fix/ui/menu-error"), true);
  assert.equal(isContributionBranch("feature/runtime-logs"), false);
  assert.equal(isContributionBranch("agent/Runtime Logs"), false);
  assert.equal(isContributionBranch("agent/-runtime"), false);
});

test("allows feature and fix pull requests to dev without a version change", () => {
  assert.deepEqual(evaluatePullRequestPolicy(pullRequest()), {
    kind: "contribution",
    version: "0.2.1"
  });
  assert.equal(
    evaluatePullRequestPolicy(pullRequest({ headBranch: "fix/menu" })).kind,
    "contribution"
  );
});

test("rejects invalid dev branches and release bumps on feature branches", () => {
  assert.throws(
    () => evaluatePullRequestPolicy(pullRequest({ headBranch: "feature/logs" })),
    /agent\/<feature>/
  );
  const bumped = files("0.3.0");
  assert.throws(
    () => evaluatePullRequestPolicy(pullRequest({
      headPackageJson: bumped.packageJson,
      headPackageLock: bumped.packageLock
    })),
    /agent\/release-<version>/
  );
});

test("allows a focused version-only release preparation PR to dev", () => {
  const bumped = files("0.3.0");
  assert.deepEqual(evaluatePullRequestPolicy(pullRequest({
    changedPaths: ["package-lock.json", "package.json"],
    headBranch: "agent/release-0.3.0",
    headPackageJson: bumped.packageJson,
    headPackageLock: bumped.packageLock,
    headRepository: "shelter/shelter"
  })), {
    kind: "release-preparation",
    previousVersion: "0.2.1",
    version: "0.3.0"
  });
});

test("rejects unfocused, mismatched, or forked release preparation PRs", () => {
  const bumped = files("0.3.0");
  const releasePreparation = pullRequest({
    changedPaths: ["package-lock.json", "package.json"],
    headBranch: "agent/release-0.3.0",
    headPackageJson: bumped.packageJson,
    headPackageLock: bumped.packageLock,
    headRepository: "shelter/shelter"
  });
  assert.throws(
    () => evaluatePullRequestPolicy({ ...releasePreparation, changedPaths: [...releasePreparation.changedPaths, "README.md"] }),
    /three root version fields/
  );
  assert.throws(
    () => evaluatePullRequestPolicy({ ...releasePreparation, headBranch: "agent/release-0.3.1" }),
    /agent\/release-<version>/
  );
  assert.throws(
    () => evaluatePullRequestPolicy({ ...releasePreparation, headRepository: "fork/shelter" }),
    /same-repository/
  );
  const changedPackage = JSON.stringify({
    name: "shelter",
    version: "0.3.0",
    scripts: { postinstall: "unexpected" }
  });
  assert.throws(
    () => evaluatePullRequestPolicy({ ...releasePreparation, headPackageJson: changedPackage }),
    /three root version fields/
  );
});

test("allows only the real Dependabot actor to use its branch exception", () => {
  const dependabot = pullRequest({
    actor: "dependabot[bot]",
    headBranch: "dependabot/npm_and_yarn/runtime",
    headRepository: "shelter/shelter"
  });
  assert.equal(evaluatePullRequestPolicy(dependabot).kind, "dependency");
  assert.throws(
    () => evaluatePullRequestPolicy({ ...dependabot, actor: "contributor" }),
    /real Dependabot actor/
  );
});

test("requires a same-repository dev release PR with a higher version", () => {
  const bumped = files("0.3.0");
  const release = pullRequest({
    baseBranch: "main",
    headBranch: "dev",
    headRepository: "shelter/shelter",
    headPackageJson: bumped.packageJson,
    headPackageLock: bumped.packageLock
  });
  assert.deepEqual(evaluatePullRequestPolicy(release), {
    kind: "release",
    previousVersion: "0.2.1",
    version: "0.3.0"
  });
  assert.throws(
    () => evaluatePullRequestPolicy({ ...release, headBranch: "agent/release" }),
    /Only the dev branch/
  );
  assert.throws(
    () => evaluatePullRequestPolicy({
      ...release,
      headPackageJson: files("0.2.1").packageJson,
      headPackageLock: files("0.2.1").packageLock
    }),
    /explicitly bump/
  );
});

test("requires all repository version fields to agree", () => {
  const inconsistentLock = JSON.stringify({
    version: "0.2.1",
    packages: { "": { version: "0.2.0" } }
  });
  assert.throws(
    () => readConsistentRepositoryVersion(files("0.2.1").packageJson, inconsistentLock, "test"),
    /must have the same version/
  );
});

test("updates only the root release versions", () => {
  const packageJson = JSON.stringify({ name: "shelter", version: "0.2.1", private: true });
  const packageLock = JSON.stringify({
    version: "0.2.1",
    packages: {
      "": { name: "shelter", version: "0.2.1" },
      "apps/server": { name: "@shelter/server", version: "9.9.9" }
    }
  });
  const updated = updateRepositoryVersion(packageJson, packageLock, "0.3.0");
  assert.equal(JSON.parse(updated.packageJsonText).version, "0.3.0");
  assert.equal(JSON.parse(updated.packageLockText).version, "0.3.0");
  assert.equal(JSON.parse(updated.packageLockText).packages[""].version, "0.3.0");
  assert.equal(JSON.parse(updated.packageLockText).packages["apps/server"].version, "9.9.9");
});
