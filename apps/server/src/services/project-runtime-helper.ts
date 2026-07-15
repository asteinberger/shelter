import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { CommandOptions, CommandResult } from "../lib/command.js";
import { runCommand } from "../lib/command.js";
import { isDockerDnsLabel } from "./runtime-identity.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

const HEALTH_PROBE_SCRIPT = String.raw`
const target = process.argv[1];
try {
  const response = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(2500) });
  await response.body?.cancel();
  process.stdout.write(JSON.stringify({ status: response.status }));
  process.exit(response.status >= 200 && response.status < 400 ? 0 : 22);
} catch {
  process.stderr.write(JSON.stringify({ error: "unreachable" }));
  process.exit(23);
}
`;

const PREVIEW_SCRIPT = String.raw`
const { spawn } = await import("node:child_process");
const fs = await import("node:fs/promises");
const target = process.argv[1];
const chromium = process.argv[2];
try {
  const response = await fetch(target, {
    headers: { accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(5000)
  });
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  await response.body?.cancel();
  if (!response.ok || !contentType.includes("text/html")) process.exit(40);
} catch {
  process.exit(41);
}
const args = [
  "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
  "--hide-scrollbars", "--mute-audio", "--disable-extensions", "--disable-background-networking",
  "--user-data-dir=/tmp/chromium", "--window-size=1440,900", "--force-device-scale-factor=1",
  "--virtual-time-budget=4000", "--screenshot=/tmp/preview.png", target
];
const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(chromium, args, { stdio: "ignore" });
  child.once("error", reject);
  child.once("close", (code) => resolve(code ?? 1));
});
if (exitCode !== 0) process.exit(42);
const image = await fs.readFile("/tmp/preview.png");
const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (image.length < signature.length || !image.subarray(0, signature.length).equals(signature)) process.exit(43);
`;

export type ProjectRuntimeHelperCommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions
) => Promise<CommandResult>;

interface HelperTarget {
  projectId: string;
  deploymentId: string;
  networkName: string;
  targetContainer: string;
  port: number;
  path: string;
  helperImage: string;
  signal?: AbortSignal;
}

export interface HealthProbeResult {
  ok: boolean;
  status?: number;
  detail: string;
}

export type PreviewCaptureResult = "ready" | "not_html" | "capture_failed";

interface HelperIdentity {
  name: string;
  invocation: string;
  kind: "probe" | "preview";
}

function helperIdentity(kind: "probe" | "preview", deploymentId: string): HelperIdentity {
  const deploymentToken = createHash("sha256").update(deploymentId).digest("hex").slice(0, 12);
  const invocation = randomBytes(16).toString("hex");
  return {
    name: `shelter-${kind}-${deploymentToken}-${invocation.slice(0, 16)}`,
    invocation,
    kind
  };
}

function targetUrl(input: HelperTarget): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.projectId)) throw new Error("Projekt-ID ist nicht sicher verwaltet");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.deploymentId)) throw new Error("Deployment-ID ist nicht sicher verwaltet");
  if (!/^shelter-prj-[a-f0-9]{20}$/.test(input.networkName)) throw new Error("Projekt-Netzwerk ist nicht sicher verwaltet");
  if (!isDockerDnsLabel(input.targetContainer)) throw new Error("Zielcontainer ist kein sicherer Docker-DNS-Name");
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error("Zielport ist ungültig");
  if (!input.path.startsWith("/") || /[\r\n]/.test(input.path)) throw new Error("Zielpfad ist ungültig");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(input.helperImage)) throw new Error("Helper-Image ist ungültig");
  const url = new URL(`http://${input.targetContainer}:${input.port}`);
  const queryIndex = input.path.indexOf("?");
  url.pathname = queryIndex === -1 ? input.path : input.path.slice(0, queryIndex);
  url.search = queryIndex === -1 ? "" : input.path.slice(queryIndex);
  return url.toString();
}

function commonHelperArgs(input: HelperTarget, helper: HelperIdentity): string[] {
  return [
    "run", "--name", helper.name,
    "--pull", "never",
    "--network", input.networkName,
    "--restart", "no",
    "--read-only",
    "--security-opt", "no-new-privileges:true",
    "--cap-drop", "ALL",
    "--label", "shelter.managed=true",
    "--label", `shelter.project=${input.projectId}`,
    "--label", `shelter.deployment=${input.deploymentId}`,
    "--label", `shelter.helper=${helper.kind}`,
    "--label", `shelter.invocation=${helper.invocation}`
  ];
}

function isMissingContainer(result: CommandResult): boolean {
  return /no such (?:object|container)(?::|\s)/i.test(`${result.stdout}\n${result.stderr}`);
}

async function removeOwnedHelper(
  input: HelperTarget,
  helper: HelperIdentity,
  command: ProjectRuntimeHelperCommandRunner
): Promise<void> {
  const inspected = await command("docker", [
    "inspect", "--type", "container", "--format",
    '{"id":{{json .Id}},"labels":{{json .Config.Labels}}}', helper.name
  ], { allowFailure: true });
  if (inspected.exitCode !== 0) {
    if (isMissingContainer(inspected)) return;
    throw new Error(`Helper-Container konnte vor dem Cleanup nicht sicher verifiziert werden: ${inspected.stderr || inspected.stdout || `exit ${inspected.exitCode}`}`);
  }

  let containerId: string;
  let labels: Record<string, unknown>;
  try {
    const parsed = JSON.parse(inspected.stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("inspect result is not an object");
    const record = parsed as Record<string, unknown>;
    if (typeof record.id !== "string" || !/^[a-f0-9]{64}$/.test(record.id)) throw new Error("invalid container id");
    if (!record.labels || typeof record.labels !== "object" || Array.isArray(record.labels)) throw new Error("labels are not an object");
    containerId = record.id;
    labels = record.labels as Record<string, unknown>;
  } catch {
    throw new Error("Helper-Container konnte vor dem Cleanup nicht sicher verifiziert werden: ungültige Docker-Labels");
  }

  const expectedLabels: Record<string, string> = {
    "shelter.managed": "true",
    "shelter.project": input.projectId,
    "shelter.deployment": input.deploymentId,
    "shelter.helper": helper.kind,
    "shelter.invocation": helper.invocation
  };
  if (Object.entries(expectedLabels).some(([key, value]) => labels[key] !== value)) {
    throw new Error("Helper-Container gehört nicht zu diesem Shelter-Aufruf und wird nicht gelöscht");
  }

  const removed = await command("docker", ["rm", "-f", "-v", containerId], { allowFailure: true });
  if (removed.exitCode !== 0 && !isMissingContainer(removed)) {
    throw new Error(`Verifizierter Helper-Container konnte nicht entfernt werden: ${removed.stderr || removed.stdout || `exit ${removed.exitCode}`}`);
  }
}

export async function probeProjectContainer(
  input: HelperTarget,
  command: ProjectRuntimeHelperCommandRunner = runCommand
): Promise<HealthProbeResult> {
  const url = targetUrl(input);
  const helper = helperIdentity("probe", input.deploymentId);
  try {
    const result = await command("docker", [
      ...commonHelperArgs(input, helper),
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
      "--memory", "96m",
      "--memory-swap", "96m",
      "--cpus", "0.25",
      "--pids-limit", "64",
      input.helperImage,
      "node", "--input-type=module", "-e", HEALTH_PROBE_SCRIPT, url
    ], {
      allowFailure: true,
      timeoutMs: 4_000,
      ...(input.signal ? { signal: input.signal } : {})
    });
    let status: number | undefined;
    try {
      const parsed = JSON.parse(result.stdout) as { status?: unknown };
      if (typeof parsed.status === "number" && Number.isInteger(parsed.status)) status = parsed.status;
    } catch {
      // Invalid output is treated as an unhealthy probe below.
    }
    return {
      ok: result.exitCode === 0 && status !== undefined && status >= 200 && status < 400,
      ...(status !== undefined ? { status } : {}),
      detail: status !== undefined ? `HTTP ${status}` : (result.stderr || `Probe exit ${result.exitCode}`)
    };
  } finally {
    await removeOwnedHelper(input, helper, command);
  }
}

export async function captureProjectContainerPreview(
  input: HelperTarget & { outputPath: string; chromiumPath: string },
  command: ProjectRuntimeHelperCommandRunner = runCommand
): Promise<PreviewCaptureResult> {
  const url = targetUrl(input);
  if (!input.chromiumPath.startsWith("/") || /[\r\n]/.test(input.chromiumPath)) throw new Error("Chromium-Pfad ist ungültig");
  const helper = helperIdentity("preview", input.deploymentId);
  await fs.promises.mkdir(path.dirname(input.outputPath), { recursive: true, mode: 0o700 });
  await fs.promises.rm(input.outputPath, { force: true });
  try {
    const result = await command("docker", [
      ...commonHelperArgs(input, helper),
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
      "--memory", "512m",
      "--memory-swap", "512m",
      "--cpus", "0.75",
      "--pids-limit", "256",
      input.helperImage,
      "node", "--input-type=module", "-e", PREVIEW_SCRIPT, url, input.chromiumPath
    ], {
      allowFailure: true,
      timeoutMs: 30_000,
      ...(input.signal ? { signal: input.signal } : {})
    });
    if (result.exitCode === 40) return "not_html";
    if (result.exitCode !== 0) return "capture_failed";
    const copied = await command("docker", ["cp", `${helper.name}:/tmp/preview.png`, input.outputPath], {
      allowFailure: true,
      ...(input.signal ? { signal: input.signal } : {})
    });
    if (copied.exitCode !== 0) return "capture_failed";
    const stat = await fs.promises.stat(input.outputPath).catch(() => null);
    if (!stat?.isFile() || stat.size < PNG_SIGNATURE.length || stat.size > MAX_PREVIEW_BYTES) return "capture_failed";
    const file = await fs.promises.open(input.outputPath, "r");
    try {
      const signature = Buffer.alloc(PNG_SIGNATURE.length);
      const { bytesRead } = await file.read(signature, 0, signature.length, 0);
      if (bytesRead !== PNG_SIGNATURE.length || !signature.equals(PNG_SIGNATURE)) return "capture_failed";
    } finally {
      await file.close();
    }
    return "ready";
  } finally {
    await removeOwnedHelper(input, helper, command);
  }
}
