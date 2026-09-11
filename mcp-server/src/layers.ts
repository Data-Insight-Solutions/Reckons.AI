/**
 * RELATION LAYERS AT THE TOOL BOUNDARY (F194) — claim, provenance, question.
 *
 * Matt, 2026-09-09: "For MCP and tool use, lets get detailed responses for claims, questions, and
 * provenance recorded. The first two being about the human added content, the provenance about the
 * extraction process, assumptions, etc."
 *
 * WHY THIS MATTERS MORE AT THE MCP BOUNDARY THAN IN THE APP. A person reading a page can tell a
 * claim from a filename. An agent reading a flat list of predicates cannot, and it is agents that
 * consume this server. Handing back `.has-file package.json` beside `.principle The graph is the
 * plan` as though they were the same kind of statement invites exactly the confusion the layers
 * exist to remove — and an agent that cannot tell what a human SETTLED from what a machine
 * RECORDED will treat both as equally authoritative.
 *
 * THE DEFAULT IS `claim`, ALWAYS, and it is a safety property rather than a convenience. Because
 * provenance auto-confirms (Matt's decision, same day), a predicate wrongly read as provenance
 * would present machine bookkeeping as settled human knowledge. Unclassified therefore means
 * claim: the layer that still requires a person.
 *
 * TWO SOURCES OF TRUTH, IN THIS ORDER:
 *   1. kpred:layer on the predicate, read from the graphs. Authoritative.
 *   2. A structural fallback for namespaces that are provenance BY CONSTRUCTION — urn:kbase:meta/
 *      and the PROV vocabulary describe how a statement got here and never what it says. This is
 *      not a guess about meaning; those namespaces have no other purpose.
 * Nothing else is inferred. A predicate whose NAME merely looks like a file path stays a claim.
 */

export type Layer = 'claim' | 'provenance' | 'question';

export const LAYER_PREDICATE = 'urn:kbase:predicate/layer';
const LAYER_SCHEME_PREFIX = 'urn:kbase:type/layer/';

/** Namespaces that are provenance by construction rather than by classification. */
const STRUCTURAL_PROVENANCE = [
  'urn:kbase:meta/',
  'http://www.w3.org/ns/prov#',
  'urn:reckons:meta/',
];

/**
 * Individual predicates that are provenance by construction, not by namespace.
 *
 * ADDED 2026-09-11, AND IT WAS A REAL MISCLASSIFICATION, not tidying. `kpred:extracted-from` sits
 * under urn:kbase:predicate/ like every claim does, so it fell through to the `claim` fail-safe and
 * every tool response has been filing "where this text came from" alongside what the graph knows.
 * src/lib/rdf/captured-notes.ts already called it "a RECORD the extractor derived and can
 * re-derive"; nothing had written that down where a script could read it.
 *
 * Surfaced by the set-derivation stage (F187.3): grouping by it proposed a set for three of four
 * candidates on a real graph, all wrong. A bug in one feature found a misclassification affecting
 * three.
 *
 * The same list exists in src/lib/rdf/set-derive.ts — deliberately duplicated, not imported, since
 * a cross-package import is what broke CI on 2026-09-10. They must stay in step.
 */
const STRUCTURAL_PROVENANCE_PREDICATES = [
  'urn:kbase:predicate/extracted-from',
  'urn:kbase:predicate/assumption',
  'urn:kbase:predicate/derived-from',
  'urn:kbase:predicate/source',
];

/**
 * Predicates that ASK rather than assert.
 *
 * Kept minimal on purpose. kpred:open-question is the house term and carries 143 uses; everything
 * else earns its place by being classified in the graph. `kpred:remaining` is deliberately NOT
 * here — Matt, 2026-09-09: "plan isn't really a question." Its values read "DONE WHEN speakText
 * routes by voiceType", which is a plan somebody decided, not something left open.
 */
const STRUCTURAL_QUESTION = ['urn:kbase:predicate/open-question'];

export interface LayerMap {
  /** predicate IRI -> layer, as declared in the graph by kpred:layer. */
  declared: Map<string, Layer>;
  /** How many predicates carry an explicit classification — reported, never guessed at. */
  declaredCount: number;
}

interface TripleLike { subject: string; predicate: string; object: string }

const isLayer = (v: string): v is Layer =>
  v === 'claim' || v === 'provenance' || v === 'question';

/**
 * Read kpred:layer assignments out of the corpus.
 *
 * Accepts both an object value (the klayer: IRI) and a literal notation, because a classification
 * may arrive either way — as a triple written by hand or as a proposal drained from the queue.
 */
export function loadLayerMap(triples: TripleLike[]): LayerMap {
  const declared = new Map<string, Layer>();
  for (const t of triples) {
    if (t.predicate !== LAYER_PREDICATE) continue;
    const raw = t.object.startsWith(LAYER_SCHEME_PREFIX)
      ? t.object.slice(LAYER_SCHEME_PREFIX.length)
      : t.object;
    if (isLayer(raw)) declared.set(t.subject, raw);
  }
  return { declared, declaredCount: declared.size };
}

/** Which layer does this predicate belong to? Unclassified is `claim`, deliberately. */
export function layerOf(predicate: string, map: LayerMap): Layer {
  const declared = map.declared.get(predicate);
  if (declared) return declared;
  if (STRUCTURAL_PROVENANCE.some((ns) => predicate.startsWith(ns))) return 'provenance';
  if (STRUCTURAL_PROVENANCE_PREDICATES.includes(predicate)) return 'provenance';
  if (STRUCTURAL_QUESTION.includes(predicate)) return 'question';
  return 'claim';
}

export interface Layered<T> {
  claim: T[];
  question: T[];
  provenance: T[];
}

/** Split triples three ways, preserving input order within each layer. */
export function groupByLayer<T extends TripleLike>(triples: T[], map: LayerMap): Layered<T> {
  const out: Layered<T> = { claim: [], question: [], provenance: [] };
  for (const t of triples) out[layerOf(t.predicate, map)].push(t);
  return out;
}

/**
 * Render an entity's triples with the layers named, for a tool response.
 *
 * ORDER IS THE ARGUMENT: claims first because they are what a person settled, questions next
 * because they are what is still open and what an agent could usefully help with, provenance last
 * because it is how the rest got here. An agent reading only the first section has read the
 * knowledge; one reading only the last has read the bookkeeping.
 *
 * SAYS WHEN NOTHING IS CLASSIFIED. If the corpus carries no kpred:layer at all, everything lands
 * in `claim` by the fail-safe default and the grouping is honest but uninformative. Announcing
 * that is the difference between "this entity has no provenance" and "nothing here is classified
 * yet, so I cannot tell you".
 */
export function renderLayered(
  triples: TripleLike[],
  map: LayerMap,
  opts: { max?: number } = {},
): string[] {
  const max = opts.max ?? 40;
  const g = groupByLayer(triples.slice(0, max), map);
  const short = (iri: string) => iri.split(/[/#]/).filter(Boolean).pop() ?? iri;

  const lines: string[] = [];
  const section = (title: string, rows: TripleLike[], note?: string) => {
    if (rows.length === 0) return;
    lines.push(`${title} (${rows.length})${note ? ` — ${note}` : ''}`);
    for (const t of rows) lines.push(`  .${short(t.predicate)} ${t.object}`);
  };

  section('CLAIMS', g.claim, 'asserted about the world; a person settles these');
  section('QUESTIONS', g.question, 'left open on purpose; answered, not confirmed');
  section('PROVENANCE', g.provenance, 'how this got here — source, run, assumptions');

  if (map.declaredCount === 0) {
    lines.push('');
    lines.push('NOTE: no predicate in this corpus carries kpred:layer yet, so everything not');
    lines.push('structurally provenance defaults to CLAIM. That is the fail-safe, not a finding.');
  }
  return lines;
}
