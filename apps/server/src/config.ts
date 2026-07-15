import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const optionalTrimmedString = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).optional()
);

const optionalUrl = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.url().optional()
);

export function parseDockerMemoryBytes(value: string): number {
  const normalized = value.trim().toLowerCase();
  const unit = normalized.at(-1);
  const amount = Number(unit && /[bkmg]/.test(unit) ? normalized.slice(0, -1) : normalized);
  const multiplier = unit === "g" ? 1024 ** 3 : unit === "m" ? 1024 ** 2 : unit === "k" ? 1024 : 1;
  return amount * multiplier;
}

const DockerMemoryLimit = z.string()
  .trim()
  .regex(/^\d+(?:\.\d+)?[bkmgBKMG]?$/)
  .refine((value) => {
    const bytes = parseDockerMemoryBytes(value);
    return Number.isFinite(bytes) && bytes >= 64 * 1024 ** 2 && bytes <= 64 * 1024 ** 3;
  }, "memory limit must be between 64 MiB and 64 GiB");

const DockerCpuLimit = z.string()
  .trim()
  .regex(/^\d+(?:\.\d+)?$/)
  .refine((value) => {
    const cpus = Number(value);
    return Number.isFinite(cpus) && cpus >= 0.1 && cpus <= 64;
  }, "CPU limit must be between 0.1 and 64");

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(7080),
  DATA_DIR: z.string().default(path.resolve(process.cwd(), "data")),
  TRAEFIK_CONFIG_PATH: z.string().optional(),
  TUNNEL_TOKEN_PATH: z.string().optional(),
  WEB_DIST: z.string().default(path.resolve(process.cwd(), "apps/web/dist")),
  ADMIN_EMAIL: z.email().default("admin@localhost"),
  ADMIN_PASSWORD: z.string().optional(),
  ADMIN_PASSWORD_B64: z.string().optional(),
  APP_SECRET: z.string().min(32).default("local-development-secret-change-me-please"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(4096).default(500),
  CONTROL_PLANE_IMAGE: z.string().trim().min(1).max(255)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/)
    .default("shelter/control-plane:local"),
  RUNTIME_NETWORK: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/).default("shelter-runtime"),
  TRAEFIK_SERVICE_URL: z.url().default("http://traefik:80"),
  TRUSTED_PROXY_IP: z.ipv4().default("10.253.253.3"),
  TRUSTED_CLOUDFLARED_IP: z.ipv4().default("10.253.253.4"),
  DEPLOYMENT_MEMORY: z.string().regex(/^\d+(?:\.\d+)?[bkmgBKMG]?$/).default("1g"),
  DEPLOYMENT_CPUS: z.string().regex(/^\d+(?:\.\d+)?$/).default("1.0"),
  HEALTHCHECK_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(600).default(60),
  BUILD_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(240).default(30),
  GIT_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  BUILD_CACHE_MAX_GB: z.coerce.number().int().min(1).max(1000).default(8),
  BUILD_MEMORY: DockerMemoryLimit.default("2g"),
  BUILD_MEMORY_SWAP: DockerMemoryLimit.default("2g"),
  BUILD_CPUS: DockerCpuLimit.default("1.0"),
  BUILD_PIDS_LIMIT: z.coerce.number().int().min(64).max(65_536).default(1024),
  BUILD_MAX_PARALLELISM: z.coerce.number().int().min(1).max(16).default(2),
  BUILD_MIN_FREE_GB: z.coerce.number().int().min(1).max(1024).default(5),
  METRICS_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(300).default(15),
  METRICS_RETENTION_HOURS: z.coerce.number().int().min(1).max(720).default(48),
  CHROMIUM_PATH: z.string().min(1).default("/usr/bin/chromium-browser"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  CLOUDFLARE_OAUTH_CLIENT_ID: optionalTrimmedString,
  CLOUDFLARE_OAUTH_CLIENT_SECRET: optionalTrimmedString,
  CLOUDFLARE_OAUTH_REDIRECT_URI: optionalUrl,
  CLOUDFLARE_OAUTH_PROXY_URL: optionalUrl,
  CLOUDFLARE_OAUTH_SCOPES: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string()
      .trim()
      .min(1)
      .max(2048)
      .regex(/^[A-Za-z0-9._:-]+(?:\s+[A-Za-z0-9._:-]+)*$/)
      .default("account-settings.read zone.read dns.write argotunnel.write")
  )
}).superRefine((config, context) => {
  if (parseDockerMemoryBytes(config.BUILD_MEMORY_SWAP) < parseDockerMemoryBytes(config.BUILD_MEMORY)) {
    context.addIssue({
      code: "custom",
      path: ["BUILD_MEMORY_SWAP"],
      message: "BUILD_MEMORY_SWAP must be greater than or equal to BUILD_MEMORY"
    });
  }
});

export type AppConfig = Omit<z.infer<typeof ConfigSchema>, "ADMIN_PASSWORD"> & {
  ADMIN_PASSWORD: string | undefined;
  databasePath: string;
  sourcesDir: string;
  workspacesDir: string;
  traefikConfigPath: string;
  tunnelTokenPath: string;
};

export function loadConfig(input: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.parse(input);
  if (parsed.CLOUDFLARE_OAUTH_REDIRECT_URI) {
    const redirectUri = new URL(parsed.CLOUDFLARE_OAUTH_REDIRECT_URI);
    if (!["http:", "https:"].includes(redirectUri.protocol)) {
      throw new Error("CLOUDFLARE_OAUTH_REDIRECT_URI must use http or https");
    }
    if (redirectUri.username || redirectUri.password) {
      throw new Error("CLOUDFLARE_OAUTH_REDIRECT_URI must not contain user information");
    }
    if (
      redirectUri.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(redirectUri.hostname)
    ) {
      throw new Error("CLOUDFLARE_OAUTH_REDIRECT_URI must use https unless it targets loopback");
    }
    if (redirectUri.search || redirectUri.hash) {
      throw new Error("CLOUDFLARE_OAUTH_REDIRECT_URI must not contain a query or fragment");
    }
    if (redirectUri.pathname !== "/api/settings/cloudflare/oauth/callback") {
      throw new Error("CLOUDFLARE_OAUTH_REDIRECT_URI must end with /api/settings/cloudflare/oauth/callback");
    }
  }
  if (parsed.CLOUDFLARE_OAUTH_PROXY_URL) {
    const proxyUrl = new URL(parsed.CLOUDFLARE_OAUTH_PROXY_URL);
    if (!["http:", "https:"].includes(proxyUrl.protocol)) {
      throw new Error("CLOUDFLARE_OAUTH_PROXY_URL must use http or https");
    }
    if (proxyUrl.pathname !== "/" || proxyUrl.search || proxyUrl.hash) {
      throw new Error("CLOUDFLARE_OAUTH_PROXY_URL must contain only a proxy origin");
    }
    try {
      decodeURIComponent(proxyUrl.username);
      decodeURIComponent(proxyUrl.password);
    } catch {
      throw new Error("CLOUDFLARE_OAUTH_PROXY_URL credentials must use valid percent-encoding");
    }
  }
  const encodedAdminPassword = parsed.ADMIN_PASSWORD_B64?.trim();
  const configuredAdminPassword = parsed.ADMIN_PASSWORD === "" ? undefined : parsed.ADMIN_PASSWORD;
  const adminPassword = encodedAdminPassword
    ? Buffer.from(encodedAdminPassword, "base64").toString("utf8")
    : configuredAdminPassword ?? (parsed.NODE_ENV === "production" ? undefined : "local-development-only");
  if (adminPassword !== undefined && adminPassword.length < 12) {
    throw new Error("ADMIN_PASSWORD must contain at least 12 characters");
  }

  if (parsed.NODE_ENV === "production") {
    if (adminPassword && ["local-development-only", "replace-with-at-least-16-random-characters"].includes(adminPassword)) {
      throw new Error("ADMIN_PASSWORD must be set in production");
    }
    if (["local-development-secret-change-me-please", "replace-with-64-random-hex-characters"].includes(parsed.APP_SECRET)) {
      throw new Error("APP_SECRET must be set in production");
    }
  }

  const shelterDatabasePath = path.join(parsed.DATA_DIR, "shelter.sqlite");
  const legacyDatabasePath = path.join(parsed.DATA_DIR, "portsmith.sqlite");
  // Existing installations keep using their original SQLite file in place.
  // Renaming a live WAL database during a rolling API/worker restart would be
  // unsafe; new installations use the Shelter filename instead.
  const databasePath = fs.existsSync(shelterDatabasePath) || !fs.existsSync(legacyDatabasePath)
    ? shelterDatabasePath
    : legacyDatabasePath;

  return {
    ...parsed,
    ADMIN_PASSWORD: adminPassword,
    databasePath,
    sourcesDir: path.join(parsed.DATA_DIR, "sources"),
    workspacesDir: path.join(parsed.DATA_DIR, "workspaces"),
    traefikConfigPath: parsed.TRAEFIK_CONFIG_PATH ?? path.join(parsed.DATA_DIR, "traefik", "dynamic.yml"),
    tunnelTokenPath: parsed.TUNNEL_TOKEN_PATH ?? path.join(parsed.DATA_DIR, "cloudflared", "tunnel-token")
  };
}
