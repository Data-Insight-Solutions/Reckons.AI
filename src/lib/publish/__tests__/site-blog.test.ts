/**
 * F274.4.2 done-test — blog: index, posts, categories, cover images and a references note.
 * The done-test lives on kb:downstream-site-blog (static/reckons-roadmap.ttl):
 *
 *   Fixture with three posts (one draft, two categories): the blog index lists the two published
 *   posts newest first with excerpt and cover; each category page lists only its posts; the draft
 *   appears nowhere; a post with references-note renders the note. Unit tests pass.
 *
 * Plus the four gaps found by building the real site on 2026-11-10: categories/coverImage keys,
 * the cover path rule, a post is never the home page, and --drafts (local preview only).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertNotDraftPreview, buildSite, DRAFT_PREVIEW_MARKER } from '../site-build';
import { parsePostMeta } from '../markdown-site-import';
import { resolveCoverPath } from '../site-blog';

const FIXTURE = join(process.cwd(), 'src/lib/publish/__tests__/fixtures/fixture-blog-site');
if (!existsSync(join(FIXTURE, 'content/blog'))) throw new Error('fixture not found; run vitest from the repo root: ' + FIXTURE);

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

function writeFile(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}
const read = (out: string, rel: string): string => readFileSync(join(out, rel), 'utf8');
const post = (title: string, extra = '', status = 'published'): string =>
  '---\ntitle: "' + title + '"\nstatus: ' + status + '\ndate: "2026-01-01"\n' + extra + '---\nbody\n';

describe('blog (F274.4.2) on the three-post fixture', () => {
  it('lists the two published posts newest first with excerpt and cover, and omits the draft', () => {
    const out = tmp('blog-');
    const r = buildSite({ site: FIXTURE, out });
    const index = read(out, 'blog/index.html');
    expect(index.indexOf('Second Post')).toBeGreaterThan(-1);
    expect(index.indexOf('Second Post')).toBeLessThan(index.indexOf('First Post'));
    expect(index).toContain('The newer of the two published posts.');
    expect(index).toContain('2026-05-02');
    expect(index).toContain('src="/assets/images/blog/two.svg"');
    expect(index).toContain('src="/assets/images/blog/one.svg"');
    expect(index).not.toContain('Third Draft');
    expect(r.files).toContain('blog/first-post/index.html');
    expect(r.files).toContain('blog/second-post/index.html');
    expect(r.files).not.toContain('blog/third-draft/index.html');
  });

  it('writes one page per category listing only its posts', () => {
    const out = tmp('blog-');
    const r = buildSite({ site: FIXTURE, out });
    expect(r.files).toContain('blog/category/alpha/index.html');
    expect(r.files).toContain('blog/category/beta/index.html');
    const alpha = read(out, 'blog/category/alpha/index.html');
    expect(alpha).toContain('First Post');
    expect(alpha).not.toContain('Second Post'); // Second Post is Beta only
    expect(alpha).not.toContain('Third Draft'); // the draft is Alpha, but unpublished
    const beta = read(out, 'blog/category/beta/index.html');
    expect(beta).toContain('First Post');
    expect(beta).toContain('Second Post');
  });

  it('the draft appears in no output file', () => {
    const out = tmp('blog-');
    const r = buildSite({ site: FIXTURE, out });
    for (const rel of r.files) {
      if (!/\.(html|json|css|txt|ttl)$/.test(rel) && rel !== '_headers') continue;
      const text = read(out, rel);
      expect(text, 'draft leaked into ' + rel).not.toContain('DRAFT-SECRET-MARKER');
      expect(text, 'draft title leaked into ' + rel).not.toContain('Third Draft');
    }
  });

  it('renders the references note under the post, and only on posts that carry one', () => {
    const out = tmp('blog-');
    buildSite({ site: FIXTURE, out });
    const first = read(out, 'blog/first-post/index.html');
    expect(first).toContain('class="references-note"');
    expect(first).toContain('Checked on 2026-03-09 by the author.');
    expect(first).toContain('href="https://example.com/ref"');
    expect(first.indexOf('Body of the first post')).toBeLessThan(first.indexOf('references-note'));
    expect(read(out, 'blog/second-post/index.html')).not.toContain('references-note');
  });

  it('shows the cover and category links on the post, and pages posts by date', () => {
    const out = tmp('blog-');
    buildSite({ site: FIXTURE, out });
    const second = read(out, 'blog/second-post/index.html');
    expect(second).toContain('class="post-cover" src="/assets/images/blog/two.svg"');
    expect(second).toContain('href="/blog/category/beta/"');
    expect(second).toContain('href="/blog/first-post/"'); // prev = the older post
    expect(read(out, 'blog/first-post/index.html')).toContain('href="/blog/second-post/"'); // next = the newer
  });

  it('is deterministic: a second build is byte-identical', () => {
    const out = tmp('blog-');
    buildSite({ site: FIXTURE, out });
    const a = read(out, 'blog/index.html') + read(out, 'blog/category/beta/index.html');
    buildSite({ site: FIXTURE, out });
    expect(read(out, 'blog/index.html') + read(out, 'blog/category/beta/index.html')).toBe(a);
  });
});

describe('gap 1: categories and coverImage frontmatter', () => {
  it('parsePostMeta reads categories, tags fallback, cover and a folded references-note', () => {
    const m = parsePostMeta('---\ntitle: T\ncategories:\n  - "A"\n  - B\ncoverImage: "/x.jpg"\nreferences-note: >\n  one\n  two\n---\nbody');
    expect(m).toEqual({ categories: ['A', 'B'], coverImage: '/x.jpg', referencesNote: 'one two' });
    expect(parsePostMeta('---\ntitle: T\ntags:\n  - Z\nimage: y.png\nreferences-note: "inline"\n---\n')).toEqual({
      categories: ['Z'], coverImage: 'y.png', referencesNote: 'inline',
    });
    expect(parsePostMeta('no frontmatter')).toEqual({ categories: [], coverImage: null, referencesNote: null });
  });
});

describe('gap 2: cover paths resolve against /assets/ and fail loudly', () => {
  it('resolves with or without a leading slash, keeps an assets/ prefix', () => {
    expect(resolveCoverPath('/images/a.jpg')).toBe('assets/images/a.jpg');
    expect(resolveCoverPath('images/a.jpg')).toBe('assets/images/a.jpg');
    expect(resolveCoverPath('/assets/images/a.jpg')).toBe('assets/images/a.jpg');
  });

  it('rejects external URLs, traversal and whitespace in a path', () => {
    expect(() => resolveCoverPath('https://example.com/a.jpg')).toThrow(/external/);
    expect(() => resolveCoverPath('//cdn.example.com/a.jpg')).toThrow(/external/);
    expect(() => resolveCoverPath('../secret.jpg')).toThrow(/clean path/);
    expect(() => resolveCoverPath('/images/my cover.jpg')).toThrow(/usable/);
  });

  it('the build fails, naming the post and the file, when a cover resolves to no file', () => {
    const site = tmp('blog-site-');
    writeFile(site, 'content/blog/p.md', post('P', 'coverImage: "/images/nope.jpg"\n'));
    expect(() => buildSite({ site, out: tmp('blog-out-') })).toThrow(/p: coverImage "\/images\/nope.jpg" -> assets\/images\/nope.jpg/);
  });

  it('does not check the cover of a draft that is not built', () => {
    const site = tmp('blog-site-');
    writeFile(site, 'content/blog/ok.md', post('Ok'));
    writeFile(site, 'content/blog/d.md', post('D', 'coverImage: "/images/nope.jpg"\n', 'draft'));
    expect(() => buildSite({ site, out: tmp('blog-out-') })).not.toThrow();
  });
});

describe('gap 3: a post is never the home page', () => {
  it('a site of only posts has a root that redirects to /blog/, not a post', () => {
    const out = tmp('blog-');
    buildSite({ site: FIXTURE, out });
    const root = read(out, 'index.html');
    expect(root).toContain('url=/blog/');
    expect(root).not.toContain('Body of the second post');
    expect(root).not.toContain('class="date"');
  });

  it('with a landing page, the landing page is the home and the blog index stays at /blog/', () => {
    const site = tmp('blog-site-');
    writeFile(site, 'content/home.md', '---\ntitle: Home\nslug: home\ntemplate: landing\nstatus: published\n---\nLANDING-BODY\n');
    writeFile(site, 'content/blog/p.md', post('P'));
    const out = tmp('blog-out-');
    buildSite({ site, out });
    expect(read(out, 'index.html')).toContain('LANDING-BODY');
    expect(read(out, 'blog/index.html')).toContain('>P</a>');
    expect(read(out, 'index.html')).toContain('href="/blog/"'); // sidebar Blog link
  });

  it('a non-landing page is promoted before any post when there is no landing page', () => {
    const site = tmp('blog-site-');
    writeFile(site, 'content/about.md', '---\ntitle: About\nslug: about\nstatus: published\n---\nABOUT-BODY\n');
    writeFile(site, 'content/blog/p.md', post('P'));
    const out = tmp('blog-out-');
    buildSite({ site, out });
    expect(read(out, 'index.html')).toContain('ABOUT-BODY');
    expect(existsSync(join(out, 'blog/p/index.html'))).toBe(true);
  });

  it('posts stay out of the sidebar nav', () => {
    const out = tmp('blog-');
    buildSite({ site: FIXTURE, out });
    const nav = /<nav class="site-nav">([\s\S]*?)<\/nav>/.exec(read(out, 'blog/index.html'))?.[1] ?? '';
    expect(nav).toContain('href="/blog/"');
    expect(nav).not.toContain('First Post');
  });
});

describe('gap 4: --drafts is a local preview that cannot be deployed', () => {
  it('without the flag the draft is excluded (default)', () => {
    const out = tmp('blog-');
    buildSite({ site: FIXTURE, out });
    expect(existsSync(join(out, 'blog/third-draft/index.html'))).toBe(false);
    expect(existsSync(join(out, DRAFT_PREVIEW_MARKER))).toBe(false);
    expect(read(out, 'blog/index.html')).not.toContain('noindex');
    expect(read(out, '_headers')).not.toContain('X-Robots-Tag');
  });

  it('with the flag the draft is built, marked Draft, and every page is noindex', () => {
    const out = tmp('blog-');
    const r = buildSite({ site: FIXTURE, out, includeDrafts: true });
    expect(r.files).toContain('blog/third-draft/index.html');
    const draft = read(out, 'blog/third-draft/index.html');
    expect(draft).toContain('class="draft-banner"');
    expect(draft).toContain('<meta name="robots" content="noindex, nofollow">');
    const index = read(out, 'blog/index.html');
    expect(index).toContain('Third Draft');
    expect(index).toContain('badge-draft');
    expect(index).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(read(out, 'index.html')).toContain('noindex');
    expect(read(out, '_headers')).toContain('X-Robots-Tag: noindex, nofollow');
  });

  it('stamps the output so a deploy path refuses it, and a normal build clears the stamp', () => {
    const out = tmp('blog-');
    buildSite({ site: FIXTURE, out, includeDrafts: true });
    expect(existsSync(join(out, DRAFT_PREVIEW_MARKER))).toBe(true);
    expect(() => assertNotDraftPreview(out)).toThrow(/--drafts preview/);
    buildSite({ site: FIXTURE, out }); // replaces the output wholesale
    expect(existsSync(join(out, DRAFT_PREVIEW_MARKER))).toBe(false);
    expect(() => assertNotDraftPreview(out)).not.toThrow();
  });
});
