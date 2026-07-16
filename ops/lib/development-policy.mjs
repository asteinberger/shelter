const MAX_RELEASE_VERSION_LENGTH = 127;
const MAX_CONTRIBUTION_BRANCH_LENGTH = 240;

export class PolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "PolicyError";
  }
}

function isAsciiDigit(character) {
  return character >= "0" && character <= "9";
}

function isAsciiLetter(character) {
  return (character >= "A" && character <= "Z")
    || (character >= "a" && character <= "z");
}

function isNumericIdentifier(value) {
  if (value.length === 0) return false;
  for (const character of value) {
    if (!isAsciiDigit(character)) return false;
  }
  return true;
}

function isValidNumericIdentifier(value) {
  return isNumericIdentifier(value) && (value === "0" || value[0] !== "0");
}

function isValidPrereleaseIdentifier(value) {
  if (value.length === 0) return false;
  let containsLetterOrHyphen = false;
  for (const character of value) {
    if (isAsciiDigit(character)) continue;
    if (isAsciiLetter(character) || character === "-") {
      containsLetterOrHyphen = true;
      continue;
    }
    return false;
  }
  return containsLetterOrHyphen || isValidNumericIdentifier(value);
}

function invalidVersion(label) {
  throw new PolicyError(
    `${label} must use SemVer MAJOR.MINOR.PATCH with an optional prerelease suffix and no build metadata.`
  );
}

export function parseShelterVersion(value, label = "version") {
  if (typeof value !== "string") {
    throw new PolicyError(`${label} must be a string.`);
  }
  if (value.length > MAX_RELEASE_VERSION_LENGTH) {
    throw new PolicyError(`${label} must not exceed ${MAX_RELEASE_VERSION_LENGTH} characters.`);
  }
  if (value.includes("+")) invalidVersion(label);

  const prereleaseSeparator = value.indexOf("-");
  const core = prereleaseSeparator === -1 ? value : value.slice(0, prereleaseSeparator);
  const prereleaseText = prereleaseSeparator === -1 ? "" : value.slice(prereleaseSeparator + 1);
  const coreIdentifiers = core.split(".");
  if (coreIdentifiers.length !== 3 || !coreIdentifiers.every(isValidNumericIdentifier)) {
    invalidVersion(label);
  }
  const prerelease = prereleaseSeparator === -1 ? [] : prereleaseText.split(".");
  if (prereleaseSeparator !== -1 && !prerelease.every(isValidPrereleaseIdentifier)) {
    invalidVersion(label);
  }

  return {
    raw: value,
    major: coreIdentifiers[0],
    minor: coreIdentifiers[1],
    patch: coreIdentifiers[2],
    prerelease
  };
}

function compareNumericIdentifier(left, right) {
  if (left.length !== right.length) return Math.sign(left.length - right.length);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function comparePrereleaseIdentifier(left, right) {
  const leftIsNumber = isNumericIdentifier(left);
  const rightIsNumber = isNumericIdentifier(right);
  if (leftIsNumber && rightIsNumber) return compareNumericIdentifier(left, right);
  if (leftIsNumber) return -1;
  if (rightIsNumber) return 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function compareShelterVersions(leftValue, rightValue) {
  const left = parseShelterVersion(leftValue, "left version");
  const right = parseShelterVersion(rightValue, "right version");

  for (const key of ["major", "minor", "patch"]) {
    const difference = compareNumericIdentifier(left[key], right[key]);
    if (difference !== 0) return Math.sign(difference);
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const difference = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (difference !== 0) return Math.sign(difference);
  }

  return 0;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new PolicyError(`${label} must contain valid JSON.`);
  }
}

export function readConsistentRepositoryVersion(packageJsonText, packageLockText, label) {
  const packageJson = parseJson(packageJsonText, `${label} package.json`);
  const packageLock = parseJson(packageLockText, `${label} package-lock.json`);
  const packageVersion = packageJson.version;
  const lockVersion = packageLock.version;
  const lockRootVersion = packageLock.packages?.[""]?.version;

  parseShelterVersion(packageVersion, `${label} package.json version`);
  parseShelterVersion(lockVersion, `${label} package-lock.json version`);
  parseShelterVersion(lockRootVersion, `${label} package-lock.json root version`);

  if (packageVersion !== lockVersion || lockVersion !== lockRootVersion) {
    throw new PolicyError(
      `${label} package.json, package-lock.json, and the lockfile root package must have the same version.`
    );
  }

  return packageVersion;
}

export function updateRepositoryVersion(packageJsonText, packageLockText, targetVersion) {
  parseShelterVersion(targetVersion, "target version");
  const packageJson = parseJson(packageJsonText, "package.json");
  const packageLock = parseJson(packageLockText, "package-lock.json");

  if (!packageLock.packages || !packageLock.packages[""]) {
    throw new PolicyError('package-lock.json must contain the root package at packages[""].');
  }

  packageJson.version = targetVersion;
  packageLock.version = targetVersion;
  packageLock.packages[""].version = targetVersion;

  return {
    packageJsonText: `${JSON.stringify(packageJson, null, 2)}\n`,
    packageLockText: `${JSON.stringify(packageLock, null, 2)}\n`
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])])
    );
  }
  return value;
}

export function onlyRepositoryVersionChanged({
  basePackageJson,
  basePackageLock,
  headPackageJson,
  headPackageLock
}) {
  const basePackage = parseJson(basePackageJson, "base package.json");
  const baseLock = parseJson(basePackageLock, "base package-lock.json");
  const headPackage = parseJson(headPackageJson, "pull request head package.json");
  const headLock = parseJson(headPackageLock, "pull request head package-lock.json");

  for (const document of [basePackage, headPackage]) document.version = "<release-version>";
  for (const document of [baseLock, headLock]) {
    if (!document.packages?.[""]) return false;
    document.version = "<release-version>";
    document.packages[""].version = "<release-version>";
  }

  return JSON.stringify(canonicalJson(basePackage)) === JSON.stringify(canonicalJson(headPackage))
    && JSON.stringify(canonicalJson(baseLock)) === JSON.stringify(canonicalJson(headLock));
}

export function isContributionBranch(branch) {
  if (typeof branch !== "string" || branch.length > MAX_CONTRIBUTION_BRANCH_LENGTH) return false;
  const prefix = branch.startsWith("agent/")
    ? "agent/"
    : branch.startsWith("fix/") ? "fix/" : "";
  if (!prefix) return false;
  const segments = branch.slice(prefix.length).split("/");
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    if (segment.length === 0 || !isAsciiDigit(segment[0]) && !isAsciiLetter(segment[0])) return false;
    const last = segment[segment.length - 1];
    if (!isAsciiDigit(last) && !isAsciiLetter(last)) return false;
    for (const character of segment) {
      if (isAsciiDigit(character) || (character >= "a" && character <= "z")) continue;
      if (character === "." || character === "_" || character === "-") continue;
      return false;
    }
    return true;
  });
}

function isDependabotPullRequest({ actor, branch, baseRepository, headRepository }) {
  return actor === "dependabot[bot]"
    && headRepository === baseRepository
    && branch.startsWith("dependabot/");
}

export function evaluatePullRequestPolicy({
  actor,
  baseBranch,
  basePackageJson,
  basePackageLock,
  baseRepository,
  changedPaths,
  headBranch,
  headPackageJson,
  headPackageLock,
  headRepository
}) {
  const baseVersion = readConsistentRepositoryVersion(
    basePackageJson,
    basePackageLock,
    "base"
  );
  const headVersion = readConsistentRepositoryVersion(
    headPackageJson,
    headPackageLock,
    "pull request head"
  );

  if (baseBranch === "dev") {
    const allowedContribution = isContributionBranch(headBranch);
    const allowedDependabot = isDependabotPullRequest({
      actor,
      branch: headBranch,
      baseRepository,
      headRepository
    });
    if (!allowedContribution && !allowedDependabot) {
      throw new PolicyError(
        "Pull requests to dev must come from agent/<feature> or fix/<name>. Only the real Dependabot actor may use dependabot/*."
      );
    }
    if (headVersion !== baseVersion) {
      const releaseBranchVersion = headBranch.startsWith("agent/release-")
        ? headBranch.slice("agent/release-".length)
        : "";
      const allowedReleasePaths = new Set(["package.json", "package-lock.json"]);
      const releaseBranchIsValid = releaseBranchVersion === headVersion
        && headRepository === baseRepository;
      const releaseDiffIsFocused = changedPaths.length === allowedReleasePaths.size
        && changedPaths.every((path) => allowedReleasePaths.has(path));
      const releaseContentIsFocused = onlyRepositoryVersionChanged({
        basePackageJson,
        basePackageLock,
        headPackageJson,
        headPackageLock
      });
      if (releaseBranchIsValid
        && compareShelterVersions(headVersion, baseVersion) > 0
        && releaseDiffIsFocused
        && releaseContentIsFocused) {
        return {
          kind: "release-preparation",
          previousVersion: baseVersion,
          version: headVersion
        };
      }
      throw new PolicyError(
        `Only same-repository agent/release-<version> may raise ${baseVersion}, and that PR may change only the three root version fields in package.json and package-lock.json.`
      );
    }
    return {
      kind: allowedDependabot ? "dependency" : "contribution",
      version: headVersion
    };
  }

  if (baseBranch === "main") {
    if (headRepository !== baseRepository || headBranch !== "dev") {
      throw new PolicyError("Only the dev branch from this repository may open a release pull request to main.");
    }
    if (compareShelterVersions(headVersion, baseVersion) <= 0) {
      throw new PolicyError(
        `A release pull request must explicitly bump the version above ${baseVersion}; received ${headVersion}.`
      );
    }
    return { kind: "release", previousVersion: baseVersion, version: headVersion };
  }

  throw new PolicyError(`Unsupported pull request base branch: ${baseBranch}.`);
}
