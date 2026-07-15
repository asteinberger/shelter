import { describe, expect, it } from 'vitest';
import { isLikelyFileStorageFolder, type FolderUploadFile } from './file-storage';

function file(path: string): FolderUploadFile {
  return { name: path.split('/').at(-1) ?? path, webkitRelativePath: path };
}

describe('isLikelyFileStorageFolder', () => {
  it('recognizes media and document folders', () => {
    expect(isLikelyFileStorageFolder([
      file('campaign/cover.jpg'),
      file('campaign/gallery/frog.avif'),
      file('campaign/press-kit.pdf'),
      file('campaign/README'),
    ])).toBe(true);
  });

  it('ignores hidden operating-system metadata', () => {
    expect(isLikelyFileStorageFolder([
      file('campaign/.DS_Store'),
      file('campaign/__MACOSX/._cover.jpg'),
      file('campaign/Thumbs.db'),
      file('campaign/cover.png'),
    ])).toBe(true);
  });

  it('does not label projects or source folders as file storage', () => {
    expect(isLikelyFileStorageFolder([
      file('app/package.json'),
      file('app/cover.png'),
    ])).toBe(false);
    expect(isLikelyFileStorageFolder([
      file('app/server.php'),
      file('app/cover.png'),
    ])).toBe(false);
    expect(isLikelyFileStorageFolder([
      file('site/index.html'),
      file('site/cover.png'),
    ])).toBe(false);
    expect(isLikelyFileStorageFolder([
      file('source/server.js'),
      file('source/credentials.json'),
    ])).toBe(false);
  });

  it('rejects empty and metadata-only selections', () => {
    expect(isLikelyFileStorageFolder([])).toBe(false);
    expect(isLikelyFileStorageFolder([file('campaign/.DS_Store')])).toBe(false);
  });
});
