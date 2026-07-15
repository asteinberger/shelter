import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GitHubIcon } from './GitHubIcon';

describe('GitHubIcon', () => {
  it('is decorative by default while preserving sizing classes', () => {
    const markup = renderToStaticMarkup(<GitHubIcon className="size-5" />);

    expect(markup).toContain('class="size-5"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('focusable="false"');
    expect(markup).toContain('viewBox="0 0 98 96"');
  });

  it('exposes an accessible name when a title is provided', () => {
    const markup = renderToStaticMarkup(<GitHubIcon title="GitHub" />);

    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-labelledby');
    expect(markup).toContain('<title');
    expect(markup).toContain('GitHub</title>');
    expect(markup).not.toContain('aria-hidden="true"');
  });
});
