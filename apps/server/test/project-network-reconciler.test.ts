import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { ProjectNetworkReconciler } from "../src/services/project-network-reconciler.js";
import { projectNetworkName, type ProjectNetworkCommandRunner } from "../src/services/project-network.js";
import type { ProjectRow } from "../src/types/models.js";

const directories: string[] = [];
const databases: Database[] = [];

function project(id: string): ProjectRow {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    slug: id.replaceAll("_", "-"),
    source_type: "git",
    repository_url: "https://github.com/example/project.git",
    repository_branch: "main",
    source_archive: null,
    static_base_path: null,
    root_directory: ".",
    build_type: "auto",
    dockerfile_path: "Dockerfile",
    port: 3000,
    healthcheck_path: "/",
    memory_limit: "1g",
    cpu_limit: "1.0",
    active_deployment_id: null,
    created_at: now,
    updated_at: now
  };
}

function context() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-network-reconcile-"));
  directories.push(directory);
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: directory,
    WEB_DIST: path.join(directory, "missing"),
    APP_SECRET: "n".repeat(64),
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "correct horse battery staple",
    LOG_LEVEL: "silent"
  });
  const database = new Database(config);
  databases.push(database);
  return { config, database };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) if (database.sqlite.open) database.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("project network reconciliation", () => {
  it("migrates every managed project container additively before leaving the legacy network", async () => {
    const { config, database } = context();
    const first = project("prj_first");
    const second = project("prj_second");
    const traefikId = "f".repeat(64);
    const firstRuntime = "shelter-run-first";
    const secondRuntime = "shelter-run-second";
    database.createProject(first);
    database.createProject(second);
    const networks = new Map<string, Set<string>>([
      [firstRuntime, new Set([config.RUNTIME_NETWORK])],
      [secondRuntime, new Set([config.RUNTIME_NETWORK])],
      [traefikId, new Set(["shelter-control", config.RUNTIME_NETWORK])]
    ]);
    const labels = new Map<string, Record<string, string>>();
    const calls: string[][] = [];
    const command: ProjectNetworkCommandRunner = vi.fn(async (_binary: string, args: string[]) => {
      calls.push([...args]);
      if (args[0] === "ps" && args.includes(`label=shelter.project=${first.id}`)) {
        return { stdout: firstRuntime, stderr: "", exitCode: 0 };
      }
      if (args[0] === "ps" && args.includes(`label=shelter.project=${second.id}`)) {
        return { stdout: secondRuntime, stderr: "", exitCode: 0 };
      }
      if (args[0] === "inspect" && args.at(-1) === "shelter-traefik" && args.includes("--type")) {
        return {
          stdout: JSON.stringify({
            id: traefikId,
            name: "/shelter-traefik",
            running: true,
            labels: {
              "shelter.control-plane": "traefik",
              "com.docker.compose.project": "shelter",
              "com.docker.compose.service": "traefik"
            }
          }),
          stderr: "",
          exitCode: 0
        };
      }
      if (args[0] === "inspect" && args.some((value) => value.includes('"name"'))) {
        const container = args.at(-1)!;
        const owner = container === firstRuntime ? first.id : second.id;
        return {
          stdout: JSON.stringify({
            name: `/${container}`,
            image: `shelter/${owner}:latest`,
            labels: { "shelter.managed": "true", "shelter.project": owner }
          }),
          stderr: "",
          exitCode: 0
        };
      }
      if (args[0] === "network" && args[1] === "inspect" && args.includes("{{json .Labels}}")) {
        const network = args.at(-1)!;
        const value = labels.get(network);
        return value
          ? { stdout: JSON.stringify(value), stderr: "", exitCode: 0 }
          : { stdout: "", stderr: `Error response from daemon: network ${network} not found`, exitCode: 1 };
      }
      if (args[0] === "network" && args[1] === "create") {
        const network = args.at(-1)!;
        const projectLabel = args.find((value) => value.startsWith("shelter.project="))!;
        labels.set(network, {
          "shelter.managed": "true",
          "shelter.project": projectLabel.slice("shelter.project=".length),
          "shelter.purpose": "project"
        });
        return { stdout: network, stderr: "", exitCode: 0 };
      }
      if (args[0] === "inspect" && args.includes("{{json .NetworkSettings.Networks}}")) {
        const container = args.at(-1)!;
        const attached = networks.get(container);
        if (!attached) return { stdout: "", stderr: `Error: No such object: ${container}`, exitCode: 1 };
        return { stdout: JSON.stringify(Object.fromEntries([...attached].map((network) => [network, {}]))), stderr: "", exitCode: 0 };
      }
      if (args[0] === "network" && args[1] === "connect") {
        networks.get(args[3]!)?.add(args[2]!);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args[0] === "network" && args[1] === "disconnect") {
        networks.get(args[4]!)?.delete(args[3]!);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    await new ProjectNetworkReconciler(config, database, command).reconcileAll();

    expect(networks.get(firstRuntime)).toEqual(new Set([projectNetworkName(first.id)]));
    expect(networks.get(secondRuntime)).toEqual(new Set([projectNetworkName(second.id)]));
    expect(networks.get(traefikId)).toEqual(new Set([
      "shelter-control",
      config.RUNTIME_NETWORK,
      projectNetworkName(first.id),
      projectNetworkName(second.id)
    ]));
    for (const container of [firstRuntime, secondRuntime]) {
      const connectIndex = calls.findIndex((args) => args[0] === "network" && args[1] === "connect" && args.at(-1) === container);
      const disconnectIndex = calls.findIndex((args) => args[0] === "network" && args[1] === "disconnect" && args.at(-1) === container);
      expect(connectIndex).toBeGreaterThan(-1);
      expect(disconnectIndex).toBeGreaterThan(connectIndex);
    }
  });

  it("does not create empty networks for projects without managed containers", async () => {
    const { config, database } = context();
    database.createProject(project("prj_empty"));
    const command = vi.fn<ProjectNetworkCommandRunner>(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    await new ProjectNetworkReconciler(config, database, command).reconcileAll();
    expect(command.mock.calls.some(([, args]) => args[0] === "network" && args[1] === "create")).toBe(false);
  });

  it("fails startup reconciliation closed when managed containers cannot be listed", async () => {
    const { config, database } = context();
    database.createProject(project("prj_docker_down"));
    const command = vi.fn<ProjectNetworkCommandRunner>(async () => ({
      stdout: "",
      stderr: "Cannot connect to the Docker daemon",
      exitCode: 1
    }));
    await expect(new ProjectNetworkReconciler(config, database, command).reconcileAll())
      .rejects.toThrow(/konnten nicht sicher ermittelt werden/);
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("ignores forged legacy ownership when current Shelter ownership points elsewhere", async () => {
    const { config, database } = context();
    const victim = project("prj_victim");
    database.createProject(victim);
    const command = vi.fn<ProjectNetworkCommandRunner>(async (_binary, args) => {
      if (args[0] === "ps" && args.includes(`label=portsmith.project=${victim.id}`)) {
        return { stdout: "malicious-runtime", stderr: "", exitCode: 0 };
      }
      if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0 };
      if (args[0] === "inspect" && args.some((value) => value.includes('"name"'))) {
        return {
          stdout: JSON.stringify({
            name: "/shelter-run-attacker",
            image: "shelter/attacker:latest",
            labels: {
              "shelter.managed": "true",
              "shelter.project": "prj_attacker",
              "portsmith.managed": "true",
              "portsmith.project": victim.id
            }
          }),
          stderr: "",
          exitCode: 0
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    await expect(new ProjectNetworkReconciler(config, database, command).reconcileAll()).resolves.toBeUndefined();
    expect(command.mock.calls.some(([, args]) => args[0] === "network" && args[1] === "connect")).toBe(false);
  });

  it("uses real Portsmith identity over forged inherited Shelter labels", async () => {
    const { config, database } = context();
    const victim = project("prj_victim_legacy_spoof");
    database.createProject(victim);
    const command = vi.fn<ProjectNetworkCommandRunner>(async (_binary, args) => {
      if (args[0] === "ps" && args.includes(`label=shelter.project=${victim.id}`)) {
        return { stdout: "portsmith-app-attacker", stderr: "", exitCode: 0 };
      }
      if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0 };
      if (args[0] === "inspect" && args.some((value) => value.includes('"name"'))) {
        return {
          stdout: JSON.stringify({
            name: "/portsmith-app-attacker",
            image: "portsmith/attacker:latest",
            labels: {
              "shelter.managed": "true",
              "shelter.project": victim.id,
              "portsmith.managed": "true",
              "portsmith.project": "prj_attacker"
            }
          }),
          stderr: "",
          exitCode: 0
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    await expect(new ProjectNetworkReconciler(config, database, command).reconcileAll()).resolves.toBeUndefined();
    expect(command.mock.calls.some(([, args]) => args[0] === "network" && args[1] === "connect")).toBe(false);
  });
});
