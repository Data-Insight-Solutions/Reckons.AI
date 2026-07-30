/**
 * Website graph reader (F27.3) — standard RDF in, composition input out.
 *
 * `static/website.ttl` describes the whole site in ONE graph using standard vocabularies:
 * schema.org for the site and its pages, VoID for the datasets each page is built from. This
 * module is the only place that knows those terms. `page-composition.ts` stays vocabulary-
 * agnostic and takes plain objects, so the vocabulary can change without touching the logic that
 * decides what gets published — and, more usefully, so the composition rules can be tested
 * without a parser.
 *
 * WHY THESE TERMS. They already exist for exactly this job, and the project already uses
 * dcterms, foaf, owl, prov and skos, so inventing `urn:reckons:page/sources-graph` was the
 * outlier rather than the convention:
 *
 *   schema:isBasedOn — "a resource from which this work is derived". That IS the source
 *                      relation. Repeatable, so one page derives from several datasets.
 *   schema:about     — the subject matter of the content: a page about one named entity.
 *   schema:abstract  — why a reader would open the page.
 *   schema:hasPart / schema:isPartOf — site structure, readable from either end.
 *   void:Dataset     — the standard description of an RDF dataset. `dcterms:source` carries the
 *                      file so a generator resolves a page's datasets without a lookup table.
 *
 * ONE HONEST DEPARTURE: there is no standard term for "this subtree is deliberately not
 * published, and here is why". `schema:creativeWorkStatus` and `dcterms:accessRights` describe a
 * resource's own state, not an editorial rule about a set of them, so exclusions use a local
 * `urn:reckons:page/excludes-under`. Bending a standard term into meaning something it does not
 * would be worse than a clearly-labelled local one.
 */

/**
 * Structural shape of an n3 Quad, declared locally rather than imported.
 *
 * `import type { Quad } from 'n3'` resolves to a NAMESPACE in this project's TypeScript config,
 * not a type, so it cannot be used in a type position. Declaring what is actually read also
 * keeps this module usable from a test that hand-builds quads without pulling in the parser.
 */
interface Quad {
  subject: { value: string };
  predicate: { value: string };
  object: { value: string };
}
import type { ExclusionRule, PageDefinition, PageSource } from './page-composition';

// ── Vocabulary ───────────────────────────────────────────────────────────────
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const DCTERMS = 'http://purl.org/dc/terms/';
const VOID = 'http://rdfs.org/ns/void#';

/**
 * schema.org is served over https and published under both schemes; graphs in the wild use
 * either. Both are accepted on read so a hand-edited file does not silently match nothing —
 * a page whose type failed to parse would simply not exist, with no error to explain it.
 */
const SCHEMA_PREFIXES = ['https://schema.org/', 'http://schema.org/'] as const;
const schemaTerm = (local: string) => SCHEMA_PREFIXES.map((p) => `${p}${local}`);

const WEBSITE_TYPES = schemaTerm('WebSite');
const WEBPAGE_TYPES = schemaTerm('WebPage');
const NAME = schemaTerm('name');
const ABSTRACT = schemaTerm('abstract');
const URL = schemaTerm('url');
const POSITION = schemaTerm('position');
const IS_BASED_ON = schemaTerm('isBasedOn');
const ABOUT = schemaTerm('about');
const IS_PART_OF = schemaTerm('isPartOf');
const HAS_PART = schemaTerm('hasPart');

const VOID_DATASET = `${VOID}Dataset`;
const DCTERMS_TITLE = `${DCTERMS}title`;
const DCTERMS_SOURCE = `${DCTERMS}source`;
const DCTERMS_DESCRIPTION = `${DCTERMS}description`;

/** The one local term. See the module doc for why no standard term fits. */
const EXCLUDES_UNDER = 'urn:reckons:page/excludes-under';
const EXCLUDES_ENTITY = 'urn:reckons:page/excludes-entity';

export interface DatasetRef {
  iri: string;
  title: string;
  /** The graph file, e.g. "docs-features.ttl". */
  file: string;
}

export interface WebsiteGraph {
  siteIri: string | null;
  siteName: string;
  datasets: DatasetRef[];
  pages: PageDefinition[];
  exclusions: ExclusionRule[];
  /** Problems that would otherwise make a page silently not exist. Never thrown away. */
  problems: string[];
}

const localName = (iri: string): string => iri.split(/[/#]/).filter(Boolean).pop() ?? iri;

/**
 * Read a website graph into the shape `composePages` consumes.
 *
 * Returns `problems` rather than throwing on a page that cannot be resolved. A page naming a
 * dataset that does not exist is a typo the author must see; throwing would abort the whole
 * report and tell them about one problem at a time, and silently skipping the page would let the
 * site lose a section with nothing to explain it.
 */
export function readWebsiteGraph(quads: Quad[], sectionName = 'Docs'): WebsiteGraph {
  const problems: string[] = [];
  const has = (p: string, terms: readonly string[]) => terms.includes(p);

  // ── Datasets ───────────────────────────────────────────────────────────────
  const datasetIris = new Set<string>();
  for (const q of quads) {
    if (q.predicate.value === RDF_TYPE && q.object.value === VOID_DATASET) datasetIris.add(q.subject.value);
  }

  const datasets: DatasetRef[] = [];
  const fileByIri = new Map<string, string>();
  for (const iri of [...datasetIris].sort()) {
    const own = quads.filter((q) => q.subject.value === iri);
    const one = (p: string) => own.find((q) => q.predicate.value === p)?.object.value;
    const file = one(DCTERMS_SOURCE);
    if (!file) {
      problems.push(`Dataset ${localName(iri)} has no dcterms:source, so nothing can resolve it to a graph file.`);
      continue;
    }
    datasets.push({ iri, title: one(DCTERMS_TITLE) ?? localName(iri), file });
    fileByIri.set(iri, file);
  }

  // ── Site ───────────────────────────────────────────────────────────────────
  let siteIri: string | null = null;
  let siteName = '';
  for (const q of quads) {
    if (q.predicate.value === RDF_TYPE && has(q.object.value, WEBSITE_TYPES)) {
      siteIri = q.subject.value;
      break;
    }
  }
  if (siteIri) {
    siteName = quads.find((q) => q.subject.value === siteIri && has(q.predicate.value, NAME))?.object.value ?? '';
  }

  // ── Pages ──────────────────────────────────────────────────────────────────
  // Read from BOTH ends of the structure relation: a page may declare schema:isPartOf, or the
  // site may declare schema:hasPart, and a graph that states only one should not lose pages.
  const pageIris = new Set<string>();
  for (const q of quads) {
    if (q.predicate.value === RDF_TYPE && has(q.object.value, WEBPAGE_TYPES)) pageIris.add(q.subject.value);
  }
  if (siteIri) {
    for (const q of quads) {
      if (q.subject.value === siteIri && has(q.predicate.value, HAS_PART)) pageIris.add(q.object.value);
      if (q.object.value === siteIri && has(q.predicate.value, IS_PART_OF)) pageIris.add(q.subject.value);
    }
  }

  const pages: PageDefinition[] = [];
  for (const iri of pageIris) {
    const own = quads.filter((q) => q.subject.value === iri);
    if (own.length === 0) {
      problems.push(`Page ${localName(iri)} is referenced by the site but has no statements of its own.`);
      continue;
    }
    const one = (terms: readonly string[]) =>
      own.find((q) => has(q.predicate.value, terms))?.object.value;
    const many = (terms: readonly string[]) =>
      own.filter((q) => has(q.predicate.value, terms)).map((q) => q.object.value);

    const sources: PageSource[] = [];
    for (const dsIri of many(IS_BASED_ON)) {
      const file = fileByIri.get(dsIri);
      if (!file) {
        problems.push(
          `Page ${localName(iri)} is based on ${localName(dsIri)}, which is not a void:Dataset in this graph.`,
        );
        continue;
      }
      sources.push({ kind: 'graph', graph: file });
    }
    for (const entity of many(ABOUT)) sources.push({ kind: 'entity', iri: entity });

    const title = one(NAME) ?? localName(iri);
    pages.push({
      id: localName(iri),
      title,
      slug: one(URL) || undefined,
      section: sectionName,
      purpose: one(ABSTRACT) ?? '',
      order: Number(one(POSITION) ?? 0),
      sources,
    });
  }
  pages.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title));

  // ── Exclusions ─────────────────────────────────────────────────────────────
  const exclusionIris = new Set<string>();
  for (const q of quads) {
    if (q.predicate.value === EXCLUDES_UNDER || q.predicate.value === EXCLUDES_ENTITY) {
      exclusionIris.add(q.subject.value);
    }
  }
  const exclusions: ExclusionRule[] = [...exclusionIris].sort().map((iri) => {
    const own = quads.filter((q) => q.subject.value === iri);
    const one = (p: string) => own.find((q) => q.predicate.value === p)?.object.value;
    return {
      id: one(RDFS_LABEL) ?? localName(iri),
      reason: one(DCTERMS_DESCRIPTION) ?? '',
      under: one(EXCLUDES_UNDER),
      entity: one(EXCLUDES_ENTITY),
    };
  });

  return { siteIri, siteName, datasets, pages, exclusions, problems };
}

// ── The meta-graph: how the datasets inter-relate ────────────────────────────

export interface DatasetOverlap {
  /** The two dataset FILES, sorted, so a pair is reported once. */
  a: string;
  b: string;
  /** Entity IRIs asserted in both. */
  shared: string[];
}

/**
 * Which datasets assert the same entities.
 *
 * This is the "how do my graphs inter-relate" view, and it is DERIVED, never hand-maintained —
 * a hand-written claim that two graphs overlap is exactly the kind of unverifiable assertion the
 * project's own thesis rejects.
 *
 * It is deliberately NOT emitted as `void:Linkset`. A Linkset describes triples whose subject is
 * in one dataset and object in another; two datasets independently asserting facts about the
 * SAME IRI is a different relation, and labelling it with a standard term that means something
 * else would be a more expensive mistake than having no term for it.
 *
 * Why it matters for composition: an entity in two datasets lands on both pages that source from
 * them, so this is the list of things that will appear twice before anyone has to look at a
 * rendered site to find out.
 */
export function datasetOverlaps(
  entities: Array<{ iri: string; graph: string }>,
): DatasetOverlap[] {
  const graphsByEntity = new Map<string, Set<string>>();
  for (const e of entities) {
    if (!graphsByEntity.has(e.iri)) graphsByEntity.set(e.iri, new Set());
    graphsByEntity.get(e.iri)!.add(e.graph);
  }

  const pairs = new Map<string, string[]>();
  for (const [iri, graphs] of graphsByEntity) {
    if (graphs.size < 2) continue;
    const sorted = [...graphs].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]} ${sorted[j]}`;
        pairs.set(key, [...(pairs.get(key) ?? []), iri]);
      }
    }
  }

  return [...pairs.entries()]
    .map(([key, shared]) => {
      const [a, b] = key.split(' ');
      return { a, b, shared: [...shared].sort() };
    })
    .sort((x, y) => y.shared.length - x.shared.length || x.a.localeCompare(y.a));
}
