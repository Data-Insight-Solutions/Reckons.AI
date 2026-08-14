/**
 * Post authoring (F27) — the write side.
 *
 * The property that matters most is the ROUND TRIP: statements this module writes must come back
 * out of `buildSitePages` unchanged and render through `pageToMarkdown` to the path
 * `contentPath` predicts. A writer and a reader that disagree produce a post that exists in the
 * graph and never appears on the site — the exact failure mode this pipeline already had in the
 * other direction, where the whole publish module had no caller at all.
 *
 * The validation tests are about a narrower thing: every rejected draft here is one that would
 * otherwise have produced a page that LOOKS like it worked — a post at the wrong path, dated a
 * day that does not exist, or silently overwriting another post's file on export.
 */
import { describe, it, expect } from 'vitest';
import {
  buildPostStatements, validatePostDraft, takenSlugs, slugKey, todayIso,
  PostDraftError, AUTHORED_POST_NS, type PostDraft,
} from '../post-authoring';
import { buildSitePages, publishablePages, sitePosts } from '$lib/rdf/page';
import { contentPath, pageToMarkdown } from '../site-export';

const draft = (over: Partial<PostDraft> = {}): PostDraft => ({
  title: 'Shipping the Archive Sweep',
  section: 'Releases',
  date: '2026-07-30',
  excerpt: 'How F97 finally got an entry point.',
  body: '# Shipping\n\nThe storage layer existed for weeks with no caller.',
  ...over,
});

/** Deterministic ids so a round trip can be asserted exactly. */
let n = 0;
const build = (d: PostDraft, opts = {}) =>
  buildPostStatements(d, { now: () => 1_700_000_000_000, newId: () => `id-${n++}`, ...opts });

describe('validation refuses drafts that would look like they worked', () => {
  it('accepts a complete draft', () => {
    const v = validatePostDraft(draft());
    expect(v.ok).toBe(true);
    expect(v.problems).toEqual([]);
    expect(v.resolvedSlug).toBe('shipping-the-archive-sweep');
  });

  it('reports every problem at once, not just the first', () => {
    const v = validatePostDraft({ title: '', section: '', date: 'yesterday', excerpt: '', body: '' });
    expect(v.ok).toBe(false);
    // A form that reveals its objections one at a time gets filled in wrong four times.
    expect(v.problems.map((p) => p.field).sort()).toEqual(['body', 'date', 'section', 'slug', 'title']);
  });

  it('rejects a date that passes the regex but never happened', () => {
    // `new Date('2026-02-30')` rolls over to 2 March rather than failing, so a regex alone would
    // publish a post dated a day that does not exist.
    const v = validatePostDraft(draft({ date: '2026-02-30' }));
    expect(v.ok).toBe(false);
    expect(v.problems).toContainEqual({ field: 'date', message: '2026-02-30 is not a real date.' });
  });

  it('accepts a real leap day and rejects a fake one', () => {
    expect(validatePostDraft(draft({ date: '2024-02-29' })).ok).toBe(true);
    expect(validatePostDraft(draft({ date: '2026-02-29' })).ok).toBe(false);
  });

  it('derives the slug from the title when none is given', () => {
    expect(validatePostDraft(draft({ title: 'Why Graphs Beat Docs' })).resolvedSlug)
      .toBe('why-graphs-beat-docs');
  });

  it('reports a title that produces no usable slug', () => {
    // slugify never returns empty — it falls back to the literal "page", so every
    // punctuation-only title would silently land at content/<section>/page.md.
    const v = validatePostDraft(draft({ title: '!!! ???' }));
    expect(v.problems.some((p) => p.field === 'slug')).toBe(true);
  });

  it('still allows a slug of "page" when the author actually typed it', () => {
    expect(validatePostDraft(draft({ slug: 'page' })).ok).toBe(true);
    expect(validatePostDraft(draft({ slug: 'page' })).resolvedSlug).toBe('page');
  });

  it('refuses a slug that would overwrite another post on export', () => {
    // The real cost: contentPath derives the FILE from section+slug, so a collision is a silent
    // overwrite that shows up as a file with the wrong content, not as an error.
    const taken = new Set([slugKey('Releases', 'shipping-the-archive-sweep')]);
    const v = validatePostDraft(draft(), taken);
    expect(v.ok).toBe(false);
    expect(v.problems[0].message).toContain('already exists');
  });

  it('allows the same slug in a different section', () => {
    const taken = new Set([slugKey('Guide', 'shipping-the-archive-sweep')]);
    expect(validatePostDraft(draft({ section: 'Releases' }), taken).ok).toBe(true);
  });

  it('does not collide an edited post with itself', () => {
    const { statements, iri } = build(draft());
    const pages = buildSitePages(statements);
    // Editing THIS post must not report its own slug as taken.
    expect(validatePostDraft(draft(), takenSlugs(pages, iri)).ok).toBe(true);
    expect(validatePostDraft(draft(), takenSlugs(pages)).ok).toBe(false);
  });
});

describe('building the post', () => {
  it('refuses to write a partial node from an invalid draft', () => {
    // A WebPage missing its date still renders — at the wrong path, dated nothing — which is
    // worse than not existing, because it looks like it worked.
    expect(() => build(draft({ date: 'nonsense' }))).toThrow(PostDraftError);
  });

  it('carries every problem on the thrown error', () => {
    try {
      build({ title: '', section: '', date: 'x', excerpt: '', body: '' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PostDraftError);
      expect((e as PostDraftError).problems).toHaveLength(5);
    }
  });

  it('mints an IRI under the authored-post namespace', () => {
    expect(build(draft()).iri.startsWith(AUTHORED_POST_NS)).toBe(true);
  });

  it('reuses a supplied IRI so an edit replaces rather than duplicates', () => {
    const existing = `${AUTHORED_POST_NS}fixed`;
    expect(build(draft(), { iri: existing }).iri).toBe(existing);
  });

  it('omits an empty excerpt instead of storing a blank fact', () => {
    const { statements } = build(draft({ excerpt: '   ' }));
    expect(statements.some((s) => s.p.value.endsWith('/excerpt'))).toBe(false);
  });

  it('writes confirmed facts — this is the user authoring, not an agent proposing', () => {
    // F52 exists to stop machines settling facts, not to make people review their own writing.
    expect(build(draft()).statements.every((s) => s.status === 'confirmed')).toBe(true);
  });

  it('defaults a post to draft status and hidden nav', () => {
    const [page] = buildSitePages(build(draft()).statements);
    expect(page.status).toBe('draft');
    expect(page.nav).toBe('hidden');
    // A draft must not be publishable by accident.
    expect(publishablePages([page])).toEqual([]);
  });
});

describe('the round trip — writer and reader must agree', () => {
  it('comes back out of buildSitePages with every field intact', () => {
    const d = draft({ status: 'published', nav: 'menu', order: 3 });
    const { statements, iri, slug } = build(d);
    const [page] = buildSitePages(statements);

    expect(page).toMatchObject({
      iri,
      slug,
      title: d.title,
      section: 'Releases',
      template: 'post',
      status: 'published',
      nav: 'menu',
      order: 3,
      date: '2026-07-30',
      excerpt: d.excerpt,
      body: d.body,
    });
  });

  it('is recognised as a post by the reader that lists posts', () => {
    const { statements } = build(draft({ status: 'published' }));
    const pages = buildSitePages(statements);
    expect(sitePosts(pages).map((p) => p.title)).toEqual(['Shipping the Archive Sweep']);
  });

  it('lands at the content path the exporter predicts', () => {
    const { statements } = build(draft());
    const [page] = buildSitePages(statements);
    expect(contentPath(page)).toBe('content/releases/shipping-the-archive-sweep.md');
  });

  it('renders frontmatter the docs loader can read back', () => {
    const { statements } = build(draft({ status: 'published' }));
    const [page] = buildSitePages(statements);
    const md = pageToMarkdown(page, new Map([[page.iri, page.slug]]));

    expect(md).toContain('title: "Shipping the Archive Sweep"');
    // Enums are written UNQUOTED by pageToMarkdown; strings are quoted. Asserted as written,
    // because the docs loader parses this frontmatter and a quoting change would break it.
    expect(md).toContain('template: post');
    expect(md).toContain('status: published');
    expect(md).toContain('date: "2026-07-30"');
    // The body survives as body, below the frontmatter.
    expect(md).toContain('The storage layer existed for weeks with no caller.');
  });

  it('survives a body containing characters that would break YAML', () => {
    const nasty = 'A "quoted" title: with a colon\nand a second line — plus a \\backslash';
    const { statements } = build(draft({ title: 'Edge: "cases"', body: nasty }));
    const [page] = buildSitePages(statements);
    const md = pageToMarkdown(page, new Map());

    expect(md).toContain(nasty);
    // The title is escaped in frontmatter rather than terminating the YAML string early.
    expect(md).toContain('title: "Edge: \\"cases\\""');
  });
});

describe('todayIso', () => {
  it('returns the LOCAL day, so "today" means the author\'s today', () => {
    // 23:30 local on the 30th is still the 30th, even where that is the 31st in UTC.
    const local = new Date(2026, 6, 30, 23, 30).getTime();
    expect(todayIso(local)).toBe('2026-07-30');
  });

  it('produces a value its own validator accepts', () => {
    expect(validatePostDraft(draft({ date: todayIso() })).ok).toBe(true);
  });
});
