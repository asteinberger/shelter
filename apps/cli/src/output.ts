import type { Deployment, DeploymentLog, Domain, Project, TokenIdentity } from "./types.js";

function text(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function date(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function table(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const normalized = rows.map((row) => row.map(text));
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...normalized.map((row) => row[index]?.length ?? 0)
  ));
  const line = (row: readonly string[]): string => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  if (normalized.length === 0) return "No results.";
  return [line(headers), line(widths.map((width) => "─".repeat(width))), ...normalized.map(line)].join("\n");
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printProjects(projects: Project[]): void {
  process.stdout.write(`${table(
    ["ID", "NAME", "STATUS", "SOURCE", "DOMAIN"],
    projects.map((project) => [
      project.id,
      project.name,
      project.status,
      project.sourceType,
      project.domains?.find((domain) => domain.status === "active")?.hostname
    ])
  )}\n`);
}

export function printProject(project: Project): void {
  const lines = [
    ["ID", project.id],
    ["Name", project.name],
    ["Status", project.status],
    ["Source", project.sourceType],
    ["Repository", project.repositoryUrl],
    ["Branch", project.repositoryBranch],
    ["Build type", project.buildType],
    ["Root directory", project.rootDirectory],
    ["Base path", project.staticBasePath],
    ["Updated", date(project.updatedAt)]
  ];
  process.stdout.write(`${lines.map(([label, value]) => `${label}: ${text(value)}`).join("\n")}\n`);
  if (project.domains?.length) {
    process.stdout.write(`\nDomains\n${formatDomains(project.domains)}\n`);
  }
}

export function printDeployment(deployment: Deployment): void {
  const details = [
    ["Deployment", deployment.id],
    ["Project", deployment.projectId],
    ["Status", deployment.status],
    ["Source", deployment.sourceRef],
    ["Runtime", deployment.runtimeDescription ?? deployment.runtimeKind],
    ["Commit", deployment.commitSha?.slice(0, 12)],
    ["Created", date(deployment.createdAt)],
    ["Duration", deployment.durationSeconds === null ? null : `${deployment.durationSeconds}s`],
    ...(deployment.failureKind ? [["Failure kind", deployment.failureKind]] : []),
    ...(deployment.rollbackStatus && deployment.rollbackStatus !== "not_required"
      ? [["Safety rollback", deployment.rollbackStatus]]
      : []),
    ...(deployment.rollbackDeploymentId ? [["Restored deployment", deployment.rollbackDeploymentId]] : []),
    ...(deployment.cancelRequestedAt ? [["Cancel requested", date(deployment.cancelRequestedAt)]] : []),
    ["Error", deployment.error]
  ];
  process.stdout.write(`${details.map(([label, value]) => `${label}: ${text(value)}`).join("\n")}\n`);
}

function formatDomains(domains: Domain[]): string {
  return table(
    ["ID", "HOSTNAME", "STATUS", "ERROR"],
    domains.map((domain) => [domain.id, domain.hostname, domain.status, domain.error])
  );
}

export function printDomains(domains: Domain[]): void {
  process.stdout.write(`${formatDomains(domains)}\n`);
}

export function printLogs(logs: DeploymentLog[]): void {
  for (const log of logs) {
    process.stdout.write(`${date(log.createdAt)}  ${log.stream.padEnd(6)}  ${log.message}\n`);
  }
}

export function printIdentity(identity: TokenIdentity, serverUrl: string): void {
  const token = identity.authentication.token;
  const details = [
    ["Server", serverUrl],
    ["User", identity.user?.email],
    ["Authentication", identity.authentication.type],
    ["Token name", token?.name],
    ["Scopes", token?.scopes.join(", ")]
  ];
  process.stdout.write(`${details.map(([label, value]) => `${label}: ${text(value)}`).join("\n")}\n`);
}
