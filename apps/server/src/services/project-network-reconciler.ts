import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import {
  disconnectContainerFromNetwork,
  ensureContainerOnProjectNetwork,
  ensureTraefikOnProjectNetwork,
  projectNetworkName,
  type ProjectNetworkCommandRunner
} from "./project-network.js";
import { managedProjectIdForContainer, MANAGED_LABEL_NAMESPACES } from "./runtime-identity.js";

type NetworkConfig = Pick<AppConfig, "RUNTIME_NETWORK">;

interface ProjectIdRow {
  id: string;
}

export class ProjectNetworkReconciler {
  constructor(
    private readonly config: NetworkConfig,
    private readonly database: Pick<Database, "sqlite">,
    private readonly command: ProjectNetworkCommandRunner
  ) {}

  private projectIds(): string[] {
    return (this.database.sqlite.prepare("SELECT id FROM projects ORDER BY id").all() as ProjectIdRow[])
      .map((row) => row.id);
  }

  private async managedProjectContainerIds(projectId: string): Promise<string[]> {
    const candidates = new Set<string>();
    for (const namespace of MANAGED_LABEL_NAMESPACES) {
      const result = await this.command("docker", [
        "ps", "-aq",
        "--filter", `label=${namespace}.managed=true`,
        "--filter", `label=${namespace}.project=${projectId}`
      ], { allowFailure: true });
      if (result.exitCode !== 0) {
        throw new Error(`Verwaltete Container für Projekt ${projectId} konnten nicht sicher ermittelt werden: ${result.stderr || `Exit ${result.exitCode}`}`);
      }
      for (const id of result.stdout.split("\n").map((value) => value.trim()).filter(Boolean)) candidates.add(id);
    }
    const ids: string[] = [];
    for (const id of candidates) {
      const inspected = await this.command("docker", [
        "inspect", "--type", "container", "--format",
        '{"name":{{json .Name}},"image":{{json .Config.Image}},"labels":{{json .Config.Labels}}}', id
      ], { allowFailure: true });
      if (inspected.exitCode !== 0) {
        throw new Error(`Container ${id} konnte vor der Projekt-Netzwerkzuordnung nicht verifiziert werden: ${inspected.stderr || `Exit ${inspected.exitCode}`}`);
      }
      let identity: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(inspected.stdout);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid identity");
        identity = parsed as Record<string, unknown>;
      } catch {
        throw new Error(`Container ${id} hat eine ungültige Docker-Identität`);
      }
      if (
        typeof identity.name !== "string"
        || typeof identity.image !== "string"
        || !identity.labels
        || typeof identity.labels !== "object"
        || Array.isArray(identity.labels)
      ) throw new Error(`Container ${id} hat eine unvollständige Docker-Identität`);
      const owner = managedProjectIdForContainer(
        identity.labels as Record<string, unknown>,
        identity.name,
        identity.image
      );
      if (owner !== projectId) continue;
      ids.push(id);
    }
    return ids;
  }

  async prepareProject(projectId: string): Promise<string> {
    const { networkName } = await ensureTraefikOnProjectNetwork(projectId, this.command);
    return networkName;
  }

  async prepareRuntime(projectId: string, container: string): Promise<string> {
    // Keep the legacy network attached until both the runtime and Traefik have
    // verified project-network attachments. This makes migration additive and
    // avoids dropping a live route halfway through reconciliation.
    const networkName = await ensureContainerOnProjectNetwork(projectId, container, this.command);
    await ensureTraefikOnProjectNetwork(projectId, this.command);
    if (this.config.RUNTIME_NETWORK !== networkName) {
      await disconnectContainerFromNetwork(this.config.RUNTIME_NETWORK, container, this.command);
    }
    return networkName;
  }

  async reconcileAll(): Promise<void> {
    for (const projectId of this.projectIds()) {
      const containers = await this.managedProjectContainerIds(projectId);
      if (containers.length === 0) continue;
      for (const container of containers) await this.prepareRuntime(projectId, container);
    }
  }

  networkName(projectId: string): string {
    return projectNetworkName(projectId);
  }
}
