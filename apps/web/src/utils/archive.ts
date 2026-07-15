import { Zip, ZipDeflate } from 'fflate';
import { localize } from '../i18n';

export interface ArchiveProgress {
  phase: 'packing';
  current: number;
  total: number;
  processedBytes: number;
  totalBytes: number;
}

const EMPTY_CHUNK = new Uint8Array(0);
const YIELD_AFTER_BYTES = 2 * 1024 * 1024;

function archivePath(file: File): string {
  const path = file.webkitRelativePath || file.name;
  const segments = path.split('/');
  if (!path || path.includes('\\') || path.startsWith('/') || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(localize(
      'The file path “{path}” cannot be archived safely.',
      'Der Dateipfad „{path}“ kann nicht sicher gepackt werden.',
      { path: path || file.name },
    ));
  }
  return path;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function archiveFolder(
  files: File[],
  onProgress?: (progress: ArchiveProgress) => void,
): Promise<File> {
  if (files.length === 0) throw new Error(localize('The selected folder contains no files.', 'Der ausgewählte Ordner enthält keine Dateien.'));

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const paths = new Set<string>();
  let processedBytes = 0;
  let bytesSinceYield = 0;

  return new Promise((resolve, reject) => {
    const chunks: Array<Uint8Array<ArrayBuffer>> = [];
    let settled = false;
    const archive = new Zip((error, data, final) => {
      if (settled) return;
      if (error) {
        settled = true;
        reject(error);
        return;
      }
      if (data.length > 0) chunks.push(data as Uint8Array<ArrayBuffer>);
      if (final) {
        settled = true;
        resolve(new File(chunks, 'project-folder.zip', { type: 'application/zip' }));
      }
    });

    void (async () => {
      try {
        for (let index = 0; index < files.length; index += 1) {
          if (settled) return;
          const file = files[index];
          if (!file) continue;
          const path = archivePath(file);
          if (paths.has(path)) throw new Error(localize(
            'The file path “{path}” occurs more than once in the folder.',
            'Der Dateipfad „{path}“ ist im Ordner doppelt vorhanden.',
            { path },
          ));
          paths.add(path);

          const entry = new ZipDeflate(path, { level: 1 });
          archive.add(entry);
          onProgress?.({
            phase: 'packing',
            current: index + 1,
            total: files.length,
            processedBytes,
            totalBytes,
          });

          const reader = file.stream().getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              entry.push(value);
              processedBytes += value.byteLength;
              bytesSinceYield += value.byteLength;
              onProgress?.({
                phase: 'packing',
                current: index + 1,
                total: files.length,
                processedBytes,
                totalBytes,
              });
              if (bytesSinceYield >= YIELD_AFTER_BYTES) {
                bytesSinceYield = 0;
                await yieldToBrowser();
              }
            }
          } finally {
            reader.releaseLock();
          }
          entry.push(EMPTY_CHUNK, true);
        }
        archive.end();
      } catch (error) {
        if (settled) return;
        settled = true;
        archive.terminate();
        reject(error instanceof Error ? error : new Error(localize('The project folder could not be archived.', 'Der Projektordner konnte nicht gepackt werden.')));
      }
    })();
  });
}
