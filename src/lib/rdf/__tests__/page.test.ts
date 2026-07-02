import { describe, it, expect } from 'vitest';
import type { Statement } from '../types';
import { iri, lit } from '../types';
import {
  buildSitePages, publishablePages, sitePosts, slugify,
  PAGE_SLUG, PAGE_SECTION, PAGE_TEMPLATE, PAGE_STATUS, PAGE_NAV, PAGE_EXCERPT, PAGE_BODY, PAGE_DATE,
} from '../page';
import { NAV_ORDER } from '../hierarchy';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SKOS_BROADER = 'http://www.w3.org/2004/02/skos/core#broader';
const WEBPAGE = 'urn:kbase:type/WebPage';

let _id = 0;
function st(s: string, p: string, o: string, oIsIri = false): Statement {
  return {
    id: `p-${++_id}`,
    s: iri(s),
    p: iri(p),
    o: oIsIri ? iri(o) : lit(o),
    g: iri('urn:kbase:source/test'),
    sourceId: 'test',
    confidence: 1,
    status: 'confirmed',
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('slugify', () => {
  it('lowercases and dashes', () => {
    expect(slugify('Getting Started!')).toBe('getting-started');
    expect(slugify("It's a Test")).toBe('its-a-test');
  });
  it('never returns empty', () => {
    expect(slugify('---')).toBe('page');
    expect(slugify('')).toBe('page');
  });
});

describe('buildSitePages', () => {
  it('collects only WebPage nodes and applies defaults', () => {
    const stmts = [
      st('page:home', RDF_TYPE, WEBPAGE, true),
      st('page:home', RDFS_LABEL, 'Home'),
      st('concept:other', RDF_TYPE, 'urn:kbase:type/Concept', true),
      st('concept:other', RDFS_LABEL, 'Not a page'),
    ];
    const pages = buildSitePages(stmts);
    expect(pages).toHaveLength(1);
    const p = pages[0];
    expect(p.iri).toBe('page:home');
    expect(p.title).toBe('Home');
    expect(p.slug).toBe('home');        // derived from title
    expect(p.template).toBe('doc');     // default
    expect(p.status).toBe('draft');     // default
    expect(p.nav).toBe('sidebar');      // default
    expect(p.order).toBe(0);
    expect(p.parent).toBeNull();
    expect(p.date).toBeNull();
  });

  it('reads all page metadata and validates enums', () => {
    const stmts = [
      st('page:a', RDF_TYPE, WEBPAGE, true),
      st('page:a', RDFS_LABEL, 'Alpha Page'),
      st('page:a', PAGE_SLUG, 'alpha'),
      st('page:a', PAGE_SECTION, 'Docs'),
      st('page:a', NAV_ORDER, '3'),
      st('page:a', PAGE_TEMPLATE, 'landing'),
      st('page:a', PAGE_STATUS, 'published'),
      st('page:a', PAGE_NAV, 'both'),
      st('page:a', PAGE_EXCERPT, 'Short summary'),
      st('page:a', PAGE_BODY, '# Alpha\n\nBody text'),
      // invalid enum values must be ignored (fall back to defaults)
      st('page:a', 'urn:reckons:page/template', 'bogus'),
    ];
    const [p] = buildSitePages(stmts);
    expect(p.slug).toBe('alpha');
    expect(p.section).toBe('Docs');
    expect(p.order).toBe(3);
    expect(p.template).toBe('landing');
    expect(p.status).toBe('published');
    expect(p.nav).toBe('both');
    expect(p.excerpt).toBe('Short summary');
    expect(p.body).toContain('Body text');
  });

  it('resolves parent via skos:broader and sorts by section/order/title', () => {
    const stmts = [
      st('page:child', RDF_TYPE, WEBPAGE, true),
      st('page:child', RDFS_LABEL, 'Child'),
      st('page:child', PAGE_SECTION, 'Docs'),
      st('page:child', NAV_ORDER, '2'),
      st('page:child', SKOS_BROADER, 'page:parent', true),
      st('page:parent', RDF_TYPE, WEBPAGE, true),
      st('page:parent', RDFS_LABEL, 'Parent'),
      st('page:parent', PAGE_SECTION, 'Docs'),
      st('page:parent', NAV_ORDER, '1'),
    ];
    const pages = buildSitePages(stmts);
    expect(pages.map((p) => p.title)).toEqual(['Parent', 'Child']); // order 1 then 2
    expect(pages[1].parent).toBe('page:parent');
  });

  it('excludes rejected/superseded statements', () => {
    const rejected = st('page:x', RDF_TYPE, WEBPAGE, true);
    rejected.status = 'rejected';
    const pages = buildSitePages([rejected]);
    expect(pages).toHaveLength(0);
  });

  it('accepts the post template and parses a valid ISO date', () => {
    const stmts = [
      st('page:r1', RDF_TYPE, WEBPAGE, true),
      st('page:r1', RDFS_LABEL, 'v0.1.0'),
      st('page:r1', PAGE_TEMPLATE, 'post'),
      st('page:r1', PAGE_STATUS, 'published'),
      st('page:r1', PAGE_DATE, '2026-07-01'),
    ];
    const [p] = buildSitePages(stmts);
    expect(p.template).toBe('post');
    expect(p.date).toBe('2026-07-01');
  });

  it('ignores a malformed date literal (falls back to null)', () => {
    const stmts = [
      st('page:r2', RDF_TYPE, WEBPAGE, true),
      st('page:r2', PAGE_TEMPLATE, 'post'),
      st('page:r2', PAGE_DATE, 'not-a-date'),
    ];
    const [p] = buildSitePages(stmts);
    expect(p.date).toBeNull();
  });

  it('does not disturb the (section, order, title) sort for non-post pages', () => {
    const stmts = [
      st('page:b', RDF_TYPE, WEBPAGE, true), st('page:b', RDFS_LABEL, 'Bravo'),
      st('page:b', PAGE_SECTION, 'Docs'), st('page:b', NAV_ORDER, '2'),
      st('page:a', RDF_TYPE, WEBPAGE, true), st('page:a', RDFS_LABEL, 'Alpha'),
      st('page:a', PAGE_SECTION, 'Docs'), st('page:a', NAV_ORDER, '1'),
    ];
    const pages = buildSitePages(stmts);
    expect(pages.map((p) => p.title)).toEqual(['Alpha', 'Bravo']);
  });
});

describe('publishablePages', () => {
  it('drops drafts, keeps published and unlisted', () => {
    const stmts = [
      st('page:d', RDF_TYPE, WEBPAGE, true), st('page:d', PAGE_STATUS, 'draft'),
      st('page:p', RDF_TYPE, WEBPAGE, true), st('page:p', PAGE_STATUS, 'published'),
      st('page:u', RDF_TYPE, WEBPAGE, true), st('page:u', PAGE_STATUS, 'unlisted'),
    ];
    const pub = publishablePages(buildSitePages(stmts));
    expect(pub.map((p) => p.iri).sort()).toEqual(['page:p', 'page:u']);
  });

  it('excludes draft posts too', () => {
    const stmts = [
      st('page:secret-release', RDF_TYPE, WEBPAGE, true),
      st('page:secret-release', PAGE_TEMPLATE, 'post'),
      st('page:secret-release', PAGE_STATUS, 'draft'),
      st('page:secret-release', PAGE_DATE, '2026-08-01'),
      st('page:shipped-release', RDF_TYPE, WEBPAGE, true),
      st('page:shipped-release', PAGE_TEMPLATE, 'post'),
      st('page:shipped-release', PAGE_STATUS, 'published'),
      st('page:shipped-release', PAGE_DATE, '2026-07-01'),
    ];
    const pub = publishablePages(buildSitePages(stmts));
    expect(pub.map((p) => p.iri)).toEqual(['page:shipped-release']);
  });
});

describe('sitePosts', () => {
  function samplePosts(): Statement[] {
    return [
      st('page:oldest', RDF_TYPE, WEBPAGE, true), st('page:oldest', RDFS_LABEL, 'Oldest'),
      st('page:oldest', PAGE_TEMPLATE, 'post'), st('page:oldest', PAGE_SECTION, 'Releases'),
      st('page:oldest', PAGE_DATE, '2026-01-01'),

      st('page:newest', RDF_TYPE, WEBPAGE, true), st('page:newest', RDFS_LABEL, 'Newest'),
      st('page:newest', PAGE_TEMPLATE, 'post'), st('page:newest', PAGE_SECTION, 'Releases'),
      st('page:newest', PAGE_DATE, '2026-07-01'),

      st('page:middle', RDF_TYPE, WEBPAGE, true), st('page:middle', RDFS_LABEL, 'Middle'),
      st('page:middle', PAGE_TEMPLATE, 'post'), st('page:middle', PAGE_SECTION, 'Releases'),
      st('page:middle', PAGE_DATE, '2026-04-01'),

      // undated post — sorts last
      st('page:undated', RDF_TYPE, WEBPAGE, true), st('page:undated', RDFS_LABEL, 'Undated'),
      st('page:undated', PAGE_TEMPLATE, 'post'), st('page:undated', PAGE_SECTION, 'Releases'),

      // not a post — must never appear in sitePosts()
      st('page:doc', RDF_TYPE, WEBPAGE, true), st('page:doc', RDFS_LABEL, 'Doc'),
      st('page:doc', PAGE_SECTION, 'Releases'),
    ];
  }

  it('orders posts newest-first, undated last, excludes non-posts', () => {
    const pages = buildSitePages(samplePosts());
    const posts = sitePosts(pages);
    expect(posts.map((p) => p.title)).toEqual(['Newest', 'Middle', 'Oldest', 'Undated']);
    expect(posts.every((p) => p.template === 'post')).toBe(true);
  });

  it('scopes to a single section when given', () => {
    const pages = buildSitePages([
      ...samplePosts(),
      st('page:other-section', RDF_TYPE, WEBPAGE, true),
      st('page:other-section', RDFS_LABEL, 'Other'),
      st('page:other-section', PAGE_TEMPLATE, 'post'),
      st('page:other-section', PAGE_SECTION, 'Announcements'),
      st('page:other-section', PAGE_DATE, '2026-12-01'),
    ]);
    const posts = sitePosts(pages, 'Releases');
    expect(posts.map((p) => p.title)).toEqual(['Newest', 'Middle', 'Oldest', 'Undated']);
  });
});
