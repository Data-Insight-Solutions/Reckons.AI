import { describe, expect, it } from 'vitest';
import { buildSiteSpace, normalizeUrl, resolveFooter, resolveUrl } from '../build-site-space';
import { extractStories } from '../../../src/lib/rdf/story';

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

  describe('the story of how the site was made (F292.1)', () => {
    const withFacts = {
      ...files,
      'content/credentials.md': '---\ntitle: Credentials\nslug: credentials\nstatus: published\ntemplate: doc\n---\n\n- Certificate Alpha | valid-until: 2027-06-30\n- Certificate Beta | valid-until: ?\n',
      'content/blog/second-post.md': '---\ntitle: Second\nslug: second-post\nstatus: published\ndate: 2026-02-03\nexcerpt: Two.\n---\n\n- Certificate Alpha | valid-until: 2027-06-30\n',
    };
    const o = { ...opts, footer: '(c) 2026 Example Studio, Anytown' };
    const iris = (r: ReturnType<typeof buildSiteSpace>) => new Set(r.statements.map((x) => x.s.value));

    it('holds one story with five ordered steps whose highlights are all nodes of the same file', () => {
      const r = buildSiteSpace(withFacts, o);
      const stories = extractStories(r.statements);
      expect(stories).toHaveLength(1);
      expect(stories[0].label).toBe('How this website was made');
      expect(stories[0].steps.map((x) => x.order)).toEqual([1, 2, 3, 4, 5]);
      const nodes = iris(r);
      for (const step of stories[0].steps) {
        expect(step.highlights.length).toBeGreaterThan(0);
        for (const h of step.highlights) expect(nodes.has(h), h).toBe(true);
      }
    });
    it('writes the counts of the build into the captions, never typed numbers', () => {
      const r = buildSiteSpace(withFacts, o);
      const [st] = extractStories(r.statements);
      const total = r.pages + r.posts;
      expect(r.pages).toBe(2); expect(r.posts).toBe(2);
      expect(st.steps[0].content).toContain(`${r.pages} pages and ${r.posts} blog posts, ${total} in all`);
      expect(st.steps[2].content).toContain(`all ${total} pages and posts`);
      expect(st.steps[2].content).toContain('(c) 2026 Example Studio, Anytown');
      expect(st.steps[3].content).toContain('1 fact on this site carries an end date: Certificate Alpha (valid until 2027-06-30)');
      expect(st.steps[3].content).toContain('1 fact has no date yet');
      // the shared line is stated on every published page and post, one edge each
      const edges = r.statements.filter((x) => x.s.value.endsWith('dis-shared-footer') && x.p.value.endsWith('/stated-on'));
      expect(edges).toHaveLength(total);
      // a fact stated on two pages names both; the open date stays an open question, not a date
      const alphaPages = r.statements.filter((x) => x.s.value.includes('dis-fact-') && x.p.value.endsWith('/stated-on') && x.o.value.includes('credentials'));
      expect(alphaPages.length).toBe(2);
      const open = r.statements.find((x) => x.needsObject === true)!;
      expect(open.o.value).toBe('?');
      expect(open.blocks).toHaveLength(1);
    });
    it('says plainly that no fact is dated when none is, and lights the check', () => {
      const r = buildSiteSpace(files, o);
      const [st] = extractStories(r.statements);
      expect(st.steps[3].content).toContain('none of the 2 pages carries one');
      expect(st.steps[3].highlights).toEqual(['urn:kbase:concept/dis-expiry-check']);
      expect(st.steps[0].content).toContain('no content from them is included');
    });
    it('gives the same bytes on two runs, and takes the footer only from footer.text of the config', () => {
      expect(buildSiteSpace(withFacts, o).text).toBe(buildSiteSpace(withFacts, o).text);
      expect(resolveFooter('/nonexistent-dir')).toBeUndefined();
    });
  });
});
