export interface FolderUploadFile {
  name: string;
  webkitRelativePath?: string;
}

const FILE_STORAGE_EXTENSIONS = new Set([
  '.aac', '.avif', '.bmp', '.csv', '.doc', '.docx', '.flac', '.gif', '.heic', '.heif',
  '.ico', '.jpeg', '.jpg', '.m4a', '.m4v', '.md', '.mov', '.mp3', '.mp4', '.oga', '.ogg',
  '.ogv', '.opus', '.otf', '.pdf', '.png', '.ppt', '.pptx', '.rtf', '.svg', '.text', '.tif',
  '.tiff', '.tsv', '.ttf', '.txt', '.wav', '.webm', '.webp', '.woff', '.woff2', '.xls',
  '.xlsx',
]);
const EXTENSIONLESS_PUBLIC_FILES = new Set(['copying', 'license', 'notice', 'readme']);
const BLOCKED_PROJECT_FILES = new Set([
  'bun.lock', 'bun.lockb', 'cargo.lock', 'cargo.toml', 'composer.json', 'composer.lock',
  'deno.json', 'deno.jsonc', 'docker-compose.yml', 'docker-compose.yaml', 'dockerfile',
  'gemfile', 'gemfile.lock', 'go.mod', 'go.sum', 'package-lock.json', 'package.json',
  'pnpm-lock.yaml', 'poetry.lock', 'pyproject.toml', 'requirements.txt', 'tsconfig.json',
  'yarn.lock',
]);
const IGNORED_METADATA = new Set(['.ds_store', 'desktop.ini', 'thumbs.db']);

function publicContentPath(file: FolderUploadFile): string[] {
  const path = file.webkitRelativePath || file.name;
  const segments = path.replaceAll('\\', '/').split('/').filter(Boolean);
  return file.webkitRelativePath ? segments.slice(1) : segments;
}

/**
 * A fast, conservative browser-side hint. The server repeats the authoritative
 * check after safely extracting the archive.
 */
export function isLikelyFileStorageFolder(files: FolderUploadFile[]): boolean {
  let publicFiles = 0;

  for (const file of files) {
    const segments = publicContentPath(file);
    const name = segments.at(-1)?.toLowerCase() ?? file.name.toLowerCase();
    if (
      segments.some((segment) => segment.startsWith('.') || segment.toLowerCase() === '__macosx')
      || IGNORED_METADATA.has(name)
    ) continue;
    if (BLOCKED_PROJECT_FILES.has(name)) return false;

    const dot = name.lastIndexOf('.');
    const extension = dot > 0 ? name.slice(dot) : '';
    if (!FILE_STORAGE_EXTENSIONS.has(extension) && !EXTENSIONLESS_PUBLIC_FILES.has(name)) return false;
    publicFiles += 1;
  }

  return publicFiles > 0;
}
