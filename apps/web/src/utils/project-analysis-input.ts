import { Unzip, UnzipInflate, type UnzipFile } from 'fflate';

export interface ProjectAnalysisInputFile {
  path: string;
  size?: number;
  content?: string;
}

export interface ProjectAnalysisProgress {
  scannedEntries: number;
  bytesRead: number;
  totalBytes: number;
}

export interface ProjectAnalysisInputOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ProjectAnalysisProgress) => void;
  maxEntries?: number;
  maxContentBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_CONTENT_BYTES = 512 * 1024;
const MAX_SOURCE_FILE_BYTES = 64 * 1024;
const MAX_SOURCE_CONTENT_BYTES = 384 * 1024;
const MAX_ANALYSIS_PATH_LENGTH = 240;
const MAX_SCANNED_ARCHIVE_ENTRIES = 100_000;
const ZIP_INPUT_CHUNK_BYTES = 64 * 1024;
const EMPTY_CHUNK = new Uint8Array(0);

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '__macosx',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'vendor',
]);

const IGNORED_FILES = new Set([
  '.ds_store',
  'thumbs.db',
]);

const PRESENCE_ONLY_FILES = new Set([
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

const TEXT_CONFIGURATION_FILES = new Set([
  'astro.config.cjs',
  'astro.config.js',
  'astro.config.mjs',
  'astro.config.ts',
  'package.json',
  'vite.config.cjs',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'vite.config.jsx',
  'vite.config.tsx',
  'next.config.cjs',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
]);

const ENVIRONMENT_SOURCE_EXTENSIONS = new Set([
  '.astro', '.cjs', '.js', '.jsx', '.mjs', '.svelte', '.ts', '.tsx', '.vue',
]);

const ENVIRONMENT_SOURCE_IGNORED_SEGMENTS = new Set([
  '__fixtures__', '__mocks__', '__tests__', 'fixtures', 'mocks', 'test', 'tests',
]);

interface ResolvedOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ProjectAnalysisProgress) => void;
  maxEntries: number;
  maxContentBytes: number;
}

interface FolderEntry {
  file: File;
  path: string;
}

function resolveOptions(options: ProjectAnalysisInputOptions = {}): ResolvedOptions {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('maxEntries must be a positive integer.');
  }
  if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes < 0) {
    throw new RangeError('maxContentBytes must be a non-negative integer.');
  }
  return { ...options, maxEntries, maxContentBytes };
}

function abortError(): DOMException {
  return new DOMException('Project analysis was cancelled.', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/**
 * Returns a safe, portable relative path or null for an entry that must never
 * be sent to the analysis API. Backslashes are rejected instead of normalized
 * so a path cannot mean two different things on Unix and Windows.
 */
function normalizeRelativePath(input: string): string | null {
  if (!input || input.includes('\0') || input.includes('\\')) return null;
  if (input.startsWith('/') || /^[a-zA-Z]:\//.test(input)) return null;

  const withoutTrailingSlash = input.endsWith('/') ? input.slice(0, -1) : input;
  if (!withoutTrailingSlash) return null;
  const segments = withoutTrailingSlash.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

function stripCommonTopDirectory(paths: string[]): string[] {
  if (paths.length === 0) return [];
  const segments = paths.map((path) => path.split('/'));
  const commonTop = segments[0]?.[0];
  if (!commonTop || !segments.every((parts) => parts.length > 1 && parts[0] === commonTop)) {
    return paths;
  }
  return segments.map((parts) => parts.slice(1).join('/'));
}

function isIgnoredPath(path: string): boolean {
  const directories = path.split('/').slice(0, -1);
  return directories.some((segment) => IGNORED_DIRECTORIES.has(segment.toLowerCase()))
    || IGNORED_FILES.has(basename(path).toLowerCase());
}

function basename(path: string): string {
  return path.split('/').at(-1) ?? path;
}

function isExampleEnvironmentFile(name: string): boolean {
  return /^\.env(?:\.[a-z0-9_-]+)*\.(?:example|sample)$/i.test(name);
}

function extension(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index).toLowerCase();
}

function isEnvironmentSourceContentPath(path: string): boolean {
  const segments = path.toLowerCase().split('/');
  const name = segments.at(-1) ?? '';
  if (segments.some((segment) => ENVIRONMENT_SOURCE_IGNORED_SEGMENTS.has(segment))) return false;
  if (/\.(?:spec|test|stories)\.[^.]+$/.test(name)) return false;
  return ENVIRONMENT_SOURCE_EXTENSIONS.has(extension(path));
}

function isProjectConfigurationTextPath(path: string): boolean {
  const name = basename(path).toLowerCase();
  return TEXT_CONFIGURATION_FILES.has(name) || isExampleEnvironmentFile(name);
}

function shouldReadTextContent(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (PRESENCE_ONLY_FILES.has(name)) return false;
  return isProjectConfigurationTextPath(path) || isEnvironmentSourceContentPath(path);
}

function decodeUtf8(chunks: Uint8Array[], totalBytes: number): string | undefined {
  const value = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    return undefined;
  }
}

async function readFileText(file: File, maximumBytes: number, signal?: AbortSignal): Promise<string | undefined> {
  if (file.size > maximumBytes) return undefined;
  throwIfAborted(signal);

  const reader = file.stream().getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const cancel = (): void => {
    void reader.cancel(abortError()).catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) return undefined;
      chunks.push(value);
    }
    throwIfAborted(signal);
    return decodeUtf8(chunks, totalBytes);
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function reportProgress(
  options: ResolvedOptions,
  scannedEntries: number,
  bytesRead: number,
  totalBytes: number,
): void {
  options.onProgress?.({ scannedEntries, bytesRead, totalBytes });
}

function tooManyEntries(maxEntries: number): Error {
  return new Error(`Project analysis is limited to ${maxEntries.toLocaleString('en-US')} entries.`);
}

export async function collectFolderAnalysisFiles(
  files: File[],
  inputOptions: ProjectAnalysisInputOptions = {},
): Promise<ProjectAnalysisInputFile[]> {
  const options = resolveOptions(inputOptions);
  throwIfAborted(options.signal);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  reportProgress(options, 0, 0, totalBytes);

  const safeEntries: FolderEntry[] = [];
  for (const file of files) {
    throwIfAborted(options.signal);
    const path = normalizeRelativePath(file.webkitRelativePath || file.name);
    if (!path) continue;
    safeEntries.push({ file, path });
  }

  const relevantEntries = safeEntries.filter((entry) => !isIgnoredPath(entry.path));
  const strippedPaths = stripCommonTopDirectory(relevantEntries.map((entry) => entry.path));
  const entries = relevantEntries
    .map((entry, index) => ({ ...entry, path: strippedPaths[index] ?? entry.path }))
    .filter((entry) => entry.path.length <= MAX_ANALYSIS_PATH_LENGTH && !isIgnoredPath(entry.path));
  if (entries.length > options.maxEntries) throw tooManyEntries(options.maxEntries);
  const results: ProjectAnalysisInputFile[] = [];
  const seenPaths = new Set<string>();
  let contentBytes = 0;
  let sourceContentBytes = 0;
  let processedBytes = 0;
  let scannedEntries = 0;

  for (const entry of entries) {
    throwIfAborted(options.signal);
    processedBytes += entry.file.size;
    scannedEntries += 1;
    if (seenPaths.has(entry.path)) {
      reportProgress(options, scannedEntries, Math.min(processedBytes, totalBytes), totalBytes);
      continue;
    }
    seenPaths.add(entry.path);

    const result: ProjectAnalysisInputFile = { path: entry.path, size: entry.file.size };
    if (shouldReadTextContent(entry.path)) {
      const sourceFile = isEnvironmentSourceContentPath(entry.path)
        && !isProjectConfigurationTextPath(entry.path);
      const remainingBytes = sourceFile
        ? Math.min(
            options.maxContentBytes - contentBytes,
            MAX_SOURCE_CONTENT_BYTES - sourceContentBytes,
            MAX_SOURCE_FILE_BYTES,
          )
        : options.maxContentBytes - contentBytes;
      const content = await readFileText(entry.file, remainingBytes, options.signal);
      if (content !== undefined) {
        result.content = content;
        contentBytes += entry.file.size;
        if (sourceFile) sourceContentBytes += entry.file.size;
      }
    }
    results.push(result);
    reportProgress(options, scannedEntries, Math.min(processedBytes, totalBytes), totalBytes);
  }
  throwIfAborted(options.signal);
  reportProgress(options, safeEntries.length, totalBytes, totalBytes);
  return results;
}

function terminateStreams(streams: Set<UnzipFile>): void {
  for (const stream of streams) {
    try {
      stream.terminate();
    } catch {
      // The stream may already have completed synchronously.
    }
  }
  streams.clear();
}

export async function collectZipAnalysisFiles(
  file: File,
  inputOptions: ProjectAnalysisInputOptions = {},
): Promise<ProjectAnalysisInputFile[]> {
  const options = resolveOptions(inputOptions);
  throwIfAborted(options.signal);
  reportProgress(options, 0, 0, file.size);

  const pending: ProjectAnalysisInputFile[] = [];
  const activeStreams = new Set<UnzipFile>();
  let contentBytes = 0;
  let sourceContentBytes = 0;
  let sourceReservedBytes = 0;
  let scannedEntries = 0;
  let bytesRead = 0;
  let failure: Error | null = null;

  const unzip = new Unzip((entry) => {
    if (failure) return;
    scannedEntries += 1;
    if (scannedEntries > Math.max(MAX_SCANNED_ARCHIVE_ENTRIES, options.maxEntries)) {
      failure = new Error(`Project analysis cannot scan more than ${MAX_SCANNED_ARCHIVE_ENTRIES.toLocaleString('en-US')} archive entries.`);
      return;
    }

    const directory = entry.name.endsWith('/');
    const normalizedPath = normalizeRelativePath(entry.name);
    reportProgress(options, scannedEntries, bytesRead, file.size);
    if (directory || !normalizedPath) return;

    const result: ProjectAnalysisInputFile = { path: normalizedPath };
    if (entry.originalSize !== undefined) result.size = entry.originalSize;
    pending.push(result);

    if (isIgnoredPath(normalizedPath) || !shouldReadTextContent(normalizedPath)) return;
    const sourceFile = isEnvironmentSourceContentPath(normalizedPath)
      && !isProjectConfigurationTextPath(normalizedPath);
    const remainingBytes = sourceFile
      ? Math.min(
          options.maxContentBytes - contentBytes,
          MAX_SOURCE_CONTENT_BYTES - sourceContentBytes - sourceReservedBytes,
          MAX_SOURCE_FILE_BYTES,
        )
      : options.maxContentBytes - contentBytes;
    if (remainingBytes <= 0 || (entry.originalSize !== undefined && entry.originalSize > remainingBytes)) return;
    const sourceReservation = sourceFile
      ? Math.min(entry.originalSize ?? remainingBytes, remainingBytes)
      : 0;
    sourceReservedBytes += sourceReservation;

    const chunks: Uint8Array[] = [];
    let entryBytes = 0;
    let exceededLimit = false;
    activeStreams.add(entry);
    entry.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) {
        failure = error;
        sourceReservedBytes -= sourceReservation;
        activeStreams.delete(entry);
        return;
      }
      if (!exceededLimit && chunk) {
        entryBytes += chunk.byteLength;
        if (entryBytes > remainingBytes) {
          exceededLimit = true;
          chunks.length = 0;
          try {
            entry.terminate();
          } catch {
            // A synchronous inflate stream can already be complete here.
          }
        } else if (chunk.byteLength > 0) {
          chunks.push(chunk);
        }
      }
      if (!final) return;
      activeStreams.delete(entry);
      sourceReservedBytes -= sourceReservation;
      if (result.size === undefined) result.size = entryBytes;
      if (exceededLimit) return;
      const content = decodeUtf8(chunks, entryBytes);
      if (content !== undefined) {
        result.content = content;
        contentBytes += entryBytes;
        if (sourceFile) sourceContentBytes += entryBytes;
      }
    };

    try {
      entry.start();
    } catch (error) {
      activeStreams.delete(entry);
      failure = error instanceof Error ? error : new Error('ZIP entry could not be read.');
    }
  });
  unzip.register(UnzipInflate);

  const reader = file.stream().getReader();
  const cancel = (): void => {
    terminateStreams(activeStreams);
    void reader.cancel(abortError()).catch(() => undefined);
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      throwIfAborted(options.signal);
      const { done, value } = await reader.read();
      if (done) break;
      for (let offset = 0; offset < value.byteLength; offset += ZIP_INPUT_CHUNK_BYTES) {
        throwIfAborted(options.signal);
        const chunk = value.subarray(offset, Math.min(offset + ZIP_INPUT_CHUNK_BYTES, value.byteLength));
        bytesRead += chunk.byteLength;
        unzip.push(chunk);
        if (failure) throw failure;
        reportProgress(options, scannedEntries, Math.min(bytesRead, file.size), file.size);
      }
    }
    unzip.push(EMPTY_CHUNK, true);
    if (failure) throw failure;
    throwIfAborted(options.signal);
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    terminateStreams(activeStreams);
    reader.releaseLock();
  }

  const relevantEntries = pending.filter((entry) => !isIgnoredPath(entry.path));
  const normalizedPaths = stripCommonTopDirectory(relevantEntries.map((entry) => entry.path));
  const results: ProjectAnalysisInputFile[] = [];
  const seenPaths = new Set<string>();
  relevantEntries.forEach((entry, index) => {
    const path = normalizedPaths[index] ?? entry.path;
    if (path.length > MAX_ANALYSIS_PATH_LENGTH || isIgnoredPath(path) || seenPaths.has(path)) return;
    seenPaths.add(path);
    results.push({ ...entry, path });
  });
  if (results.length > options.maxEntries) throw tooManyEntries(options.maxEntries);
  return results;
}
