import { describe, expect, it } from 'vitest';
import { buildSiteSpace, normalizeUrl, resolveUrl } from '../build-site-space';

const files = {
  'content/index.md': '---\ntitle: Home\nslug: index\nstatus: published\nexcerpt: The front page.\n---\n\n## What\n\nWelcome.\n',
  'content/about.md': '---\ntitle: About Us\nslug: about\nstatus: draft\nexcerpt: SECRET-DRAFT-EXCERPT\n---\n\nSECRET-DRAFT-BODY\n',
  'content/blog/first-post.md': '---\ntitle: A First Post\nslug: first-post\nstatus: published\ndate: 2026-01-02\ncategories:\n  - "Notes"\n  - "Fixtures"\nexcerpt: One post.\n---\n\nPost body text.\n',
};
const opts = { url: 'https://site.example.test', publisher: 'Example Studio LLC', siteName: 'Example Studio' };

describe('build-site-space', () => {
  it('includes published pages and posts, leaves a draft out entirely, and carries the leap to the site', () => {
    const r = buildSiteSpace(files, opts);
    expect(r.pages).toBe(1);
    expect(r.posts).toBe(1);
    expect(r.skippedNotPublished).toBe(1);
    expect(r.text).not.toMatch(/About Us|SECRET-DRAFT/);
    expect(r.text).not.toContain('Post body text');
    expect(r.text).toContain('<urn:reckons:leap> "https://site.example.test/"');
    expect(r.text).toContain('"https://site.example.test/blog/first-post/"');
    expect(r.text).toContain('"Example Studio LLC"');
    expect(r.text).toContain('pred:category "Notes"');
  });
  it('gives the same bytes on two runs', () => {
    expect(buildSiteSpace(files, opts).text).toBe(buildSiteSpace(files, opts).text);
  });
  it('refuses a non-https address and takes the address only from url or siteUrl in the config', () => {
    expect(() => normalizeUrl('http://site.example.test')).toThrow();
    expect(() => normalizeUrl('https://user:pw@site.example.test')).toThrow();
    expect(() => resolveUrl('/nonexistent-dir')).toThrow(/no public address/);
  });
});
