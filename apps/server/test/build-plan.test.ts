import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildPlan } from "../src/services/build-plan.js";
import { analyzeProjectDirectory } from "../src/services/project-analysis.js";
import type { ProjectRow } from "../src/types/models.js";

const temporaryDirectories: string[] = [];

function temporaryProject(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portsmith-build-"));
  temporaryDirectories.push(directory);
  return directory;
}

function generated(directory: string): string {
  const generatedDirectory = path.join(path.dirname(directory), `${path.basename(directory)}-generated`);
  temporaryDirectories.push(generatedDirectory);
  return generatedDirectory;
}

function generatedNginxConfig(dockerfile: string): string {
  const encoded = [...dockerfile.matchAll(/RUN echo ([a-zA-Z0-9+/=]+) \| base64 -d/g)].at(-1)?.[1];
  if (!encoded) throw new Error("Generated Dockerfile does not contain an Nginx configuration");
  return Buffer.from(encoded, "base64").toString("utf8");
}

function generatedBuildRunner(dockerfile: string): string {
  const encoded = dockerfile.match(/RUN echo ([a-zA-Z0-9+/=]+) \| base64 -d > \/tmp\/shelter-build\.cjs/)?.[1];
  if (!encoded) throw new Error("Generated Dockerfile does not contain a build runner");
  return Buffer.from(encoded, "base64").toString("utf8");
}

function project(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: "prj_test",
    name: "Test",
    slug: "test",
    source_type: "upload",
    repository_url: null,
    repository_branch: null,
    source_archive: "/tmp/source.zip",
    static_base_path: null,
    root_directory: ".",
    build_type: "auto",
    dockerfile_path: "Dockerfile",
    port: 3000,
    healthcheck_path: "/",
    memory_limit: "1g",
    cpu_limit: "1.0",
    active_deployment_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("build plan detection", () => {
  it("prefers a user Dockerfile", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "Dockerfile"), "FROM scratch\n");
    const plan = createBuildPlan(project(), directory, generated(directory));
    expect(plan.kind).toBe("dockerfile");
    expect(plan.dockerfilePath).toBe(fs.realpathSync(path.join(directory, "Dockerfile")));
  });

  it("detects Next.js and writes a generated Dockerfile", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      scripts: { build: "next build", start: "next start" },
      dependencies: { next: "16.0.0" }
    }));
    const plan = createBuildPlan(project(), directory, generated(directory));
    expect(plan.kind).toBe("next");
    const dockerfile = fs.readFileSync(plan.dockerfilePath, "utf8");
    expect(dockerfile).toContain("shelter_env");
    expect(dockerfile).toContain("ARG SHELTER_CACHE_BUSTER");
    expect(plan.internalPort).toBe(3000);
  });

  it("detects a Vite static application", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      scripts: { build: "vite build" },
      devDependencies: { vite: "7.0.0" }
    }));
    const plan = createBuildPlan(project(), directory, generated(directory));
    expect(plan.kind).toBe("static");
    expect(plan.internalPort).toBe(8080);
    expect(fs.readFileSync(plan.dockerfilePath, "utf8")).toContain("/app/dist");
  });

  it("copies safe custom Vite output and falls back for unsafe output", () => {
    const customDirectory = temporaryProject();
    fs.writeFileSync(path.join(customDirectory, "package.json"), JSON.stringify({
      scripts: { build: "vite build" },
      devDependencies: { vite: "7.0.0" }
    }));
    fs.writeFileSync(
      path.join(customDirectory, "vite.config.ts"),
      "export default defineConfig({ build: { outDir: './release/client' } })\n"
    );
    const customPlan = createBuildPlan(project(), customDirectory, generated(customDirectory));
    expect(fs.readFileSync(customPlan.dockerfilePath, "utf8"))
      .toContain("COPY --from=build /app/release/client /usr/share/nginx/html");

    const unsafeDirectory = temporaryProject();
    fs.writeFileSync(path.join(unsafeDirectory, "package.json"), JSON.stringify({
      scripts: { build: "vite build" },
      devDependencies: { vite: "7.0.0" }
    }));
    fs.writeFileSync(
      path.join(unsafeDirectory, "vite.config.ts"),
      "export default { build: { outDir: '../outside' } }\n"
    );
    const unsafePlan = createBuildPlan(project(), unsafeDirectory, generated(unsafeDirectory));
    const unsafeDockerfile = fs.readFileSync(unsafePlan.dockerfilePath, "utf8");
    expect(unsafeDockerfile).toContain("COPY --from=build /app/dist /usr/share/nginx/html");
    expect(unsafeDockerfile).not.toContain("../outside");
  });

  it("builds Create React App with its build output and SPA fallback", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      scripts: { build: "react-scripts build" },
      dependencies: { react: "18.3.0", "react-scripts": "5.0.1" }
    }));
    fs.writeFileSync(path.join(directory, "package-lock.json"), "{}");
    const plan = createBuildPlan(project(), directory, generated(directory));
    const dockerfile = fs.readFileSync(plan.dockerfilePath, "utf8");
    const nginx = generatedNginxConfig(dockerfile);
    expect(plan.kind).toBe("static");
    expect(plan.description).toContain("React Static");
    expect(dockerfile).toContain("COPY --from=build /app/build /usr/share/nginx/html");
    expect(nginx).toContain("try_files $uri $uri/ /index.html");
  });

  it("builds Astro static output as a multi-page site without SPA rewrites", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      scripts: { build: "astro build" },
      dependencies: { astro: "5.12.0" }
    }));
    fs.writeFileSync(path.join(directory, "astro.config.mjs"), "export default {}\n");
    const plan = createBuildPlan(project(), directory, generated(directory));
    const dockerfile = fs.readFileSync(plan.dockerfilePath, "utf8");
    const nginx = generatedNginxConfig(dockerfile);
    expect(plan.kind).toBe("static");
    expect(plan.description).toContain("Astro Static");
    expect(dockerfile).toContain("COPY --from=build /app/dist /usr/share/nginx/html");
    expect(nginx).toContain("try_files $uri $uri/ =404");
    expect(nginx).not.toContain("/index.html; }");
  });

  it("copies a safe custom Astro static output directory", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      scripts: { build: "astro build" },
      dependencies: { astro: "5.12.0" }
    }));
    fs.writeFileSync(path.join(directory, "astro.config.mjs"), "export default { outDir: 'release/site' }\n");
    const plan = createBuildPlan(project(), directory, generated(directory));
    expect(fs.readFileSync(plan.dockerfilePath, "utf8"))
      .toContain("COPY --from=build /app/release/site /usr/share/nginx/html");
  });

  it("builds Next.js export output as static multi-page content", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      scripts: { build: "next build" },
      dependencies: { next: "16.0.0", react: "19.1.0" }
    }));
    fs.writeFileSync(path.join(directory, "next.config.mjs"), "export default { output: 'export' }\n");
    const plan = createBuildPlan(project(), directory, generated(directory));
    const dockerfile = fs.readFileSync(plan.dockerfilePath, "utf8");
    const nginx = generatedNginxConfig(dockerfile);
    expect(plan.kind).toBe("static");
    expect(plan.description).toContain("Next.js Export");
    expect(dockerfile).toContain("COPY --from=build /app/out /usr/share/nginx/html");
    expect(nginx).toContain("try_files $uri $uri/ $uri.html =404");
  });

  it("runs detected Next.js and Astro Node servers with real production commands", () => {
    const nextDirectory = temporaryProject();
    fs.writeFileSync(path.join(nextDirectory, "package.json"), JSON.stringify({
      scripts: { build: "next build" },
      dependencies: { next: "16.0.0", react: "19.1.0" }
    }));
    const nextPlan = createBuildPlan(project(), nextDirectory, generated(nextDirectory));
    expect(fs.readFileSync(nextPlan.dockerfilePath, "utf8")).toContain("npm exec -- next start");

    const astroDirectory = temporaryProject();
    fs.writeFileSync(path.join(astroDirectory, "package.json"), JSON.stringify({
      scripts: { build: "astro build" },
      dependencies: { astro: "5.12.0", "@astrojs/node": "9.4.0" }
    }));
    fs.writeFileSync(
      path.join(astroDirectory, "astro.config.mjs"),
      "import node from '@astrojs/node'; export default { output: 'server', adapter: node({ mode: 'standalone' }) }\n"
    );
    const astroPlan = createBuildPlan(project({ build_type: "node", port: 4321 }), astroDirectory, generated(astroDirectory));
    const astroDockerfile = fs.readFileSync(astroPlan.dockerfilePath, "utf8");
    expect(astroPlan.kind).toBe("node");
    expect(astroDockerfile).toContain("node ./dist/server/entry.mjs");
  });

  it("requires a Dockerfile for non-Node Astro server adapters", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      scripts: { build: "astro build" },
      dependencies: { astro: "5.12.0", "@astrojs/cloudflare": "12.0.0" }
    }));
    fs.writeFileSync(path.join(directory, "astro.config.mjs"), "export default { output: 'server' }\n");
    expect(() => createBuildPlan(project(), directory, generated(directory))).toThrow(/@astrojs\/node.*Dockerfile/);
  });

  it("requires a Dockerfile for Astro Node middleware output", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      scripts: { build: "astro build" },
      dependencies: { astro: "5.12.0", "@astrojs/node": "9.4.0" }
    }));
    fs.writeFileSync(
      path.join(directory, "astro.config.mjs"),
      "import node from '@astrojs/node'; export default { output: 'server', adapter: node({ mode: 'middleware' }) }\n"
    );
    expect(() => createBuildPlan(project(), directory, generated(directory)))
      .toThrow(/@astrojs\/node Standalone-Adapter.*Dockerfile/);
  });

  it("uses Bun consistently when bun.lock selected the detected package manager", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      scripts: { build: "vite build" },
      devDependencies: { vite: "7.0.0" }
    }));
    fs.writeFileSync(path.join(directory, "bun.lock"), "");
    const plan = createBuildPlan(project(), directory, generated(directory));
    const dockerfile = fs.readFileSync(plan.dockerfilePath, "utf8");
    expect(dockerfile).toContain("COPY package.json bun.lock ./");
    expect(dockerfile).toContain("npm install --global bun@1.2.20 && bun install --frozen-lockfile");
  });

  it("uses npm when package-lock.json is committed beside a legacy bun.lockb", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      scripts: { build: "vite build" },
      dependencies: { react: "18.3.1" },
      devDependencies: { vite: "5.4.19" }
    }));
    fs.writeFileSync(path.join(directory, "bun.lockb"), "legacy");
    fs.writeFileSync(path.join(directory, "package-lock.json"), "{}");
    const plan = createBuildPlan(project(), directory, generated(directory));
    const dockerfile = fs.readFileSync(plan.dockerfilePath, "utf8");
    expect(dockerfile).toContain("COPY package.json package-lock.json ./");
    expect(dockerfile).toContain("RUN npm ci");
    expect(dockerfile).not.toContain("bun install");
  });

  it("honors an explicitly declared package manager when multiple lockfiles exist", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      packageManager: "bun@1.2.20",
      scripts: { build: "vite build" },
      devDependencies: { vite: "7.0.0" }
    }));
    fs.writeFileSync(path.join(directory, "bun.lockb"), "legacy");
    fs.writeFileSync(path.join(directory, "package-lock.json"), "{}");
    const plan = createBuildPlan(project(), directory, generated(directory));
    const dockerfile = fs.readFileSync(plan.dockerfilePath, "utf8");
    expect(dockerfile).toContain("COPY package.json bun.lockb ./");
    expect(dockerfile).toContain("bun install --frozen-lockfile");
    expect(dockerfile).not.toContain("RUN npm ci");
  });

  it("builds a selected pnpm workspace app from the repository root with analyzer parity", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      private: true,
      packageManager: "pnpm@10.13.1",
      workspaces: ["apps/*", "packages/*"]
    }));
    fs.writeFileSync(path.join(directory, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n");
    fs.writeFileSync(path.join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const appDirectory = path.join(directory, "apps", "web");
    fs.mkdirSync(appDirectory, { recursive: true });
    fs.writeFileSync(path.join(appDirectory, "package.json"), JSON.stringify({
      name: "web",
      scripts: { build: "vite build" },
      dependencies: { "@shelter/ui": "workspace:*" },
      devDependencies: { vite: "7.0.0" }
    }));
    const packageDirectory = path.join(directory, "packages", "ui");
    fs.mkdirSync(packageDirectory, { recursive: true });
    fs.writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({ name: "@shelter/ui", version: "1.0.0" }));

    const detected = analyzeProjectDirectory(directory).applications.find((candidate) => candidate.rootDirectory === "apps/web");
    expect(detected?.packageManager).toBe("pnpm");
    expect(detected?.buildCommand).toBe("pnpm run build");
    const plan = createBuildPlan(project({ root_directory: "apps/web" }), directory, generated(directory));
    const dockerfile = fs.readFileSync(plan.dockerfilePath, "utf8");
    expect(plan.contextDirectory).toBe(fs.realpathSync(directory));
    expect(dockerfile).toContain("COPY . .\nRUN corepack enable && pnpm install --frozen-lockfile\nWORKDIR /app/apps/web");
    expect(generatedBuildRunner(dockerfile)).toContain("spawnSync(\"pnpm\", [\"run\",\"build\"]");
    expect(dockerfile).toContain("COPY --from=build /app/apps/web/dist /usr/share/nginx/html");
  });

  it.each([
    {
      manager: "npm",
      packageManager: "npm@11.4.2",
      lockfile: "package-lock.json",
      install: "RUN npm ci",
      analyzerBuild: "npm run build",
      runner: "spawnSync(\"npm\", [\"run\",\"build\"]"
    },
    {
      manager: "yarn",
      packageManager: "yarn@4.9.2",
      lockfile: "yarn.lock",
      install: "RUN corepack enable && yarn install --immutable",
      analyzerBuild: "yarn build",
      runner: "spawnSync(\"yarn\", [\"build\"]"
    },
    {
      manager: "bun",
      packageManager: "bun@1.2.20",
      lockfile: "bun.lock",
      install: "bun install --frozen-lockfile",
      analyzerBuild: "bun run build",
      runner: "spawnSync(\"bun\", [\"run\",\"build\"]"
    }
  ])("keeps $manager workspace analysis and generated build commands in sync", ({
    packageManager,
    lockfile,
    install,
    analyzerBuild,
    runner
  }) => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      private: true,
      packageManager,
      workspaces: ["apps/*"]
    }));
    fs.writeFileSync(path.join(directory, lockfile), lockfile === "package-lock.json" ? "{}" : "");
    if (lockfile === "yarn.lock") fs.writeFileSync(path.join(directory, ".yarnrc.yml"), "nodeLinker: node-modules\n");
    const appDirectory = path.join(directory, "apps", "web");
    fs.mkdirSync(appDirectory, { recursive: true });
    fs.writeFileSync(path.join(appDirectory, "package.json"), JSON.stringify({
      name: "web",
      scripts: { build: "vite build" },
      devDependencies: { vite: "7.0.0" }
    }));

    const detected = analyzeProjectDirectory(directory).applications.find((candidate) => candidate.rootDirectory === "apps/web");
    expect(detected?.buildCommand).toBe(analyzerBuild);
    const plan = createBuildPlan(project({ root_directory: "apps/web" }), directory, generated(directory));
    const dockerfile = fs.readFileSync(plan.dockerfilePath, "utf8");
    expect(plan.contextDirectory).toBe(fs.realpathSync(directory));
    expect(dockerfile).toContain(install);
    expect(dockerfile).toContain("WORKDIR /app/apps/web");
    expect(generatedBuildRunner(dockerfile)).toContain(runner);
    expect(dockerfile).toContain("COPY --from=build /app/apps/web/dist /usr/share/nginx/html");
  });

  it("starts a selected Node workspace app from its own working directory", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      private: true,
      packageManager: "npm@11.4.2",
      workspaces: ["apps/*"]
    }));
    fs.writeFileSync(path.join(directory, "package-lock.json"), "{}");
    const appDirectory = path.join(directory, "apps", "api");
    fs.mkdirSync(appDirectory, { recursive: true });
    fs.writeFileSync(path.join(appDirectory, "package.json"), JSON.stringify({
      name: "api",
      scripts: { build: "node build.js", start: "node server.js" }
    }));

    const detected = analyzeProjectDirectory(directory).applications.find((candidate) => candidate.rootDirectory === "apps/api");
    expect(detected).toMatchObject({ packageManager: "npm", buildCommand: "npm run build", startCommand: "npm run start" });
    const plan = createBuildPlan(project({ root_directory: "apps/api", build_type: "node" }), directory, generated(directory));
    const dockerfile = fs.readFileSync(plan.dockerfilePath, "utf8");
    expect(plan.contextDirectory).toBe(fs.realpathSync(directory));
    expect(dockerfile).toContain("RUN npm ci\nWORKDIR /app/apps/api");
    expect(generatedBuildRunner(dockerfile)).toContain("spawnSync(\"npm\", [\"run\",\"build\"]");
    expect(dockerfile).toContain('CMD ["sh", "-lc", "npm run start"]');
  });

  it("detects a safe uploaded asset folder as file storage", () => {
    const directory = temporaryProject();
    fs.mkdirSync(path.join(directory, "gallery"));
    fs.writeFileSync(path.join(directory, "cover.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    fs.writeFileSync(path.join(directory, "gallery", "frog.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(directory, "gallery", "credits.txt"), "Shelter\n");

    const plan = createBuildPlan(project(), directory, generated(directory));
    const dockerfile = fs.readFileSync(plan.dockerfilePath, "utf8");
    const nginx = generatedNginxConfig(dockerfile);

    expect(plan.kind).toBe("files");
    expect(plan.description).toBe("File storage");
    expect(plan.internalPort).toBe(8080);
    expect(dockerfile).toContain("RUN rm -rf /usr/share/nginx/html");
    expect(dockerfile).toContain("COPY --chown=101:101 . /usr/share/nginx/html");
    expect(nginx).toContain('location = / { default_type text/plain; return 200 "Shelter file storage is available.\\n"; }');
    expect(nginx).toContain("location / { if (-d $request_filename) { return 404; } try_files $uri =404; }");
    expect(nginx).toContain("location ~ (^|/)\\. { return 404; }");
    expect(nginx).toContain('add_header X-Content-Type-Options "nosniff" always;');
    expect(nginx).toContain("default_type application/octet-stream;");
    expect(nginx).toContain("access_log off;");
    expect(nginx).not.toContain("autoindex on");
    expect(nginx).not.toContain("immutable");
    const dockerignore = fs.readFileSync(`${plan.dockerfilePath}.dockerignore`, "utf8");
    expect(dockerignore).toContain("**/.*");
    expect(dockerignore).toContain("**/[Tt][Hh][Uu][Mm][Bb][Ss].[Dd][Bb]");
  });

  it("supports the same safe automatic file-storage fallback for Git repositories", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "cover.jpg"), Buffer.from([0xff, 0xd8, 0xff]));

    const plan = createBuildPlan(
      project({ source_type: "git", source_archive: null, repository_url: "https://example.com/assets.git" }),
      directory,
      generated(directory)
    );
    expect(plan.kind).toBe("files");
  });

  it("uses file storage for an explicit safe upload without an index document", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "download.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46]));

    const plan = createBuildPlan(
      project({ build_type: "static", static_base_path: "/assets" }),
      directory,
      generated(directory)
    );
    const nginx = generatedNginxConfig(fs.readFileSync(plan.dockerfilePath, "utf8"));

    expect(plan.kind).toBe("files");
    expect(plan.description).toBe("File storage (path /assets/, manual)");
    expect(nginx).toContain("location = / { return 308 /assets/; }");
    expect(nginx).toContain('location = /assets/ { default_type text/plain; return 200 "Shelter file storage is available.\\n"; }');
    expect(nginx).toContain("location / { return 404; }");
    expect(nginx).toContain("location /assets/ { if (-d $request_filename) { return 404; } try_files $uri =404; }");
  });

  it("does not publish hidden-only uploads or project source as file storage", () => {
    const hiddenDirectory = temporaryProject();
    fs.writeFileSync(path.join(hiddenDirectory, ".DS_Store"), "metadata");
    expect(() => createBuildPlan(project(), hiddenDirectory, generated(hiddenDirectory))).toThrow(/Kein unterstützter Build/);

    const sourceDirectory = temporaryProject();
    fs.writeFileSync(path.join(sourceDirectory, "main.php"), "<?php echo 'secret';");
    fs.writeFileSync(path.join(sourceDirectory, "cover.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    expect(() => createBuildPlan(project(), sourceDirectory, generated(sourceDirectory))).toThrow(/Kein unterstützter Build/);

    const scriptDirectory = temporaryProject();
    fs.writeFileSync(path.join(scriptDirectory, "server.js"), "console.log(process.env.SECRET)");
    fs.writeFileSync(path.join(scriptDirectory, "credentials.json"), "{}");
    expect(() => createBuildPlan(project(), scriptDirectory, generated(scriptDirectory))).toThrow(/Kein unterstützter Build/);
  });

  it("does not hide malformed project manifests behind file storage", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "package.json"), "{");
    fs.writeFileSync(path.join(directory, "cover.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    expect(() => createBuildPlan(project(), directory, generated(directory))).toThrow(/package\.json ist kein gültiges JSON/);
  });

  it("never publishes an unsupported package project as explicit file storage", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "library-only" }));
    fs.writeFileSync(path.join(directory, "source.txt"), "not a public asset bundle");
    expect(() => createBuildPlan(project({ build_type: "static" }), directory, generated(directory)))
      .toThrow(/Kein unterstützter Build/);
  });

  it("does not create a broken static preset for an unsafe extension-only folder", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "payload.bin"), Buffer.from([0x01, 0x02]));
    expect(() => createBuildPlan(project({ build_type: "static" }), directory, generated(directory)))
      .toThrow(/Kein unterstützter Build/);
  });

  it("keeps framework detection working when an unrelated path exceeds the public analysis limit", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      scripts: { build: "vite build" },
      devDependencies: { vite: "7.0.0" }
    }));
    fs.writeFileSync(path.join(directory, `${"a".repeat(241)}.txt`), "ignored");
    expect(createBuildPlan(project(), directory, generated(directory)).kind).toBe("static");
  });

  it("mounts a prebuilt SPA at its uniform file-backed base path", () => {
    const directory = temporaryProject();
    fs.mkdirSync(path.join(directory, "assets"));
    fs.writeFileSync(path.join(directory, "assets", "app.js"), "console.log('app');");
    fs.writeFileSync(path.join(directory, "assets", "app.css"), "body {}");
    fs.writeFileSync(path.join(directory, "favicon.svg"), "<svg />");
    fs.writeFileSync(path.join(directory, "index.html"), [
      "<!doctype html>",
      '<link rel="icon" href="/dhd/favicon.svg">',
      '<link rel="stylesheet" href="/dhd/assets/app.css?v=1">',
      '<script type="module" src="/dhd/assets/app.js#entry"></script>'
    ].join("\n"));

    const plan = createBuildPlan(project(), directory, generated(directory));
    const dockerfile = fs.readFileSync(plan.dockerfilePath, "utf8");
    const nginx = generatedNginxConfig(dockerfile);

    expect(plan.kind).toBe("static");
    expect(plan.description).toContain("Basis /dhd/");
    expect(dockerfile).toContain("COPY . /usr/share/nginx/html/dhd");
    expect(nginx).toContain("location = / { return 308 /dhd/; }");
    expect(nginx).toContain("location = /dhd { return 308 /dhd/; }");
    expect(nginx).toContain("absolute_redirect off;");
    expect(nginx).toContain("location /dhd/ { try_files $uri $uri/ /dhd/index.html; }");
    expect(nginx).toContain("location ~ (^|/)\\. { deny all; }");
  });

  it("keeps root hosting when file-backed references use the root path", () => {
    const directory = temporaryProject();
    fs.mkdirSync(path.join(directory, "assets"));
    fs.writeFileSync(path.join(directory, "assets", "app.js"), "console.log('app');");
    fs.writeFileSync(path.join(directory, "index.html"), '<script type="module" src="/assets/app.js"></script>');

    const plan = createBuildPlan(project(), directory, generated(directory));
    const dockerfile = fs.readFileSync(plan.dockerfilePath, "utf8");
    const nginx = generatedNginxConfig(dockerfile);

    expect(plan.description).toBe("Statische Website");
    expect(dockerfile).toContain("COPY . /usr/share/nginx/html\n");
    expect(nginx).toContain("location / { try_files $uri $uri/ /index.html; }");
    expect(nginx).not.toContain("return 308");
    expect(nginx).toContain("location ~ (^|/)\\. { deny all; }");
  });

  it("lets a manual base path override automatic static detection", () => {
    const directory = temporaryProject();
    fs.mkdirSync(path.join(directory, "assets"));
    fs.writeFileSync(path.join(directory, "assets", "app.js"), "console.log('app');");
    fs.writeFileSync(path.join(directory, "index.html"), '<script type="module" src="/assets/app.js"></script>');

    const plan = createBuildPlan(project({ static_base_path: "/preview/app_2" }), directory, generated(directory));
    const dockerfile = fs.readFileSync(plan.dockerfilePath, "utf8");
    const nginx = generatedNginxConfig(dockerfile);

    expect(plan.description).toBe("Statische Website (Basis /preview/app_2/, manuell)");
    expect(dockerfile).toContain("COPY . /usr/share/nginx/html/preview/app_2");
    expect(nginx).toContain("location = / { return 308 /preview/app_2/; }");
    expect(nginx).toContain("location /preview/app_2/ { try_files $uri $uri/ /preview/app_2/index.html; }");
  });

  it("lets a manual root path override an inferred static prefix", () => {
    const directory = temporaryProject();
    fs.mkdirSync(path.join(directory, "assets"));
    fs.writeFileSync(path.join(directory, "assets", "app.js"), "console.log('app');");
    fs.writeFileSync(path.join(directory, "index.html"), '<script type="module" src="/dhd/assets/app.js"></script>');

    const plan = createBuildPlan(project({ static_base_path: "/" }), directory, generated(directory));
    const dockerfile = fs.readFileSync(plan.dockerfilePath, "utf8");
    const nginx = generatedNginxConfig(dockerfile);

    expect(plan.description).toBe("Statische Website (Basis /, manuell)");
    expect(dockerfile).toContain("COPY . /usr/share/nginx/html\n");
    expect(nginx).toContain("location / { try_files $uri $uri/ /index.html; }");
    expect(nginx).not.toContain("return 308");
  });

  it.each([
    "", "foo", "//foo", "/foo/", "/foo.bar", "/foo~bar", "/foo bar",
    "/foo\\bar", "/foo?bar", "/foo#bar", "/foo/../bar", `/${"a".repeat(200)}`
  ])("rejects the invalid manual base path %j", (staticBasePath) => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "index.html"), "<!doctype html>");
    expect(() => createBuildPlan(
      project({ static_base_path: staticBasePath }),
      directory,
      generated(directory)
    )).toThrow(/Hosting-Basispfad/);
  });

  it("rejects a non-root manual base path for Next.js but accepts explicit root", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      scripts: { build: "next build", start: "next start" },
      dependencies: { next: "16.0.0" }
    }));

    expect(() => createBuildPlan(
      project({ static_base_path: "/subpath" }),
      directory,
      generated(directory)
    )).toThrow(/nur für statische Distributionen.*Next\.js oder Node\.js/);
    expect(createBuildPlan(
      project({ static_base_path: "/" }),
      directory,
      generated(directory)
    ).kind).toBe("next");
  });

  it("rejects a non-root manual base path for a custom Dockerfile", () => {
    const directory = temporaryProject();
    fs.writeFileSync(path.join(directory, "Dockerfile"), "FROM scratch\n");
    expect(() => createBuildPlan(
      project({ static_base_path: "/subpath" }),
      directory,
      generated(directory)
    )).toThrow(/eigenen Dockerfiles/);
  });

  it("does not infer a base path from inconsistent file-backed references", () => {
    const directory = temporaryProject();
    fs.mkdirSync(path.join(directory, "assets"));
    fs.writeFileSync(path.join(directory, "assets", "app.js"), "console.log('app');");
    fs.writeFileSync(path.join(directory, "favicon.svg"), "<svg />");
    fs.writeFileSync(path.join(directory, "index.html"), [
      '<link rel="icon" href="/favicon.svg">',
      '<script type="module" src="/dhd/assets/app.js"></script>'
    ].join("\n"));

    const plan = createBuildPlan(project(), directory, generated(directory));
    const dockerfile = fs.readFileSync(plan.dockerfilePath, "utf8");
    const nginx = generatedNginxConfig(dockerfile);

    expect(plan.description).toBe("Statische Website");
    expect(dockerfile).toContain("COPY . /usr/share/nginx/html\n");
    expect(nginx).not.toContain("return 308");
  });

  it("copies Yarn Berry configuration before installing dependencies", () => {
    const directory = temporaryProject();
    fs.mkdirSync(path.join(directory, ".yarn"));
    fs.writeFileSync(path.join(directory, ".yarn", "plugins.cjs"), "module.exports = {};");
    fs.writeFileSync(path.join(directory, ".yarnrc.yml"), "nodeLinker: node-modules\n");
    fs.writeFileSync(path.join(directory, "yarn.lock"), "");
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      packageManager: "yarn@4.10.3",
      scripts: { start: "node server.js" }
    }));
    const plan = createBuildPlan(project(), directory, generated(directory));
    const dockerfile = fs.readFileSync(plan.dockerfilePath, "utf8");
    expect(dockerfile).toContain("COPY .yarnrc.yml ./");
    expect(dockerfile).toContain("COPY .yarn ./.yarn");
    expect(dockerfile).toContain("yarn install --immutable");
  });

  it("requires an explicit Dockerfile for unknown stacks", () => {
    const directory = temporaryProject();
    expect(() => createBuildPlan(project(), directory, generated(directory))).toThrow(/Kein unterstützter Build/);
  });

  it("never follows a repository symlink for generated build files", () => {
    const directory = temporaryProject();
    const victim = path.join(path.dirname(directory), `${path.basename(directory)}-victim`);
    temporaryDirectories.push(victim);
    fs.writeFileSync(victim, "must stay intact");
    fs.mkdirSync(path.join(directory, ".portsmith"));
    fs.symlinkSync(victim, path.join(directory, ".portsmith", "Dockerfile"));
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      scripts: { start: "node server.js" }
    }));
    const plan = createBuildPlan(project(), directory, generated(directory));
    expect(path.relative(fs.realpathSync(directory), plan.dockerfilePath).startsWith(".." )).toBe(true);
    expect(fs.readFileSync(victim, "utf8")).toBe("must stay intact");
  });

  it("rejects a Dockerfile symlink that escapes the source", () => {
    const directory = temporaryProject();
    const outside = path.join(path.dirname(directory), `${path.basename(directory)}-outside`);
    temporaryDirectories.push(outside);
    fs.writeFileSync(outside, "FROM scratch\n");
    fs.symlinkSync(outside, path.join(directory, "Dockerfile"));
    expect(() => createBuildPlan(project(), directory, generated(directory))).toThrow(/Symlink escapes/);
  });
});
