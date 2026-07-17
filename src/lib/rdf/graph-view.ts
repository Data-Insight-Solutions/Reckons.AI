/**
 * Graph legibility (F83 / kb:graph-legibility).
 *
 * THE BUG THIS FIXES: the graph view turned EVERY object into a node — including literals.
 * So a 265-character `kpred:description` became a node. Reckons.AI's own roadmap has 1,888
 * triples but only 233 real entities; it was rendering as ~1,234 nodes, most of them
 * dangling walls of text. On a phone it is simply unusable, and the roadmap is the first
 * graph anyone will open.
 *
 * THE RULE: A LITERAL EARNS A NODE BY BEING SHARED.
 *
 *   "production"  appears 53 times  → a category. Every feature that is production hangs
 *                                     off it. That is real structure worth seeing.
 *   a description appears once      → it connects nothing. It is an ATTRIBUTE of its
 *                                     subject, and belongs in the node panel, not the canvas.
 *
 * Measured on reckons-roadmap.ttl: of 990 distinct literal values, 953 (96%) appear exactly
 * ONCE. Rendering them as nodes adds 953 leaves that can never link anything to anything.
 *
 * This is the same principle as kb:predicate-economy, applied to values instead of edges:
 * a graph's power comes from what is SHARED. A unique value generalizes nothing, and an
 * edge to it teaches nobody anything.
 *
 * Nodes: 1,234 → 271. The graph does not get smaller; it stops lying about what is in it.
 */
import type { Statement, Term } from './types';
import { termKey, isIRI, isLit } from './types';

/**
 * A literal must be at least this short to be a category. Long strings are prose — even
 * if two features happen to share the identical sentence, a paragraph is not a category.
 */
export const MAX_CATEGORY_LITERAL_LENGTH = 40;

/** A literal must appear at least this many times to earn a node rather than be an attribute. */
export const MIN_SHARED_FOR_NODE = 2;

export interface GraphViewOptions {
  /** Render shared, short literals as category nodes ("production", "high"). Default true. */
  categoryNodes?: boolean;
  /** Only these predicates become edges. Empty/undefined = all. */
  predicates?: Set<string>;
  /** Only statements created within this window (ms epoch). */
  since?: number;
  until?: number;
}

export interface GraphView {
  /** Statements that draw an edge between two nodes. */
  edges: Statement[];
  /**
   * Statements whose object is an attribute of the subject, keyed by subject term key.
   * These are NOT drawn — they belong in the node panel.
   */
  attributes: Map<string, Statement[]>;
  /** Literal values that earned a node by being shared. */
  categories: Set<string>;
}

/**
 * Which literal values are shared often enough, and short enough, to be categories?
 * Everything else is an attribute.
 */
export function categoryLiterals(statements: Statement[]): Set<string> {
  const counts = new Map<string, number>();
  for (const st of statements) {
    if (!isLit(st.o)) continue;
    if (st.o.value.length > MAX_CATEGORY_LITERAL_LENGTH) continue; // prose is never a category
    counts.set(st.o.value, (counts.get(st.o.value) ?? 0) + 1);
  }

  const shared = new Set<string>();
  for (const [value, n] of counts) {
    if (n >= MIN_SHARED_FOR_NODE) shared.add(value);
  }
  return shared;
}

/** Does this term become a node in the rendered graph? */
export function isNodeTerm(term: Term, categories: Set<string>): boolean {
  if (isIRI(term)) return true;                       // entities are always nodes
  if (isLit(term)) return categories.has(term.value); // literals only when shared
  return false;                                        // blank nodes: not rendered
}

/**
 * Split statements into what the canvas DRAWS and what the node panel SHOWS.
 *
 * The distinction is the whole point: a graph is a picture of RELATIONSHIPS. A value that
 * relates nothing to nothing is not part of that picture, however important it is to read.
 */
export function buildGraphView(statements: Statement[], opts: GraphViewOptions = {}): GraphView {
  const { categoryNodes = true, predicates, since, until } = opts;

  const inWindow = (st: Statement) =>
    (since === undefined || st.createdAt >= since) && (until === undefined || st.createdAt <= until);

  const filtered = statements.filter(
    (st) => inWindow(st) && (!predicates || predicates.size === 0 || predicates.has(st.p.value)),
  );

  const categories = categoryNodes ? categoryLiterals(filtered) : new Set<string>();

  const edges: Statement[] = [];
  const attributes = new Map<string, Statement[]>();

  for (const st of filtered) {
    if (isNodeTerm(st.o, categories)) {
      edges.push(st);
    } else {
      const key = termKey(st.s);
      const list = attributes.get(key) ?? [];
      list.push(st);
      attributes.set(key, list);
    }
  }

  return { edges, attributes, categories };
}

/**
 * Predicates in use, with counts — for a "show only these relations" filter.
 *
 * Sorted by count so the filter surfaces the structural predicates first. The user should
 * be able to say "just show me depends-on" and see the dependency graph, rather than
 * hunting for it inside everything else.
 */
export function predicateFacets(statements: Statement[]): { iri: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const st of statements) counts.set(st.p.value, (counts.get(st.p.value) ?? 0) + 1);

  return [...counts.entries()]
    .map(([iri, count]) => ({ iri, label: iri.split(/[/#]/).pop() ?? iri, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * The time range the graph spans — for a time slider.
 * Returns null when there is nothing to bound.
 */
export function timeRange(statements: Statement[]): { min: number; max: number } | null {
  if (statements.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const st of statements) {
    if (st.createdAt < min) min = st.createdAt;
    if (st.createdAt > max) max = st.createdAt;
  }
  return Number.isFinite(min) ? { min, max } : null;
}

/**
 * Progressive disclosure: the N most-connected nodes and the edges among them.
 *
 * The same trick kb_compress plays for an LLM — do not hand over the whole graph, hand
 * over the part that matters. A human has a context window too, and 1,234 nodes overruns
 * it exactly as surely as 116k tokens overruns a model's.
 *
 * Edges are kept only when BOTH endpoints survive, so the view never shows an edge
 * disappearing into nothing.
 */
export function topByDegree(edges: Statement[], limit: number): Statement[] {
  if (edges.length === 0 || limit <= 0) return [];

  const degree = new Map<string, number>();
  for (const st of edges) {
    const s = termKey(st.s);
    const o = termKey(st.o);
    degree.set(s, (degree.get(s) ?? 0) + 1);
    degree.set(o, (degree.get(o) ?? 0) + 1);
  }

  const keep = new Set(
    [...degree.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([k]) => k),
  );

  return edges.filter((st) => keep.has(termKey(st.s)) && keep.has(termKey(st.o)));
}
