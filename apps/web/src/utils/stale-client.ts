const reloadMarkerKey = 'shelter.stale-client-reload-build';

const staleClientPatterns = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
  /loading (?:css )?chunk .+ failed/i,
  /chunkloaderror/i,
];

export interface StaleClientReloadRuntime {
  buildId: string;
  readMarker(): string | null;
  writeMarker(value: string): void;
  reload(): void;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error ?? '');
}

export function isStaleClientError(error: unknown): boolean {
  const message = errorText(error);
  return staleClientPatterns.some((pattern) => pattern.test(message));
}

function browserRuntime(): StaleClientReloadRuntime {
  return {
    buildId: import.meta.url,
    readMarker: () => window.sessionStorage.getItem(reloadMarkerKey),
    writeMarker: (value) => window.sessionStorage.setItem(reloadMarkerKey, value),
    reload: () => window.location.reload(),
  };
}

export function recoverFromStaleClientError(
  error: unknown,
  runtime: StaleClientReloadRuntime = browserRuntime(),
): boolean {
  if (!isStaleClientError(error)) return false;

  try {
    if (runtime.readMarker() === runtime.buildId) return false;
    runtime.writeMarker(runtime.buildId);
  } catch {
    // Without a reliable marker, automatic reloads could loop forever. The
    // error boundary still offers a manual reload in this uncommon case.
    return false;
  }

  runtime.reload();
  return true;
}
