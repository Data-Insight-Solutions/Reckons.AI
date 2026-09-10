/**
 * The shape of the published docs, asserted against the generated files themselves.
 *
 * WHY THESE EXIST. Every failure this file pins was invisible to all six align gates, because the
 * gates check that content/ matches what the generator produces — not that what the generator
 * produces is worth reading. A generator can be perfectly self-consistent and still emit 138 pages
 * of one sentence, a link to a file it just deleted, or a hierarchy it silently stopped building.
 *
 * Each assertion below is a bug that actually shipped on 2026-09-06, not a hypothetical.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve, relative } from 'path';

const ROOT = resolve(import.meta.dirname ?? '.', '..', '..');
const CONTENT_DIR = join(ROOT, 'content');

/** Only the sections docs-pages.ts generates; content/ also holds hand-authored trees. */
const GENERATED_TAG = 'docs-kb';

interface Page { file: string; slug: string; frontmatter: string; body: string }

function loadGeneratedPages(): Page[] {
  const out: Page[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const raw = readFileSync(full, 'utf8');
        if (!raw.startsWith('---')) continue;
        const end = raw.indexOf('\n---', 3);
        const frontmatter = raw.slice(3, end);
        if (!frontmatter.includes(GENERATED_TAG)) continue;
        out.push({
          file: relative(ROOT, full),
          slug: relative(CONTENT_DIR, full).replace(/\.md$/, ''),
          frontmatter,
          body: raw.slice(end + 4),
        });
      }
    }
  };
  walk(CONTENT_DIR);
  return out;
}

const pages = loadGeneratedPages();

/** Prose a reader actually reads: not headings, not bold predicate labels, not the SVG. */
function proseWords(body: string): number {
  const withoutDiagrams = body.replace(/<figure class="diagram"[\s\S]*?<\/figure>/g, '');
  return withoutDiagrams
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !/^\*\*[^*]+\*\*$/.test(l) && !l.startsWith('>'))
    .reduce((n, l) => n + l.split(/\s+/).length, 0);
}

describe('the generated docs are pages, not stubs', () => {
  it('generated something at all — a silent zero would make every other assertion vacuous', () => {
    expect(pages.length).toBeGreaterThan(50);
  });

  /**
   * MEASURED BEFORE THE FIX: 138 of 316 pages (43%) carried under 40 words, and nine under 20.
   * `content/features/entity-types.md` was a title and one sentence — a paragraph that had been
   * given a URL, a sidebar entry and a back-link, so a reader paid a navigation step for one line.
   * Thin entities are folded into their parent as a section now (see earnsPage in docs-pages.ts).
   *
   * The threshold is deliberately loose: some entities are genuinely short and have no parent to
   * fold into (a person, an organization). This asserts the SHAPE — stubs are the exception — not
   * a floor on every page.
   */
  it('does not publish a page per one-sentence entity', () => {
    const thin = pages.filter((p) => proseWords(p.body) < 40);
    expect(thin.length / pages.length).toBeLessThan(0.25);
  });

  it('has no page that is only a title', () => {
    const empty = pages.filter((p) => proseWords(p.body) < 12).map((p) => p.file);
    expect(empty).toEqual([]);
  });
});

describe('every generated link goes somewhere', () => {
  const slugs = new Set(pages.map((p) => p.slug));

  /**
   * Folding thin entities into their parents deletes files, and a reference written by an author
   * still points at the entity. Resolved through the fold (hostPageOf) so it lands on the page
   * that now CONTAINS the content — but nothing except this test would notice if it stopped.
   */
  it('body links resolve to a page that exists', () => {
    const dead: string[] = [];
    for (const p of pages) {
      for (const m of p.body.matchAll(/\]\(\.\.\/([a-z0-9-]+\/[a-z0-9-]+)\)/g)) {
        if (!slugs.has(m[1])) dead.push(`${p.file} -> ${m[1]}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it('frontmatter `related` names a page that exists', () => {
    const dead: string[] = [];
    const bySlugTail = new Set([...slugs].map((s) => s.split('/')[1]));
    for (const p of pages) {
      for (const m of p.frontmatter.matchAll(/^\s+- "([a-z0-9-]+)"$/gm)) {
        if (!bySlugTail.has(m[1])) dead.push(`${p.file} -> ${m[1]}`);
      }
    }
    expect(dead).toEqual([]);
  });
});

describe('structural predicates are read, never shown', () => {
  /**
   * `part-of` and `step-order` cannot be dropped at extraction time: the first is how a child
   * finds its parent, the second is how steps are ordered. Removing them from the data unbuilds
   * the hierarchy while every gate keeps passing — which is exactly what happened for one run on
   * 2026-09-06, and the only visible symptom was that a page's Steps section quietly vanished.
   * So they are excluded at RENDER time, and both halves are asserted here.
   */
  it('never prints the sort key or a back-link at a reader', () => {
    const leaked = pages.filter((p) => /^\*\*(Step Order|Part Of)\*\*$/m.test(p.body));
    expect(leaked.map((p) => p.file)).toEqual([]);
  });

  it('still builds the hierarchy those predicates drive', () => {
    // If part-of stopped reaching the indexer, no page would carry a Steps section at all.
    const withSteps = pages.filter((p) => /^## Steps$/m.test(p.body));
    expect(withSteps.length).toBeGreaterThan(0);
  });
});

describe('the page reads as a document', () => {
  it('does not print a heading and then repeat it as a label', () => {
    // "## Related" followed by "**Related**" appeared on 87 pages.
    const doubled = pages.filter((p) => /## Related\n\n\*\*Related\*\*/.test(p.body));
    expect(doubled.map((p) => p.file)).toEqual([]);
  });

  it('puts a lifecycle banner above the prose, never below it', () => {
    // kb:honest-status: a reader must learn the thing is unbuilt before reading it described.
    for (const p of pages) {
      const banner = p.body.search(/^> \*\*(Speculative|Planned|In progress|Scaffolded)\*\*/m);
      if (banner === -1) continue;
      const firstHeading = p.body.search(/^## /m);
      if (firstHeading === -1) continue;
      expect(banner).toBeLessThan(firstHeading);
    }
  });
});
