import { describe, expect, it } from 'vitest';
import { normalizeStaticBasePath, staticBasePathError } from './static-base-path';

describe('static base path helpers', () => {
  it('normalizes a missing leading slash immediately and a trailing slash on finalize', () => {
    expect(normalizeStaticBasePath('shop')).toBe('/shop');
    expect(normalizeStaticBasePath('/shop/')).toBe('/shop/');
    expect(normalizeStaticBasePath('/shop/', true)).toBe('/shop');
    expect(normalizeStaticBasePath('/', true)).toBe('/');
  });

  it('accepts root and nested URL-safe prefixes', () => {
    expect(staticBasePathError('/')).toBeUndefined();
    expect(staticBasePathError('/shop')).toBeUndefined();
    expect(staticBasePathError('/shop/app_v2')).toBeUndefined();
  });

  it('rejects paths outside the server contract', () => {
    expect(staticBasePathError('')).toBeTruthy();
    expect(staticBasePathError('/shop/')).toBeTruthy();
    expect(staticBasePathError('/shop.html')).toBeTruthy();
    expect(staticBasePathError('/shop//app')).toBeTruthy();
    expect(staticBasePathError('/shop?q=1')).toBeTruthy();
    expect(staticBasePathError('\\shop')).toBeTruthy();
  });
});

