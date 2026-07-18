import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import {
  collectFolderAnalysisFiles,
  collectZipAnalysisFiles,
  type ProjectAnalysisProgress,
} from './project-analysis-input';

function folderFile(path: string, contents: BlobPart): File {
  const file = new File([contents], path.split('/').at(-1) ?? 'file');
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

function zipFile(entries: Record<string, string | Uint8Array>): File {
  const encoded = Object.fromEntries(
    Object.entries(entries).map(([path, content]) => [
      path,
      typeof content === 'string' ? strToU8(content) : content,
    ]),
  );
  return new File([zipSync(encoded)], 'project.zip', { type: 'application/zip' });
}

describe('collectFolderAnalysisFiles', () => {
  it('strips the selected folder root and only reads useful configuration files', async () => {
    const files = [
      folderFile('my-project/package.json', '{"scripts":{"build":"vite build"}}'),
      folderFile('my-project/vite.config.ts', 'export default {}'),
      folderFile('my-project/pnpm-lock.yaml', 'lockfileVersion: 9'),
      folderFile('my-project/src/main.tsx', 'console.log("Shelter")'),
      folderFile('my-project/node_modules/react/package.json', '{"name":"react"}'),
      folderFile('my-project/dist/index.html', '<h1>generated</h1>'),
    ];

    const result = await collectFolderAnalysisFiles(files);

    expect(result).toEqual([
      {
        path: 'package.json',
        size: 34,
        content: '{"scripts":{"build":"vite build"}}',
      },
      { path: 'vite.config.ts', size: 17, content: 'export default {}' },
      { path: 'pnpm-lock.yaml', size: 18 },
      { path: 'src/main.tsx', size: 22, content: 'console.log("Shelter")' },
    ]);
  });

  it('never reads real environment files but does read explicit examples', async () => {
    const result = await collectFolderAnalysisFiles([
      folderFile('project/.env', 'DATABASE_URL=top-secret'),
      folderFile('project/.env.local', 'API_TOKEN=also-secret'),
      folderFile('project/.env.example', 'DATABASE_URL='),
      folderFile('project/.env.local.example', 'API_TOKEN='),
      folderFile('project/.env.sample', 'PORT=3000'),
    ]);

    expect(result).toEqual([
      { path: '.env', size: 23 },
      { path: '.env.local', size: 21 },
      { path: '.env.example', size: 13, content: 'DATABASE_URL=' },
      { path: '.env.local.example', size: 10, content: 'API_TOKEN=' },
      { path: '.env.sample', size: 9, content: 'PORT=3000' },
    ]);
  });

  it('reads bounded application source but ignores tests and generated code', async () => {
    const oversizedSource = `process.env.${'A'.repeat(70 * 1024)}`;
    const result = await collectFolderAnalysisFiles([
      folderFile('project/src/server.ts', 'if (!process.env.API_TOKEN) throw new Error()'),
      folderFile('project/src/server.test.ts', 'process.env.TEST_TOKEN'),
      folderFile('project/tests/helper.ts', 'process.env.FIXTURE_TOKEN'),
      folderFile('project/src/large.ts', oversizedSource),
    ]);

    expect(result).toEqual([
      {
        path: 'src/server.ts',
        size: 45,
        content: 'if (!process.env.API_TOKEN) throw new Error()',
      },
      { path: 'src/server.test.ts', size: 22 },
      { path: 'tests/helper.ts', size: 25 },
      { path: 'src/large.ts', size: oversizedSource.length },
    ]);
  });

  it('sends entry points and workspace files as presence-only facts', async () => {
    const result = await collectFolderAnalysisFiles([
      folderFile('project/Dockerfile', 'FROM node:24'),
      folderFile('project/index.html', '<main>Website</main>'),
      folderFile('project/tsconfig.json', '{"compilerOptions":{}}'),
      folderFile('project/pnpm-workspace.yaml', 'packages:\n  - apps/*'),
    ]);

    expect(result).toEqual([
      { path: 'Dockerfile', size: 12 },
      { path: 'index.html', size: 20 },
      { path: 'tsconfig.json', size: 22 },
      { path: 'pnpm-workspace.yaml', size: 20 },
    ]);
  });

  it('ignores unsafe paths and enforces entry and content limits', async () => {
    const files = [
      folderFile('../secret/package.json', '{"private":true}'),
      folderFile(`project/${'x'.repeat(241)}`, 'too long'),
      folderFile('project/package.json', '{"private":true}'),
      folderFile('project/index.html', '<main>Shelter</main>'),
    ];

    await expect(collectFolderAnalysisFiles(files, { maxEntries: 1 })).rejects.toThrow(
      'limited to 1 entries',
    );

    const result = await collectFolderAnalysisFiles(files, { maxContentBytes: 16 });
    expect(result).toEqual([
      { path: 'package.json', size: 16, content: '{"private":true}' },
      { path: 'index.html', size: 20 },
    ]);

    await expect(collectFolderAnalysisFiles([
      folderFile('project/node_modules/a/index.js', 'ignored'),
      folderFile('project/node_modules/b/index.js', 'ignored'),
      folderFile('project/package.json', '{"private":true}'),
    ], { maxEntries: 1 })).resolves.toEqual([
      { path: 'package.json', size: 16, content: '{"private":true}' },
    ]);
  });

  it('supports cancellation while reading a configuration file', async () => {
    const controller = new AbortController();
    const file = folderFile('project/package.json', new Uint8Array(128 * 1024).fill(32));
    const originalStream = file.stream.bind(file);
    Object.defineProperty(file, 'stream', {
      value: () => {
        const reader = originalStream().getReader();
        return new ReadableStream<Uint8Array>({
          async pull(target) {
            const chunk = await reader.read();
            if (chunk.done) {
              target.close();
              return;
            }
            controller.abort();
            target.enqueue(chunk.value);
          },
          cancel() {
            return reader.cancel();
          },
        });
      },
    });

    await expect(
      collectFolderAnalysisFiles([file], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('collectZipAnalysisFiles', () => {
  it('streams the archive, reports progress, strips its wrapper and ignores generated trees', async () => {
    const archive = zipFile({
      'repo-main/package.json': '{"dependencies":{"next":"15.0.0"}}',
      'repo-main/next.config.mjs': 'export default {}',
      'repo-main/package-lock.json': '{"lockfileVersion":3}',
      'repo-main/app/page.tsx': 'export default function Page() {}',
      'repo-main/.next/server/app.js': 'generated',
    });
    Object.defineProperty(archive, 'arrayBuffer', {
      value: vi.fn(() => Promise.reject(new Error('arrayBuffer must not be used'))),
    });
    const progress: ProjectAnalysisProgress[] = [];

    const result = await collectZipAnalysisFiles(archive, {
      onProgress: (update) => progress.push(update),
    });

    expect(result).toEqual([
      {
        path: 'package.json',
        size: 34,
        content: '{"dependencies":{"next":"15.0.0"}}',
      },
      { path: 'next.config.mjs', size: 17, content: 'export default {}' },
      { path: 'package-lock.json', size: 21 },
      { path: 'app/page.tsx', size: 33, content: 'export default function Page() {}' },
    ]);
    expect(archive.arrayBuffer).not.toHaveBeenCalled();
    expect(progress[0]).toEqual({ scannedEntries: 0, bytesRead: 0, totalBytes: archive.size });
    expect(progress.at(-1)).toMatchObject({ bytesRead: archive.size, totalBytes: archive.size });
  });

  it('ignores macOS metadata without losing the real archive wrapper', async () => {
    const archive = zipFile({
      '__MACOSX/._repo-main': 'metadata',
      'repo-main/package.json': '{"scripts":{"build":"vite build"}}',
      'repo-main/vite.config.ts': 'export default {}',
    });

    await expect(collectZipAnalysisFiles(archive)).resolves.toEqual([
      {
        path: 'package.json',
        size: 34,
        content: '{"scripts":{"build":"vite build"}}',
      },
      { path: 'vite.config.ts', size: 17, content: 'export default {}' },
    ]);
  });

  it('safely excludes traversal, absolute, Windows and null-containing paths', async () => {
    const archive = zipFile({
      '../secret/package.json': '{"secret":true}',
      '/absolute/index.html': '<h1>unsafe</h1>',
      'C:/windows/package.json': '{"unsafe":true}',
      'folder\\package.json': '{"unsafe":true}',
      'null\0byte/package.json': '{"unsafe":true}',
      'safe/package.json': '{"safe":true}',
    });

    await expect(collectZipAnalysisFiles(archive)).resolves.toEqual([
      { path: 'package.json', size: 13, content: '{"safe":true}' },
    ]);
  });

  it('does not extract secrets or locks and applies the shared content budget', async () => {
    const archive = zipFile({
      'project/.env': 'SECRET=never-send-this',
      'project/.env.production': 'SECRET=also-never-send-this',
      'project/.env.local.example': 'SECRET=',
      'project/yarn.lock': 'lots of lock data',
      'project/package.json': '{"private":true}',
    });

    const result = await collectZipAnalysisFiles(archive, { maxContentBytes: 8 });

    expect(result).toEqual([
      { path: '.env', size: 22 },
      { path: '.env.production', size: 27 },
      { path: '.env.local.example', size: 7, content: 'SECRET=' },
      { path: 'yarn.lock', size: 17 },
      { path: 'package.json', size: 16 },
    ]);
  });

  it('enforces the archive entry limit', async () => {
    const archive = zipFile({
      'one.txt': '1',
      'two.txt': '2',
      'three.txt': '3',
    });

    await expect(collectZipAnalysisFiles(archive, { maxEntries: 2 })).rejects.toThrow(
      'limited to 2 entries',
    );

    const generatedTree = zipFile({
      'project/node_modules/a/index.js': 'ignored',
      'project/node_modules/b/index.js': 'ignored',
      'project/package.json': '{"private":true}',
    });
    await expect(collectZipAnalysisFiles(generatedTree, { maxEntries: 1 })).resolves.toEqual([
      { path: 'package.json', size: 16, content: '{"private":true}' },
    ]);
  });

  it('can be aborted while the source stream is being read', async () => {
    const archive = zipFile({
      'project/package.json': '{"private":true}',
      'project/assets/large.bin': new Uint8Array(256 * 1024).fill(42),
    });
    const controller = new AbortController();

    await expect(collectZipAnalysisFiles(archive, {
      signal: controller.signal,
      onProgress: ({ bytesRead }) => {
        if (bytesRead > 0) controller.abort();
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
