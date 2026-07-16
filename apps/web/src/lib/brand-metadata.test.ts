import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BRAND_CLAIM, BRAND_NAME } from './brand';

const indexHtml = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(
  new URL('../../public/site.webmanifest', import.meta.url),
  'utf8',
)) as Record<string, unknown>;
const favicon16 = fs.readFileSync(new URL('../../public/favicon-16.png', import.meta.url));
const favicon32 = fs.readFileSync(new URL('../../public/favicon-32.png', import.meta.url));
const appleTouchIcon = fs.readFileSync(new URL('../../public/apple-touch-icon.png', import.meta.url));
const brandIcon64 = fs.readFileSync(new URL('../../public/brand/shelter-icon-64.png', import.meta.url));
const installIcon192 = fs.readFileSync(new URL('../../public/brand/shelter-icon-192.png', import.meta.url));
const installIcon = fs.readFileSync(new URL('../../public/brand/shelter-icon-512.png', import.meta.url));

function pngDimensions(image: Buffer): { width: number; height: number } {
  expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return {
    width: image.readUInt32BE(16),
    height: image.readUInt32BE(20),
  };
}

describe('Shelter browser metadata', () => {
  it('uses the public brand and exact claim in document metadata', () => {
    expect(indexHtml).toContain(`<meta name="application-name" content="${BRAND_NAME}"`);
    expect(indexHtml).toContain(`<meta property="og:title" content="${BRAND_NAME} — ${BRAND_CLAIM}"`);
    expect(indexHtml).toContain('<link rel="manifest" href="/site.webmanifest"');
    expect(indexHtml).toContain('<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png"');
    expect(indexHtml).toContain('<link rel="icon" href="/favicon-16.png" sizes="16x16" type="image/png"');
    expect(indexHtml).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180"');
  });

  it('ships rounded photographic frog icons at browser and install sizes', () => {
    expect(manifest).toMatchObject({
      name: BRAND_NAME,
      short_name: BRAND_NAME,
      description: BRAND_CLAIM,
      background_color: '#ffffff',
      theme_color: '#173f2d',
      icons: [
        {
          src: '/brand/shelter-icon-192.png',
          sizes: '192x192',
          type: 'image/png',
          purpose: 'any',
        },
        {
          src: '/brand/shelter-icon-512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any',
        },
      ],
    });
    expect(pngDimensions(favicon16)).toEqual({ width: 16, height: 16 });
    expect(pngDimensions(favicon32)).toEqual({ width: 32, height: 32 });
    expect(pngDimensions(appleTouchIcon)).toEqual({ width: 180, height: 180 });
    expect(pngDimensions(brandIcon64)).toEqual({ width: 64, height: 64 });
    expect(pngDimensions(installIcon192)).toEqual({ width: 192, height: 192 });
    expect(pngDimensions(installIcon)).toEqual({ width: 512, height: 512 });
  });
});
