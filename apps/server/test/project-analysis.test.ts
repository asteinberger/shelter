import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeProjectFiles,
  analyzeZipProject,
  MAX_ANALYSIS_PATHS,
  ProjectAnalysisRequestSchema,
  type ProjectFileFact
} from "../src/services/project-analysis.js";

const temporaryDirectories: string[] = [];

function packageFile(root: string, manifest: unknown): ProjectFileFact {
  return {
    path: root === "." ? "package.json" : `${root}/package.json`,
    content: JSON.stringify(manifest)
  };
}

function application(files: ProjectFileFact[]) {
  const analysis = analyzeProjectFiles(files);
  return analysis.applications.find((candidate) => candidate.id === analysis.recommendedApplicationId)!;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("project source analysis", () => {
  it("detects Next.js SSR and static export without reading secrets", () => {
    const ssr = application([
      packageFile(".", {
        name: "web",
        scripts: { build: "next build", start: "next start" },
        dependencies: { next: "^16.0.0", react: "^19.0.0" }
      }),
      { path: "package-lock.json" },
      { path: ".env.example", content: "DATABASE_URL=do-not-return\nNEXT_PUBLIC_ORIGIN=https://example.test\n" }
    ]);
    expect(ssr).toMatchObject({
      framework: "next",
      frameworkVersion: "^16.0.0",
      rendering: "ssr",
      packageManager: "npm",
      buildType: "auto",
      buildCommand: "npm run build",
      startCommand: "npm run start",
      port: 3000,
      spaFallback: false,
      environmentKeys: ["DATABASE_URL", "NEXT_PUBLIC_ORIGIN"]
    });
    expect(JSON.stringify(ssr)).not.toContain("do-not-return");

    const workspaceWithoutStartScript = analyzeProjectFiles([
      packageFile(".", { private: true, workspaces: ["apps/*"], packageManager: "npm@11.4.2" }),
      { path: "package-lock.json" },
      packageFile("apps/web", { scripts: { build: "next build" }, dependencies: { next: "16.0.1" } })
    ]).applications.find((candidate) => candidate.rootDirectory === "apps/web");
    expect(workspaceWithoutStartScript?.startCommand).toBe("npm exec -- next start");

    const exported = application([
      packageFile(".", { scripts: { build: "next build" }, dependencies: { next: "16.0.1" } }),
      { path: "next.config.mjs", content: "export default { output: 'export' }" }
    ]);
    expect(exported).toMatchObject({
      framework: "next",
      rendering: "static",
      buildType: "static",
      outputDirectory: "out",
      startCommand: null,
      spaFallback: false
    });
  });

  it("detects React Vite, Create React App and plain Vite as SPAs", () => {
    expect(application([
      packageFile(".", { scripts: { build: "vite build" }, dependencies: { react: "19.1.0" }, devDependencies: { vite: "7.0.0" } }),
      { path: "pnpm-lock.yaml" }
    ])).toMatchObject({
      framework: "react",
      packageManager: "pnpm",
      rendering: "spa",
      outputDirectory: "dist",
      spaFallback: true
    });
    expect(application([
      packageFile(".", { scripts: { build: "react-scripts build" }, dependencies: { react: "18.3.0", "react-scripts": "5.0.1" } }),
      { path: "yarn.lock" }
    ])).toMatchObject({ framework: "react", outputDirectory: "build", packageManager: "yarn", spaFallback: true });
    expect(application([
      packageFile(".", { scripts: { build: "vite build" }, devDependencies: { vite: "7.0.0" } })
    ])).toMatchObject({ framework: "vite", outputDirectory: "dist", spaFallback: true });
  });

  it("prefers a modern npm lockfile over an additional legacy Bun lockfile", () => {
    expect(application([
      packageFile(".", {
        scripts: { build: "vite build" },
        dependencies: { react: "18.3.1" },
        devDependencies: { vite: "5.4.19" }
      }),
      { path: "bun.lockb" },
      { path: "package-lock.json" }
    ])).toMatchObject({
      framework: "react",
      packageManager: "npm",
      buildCommand: "npm run build"
    });
  });

  it("detects Astro static/server, Node, Dockerfile, static HTML and file storage", () => {
    expect(application([
      packageFile(".", { scripts: { build: "astro build" }, dependencies: { astro: "5.12.0" } }),
      { path: "astro.config.mjs", content: "export default {}" }
    ])).toMatchObject({ framework: "astro", rendering: "static", outputDirectory: "dist", spaFallback: false });
    expect(application([
      packageFile(".", { scripts: { build: "astro build" }, dependencies: { astro: "5.12.0", "@astrojs/node": "9.4.0" } }),
      {
        path: "astro.config.mjs",
        content: "import node from '@astrojs/node'; export default { output: 'server', adapter: node({ mode: 'standalone' }) }"
      }
    ])).toMatchObject({ framework: "astro", rendering: "server", buildType: "node", port: 4321 });
    expect(application([
      packageFile(".", { scripts: { start: "node server.js" } }),
      { path: "server.js" }
    ])).toMatchObject({ framework: "node", rendering: "server", buildType: "node" });
    expect(application([{ path: "Dockerfile" }, { path: "src/main.go" }])).toMatchObject({
      framework: "dockerfile",
      rendering: "container",
      buildType: "dockerfile"
    });
    expect(application([{ path: "index.html" }, { path: "assets/site.css" }])).toMatchObject({
      framework: "static",
      rendering: "static",
      outputDirectory: ".",
      spaFallback: false
    });
    expect(application([{ path: "images/frog.png" }, { path: "manual.pdf" }, { path: "README" }])).toMatchObject({
      framework: "files",
      rendering: "files",
      buildType: "auto"
    });
  });

  it("returns separate applications for a monorepo and recommends a real app instead of the workspace root", () => {
    const analysis = analyzeProjectFiles([
      packageFile(".", { name: "workspace", private: true, workspaces: ["apps/*"] }),
      packageFile("apps/web", { name: "web", scripts: { build: "next build", start: "next start" }, dependencies: { next: "16.0.0" } }),
      packageFile("apps/docs", { name: "docs", scripts: { build: "astro build" }, dependencies: { astro: "5.0.0" } }),
      packageFile("apps/api", { name: "api", scripts: { start: "node src.js" } }),
      { path: "pnpm-lock.yaml" }
    ]);
    expect(analysis.applications.map((candidate) => candidate.rootDirectory)).toEqual(["apps/web", "apps/docs", "apps/api"]);
    expect(analysis.applications.every((candidate) => candidate.packageManager === "pnpm")).toBe(true);
    expect(analysis.applications.every((candidate) => candidate.buildCommand === "pnpm run build" || candidate.buildCommand === null)).toBe(true);
    expect(analysis.applications.find((candidate) => candidate.rootDirectory === "apps/api")?.startCommand).toBe("pnpm run start");
    expect(analysis.recommendedApplicationId).toBe(analysis.applications[0]?.id);
    expect(analysis.applications[0]?.framework).toBe("next");
  });

  it("filters generated dependency trees and bounds application output deterministically", () => {
    const files: ProjectFileFact[] = [
      packageFile("node_modules/react", { name: "react", scripts: { start: "node index.js" } }),
      packageFile("dist/fake", { name: "fake", scripts: { start: "node index.js" } }),
      ...Array.from({ length: 130 }, (_, index) => packageFile(`apps/site-${String(index).padStart(3, "0")}`, {
        name: `site-${index}`,
        scripts: { build: "vite build" },
        devDependencies: { vite: "7.0.0" }
      }))
    ];
    const analysis = analyzeProjectFiles(files);
    expect(analysis.applications).toHaveLength(100);
    expect(analysis.applications.some((candidate) => candidate.rootDirectory.includes("node_modules"))).toBe(false);
    expect(analysis.applications.some((candidate) => candidate.rootDirectory.startsWith("dist/"))).toBe(false);
    expect(analysis.applications[0]?.rootDirectory).toBe("apps/site-000");
    expect(analysis.applications[0]?.evidence.at(-1)).toContain("additional applications omitted");
  });

  it("does not claim an unsupported source is a static application", () => {
    const analysis = analyzeProjectFiles([{ path: "src/main.php" }]);
    expect(analysis.applications).toEqual([]);
    expect(analysis.recommendedApplicationId).toBeNull();
  });

  it("has a deterministic content-sensitive fingerprint", () => {
    const first = analyzeProjectFiles([packageFile(".", { scripts: { start: "node a.js" } }), { path: "a.js", size: 20 }]);
    const reordered = analyzeProjectFiles([{ path: "a.js", size: 20 }, packageFile(".", { scripts: { start: "node a.js" } })]);
    const changed = analyzeProjectFiles([packageFile(".", { scripts: { start: "node b.js" } }), { path: "a.js", size: 20 }]);
    expect(reordered.fingerprint).toBe(first.fingerprint);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it("does not treat an unused Astro Node adapter as server output", () => {
    const detected = application([
      packageFile(".", {
        scripts: { build: "astro build" },
        dependencies: { astro: "5.12.0", "@astrojs/node": "9.4.0" }
      }),
      { path: "astro.config.mjs", content: "export default {}" }
    ]);
    expect(detected).toMatchObject({ framework: "astro", rendering: "static", buildType: "static" });

    const unsupported = application([
      packageFile(".", {
        scripts: { build: "astro build" },
        dependencies: { astro: "5.12.0", "@astrojs/cloudflare": "12.0.0" }
      }),
      { path: "astro.config.mjs", content: "export default { output: 'server' }" }
    ]);
    expect(unsupported).toMatchObject({ framework: "astro", rendering: "server", buildType: "auto", startCommand: null });
  });

  it("uses only safe literal Vite and Astro output directories", () => {
    expect(application([
      packageFile(".", { scripts: { build: "vite build" }, dependencies: { react: "19.1.0" }, devDependencies: { vite: "7.0.0" } }),
      { path: "vite.config.ts", content: "export default defineConfig({ build: { outDir: './release/client' } })" }
    ])).toMatchObject({ framework: "react", outputDirectory: "release/client" });

    expect(application([
      packageFile(".", { scripts: { build: "astro build" }, dependencies: { astro: "5.12.0" } }),
      { path: "astro.config.mjs", content: "export default { outDir: 'public/site' }" }
    ])).toMatchObject({ framework: "astro", outputDirectory: "public/site" });

    expect(application([
      packageFile(".", { scripts: { build: "vite build" }, devDependencies: { vite: "7.0.0" } }),
      { path: "vite.config.ts", content: "export default { build: { outDir: '../outside' } }" }
    ])).toMatchObject({ framework: "vite", outputDirectory: "dist" });

    expect(application([
      packageFile(".", { scripts: { build: "astro build" }, dependencies: { astro: "5.12.0" } }),
      { path: "astro.config.mjs", content: "export default { outDir: '/tmp/output' }" }
    ])).toMatchObject({ framework: "astro", outputDirectory: "dist" });
  });

  it("accepts only a configured Astro Node standalone adapter as directly startable", () => {
    const standalone = application([
      packageFile(".", {
        scripts: { build: "astro build" },
        dependencies: { astro: "5.12.0", "@astrojs/node": "9.4.0" }
      }),
      {
        path: "astro.config.mjs",
        content: "import nodeAdapter from '@astrojs/node'; export default defineConfig({ output: 'server', outDir: 'output', adapter: nodeAdapter({ mode: 'standalone' }) })"
      }
    ]);
    expect(standalone).toMatchObject({
      framework: "astro",
      rendering: "server",
      buildType: "node",
      startCommand: "node ./output/server/entry.mjs"
    });

    const middleware = application([
      packageFile(".", {
        scripts: { build: "astro build" },
        dependencies: { astro: "5.12.0", "@astrojs/node": "9.4.0" }
      }),
      {
        path: "astro.config.mjs",
        content: "import node from '@astrojs/node'; export default defineConfig({ output: 'server', adapter: node({ mode: 'middleware' }) })"
      }
    ]);
    expect(middleware).toMatchObject({ buildType: "auto", startCommand: null });

    const unconfigured = application([
      packageFile(".", {
        scripts: { build: "astro build" },
        dependencies: { astro: "5.12.0", "@astrojs/node": "9.4.0" }
      }),
      { path: "astro.config.mjs", content: "export default { output: 'server' }" }
    ]);
    expect(unconfigured).toMatchObject({ buildType: "auto", startCommand: null });
  });

  it("enforces path, count, duplicate and configuration-content limits", () => {
    expect(() => ProjectAnalysisRequestSchema.parse({ files: [{ path: "../package.json", content: "{}" }] })).toThrow();
    expect(() => ProjectAnalysisRequestSchema.parse({ files: [{ path: ".env", content: "SECRET=value" }] })).toThrow();
    expect(ProjectAnalysisRequestSchema.parse({ files: [{ path: ".env.local.example", content: "SAFE_KEY=" }] }).files).toHaveLength(1);
    expect(() => ProjectAnalysisRequestSchema.parse({ files: [{ path: "src.js", content: "console.log(1)" }] })).toThrow();
    expect(() => ProjectAnalysisRequestSchema.parse({ files: [{ path: "index.html" }, { path: "index.html" }] })).toThrow();
    expect(() => ProjectAnalysisRequestSchema.parse({
      files: Array.from({ length: MAX_ANALYSIS_PATHS + 1 }, (_, index) => ({ path: `files/${index}.txt` }))
    })).toThrow();
    expect(() => ProjectAnalysisRequestSchema.parse({
      files: [{ path: "package.json", content: "x".repeat(512 * 1024 + 1) }]
    })).toThrow();
  });

  it("validates and analyzes the complete ZIP server-side", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-analysis-zip-"));
    temporaryDirectories.push(directory);
    const archive = path.join(directory, "project.zip");
    fs.writeFileSync(archive, zipSync({
      "project/apps/site/package.json": strToU8(JSON.stringify({
        name: "site",
        scripts: { build: "astro build" },
        dependencies: { astro: "5.0.0" }
      })),
      "project/apps/site/astro.config.mjs": strToU8("export default {}"),
      "project/apps/site/src/pages/index.astro": strToU8("<h1>Shelter</h1>")
    }));
    const analysis = await analyzeZipProject(archive);
    expect(analysis.applications).toHaveLength(1);
    expect(analysis.applications[0]).toMatchObject({
      rootDirectory: "apps/site",
      framework: "astro",
      rendering: "static"
    });
  });
});
