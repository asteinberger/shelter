import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/pr-policy.yml", import.meta.url),
  "utf8"
);

const expectedBootstrapPaths = [
  ".github/CODEOWNERS",
  ".github/pull_request_template.md",
  ".github/workflows/ci.yml",
  ".github/workflows/pr-policy.yml",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "docs/RELEASES.md",
  "ops/check-pr-policy.mjs",
  "ops/lib/development-policy.mjs",
  "ops/prepare-release.mjs",
  "package.json",
  "test/development-policy.test.mjs",
  "test/development-workflow.test.sh",
  "test/pr-policy-workflow.test.mjs"
];

test("pull request policy uses the trusted base without elevated events", () => {
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /types:\n\s+- edited\n/);
  assert.ok(
    workflow.indexOf("Check out trusted base policy")
      < workflow.indexOf("Fetch exact pull request head")
  );
});

test("bootstrap is one exact same-repository branch and executes no head scripts", () => {
  const trustedPolicy = workflow.indexOf("if [[ -f ops/check-pr-policy.mjs ]]");
  const trustedExecution = workflow.indexOf("node ops/check-pr-policy.mjs", trustedPolicy);
  const trustedExit = workflow.indexOf("exit 0", trustedExecution);
  const requiredBlobs = workflow.indexOf("for required_blob in", trustedExit);
  const bootstrap = workflow.indexOf('HEAD_BRANCH" != "agent/development-workflow"', trustedExit);
  assert.ok(trustedPolicy >= 0 && trustedPolicy < trustedExecution);
  assert.ok(trustedExecution < trustedExit && trustedExit < bootstrap);
  assert.ok(trustedExit < requiredBlobs && requiredBlobs < workflow.indexOf('BASE_BRANCH" == "main"'));
  assert.match(workflow, /HEAD_REPOSITORY" != "\$BASE_REPOSITORY"/);
  assert.match(workflow, /BASE_REPOSITORY" != "\$EVENT_REPOSITORY"/);

  const bootstrapBody = workflow.slice(bootstrap);
  assert.doesNotMatch(bootstrapBody, /git (?:checkout|switch)/);
  assert.doesNotMatch(bootstrapBody, /node .*refs\/shelter-policy\/head/);
  assert.match(bootstrapBody, /git (?:diff|show|ls-tree)/);
  assert.match(bootstrapBody, /must not change or desynchronize the release version/);
  assert.match(workflow, /Bootstrap policy file is missing or not a regular Git blob/);
});

test("bootstrap changed paths remain an exact reviewed set", () => {
  const match = workflow.match(
    /cat >"\$expected_paths" <<'EOF_BOOTSTRAP_PATHS'\n([\s\S]*?)\n\s*EOF_BOOTSTRAP_PATHS/
  );
  assert.ok(match, "bootstrap path heredoc is missing");
  const actual = match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  assert.deepEqual(actual, expectedBootstrapPaths);
  assert.match(workflow, /cmp -s "\$expected_paths" "\$actual_paths"/);
});

test("main bootstrap permits only same-repository dev with a higher strict SemVer", () => {
  assert.match(workflow, /BASE_BRANCH" == "main"/);
  assert.match(workflow, /HEAD_BRANCH" != "dev"/);
  assert.match(workflow, /main policy bootstrap permits only same-repository dev -> main/);
  assert.match(workflow, /requires consistent package and lockfile versions/);

  const match = workflow.match(
    /node <<'EOF_BOOTSTRAP_SEMVER'\n([\s\S]*?)\n\s*EOF_BOOTSTRAP_SEMVER/
  );
  assert.ok(match, "main bootstrap SemVer validator is missing");
  const script = match[1].split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
  const compare = (base, head) => spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, BASE_VERSION: base, HEAD_VERSION: head }
  });

  assert.equal(compare("0.2.1", "0.3.0").status, 0);
  assert.equal(compare("1.0.0-rc.1", "1.0.0").status, 0);
  assert.notEqual(compare("0.2.1", "0.2.1").status, 0);
  assert.notEqual(compare("0.3.0", "0.2.9").status, 0);
  assert.notEqual(compare("0.2.1", "0.3.0+rebuilt").status, 0);
  assert.notEqual(compare("0.2.1", `0.3.0-${"a.".repeat(100_000)}`).status, 0);
});
