import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Statement } from '../../rdf/types';
import { iri, lit } from '../../rdf/types';
import {
  PAGE_SLUG, PAGE_SECTION, PAGE_STATUS, PAGE_TEMPLATE, PAGE_BODY, PAGE_EXCERPT,
  buildSitePages,
} from '../../rdf/page';
import { NAV_ORDER } from '../../rdf/hierarchy';
import { buildSiteFiles } from '../site-export';
import { parsePageFile, importSitePages, importSiteFiles } from '../site-import';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SKOS_BROADER = 'http://www.w3.org/2004/02/skos/core#broader';
const SKOS_RELATED = 'http://www.w3.org/2004/02/skos/core#related';
const WEBPAGE = 'urn:kbase:type/WebPage';

let _id = 0;
function st(s: string, p: string, o: string, oIsIri = false): Statement {
  return {
    id: `s-${++_id}`, s: iri(s), p: iri(p), o: oIsIri ? iri(o) : lit(o),
    g: iri('urn:kbase:source/test'), sourceId: 'test', confidence: 1,
    status: 'confirmed', createdAt: 0, updatedAt: 0,
  };
}

function sampleSite(): Statement[] {
  return [
    st('page:overview', RDF_TYPE, WEBPAGE, true),
    st('page:overview', RDFS_LABEL, 'Overview'),
    st('page:overview', PAGE_SLUG, 'overview'),
    st('page:overview', PAGE_SECTION, 'Docs'),
    st('page:overview', NAV_ORDER, '1'),
    st('page:overview', PAGE_STATUS, 'published'),
    st('page:overview', PAGE_TEMPLATE, 'landing'),
    st('page:overview', PAGE_BODY, '# Overview\n\nWelcome to the docs.'),

    st('page:install', RDF_TYPE, WEBPAGE, true),
    st('page:install', RDFS_LABEL, 'Install'),
    st('page:install', PAGE_SLUG, 'install'),
    st('page:install', PAGE_SECTION, 'Docs'),
    st('page:install', NAV_ORDER, '2'),
    st('page:install', PAGE_STATUS, 'published'),
    st('page:install', SKOS_BROADER, 'page:overview', true),
    st('page:install', SKOS_RELATED, 'page:overview', true),

    st('page:root', RDF_TYPE, WEBPAGE, true),
    st('page:root', RDFS_LABEL, 'Root'),
    st('page:root', PAGE_SLUG, 'root'),
    st('page:root', PAGE_STATUS, 'unlisted'),
    st('page:root', PAGE_EXCERPT, 'A "quoted" excerpt with a \\backslash\\.'),

    // draft — excluded from a default publish, so it never round-trips through content/
    st('page:secret', RDF_TYPE, WEBPAGE, true),
    st('page:secret', RDFS_LABEL, 'Secret'),
    st('page:secret', PAGE_STATUS, 'draft'),
  ];
}

/** Only the content/*.md entries — graph.json/admin are regenerated, not round-tripped. */
function mdFiles(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).filter(([path]) => path.endsWith('.md')));
}

describe('parsePageFile', () => {
  it('parses frontmatter fields and preserves the body exactly', () => {
    const pages = buildSitePages(sampleSite());
    const overview = pages.find((p) => p.slug === 'overview')!;
    const files = buildSiteFiles(sampleSite(), { repo: 'me/site' });
    const parsed = parsePageFile(files['content/docs/overview.md']);

    expect(parsed.title).toBe('Overview');
    expect(parsed.slug).toBe('overview');
    expect(parsed.order).toBe(1);
    expect(parsed.section).toBe('Docs');
    expect(parsed.template).toBe('landing');
    expect(parsed.status).toBe('published');
    expect(parsed.parentSlug).toBeNull();
    expect(parsed.body).toBe(overview.body);
  });

  it('round-trips escaped quotes/backslashes in a quoted scalar', () => {
    const files = buildSiteFiles(sampleSite(), { includeDrafts: true });
    const parsed = parsePageFile(files['content/root.md']);
    expect(parsed.excerpt).toBe('A "quoted" excerpt with a \\backslash\\.');
  });

  it('resolves parent + related frontmatter slugs', () => {
    const files = buildSiteFiles(sampleSite(), { repo: 'me/site' });
    const parsed = parsePageFile(files['content/docs/install.md']);
    expect(parsed.parentSlug).toBe('overview');
    expect(parsed.relatedSlugs).toEqual(['overview']);
  });

  it('falls back to defaults for a file with no frontmatter', () => {
    const parsed = parsePageFile('just a body, no frontmatter\n');
    expect(parsed.title).toBe('');
    expect(parsed.template).toBe('doc');
    expect(parsed.status).toBe('draft');
    expect(parsed.nav).toBe('sidebar');
    expect(parsed.body).toBe('just a body, no frontmatter\n');
  });
});

describe('importSitePages / importSiteFiles', () => {
  it('reconstructs WebPage type, metadata, skos:broader and skos:related', () => {
    const files = buildSiteFiles(sampleSite(), { repo: 'me/site' });
    const imported = importSiteFiles(files);
    const pages = buildSitePages(imported);

    const install = pages.find((p) => p.slug === 'install')!;
    const overview = pages.find((p) => p.slug === 'overview')!;
    expect(install.parent).toBe(overview.iri);
    expect(install.related).toEqual([overview.iri]);
    expect(install.section).toBe('Docs');
    expect(install.order).toBe(2);
    expect(install.status).toBe('published');
  });

  it('ignores non-content-markdown entries (graph.json, admin/*)', () => {
    const files = buildSiteFiles(sampleSite(), { repo: 'me/site' });
    expect(Object.keys(files)).toContain('graph.json');
    expect(Object.keys(files)).toContain('admin/config.yml');
    const imported = importSiteFiles(files);
    // overview + install + root are published/unlisted; secret (draft) and
    // graph.json/admin.* must not leak in as WebPage subjects.
    const subjects = new Set(
      imported.filter((s) => s.p.value === RDF_TYPE).map((s) => (s.s.kind === 'iri' ? s.s.value : '')),
    );
    expect(subjects.size).toBe(3);
  });

  it('assigns nav:next/prev between true siblings, ordered by nav:order', () => {
    const stmts: Statement[] = [
      st('page:a', RDF_TYPE, WEBPAGE, true), st('page:a', RDFS_LABEL, 'A'),
      st('page:a', PAGE_SLUG, 'a'), st('page:a', PAGE_STATUS, 'published'), st('page:a', NAV_ORDER, '1'),
      st('page:b', RDF_TYPE, WEBPAGE, true), st('page:b', RDFS_LABEL, 'B'),
      st('page:b', PAGE_SLUG, 'b'), st('page:b', PAGE_STATUS, 'published'), st('page:b', NAV_ORDER, '2'),
      st('page:c', RDF_TYPE, WEBPAGE, true), st('page:c', RDFS_LABEL, 'C'),
      st('page:c', PAGE_SLUG, 'c'), st('page:c', PAGE_STATUS, 'published'), st('page:c', NAV_ORDER, '3'),
    ];
    const files = buildSiteFiles(stmts);
    const imported = importSitePages([
      parsePageFile(files['content/a.md']),
      parsePageFile(files['content/b.md']),
      parsePageFile(files['content/c.md']),
    ]);
    const pages = buildSitePages(imported);
    const a = pages.find((p) => p.slug === 'a')!;
    const b = pages.find((p) => p.slug === 'b')!;
    const c = pages.find((p) => p.slug === 'c')!;
    expect(a.next).toBe(b.iri);
    expect(b.prev).toBe(a.iri);
    expect(b.next).toBe(c.iri);
    expect(c.prev).toBe(b.iri);
  });
});

describe('round-trip idempotency (export → import → export)', () => {
  it('re-exported markdown matches the original for every published page', () => {
    const original = buildSiteFiles(sampleSite(), { repo: 'me/site', branch: 'main' });
    const imported = importSiteFiles(original);
    const reExported = buildSiteFiles(imported, { repo: 'me/site', branch: 'main' });

    expect(mdFiles(reExported)).toEqual(mdFiles(original));
  });

  it('round-trips with drafts included too', () => {
    const original = buildSiteFiles(sampleSite(), { includeDrafts: true, includeAdmin: false });
    const imported = importSiteFiles(original);
    const reExported = buildSiteFiles(imported, { includeDrafts: true, includeAdmin: false });

    expect(mdFiles(reExported)).toEqual(mdFiles(original));
  });

  it('round-trips the shipped content/docs/welcome.md unchanged', () => {
    const path = resolve(import.meta.dirname, '../../../../content/docs/welcome.md');
    const original = readFileSync(path, 'utf8');
    const imported = importSitePages([parsePageFile(original)]);
    const pages = buildSitePages(imported);
    expect(pages).toHaveLength(1);

    const files = buildSiteFiles(imported, {});
    expect(files['content/docs/welcome.md']).toBe(original);
  });
});
