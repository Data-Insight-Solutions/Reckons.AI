/**
 * Website graph reader (F27.3) — standard RDF in, composition input out.
 *
 * The failures worth testing are the QUIET ones. A page whose type IRI does not match, or whose
 * dataset reference resolves to nothing, does not error — it simply stops existing, and a site
 * section disappears with nothing to explain it. So every such case is asserted to produce a
 * reported problem rather than a smaller site.
 */
import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { readWebsiteGraph, datasetOverlaps } from '../website-graph';
import { composePages } from '../page-composition';

const parse = (ttl: string) => new Parser().parse(ttl);

const PREFIXES = `
@prefix rdf:     <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs:    <http://www.w3.org/2000/01/rdf-schema#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix schema:  <https://schema.org/> .
@prefix void:    <http://rdfs.org/ns/void#> .
@prefix site:    <https://reckons.ai/> .
@prefix ds:      <https://reckons.ai/dataset/> .
@prefix reckons: <urn:reckons:page/> .
`;

const SITE = `${PREFIXES}
site:docs a schema:WebSite ;
    schema:name "Reckons.AI documentation" ;
    schema:hasPart site:what-it-does .

ds:features a void:Dataset ; dcterms:title "Features" ; dcterms:source "docs-features.ttl" .
ds:use-cases a void:Dataset ; dcterms:title "Use cases" ; dcterms:source "docs-use-cases.ttl" .

site:what-it-does a schema:WebPage ;
    schema:isPartOf site:docs ;
    schema:name "What it does" ;
    schema:url "what-it-does" ;
    schema:position 2 ;
    schema:abstract "Every capability, and a worked example of each." ;
    schema:isBasedOn ds:features , ds:use-cases .
`;

describe('reading the site with standard vocabulary', () => {
  it('reads the site, its datasets and its pages', () => {
    const g = readWebsiteGraph(parse(SITE));
    expect(g.siteName).toBe('Reckons.AI documentation');
    expect(g.datasets.map((d) => d.file)).toEqual(['docs-features.ttl', 'docs-use-cases.ttl']);
    expect(g.problems).toEqual([]);
  });

  it('turns schema:isBasedOn into graph sources — one page, several datasets', () => {
    const [page] = readWebsiteGraph(parse(SITE)).pages;
    expect(page.title).toBe('What it does');
    expect(page.purpose).toBe('Every capability, and a worked example of each.');
    expect(page.sources).toEqual([
      { kind: 'graph', graph: 'docs-features.ttl' },
      { kind: 'graph', graph: 'docs-use-cases.ttl' },
    ]);
  });

  it('turns schema:about into an entity source', () => {
    const g = readWebsiteGraph(parse(`${SITE}
site:about a schema:WebPage ;
    schema:isPartOf site:docs ;
    schema:name "About" ;
    schema:abstract "Who makes this and why." ;
    schema:about <urn:kbase:concept/mission> .
`));
    const about = g.pages.find((p) => p.title === 'About')!;
    expect(about.sources).toEqual([{ kind: 'entity', iri: 'urn:kbase:concept/mission' }]);
  });

  it('accepts schema.org under either http or https', () => {
    // Graphs in the wild use both. A page whose type failed to match would simply not exist,
    // with no error to explain the missing section.
    const httpSite = SITE.replace('<https://schema.org/>', '<http://schema.org/>');
    expect(readWebsiteGraph(parse(httpSite)).pages).toHaveLength(1);
  });

  it('finds a page declared only by the SITE via schema:hasPart', () => {
    const g = readWebsiteGraph(parse(`${PREFIXES}
site:docs a schema:WebSite ; schema:name "Docs" ; schema:hasPart site:orphan .
ds:features a void:Dataset ; dcterms:source "docs-features.ttl" .
site:orphan schema:name "Only reachable from the site" ;
    schema:abstract "Reachable from one end only." ;
    schema:isBasedOn ds:features .
`));
    expect(g.pages.map((p) => p.title)).toEqual(['Only reachable from the site']);
  });

  it('orders pages by schema:position', () => {
    const g = readWebsiteGraph(parse(`${SITE}
site:start a schema:WebPage ;
    schema:isPartOf site:docs ; schema:name "Start here" ;
    schema:position 1 ; schema:abstract "First." ; schema:isBasedOn ds:features .
`));
    expect(g.pages.map((p) => p.title)).toEqual(['Start here', 'What it does']);
  });
});

describe('quiet failures are reported, not swallowed', () => {
  it('reports a dataset with no dcterms:source instead of dropping it', () => {
    const g = readWebsiteGraph(parse(`${PREFIXES}
ds:broken a void:Dataset ; dcterms:title "Nowhere" .
`));
    expect(g.datasets).toEqual([]);
    expect(g.problems[0]).toContain('no dcterms:source');
  });

  it('reports a page based on something that is not a dataset', () => {
    const g = readWebsiteGraph(parse(`${PREFIXES}
site:docs a schema:WebSite ; schema:name "Docs" .
site:typo a schema:WebPage ;
    schema:isPartOf site:docs ; schema:name "Typo" ;
    schema:abstract "Points at nothing." ; schema:isBasedOn ds:does-not-exist .
`));
    expect(g.problems[0]).toContain('not a void:Dataset');
    // The page still exists, with no sources — composition then refuses it loudly.
    expect(g.pages[0].sources).toEqual([]);
  });

  it('reports a page the site names but that has no statements', () => {
    const g = readWebsiteGraph(parse(`${PREFIXES}
site:docs a schema:WebSite ; schema:name "Docs" ; schema:hasPart site:ghost .
`));
    expect(g.problems[0]).toContain('no statements of its own');
  });

  it('feeds composition directly, so the vocabulary and the rules stay separable', () => {
    const g = readWebsiteGraph(parse(SITE));
    const report = composePages(g.pages, [
      { iri: 'kb:ingest', graph: 'docs-features.ttl', title: 'Ingest', definition: '', types: ['Feature'] },
      { iri: 'kb:trip', graph: 'docs-use-cases.ttl', title: 'Trip planning', definition: '', types: ['Concept'] },
    ], g.exclusions);
    expect(report.pages[0].entityCount).toBe(2);
    expect(report.orphans).toEqual([]);
  });
});

describe('exclusions carry their reason', () => {
  const WITH_EXCLUSION = `${SITE}
site:exclude-tracker a rdfs:Resource ;
    rdfs:label "Markdown migration tracker" ;
    reckons:excludes-under <urn:reckons:arch/MigrationStatus> ;
    dcterms:description "Internal bookkeeping, not documentation." .
`;

  it('reads the rule and its dcterms:description', () => {
    const [rule] = readWebsiteGraph(parse(WITH_EXCLUSION)).exclusions;
    expect(rule).toMatchObject({
      id: 'Markdown migration tracker',
      under: 'urn:reckons:arch/MigrationStatus',
      reason: 'Internal bookkeeping, not documentation.',
    });
  });

  it('produces a rule composition will refuse when the reason is missing', () => {
    const g = readWebsiteGraph(parse(WITH_EXCLUSION.replace(
      'dcterms:description "Internal bookkeeping, not documentation." .', '.',
    )));
    expect(g.exclusions[0].reason).toBe('');
    expect(() => composePages(g.pages, [], g.exclusions)).toThrow(/silent drop/);
  });
});

describe('the meta-graph — how datasets inter-relate', () => {
  it('finds entities asserted in more than one dataset', () => {
    const overlaps = datasetOverlaps([
      { iri: 'kb:ingest', graph: 'docs-features.ttl' },
      { iri: 'kb:ingest', graph: 'starter-guide.ttl' },
      { iri: 'kb:review', graph: 'docs-features.ttl' },
      { iri: 'kb:review', graph: 'starter-guide.ttl' },
      { iri: 'kb:alone', graph: 'docs-llm.ttl' },
    ]);
    expect(overlaps).toEqual([
      { a: 'docs-features.ttl', b: 'starter-guide.ttl', shared: ['kb:ingest', 'kb:review'] },
    ]);
  });

  it('reports nothing when no entity is shared', () => {
    expect(datasetOverlaps([
      { iri: 'a', graph: 'one.ttl' },
      { iri: 'b', graph: 'two.ttl' },
    ])).toEqual([]);
  });

  it('reports each PAIR once when an entity spans three datasets', () => {
    const overlaps = datasetOverlaps([
      { iri: 'x', graph: 'a.ttl' },
      { iri: 'x', graph: 'b.ttl' },
      { iri: 'x', graph: 'c.ttl' },
    ]);
    expect(overlaps.map((o) => `${o.a}+${o.b}`).sort())
      .toEqual(['a.ttl+b.ttl', 'a.ttl+c.ttl', 'b.ttl+c.ttl']);
  });

  it('ranks the most-overlapping pair first', () => {
    const overlaps = datasetOverlaps([
      { iri: '1', graph: 'a.ttl' }, { iri: '1', graph: 'b.ttl' },
      { iri: '2', graph: 'a.ttl' }, { iri: '2', graph: 'b.ttl' },
      { iri: '3', graph: 'c.ttl' }, { iri: '3', graph: 'd.ttl' },
    ]);
    expect(overlaps[0].shared).toHaveLength(2);
  });
});

describe('navigation elements are not pages', () => {
  it('does not adopt a SiteNavigationElement that declares schema:isPartOf the site', () => {
    // Found by the alignment report itself, which demanded a schema:url for "menu". A nav
    // element links to the site exactly like a page does; the type is what tells them apart.
    const g = readWebsiteGraph(parse(`${SITE}
site:menu a schema:SiteNavigationElement ;
    schema:isPartOf site:docs ;
    schema:name "Docs" ;
    schema:hasPart site:what-it-does .
`));
    expect(g.pages.map((p) => p.title)).toEqual(['What it does']);
    expect(g.problems).toEqual([]);
  });

  it('still adopts an UNTYPED page the site names, so one-ended declarations survive', () => {
    const g = readWebsiteGraph(parse(`${PREFIXES}
site:docs a schema:WebSite ; schema:name "Docs" ; schema:hasPart site:untyped .
ds:features a void:Dataset ; dcterms:source "docs-features.ttl" .
site:untyped schema:name "Untyped page" ; schema:abstract "Still a page." ;
    schema:url <https://reckons.ai/docs/learn/untyped> ; schema:isBasedOn ds:features .
`));
    expect(g.pages.map((p) => p.title)).toEqual(['Untyped page']);
  });
});
