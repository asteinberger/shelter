import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decryptString,
  encryptString,
  hashApiToken,
  hashPassword,
  hashToken,
  issueApiToken,
  normalizeHostname,
  resolveWithin,
  toSlug,
  verifyPassword
} from "../src/lib/security.js";
import { loadConfig } from "../src/config.js";

describe("security helpers", () => {
  it("rejects example credentials in production", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: "replace-with-at-least-16-random-characters",
      APP_SECRET: "replace-with-64-random-hex-characters"
    })).toThrow(/ADMIN_PASSWORD/);
    expect(() => loadConfig({
      NODE_ENV: "production",
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: "a genuinely random admin password",
      APP_SECRET: "replace-with-64-random-hex-characters"
    })).toThrow(/APP_SECRET/);
  });

  it("allows production startup without a bootstrap password", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      ADMIN_EMAIL: "admin@example.com",
      APP_SECRET: "a".repeat(64)
    });

    expect(config.ADMIN_PASSWORD).toBeUndefined();
  });

  it("hashes and verifies passwords", async () => {
    const encoded = await hashPassword("a very long test password");
    expect(encoded).not.toContain("a very long test password");
    await expect(verifyPassword("a very long test password", encoded)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", encoded)).resolves.toBe(false);
  });

  it("issues strict, domain-separated API tokens", () => {
    const first = issueApiToken();
    const second = issueApiToken();
    expect(first.token).toMatch(/^shelter_pat_v1_[A-Za-z0-9_-]{43}$/);
    expect(first.hint).toBe(first.token.slice(-4));
    expect(second.token).not.toBe(first.token);
    expect(hashApiToken(first.token)).toHaveLength(64);
    expect(hashApiToken(first.token)).toBe(hashApiToken(first.token));
    expect(hashApiToken(first.token)).not.toBe(hashToken(first.token));
    expect(hashApiToken(first.token)).not.toContain(first.token);
  });

  it("encrypts secrets with authenticated encryption", () => {
    const encrypted = encryptString("top secret", "a".repeat(64));
    expect(encrypted).not.toContain("top secret");
    expect(decryptString(encrypted, "a".repeat(64))).toBe("top secret");
    expect(() => decryptString(encrypted, "b".repeat(64))).toThrow();
  });

  it("normalizes slugs and hostnames", () => {
    expect(toSlug("München & Zürich")).toBe("munchen-zurich");
    expect(normalizeHostname("https://APP.Example.com/path")).toBe("app.example.com");
    expect(() => normalizeHostname("localhost")).toThrow();
  });

  it("prevents paths from escaping their workspace", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-path-"));
    expect(resolveWithin(directory, "apps/web")).toBe(path.join(directory, "apps/web"));
    expect(() => resolveWithin(directory, "../secret")).toThrow();
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
