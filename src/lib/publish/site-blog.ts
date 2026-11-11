/**
 * Blog for a site repository (F274.4.2) — pages under content/blog/ become posts.
 *
 *   content/blog/*.md   → posts (template post, section blog) whatever their frontmatter says
 *   /blog/              → the blog index: published posts newest first, date + excerpt + cover
 *   /blog/category/<c>/ → one page per category, listing only its posts
 *   references-note     → frontmatter key; the note renders under the post
 *   categories, coverImage, references-note are read by markdown-site-import's frontmatter parser
 *   (the same one the old-site importer uses), not a second parser.
 *
 * COVER RULE (decided 2026-11-10, written in kb:downstream-site-blog): a cover path resolves
 * against /assets/. "/images/x.jpg" and "images/x.jpg" both mean <site>/assets/images/x.jpg, served
 * at /assets/images/x.jpg; a path that already starts with "assets/" is left as is. The build fails
 * loudly when a rendered post's cover resolves to no file (`missingCovers`), and on an external URL
 * (the generated CSP only allows same-origin images) or a path with "..".
 *
 * This module is pure (triples in, html out); the generator only calls the SiteExtension hooks.
 * Existence of cover files is checked by site-build.ts, which owns the file system.
 */
import { marked } from 'marked';
import type { Statement } from '../rdf/types';
import { iri, lit } from '../rdf/types';
import { PAGE_CATEGORY, PAGE_COVER, slugify, sitePosts, type SitePage } from '../rdf/page';
import { escapeHtml, type ExtraPage, type SiteExtension } from './site-generator';
import { importSitePages, parsePageFile, type ParsedPageFile } from './site-import';
import { parsePostMeta } from './markdown-site-import';
import { localImageUrl, sanitizePageHtml } from './output-policy';

/** Page predicate for the references note (a literal on the post). */
export const PAGE_REFERENCES_NOTE = 'urn:reckons:page/references-note';

const BLOG_DIR = 'content/blog/';
const SOURCE_ID = 'site-import';

/** True when a content file path (content/<rel>.md) is a blog post by location. */
export function isBlogPath(path: string): boolean {
  return path.startsWith(BLOG_DIR) && path.endsWith('.md') && !path.slice(BLOG_DIR.length).includes('/');
}

/**
 * Resolve a frontmatter cover path to the site-relative file it must be (assets/...). Throws
 * a message naming the cover when it cannot be a local file.
 */
export function resolveCoverPath(raw: string): string {
  const v = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('//')) {
    throw new Error('cover image "' + raw + '" is an external URL; covers must be files under assets/ (the page CSP blocks other origins)');
  }
  const rel = v.replace(/^\/+/, '');
  if (rel === '' || rel.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new Error('cover image "' + raw + '" is not a clean path under assets/');
  }
  const resolved = rel.startsWith('assets/') ? rel : 'assets/' + rel;
  if (localImageUrl('/' + resolved) === null) {
    throw new Error('cover image "' + raw + '" is not a usable image path (no whitespace or control characters)');
  }
  return resolved;
}

/**
 * Parse the content map into WebPage triples for the whole site, treating content/blog/*.md as
 * posts, and append the blog predicates (category, cover, references note).
 * Replaces site-import's importSiteFiles for a site build; every other file is imported unchanged.
 */
export function importSiteWithBlog(files: Record<string, string>): Statement[] {
  const entries = Object.entries(files)
    .filter(([path]) => path.startsWith('content/') && path.endsWith('.md'));
  const parsed: ParsedPageFile[] = [];
  const posts: Array<{ slug: string; meta: ReturnType<typeof parsePostMeta> }> = [];
  for (const [path, source] of entries) {
    const page = parsePageFile(source);
    if (isBlogPath(path)) {
      page.template = 'post';
      if (!page.section) page.section = 'blog';
      posts.push({ slug: page.slug, meta: parsePostMeta(source) });
    }
    parsed.push(page);
  }

  const stmts = importSitePages(parsed, { sourceId: SOURCE_ID });
  const g = iri('urn:kbase:source/' + SOURCE_ID);
  const now = Date.now();
  let n = stmts.length;
  const add = (slug: string, predicate: string, value: string): void => {
    n += 1;
    stmts.push({
      id: SOURCE_ID + '-' + n, s: iri('urn:kbase:concept/' + slug), p: iri(predicate), o: lit(value),
      g, sourceId: SOURCE_ID, confidence: 1, status: 'confirmed', createdAt: now, updatedAt: now,
    });
  };
  for (const { slug, meta } of posts) {
    for (const c of meta.categories) add(slug, PAGE_CATEGORY, c);
    if (meta.coverImage) add(slug, PAGE_COVER, meta.coverImage);
    if (meta.referencesNote) add(slug, PAGE_REFERENCES_NOTE, meta.referencesNote);
  }
  return stmts;
}

export interface BlogExtension extends SiteExtension {
  /** Site-relative cover files (assets/...) of the posts that were rendered, sorted. Valid after generateStaticSite. */
  requiredCovers(): Array<{ post: string; cover: string; file: string }>;
}

interface PostMeta {
  categories: string[];
  cover: string | null;
  note: string | null;
}

function postMetaFromStatements(stmts: Statement[]): Map<string, PostMeta> {
  const meta = new Map<string, PostMeta>();
  const get = (iriValue: string): PostMeta => {
    let m = meta.get(iriValue);
    if (!m) meta.set(iriValue, (m = { categories: [], cover: null, note: null }));
    return m;
  };
  for (const s of stmts) {
    if (s.status === 'rejected' || s.status === 'superseded' || s.s.kind !== 'iri' || s.o.kind !== 'literal') continue;
    if (s.p.value === PAGE_CATEGORY) get(s.s.value).categories.push(s.o.value);
    else if (s.p.value === PAGE_COVER) get(s.s.value).cover = s.o.value;
    else if (s.p.value === PAGE_REFERENCES_NOTE) get(s.s.value).note = s.o.value;
  }
  return meta;
}

const BLOG_CSS = [
  '.draft-banner{background:var(--surface);border:1px dashed var(--accent);color:var(--accent);padding:.4rem .75rem;border-radius:6px;font-size:.85rem}',
  '.badge-draft{display:inline-block;border:1px solid var(--accent);color:var(--accent);border-radius:4px;padding:0 .35rem;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;margin-left:.4rem}',
  '.post-list{list-style:none;margin:0;padding:0;display:grid;gap:1.25rem}',
  '.post-card{display:flex;gap:1rem;padding:1rem;border:1px solid var(--line);border-radius:10px;background:var(--surface)}',
  '.post-card img{width:160px;height:110px;object-fit:cover;border-radius:6px;flex:0 0 160px}',
  '.post-card h2{margin:.1rem 0 .25rem;font-size:1.15rem}.post-card p{margin:.25rem 0}',
  '.post-cover{display:block;width:100%;height:auto;max-height:420px;object-fit:contain}',
  '.post-categories{list-style:none;display:flex;flex-wrap:wrap;gap:.4rem;margin:.25rem 0;padding:0}',
  '.post-categories a{border:1px solid var(--line);border-radius:999px;padding:0 .6rem;font-size:.8rem;color:var(--muted)}',
  '.references-note{margin-top:2.5rem;padding-top:1rem;border-top:1px solid var(--line);color:var(--muted);font-size:.92rem}',
  '.references-note h2{font-size:1rem;margin:.2rem 0 .5rem}',
  '@media(max-width:720px){.post-card{flex-direction:column}.post-card img{width:100%;flex:none;height:auto;max-height:200px}}',
].join('\n');

/**
 * Build the blog's generator hooks from the site triples (pass the same triples to
 * generateStaticSite). A site with no post pages gets hooks that add nothing.
 */
export function createBlogExtension(stmts: Statement[]): BlogExtension {
  const meta = postMetaFromStatements(stmts);
  let rendered: SitePage[] = [];
  const metaOf = (p: SitePage): PostMeta => meta.get(p.iri) ?? { categories: [], cover: null, note: null };
  const isPost = (p: SitePage): boolean => p.template === 'post';
  // Posts that show up in listings: published ones (and drafts, only because the generator
  // included them for a local preview). `unlisted` stays reachable by URL but is not listed.
  const listed = (pages: SitePage[]): SitePage[] => sitePosts(pages).filter((p) => p.status !== 'unlisted');
  const postUrl = (p: SitePage): string => '/' + (p.section ? slugify(p.section) + '/' : '') + p.slug + '/';
  const coverUrl = (p: SitePage): string | null => {
    const c = metaOf(p).cover;
    return c ? '/' + resolveCoverPath(c) : null;
  };
  const chips = (p: SitePage): string => {
    const cats = metaOf(p).categories;
    if (cats.length === 0) return '';
    return '<ul class="post-categories">' +
      cats.map((c) => `<li><a href="/blog/category/${slugify(c)}/">${escapeHtml(c)}</a></li>`).join('') + '</ul>';
  };
  const draftBadge = (p: SitePage): string => (p.status === 'draft' ? '<span class="badge-draft">Draft</span>' : '');
  const card = (p: SitePage): string => {
    const cover = coverUrl(p);
    return `<li class="post-card">${cover ? `<img src="${escapeHtml(cover)}" alt="" loading="lazy">` : ''}<div>` +
      `<h2><a href="${postUrl(p)}">${escapeHtml(p.title)}</a>${draftBadge(p)}</h2>` +
      (p.date ? `<time class="date" datetime="${escapeHtml(p.date)}">${escapeHtml(p.date)}</time>` : '') +
      (p.excerpt ? `<p>${escapeHtml(p.excerpt)}</p>` : '') + chips(p) + '</div></li>';
  };
  const list = (posts: SitePage[]): string =>
    posts.length === 0 ? '<p>No posts yet.</p>' : `<ul class="post-list">${posts.map(card).join('')}</ul>`;

  return {
    preparePages(pages) {
      rendered = pages;
      // Posts page through the listed ones by date, not by file name: prev = older, next = newer.
      const ordered = listed(pages);
      const idx = new Map(ordered.map((p, i) => [p.iri, i]));
      return pages.map((p) => {
        if (!isPost(p)) return p;
        const i = idx.get(p.iri);
        if (i === undefined) return { ...p, prev: null, next: null };
        return { ...p, prev: ordered[i + 1]?.iri ?? null, next: ordered[i - 1]?.iri ?? null };
      });
    },
    hiddenFromNav: isPost,
    navLinks() {
      return listed(rendered).length > 0 ? [{ href: '/blog/', label: 'Blog' }] : [];
    },
    beforeBody(page) {
      if (!isPost(page)) return '';
      const cover = coverUrl(page);
      return chips(page) + (cover ? `<img class="post-cover" src="${escapeHtml(cover)}" alt="">` : '');
    },
    afterBody(page) {
      const note = isPost(page) ? metaOf(page).note : null;
      if (!note) return '';
      return '<aside class="references-note"><h2>References</h2>' + sanitizePageHtml(marked.parse(note) as string) + '</aside>';
    },
    extraPages(pages) {
      const posts = listed(pages);
      if (pages.filter(isPost).length === 0) return [];
      const out: ExtraPage[] = [{
        path: 'blog/index.html', title: 'Blog', description: 'Posts, newest first.', html: list(posts),
      }];
      const byCategory = new Map<string, { label: string; posts: SitePage[] }>();
      for (const p of posts) {
        for (const c of metaOf(p).categories) {
          const key = slugify(c);
          const entry = byCategory.get(key) ?? { label: c, posts: [] };
          if (!entry.posts.includes(p)) entry.posts.push(p);
          byCategory.set(key, entry);
        }
      }
      for (const [key, entry] of [...byCategory].sort(([a], [b]) => a.localeCompare(b))) {
        out.push({
          path: 'blog/category/' + key + '/index.html',
          title: 'Category: ' + entry.label,
          description: 'Posts in the ' + entry.label + ' category.',
          html: '<p><a href="/blog/">All posts</a></p>' + list(entry.posts),
        });
      }
      return out;
    },
    css: () => BLOG_CSS,
    rootRedirect: () => (rendered.some(isPost) ? '/blog/' : null),
    requiredCovers() {
      return rendered
        .filter(isPost)
        .flatMap((p) => {
          const c = metaOf(p).cover;
          return c ? [{ post: p.slug, cover: c, file: resolveCoverPath(c) }] : [];
        })
        .sort((a, b) => a.post.localeCompare(b.post));
    },
  };
}
