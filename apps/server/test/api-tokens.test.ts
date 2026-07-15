import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { hashApiToken } from "../src/lib/security.js";

const temporaryDirectories: string[] = [];

async function testApp() {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-api-token-"));
  temporaryDirectories.push(dataDirectory);
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDirectory,
    WEB_DIST: path.join(dataDirectory, "missing-web"),
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "correct horse battery staple",
    APP_SECRET: "t".repeat(64),
    LOG_LEVEL: "silent"
  });
  const database = new Database(config);
  return { app: await createApp(config, database), database };
}

async function browserAuthentication(app: Awaited<ReturnType<typeof createApp>>) {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin@example.com", password: "correct horse battery staple" }
  });
  const session = login.cookies.find((entry) => entry.name === "shelter_session")?.value ?? "";
  return {
    cookie: `shelter_session=${session}`,
    "x-csrf-token": login.json().csrfToken as string,
    origin: "http://localhost:7080",
    host: "localhost:7080"
  };
}

async function createToken(
  app: Awaited<ReturnType<typeof createApp>>,
  headers: Awaited<ReturnType<typeof browserAuthentication>>,
  access: "read" | "write"
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/settings/api-tokens",
    headers,
    payload: {
      name: `${access} automation`,
      access,
      expiresInDays: 30,
      currentPassword: "correct horse battery staple"
    }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as {
    apiToken: { id: string; scopes: string[]; displayHint: string };
    secret: string;
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("personal API tokens", () => {
  it("shows the secret once and never exposes hashes or secrets in the token list", async () => {
    const { app, database } = await testApp();
    const headers = await browserAuthentication(app);
    const created = await createToken(app, headers, "write");

    expect(created.secret).toMatch(/^shelter_pat_v1_[A-Za-z0-9_-]{43}$/);
    expect(created.apiToken.scopes).toEqual([
      "projects:read",
      "projects:write",
      "deployments:write",
      "uploads:write",
      "domains:write",
      "environment:write"
    ]);
    expect(created.apiToken.displayHint).toMatch(/^shelter_pat_v1_••••[A-Za-z0-9_-]{4}$/);
    const stored = database.sqlite.prepare("SELECT * FROM api_tokens WHERE id = ?")
      .get(created.apiToken.id) as Record<string, unknown>;
    expect(stored.token_hash).toBe(hashApiToken(created.secret));
    expect(JSON.stringify(stored)).not.toContain(created.secret);

    const list = await app.inject({ method: "GET", url: "/api/settings/api-tokens", headers: { cookie: headers.cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().apiTokens).toHaveLength(1);
    expect(list.body).not.toContain(created.secret);
    expect(list.body).not.toContain("token_hash");
    expect(list.body).not.toContain("tokenHash");
    expect(list.headers["cache-control"]).toBe("no-store");
    expect(list.headers.pragma).toBe("no-cache");
    await app.close();
  });

  it("enforces read and write scopes without requiring CSRF for bearer-token mutations", async () => {
    const { app } = await testApp();
    const headers = await browserAuthentication(app);
    const readToken = await createToken(app, headers, "read");
    const writeToken = await createToken(app, headers, "write");

    const readProjects = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${readToken.secret}` }
    });
    expect(readProjects.statusCode).toBe(200);

    const deniedMutation = await app.inject({
      method: "POST",
      url: "/api/projects/git",
      headers: { authorization: `Bearer ${readToken.secret}` },
      payload: { name: "Read token app", repositoryUrl: "https://github.com/example/read.git" }
    });
    expect(deniedMutation.statusCode).toBe(403);
    expect(deniedMutation.json().code).toBe("INSUFFICIENT_SCOPE");

    const createdProject = await app.inject({
      method: "POST",
      url: "/api/projects/git",
      headers: {
        authorization: `Bearer ${writeToken.secret}`,
        origin: "https://automation.example"
      },
      payload: { name: "CLI app", repositoryUrl: "https://github.com/example/cli.git" }
    });
    expect(createdProject.statusCode).toBe(201);

    const deniedManagement = await app.inject({
      method: "GET",
      url: "/api/settings/api-tokens",
      headers: { authorization: `Bearer ${writeToken.secret}` }
    });
    expect(deniedManagement.statusCode).toBe(403);
    expect(deniedManagement.json().code).toBe("SESSION_REQUIRED");
    await app.close();
  });

  it("does not fall back to a browser cookie when an Authorization header is invalid", async () => {
    const { app } = await testApp();
    const headers = await browserAuthentication(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: headers.cookie, authorization: "Bearer invalid" }
    });
    expect(response.statusCode).toBe(401);

    const ambiguous = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: {
        cookie: headers.cookie,
        authorization: "Bearer shelter_pat_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA, Bearer shelter_pat_v1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
      }
    });
    expect(ambiguous.statusCode).toBe(401);
    await app.close();
  });

  it("revokes tokens immediately and ignores expired tokens", async () => {
    const { app, database } = await testApp();
    const headers = await browserAuthentication(app);
    const revoked = await createToken(app, headers, "read");
    const expired = await createToken(app, headers, "read");

    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/settings/api-tokens/${encodeURIComponent(revoked.apiToken.id)}`,
      headers
    });
    expect(revoke.statusCode).toBe(204);
    expect((await app.inject({
      method: "GET",
      url: "/api/api-tokens/current",
      headers: { authorization: `Bearer ${revoked.secret}` }
    })).statusCode).toBe(401);

    database.sqlite.prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), expired.apiToken.id);
    expect((await app.inject({
      method: "GET",
      url: "/api/api-tokens/current",
      headers: { authorization: `Bearer ${expired.secret}` }
    })).statusCode).toBe(401);
    await app.close();
  });

  it("requires the current password and fails closed for malformed stored scopes", async () => {
    const { app, database } = await testApp();
    const headers = await browserAuthentication(app);
    const missingPassword = await app.inject({
      method: "POST",
      url: "/api/settings/api-tokens",
      headers,
      payload: { name: "Automation", access: "read", expiresInDays: 30 }
    });
    expect(missingPassword.statusCode).toBe(400);

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/settings/api-tokens",
      headers,
      payload: { name: "Automation", access: "read", expiresInDays: 30, currentPassword: "wrong" }
    });
    expect(wrongPassword.statusCode).toBe(400);
    expect(wrongPassword.json().code).toBe("CURRENT_PASSWORD_INVALID");

    const token = await createToken(app, headers, "read");
    database.sqlite.prepare("UPDATE api_tokens SET scopes_json = ? WHERE id = ?")
      .run('["projects:read","projects:read"]', token.apiToken.id);
    const response = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${token.secret}` }
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("revokes active API tokens when the administrator password changes", async () => {
    const { app } = await testApp();
    const headers = await browserAuthentication(app);
    const token = await createToken(app, headers, "read");
    const changed = await app.inject({
      method: "PUT",
      url: "/api/auth/password",
      headers,
      payload: {
        currentPassword: "correct horse battery staple",
        newPassword: "an entirely different long password"
      }
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().invalidatedApiTokens).toBe(1);
    const response = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${token.secret}` }
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("upgrades the experimental token table without changing existing users or sessions", () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-api-token-migration-"));
    temporaryDirectories.push(dataDirectory);
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: dataDirectory,
      WEB_DIST: path.join(dataDirectory, "missing-web"),
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: "correct horse battery staple",
      APP_SECRET: "m".repeat(64),
      LOG_LEVEL: "silent"
    });
    const legacy = new BetterSqlite3(config.databasePath);
    legacy.pragma("foreign_keys = ON");
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_hash TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE api_tokens (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL,
        scopes TEXT NOT NULL, expires_at TEXT, last_used_at TEXT, created_at TEXT NOT NULL
      );
    `);
    const future = new Date(Date.now() + 60_000).toISOString();
    legacy.prepare("INSERT INTO users VALUES (?, ?, ?, ?)")
      .run("usr_legacy", "legacy@example.com", "legacy-hash", new Date().toISOString());
    legacy.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)")
      .run("session-hash", "usr_legacy", "csrf-hash", future, new Date().toISOString());
    legacy.prepare("INSERT INTO api_tokens VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("tok_legacy", "usr_legacy", "Old token", "a".repeat(64), "shelter_pat_old", '["read"]', future, null, new Date().toISOString());
    legacy.close();

    const database = new Database(config);
    expect(database.findUserById("usr_legacy")?.email).toBe("legacy@example.com");
    expect(database.getSession("session-hash")?.user_id).toBe("usr_legacy");
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM api_tokens").get()).toEqual({ count: 0 });
    const columns = database.sqlite.pragma("table_info(api_tokens)") as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("token_hint");
    expect(columns.map((column) => column.name)).toContain("scopes_json");
    expect(columns.map((column) => column.name)).toContain("revoked_at");
    database.close();
  });
});
