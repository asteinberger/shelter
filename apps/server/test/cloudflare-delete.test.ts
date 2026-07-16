import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { CloudflareService } from "../src/services/cloudflare.js";

const directories: string[] = [];
const databases: Database[] = [];

function service(): CloudflareService {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-cf-delete-"));
  directories.push(dataDirectory);
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDirectory,
    APP_SECRET: "e".repeat(64),
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_API_TOKEN: "cloudflare-delete-token",
    LOG_LEVEL: "silent"
  });
  const database = new Database(config);
  databases.push(database);
  database.setSetting("cloudflare.tunnel_id", "owned-tunnel");
  return new CloudflareService(config, database);
}

function success<T>(result: T): Response {
  return Response.json({ success: true, result });
}

function missing(): Response {
  return Response.json({
    success: false,
    result: null,
    errors: [{ code: 81044, message: "DNS record does not exist" }]
  }, { status: 404 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) {
    if (database.sqlite.open) database.close();
  }
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Cloudflare DNS deletion ownership", () => {
  it("deletes only the expected hostname, CNAME type and owned tunnel target", async () => {
    const providerFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET") {
        return success({
          id: "record-id",
          name: "App.Example.com.",
          type: "CNAME",
          content: "OWNED-TUNNEL.cfargotunnel.com.",
          proxied: true
        });
      }
      if (init?.method === "DELETE") return success({ id: "record-id" });
      throw new Error(`Unexpected method: ${init?.method}`);
    });
    vi.stubGlobal("fetch", providerFetch);

    await expect(service().deleteDnsRecord("zone-id", "record-id", "app.example.com")).resolves.toBeUndefined();
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(providerFetch.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it.each([
    ["hostname", { name: "foreign.example.com", type: "CNAME", content: "owned-tunnel.cfargotunnel.com" }],
    ["type", { name: "app.example.com", type: "A", content: "owned-tunnel.cfargotunnel.com" }],
    ["target", { name: "app.example.com", type: "CNAME", content: "foreign-tunnel.cfargotunnel.com" }]
  ])("refuses deletion when the %s ownership field drifted", async (_field, drifted) => {
    const providerFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET") return success({ id: "record-id", proxied: true, ...drifted });
      throw new Error("DELETE must not be called for a foreign record");
    });
    vi.stubGlobal("fetch", providerFetch);

    await expect(service().deleteDnsRecord("zone-id", "record-id", "app.example.com")).rejects.toMatchObject({
      statusCode: 409,
      code: "DNS_RECORD_DRIFT"
    });
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("treats an already missing record and a delete-time Cloudflare 404 as success", async () => {
    const missingOnRead = vi.fn(async () => missing());
    vi.stubGlobal("fetch", missingOnRead);
    await expect(service().deleteDnsRecord("zone-id", "record-id", "app.example.com")).resolves.toBeUndefined();
    expect(missingOnRead).toHaveBeenCalledTimes(1);

    const missingOnDelete = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => (
      init?.method === "GET"
        ? success({
            id: "record-id",
            name: "app.example.com",
            type: "CNAME",
            content: "owned-tunnel.cfargotunnel.com",
            proxied: true
          })
        : missing()
    ));
    vi.stubGlobal("fetch", missingOnDelete);
    await expect(service().deleteDnsRecord("zone-id", "record-id", "app.example.com")).resolves.toBeUndefined();
    expect(missingOnDelete).toHaveBeenCalledTimes(2);
  });

  it("rediscovers an owned record by hostname when a crashed API never stored its record id", async () => {
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "GET" && url.pathname.endsWith("/dns_records")) {
        expect(url.searchParams.get("type")).toBe("CNAME");
        expect(url.searchParams.get("name")).toBe("app.example.com");
        return success([{
          id: "recovered-record",
          name: "app.example.com",
          type: "CNAME",
          content: "owned-tunnel.cfargotunnel.com",
          proxied: true
        }]);
      }
      if (init?.method === "DELETE" && url.pathname.endsWith("/recovered-record")) return success({});
      throw new Error(`Unexpected Cloudflare request: ${init?.method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", providerFetch);

    await expect(service().deleteDnsRecord("zone-id", null, "app.example.com")).resolves.toBeUndefined();
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });
});

describe("Cloudflare preview DNS ownership", () => {
  it.each([
    ["current", "Managed by Shelter", false],
    ["legacy", "Managed by Portsmith", true]
  ])("adopts a same-tunnel record carrying the %s Shelter marker", async (_label, comment, expectsMigration) => {
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "GET" && url.pathname === "/client/v4/zones") {
        return success([{ id: "zone-id", name: "example.com", status: "active" }]);
      }
      if (init?.method === "GET" && url.pathname.endsWith("/dns_records")) {
        return success([{
          id: "preview-record",
          name: "preview.example.com",
          type: "CNAME",
          content: "owned-tunnel.cfargotunnel.com",
          proxied: true,
          comment
        }]);
      }
      if (init?.method === "PATCH" && url.pathname.endsWith("/preview-record")) {
        expect(JSON.parse(String(init.body))).toEqual({
          proxied: true,
          comment: "Managed by Shelter"
        });
        return success({ id: "preview-record" });
      }
      throw new Error(`Unexpected Cloudflare request: ${init?.method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", providerFetch);

    await expect(service().ensurePreviewDnsRecord("preview.example.com", "zone-id")).resolves.toEqual({
      zoneId: "zone-id",
      recordId: "preview-record"
    });
    expect(providerFetch.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(
      expectsMigration ? 1 : 0
    );
  });

  it.each([
    ["without a comment", undefined],
    ["with a foreign comment", "Managed manually"]
  ])("refuses to adopt a same-tunnel record %s", async (_label, comment) => {
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "GET" && url.pathname === "/client/v4/zones") {
        return success([{ id: "zone-id", name: "example.com", status: "active" }]);
      }
      if (init?.method === "GET" && url.pathname.endsWith("/dns_records")) {
        return success([{
          id: "manual-record",
          name: "preview.example.com",
          type: "CNAME",
          content: "owned-tunnel.cfargotunnel.com",
          proxied: true,
          comment
        }]);
      }
      throw new Error("An unowned preview record must not be mutated");
    });
    vi.stubGlobal("fetch", providerFetch);

    await expect(service().ensurePreviewDnsRecord("preview.example.com", "zone-id")).rejects.toMatchObject({
      statusCode: 409,
      code: "DNS_RECORD_EXISTS"
    });
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["current", "Managed by Shelter"],
    ["legacy", "Managed by Portsmith"]
  ])("recovers and deletes a hostname-only preview record carrying the %s marker", async (_label, comment) => {
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "GET" && url.pathname.endsWith("/dns_records")) {
        return success([{
          id: "recovered-preview-record",
          name: "preview.example.com",
          type: "CNAME",
          content: "owned-tunnel.cfargotunnel.com",
          proxied: true,
          comment
        }]);
      }
      if (init?.method === "DELETE" && url.pathname.endsWith("/recovered-preview-record")) return success({});
      throw new Error(`Unexpected Cloudflare request: ${init?.method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", providerFetch);

    await expect(service().deletePreviewDnsRecord("zone-id", null, "preview.example.com")).resolves.toBeUndefined();
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["stored id without a comment", "record-id", undefined],
    ["hostname recovery with a foreign comment", null, "Managed manually"]
  ])("refuses to delete an unowned preview record during %s", async (_label, recordId, comment) => {
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "GET") {
        return success(recordId
          ? {
              id: "record-id",
              name: "preview.example.com",
              type: "CNAME",
              content: "owned-tunnel.cfargotunnel.com",
              proxied: true,
              comment
            }
          : [{
              id: "manual-record",
              name: "preview.example.com",
              type: "CNAME",
              content: "owned-tunnel.cfargotunnel.com",
              proxied: true,
              comment
            }]);
      }
      throw new Error("An unowned preview record must not be deleted");
    });
    vi.stubGlobal("fetch", providerFetch);

    await expect(service().deletePreviewDnsRecord("zone-id", recordId, "preview.example.com")).rejects.toMatchObject({
      statusCode: 409,
      code: "DNS_RECORD_DRIFT"
    });
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });
});
