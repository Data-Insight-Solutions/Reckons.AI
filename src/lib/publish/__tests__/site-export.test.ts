import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import type { Statement } from '../../rdf/types';
import { iri, lit } from '../../rdf/types';
import {
  PAGE_SLUG, PAGE_SECTION, PAGE_STATUS, PAGE_TEMPLATE, PAGE_BODY, PAGE_DATE, PAGE_GENERATED,
} from '../../rdf/page';
import { buildSitePages } from '../../rdf/page';
import { NAV_ORDER } from '../../rdf/hierarchy';
import {
  contentPath, pageToMarkdown, buildGraphJson, buildSiteFiles, zipSiteBytes, sveltiaConfig,
} from '../site-export';

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

    // draft — should be excluded from a default publish
    st('page:secret', RDF_TYPE, WEBPAGE, true),
    st('page:secret', RDFS_LABEL, 'Secret'),
    st('page:secret', PAGE_STATUS, 'draft'),
  ];
}

describe('contentPath', () => {
  it('nests under a slugified section', () => {
    const overview = buildSitePages(sampleSite()).find((p) => p.slug === 'overview')!;
    expect(contentPath(overview)).toBe('content/docs/overview.md');
  });
  it('places section-less pages at content root', () => {
    const pages = buildSitePages([
      st('page:root', RDF_TYPE, WEBPAGE, true),
      st('page:root', RDFS_LABEL, 'Root'),
    ]);
    expect(contentPath(pages[0])).toBe('content/root.md');
  });
});

describe('pageToMarkdown', () => {
  it('emits frontmatter with parent/related as slugs, then body', () => {
    const pages = buildSitePages(sampleSite());
    const slugs = new Map(pages.map((p) => [p.iri, p.slug]));
    const install = pages.find((p) => p.slug === 'install')!;
    const md = pageToMarkdown(install, slugs);
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('title: "Install"');
    expect(md).toContain('order: 2');
    expect(md).toContain('section: "Docs"');
    expect(md).toContain('parent: "overview"');   // IRI resolved to slug
    expect(md).toContain('status: published');
    expect(md).toMatch(/related:\n {2}- "overview"/);
    // body fallback when no page:body
    expect(md.trimEnd().endsWith('# Install')).toBe(true);
  });

  it('emits date frontmatter for a post, omits it when absent', () => {
    const withDate = buildSitePages([
      st('page:release', RDF_TYPE, WEBPAGE, true),
      st('page:release', RDFS_LABEL, 'v0.1.0'),
      st('page:release', PAGE_TEMPLATE, 'post'),
      st('page:release', PAGE_STATUS, 'published'),
      st('page:release', PAGE_DATE, '2026-07-01'),
    ]);
    const slugs = new Map(withDate.map((p) => [p.iri, p.slug]));
    const md = pageToMarkdown(withDate[0], slugs);
    expect(md).toContain('template: post');
    expect(md).toContain('date: "2026-07-01"');

    const noDate = buildSitePages(sampleSite());
    const md2 = pageToMarkdown(noDate.find((p) => p.slug === 'overview')!, slugs);
    expect(md2).not.toContain('date:');
  });

  it('emits generated frontmatter for docs-KB pages, omits it when absent', () => {
    const generatedPages = buildSitePages([
      st('page:auto', RDF_TYPE, WEBPAGE, true),
      st('page:auto', RDFS_LABEL, 'Auto Page'),
      st('page:auto', PAGE_STATUS, 'published'),
      st('page:auto', PAGE_GENERATED, 'docs-kb'),
    ]);
    const slugs = new Map(generatedPages.map((p) => [p.iri, p.slug]));
    const md = pageToMarkdown(generatedPages[0], slugs);
    expect(md).toContain('generated: "docs-kb"');

    const manual = buildSitePages(sampleSite());
    const md2 = pageToMarkdown(manual.find((p) => p.slug === 'overview')!, slugs);
    expect(md2).not.toContain('generated:');
  });
});

describe('buildGraphJson', () => {
  it('builds nodes and parent/related/next edges by slug', () => {
    const pages = buildSitePages(sampleSite()).filter((p) => p.status !== 'draft');
    const g = buildGraphJson(pages);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['install', 'overview']);
    expect(g.edges).toContainEqual({ from: 'install', to: 'overview', kind: 'parent' });
    expect(g.edges).toContainEqual({ from: 'install', to: 'overview', kind: 'related' });
  });
});

describe('buildSiteFiles', () => {
  it('writes published markdown + graph.json + admin scaffolding, excludes drafts', () => {
    const files = buildSiteFiles(sampleSite(), { repo: 'me/site', branch: 'main' });
    expect(Object.keys(files)).toContain('content/docs/overview.md');
    expect(Object.keys(files)).toContain('content/docs/install.md');
    expect(Object.keys(files)).not.toContain('content/secret.md'); // draft excluded
    expect(files['graph.json']).toContain('"overview"');
    expect(files['admin/config.yml']).toContain('repo: me/site');
    expect(files['admin/index.html']).toContain('sveltia-cms');
  });

  it('includes drafts when asked and can skip admin', () => {
    const files = buildSiteFiles(sampleSite(), { includeDrafts: true, includeAdmin: false });
    expect(Object.keys(files)).toContain('content/secret.md');
    expect(Object.keys(files)).not.toContain('admin/config.yml');
  });

  it('emits a self-describing knowledge.ttl that parses and carries the published facts (F72)', async () => {
    const files = buildSiteFiles(sampleSite());
    expect(Object.keys(files)).toContain('knowledge.ttl');
    const ttl = files['knowledge.ttl'];
    // Parses as valid Turtle and contains a published page's facts.
    const N3 = (await import('n3')).default;
    const quads = new N3.Parser().parse(ttl);
    expect(quads.length).toBeGreaterThan(0);
    expect(ttl).toContain('Overview');
  });

  it('never emits publish-blocked statements into knowledge.ttl (safety gate)', () => {
    // A hate/violence literal the content policy blocks (see content-policy tests).
    const slur = 'kill all the jews';
    const files = buildSiteFiles([...sampleSite(), st('kb:x', 'urn:kbase:predicate/note', slur)]);
    expect(files['knowledge.ttl']).not.toContain(slur);
  });
});

describe('zipSiteBytes', () => {
  it('produces a valid zip that unzips back to the same files', () => {
    const bytes = zipSiteBytes(sampleSite(), { repo: 'me/site' });
    const unzipped = unzipSync(bytes);
    expect(Object.keys(unzipped)).toContain('content/docs/overview.md');
    expect(strFromU8(unzipped['content/docs/overview.md'])).toContain('title: "Overview"');
  });
});

describe('sveltiaConfig', () => {
  it('wires the github backend and a matching pages collection', () => {
    const cfg = sveltiaConfig({ repo: 'me/site', branch: 'dev' });
    expect(cfg).toContain('name: github');
    expect(cfg).toContain('repo: me/site');
    expect(cfg).toContain('branch: dev');
    expect(cfg).toContain('folder: content');
    for (const field of ['title', 'slug', 'order', 'section', 'template', 'status', 'nav', 'date', 'excerpt', 'body', 'generated']) {
      expect(cfg).toContain(`name: ${field}`);
    }
    expect(cfg).toContain('post'); // template widget must offer the post option
    expect(cfg).toContain('widget: hidden'); // generated field is readonly, hidden from editors
  });
});
