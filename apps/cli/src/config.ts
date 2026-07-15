import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface StoredConfig {
  serverUrl: string;
  token: string;
}

export interface ConfigPaths {
  directory: string;
  file: string;
}

export interface Credentials {
  serverUrl: string;
  token: string;
}

export function normalizeServerUrl(value: string): string {
  const input = value.trim();
  if (!input) throw new Error("The Shelter server URL is required.");

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("The Shelter server URL must be an absolute HTTP or HTTPS URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The Shelter server URL must use HTTP or HTTPS.");
  }
  const loopbackHostname = url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopbackHostname) {
    throw new Error("The Shelter server URL must use HTTPS. HTTP is only allowed for loopback development servers.");
  }
  if (url.username || url.password) {
    throw new Error("The Shelter server URL must not contain credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("The Shelter server URL must not contain a query or fragment.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("The Shelter server URL must not contain a path.");
  }

  return url.origin;
}

export function configPaths(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir()
): ConfigPaths {
  const configuredRoot = env.XDG_CONFIG_HOME?.trim();
  const root = configuredRoot
    ? (isAbsolute(configuredRoot) ? configuredRoot : resolve(configuredRoot))
    : join(homeDirectory, ".config");
  const directory = join(root, "shelter");
  return { directory, file: join(directory, "config.json") };
}

function parseConfig(raw: string): StoredConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Shelter CLI configuration is not valid JSON. Run `shelter login` again.");
  }

  const record = parsed as Record<string, unknown> | null;
  const serverUrl = record?.serverUrl;
  const token = record?.token;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof serverUrl !== "string" ||
    typeof token !== "string" ||
    !token
  ) {
    throw new Error("Shelter CLI configuration is invalid. Run `shelter login` again.");
  }

  return {
    serverUrl: normalizeServerUrl(serverUrl),
    token
  };
}

export async function readConfig(paths = configPaths()): Promise<StoredConfig | null> {
  try {
    return parseConfig(await readFile(paths.file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeConfig(config: StoredConfig, paths = configPaths()): Promise<void> {
  const normalized: StoredConfig = {
    serverUrl: normalizeServerUrl(config.serverUrl),
    token: config.token.trim()
  };
  if (!normalized.token) throw new Error("The API token is required.");

  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  const temporary = join(paths.directory, `.config-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await rename(temporary, paths.file);
    await chmod(paths.file, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function deleteConfig(paths = configPaths()): Promise<boolean> {
  try {
    await unlink(paths.file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function resolveCredentials(
  env: NodeJS.ProcessEnv = process.env,
  paths = configPaths(env)
): Promise<Credentials> {
  const stored = await readConfig(paths);
  const serverValue = env.SHELTER_URL?.trim() || stored?.serverUrl;
  const token = env.SHELTER_TOKEN?.trim() || stored?.token;
  if (!serverValue || !token) {
    throw new Error("Not logged in. Run `shelter login --server https://your-shelter.example` first.");
  }
  return { serverUrl: normalizeServerUrl(serverValue), token };
}
