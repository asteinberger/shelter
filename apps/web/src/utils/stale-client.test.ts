import { describe, expect, it, vi } from 'vitest';
import {
  isStaleClientError,
  recoverFromStaleClientError,
  type StaleClientReloadRuntime,
} from './stale-client';

function runtime(marker: string | null = null, buildId = 'build-new') {
  let stored = marker;
  const reload = vi.fn();
  const value: StaleClientReloadRuntime = {
    buildId,
    readMarker: () => stored,
    writeMarker: (next) => { stored = next; },
    reload,
  };
  return { value, reload, marker: () => stored };
}

describe('stale client recovery', () => {
  it('recognizes stale Vite and chunk loading failures', () => {
    expect(isStaleClientError(new TypeError('Failed to fetch dynamically imported module: /assets/Overview-old.js'))).toBe(true);
    expect(isStaleClientError(new Error('Unable to preload CSS for /assets/index-old.css'))).toBe(true);
    expect(isStaleClientError(new Error('ChunkLoadError: Loading chunk 42 failed'))).toBe(true);
    expect(isStaleClientError(new Error('The dashboard response was invalid'))).toBe(false);
  });

  it('reloads once per entry build and suppresses a reload loop', () => {
    const first = runtime();
    const error = new TypeError('Failed to fetch dynamically imported module: /assets/Overview-old.js');
    expect(recoverFromStaleClientError(error, first.value)).toBe(true);
    expect(first.marker()).toBe('build-new');
    expect(first.reload).toHaveBeenCalledOnce();

    const repeated = runtime('build-new', 'build-new');
    expect(recoverFromStaleClientError(error, repeated.value)).toBe(false);
    expect(repeated.reload).not.toHaveBeenCalled();

    const later = runtime('build-new', 'build-later');
    expect(recoverFromStaleClientError(error, later.value)).toBe(true);
    expect(later.reload).toHaveBeenCalledOnce();
  });

  it('falls back to the error boundary when session storage is unavailable', () => {
    const blocked = runtime();
    blocked.value.readMarker = () => { throw new Error('Storage blocked'); };
    const error = new TypeError('Failed to fetch dynamically imported module: /assets/Overview-old.js');
    expect(recoverFromStaleClientError(error, blocked.value)).toBe(false);
    expect(blocked.reload).not.toHaveBeenCalled();
  });

  it('does not reload for ordinary rendering errors', () => {
    const ordinary = runtime();
    expect(recoverFromStaleClientError(new Error('Render failed'), ordinary.value)).toBe(false);
    expect(ordinary.reload).not.toHaveBeenCalled();
  });
});
