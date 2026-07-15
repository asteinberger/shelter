import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BRAND_CLAIM, BRAND_NAME } from './brand';

const indexHtml = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(
  new URL('../../public/site.webmanifest', import.meta.url),
  'utf8',
)) as Record<string, unknown>;
const favicon = fs.readFileSync(new URL('../../public/favicon.svg', import.meta.url), 'utf8');

describe('Shelter browser metadata', () => {
  it('uses the public brand and exact claim in document metadata', () => {
    expect(indexHtml).toContain(`<meta name="application-name" content="${BRAND_NAME}"`);
    expect(indexHtml).toContain(`<meta property="og:title" content="${BRAND_NAME} — ${BRAND_CLAIM}"`);
    expect(indexHtml).toContain('<link rel="manifest" href="/site.webmanifest"');
    expect(indexHtml).toContain('<link rel="icon" href="/favicon.svg"');
  });

  it('ships install metadata and an SVG-only frog icon', () => {
    expect(manifest).toMatchObject({
      name: BRAND_NAME,
      short_name: BRAND_NAME,
      description: BRAND_CLAIM,
      background_color: '#ffffff',
      theme_color: '#173f2d',
    });
    expect(favicon).toContain('<svg');
    expect(favicon).not.toContain('<image');
  });
});

