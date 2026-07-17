import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yauzl from "yauzl";
import { z } from "zod";
import { badRequest } from "../lib/errors.js";

export const MAX_ANALYSIS_PATHS = 10_000;
export const MAX_ANALYSIS_CONTENT_BYTES = 512 * 1024;
export const MAX_ANALYSIS_SOURCE_FILE_BYTES = 64 * 1024;
export const MAX_ANALYSIS_SOURCE_CONTENT_BYTES = 384 * 1024;
export const MAX_ANALYSIS_APPLICATIONS = 100;

export type DetectedFramework =
  | "next"
  | "react"
  | "astro"
  | "vite"
  | "static"
  | "node"
  | "dockerfile"
  | "files"
  | "unknown";

export type DetectedRendering = "ssr" | "spa" | "static" | "server" | "container" | "files";
export type DetectedPackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type EnvironmentRequirementConfidence = "high" | "medium";
export type EnvironmentRequirementScope = "build" | "runtime" | "both";
export type EnvironmentRequirementVisibility = "server" | "public";

export interface ProjectEnvironmentRequirementSource {
  path: string;
  line: number;
  kind: "example" | "reference" | "validation";
}

export interface ProjectEnvironmentRequirement {
  key: string;
  required: boolean;
  secret: boolean;
  scope: EnvironmentRequirementScope;
  visibility: EnvironmentRequirementVisibility;
  confidence: EnvironmentRequirementConfidence;
  sources: ProjectEnvironmentRequirementSource[];
}

export interface ProjectFileFact {
  path: string;
  size?: number | undefined;
  content?: string | undefined;
}

export interface ProjectApplicationAnalysis {
  id: string;
  rootDirectory: string;
  name: string;
  framework: DetectedFramework;
  frameworkVersion: string | null;
  rendering: DetectedRendering;
  packageManager: DetectedPackageManager | null;
  buildType: "auto" | "dockerfile" | "node" | "static";
  buildCommand: string | null;
  startCommand: string | null;
  outputDirectory: string | null;
  port: number;
  healthcheckPath: string;
  spaFallback: boolean;
  environmentKeys: string[];
  environmentRequirements: ProjectEnvironmentRequirement[];
  confidence: number;
  evidence: string[];
}

export interface ProjectAnalysis {
  fingerprint: string;
  applications: ProjectApplicationAnalysis[];
  recommendedApplicationId: string | null;
}

const SafeRelativePath = z.string().min(1).max(240).superRefine((value, context) => {
  if (
    value.includes("\\")
    || value.includes("\0")
    || value.startsWith("/")
    || /^[A-Za-z]:\//.test(value)
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    context.addIssue({ code: "custom", message: "Path must be a safe relative POSIX path" });
  }
});

export const ProjectFileFactSchema = z.object({
  path: SafeRelativePath,
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  content: z.string().max(MAX_ANALYSIS_CONTENT_BYTES).optional()
}).strict().superRefine((value, context) => {
  if (value.content !== undefined && !isAnalysisContentPath(value.path)) {
    context.addIssue({
      code: "custom",
      path: ["content"],
      message: "Content is accepted only for supported project configuration files"
    });
  }
});

export const ProjectAnalysisRequestSchema = z.object({
  files: z.array(ProjectFileFactSchema).max(MAX_ANALYSIS_PATHS)
}).strict().superRefine((value, context) => {
  let contentBytes = 0;
  let sourceContentBytes = 0;
  const paths = new Set<string>();
  value.files.forEach((file, index) => {
    if (paths.has(file.path)) {
      context.addIssue({ code: "custom", path: ["files", index, "path"], message: "File paths must be unique" });
    }
    paths.add(file.path);
    if (file.content !== undefined) {
      const bytes = Buffer.byteLength(file.content, "utf8");
      contentBytes += bytes;
      if (isEnvironmentSourceOnlyPath(file.path)) {
        sourceContentBytes += bytes;
        if (bytes > MAX_ANALYSIS_SOURCE_FILE_BYTES) {
          context.addIssue({
            code: "custom",
            path: ["files", index, "content"],
            message: "Source files may contribute at most 64 KiB each to project analysis"
          });
        }
      }
    }
  });
  if (contentBytes > MAX_ANALYSIS_CONTENT_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["files"],
      message: "Configuration content may total at most 512 KiB"
    });
  }
  if (sourceContentBytes > MAX_ANALYSIS_SOURCE_CONTENT_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["files"],
      message: "Source files may contribute at most 384 KiB to project analysis"
    });
  }
});

const CONFIG_FILE_NAMES = new Set([
  "package.json",
  "next.config.js",
  "next.config.cjs",
  "next.config.mjs",
  "next.config.ts",
  "astro.config.js",
  "astro.config.cjs",
  "astro.config.mjs",
  "astro.config.ts",
  "vite.config.js",
  "vite.config.cjs",
  "vite.config.mjs",
  "vite.config.ts",
  "vite.config.jsx",
  "vite.config.tsx",
  "dockerfile",
  "index.html",
  "tsconfig.json",
  "nx.json",
  "turbo.json",
  "pnpm-workspace.yaml"
]);

const ENVIRONMENT_SOURCE_EXTENSIONS = new Set([
  ".astro", ".cjs", ".js", ".jsx", ".mjs", ".svelte", ".ts", ".tsx", ".vue"
]);
const ENVIRONMENT_SOURCE_IGNORED_SEGMENTS = new Set([
  "__fixtures__", "__mocks__", "__tests__", "fixtures", "mocks", "test", "tests"
]);

const LOCK_FILES = ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"] as const;
const IGNORED_DIRECTORY_SEGMENTS = new Set([
  ".git", "node_modules", ".next", ".turbo", "coverage", "dist", "build", "out", "vendor", "__macosx"
]);
const FILE_STORAGE_EXTENSIONS = new Set([
  ".aac", ".avif", ".bmp", ".csv", ".doc", ".docx", ".flac", ".gif", ".heic", ".heif", ".ico",
  ".jpeg", ".jpg", ".m4a", ".m4v", ".md", ".mov", ".mp3", ".mp4", ".oga", ".ogg", ".ogv", ".opus",
  ".otf", ".pdf", ".png", ".ppt", ".pptx", ".rtf", ".svg", ".text", ".tif", ".tiff", ".tsv", ".ttf",
  ".txt", ".wav", ".webm", ".webp", ".woff", ".woff2", ".xls", ".xlsx"
]);
const FILE_STORAGE_EXTENSIONLESS_FILES = new Set(["copying", "license", "notice", "readme"]);
const FILE_STORAGE_BLOCKED_PROJECT_FILES = new Set([
  "bun.lock", "bun.lockb", "cargo.lock", "cargo.toml", "composer.json", "composer.lock", "deno.json",
  "deno.jsonc", "docker-compose.yml", "docker-compose.yaml", "dockerfile", "gemfile", "gemfile.lock",
  "go.mod", "go.sum", "package-lock.json", "package.json", "pnpm-lock.yaml", "poetry.lock",
  "pyproject.toml", "requirements.txt", "tsconfig.json", "yarn.lock"
]);

interface PackageManifest {
  name?: string | undefined;
  version?: string | undefined;
  packageManager?: string | undefined;
  main?: string | undefined;
  module?: string | undefined;
  workspaces?: unknown;
  scripts?: Record<string, string> | undefined;
  dependencies?: Record<string, string> | undefined;
  devDependencies?: Record<string, string> | undefined;
}

const PackageManifestSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  packageManager: z.string().optional(),
  main: z.string().optional(),
  module: z.string().optional(),
  workspaces: z.unknown().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional()
}).passthrough();

function parsePackageManifest(content: string): PackageManifest | null {
  try {
    return PackageManifestSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

function basename(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf("/") + 1).toLowerCase();
}

function isIgnoredAnalysisPath(filePath: string): boolean {
  const segments = filePath.split("/");
  return segments.some((segment) => IGNORED_DIRECTORY_SEGMENTS.has(segment.toLowerCase()))
    || segments.some((segment) => segment.toLowerCase() === ".ds_store");
}

export function isAnalysisContentPath(filePath: string): boolean {
  return isProjectConfigurationContentPath(filePath) || isEnvironmentSourceContentPath(filePath);
}

export function isProjectConfigurationContentPath(filePath: string): boolean {
  const name = basename(filePath);
  return CONFIG_FILE_NAMES.has(name) || /^\.env(?:\.[a-z0-9_-]+)*\.(?:example|sample)$/i.test(name);
}

export function requiresAnalysisContent(filePath: string): boolean {
  const name = basename(filePath);
  return name === "package.json"
    || /^(?:next|astro|vite)\.config\.(?:js|cjs|mjs|ts|jsx|tsx)$/.test(name)
    || /^\.env(?:\.[a-z0-9_-]+)*\.(?:example|sample)$/i.test(name)
    || isEnvironmentSourceContentPath(filePath);
}

export function isEnvironmentSourceContentPath(filePath: string): boolean {
  const segments = filePath.toLowerCase().split("/");
  const name = segments.at(-1) ?? "";
  if (segments.some((segment) => ENVIRONMENT_SOURCE_IGNORED_SEGMENTS.has(segment))) return false;
  if (/\.(?:spec|test|stories)\.[^.]+$/.test(name)) return false;
  return ENVIRONMENT_SOURCE_EXTENSIONS.has(path.posix.extname(name));
}

function isEnvironmentSourceOnlyPath(filePath: string): boolean {
  return isEnvironmentSourceContentPath(filePath) && !isProjectConfigurationContentPath(filePath);
}

function joinRoot(root: string, name: string): string {
  return root === "." ? name : `${root}/${name}`;
}

function rootOf(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index === -1 ? "." : filePath.slice(0, index);
}

function rootName(root: string): string {
  return root === "." ? "Project" : root.slice(root.lastIndexOf("/") + 1);
}

function managerCommand(manager: DetectedPackageManager | null, script: string): string {
  if (manager === "yarn") return `yarn ${script}`;
  if (manager === "pnpm") return `pnpm run ${script}`;
  if (manager === "bun") return `bun run ${script}`;
  return `npm run ${script}`;
}

function managerBinaryCommand(manager: DetectedPackageManager | null, binary: string, args: string): string {
  if (manager === "yarn") return `yarn ${binary} ${args}`;
  if (manager === "pnpm") return `pnpm exec ${binary} ${args}`;
  if (manager === "bun") return `bun run ${binary} ${args}`;
  // npm exec resolves binaries from ancestor node_modules directories as
  // well, which is required when npm hoists a selected workspace app.
  return `npm exec -- ${binary} ${args}`;
}

function hasWorkspaceDeclaration(manifest: PackageManifest | undefined): boolean {
  if (!manifest?.workspaces) return false;
  if (Array.isArray(manifest.workspaces)) return manifest.workspaces.length > 0;
  if (typeof manifest.workspaces !== "object") return false;
  const packages = (manifest.workspaces as { packages?: unknown }).packages;
  return Array.isArray(packages) && packages.length > 0;
}

function parentRoot(root: string): string | null {
  if (root === ".") return null;
  const parent = path.posix.dirname(root);
  return parent === root ? null : parent;
}

function workspaceRootFor(
  root: string,
  manifests: ReadonlyMap<string, PackageManifest>,
  paths: ReadonlySet<string>
): string {
  let candidate = parentRoot(root);
  while (candidate !== null) {
    if (
      paths.has(joinRoot(candidate, "pnpm-workspace.yaml"))
      || hasWorkspaceDeclaration(manifests.get(candidate))
    ) return candidate;
    candidate = parentRoot(candidate);
  }
  return root;
}

function packageManagerFor(
  root: string,
  manifest: PackageManifest,
  manifests: ReadonlyMap<string, PackageManifest>,
  paths: ReadonlySet<string>
): DetectedPackageManager {
  const workspaceRoot = workspaceRootFor(root, manifests, paths);
  const managerRoot = workspaceRoot === root ? root : workspaceRoot;
  const managerManifest = manifests.get(managerRoot) ?? manifest;
  const declared = managerManifest.packageManager?.split("@", 1)[0];
  if (declared === "bun" || declared === "pnpm" || declared === "yarn" || declared === "npm") return declared;
  if (paths.has(joinRoot(managerRoot, "bun.lock"))) return "bun";
  if (paths.has(joinRoot(managerRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (paths.has(joinRoot(managerRoot, "yarn.lock"))) return "yarn";
  if (paths.has(joinRoot(managerRoot, "package-lock.json"))) return "npm";
  // bun.lockb is Bun's legacy binary lockfile and is frequently left beside
  // a newer lockfile by generators. Only infer Bun from it when no modern
  // package-manager signal exists.
  if (paths.has(joinRoot(managerRoot, "bun.lockb"))) return "bun";
  return "npm";
}

function configContent(root: string, files: ReadonlyMap<string, ProjectFileFact>, prefixes: string[]): string {
  for (const prefix of prefixes) {
    for (const extension of ["js", "cjs", "mjs", "ts", "jsx", "tsx"]) {
      const content = files.get(joinRoot(root, `${prefix}.${extension}`))?.content;
      if (content !== undefined) return content;
    }
  }
  return "";
}

function withoutJavaScriptComments(source: string): string {
  let result = "";
  let quote: "\"" | "'" | "`" | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (quote) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      result += character;
      continue;
    }
    if (character === "/" && next === "/") {
      result += "  ";
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        result += " ";
        index += 1;
      }
      if (index < source.length) result += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      result += "  ";
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        result += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index < source.length) {
        result += "  ";
        index += 1;
      }
      continue;
    }
    result += character;
  }
  return result;
}

function matchingBrace(source: string, openingIndex: number): number | null {
  let depth = 0;
  let quote: "\"" | "'" | "`" | null = null;
  let escaped = false;
  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return null;
}

function isTopLevelPosition(source: string, position: number): boolean {
  let curly = 0;
  let square = 0;
  let round = 0;
  let quote: "\"" | "'" | "`" | null = null;
  let escaped = false;
  for (let index = 0; index < position; index += 1) {
    const character = source[index] ?? "";
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") quote = character;
    else if (character === "{") curly += 1;
    else if (character === "}") curly -= 1;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === "(") round += 1;
    else if (character === ")") round -= 1;
  }
  return curly === 0 && square === 0 && round === 0 && quote === null;
}

function configurationObject(source: string): string | null {
  const uncommented = withoutJavaScriptComments(source);
  const match = /\bdefineConfig\s*\(\s*\{|\bexport\s+default\s*\{/.exec(uncommented);
  if (!match || match.index === undefined) return null;
  const openingIndex = uncommented.indexOf("{", match.index);
  const closingIndex = matchingBrace(uncommented, openingIndex);
  return closingIndex === null ? null : uncommented.slice(openingIndex + 1, closingIndex);
}

function nestedConfigurationObject(source: string, property: string): string | null {
  const pattern = new RegExp(`\\b${property}\\s*:\\s*\\{`, "g");
  for (const match of source.matchAll(pattern)) {
    if (match.index === undefined || !isTopLevelPosition(source, match.index)) continue;
    const openingIndex = source.indexOf("{", match.index);
    const closingIndex = matchingBrace(source, openingIndex);
    if (closingIndex !== null) return source.slice(openingIndex + 1, closingIndex);
  }
  return null;
}

function stringConfigurationProperty(source: string, property: string): string | null {
  const pattern = new RegExp(`\\b${property}\\s*:\\s*([\"'\\x60])([^\"'\\x60\\r\\n]*)\\1`, "g");
  for (const match of source.matchAll(pattern)) {
    if (match.index !== undefined && isTopLevelPosition(source, match.index)) return match[2] ?? null;
  }
  return null;
}

function safeOutputDirectory(value: string | null, fallback: string): string {
  if (value === null || value.length > 160 || value.includes("\\") || value.startsWith("/")) return fallback;
  const normalized = value.startsWith("./") ? value.slice(2) : value;
  const segments = normalized.split("/");
  if (
    segments.length === 0
    || segments.some((segment) => !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment))
  ) return fallback;
  return segments.join("/");
}

function configuredAstroOutputDirectory(config: string): string {
  const object = configurationObject(config);
  return safeOutputDirectory(object ? stringConfigurationProperty(object, "outDir") : null, "dist");
}

function configuredViteOutputDirectory(config: string): string {
  const object = configurationObject(config);
  const build = object ? nestedConfigurationObject(object, "build") : null;
  return safeOutputDirectory(build ? stringConfigurationProperty(build, "outDir") : null, "dist");
}

function hasAstroNodeStandaloneAdapter(config: string): boolean {
  const uncommented = withoutJavaScriptComments(config);
  const importMatch = /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*([\"'])@astrojs\/node\2/.exec(uncommented);
  const localName = importMatch?.[1];
  const object = configurationObject(uncommented);
  if (!localName || !object) return false;
  const escapedName = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const adapterPattern = new RegExp(`\\badapter\\s*:\\s*${escapedName}\\s*\\(\\s*\\{`, "g");
  for (const match of object.matchAll(adapterPattern)) {
    if (match.index === undefined || !isTopLevelPosition(object, match.index)) continue;
    const openingIndex = object.indexOf("{", match.index);
    const closingIndex = matchingBrace(object, openingIndex);
    if (closingIndex === null) continue;
    const options = object.slice(openingIndex + 1, closingIndex);
    return stringConfigurationProperty(options, "mode") === "standalone";
  }
  return false;
}

interface MutableEnvironmentRequirement extends ProjectEnvironmentRequirement {
  sourceIdentities: Set<string>;
}

const PUBLIC_ENVIRONMENT_PREFIXES = ["NEXT_PUBLIC_", "NUXT_PUBLIC_", "PUBLIC_", "REACT_APP_", "VITE_"];

function publicEnvironmentKey(key: string): boolean {
  return PUBLIC_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function secretEnvironmentKey(key: string): boolean {
  if (publicEnvironmentKey(key)) return false;
  return /(?:API_?KEY|ACCESS_?KEY|AUTH|CREDENTIAL|DATABASE_URL|DB_URL|PASS(?:WORD)?|PRIVATE|SECRET|TOKEN)/.test(key);
}

function environmentScope(filePath: string, key: string): EnvironmentRequirementScope {
  if (publicEnvironmentKey(key)) return "build";
  const name = basename(filePath);
  return /^(?:next|astro|vite)\.config\./.test(name) ? "build" : "runtime";
}

function mergedEnvironmentScope(
  left: EnvironmentRequirementScope,
  right: EnvironmentRequirementScope
): EnvironmentRequirementScope {
  return left === right ? left : "both";
}

function sourceLineLocator(content: string): (index: number) => number {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return (index: number): number => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((starts[middle] ?? 0) <= index) low = middle + 1;
      else high = middle;
    }
    return Math.max(1, low);
  };
}

function sourceBelongsToApplication(filePath: string, root: string): boolean {
  return root === "." || filePath.startsWith(`${root}/`);
}

function explicitlyRequiredEnvironmentKey(source: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const access = `(?:process\\.env(?:\\.${escaped}|\\[\\s*[\"']${escaped}[\"']\\s*\\])|import\\.meta\\.env\\.${escaped}|Deno\\.env\\.get\\(\\s*[\"']${escaped}[\"']\\s*\\)|Bun\\.env\\.${escaped})`;
  return new RegExp(`${access}\\s*!`).test(source)
    || new RegExp(`if\\s*\\(\\s*!\\s*${access}\\s*\\)[\\s\\S]{0,240}?\\bthrow\\b`).test(source)
    || new RegExp(`(?:assert|invariant)\\s*\\(\\s*${access}`).test(source);
}

function addEnvironmentRequirement(
  requirements: Map<string, MutableEnvironmentRequirement>,
  requirement: Omit<ProjectEnvironmentRequirement, "sources"> & { source: ProjectEnvironmentRequirementSource }
): void {
  const key = requirement.key.toUpperCase();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) return;
  const sourceIdentity = `${requirement.source.path}:${requirement.source.line}:${requirement.source.kind}`;
  const existing = requirements.get(key);
  if (existing) {
    existing.required ||= requirement.required;
    existing.secret ||= requirement.secret;
    existing.scope = mergedEnvironmentScope(existing.scope, requirement.scope);
    if (requirement.confidence === "high") existing.confidence = "high";
    if (!existing.sourceIdentities.has(sourceIdentity) && existing.sources.length < 5) {
      existing.sourceIdentities.add(sourceIdentity);
      existing.sources.push(requirement.source);
    }
    return;
  }
  requirements.set(key, {
    key,
    required: requirement.required,
    secret: requirement.secret,
    scope: requirement.scope,
    visibility: publicEnvironmentKey(key) ? "public" : "server",
    confidence: requirement.confidence,
    sources: [requirement.source],
    sourceIdentities: new Set([sourceIdentity])
  });
}

function sourceEnvironmentReferences(source: string): Array<{ key: string; index: number }> {
  const references: Array<{ key: string; index: number }> = [];
  const patterns = [
    /\bprocess\.env\.([A-Z_][A-Z0-9_]*)\b/g,
    /\bprocess\.env\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g,
    /\bimport\.meta\.env\.([A-Z_][A-Z0-9_]*)\b/g,
    /\bDeno\.env\.get\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g,
    /\bBun\.env\.([A-Z_][A-Z0-9_]*)\b/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match.index !== undefined && match[1]) references.push({ key: match[1], index: match.index });
    }
  }
  return references;
}

function environmentRequirements(
  root: string,
  files: ReadonlyMap<string, ProjectFileFact>
): ProjectEnvironmentRequirement[] {
  const requirements = new Map<string, MutableEnvironmentRequirement>();
  for (const file of files.values()) {
    const content = file.content;
    if (!content) continue;
    const name = basename(file.path);
    const example = rootOf(file.path) === root
      && /^\.env(?:\.[a-z0-9_-]+)*\.(?:example|sample)$/i.test(name);
    if (example) {
      let previousComment = "";
      content.split(/\r?\n/).forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("#")) {
          previousComment = trimmed.slice(1).trim();
          return;
        }
        const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^#]*)/);
        if (!match?.[1]) {
          if (trimmed) previousComment = "";
          return;
        }
        const optional = /\boptional\b/i.test(`${previousComment} ${line.slice(match[0].length)}`);
        const value = match[2]?.trim() ?? "";
        addEnvironmentRequirement(requirements, {
          key: match[1],
          required: !optional && value.length === 0,
          secret: secretEnvironmentKey(match[1].toUpperCase()),
          scope: environmentScope(file.path, match[1].toUpperCase()),
          visibility: publicEnvironmentKey(match[1].toUpperCase()) ? "public" : "server",
          confidence: "high",
          source: { path: file.path, line: index + 1, kind: "example" }
        });
        previousComment = "";
      });
      continue;
    }
    if (!sourceBelongsToApplication(file.path, root) || !isEnvironmentSourceContentPath(file.path)) continue;

    const uncommented = withoutJavaScriptComments(content);
    const lineAt = sourceLineLocator(uncommented);
    for (const reference of sourceEnvironmentReferences(uncommented)) {
      const required = explicitlyRequiredEnvironmentKey(uncommented, reference.key);
      addEnvironmentRequirement(requirements, {
        key: reference.key,
        required,
        secret: secretEnvironmentKey(reference.key),
        scope: environmentScope(file.path, reference.key),
        visibility: publicEnvironmentKey(reference.key) ? "public" : "server",
        confidence: required ? "high" : "medium",
        source: { path: file.path, line: lineAt(reference.index), kind: required ? "validation" : "reference" }
      });
    }

    const envSchema = /(?:createEnv|envsafe|processEnv|runtimeEnv)/.test(uncommented)
      || /(?:^|[._-])env(?:ironment)?(?:[._-]|$)/i.test(name);
    if (!envSchema) continue;
    const schemaPattern = /\b([A-Z_][A-Z0-9_]*)\s*:\s*z\.[A-Za-z_$][\w$]*\s*\([^\r\n]{0,240}/g;
    for (const match of uncommented.matchAll(schemaPattern)) {
      if (match.index === undefined || !match[1]) continue;
      const required = !/\.optional\s*\(/.test(match[0]);
      addEnvironmentRequirement(requirements, {
        key: match[1],
        required,
        secret: secretEnvironmentKey(match[1]),
        scope: environmentScope(file.path, match[1]),
        visibility: publicEnvironmentKey(match[1]) ? "public" : "server",
        confidence: "high",
        source: { path: file.path, line: lineAt(match.index), kind: "validation" }
      });
    }
  }
  return [...requirements.values()]
    .map(({ sourceIdentities: _sourceIdentities, ...requirement }) => requirement)
    .sort((left, right) => Number(right.required) - Number(left.required) || left.key.localeCompare(right.key));
}

function environmentAnalysis(
  root: string,
  files: ReadonlyMap<string, ProjectFileFact>
): Pick<ProjectApplicationAnalysis, "environmentKeys" | "environmentRequirements"> {
  const requirements = environmentRequirements(root, files);
  return {
    environmentKeys: requirements.map((requirement) => requirement.key).sort((left, right) => left.localeCompare(right)),
    environmentRequirements: requirements
  };
}

function applicationId(root: string): string {
  return `app_${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
}

function withDockerfile(
  application: ProjectApplicationAnalysis,
  root: string,
  paths: ReadonlySet<string>
): ProjectApplicationAnalysis {
  if (!paths.has(joinRoot(root, "Dockerfile"))) return application;
  return {
    ...application,
    buildType: "dockerfile",
    rendering: "container",
    outputDirectory: null,
    evidence: [...application.evidence, "Dockerfile found at application root"]
  };
}

function detectPackageApplication(
  root: string,
  manifest: PackageManifest,
  manifests: ReadonlyMap<string, PackageManifest>,
  files: ReadonlyMap<string, ProjectFileFact>,
  paths: ReadonlySet<string>
): ProjectApplicationAnalysis | null {
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  const manager = packageManagerFor(root, manifest, manifests, paths);
  const buildCommand = manifest.scripts?.build ? managerCommand(manager, "build") : null;
  const startCommand = manifest.scripts?.start ? managerCommand(manager, "start") : null;
  const detectedEnvironment = environmentAnalysis(root, files);
  const common = {
    id: applicationId(root),
    rootDirectory: root,
    name: manifest.name?.trim() || rootName(root),
    packageManager: manager,
    buildCommand,
    healthcheckPath: "/",
    ...detectedEnvironment,
    confidence: 0.98
  };

  if (dependencies.next) {
    const nextConfig = configContent(root, files, ["next.config"]);
    const isExport = /\boutput\s*:\s*["']export["']/.test(nextConfig)
      || /\bnext\s+export\b/.test(manifest.scripts?.build ?? "");
    return withDockerfile({
      ...common,
      framework: "next",
      frameworkVersion: dependencies.next,
      rendering: isExport ? "static" : "ssr",
      buildType: isExport ? "static" : "auto",
      startCommand: isExport ? null : startCommand ?? managerBinaryCommand(manager, "next", "start"),
      outputDirectory: isExport ? "out" : null,
      port: isExport ? 8080 : 3000,
      spaFallback: false,
      evidence: ["next dependency found in package.json", ...(isExport ? ["Next.js static export configured"] : ["Next.js server rendering selected"])]
    }, root, paths);
  }

  if (dependencies.astro) {
    const astroConfig = configContent(root, files, ["astro.config"]);
    const astroObject = configurationObject(astroConfig);
    const configuredOutput = astroObject ? stringConfigurationProperty(astroObject, "output") : null;
    const configuredServerOutput = configuredOutput === "server" || configuredOutput === "hybrid";
    const outputDirectory = configuredAstroOutputDirectory(astroConfig);
    const serverOutput = configuredServerOutput;
    const supportedServerOutput = serverOutput
      && Boolean(dependencies["@astrojs/node"])
      && hasAstroNodeStandaloneAdapter(astroConfig);
    return withDockerfile({
      ...common,
      framework: "astro",
      frameworkVersion: dependencies.astro,
      rendering: serverOutput ? "server" : "static",
      buildType: supportedServerOutput ? "node" : serverOutput ? "auto" : "static",
      startCommand: supportedServerOutput ? `node ./${outputDirectory}/server/entry.mjs` : null,
      outputDirectory: serverOutput ? null : outputDirectory,
      port: serverOutput ? 4321 : 8080,
      spaFallback: false,
      evidence: [
        "astro dependency found in package.json",
        supportedServerOutput
          ? "Astro server output with configured Node standalone adapter detected"
          : serverOutput
            ? "Astro server output requires a compatible Dockerfile"
            : "Astro static output selected"
      ]
    }, root, paths);
  }

  const hasReact = Boolean(dependencies.react || dependencies["react-dom"]);
  const hasVite = Boolean(dependencies.vite);
  const hasCreateReactApp = Boolean(dependencies["react-scripts"]);
  const viteOutputDirectory = hasVite
    ? configuredViteOutputDirectory(configContent(root, files, ["vite.config"]))
    : "dist";
  if (hasReact && (hasVite || hasCreateReactApp)) {
    return withDockerfile({
      ...common,
      framework: "react",
      frameworkVersion: dependencies.react ?? dependencies["react-dom"] ?? null,
      rendering: "spa",
      buildType: "static",
      startCommand: null,
      outputDirectory: hasCreateReactApp ? "build" : viteOutputDirectory,
      port: 8080,
      spaFallback: true,
      evidence: ["React dependency found in package.json", hasCreateReactApp ? "Create React App build detected" : "Vite build detected"]
    }, root, paths);
  }

  if (hasVite) {
    return withDockerfile({
      ...common,
      framework: "vite",
      frameworkVersion: dependencies.vite ?? null,
      rendering: "spa",
      buildType: "static",
      startCommand: null,
      outputDirectory: viteOutputDirectory,
      port: 8080,
      spaFallback: true,
      evidence: ["vite dependency found in package.json"]
    }, root, paths);
  }

  if (manifest.scripts?.start) {
    return withDockerfile({
      ...common,
      framework: "node",
      frameworkVersion: null,
      rendering: "server",
      buildType: "node",
      startCommand,
      outputDirectory: null,
      port: 3000,
      spaFallback: false,
      evidence: ["start script found in package.json"]
    }, root, paths);
  }

  return null;
}

export function isPublishableFileCollection(filePaths: readonly string[]): boolean {
  const publicFiles = filePaths.filter((filePath) => (
    !isIgnoredAnalysisPath(filePath) && !filePath.split("/").some((segment) => segment.startsWith("."))
  ));
  return publicFiles.length > 0 && publicFiles.every((filePath) => {
    const name = basename(filePath);
    if (FILE_STORAGE_BLOCKED_PROJECT_FILES.has(name)) return false;
    const extension = path.posix.extname(name);
    return FILE_STORAGE_EXTENSIONS.has(extension) || FILE_STORAGE_EXTENSIONLESS_FILES.has(name);
  });
}

function applicationPriority(framework: DetectedFramework): number {
  return {
    next: 90,
    react: 80,
    astro: 70,
    vite: 60,
    static: 50,
    dockerfile: 40,
    node: 30,
    files: 20,
    unknown: 0
  }[framework];
}

export function analyzeProjectFiles(
  input: readonly ProjectFileFact[],
  options: { partial?: boolean } = {}
): ProjectAnalysis {
  const parsed = ProjectAnalysisRequestSchema.parse({ files: input }).files
    .filter((file) => !isIgnoredAnalysisPath(file.path));
  const files = new Map(parsed.map((file) => [file.path, file]));
  const paths = new Set(files.keys());
  const applications = new Map<string, ProjectApplicationAnalysis>();
  const manifests = new Map<string, PackageManifest>();

  for (const file of parsed) {
    if (basename(file.path) !== "package.json" || file.content === undefined) continue;
    const manifest = parsePackageManifest(file.content);
    if (manifest) manifests.set(rootOf(file.path), manifest);
  }

  for (const [root, manifest] of manifests) {
    const application = detectPackageApplication(root, manifest, manifests, files, paths);
    if (application) applications.set(root, application);
  }

  for (const file of parsed) {
    if (basename(file.path) !== "dockerfile") continue;
    const root = rootOf(file.path);
    if (applications.has(root)) continue;
    applications.set(root, {
      id: applicationId(root),
      rootDirectory: root,
      name: rootName(root),
      framework: "dockerfile",
      frameworkVersion: null,
      rendering: "container",
      packageManager: null,
      buildType: "dockerfile",
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      port: 3000,
      healthcheckPath: "/",
      spaFallback: false,
      ...environmentAnalysis(root, files),
      confidence: 0.99,
      evidence: ["Dockerfile found at application root"]
    });
  }

  for (const file of parsed) {
    if (basename(file.path) !== "index.html") continue;
    const root = rootOf(file.path);
    if ([...applications.keys()].some((applicationRoot) => (
      applicationRoot === "." || root === applicationRoot || root.startsWith(`${applicationRoot}/`)
    ))) continue;
    applications.set(root, {
      id: applicationId(root),
      rootDirectory: root,
      name: rootName(root),
      framework: "static",
      frameworkVersion: null,
      rendering: "static",
      packageManager: null,
      buildType: "static",
      buildCommand: null,
      startCommand: null,
      outputDirectory: ".",
      port: 8080,
      healthcheckPath: "/",
      spaFallback: false,
      ...environmentAnalysis(root, files),
      confidence: 0.98,
      evidence: ["index.html found"]
    });
  }

  if (applications.size === 0) {
    const fileStorage = isPublishableFileCollection(parsed.map((file) => file.path));
    if (fileStorage) {
      applications.set(".", {
        id: applicationId("."),
        rootDirectory: ".",
        name: "Files",
        framework: "files",
        frameworkVersion: null,
        rendering: "files",
        packageManager: null,
        buildType: "auto",
        buildCommand: null,
        startCommand: null,
        outputDirectory: ".",
        port: 8080,
        healthcheckPath: "/",
        spaFallback: false,
        ...environmentAnalysis(".", files),
        confidence: 0.98,
        evidence: ["Only publishable files were found"]
      });
    }
  }

  const allApplications = [...applications.values()]
    .map((application) => options.partial ? {
      ...application,
      confidence: Math.min(application.confidence, 0.75),
      evidence: [...application.evidence, "Repository tree was only partially available"]
    } : application)
    .sort((left, right) => (
      right.confidence - left.confidence
      || applicationPriority(right.framework) - applicationPriority(left.framework)
      || left.rootDirectory.split("/").length - right.rootDirectory.split("/").length
      || left.rootDirectory.localeCompare(right.rootDirectory)
    ));
  const ordered = allApplications.length > MAX_ANALYSIS_APPLICATIONS
    ? allApplications.slice(0, MAX_ANALYSIS_APPLICATIONS).map((application, index) => index === 0 ? {
        ...application,
        evidence: [...application.evidence, `${allApplications.length - MAX_ANALYSIS_APPLICATIONS} additional applications omitted`]
      } : application)
    : allApplications;
  const fingerprint = createHash("sha256");
  for (const file of [...parsed].sort((left, right) => left.path.localeCompare(right.path))) {
    fingerprint.update(file.path).update("\0").update(String(file.size ?? Buffer.byteLength(file.content ?? "", "utf8"))).update("\0");
    if (file.content !== undefined) fingerprint.update(createHash("sha256").update(file.content).digest());
    fingerprint.update("\0");
  }
  return {
    fingerprint: fingerprint.digest("hex"),
    applications: ordered,
    recommendedApplicationId: ordered[0]?.id ?? null
  };
}

export function parseStoredProjectAnalysis(value: string | null | undefined): ProjectAnalysis | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as ProjectAnalysis;
    if (
      typeof parsed.fingerprint !== "string"
      || !Array.isArray(parsed.applications)
      || !(typeof parsed.recommendedApplicationId === "string" || parsed.recommendedApplicationId === null)
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function analyzeProjectDirectory(directory: string): ProjectAnalysis {
  const root = fs.realpathSync(directory);
  const facts: ProjectFileFact[] = [];
  let contentBytes = 0;
  let sourceContentBytes = 0;
  let partial = false;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && IGNORED_DIRECTORY_SEGMENTS.has(entry.name.toLowerCase())) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.toLowerCase() === ".ds_store") continue;
      if (facts.length >= MAX_ANALYSIS_PATHS) {
        partial = true;
        continue;
      }
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (relative.length > 240) {
        partial = true;
        continue;
      }
      const stat = fs.statSync(absolute);
      const fact: ProjectFileFact = { path: relative, size: stat.size };
      if (requiresAnalysisContent(relative)) {
        const sourceFile = isEnvironmentSourceOnlyPath(relative);
        if (
          contentBytes + stat.size > MAX_ANALYSIS_CONTENT_BYTES
          || (sourceFile && (
            stat.size > MAX_ANALYSIS_SOURCE_FILE_BYTES
            || sourceContentBytes + stat.size > MAX_ANALYSIS_SOURCE_CONTENT_BYTES
          ))
        ) {
          partial = true;
          facts.push(fact);
          continue;
        }
        try {
          fact.content = fs.readFileSync(absolute, "utf8");
          const bytes = Buffer.byteLength(fact.content, "utf8");
          contentBytes += bytes;
          if (sourceFile) sourceContentBytes += bytes;
        } catch {
          partial = true;
        }
      }
      facts.push(fact);
    }
  }
  return analyzeProjectFiles(facts, { partial });
}

function stripCommonArchiveWrapper(facts: readonly ProjectFileFact[]): ProjectFileFact[] {
  if (facts.length === 0) return [];
  const firstPath = facts[0]?.path;
  const separator = firstPath?.indexOf("/") ?? -1;
  if (!firstPath || separator < 1) return [...facts];
  const wrapper = firstPath.slice(0, separator);
  if (!facts.every((fact) => fact.path.startsWith(`${wrapper}/`))) return [...facts];
  return facts.map((fact) => ({ ...fact, path: fact.path.slice(wrapper.length + 1) }));
}

export function analyzeZipProject(archivePath: string): Promise<ProjectAnalysis> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) return reject(badRequest("ZIP archive cannot be analyzed", "INVALID_ZIP"));
      const facts: ProjectFileFact[] = [];
      let contentBytes = 0;
      let sourceContentBytes = 0;
      let partial = false;
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };
      const next = (): void => zip.readEntry();
      zip.on("entry", (entry) => {
        if (entry.fileName.endsWith("/")) return next();
        const normalized: string = String(entry.fileName).replaceAll("\\", "/");
        if (normalized.length > 240) {
          partial = true;
          return next();
        }
        const pathCheck = SafeRelativePath.safeParse(normalized);
        if (!pathCheck.success) return fail(badRequest("ZIP contains an unsafe file path", "ZIP_UNSAFE_PATH"));
        const segments = normalized.split("/");
        if (
          basename(normalized) === ".ds_store"
          || segments.some((segment) => IGNORED_DIRECTORY_SEGMENTS.has(segment.toLowerCase()))
        ) return next();
        if (facts.length >= MAX_ANALYSIS_PATHS) {
          partial = true;
          return next();
        }
        const fact: ProjectFileFact = { path: normalized, size: entry.uncompressedSize };
        if (!requiresAnalysisContent(normalized)) {
          facts.push(fact);
          return next();
        }
        const sourceFile = isEnvironmentSourceOnlyPath(normalized);
        if (
          contentBytes + entry.uncompressedSize > MAX_ANALYSIS_CONTENT_BYTES
          || (sourceFile && (
            entry.uncompressedSize > MAX_ANALYSIS_SOURCE_FILE_BYTES
            || sourceContentBytes + entry.uncompressedSize > MAX_ANALYSIS_SOURCE_CONTENT_BYTES
          ))
        ) {
          partial = true;
          facts.push(fact);
          return next();
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(badRequest("ZIP configuration file cannot be read", "INVALID_ZIP"));
          const chunks: Buffer[] = [];
          let bytes = 0;
          stream.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (
              contentBytes + bytes > MAX_ANALYSIS_CONTENT_BYTES
              || (sourceFile && (
                bytes > MAX_ANALYSIS_SOURCE_FILE_BYTES
                || sourceContentBytes + bytes > MAX_ANALYSIS_SOURCE_CONTENT_BYTES
              ))
            ) {
              stream.destroy(badRequest("ZIP project configuration is too large to analyze", "ANALYSIS_CONTENT_TOO_LARGE"));
              return;
            }
            chunks.push(chunk);
          });
          let finished = false;
          stream.once("error", () => {
            if (finished) return;
            finished = true;
            partial = true;
            facts.push(fact);
            next();
          });
          stream.once("end", () => {
            if (finished) return;
            finished = true;
            fact.content = Buffer.concat(chunks).toString("utf8");
            const contentLength = Buffer.byteLength(fact.content, "utf8");
            contentBytes += contentLength;
            if (sourceFile) sourceContentBytes += contentLength;
            facts.push(fact);
            next();
          });
        });
      });
      zip.once("error", fail);
      zip.once("end", () => {
        if (settled) return;
        settled = true;
        try {
          resolve(analyzeProjectFiles(stripCommonArchiveWrapper(facts), { partial }));
        } catch (error) {
          reject(error);
        }
      });
      next();
    });
  });
}

export function relevantGitHubTreePaths(
  files: readonly ProjectFileFact[],
  truncated: boolean
): { files: ProjectFileFact[]; partial: boolean } {
  const publishableTree = files.filter((file) => !isIgnoredAnalysisPath(file.path));
  if (publishableTree.length <= MAX_ANALYSIS_PATHS && !truncated) return { files: publishableTree, partial: false };
  const structural = publishableTree.filter((file) => {
    const name = basename(file.path);
    return isProjectConfigurationContentPath(file.path)
      || name === "dockerfile"
      || name === "index.html"
      || LOCK_FILES.includes(name as typeof LOCK_FILES[number]);
  });
  if (structural.length > MAX_ANALYSIS_PATHS) {
    throw badRequest("GitHub repository is too large to analyze safely", "GITHUB_ANALYSIS_TOO_LARGE");
  }
  const source = publishableTree
    .filter((file) => isEnvironmentSourceOnlyPath(file.path))
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, MAX_ANALYSIS_PATHS - structural.length);
  return { files: [...structural, ...source], partial: true };
}
