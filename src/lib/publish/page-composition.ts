/**
 * Page composition (F27) — a page DECLARES the graph it is made from.
 *
 * Today `scripts/docs-pages.ts` publishes one page per ENTITY: any subject carrying an
 * `rdf:type` under `urn:kbase:type/` becomes its own file. 269 entities therefore produce 269
 * pages, sorted alphabetically with no editorial layer, and /docs is 23,000px of sidebar in
 * which "6-Step Migration Pipeline" and "CONFLUENCE_MIGRATION.md → Superseded" sit beside real
 * documentation. The graph decides the site's information architecture by accident, because
 * "has a type" was standing in for "is a page someone would want to read".
 *
 * This module inverts that. A PAGE is authored, and it declares its SOURCES — one or more graphs,
 * named entities, or type filters within a graph. Composition then gathers the matching entities
 * into that page as sections. One page can source from several graphs (a single "How it works"
 * page drawing on the architecture AND the features graph), which is the thing winner-takes-all
 * `resolveHomeFile()` cannot express: it picks one owning file per entity and DROPS the other's
 * assertions.
 *
 * THE ORPHAN REPORT IS THE POINT, not a diagnostic extra. Consolidating 269 pages into a dozen
 * means most entities stop having a page of their own, and the difference between "curated" and
 * "we lost 250 pages of content" is entirely whether anyone can see what was left out. So
 * composition always returns what NO page claimed. Publishing fewer pages is an editorial act;
 * doing it silently is data loss with a tidier sidebar.
 *
 * Pure: definitions + entities in, composition + report out. No filesystem, no n3, no clock.
 */

import { slugify } from '$lib/rdf/page';

/** An entity as the docs generator sees it — the minimum composition needs to place and render it. */
export interface SourceEntity {
  iri: string;
  /** The graph file it was asserted in, e.g. "docs-architecture.ttl". */
  graph: string;
  title: string;
  /** One-line definition, if the entity has one. */
  definition: string;
  /** Humanized `rdf:type` local names, e.g. ["Feature"]. */
  types: string[];
  /** `skos:broader` target, if any. Lets a whole subtree be excluded in one rule. */
  parent?: string;
}

/**
 * Content the site DELIBERATELY does not publish, and why.
 *
 * This is not the same as an orphan, and conflating them is how a curated site quietly becomes a
 * lossy one. An ORPHAN is an entity nobody decided about — it must be reported until someone
 * does. An EXCLUSION is a decision, and it carries a stated reason so the next person can tell
 * whether it still holds. The markdown-migration tracker is the motivating case: 16 entries like
 * "GUIDE.md -> Superseded" are internal bookkeeping about this repository's own docs migration,
 * and they are currently public pages on /docs.
 */
export interface ExclusionRule {
  id: string;
  /** Why this is not public documentation. Required — an unexplained exclusion is a silent drop. */
  reason: string;
  /** Exclude this entity and everything under it via `skos:broader`. */
  under?: string;
  /** Exclude one entity by IRI. */
  entity?: string;
}

/**
 * Where a page's content comes from. A page may declare several; an entity matching ANY of them
 * is claimed by that page.
 */
export type PageSource =
  /** Every entity asserted in this graph file. */
  | { kind: 'graph'; graph: string }
  /** One entity by IRI, wherever it lives. */
  | { kind: 'entity'; iri: string }
  /** Entities of a given humanized type, optionally restricted to one graph. */
  | { kind: 'type'; type: string; graph?: string };

export interface PageDefinition {
  /** Stable id for the page — becomes its slug when none is given. */
  id: string;
  title: string;
  slug?: string;
  section: string;
  /** Why a reader would open this page. Rendered as the page's lede. */
  purpose: string;
  order?: number;
  /** At least one. A page sourcing from nothing is a page about nothing. */
  sources: PageSource[];
  /** Resolvable live URL, so anything rendering this page can link a reviewer to it. */
  url?: string;
}

export interface ComposedSection {
  /** The graph this group of entities came from — a page can show several. */
  graph: string;
  entities: SourceEntity[];
}

export interface ComposedPage {
  id: string;
  title: string;
  slug: string;
  /** Resolvable live URL, carried through so a report can link straight to the page. */
  url?: string;
  section: string;
  purpose: string;
  order: number;
  /** Grouped by source graph, so a multi-graph page shows where each part came from. */
  sections: ComposedSection[];
  entityCount: number;
}

export interface CompositionReport {
  pages: ComposedPage[];
  /** Entities a rule deliberately kept off the site, with the rule that did it. */
  excluded: Array<{ iri: string; title: string; rule: string; reason: string }>;
  /** Entities no page claimed. These would NOT be published. Never silently dropped. */
  orphans: SourceEntity[];
  /** Entities claimed by more than one page — real duplication on the site, so it is reported. */
  duplicated: Array<{ iri: string; title: string; pages: string[] }>;
  /** Page definitions that matched nothing — usually a typo in a graph name. */
  emptyPages: string[];
}

export class PageDefinitionError extends Error {}

/** Does this entity match one declared source? */
function matches(entity: SourceEntity, source: PageSource): boolean {
  switch (source.kind) {
    case 'graph':
      return entity.graph === source.graph;
    case 'entity':
      return entity.iri === source.iri;
    case 'type':
      if (source.graph && entity.graph !== source.graph) return false;
      return entity.types.includes(source.type);
  }
}

/**
 * Compose pages from their declared sources.
 *
 * Order of `definitions` is NOT precedence: an entity matching two pages appears in both and is
 * reported as duplicated. Silently awarding it to the first page is exactly the behaviour of
 * `resolveHomeFile()`, which drops the loser's assertions and is why a page can currently lose
 * content it was asserted to have. Visible duplication is a decision the author can act on; a
 * silent drop is one they never learn about.
 */
export function composePages(
  definitions: PageDefinition[],
  entities: SourceEntity[],
  exclusions: ExclusionRule[] = [],
): CompositionReport {
  assertValidDefinitions(definitions);
  for (const rule of exclusions) {
    if (!rule.reason.trim()) {
      throw new PageDefinitionError(
        `Exclusion ${rule.id} has no reason — an unexplained exclusion is a silent drop with paperwork.`,
      );
    }
  }

  // Resolve subtree exclusions through skos:broader before anything is claimed, so an excluded
  // entity cannot be composed onto a page by a graph-wide source that would otherwise sweep it in.
  const byIri = new Map(entities.map((e) => [e.iri, e]));
  const excluded: CompositionReport['excluded'] = [];
  const excludedIris = new Set<string>();

  for (const entity of entities) {
    for (const rule of exclusions) {
      if (rule.entity === entity.iri || (rule.under && isUnder(entity, rule.under, byIri))) {
        excluded.push({ iri: entity.iri, title: entity.title, rule: rule.id, reason: rule.reason });
        excludedIris.add(entity.iri);
        break;
      }
    }
  }

  const publishable = entities.filter((e) => !excludedIris.has(e.iri));
  entities = publishable;

  const claimedBy = new Map<string, string[]>();
  const pages: ComposedPage[] = [];
  const emptyPages: string[] = [];

  for (const def of definitions) {
    const claimed = entities.filter((e) => def.sources.some((s) => matches(e, s)));
    for (const e of claimed) {
      claimedBy.set(e.iri, [...(claimedBy.get(e.iri) ?? []), def.id]);
    }

    if (claimed.length === 0) emptyPages.push(def.id);

    // Group by source graph so a page composed from several graphs says which part came from
    // where — provenance the reader can see, not just metadata we happen to hold.
    const byGraph = new Map<string, SourceEntity[]>();
    for (const e of claimed) byGraph.set(e.graph, [...(byGraph.get(e.graph) ?? []), e]);

    const sections: ComposedSection[] = [...byGraph.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([graph, list]) => ({
        graph,
        entities: [...list].sort((a, b) => a.title.localeCompare(b.title)),
      }));

    pages.push({
      id: def.id,
      title: def.title,
      slug: def.slug?.trim() ? slugify(def.slug) : slugify(def.title),
      url: def.url,
      section: def.section,
      purpose: def.purpose,
      order: def.order ?? 0,
      sections,
      entityCount: claimed.length,
    });
  }

  pages.sort((a, b) => (a.order - b.order) || a.title.localeCompare(b.title));

  const orphans = entities
    .filter((e) => !claimedBy.has(e.iri))
    .sort((a, b) => a.graph.localeCompare(b.graph) || a.title.localeCompare(b.title));

  const duplicated = [...claimedBy.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([iri, ids]) => ({
      iri,
      title: entities.find((e) => e.iri === iri)?.title ?? iri,
      pages: [...ids].sort(),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));

  return { pages, excluded, orphans, duplicated, emptyPages };
}

/** Is this entity at or beneath `ancestor` in the skos:broader chain? Cycle-safe. */
function isUnder(
  entity: SourceEntity,
  ancestor: string,
  byIri: Map<string, SourceEntity>,
): boolean {
  const seen = new Set<string>();
  let current: SourceEntity | undefined = entity;
  while (current && !seen.has(current.iri)) {
    seen.add(current.iri);
    if (current.parent === ancestor) return true;
    current = current.parent ? byIri.get(current.parent) : undefined;
  }
  return false;
}

function assertValidDefinitions(definitions: PageDefinition[]): void {
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const def of definitions) {
    if (!def.id.trim()) throw new PageDefinitionError('Every page definition needs an id.');
    if (seenIds.has(def.id)) throw new PageDefinitionError(`Duplicate page id: ${def.id}`);
    seenIds.add(def.id);

    if (!def.title.trim()) throw new PageDefinitionError(`Page ${def.id} needs a title.`);
    if (!def.purpose.trim()) {
      // The consolidation brief in one rule: a page a reader cannot tell the point of is what
      // 269 auto-generated pages already are.
      throw new PageDefinitionError(
        `Page ${def.id} needs a purpose — a page nobody can state the point of is the problem being fixed.`,
      );
    }
    if (def.sources.length === 0) {
      throw new PageDefinitionError(`Page ${def.id} declares no sources — it would be about nothing.`);
    }

    // Section+slug is the file path; two pages agreeing on both would overwrite each other.
    const path = `${slugify(def.section)}/${def.slug?.trim() ? slugify(def.slug) : slugify(def.title)}`;
    if (seenPaths.has(path)) throw new PageDefinitionError(`Two pages resolve to the same path: ${path}`);
    seenPaths.add(path);
  }
}

/**
 * One honest line about what a composition would publish — INCLUDING what it would not.
 *
 * Written here rather than in the caller so the caveat travels with the number. "12 pages" is a
 * fine headline and a misleading one if 250 entities quietly stopped being published.
 */
export function describeComposition(report: CompositionReport): string {
  const published = report.pages.reduce((n, p) => n + p.entityCount, 0);
  const parts = [
    `${report.pages.length} page${report.pages.length === 1 ? '' : 's'} `
    + `covering ${published} entit${published === 1 ? 'y' : 'ies'}.`,
  ];
  if (report.orphans.length > 0) {
    parts.push(
      `${report.orphans.length} entit${report.orphans.length === 1 ? 'y is' : 'ies are'} `
      + `claimed by no page and would NOT be published.`,
    );
  }
  if (report.duplicated.length > 0) {
    parts.push(`${report.duplicated.length} appear on more than one page.`);
  }
  if (report.excluded.length > 0) {
    parts.push(`${report.excluded.length} deliberately excluded.`);
  }
  if (report.emptyPages.length > 0) {
    parts.push(`${report.emptyPages.length} page(s) matched nothing: ${report.emptyPages.join(', ')}.`);
  }
  return parts.join(' ');
}
