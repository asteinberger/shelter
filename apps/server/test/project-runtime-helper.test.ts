import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureProjectContainerPreview,
  probeProjectContainer,
  type ProjectRuntimeHelperCommandRunner
} from "../src/services/project-runtime-helper.js";

const directories: string[] = [];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function input() {
  return {
    projectId: "prj_helper",
    deploymentId: "dep_helper",
    networkName: "shelter-prj-0123456789abcdefabcd",
    targetContainer: "shelter-run-helper",
    port: 3000,
    path: "/health",
    helperImage: "shelter/control-plane:local"
  };
}

function optionValue(args: string[], option: string): string {
  const index = args.indexOf(option);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value) throw new Error(`Missing ${option}`);
  return value;
}

function labelsFromRunArgs(args: string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--label") continue;
    const value = args[index + 1] ?? "";
    const separator = value.indexOf("=");
    if (separator !== -1) labels[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return labels;
}

function createOwnedHelperCommand(options: {
  runResult?: { stdout: string; stderr: string; exitCode: number };
} = {}) {
  const containers = new Map<string, { id: string; labels: Record<string, string> }>();
  const containerIds = new Map<string, string>();
  const runArgs: string[][] = [];
  const removedNames: string[] = [];
  let containerSequence = 0;
  const command = vi.fn<ProjectRuntimeHelperCommandRunner>(async (_binary, args) => {
    if (args[0] === "run") {
      const name = optionValue(args, "--name");
      runArgs.push(args);
      containerSequence += 1;
      const id = containerSequence.toString(16).padStart(64, "0");
      containers.set(name, {
        id,
        labels: labelsFromRunArgs(args)
      });
      containerIds.set(name, id);
      return options.runResult ?? { stdout: JSON.stringify({ status: 204 }), stderr: "", exitCode: 0 };
    }
    if (args[0] === "inspect") {
      const name = args.at(-1) ?? "";
      const container = containers.get(name);
      return container
        ? { stdout: JSON.stringify(container), stderr: "", exitCode: 0 }
        : { stdout: "", stderr: `Error: No such container: ${name}`, exitCode: 1 };
    }
    if (args[0] === "rm") {
      const id = args.at(-1) ?? "";
      const name = [...containers].find(([, container]) => container.id === id)?.[0] ?? "";
      removedNames.push(name);
      containers.delete(name);
      return { stdout: name, stderr: "", exitCode: 0 };
    }
    throw new Error(`Unexpected docker command: ${args.join(" ")}`);
  });
  return { command, containers, containerIds, runArgs, removedNames };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("isolated project runtime helpers", () => {
  it("runs health checks in a disposable project-network container with hard limits", async () => {
    const harness = createOwnedHelperCommand();

    await expect(probeProjectContainer(input(), harness.command)).resolves.toEqual({ ok: true, status: 204, detail: "HTTP 204" });
    const runArgs = harness.runArgs[0] ?? [];
    expect(runArgs).toEqual(expect.arrayContaining([
      "--network", input().networkName,
      "--read-only",
      "--memory", "96m",
      "--memory-swap", "96m",
      "--cpus", "0.25",
      "--pids-limit", "64",
      "--cap-drop", "ALL",
      "--pull", "never"
    ]));
    expect(runArgs).not.toContain("/var/run/docker.sock");
    expect(labelsFromRunArgs(runArgs)).toMatchObject({
      "shelter.managed": "true",
      "shelter.project": input().projectId,
      "shelter.deployment": input().deploymentId,
      "shelter.helper": "probe"
    });
    expect(labelsFromRunArgs(runArgs)["shelter.invocation"]).toMatch(/^[a-f0-9]{32}$/);
    expect(harness.command.mock.calls.map(([, args]) => args[0])).toEqual(["run", "inspect", "rm"]);
    expect(harness.command.mock.calls.at(-1)?.[1]?.slice(0, 3)).toEqual(["rm", "-f", "-v"]);
  });

  it("treats malformed probe output as unhealthy and still removes the verified helper", async () => {
    const harness = createOwnedHelperCommand({
      runResult: { stdout: "not-json", stderr: "", exitCode: 0 }
    });
    await expect(probeProjectContainer(input(), harness.command)).resolves.toMatchObject({ ok: false });
    expect(harness.command.mock.calls.map(([, args]) => args[0])).toEqual(["run", "inspect", "rm"]);
  });

  it("uses independent names and invocation labels for concurrent helpers", async () => {
    const harness = createOwnedHelperCommand();

    await Promise.all([
      probeProjectContainer(input(), harness.command),
      probeProjectContainer(input(), harness.command)
    ]);

    expect(harness.runArgs).toHaveLength(2);
    const names = harness.runArgs.map((args) => optionValue(args, "--name"));
    const invocations = harness.runArgs.map((args) => labelsFromRunArgs(args)["shelter.invocation"]);
    expect(new Set(names).size).toBe(2);
    expect(new Set(invocations).size).toBe(2);
    expect(harness.removedNames.sort()).toEqual([...names].sort());
    for (const name of names) {
      const runIndex = harness.command.mock.calls.findIndex(([, args]) => args[0] === "run" && args.includes(name));
      const inspectIndex = harness.command.mock.calls.findIndex(([, args]) => args[0] === "inspect" && args.includes(name));
      const removeIndex = harness.command.mock.calls.findIndex(([, args]) => (
        args[0] === "rm" && args.at(-1) === harness.containerIds.get(name)
      ));
      expect(runIndex).toBeGreaterThanOrEqual(0);
      expect(inspectIndex).toBeGreaterThan(runIndex);
      expect(removeIndex).toBeGreaterThan(inspectIndex);
    }
  });

  it("never deletes a foreign container on a helper-name collision and fails closed", async () => {
    let collidingName = "";
    let foreignLabels: Record<string, string> = {};
    const command = vi.fn<ProjectRuntimeHelperCommandRunner>(async (_binary, args) => {
      if (args[0] === "run") {
        collidingName = optionValue(args, "--name");
        foreignLabels = {
          ...labelsFromRunArgs(args),
          "shelter.project": "prj_somebody_else"
        };
        return { stdout: "", stderr: "container name is already in use", exitCode: 125 };
      }
      if (args[0] === "inspect") {
        expect(args.at(-1)).toBe(collidingName);
        return {
          stdout: JSON.stringify({ id: "f".repeat(64), labels: foreignLabels }),
          stderr: "",
          exitCode: 0
        };
      }
      if (args[0] === "rm") throw new Error("foreign container must never be removed");
      throw new Error(`Unexpected docker command: ${args.join(" ")}`);
    });

    await expect(probeProjectContainer(input(), command)).rejects.toThrow(/gehört nicht zu diesem Shelter-Aufruf/);
    expect(command.mock.calls.some(([, args]) => args[0] === "rm")).toBe(false);
  });

  it("preserves a path query as URL search instead of encoding the question mark", async () => {
    const harness = createOwnedHelperCommand();
    await probeProjectContainer({
      ...input(),
      path: "/health/ready?deep=1&mode=strict"
    }, harness.command);

    const target = harness.runArgs[0]?.at(-1);
    expect(target).toBe("http://shelter-run-helper:3000/health/ready?deep=1&mode=strict");
    expect(target).not.toContain("%3F");
  });

  it("captures a bounded PNG through stdout without mounting host data", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-helper-preview-"));
    directories.push(directory);
    const outputPath = path.join(directory, "preview.png");
    const controller = new AbortController();
    const harness = createOwnedHelperCommand({
      runResult: { stdout: PNG.toString("base64"), stderr: "", exitCode: 0 }
    });

    await expect(captureProjectContainerPreview({
      ...input(),
      outputPath,
      chromiumPath: "/usr/bin/chromium-browser",
      signal: controller.signal
    }, harness.command)).resolves.toBe("ready");
    const runArgs = harness.runArgs[0] ?? [];
    expect(runArgs).toEqual(expect.arrayContaining([
      "--network", input().networkName,
      "--read-only",
      "--env", "HOME=/tmp",
      "--env", "XDG_CONFIG_HOME=/tmp",
      "--env", "XDG_CACHE_HOME=/tmp",
      "--memory", "512m",
      "--pids-limit", "256"
    ]));
    const previewScript = runArgs[runArgs.indexOf("-e") + 1] ?? "";
    expect(previewScript).toContain('"--disable-crash-reporter"');
    expect(previewScript).toContain('"--disable-breakpad"');
    expect(runArgs.some((value) => value.includes(`${directory}:`))).toBe(false);
    expect(harness.command.mock.calls.some(([, args]) => args[0] === "cp")).toBe(false);
    expect(harness.command.mock.calls[0]?.[2]).toMatchObject({
      allowFailure: true,
      signal: controller.signal,
      maxOutputChars: expect.any(Number)
    });
    expect(fs.readFileSync(outputPath)).toEqual(PNG);
  });

  it("does not copy a screenshot for non-HTML responses", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-helper-non-html-"));
    directories.push(directory);
    const outputPath = path.join(directory, "preview.png");
    const harness = createOwnedHelperCommand({
      runResult: { stdout: "", stderr: "", exitCode: 40 }
    });

    await expect(captureProjectContainerPreview({
      ...input(),
      outputPath,
      chromiumPath: "/usr/bin/chromium-browser"
    }, harness.command)).resolves.toBe("not_html");
    expect(harness.command.mock.calls.some(([, args]) => args[0] === "cp")).toBe(false);
    expect(harness.command.mock.calls.map(([, args]) => args[0])).toEqual(["run", "inspect", "rm"]);
  });
});
