import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import {
  cloudflareAccessConfirmationSetting,
  cloudflareAccessProtection,
  revokeCloudflareAccessConfirmation,
  storeCloudflareAccessConfirmation
} from "../src/services/cloudflare-access.js";
import { storePanelDomainTransition } from "../src/services/panel-domains.js";

const temporaryDirectories: string[] = [];

function testConfig(dataDirectory: string) {
  return loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDirectory,
    WEB_DIST: path.join(dataDirectory, "missing-web"),
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "correct horse battery staple",
    APP_SECRET: "a".repeat(64),
    LOG_LEVEL: "silent"
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Cloudflare Access protection settings", () => {
  it("persists an administrator confirmation and invalidates it for a new panel hostname", () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-access-db-"));
    temporaryDirectories.push(dataDirectory);
    const config = testConfig(dataDirectory);
    let database = new Database(config);

    expect(cloudflareAccessProtection(database)).toEqual({
      status: "not_applicable",
      panelDomain: null,
      confirmedHostname: null,
      confirmedAt: null
    });

    database.setSetting("cloudflare.panel_domain", "panel.example.com");
    expect(cloudflareAccessProtection(database).status).toBe("action_required");
    expect(storeCloudflareAccessConfirmation(
      database,
      "panel.example.com",
      "usr_admin",
      "2026-07-15T08:30:00.000Z"
    )).toEqual({
      status: "confirmed_by_admin",
      panelDomain: "panel.example.com",
      confirmedHostname: "panel.example.com",
      confirmedAt: "2026-07-15T08:30:00.000Z"
    });
    database.close();

    database = new Database(config);
    expect(cloudflareAccessProtection(database).status).toBe("confirmed_by_admin");

    storePanelDomainTransition(database, "new-panel.example.com", "zone-id", "record-id");
    expect(cloudflareAccessProtection(database)).toMatchObject({
      status: "action_required",
      panelDomain: "new-panel.example.com",
      confirmedHostname: null,
      confirmedAt: null
    });
    expect(database.getSetting(cloudflareAccessConfirmationSetting)).toBeUndefined();

    storeCloudflareAccessConfirmation(database, "new-panel.example.com", "usr_admin");
    expect(revokeCloudflareAccessConfirmation(database).status).toBe("action_required");
    database.close();
  });

  it("never applies a stale confirmation when the hostname changed outside the transition helper", () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-access-stale-"));
    temporaryDirectories.push(dataDirectory);
    const database = new Database(testConfig(dataDirectory));
    database.setSetting("cloudflare.panel_domain", "one.example.com");
    storeCloudflareAccessConfirmation(database, "one.example.com", "usr_admin");

    database.setSetting("cloudflare.panel_domain", "two.example.com");

    expect(cloudflareAccessProtection(database)).toMatchObject({
      status: "action_required",
      panelDomain: "two.example.com",
      confirmedHostname: null
    });
    database.close();
  });
});

describe("Cloudflare Access confirmation routes", () => {
  it("requires the live panel hostname and exposes the posture in settings and overview", async () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-access-route-"));
    temporaryDirectories.push(dataDirectory);
    const config = testConfig(dataDirectory);
    const database = new Database(config);
    database.setSetting("cloudflare.panel_domain", "panel.example.com");
    const app = await createApp(config, database);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });
    const sessionCookie = login.cookies.find((cookie) => cookie.name === "shelter_session")?.value ?? "";
    const csrfToken = login.json().csrfToken as string;
    const mutationHeaders = {
      cookie: `shelter_session=${sessionCookie}`,
      "x-csrf-token": csrfToken,
      origin: "http://localhost:7080",
      host: "localhost:7080"
    };

    const initial = await app.inject({
      method: "GET",
      url: "/api/settings/cloudflare",
      headers: { cookie: `shelter_session=${sessionCookie}` }
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.headers["cache-control"]).toBe("no-store");
    expect(initial.json().cloudflare.accessProtection).toEqual({
      status: "action_required",
      panelDomain: "panel.example.com",
      confirmedHostname: null,
      confirmedAt: null
    });

    const withoutCsrf = await app.inject({
      method: "POST",
      url: "/api/settings/cloudflare/access-protection/confirmation",
      headers: { cookie: `shelter_session=${sessionCookie}` },
      payload: { panelDomain: "panel.example.com" }
    });
    expect(withoutCsrf.statusCode).toBe(403);

    const stale = await app.inject({
      method: "POST",
      url: "/api/settings/cloudflare/access-protection/confirmation",
      headers: mutationHeaders,
      payload: { panelDomain: "old-panel.example.com" }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("PANEL_DOMAIN_CHANGED");

    const confirmed = await app.inject({
      method: "POST",
      url: "/api/settings/cloudflare/access-protection/confirmation",
      headers: mutationHeaders,
      payload: { panelDomain: "panel.example.com" }
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.headers["cache-control"]).toBe("no-store");
    expect(confirmed.json().accessProtection).toMatchObject({
      status: "confirmed_by_admin",
      panelDomain: "panel.example.com",
      confirmedHostname: "panel.example.com"
    });

    const overview = await app.inject({
      method: "GET",
      url: "/api/overview",
      headers: { cookie: `shelter_session=${sessionCookie}` }
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.headers["cache-control"]).toBe("no-store");
    expect(overview.json().system).toMatchObject({
      tunnelConfigured: false,
      accessProtection: {
        status: "confirmed_by_admin",
        panelDomain: "panel.example.com"
      }
    });

    const revoked = await app.inject({
      method: "DELETE",
      url: "/api/settings/cloudflare/access-protection/confirmation",
      headers: mutationHeaders
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().accessProtection).toEqual({
      status: "action_required",
      panelDomain: "panel.example.com",
      confirmedHostname: null,
      confirmedAt: null
    });

    await app.close();
  });
});
