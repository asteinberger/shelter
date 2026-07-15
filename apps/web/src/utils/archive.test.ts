import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveFolder, type ArchiveProgress } from './archive';

function folderFile(path: string, contents: BlobPart): File {
  const file = new File([contents], path.split('/').at(-1) ?? 'file');
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

describe('archiveFolder', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('packs larger folder files without starting a Web Worker', async () => {
    vi.stubGlobal('Worker', class BlockedWorker {
      constructor() {
        throw new Error('Worker is blocked by CSP');
      }
    });
    const largeContents = new Uint8Array(200_000).fill(42);
    const files = [
      folderFile('website/index.html', '<h1>Shelter</h1>'),
      folderFile('website/assets/app.js', largeContents),
    ];
    const progress: ArchiveProgress[] = [];

    const archive = await archiveFolder(files, (update) => progress.push(update));
    const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));

    expect(new TextDecoder().decode(entries['website/index.html'])).toBe('<h1>Shelter</h1>');
    expect(entries['website/assets/app.js']).toEqual(largeContents);
    expect(progress.at(-1)).toMatchObject({
      phase: 'packing',
      current: 2,
      total: 2,
      processedBytes: 200_016,
      totalBytes: 200_016,
    });
  });

  it('rejects duplicate and unsafe archive paths', async () => {
    await expect(archiveFolder([
      folderFile('website/index.html', 'first'),
      folderFile('website/index.html', 'second'),
    ])).rejects.toThrow('more than once');

    await expect(archiveFolder([
      folderFile('../secret.txt', 'secret'),
    ])).rejects.toThrow('cannot be archived safely');
  });
});
