import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BRAND_CLAIM, BRAND_NAME, SESSION_EXPIRED_EVENT } from '../lib/brand';
import { ShelterFrog } from './ShelterFrog';

describe('Shelter brand', () => {
  it('keeps the public name, claim and browser event namespace stable', () => {
    expect(BRAND_NAME).toBe('Shelter');
    expect(BRAND_CLAIM).toBe('give your code a home');
    expect(SESSION_EXPIRED_EVENT).toBe('shelter:session-expired');
  });

  it('renders the frog as an accessible code-based SVG without raster assets', () => {
    const markup = renderToStaticMarkup(<ShelterFrog title="Shelter Frosch" />);
    expect(markup).toContain('<svg');
    expect(markup).toContain('<title');
    expect(markup).toContain('Shelter Frosch');
    expect(markup).toContain('aria-labelledby');
    expect(markup).not.toContain('<image');
  });
});

