import { afterEach, describe, expect, it, vi } from 'vitest';
import { submitGitHubManifest } from './github-manifest';

interface StubElement {
  action?: string;
  hidden?: boolean;
  method?: string;
  name?: string;
  type?: string;
  value?: string;
  children: StubElement[];
  append: (...children: StubElement[]) => void;
  submit?: ReturnType<typeof vi.fn>;
}

function element(tagName: string): StubElement {
  const node: StubElement = {
    children: [],
    append(...children) {
      node.children.push(...children);
    },
  };
  if (tagName === 'form') node.submit = vi.fn();
  return node;
}

describe('GitHub manifest form submission', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts an unchanged JSON manifest to a validated organization registration endpoint', () => {
    const nodes: StubElement[] = [];
    const body = element('body');
    vi.stubGlobal('document', {
      body,
      createElement: (tagName: string) => {
        const node = element(tagName);
        nodes.push(node);
        return node;
      },
    });
    const manifest = {
      name: 'Shelter replacement',
      default_permissions: { contents: 'read', pull_requests: 'read' },
      default_events: ['push', 'pull_request'],
    };

    submitGitHubManifest(
      'https://github.com/organizations/shelter/settings/apps/new?state=abcdefghijklmnop',
      manifest,
    );

    const form = nodes[0]!;
    const input = nodes[1]!;
    expect(form).toMatchObject({
      action: 'https://github.com/organizations/shelter/settings/apps/new?state=abcdefghijklmnop',
      hidden: true,
      method: 'POST',
    });
    expect(input).toMatchObject({
      name: 'manifest',
      type: 'hidden',
      value: JSON.stringify(manifest),
    });
    expect(form.children).toEqual([input]);
    expect(body.children).toEqual([form]);
    expect(form.submit).toHaveBeenCalledOnce();
  });

  it('rejects an untrusted registration destination before creating a form', () => {
    const createElement = vi.fn();
    vi.stubGlobal('document', {
      body: element('body'),
      createElement,
      documentElement: { lang: 'en' },
    });

    expect(() => submitGitHubManifest(
      'https://github.com.evil.test/settings/apps/new?state=abcdefghijklmnop',
      '{}',
    )).toThrow('invalid registration URL');
    expect(createElement).not.toHaveBeenCalled();
  });
});
