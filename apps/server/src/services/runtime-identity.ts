import { createHash } from "node:crypto";

export const DOCKER_NAMESPACE = "shelter";
export const LEGACY_DOCKER_NAMESPACE = "portsmith";

const DNS_LABEL_MAX_LENGTH = 63;
const VERSIONED_RUNTIME_PREFIX = `${DOCKER_NAMESPACE}-run-`;

export const MANAGED_LABEL_NAMESPACES = [DOCKER_NAMESPACE, LEGACY_DOCKER_NAMESPACE] as const;
export const COMPOSE_PROJECT_NAMES = [DOCKER_NAMESPACE, LEGACY_DOCKER_NAMESPACE] as const;

export function imageTag(projectSlug: string, deploymentId: string): string {
  return `${DOCKER_NAMESPACE}/${projectSlug}:${deploymentId.replace(/^dep_/, "").slice(0, 16)}`;
}

export function isManagedImage(value: string): boolean {
  return value.startsWith(`${DOCKER_NAMESPACE}/`) || value.startsWith(`${LEGACY_DOCKER_NAMESPACE}/`);
}

export function stableContainerName(projectSlug: string, activeImage?: string | null): string {
  const namespace = activeImage?.startsWith(`${LEGACY_DOCKER_NAMESPACE}/`)
    ? LEGACY_DOCKER_NAMESPACE
    : DOCKER_NAMESPACE;
  return `${namespace}-app-${projectSlug}`;
}

export function stableContainerNames(projectSlug: string, preferredImage?: string | null): string[] {
  const preferred = stableContainerName(projectSlug, preferredImage);
  const alternatives = [
    `${DOCKER_NAMESPACE}-app-${projectSlug}`,
    `${LEGACY_DOCKER_NAMESPACE}-app-${projectSlug}`
  ];
  return [preferred, ...alternatives.filter((name) => name !== preferred)];
}

export function candidateContainerName(deploymentId: string): string {
  return dnsLabel(`${DOCKER_NAMESPACE}-candidate`, deploymentToken(deploymentId));
}

export function deploymentContainerName(projectSlug: string, deploymentId: string): string {
  const token = deploymentToken(deploymentId);
  const maximumSlugLength = DNS_LABEL_MAX_LENGTH - VERSIONED_RUNTIME_PREFIX.length - token.length - 1;
  const slug = dnsSegment(projectSlug).slice(0, maximumSlugLength).replace(/-+$/g, "") || "app";
  return `${VERSIONED_RUNTIME_PREFIX}${slug}-${token}`;
}

/** The exact format used before versioned runtime names became DNS-label bounded. */
export function legacyDeploymentContainerName(projectSlug: string, deploymentId: string): string {
  const safeSlug = projectSlug.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80);
  const safeDeployment = deploymentId.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^dep_/, "").slice(0, 32);
  return `${DOCKER_NAMESPACE}-run-${safeSlug}-${safeDeployment}`;
}

export function isManagedVersionedRuntimeName(value: string): boolean {
  return value.startsWith(VERSIONED_RUNTIME_PREFIX) && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

export function isDockerDnsLabel(value: string): boolean {
  return value.length <= DNS_LABEL_MAX_LENGTH && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

export function deploymentContainerNames(
  projectSlug: string,
  deploymentId: string,
  persistedName?: string | null
): string[] {
  return [...new Set([
    ...(persistedName && isManagedVersionedRuntimeName(persistedName) ? [persistedName] : []),
    deploymentContainerName(projectSlug, deploymentId),
    legacyDeploymentContainerName(projectSlug, deploymentId)
  ])];
}

export function managedLabel(namespace: string, name: string): string {
  return `${namespace}.${name}`;
}

function dnsLabel(prefix: string, suffix: string): string {
  const normalizedPrefix = dnsSegment(prefix) || DOCKER_NAMESPACE;
  const availablePrefixLength = DNS_LABEL_MAX_LENGTH - suffix.length - 1;
  const boundedPrefix = normalizedPrefix.slice(0, availablePrefixLength).replace(/-+$/g, "") || DOCKER_NAMESPACE;
  return `${boundedPrefix}-${suffix}`;
}

function dnsSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function deploymentToken(deploymentId: string): string {
  const raw = deploymentId.replace(/^dep_/, "");
  if (/^[a-f0-9]{32}$/.test(raw)) return raw;
  const readable = dnsSegment(raw).slice(0, 19).replace(/-+$/g, "") || "deployment";
  const hash = createHash("sha256").update(deploymentId).digest("hex").slice(0, 12);
  return `${readable}-${hash}`;
}
