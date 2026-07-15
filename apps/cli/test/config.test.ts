import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configPaths,
  deleteConfig,
  normalizeServerUrl,
  readConfig,
  resolveCredentials,
  writeConfig
} from "../src/config.js";

const temporaryDirectories: string[] = [];
const validToken = `shelter_pat_v1_${"A".repeat(43)}`;

async function temporaryConfig() {
  const root = await mkdtemp(join(tmpdir(), "shelter-cli-"));
  temporaryDirectories.push(root);
  return configPaths({ XDG_CONFIG_HOME: root }, "/unused");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("normalizeServerUrl", () => {
  it("normalizes an origin and rejects unsafe URL components", () => {
    expect(normalizeServerUrl(" https://hosting.example/ ")).toBe("https://hosting.example");
    expect(() => normalizeServerUrl("ftp://hosting.example")).toThrow(/HTTP or HTTPS/);
    expect(() => normalizeServerUrl("https://user:pass@hosting.example")).toThrow(/credentials/);
    expect(() => normalizeServerUrl("https://hosting.example/panel")).toThrow(/path/);
  });

  it("allows HTTP only for explicit loopback hosts, including ports and IPv6", () => {
    expect(normalizeServerUrl("http://localhost:4321/"))
      .toBe("http://localhost:4321");
    expect(normalizeServerUrl("http://127.0.0.1:7081"))
      .toBe("http://127.0.0.1:7081");
    expect(normalizeServerUrl("http://[::1]:4173/"))
      .toBe("http://[::1]:4173");
    expect(() => normalizeServerUrl("http://hosting.example"))
      .toThrow(/must use HTTPS/);
    expect(() => normalizeServerUrl("http://192.168.1.10:3000"))
      .toThrow(/must use HTTPS/);
  });
});

describe("configuration storage", () => {
  it("writes credentials with restrictive filesystem permissions", async () => {
    const paths = await temporaryConfig();
    await writeConfig({ serverUrl: "https://hosting.example", token: validToken }, paths);

    expect(await readConfig(paths)).toEqual({
      serverUrl: "https://hosting.example",
      token: validToken
    });
    if (process.platform !== "win32") {
      expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.file)).mode & 0o777).toBe(0o600);
    }
    expect(await deleteConfig(paths)).toBe(true);
    expect(await deleteConfig(paths)).toBe(false);
  });

  it("prefers environment overrides without modifying stored credentials", async () => {
    const paths = await temporaryConfig();
    await writeConfig({ serverUrl: "https://stored.example", token: "stored-token" }, paths);
    await expect(resolveCredentials({
      SHELTER_URL: "https://environment.example/",
      SHELTER_TOKEN: "environment-token"
    }, paths)).resolves.toEqual({
      serverUrl: "https://environment.example",
      token: "environment-token"
    });
  });
});
