import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual
} from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { badRequest } from "./errors.js";

function derivePassword(password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const API_TOKEN_PREFIX = "shelter_pat_v1_";
export const API_TOKEN_PATTERN = /^shelter_pat_v1_[A-Za-z0-9_-]{43}$/;

export function issueApiToken(): { token: string; hint: string } {
  const token = `${API_TOKEN_PREFIX}${randomToken(32)}`;
  return { token, hint: token.slice(-4) };
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update("shelter:api-token:v1\0").update(token).digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derivePassword(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });
  return `scrypt$32768$8$1$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, n, r, p, saltEncoded, expectedEncoded] = encoded.split("$");
  if (algorithm !== "scrypt" || !n || !r || !p || !saltEncoded || !expectedEncoded) {
    return false;
  }

  const expected = Buffer.from(expectedEncoded, "base64");
  const actual = await derivePassword(password, Buffer.from(saltEncoded, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024
  });

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function encryptionKey(secret: string, product: "shelter" | "portsmith", version: "v1" | "v2"): Buffer {
  return createHash("sha256").update(`${product}:${version}:${secret}`).digest();
}

export function encryptString(value: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret, "shelter", "v2"), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v2", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptString(value: string, secret: string): string {
  const [version, ivEncoded, tagEncoded, encryptedEncoded] = value.split(".");
  if (!(["v1", "v2"] as string[]).includes(version ?? "") || !ivEncoded || !tagEncoded || !encryptedEncoded) {
    throw new Error("Unsupported encrypted value");
  }
  const key = version === "v1"
    ? encryptionKey(secret, "portsmith", "v1")
    : encryptionKey(secret, "shelter", "v2");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivEncoded, "base64url"));
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedEncoded, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

export function toSlug(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "app";
}

export function normalizeHostname(value: string): string {
  const hostname = value.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]?.replace(/\.$/, "") ?? "";
  if (
    hostname.length < 3 ||
    hostname.length > 253 ||
    !hostname.includes(".") ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)
  ) {
    throw badRequest("Ungültiger Hostname", "INVALID_HOSTNAME");
  }
  return hostname;
}

export function resolveWithin(base: string, requested: string): string {
  const resolved = path.resolve(base, requested);
  const relative = path.relative(base, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes the project workspace");
  }
  return resolved;
}

export function resolveRealWithin(base: string, requested: string): string {
  const baseReal = fs.realpathSync(base);
  const lexical = resolveWithin(baseReal, requested);
  const resolvedReal = fs.realpathSync(lexical);
  const relative = path.relative(baseReal, resolvedReal);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Symlink escapes the project workspace");
  }
  return resolvedReal;
}

export function validEnvironmentKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}
