import fs from "node:fs";
import path from "node:path";
import { resolveRealWithin } from "../lib/security.js";
import { assertValidStaticBasePath } from "../lib/static-base-path.js";
import type { ProjectRow } from "../types/models.js";
import { analyzeProjectDirectory, isPublishableFileCollection } from "./project-analysis.js";

export interface BuildPlan {
  kind: "dockerfile" | "next" | "node" | "static" | "files";
  contextDirectory: string;
  dockerfilePath: string;
  internalPort: number;
  description: string;
}

interface PackageManifest {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
  workspaces?: unknown;
}

const HTML_ABSOLUTE_ASSET_REFERENCE = /\b(?:src|href)\s*=\s*(["'])(\/[^"'?#]*)(?:[?#][^"']*)?\1/gi;
const SAFE_STATIC_BASE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._~-]*$/;
const FILE_STORAGE_IGNORED_FILES = new Set([".ds_store", "desktop.ini", "thumbs.db"]);

function isHiddenOrMetadataEntry(name: string): boolean {
  const normalized = name.toLowerCase();
  return name.startsWith(".") || normalized === "__macosx" || FILE_STORAGE_IGNORED_FILES.has(normalized);
}

function isAutomaticFileStorage(directory: string): boolean {
  const pending = [directory];
  const publicFiles: string[] = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (isHiddenOrMetadataEntry(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute);
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) {
        pending.push(resolveRealWithin(directory, relative));
        continue;
      }
      if (!entry.isFile()) return false;

      resolveRealWithin(directory, relative);
      publicFiles.push(relative.split(path.sep).join("/"));
    }
  }

  return isPublishableFileCollection(publicFiles);
}

function basePathForFileReference(directory: string, reference: string): string | null {
  if (reference.startsWith("//")) return null;
  const segments = reference.slice(1).split("/");
  if (
    segments.length === 0
    || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))
  ) {
    return null;
  }

  // Prefer the longest matching path inside the distribution. For example,
  // /dhd/assets/app.js maps to the local assets/app.js and therefore yields
  // /dhd, while /assets/app.js maps directly and yields the root path.
  for (let index = 0; index < segments.length; index += 1) {
    const relativeFile = segments.slice(index).join("/");
    const lexicalFile = path.resolve(directory, relativeFile);
    if (!fs.existsSync(lexicalFile)) continue;
    try {
      const realFile = resolveRealWithin(directory, relativeFile);
      if (!fs.statSync(realFile).isFile()) continue;
    } catch {
      // References through an escaping symlink are not evidence for a base
      // path and must never influence generated Docker or Nginx paths.
      continue;
    }

    const baseSegments = segments.slice(0, index);
    if (!baseSegments.every((segment) => SAFE_STATIC_BASE_SEGMENT.test(segment))) return null;
    return baseSegments.length > 0 ? `/${baseSegments.join("/")}` : "";
  }
  return null;
}

function inferStaticBasePath(directory: string): string {
  const indexPath = path.join(directory, "index.html");
  if (!fs.existsSync(indexPath)) return "";

  let html: string;
  try {
    html = fs.readFileSync(resolveRealWithin(directory, "index.html"), "utf8");
  } catch {
    return "";
  }

  const basePaths = [...html.matchAll(HTML_ABSOLUTE_ASSET_REFERENCE)]
    .map((match) => match[2])
    .filter((reference): reference is string => Boolean(reference))
    .map((reference) => basePathForFileReference(directory, reference))
    .filter((basePath): basePath is string => basePath !== null);
  if (basePaths.length === 0) return "";

  const expected = basePaths[0] ?? "";
  return basePaths.every((basePath) => basePath === expected) ? expected : "";
}

function readPackageManifest(directory: string, required = false): PackageManifest | null {
  const manifestPath = path.join(directory, "package.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(resolveRealWithin(directory, "package.json"), "utf8")) as PackageManifest;
  } catch {
    if (required) throw new Error("package.json ist kein gültiges JSON");
    return null;
  }
}

function hasWorkspaceDeclaration(manifest: PackageManifest | null): boolean {
  if (!manifest?.workspaces) return false;
  if (Array.isArray(manifest.workspaces)) return manifest.workspaces.length > 0;
  if (typeof manifest.workspaces !== "object") return false;
  const packages = (manifest.workspaces as { packages?: unknown }).packages;
  return Array.isArray(packages) && packages.length > 0;
}

interface GeneratedBuildLayout {
  contextDirectory: string;
  applicationDirectory: string;
  applicationPath: string;
  managerManifest: PackageManifest;
  workspace: boolean;
}

function generatedBuildLayout(
  sourceDirectory: string,
  applicationDirectory: string,
  applicationManifest: PackageManifest
): GeneratedBuildLayout {
  let current = path.dirname(applicationDirectory);
  while (current !== applicationDirectory) {
    const relative = path.relative(sourceDirectory, current);
    if (relative.startsWith("..") || path.isAbsolute(relative)) break;
    const manifest = readPackageManifest(current);
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml")) || hasWorkspaceDeclaration(manifest)) {
      return {
        contextDirectory: current,
        applicationDirectory,
        applicationPath: path.relative(current, applicationDirectory).split(path.sep).join("/"),
        managerManifest: manifest ?? applicationManifest,
        workspace: true
      };
    }
    if (current === sourceDirectory) break;
    current = path.dirname(current);
  }
  return {
    contextDirectory: applicationDirectory,
    applicationDirectory,
    applicationPath: ".",
    managerManifest: applicationManifest,
    workspace: false
  };
}

export function createBuildPlan(
  project: ProjectRow,
  extractedSource: string,
  generationDirectory: string,
  staticBasePathSnapshot: string | null = project.static_base_path
): BuildPlan {
  assertValidStaticBasePath(staticBasePathSnapshot);
  const sourceDirectory = fs.realpathSync(extractedSource);
  const contextDirectory = resolveRealWithin(sourceDirectory, project.root_directory);
  if (!fs.existsSync(contextDirectory) || !fs.statSync(contextDirectory).isDirectory()) {
    throw new Error(`Root-Verzeichnis '${project.root_directory}' existiert nicht`);
  }

  const dockerfileExists = fs.existsSync(path.resolve(contextDirectory, project.dockerfile_path));
  if (project.build_type === "dockerfile" || (project.build_type === "auto" && dockerfileExists)) {
    if (staticBasePathSnapshot && staticBasePathSnapshot !== "/") {
      throw new Error("Ein manueller Hosting-Basispfad wird bei eigenen Dockerfiles nicht unterstützt; konfiguriere das Routing stattdessen im Dockerfile");
    }
    if (!dockerfileExists) throw new Error(`Dockerfile '${project.dockerfile_path}' wurde nicht gefunden`);
    const requestedDockerfile = resolveRealWithin(contextDirectory, project.dockerfile_path);
    return {
      kind: "dockerfile",
      contextDirectory,
      dockerfilePath: requestedDockerfile,
      internalPort: project.port,
      description: `Eigenes Dockerfile (${project.dockerfile_path})`
    };
  }

  const manifest = readPackageManifest(contextDirectory, true);

  const dependencies = { ...manifest?.dependencies, ...manifest?.devDependencies };
  const isNext = Boolean(dependencies.next);
  const isVite = Boolean(dependencies.vite);
  const selectedRoot = path.relative(sourceDirectory, contextDirectory).split(path.sep).join("/") || ".";
  const analysis = analyzeProjectDirectory(sourceDirectory);
  const detected = analysis.applications.find((application) => application.rootDirectory === selectedRoot);
  const generatedLayout = manifest ? generatedBuildLayout(sourceDirectory, contextDirectory, manifest) : null;
  const detectedStaticBuild = Boolean(
    detected
    && detected.buildType === "static"
    && ["next", "react", "astro", "vite"].includes(detected.framework)
  );
  const detectedServerBuild = Boolean(
    detected
    && (detected.buildType === "node" || (detected.buildType === "auto" && ["next", "node"].includes(detected.framework)))
  );
  if (detected?.framework === "astro" && detected.rendering === "server" && detected.buildType !== "node") {
    throw new Error("Astro Server-Projekte benötigen einen konfigurierten @astrojs/node Standalone-Adapter oder ein eigenes Dockerfile");
  }
  if (project.build_type === "node" || (project.build_type === "auto" && manifest && detectedServerBuild)) {
    if (!manifest) throw new Error("Für den Node-Build fehlt package.json");
    if (staticBasePathSnapshot && staticBasePathSnapshot !== "/") {
      throw new Error("Ein manueller Hosting-Basispfad wird nur für statische Distributionen unterstützt und kann nicht auf Next.js oder Node.js angewendet werden");
    }
    const detectedStartCommand = detected?.buildType === "node" || detected?.framework === "next"
      ? detected.startCommand
      : null;
    if (!manifest.scripts?.start && !detectedStartCommand) {
      throw new Error("package.json benötigt ein 'start'-Script; alternativ ein Dockerfile verwenden");
    }
    const kind = isNext ? "next" : "node";
    if (!generatedLayout) throw new Error("Für den Node-Build fehlt package.json");
    const generated = generateNodeDockerfile(
      generatedLayout,
      generationDirectory,
      manifest,
      project.port,
      detectedStartCommand ?? undefined
    );
    return {
      kind,
      contextDirectory: generatedLayout.contextDirectory,
      dockerfilePath: generated,
      internalPort: project.port,
      description: isNext ? "Next.js Auto-Preset" : "Node.js Auto-Preset"
    };
  }

  const rawStatic = fs.existsSync(path.join(contextDirectory, "index.html"));
  const safeFileCollection = isAutomaticFileStorage(contextDirectory);
  const explicitFileStorage = project.build_type === "static"
    && !isVite
    && !detectedStaticBuild
    && !rawStatic
    && safeFileCollection;
  const automaticFileStorage = project.build_type === "auto"
    && !isVite
    && !rawStatic
    && safeFileCollection;
  if (explicitFileStorage || automaticFileStorage) {
    const staticBasePath = staticBasePathSnapshot === null || staticBasePathSnapshot === "/"
      ? ""
      : staticBasePathSnapshot;
    const generated = generateFileStorageDockerfile(generationDirectory, staticBasePath);
    const baseDescription = staticBasePathSnapshot === "/"
      ? " (root path, manual)"
      : staticBasePathSnapshot
        ? ` (path ${staticBasePathSnapshot}/, manual)`
        : "";
    return {
      kind: "files",
      contextDirectory,
      dockerfilePath: generated,
      internalPort: 8080,
      description: `File storage${baseDescription}`
    };
  }

  const explicitStaticWebsite = project.build_type === "static" && (detectedStaticBuild || isVite || rawStatic);
  if (explicitStaticWebsite || (project.build_type === "auto" && (detectedStaticBuild || isVite || rawStatic))) {
    const staticBasePath = staticBasePathSnapshot === null
      ? inferStaticBasePath(contextDirectory)
      : staticBasePathSnapshot === "/" ? "" : staticBasePathSnapshot;
    const shouldBuild = Boolean(manifest && (detectedStaticBuild || isVite));
    const outputDirectory = detectedStaticBuild ? detected?.outputDirectory ?? "dist" : "dist";
    // Preserve the existing fallback for raw static uploads and Vite while
    // avoiding an incorrect SPA rewrite for Astro and Next static exports.
    const spaFallback = rawStatic || detected?.spaFallback === true || isVite;
    const staticBuildLayout = shouldBuild ? generatedLayout : null;
    if (shouldBuild && !staticBuildLayout) throw new Error("Für den statischen Build fehlt package.json");
    const generated = generateStaticDockerfile(
      staticBuildLayout,
      generationDirectory,
      manifest,
      shouldBuild,
      staticBasePath,
      outputDirectory,
      spaFallback,
      detected?.framework === "next"
    );
    const baseDescription = staticBasePathSnapshot === "/"
      ? " (Basis /, manuell)"
      : staticBasePathSnapshot
        ? ` (Basis ${staticBasePathSnapshot}/, manuell)`
        : staticBasePath
          ? ` (Basis ${staticBasePath}/)`
          : "";
    return {
      kind: "static",
      contextDirectory: staticBuildLayout?.contextDirectory ?? contextDirectory,
      dockerfilePath: generated,
      internalPort: 8080,
      description: `${detectedStaticBuild
        ? `${detected?.framework === "next" ? "Next.js Export" : detected?.framework === "astro" ? "Astro Static" : detected?.framework === "react" ? "React Static" : "Vite Static"}-Preset`
        : isVite ? "Vite Static-Preset" : "Statische Website"}${baseDescription}`
    };
  }

  if (detected?.framework === "astro" && detected.rendering === "server") {
    throw new Error("Astro Server-Projekte benötigen einen konfigurierten @astrojs/node Standalone-Adapter oder ein eigenes Dockerfile");
  }
  throw new Error("Kein unterstützter Build erkannt. Unterstützt: Next.js, Node.js, Vite/static, sichere Datei-Uploads oder ein eigenes Dockerfile.");
}

interface PackageManagerCommands {
  install: string;
  build: string;
  buildCommand: [string, ...string[]];
  start: string;
  copyFiles: string[];
  configurationCopies: string[];
}

function packageManager(directory: string, manifest: PackageManifest): PackageManagerCommands {
  const declared = manifest.packageManager?.split("@", 1)[0];
  const bunLockfile = fs.existsSync(path.join(directory, "bun.lock"))
    ? "bun.lock"
    : fs.existsSync(path.join(directory, "bun.lockb")) ? "bun.lockb" : null;
  const hasPnpmLock = fs.existsSync(path.join(directory, "pnpm-lock.yaml"));
  const hasYarnLock = fs.existsSync(path.join(directory, "yarn.lock"));
  const hasNpmLock = fs.existsSync(path.join(directory, "package-lock.json"));
  const selected = (
    declared === "bun"
    || declared === "pnpm"
    || declared === "yarn"
    || declared === "npm"
  )
    ? declared
    : fs.existsSync(path.join(directory, "bun.lock"))
      ? "bun"
      : hasPnpmLock
        ? "pnpm"
        : hasYarnLock
          ? "yarn"
          : hasNpmLock
            ? "npm"
            : bunLockfile
              ? "bun"
              : "npm";
  if (selected === "bun") {
    return {
      install: `npm install --global bun@1.2.20 && bun install${bunLockfile ? " --frozen-lockfile" : ""}`,
      build: "bun run build",
      buildCommand: ["bun", "run", "build"],
      start: "bun run start",
      copyFiles: ["package.json", ...(bunLockfile ? [bunLockfile] : [])],
      configurationCopies: []
    };
  }
  if (selected === "pnpm") {
    return {
      install: `corepack enable && pnpm install${hasPnpmLock ? " --frozen-lockfile" : ""}`,
      build: "pnpm run build",
      buildCommand: ["pnpm", "run", "build"],
      start: "pnpm run start",
      copyFiles: ["package.json", ...(hasPnpmLock ? ["pnpm-lock.yaml"] : [])],
      configurationCopies: []
    };
  }
  if (selected === "yarn") {
    const hasBerryConfig = fs.existsSync(path.join(directory, ".yarnrc.yml"));
    const classicYarn = manifest.packageManager
      ? manifest.packageManager.startsWith("yarn@1.")
      : !hasBerryConfig;
    const configurationCopies = [
      ...(hasBerryConfig ? ["COPY .yarnrc.yml ./"] : []),
      ...(fs.existsSync(path.join(directory, ".yarn")) ? ["COPY .yarn ./.yarn"] : [])
    ];
    return {
      install: `corepack enable && yarn install${hasYarnLock ? ` ${classicYarn ? "--frozen-lockfile" : "--immutable"}` : ""}`,
      build: "yarn build",
      buildCommand: ["yarn", "build"],
      start: "yarn start",
      copyFiles: ["package.json", ...(hasYarnLock ? ["yarn.lock"] : [])],
      configurationCopies
    };
  }
  if (selected === "npm") {
    return {
      install: hasNpmLock ? "npm ci" : "npm install",
      build: "npm run build",
      buildCommand: ["npm", "run", "build"],
      start: "npm run start",
      copyFiles: ["package.json", ...(hasNpmLock ? ["package-lock.json"] : [])],
      configurationCopies: []
    };
  }
  return {
    install: "npm install",
    build: "npm run build",
    buildCommand: ["npm", "run", "build"],
    start: "npm run start",
    copyFiles: ["package.json"],
    configurationCopies: []
  };
}

function prepareGenerationDirectory(directory: string): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsicheres Verzeichnis für Build-Dateien");
  return directory;
}

function writeIgnoreFile(dockerfilePath: string): void {
  fs.writeFileSync(`${dockerfilePath}.dockerignore`, [
    ".git",
    ".gitignore",
    "node_modules",
    "**/node_modules",
    ".next",
    "dist",
    "build",
    "coverage",
    "*.log",
    ".env",
    ".env.*",
    "!.env.example",
    ""
  ].join("\n"), { mode: 0o600 });
}

function writeFileStorageIgnoreFile(dockerfilePath: string): void {
  fs.writeFileSync(`${dockerfilePath}.dockerignore`, [
    ".*",
    "**/.*",
    "__[Mm][Aa][Cc][Oo][Ss][Xx]",
    "**/__[Mm][Aa][Cc][Oo][Ss][Xx]",
    "[Tt][Hh][Uu][Mm][Bb][Ss].[Dd][Bb]",
    "**/[Tt][Hh][Uu][Mm][Bb][Ss].[Dd][Bb]",
    "[Dd][Ee][Ss][Kk][Tt][Oo][Pp].[Ii][Nn][Ii]",
    "**/[Dd][Ee][Ss][Kk][Tt][Oo][Pp].[Ii][Nn][Ii]",
    ""
  ].join("\n"), { mode: 0o600 });
}

function buildWithSecretEnvironment(command: [string, ...string[]]): string[] {
  const [executable, ...args] = command;
  const runner = [
    "const fs = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    "const secretPath = '/run/secrets/shelter_env';",
    "const supplied = fs.existsSync(secretPath) ? JSON.parse(fs.readFileSync(secretPath, 'utf8')) : {};",
    `const result = spawnSync(${JSON.stringify(executable)}, ${JSON.stringify(args)}, { stdio: 'inherit', env: { ...process.env, ...supplied } });`,
    "if (result.error) throw result.error;",
    "process.exit(result.status ?? 1);"
  ].join("\n");
  const encoded = Buffer.from(runner).toString("base64");
  return [
    "ARG SHELTER_CACHE_BUSTER",
    `RUN echo ${encoded} | base64 -d > /tmp/shelter-build.cjs`,
    "RUN --mount=type=secret,id=shelter_env,required=false node /tmp/shelter-build.cjs && rm -f /tmp/shelter-build.cjs"
  ];
}

function installAndSelectApplication(
  layout: GeneratedBuildLayout,
  manager: PackageManagerCommands
): string[] {
  if (layout.workspace) {
    return [
      "COPY . .",
      `RUN ${manager.install}`,
      `WORKDIR /app/${layout.applicationPath}`
    ];
  }
  return [
    `COPY ${manager.copyFiles.join(" ")} ./`,
    ...manager.configurationCopies,
    `RUN ${manager.install}`,
    "COPY . ."
  ];
}

function generateNodeDockerfile(
  layout: GeneratedBuildLayout,
  generationDirectory: string,
  manifest: PackageManifest,
  port: number,
  startCommand?: string
): string {
  const manager = packageManager(layout.contextDirectory, layout.managerManifest);
  const generatedDirectory = prepareGenerationDirectory(generationDirectory);
  const dockerfilePath = path.join(generatedDirectory, "Dockerfile");
  const buildSteps = manifest.scripts?.build ? buildWithSecretEnvironment(manager.buildCommand) : ["# No build script configured"];
  const dockerfile = [
    "FROM node:24-bookworm-slim",
    "WORKDIR /app",
    "ENV NEXT_TELEMETRY_DISABLED=1",
    ...installAndSelectApplication(layout, manager),
    ...buildSteps,
    "ENV NODE_ENV=production",
    `ENV PORT=${port}`,
    "ENV HOSTNAME=0.0.0.0",
    `EXPOSE ${port}`,
    `CMD [\"sh\", \"-lc\", ${JSON.stringify(startCommand ?? manager.start)}]`,
    ""
  ].join("\n");
  fs.writeFileSync(dockerfilePath, dockerfile, { mode: 0o600 });
  writeIgnoreFile(dockerfilePath);
  return dockerfilePath;
}

function generateStaticDockerfile(
  layout: GeneratedBuildLayout | null,
  generationDirectory: string,
  manifest: PackageManifest | null,
  shouldBuild: boolean,
  staticBasePath: string,
  outputDirectory = "dist",
  spaFallback = true,
  htmlExtensionFallback = false
): string {
  const generatedDirectory = prepareGenerationDirectory(generationDirectory);
  const dockerfilePath = path.join(generatedDirectory, "Dockerfile");
  const staticRoot = `/usr/share/nginx/html${staticBasePath}`;
  const applicationLocation = staticBasePath ? `${staticBasePath}/` : "/";
  const fallbackDocument = `${staticBasePath}/index.html`;
  const nginxConfig = [
    "server {",
    "  listen 8080;",
    "  server_name _;",
    "  absolute_redirect off;",
    "  root /usr/share/nginx/html;",
    "  index index.html;",
    "  location ~ (^|/)\\. { deny all; }",
    ...(staticBasePath ? [
      `  location = / { return 308 ${applicationLocation}; }`,
      `  location = ${staticBasePath} { return 308 ${applicationLocation}; }`
    ] : []),
    `  location ${applicationLocation} { try_files $uri $uri/${spaFallback
      ? ` ${fallbackDocument}`
      : htmlExtensionFallback ? " $uri.html =404" : " =404"}; }`,
    "  location ~* \\.(?:css|js|jpg|jpeg|gif|png|svg|ico|webp|woff2?)$ { expires 7d; add_header Cache-Control \"public, immutable\"; }",
    "}"
  ].join("\n");
  const nginxConfigBase64 = Buffer.from(nginxConfig).toString("base64");

  if (shouldBuild && manifest) {
    if (!layout) throw new Error("Für den statischen Build fehlt der Build-Kontext");
    if (!manifest.scripts?.build) throw new Error("Für den statischen Build fehlt das 'build'-Script");
    const manager = packageManager(layout.contextDirectory, layout.managerManifest);
    const outputPath = layout.applicationPath === "."
      ? `/app/${outputDirectory}`
      : `/app/${layout.applicationPath}/${outputDirectory}`;
    fs.writeFileSync(dockerfilePath, [
      "FROM node:24-bookworm-slim AS build",
      "WORKDIR /app",
      ...installAndSelectApplication(layout, manager),
      ...buildWithSecretEnvironment(manager.buildCommand),
      "FROM nginxinc/nginx-unprivileged:1.29-alpine",
      "USER root",
      `RUN echo ${nginxConfigBase64} | base64 -d > /etc/nginx/conf.d/default.conf`,
      `COPY --from=build ${outputPath} ${staticRoot}`,
      "USER 101",
      "EXPOSE 8080",
      ""
    ].join("\n"), { mode: 0o600 });
  } else {
    fs.writeFileSync(dockerfilePath, [
      "FROM nginxinc/nginx-unprivileged:1.29-alpine",
      "USER root",
      `RUN echo ${nginxConfigBase64} | base64 -d > /etc/nginx/conf.d/default.conf`,
      `COPY . ${staticRoot}`,
      "USER 101",
      "EXPOSE 8080",
      ""
    ].join("\n"), { mode: 0o600 });
  }
  writeIgnoreFile(dockerfilePath);
  return dockerfilePath;
}

function generateFileStorageDockerfile(
  generationDirectory: string,
  staticBasePath: string
): string {
  const generatedDirectory = prepareGenerationDirectory(generationDirectory);
  const dockerfilePath = path.join(generatedDirectory, "Dockerfile");
  const storageRoot = `/usr/share/nginx/html${staticBasePath}`;
  const storageLocation = staticBasePath ? `${staticBasePath}/` : "/";
  const nginxConfig = [
    "server {",
    "  listen 8080;",
    "  server_name _;",
    "  server_tokens off;",
    "  access_log off;",
    "  absolute_redirect off;",
    "  root /usr/share/nginx/html;",
    "  index index.html;",
    "  charset utf-8;",
    "  default_type application/octet-stream;",
    '  add_header X-Content-Type-Options "nosniff" always;',
    '  add_header Referrer-Policy "no-referrer" always;',
    "  location ~ (^|/)\\. { return 404; }",
    "  location ~* (^|/)(?:__MACOSX|Thumbs\\.db|desktop\\.ini)(?:/|$) { return 404; }",
    ...(staticBasePath ? [
      `  location = / { return 308 ${storageLocation}; }`,
      `  location = ${staticBasePath} { return 308 ${storageLocation}; }`,
      `  location = ${storageLocation} { default_type text/plain; return 200 "Shelter file storage is available.\\n"; }`,
      "  location / { return 404; }"
    ] : [
      '  location = / { default_type text/plain; return 200 "Shelter file storage is available.\\n"; }'
    ]),
    `  location ${storageLocation} { if (-d $request_filename) { return 404; } try_files $uri =404; }`,
    "}"
  ].join("\n");
  const nginxConfigBase64 = Buffer.from(nginxConfig).toString("base64");
  fs.writeFileSync(dockerfilePath, [
    "FROM nginxinc/nginx-unprivileged:1.29-alpine",
    "USER root",
    "RUN rm -rf /usr/share/nginx/html && mkdir -p /usr/share/nginx/html && chown 101:101 /usr/share/nginx/html",
    `RUN echo ${nginxConfigBase64} | base64 -d > /etc/nginx/conf.d/default.conf`,
    `COPY --chown=101:101 . ${storageRoot}`,
    "USER 101",
    "EXPOSE 8080",
    ""
  ].join("\n"), { mode: 0o600 });
  writeFileStorageIgnoreFile(dockerfilePath);
  return dockerfilePath;
}
