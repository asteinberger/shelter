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

  it('renders the photographic frog icon with accessible alternative text', () => {
    const markup = renderToStaticMarkup(<ShelterFrog title="Shelter Frosch" />);
    expect(markup).toContain('<img');
    expect(markup).toContain('src="/brand/shelter-icon-64.png"');
    expect(markup).toContain('alt="Shelter Frosch"');
    expect(markup).toContain('width="64"');
    expect(markup).toContain('height="64"');
    expect(markup).not.toContain('<svg');
  });
});
