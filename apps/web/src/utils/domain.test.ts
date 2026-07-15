import { describe, expect, it } from 'vitest';
import { domainHostname, isValidSubdomain, normalizeSubdomain } from './domain';

describe('domain helpers', () => {
  it('uses the selected Cloudflare zone directly for a main domain', () => {
    expect(domainHostname('apex', 'example.com')).toBe('example.com');
  });

  it('combines a valid nested subdomain with the selected zone', () => {
    expect(domainHostname('subdomain', 'example.com', 'Preview.Shop')).toBe('preview.shop.example.com');
  });

  it('does not produce a subdomain hostname from an empty or invalid prefix', () => {
    expect(domainHostname('subdomain', 'example.com', '')).toBe('');
    expect(domainHostname('subdomain', 'example.com', '-invalid')).toBe('');
  });

  it('normalizes pasted hostnames and validates labels', () => {
    expect(normalizeSubdomain('https://APP.example.com/path')).toBe('app.example.com');
    expect(isValidSubdomain('preview.shop')).toBe(true);
    expect(isValidSubdomain('preview..shop')).toBe(false);
  });
});
