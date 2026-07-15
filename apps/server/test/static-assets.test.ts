import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("control-plane static assets", () => {
  it("revalidates entry files and caches content-hashed assets immutably", async () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-static-"));
    const webDirectory = path.join(dataDirectory, "web");
    temporaryDirectories.push(dataDirectory);
    fs.mkdirSync(path.join(webDirectory, "assets"), { recursive: true });
    fs.writeFileSync(path.join(webDirectory, "index.html"), "<!doctype html><div id=\"root\"></div>");
    fs.writeFileSync(path.join(webDirectory, "theme-init.js"), "document.documentElement.dataset.theme = 'system';");
    fs.writeFileSync(path.join(webDirectory, "assets", "index-AbCd1234.js"), "export const ready = true;");
    fs.writeFileSync(path.join(webDirectory, "assets", "runtime.js"), "export const runtime = true;");

    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: dataDirectory,
      WEB_DIST: webDirectory,
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: "correct horse battery staple",
      APP_SECRET: "s".repeat(64),
      LOG_LEVEL: "silent"
    });
    const app = await createApp(config);
    try {
      const root = await app.inject({ method: "GET", url: "/" });
      expect(root.statusCode).toBe(200);
      expect(root.headers["cache-control"]).toBe("no-store");

      const entryScript = await app.inject({ method: "GET", url: "/theme-init.js" });
      expect(entryScript.headers["cache-control"]).toBe("no-cache");

      const asset = await app.inject({ method: "GET", url: "/assets/index-AbCd1234.js" });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

      const unhashedAsset = await app.inject({ method: "GET", url: "/assets/runtime.js" });
      expect(unhashedAsset.headers["cache-control"]).toBe("no-cache");

      const missingAsset = await app.inject({ method: "GET", url: "/assets/OverviewPage-old.js" });
      expect(missingAsset.statusCode).toBe(404);
      expect(missingAsset.headers["cache-control"]).toBe("no-store");

      const clientRoute = await app.inject({
        method: "GET",
        url: "/dashboard",
        headers: { accept: "text/html" }
      });
      expect(clientRoute.statusCode).toBe(200);
      expect(clientRoute.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });
});
