#!/usr/bin/env node
import { ApiError, ShelterClient } from "./api.js";
import {
  parseGlobalArguments,
  parseOptions,
  requiredOption,
  requirePositionals
} from "./arguments.js";
import {
  configPaths,
  deleteConfig,
  normalizeServerUrl,
  resolveCredentials,
  writeConfig
} from "./config.js";
import { followDeploymentLogs, uploadArchive, waitForDeployment } from "./operations.js";
import {
  printDeployment,
  printDomains,
  printIdentity,
  printJson,
  printLogs,
  printProject,
  printProjects
} from "./output.js";
import { readHidden, readTokenFromStdin } from "./prompt.js";
import type { Deployment, DeploymentLog, Domain, Project, TokenIdentity } from "./types.js";

export const VERSION = "0.1.0";

const HELP = `Shelter CLI ${VERSION}

Usage:
  shelter [--json] <command> [options]

Authentication:
  login --server <url> [--token-stdin]  Connect to a Shelter installation
  logout                                 Remove locally stored credentials
  whoami                                 Show the active API identity

Projects and deployments:
  projects                               List projects
  project <project-id>                   Show a project
  create git --name <name> --repository <url> [--branch <branch>]
  deploy <project-id> [--wait]           Deploy the current source
  cancel <deployment-id>                 Cancel a queued or running deployment
  rollback <deployment-id> [--wait]      Restore a previous ready deployment
  logs <deployment-id> [--follow]        Read deployment logs
  upload <project-id> <archive.zip> [--wait]

Domains:
  domains <project-id>                   List project domains
  domain add <project-id> <hostname> --zone <zone-id>
  domain remove <project-id> <domain-id>

Global options:
  --json       Print machine-readable JSON (follow mode uses NDJSON)
  --help, -h   Show help
  --version    Show the CLI version

Environment overrides:
  SHELTER_URL, SHELTER_TOKEN
`;

interface RunContext {
  json: boolean;
}

function progress(message: string, context: RunContext): void {
  if (!context.json) process.stderr.write(`${message}\n`);
}

function successfulDeployment(deployment: Deployment): boolean {
  return deployment.status === "ready";
}

async function authenticatedClient(): Promise<{ client: ShelterClient; serverUrl: string }> {
  const credentials = await resolveCredentials();
  return { client: new ShelterClient(credentials), serverUrl: credentials.serverUrl };
}

async function commandLogin(args: string[], context: RunContext): Promise<void> {
  const options = parseOptions(args, ["server"], ["token-stdin"]);
  requirePositionals(options, 0);
  const serverUrl = normalizeServerUrl(requiredOption(options, "server"));
  const token = options.flags.has("token-stdin")
    ? await readTokenFromStdin()
    : process.env.SHELTER_TOKEN?.trim() || await readHidden("API token: ");
  if (!token) throw new Error("The API token is required.");

  const client = new ShelterClient({ serverUrl, token });
  const identity = await client.request<TokenIdentity>("/api/api-tokens/current");
  if (identity.authentication.type !== "api_token") {
    throw new Error("The server did not authenticate this request with an API token.");
  }
  await writeConfig({ serverUrl, token });
  if (context.json) {
    printJson({ ok: true, serverUrl, user: identity.user, authentication: identity.authentication });
  } else {
    process.stdout.write(`Logged in to ${serverUrl} as ${identity.user?.email ?? "an API user"}.\n`);
  }
}

async function commandLogout(args: string[], context: RunContext): Promise<void> {
  const options = parseOptions(args);
  requirePositionals(options, 0);
  const removed = await deleteConfig(configPaths());
  if (context.json) printJson({ ok: true, removed });
  else process.stdout.write(removed ? "Local Shelter credentials removed.\n" : "No local Shelter credentials were stored.\n");
  if (process.env.SHELTER_TOKEN || process.env.SHELTER_URL) {
    process.stderr.write("Environment overrides remain active for this shell.\n");
  }
}

async function commandWhoami(args: string[], context: RunContext): Promise<void> {
  const options = parseOptions(args);
  requirePositionals(options, 0);
  const { client, serverUrl } = await authenticatedClient();
  const identity = await client.request<TokenIdentity>("/api/api-tokens/current");
  if (context.json) printJson({ serverUrl, ...identity });
  else printIdentity(identity, serverUrl);
}

async function commandProjects(args: string[], context: RunContext): Promise<void> {
  const options = parseOptions(args);
  requirePositionals(options, 0);
  const { client } = await authenticatedClient();
  const response = await client.request<{ projects: Project[] }>("/api/projects");
  if (context.json) printJson(response);
  else printProjects(response.projects);
}

async function commandProject(args: string[], context: RunContext): Promise<void> {
  const options = parseOptions(args);
  const [projectId] = requirePositionals(options, 1);
  const { client } = await authenticatedClient();
  const response = await client.request<{ project: Project }>(`/api/projects/${encodeURIComponent(projectId ?? "")}`);
  if (context.json) printJson(response);
  else printProject(response.project);
}

async function commandCreate(args: string[], context: RunContext): Promise<void> {
  const [source, ...rest] = args;
  if (source !== "git") throw new Error("Usage: shelter create git --name <name> --repository <url> [--branch <branch>]");
  const options = parseOptions(rest, ["name", "repository", "branch"]);
  requirePositionals(options, 0);
  const body: { name: string; repositoryUrl: string; branch?: string } = {
    name: requiredOption(options, "name"),
    repositoryUrl: requiredOption(options, "repository")
  };
  if (options.values.branch) body.branch = options.values.branch;
  const { client } = await authenticatedClient();
  const response = await client.request<{ project: Project; deployment: Deployment }>("/api/projects/git", {
    method: "POST",
    body
  });
  if (context.json) printJson(response);
  else {
    process.stdout.write(`Project created: ${response.project.name} (${response.project.id})\n`);
    printDeployment(response.deployment);
  }
}

async function waitAndPrint(client: ShelterClient, deployment: Deployment, context: RunContext): Promise<Deployment> {
  progress(`Deployment ${deployment.id} queued.`, context);
  const finished = await waitForDeployment(client, deployment.id, (current) => {
    progress(`Deployment status: ${current.status}`, context);
  });
  if (context.json) printJson({ deployment: finished });
  else printDeployment(finished);
  if (!successfulDeployment(finished)) process.exitCode = 1;
  return finished;
}

async function commandDeploy(args: string[], context: RunContext): Promise<void> {
  const options = parseOptions(args, [], ["wait"]);
  const [projectId] = requirePositionals(options, 1);
  const { client } = await authenticatedClient();
  const response = await client.request<{ deployment: Deployment }>(
    `/api/projects/${encodeURIComponent(projectId ?? "")}/deploy`,
    { method: "POST", body: {} }
  );
  if (options.flags.has("wait")) await waitAndPrint(client, response.deployment, context);
  else if (context.json) printJson(response);
  else printDeployment(response.deployment);
}

async function commandCancel(args: string[], context: RunContext): Promise<void> {
  const options = parseOptions(args);
  const [deploymentId] = requirePositionals(options, 1);
  const { client } = await authenticatedClient();
  const response = await client.request<{ deployment: Deployment }>(
    `/api/deployments/${encodeURIComponent(deploymentId ?? "")}/cancel`,
    { method: "POST" }
  );
  if (context.json) printJson(response);
  else {
    const requested = response.deployment.cancelRequestedAt && response.deployment.status !== "cancelled";
    process.stdout.write(requested
      ? `Cancellation requested for ${response.deployment.id}.\n`
      : `Deployment cancelled: ${response.deployment.id}.\n`);
    printDeployment(response.deployment);
  }
}

async function commandRollback(args: string[], context: RunContext): Promise<void> {
  const options = parseOptions(args, [], ["wait"]);
  const [deploymentId] = requirePositionals(options, 1);
  const { client } = await authenticatedClient();
  const response = await client.request<{ deployment: Deployment }>(
    `/api/deployments/${encodeURIComponent(deploymentId ?? "")}/rollback`,
    { method: "POST" }
  );
  if (options.flags.has("wait")) await waitAndPrint(client, response.deployment, context);
  else if (context.json) printJson(response);
  else printDeployment(response.deployment);
}

async function commandLogs(args: string[], context: RunContext): Promise<void> {
  const options = parseOptions(args, [], ["follow"]);
  const [deploymentId] = requirePositionals(options, 1);
  const { client } = await authenticatedClient();
  const encodedId = encodeURIComponent(deploymentId ?? "");
  if (!options.flags.has("follow")) {
    const response = await client.request<{ logs: DeploymentLog[]; status: string }>(`/api/deployments/${encodedId}/logs`);
    if (context.json) printJson(response);
    else printLogs(response.logs);
    return;
  }

  const status = await followDeploymentLogs(
    client,
    deploymentId ?? "",
    (logs) => {
      if (context.json) {
        for (const log of logs) process.stdout.write(`${JSON.stringify({ type: "log", ...log })}\n`);
      } else printLogs(logs);
    },
    (finalStatus) => {
      if (context.json) process.stdout.write(`${JSON.stringify({ type: "complete", status: finalStatus })}\n`);
      else process.stderr.write(`Deployment complete: ${finalStatus}\n`);
    }
  );
  if (status !== "ready") process.exitCode = 1;
}

async function commandUpload(args: string[], context: RunContext): Promise<void> {
  const options = parseOptions(args, [], ["wait"]);
  const [projectId, archive] = requirePositionals(options, 2);
  const { client } = await authenticatedClient();
  const result = await uploadArchive(client, projectId ?? "", archive ?? "", (done, total) => {
    progress(`Uploaded ${done}/${total} chunk${total === 1 ? "" : "s"}.`, context);
  });
  if (options.flags.has("wait")) await waitAndPrint(client, result.deployment, context);
  else if (context.json) printJson(result);
  else {
    process.stdout.write(`Source replaced for ${result.project.name} (${result.project.id}).\n`);
    printDeployment(result.deployment);
  }
}

async function commandDomains(args: string[], context: RunContext): Promise<void> {
  const options = parseOptions(args);
  const [projectId] = requirePositionals(options, 1);
  const { client } = await authenticatedClient();
  const response = await client.request<{ project: Project }>(`/api/projects/${encodeURIComponent(projectId ?? "")}`);
  const domains = response.project.domains ?? [];
  if (context.json) printJson({ domains });
  else printDomains(domains);
}

async function commandDomain(args: string[], context: RunContext): Promise<void> {
  const [action, ...rest] = args;
  const { client } = await authenticatedClient();
  if (action === "add") {
    const options = parseOptions(rest, ["zone"]);
    const [projectId, hostname] = requirePositionals(options, 2);
    const response = await client.request<{ domain: Domain | null }>(
      `/api/projects/${encodeURIComponent(projectId ?? "")}/domains`,
      { method: "POST", body: { hostname, zoneId: requiredOption(options, "zone") } }
    );
    if (context.json) printJson(response);
    else if (response.domain) printDomains([response.domain]);
    else process.stdout.write("Domain provisioning started.\n");
    return;
  }
  if (action === "remove") {
    const options = parseOptions(rest);
    const [projectId, domainId] = requirePositionals(options, 2);
    await client.request(`/api/projects/${encodeURIComponent(projectId ?? "")}/domains/${encodeURIComponent(domainId ?? "")}`, {
      method: "DELETE"
    });
    if (context.json) printJson({ ok: true, domainId });
    else process.stdout.write(`Domain removed: ${domainId}\n`);
    return;
  }
  throw new Error("Usage: shelter domain <add|remove> ...");
}

export async function run(argv = process.argv.slice(2)): Promise<void> {
  const global = parseGlobalArguments(argv);
  if (global.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (global.help || global.args.length === 0) {
    process.stdout.write(HELP);
    return;
  }

  const [command, ...args] = global.args;
  const context = { json: global.json };
  switch (command) {
    case "login": await commandLogin(args, context); break;
    case "logout": await commandLogout(args, context); break;
    case "whoami": await commandWhoami(args, context); break;
    case "projects": await commandProjects(args, context); break;
    case "project": await commandProject(args, context); break;
    case "create": await commandCreate(args, context); break;
    case "deploy": await commandDeploy(args, context); break;
    case "cancel": await commandCancel(args, context); break;
    case "rollback": await commandRollback(args, context); break;
    case "logs": await commandLogs(args, context); break;
    case "upload": await commandUpload(args, context); break;
    case "domains": await commandDomains(args, context); break;
    case "domain": await commandDomain(args, context); break;
    default: throw new Error(`Unknown command: ${command ?? ""}. Run \`shelter --help\` for usage.`);
  }
}

run().catch((error: unknown) => {
  if (error instanceof ApiError) {
    const suffix = error.code ? ` (${error.code})` : "";
    process.stderr.write(`Shelter API error${suffix}: ${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : "Unexpected CLI error."}\n`);
  }
  process.exitCode = 1;
});
