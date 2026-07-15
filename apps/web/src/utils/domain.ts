export type DomainMode = 'apex' | 'subdomain';

export function normalizeSubdomain(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0] ?? '';
}

export function isValidSubdomain(value: string) {
  if (!value || value.length > 189) return false;
  return value.split('.').every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
}

export function domainHostname(mode: DomainMode, zoneName?: string, subdomain = '') {
  if (!zoneName) return '';
  if (mode === 'apex') return zoneName;
  const normalized = normalizeSubdomain(subdomain);
  return isValidSubdomain(normalized) ? `${normalized}.${zoneName}` : '';
}
