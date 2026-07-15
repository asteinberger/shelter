import { createHash } from "node:crypto";
import type { CommandOptions, CommandResult } from "../lib/command.js";
import { runCommand } from "../lib/command.js";
import { DOCKER_NAMESPACE } from "./runtime-identity.js";

const PROJECT_NETWORK_PREFIX = "shelter-prj-";
const PROJECT_NETWORK_PURPOSE = "project";
const TRAEFIK_CONTAINER_NAME = "shelter-traefik";

export type ProjectNetworkCommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions
) => Promise<CommandResult>;

interface NetworkEndpoint {
  Name?: unknown;
}

interface TraefikContainerIdentity {
  id: string;
  running: boolean;
}

function assertManagedProjectId(projectId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId)) {
    throw new Error("Projekt-ID ist nicht sicher verwaltet");
  }
}

function parseJsonObject(value: string, description: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${description} hat ein ungültiges Docker-Format`);
  }
}

function isMissingNetwork(detail: string): boolean {
  return /\bno such network\b/i.test(detail) || /\bnetwork\s+\S+\s+not found\b/i.test(detail);
}

function isMissingContainer(detail: string): boolean {
  return /\bno such (?:object|container)\b/i.test(detail);
}

export function projectNetworkName(projectId: string): string {
  assertManagedProjectId(projectId);
  return `${PROJECT_NETWORK_PREFIX}${createHash("sha256").update(projectId).digest("hex").slice(0, 20)}`;
}

async function inspectNetworkLabels(
  networkName: string,
  command: ProjectNetworkCommandRunner
): Promise<Record<string, unknown> | null> {
  const result = await command("docker", [
    "network", "inspect", "--format", "{{json .Labels}}", networkName
  ], { allowFailure: true });
  if (result.exitCode !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim();
    if (isMissingNetwork(detail)) return null;
    throw new Error(`Docker-Netzwerk ${networkName} konnte nicht geprüft werden: ${detail || `Exit ${result.exitCode}`}`);
  }
  return parseJsonObject(result.stdout, "Netzwerk-Labels");
}

function assertOwnedProjectNetwork(
  labels: Record<string, unknown>,
  networkName: string,
  projectId: string
): void {
  if (
    labels["shelter.managed"] !== "true"
    || labels["shelter.project"] !== projectId
    || labels["shelter.purpose"] !== PROJECT_NETWORK_PURPOSE
  ) {
    throw new Error(`Docker-Netzwerk ${networkName} gehört nicht eindeutig zu Projekt ${projectId}`);
  }
}

export async function ensureProjectNetwork(
  projectId: string,
  command: ProjectNetworkCommandRunner = runCommand
): Promise<string> {
  const networkName = projectNetworkName(projectId);
  let labels = await inspectNetworkLabels(networkName, command);
  if (!labels) {
    await command("docker", [
      "network", "create",
      "--driver", "bridge",
      "--label", "shelter.managed=true",
      "--label", `shelter.project=${projectId}`,
      "--label", `shelter.purpose=${PROJECT_NETWORK_PURPOSE}`,
      networkName
    ], { allowFailure: true });
    // A concurrent reconciliation may have won the create race. Ownership is
    // always verified after creation instead of trusting the command result.
    labels = await inspectNetworkLabels(networkName, command);
    if (!labels) throw new Error(`Docker-Netzwerk ${networkName} konnte nicht angelegt werden`);
  }
  assertOwnedProjectNetwork(labels, networkName, projectId);
  return networkName;
}

async function inspectedContainerNetworks(
  container: string,
  command: ProjectNetworkCommandRunner
): Promise<Record<string, unknown> | null> {
  const result = await command("docker", [
    "inspect", "--format", "{{json .NetworkSettings.Networks}}", container
  ], { allowFailure: true });
  if (result.exitCode !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim();
    if (isMissingContainer(detail)) return null;
    throw new Error(`Container ${container} konnte für die Netzwerkprüfung nicht gelesen werden: ${detail || `Exit ${result.exitCode}`}`);
  }
  return parseJsonObject(result.stdout, "Container-Netzwerke");
}

export async function ensureContainerOnProjectNetwork(
  projectId: string,
  container: string,
  command: ProjectNetworkCommandRunner = runCommand
): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) {
    throw new Error("Containername ist nicht sicher verwaltet");
  }
  const networkName = await ensureProjectNetwork(projectId, command);
  const before = await inspectedContainerNetworks(container, command);
  if (!before) throw new Error(`Container ${container} wurde für die Netzwerkzuordnung nicht gefunden`);
  if (Object.hasOwn(before, networkName)) return networkName;

  await command("docker", ["network", "connect", networkName, container], { allowFailure: true });
  const after = await inspectedContainerNetworks(container, command);
  if (!after || !Object.hasOwn(after, networkName)) {
    throw new Error(`Container ${container} konnte nicht sicher mit ${networkName} verbunden werden`);
  }
  return networkName;
}

export async function disconnectContainerFromNetwork(
  networkName: string,
  container: string,
  command: ProjectNetworkCommandRunner = runCommand
): Promise<void> {
  const before = await inspectedContainerNetworks(container, command);
  if (!before || !Object.hasOwn(before, networkName)) return;
  await command("docker", ["network", "disconnect", "--force", networkName, container], { allowFailure: true });
  const after = await inspectedContainerNetworks(container, command);
  if (after && Object.hasOwn(after, networkName)) {
    throw new Error(`Container ${container} konnte nicht von ${networkName} getrennt werden`);
  }
}

export async function runningTraefikContainerIds(
  command: ProjectNetworkCommandRunner = runCommand
): Promise<string[]> {
  const identity = await inspectTraefikContainer(command);
  return identity?.running ? [identity.id] : [];
}

async function allTraefikContainerIds(
  command: ProjectNetworkCommandRunner
): Promise<string[]> {
  const identity = await inspectTraefikContainer(command);
  return identity ? [identity.id] : [];
}

async function inspectTraefikContainer(
  command: ProjectNetworkCommandRunner
): Promise<TraefikContainerIdentity | null> {
  const result = await command("docker", [
    "inspect", "--type", "container", "--format",
    '{"id":{{json .Id}},"name":{{json .Name}},"running":{{json .State.Running}},"labels":{{json .Config.Labels}}}',
    TRAEFIK_CONTAINER_NAME
  ], { allowFailure: true });
  if (result.exitCode !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim();
    if (isMissingContainer(detail)) return null;
    throw new Error(`Shelter-Traefik konnte nicht ermittelt werden: ${detail || `Exit ${result.exitCode}`}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonObject(result.stdout, "Traefik-Identität");
  } catch (error) {
    throw new Error(`Shelter-Traefik konnte nicht sicher verifiziert werden: ${error instanceof Error ? error.message : "ungültige Identität"}`);
  }
  const labels = parsed.labels;
  if (
    typeof parsed.id !== "string"
    || !/^[a-f0-9]{64}$/.test(parsed.id)
    || parsed.name !== `/${TRAEFIK_CONTAINER_NAME}`
    || typeof parsed.running !== "boolean"
    || !labels
    || typeof labels !== "object"
    || Array.isArray(labels)
    || (labels as Record<string, unknown>)["shelter.control-plane"] !== "traefik"
    || (labels as Record<string, unknown>)["com.docker.compose.project"] !== DOCKER_NAMESPACE
    || (labels as Record<string, unknown>)["com.docker.compose.service"] !== "traefik"
  ) {
    throw new Error("Shelter-Traefik konnte nicht sicher verifiziert werden: Identität oder Control-Plane-Labels stimmen nicht");
  }
  return { id: parsed.id, running: parsed.running };
}

export async function ensureTraefikOnProjectNetwork(
  projectId: string,
  command: ProjectNetworkCommandRunner = runCommand
): Promise<{ networkName: string; traefikIds: string[] }> {
  const networkName = await ensureProjectNetwork(projectId, command);
  const traefikIds = await runningTraefikContainerIds(command);
  if (traefikIds.length === 0) throw new Error("Kein laufender verwalteter Traefik-Container gefunden");
  for (const id of traefikIds) await ensureContainerOnProjectNetwork(projectId, id, command);
  return { networkName, traefikIds };
}

async function inspectNetworkEndpoints(
  networkName: string,
  command: ProjectNetworkCommandRunner
): Promise<Record<string, NetworkEndpoint> | null> {
  const result = await command("docker", [
    "network", "inspect", "--format", "{{json .Containers}}", networkName
  ], { allowFailure: true });
  if (result.exitCode !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim();
    if (isMissingNetwork(detail)) return null;
    throw new Error(`Docker-Netzwerk ${networkName} konnte nicht geprüft werden: ${detail || `Exit ${result.exitCode}`}`);
  }
  return parseJsonObject(result.stdout, "Netzwerk-Endpunkte") as Record<string, NetworkEndpoint>;
}

export async function removeProjectNetwork(
  projectId: string,
  command: ProjectNetworkCommandRunner = runCommand
): Promise<void> {
  const networkName = projectNetworkName(projectId);
  const labels = await inspectNetworkLabels(networkName, command);
  if (!labels) return;
  assertOwnedProjectNetwork(labels, networkName, projectId);

  for (const traefikId of await allTraefikContainerIds(command)) {
    await disconnectContainerFromNetwork(networkName, traefikId, command);
  }
  const endpoints = await inspectNetworkEndpoints(networkName, command);
  if (!endpoints) return;
  const remaining = Object.values(endpoints)
    .map((endpoint) => typeof endpoint?.Name === "string" ? endpoint.Name : "unknown")
    .filter(Boolean);
  if (remaining.length > 0) {
    throw new Error(`Projekt-Netzwerk ${networkName} hat unerwartete Endpunkte: ${remaining.join(", ")}`);
  }
  await command("docker", ["network", "rm", networkName]);
}
