import { describe, it, expect } from 'vitest';
import type { Statement } from '../../rdf/types';
import {
  PAGE_SLUG, PAGE_SECTION, PAGE_STATUS, PAGE_TEMPLATE, PAGE_DATE, PAGE_BODY, PAGE_CATEGORY, PAGE_COVER,
  buildSitePages,
} from '../../rdf/page';
import { importMarkdownSite } from '../markdown-site-import';

const RDF_TYPE   = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const WEBPAGE    = 'urn:kbase:type/WebPage';

// ── Made-up posts (generic topics; no real company, client or person names). ──

const FULL_POST = `---
title: Choosing a backup strategy
date: 2026-01-10T10:00
excerpt: A practical look at what to back up and how often.
categories:
  - categoryName: Technology
  - categoryName: Reliability
coverImage: /images/backup-cover.jpg
---

# Choosing a backup strategy

Backups fail when nobody has tested a restore.

The rule of thumb: three copies, two media, one off-site.
`;

const TAGS_POST = `---
title: Rotating garden beds
date: 2025-09-02
tags:
  - alpha
  - beta
---

Move each crop to a new bed each season.
`;

const UNTITLED_POST = `---
date: 2025-05-05
---

An untitled draft that should be skipped.
`;

const BAD_DATE_POST = `---
title: A sourdough primer
date: soon
---

Feed the starter before you bake.
`;

const SCRIPT_POST = `---
title: Notes on static sites
date: 2025-03-01
---

# Notes

<script>alert('x')</script>

Some more body.
`;

const NOTES_POST = `---
title: A field note
date: 2025-06-15
---

Something noted.
`;

// ── Helpers ──

function litValue(statements: Statement[], subject: string, predicate: string): string | undefined {
  const s = statements.find((st) => st.s.kind === 'iri' && st.s.value === subject && st.p.value === predicate);
  return s && s.o.kind === 'literal' ? s.o.value : undefined;
}

function lits(statements: Statement[], subject: string, predicate: string): string[] {
  return statements
    .filter((st) => st.s.kind === 'iri' && st.s.value === subject && st.p.value === predicate && st.o.kind === 'literal')
    .map((st) => (st.o as { value: string }).value);
}

describe('importMarkdownSite — a full post', () => {
  const files = { 'posts/choosing-a-backup-strategy.md': FULL_POST };
  const result = importMarkdownSite(files);
  const subject = 'urn:kbase:concept/choosing-a-backup-strategy';

  it('produces exactly one WebPage entity and no warnings', () => {
    expect(result.pages).toBe(1);
    expect(result.warnings).toEqual([]);
    const webpages = result.statements
      .filter((s) => s.p.value === RDF_TYPE && s.o.kind === 'iri' && s.o.value === WEBPAGE)
      .map((s) => s.s.value);
    expect(webpages).toEqual([subject]);
  });

  it('maps slug from the file name, an ISO date from a datetime, and default draft/post', () => {
    expect(litValue(result.statements, subject, PAGE_SLUG)).toBe('choosing-a-backup-strategy');
    expect(litValue(result.statements, subject, PAGE_DATE)).toBe('2026-01-10');
    expect(litValue(result.statements, subject, PAGE_STATUS)).toBe('draft');
    expect(litValue(result.statements, subject, PAGE_TEMPLATE)).toBe('post');
  });

  it('emits one PAGE_CATEGORY per `- categoryName:` object and one PAGE_COVER', () => {
    expect(lits(result.statements, subject, PAGE_CATEGORY).sort()).toEqual(['Reliability', 'Technology']);
    expect(lits(result.statements, subject, PAGE_COVER)).toEqual(['/images/backup-cover.jpg']);
  });

  it('keeps the body text', () => {
    expect(litValue(result.statements, subject, PAGE_BODY)).toContain('three copies, two media, one off-site.');
  });
});

describe('importMarkdownSite — a `tags:` list of plain items becomes categories', () => {
  const files = { 'posts/rotating-garden-beds.md': TAGS_POST };
  const result = importMarkdownSite(files);
  const subject = 'urn:kbase:concept/rotating-garden-beds';

  it('maps each plain list item to a PAGE_CATEGORY', () => {
    expect(result.pages).toBe(1);
    expect(lits(result.statements, subject, PAGE_CATEGORY).sort()).toEqual(['alpha', 'beta']);
  });
});

describe('importMarkdownSite — a post with no title is skipped', () => {
  const result = importMarkdownSite({ 'posts/untitled.md': UNTITLED_POST });

  it('imports nothing and warns with the file name', () => {
    expect(result.pages).toBe(0);
    expect(result.statements).toEqual([]);
    expect(result.warnings.some((w) => w.includes('untitled.md'))).toBe(true);
  });
});

describe('importMarkdownSite — a bad date emits no date but keeps the post', () => {
  const result = importMarkdownSite({ 'posts/sourdough.md': BAD_DATE_POST });
  const subject = 'urn:kbase:concept/sourdough';

  it('emits no PAGE_DATE and records a warning naming the file', () => {
    expect(result.pages).toBe(1);
    expect(litValue(result.statements, subject, PAGE_DATE)).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('sourdough.md') && w.includes('date'))).toBe(true);
  });
});

describe('importMarkdownSite — a non-markdown body line is warned about, not dropped', () => {
  const result = importMarkdownSite({ 'posts/static-sites.md': SCRIPT_POST });
  const subject = 'urn:kbase:concept/static-sites';

  it('still imports the page and warns with file + line number', () => {
    expect(result.pages).toBe(1);
    expect(litValue(result.statements, subject, PAGE_BODY)).toContain('Some more body.');
    const w = result.warnings.find((x) => x.includes('static-sites.md'));
    expect(w).toBeDefined();
    expect(/static-sites\.md:\d+/.test(w!)).toBe(true);
  });
});

describe('importMarkdownSite — opts override reach the emitted page', () => {
  const result = importMarkdownSite({ 'notes/my-note.md': NOTES_POST }, { status: 'published', section: 'notes' });
  const subject = 'urn:kbase:concept/my-note';

  it('stamps the overridden status and section onto the page', () => {
    expect(litValue(result.statements, subject, PAGE_STATUS)).toBe('published');
    expect(litValue(result.statements, subject, PAGE_SECTION)).toBe('notes');
  });
});

describe('importMarkdownSite — round trip through buildSitePages', () => {
  const result = importMarkdownSite({
    'posts/choosing-a-backup-strategy.md': FULL_POST,
    'posts/rotating-garden-beds.md': TAGS_POST,
  });
  const pages = buildSitePages(result.statements);

  it('returns the pages with the right slug, title, date, template and status', () => {
    expect(pages).toHaveLength(2);
    const backup = pages.find((p) => p.slug === 'choosing-a-backup-strategy')!;
    expect(backup.title).toBe('Choosing a backup strategy');
    expect(backup.date).toBe('2026-01-10');
    expect(backup.template).toBe('post');
    expect(backup.status).toBe('draft');

    const garden = pages.find((p) => p.slug === 'rotating-garden-beds')!;
    expect(garden.title).toBe('Rotating garden beds');
    expect(garden.date).toBe('2025-09-02');
    expect(garden.section).toBe('blog');
  });
});
