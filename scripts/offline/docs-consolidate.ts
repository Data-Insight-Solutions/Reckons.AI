#!/usr/bin/env npx tsx
/**
 * Docs consolidation report (F27) — what a composed /docs site would cover, and what it would not.
 *
 * SCRIPT TIER: deterministic, zero tokens, no model. It parses `static/docs-site.ttl` (the
 * proposed information architecture, as a graph) and the docs sub-graphs it sources from, runs
 * `composePages`, and prints the coverage.
 *
 * THE ORPHAN LIST IS THE OUTPUT THAT MATTERS. Today the generator publishes one page per ENTITY —
 * 269 entities, 269 pages, alphabetical, no editorial layer. Consolidating to a handful of pages
 * means most entities lose a page of their own, and the difference between "curated" and "we lost
 * 250 pages of content" is entirely whether anyone can see the leftovers. So this exits non-zero
 * when the proposed IA would drop content, and names it.
 *
 * It CHANGES NOTHING. Wiring composition into `docs-pages.ts` is a separate, reviewed step; this
 * exists so the editorial decision is made against real numbers rather than a guess.
 *
 * Usage: npm run docs:consolidate  [--quiet]
 */

import { Parser, type Quad } from 'n3';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  composePages, describeComposition,
  type ExclusionRule, type PageDefinition, type PageSource, type SourceEntity,
} from '../../src/lib/publish/page-composition';
import {
  PAGE_PURPOSE, PAGE_SECTION, PAGE_SLUG,
  PAGE_SOURCES_ENTITY, PAGE_SOURCES_GRAPH, PAGE_SOURCES_TYPE, WEBPAGE_TYPE,
} from '../../src/lib/rdf/page';
import { NAV_ORDER } from '../../src/lib/rdf/hierarchy';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const STATIC_DIR = join(ROOT, 'static');
const SITE_FILE = 'docs-site.ttl';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SKOS_DEFINITION = 'http://www.w3.org/2004/02/skos/core#definition';
const SKOS_BROADER = 'http://www.w3.org/2004/02/skos/core#broader';
const PAGE_EXCLUDES_UNDER = 'urn:reckons:page/excludes-under';
const PAGE_EXCLUDES_ENTITY = 'urn:reckons:page/excludes-entity';
const KTYPE_NS = 'urn:kbase:type/';
/** Per-sub-graph "back to hub" stubs — UI wiring, never doc content. Mirrors docs-pages.ts. */
const NAV_DOCS_NS = 'urn:reckons:docs/nav/';

/** Which graphs hold publishable entities. Mirrors SOURCES in scripts/docs-pages.ts. */
const CORPUS = [
  'docs-triples-rdf.ttl', 'docs-llm.ttl', 'docs-use-cases.ttl', 'docs-features.ttl',
  'docs-integrations-tech.ttl', 'docs-tips-security.ttl', 'docs-timeline-ecosystem.ttl',
  'docs-architecture.ttl', 'docs-coding-workflow.ttl', 'docs-testing.ttl', 'starter-guide.ttl',
];

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

function parseTtl(file: string): Quad[] {
  const path = join(STATIC_DIR, file);
  if (!existsSync(path)) return [];
  return new Parser().parse(readFileSync(path, 'utf8'));
}

/** Humanize a ktype IRI local name the same way docs-pages.ts does. */
function typeLocalName(iri: string): string {
  return iri.slice(KTYPE_NS.length);
}

/** Every publishable entity across the corpus, tagged with the graph that asserted it. */
function readEntities(): SourceEntity[] {
  const out: SourceEntity[] = [];
  for (const graph of CORPUS) {
    const quads = parseTtl(graph);
    const types = new Map<string, string[]>();
    const titles = new Map<string, string>();
    const defs = new Map<string, string>();
    const parents = new Map<string, string>();

    for (const q of quads) {
      const s = q.subject.value;
      if (s.startsWith(NAV_DOCS_NS)) continue;
      if (q.predicate.value === RDF_TYPE && q.object.value.startsWith(KTYPE_NS)) {
        types.set(s, [...(types.get(s) ?? []), typeLocalName(q.object.value)]);
      } else if (q.predicate.value === RDFS_LABEL) {
        titles.set(s, q.object.value);
      } else if (q.predicate.value === SKOS_DEFINITION) {
        defs.set(s, q.object.value);
      } else if (q.predicate.value === SKOS_BROADER) {
        parents.set(s, q.object.value);
      }
    }

    for (const [iri, t] of types) {
      out.push({
        iri,
        graph,
        title: titles.get(iri) ?? iri.split(/[/#]/).pop() ?? iri,
        definition: defs.get(iri) ?? '',
        types: [...t].sort(),
        parent: parents.get(iri),
      });
    }
  }
  // An entity asserted in two files appears once per file; dedupe on IRI, keeping the first,
  // so coverage counts ENTITIES rather than assertions.
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.iri) ? false : (seen.add(e.iri), true)));
}

/** Read the proposed page definitions out of docs-site.ttl. */
function readPageDefinitions(): PageDefinition[] {
  const quads = parseTtl(SITE_FILE);
  const pages = new Set<string>();
  for (const q of quads) {
    if (q.predicate.value === RDF_TYPE && q.object.value === WEBPAGE_TYPE) pages.add(q.subject.value);
  }

  const defs: PageDefinition[] = [];
  for (const iri of [...pages].sort()) {
    const own = quads.filter((q) => q.subject.value === iri);
    const one = (p: string) => own.find((q) => q.predicate.value === p)?.object.value ?? '';
    const many = (p: string) => own.filter((q) => q.predicate.value === p).map((q) => q.object.value);

    const sources: PageSource[] = [
      ...many(PAGE_SOURCES_GRAPH).map((graph): PageSource => ({ kind: 'graph', graph })),
      ...many(PAGE_SOURCES_ENTITY).map((entity): PageSource => ({ kind: 'entity', iri: entity })),
      ...many(PAGE_SOURCES_TYPE).map((type): PageSource => ({ kind: 'type', type })),
    ];

    defs.push({
      id: iri.split(/[/#]/).pop() ?? iri,
      title: one(RDFS_LABEL),
      slug: one(PAGE_SLUG) || undefined,
      section: one(PAGE_SECTION) || 'Docs',
      purpose: one(PAGE_PURPOSE),
      order: Number(one(NAV_ORDER) || 0),
      sources,
    });
  }
  return defs;
}

/** Exclusion rules declared in docs-site.ttl — what the site deliberately does not publish. */
function readExclusions(): ExclusionRule[] {
  const quads = parseTtl(SITE_FILE);
  const ids = new Set<string>();
  for (const q of quads) {
    if (q.predicate.value === PAGE_EXCLUDES_UNDER || q.predicate.value === PAGE_EXCLUDES_ENTITY) {
      ids.add(q.subject.value);
    }
  }
  return [...ids].sort().map((iri) => {
    const own = quads.filter((q) => q.subject.value === iri);
    const one = (p: string) => own.find((q) => q.predicate.value === p)?.object.value;
    return {
      id: one(RDFS_LABEL) ?? iri.split(/[/#]/).pop() ?? iri,
      reason: one(PAGE_PURPOSE) ?? '',
      under: one(PAGE_EXCLUDES_UNDER),
      entity: one(PAGE_EXCLUDES_ENTITY),
    };
  });
}

function main(): void {
  const quiet = process.argv.includes('--quiet');
  const entities = readEntities();
  const definitions = readPageDefinitions();

  if (definitions.length === 0) {
    console.error(C.red(`No WebPage definitions found in static/${SITE_FILE}.`));
    process.exit(1);
  }

  const report = composePages(definitions, entities, readExclusions());

  console.log('');
  console.log(C.bold('docs consolidation') + C.dim(` — proposed in static/${SITE_FILE}`));
  console.log(C.dim(`  today: ${entities.length} entities published as ${entities.length} separate pages`));
  console.log(`  ${C.bold(describeComposition(report))}`);
  console.log('');

  for (const page of report.pages) {
    const from = page.sections.map((s) => s.graph.replace(/^docs-|\.ttl$/g, '')).join(' + ');
    console.log(
      `  ${C.bold(page.title.padEnd(26))} ${String(page.entityCount).padStart(3)} entities  ${C.dim(from)}`,
    );
    if (!quiet) console.log(C.dim(`    ${page.purpose}`));
  }

  if (report.excluded.length > 0) {
    console.log('');
    console.log(C.dim(`  deliberately not published (${report.excluded.length}):`));
    const byRule = new Map<string, string[]>();
    for (const e of report.excluded) byRule.set(e.rule, [...(byRule.get(e.rule) ?? []), e.title]);
    for (const [rule, titles] of [...byRule].sort()) {
      console.log(C.dim(`    ${rule} — ${titles.length} entities`));
    }
  }

  if (report.emptyPages.length > 0) {
    console.log('');
    console.log(C.yellow(`  pages matching nothing (check the graph names): ${report.emptyPages.join(', ')}`));
  }

  if (report.duplicated.length > 0) {
    console.log('');
    console.log(C.yellow(`  on more than one page (${report.duplicated.length}):`));
    for (const d of report.duplicated.slice(0, 10)) {
      console.log(C.dim(`    ${d.title} — ${d.pages.join(', ')}`));
    }
  }

  if (report.orphans.length > 0) {
    console.log('');
    console.log(C.red(C.bold(`  ${report.orphans.length} entities would NOT be published:`)));
    const byGraph = new Map<string, string[]>();
    for (const o of report.orphans) byGraph.set(o.graph, [...(byGraph.get(o.graph) ?? []), o.title]);
    for (const [graph, titles] of [...byGraph].sort()) {
      console.log(`    ${C.bold(graph)} ${C.dim(`(${titles.length})`)}`);
      for (const t of titles.slice(0, quiet ? 3 : 12)) console.log(C.dim(`      ${t}`));
      if (titles.length > (quiet ? 3 : 12)) console.log(C.dim(`      … and ${titles.length - (quiet ? 3 : 12)} more`));
    }
    console.log('');
    console.log(C.dim('  Either claim them from a page, or decide deliberately that they are not'));
    console.log(C.dim('  public documentation. Both are fine; losing them by accident is not.'));
    process.exit(1);
  }

  console.log('');
  console.log(C.green('  every entity is claimed by a page — nothing would be dropped.'));
}

main();
