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
import { ALTITUDE_RANK, altitudeOf, liftedAltitudes, type Altitude } from './fact-altitude';

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
  /**
   * Hide facts BELOW this altitude from the canvas. Undefined draws everything.
   *
   * WHY THIS REMOVES RATHER THAN DIMS, against the house rule that a filter is a lens.
   * Every other filter here is a SELECTION — "show me hubs", "show me this type" — where the
   * unselected facts are still the thing you are looking at, so dimming them to 0.18 alpha
   * focuses without lying, and removing them made the layout jump. Altitude is not a selection.
   * It is a statement about whether a fact is reviewable CONTENT at all: a `log` "asserts only
   * that something happened", and ALTITUDE_META marks it unreviewable because the person who
   * would confirm it is the person who did it. Dimming 73% of the graph leaves 73% of the
   * clutter, still in the force simulation, still occupying the space the user is complaining
   * about. So the floor removes from the CANVAS — and from nowhere else.
   *
   * Three things keep that honest. Lifted altitude (below) never hides a log that a live
   * decision rests on. `hidden` reports exactly what went, because a hidden thing must be
   * visibly hidden. And a hidden fact still reaches the node panel as an attribute, so the
   * record is one click away rather than gone.
   */
  minAltitude?: Altitude;
}

/** What an altitude floor took off the canvas. Never let something be invisibly hidden. */
export interface HiddenByAltitude {
  /** Facts below the floor. They remain in the graph, and in the node panel. */
  statements: number;
  /** Per altitude, so a control can say what lowering the floor would bring back. */
  byAltitude: Record<Altitude, number>;
  /** Nodes that vanished entirely because every edge touching them was below the floor. */
  nodes: number;
  /**
   * Ids of the statements the floor removed.
   *
   * The renderers need this and a COUNT will not do. Their attribute rule — "a unique literal is
   * an attribute, so keep its subject visible even when this is the entity's only fact" — is right
   * for attributes and wrong for a floored fact: it resurrects the very node the floor was asked
   * to hide. Telling them WHICH exclusions came from the floor is what separates the two.
   */
  statementIds: Set<string>;
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
  /** What `minAltitude` removed. All zeroes when no floor is set. */
  hidden: HiddenByAltitude;
}

const NO_ALTITUDE_HIDDEN: HiddenByAltitude = {
  statements: 0,
  byAltitude: { decision: 0, judgment: 0, evidence: 0, record: 0, log: 0 },
  nodes: 0,
  statementIds: new Set(),
};

/** Node keys an edge set would put on the canvas. */
function nodeKeysOf(edges: Statement[]): Set<string> {
  const keys = new Set<string>();
  for (const st of edges) {
    keys.add(termKey(st.s));
    keys.add(termKey(st.o));
  }
  return keys;
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
  const { categoryNodes = true, predicates, since, until, minAltitude } = opts;

  const inWindow = (st: Statement) =>
    (since === undefined || st.createdAt >= since) && (until === undefined || st.createdAt <= until);

  const filtered = statements.filter(
    (st) => inWindow(st) && (!predicates || predicates.size === 0 || predicates.has(st.p.value)),
  );

  // LIFTED, NOT RAW. `liftedAltitudes` pulls a fact up to the altitude of any OPEN decision on
  // its subject, which is the rule that makes hiding safe: a log contradicting the evidence
  // under a live decision IS a deciding factor, and a floor reading raw altitude would be
  // exactly the design that could never surface it. Computed over ALL statements rather than
  // the windowed set, so narrowing a date range cannot accidentally drop the decision doing
  // the lifting and hide a fact that was visible a moment ago.
  const lifted = minAltitude ? liftedAltitudes(statements) : null;
  const floor = minAltitude ? ALTITUDE_RANK[minAltitude] : Number.NEGATIVE_INFINITY;
  const altitudeOfDrawn = (st: Statement): Altitude => lifted?.get(st.id) ?? altitudeOf(st);
  const aboveFloor = (st: Statement) => !lifted || ALTITUDE_RANK[altitudeOfDrawn(st)] >= floor;

  const drawable = lifted ? filtered.filter(aboveFloor) : filtered;

  // Categories come from the DRAWABLE set: a literal shared only among hidden facts is not a
  // category anybody can see, and minting a node for it would leave an orphan on the canvas
  // with every edge that justified it removed.
  const categories = categoryNodes ? categoryLiterals(drawable) : new Set<string>();

  const edges: Statement[] = [];
  const attributes = new Map<string, Statement[]>();

  // Iterate the FULL windowed set, not `drawable`. Anything the floor removed falls through to
  // `attributes`, so opening the node still shows it. Hidden from the picture, not from the
  // record — which is the same distinction the review tree draws when it collapses logs into a
  // drawer instead of dropping them.
  for (const st of filtered) {
    if (aboveFloor(st) && isNodeTerm(st.o, categories)) {
      edges.push(st);
    } else {
      const key = termKey(st.s);
      const list = attributes.get(key) ?? [];
      list.push(st);
      attributes.set(key, list);
    }
  }

  return { edges, attributes, categories, hidden: summarizeHidden() };

  function summarizeHidden(): HiddenByAltitude {
    if (!lifted) return NO_ALTITUDE_HIDDEN;

    const byAltitude: Record<Altitude, number> = {
      decision: 0, judgment: 0, evidence: 0, record: 0, log: 0,
    };
    let count = 0;
    const statementIds = new Set<string>();
    for (const st of filtered) {
      if (aboveFloor(st)) continue;
      byAltitude[altitudeOfDrawn(st)]++;
      statementIds.add(st.id);
      count++;
    }

    // What the canvas WOULD have shown with no floor, so "nodes" is the number that actually
    // disappeared rather than the number of facts removed. Those differ by a lot: hiding 900
    // provenance edges may remove three nodes or three hundred, and only one of those numbers
    // answers "is my graph less cluttered".
    const openCategories = categoryNodes ? categoryLiterals(filtered) : new Set<string>();
    const openEdges = filtered.filter((st) => isNodeTerm(st.o, openCategories));
    const shown = nodeKeysOf(edges);
    let vanished = 0;
    for (const key of nodeKeysOf(openEdges)) if (!shown.has(key)) vanished++;

    return { statements: count, byAltitude, nodes: vanished, statementIds };
  }
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

/**
 * The most-connected node keys — the skeleton of a graph.
 *
 * Extracted so the hubs FILTER and the top rung of the detail ladder cannot drift apart. They are
 * the same question asked for two purposes: "which nodes hold this graph together?"
 *
 * The threshold is relative, not absolute: twice the median degree, floored at 3. A fixed cut-off
 * would call everything a hub in a dense graph and nothing a hub in a sparse one, and the answer
 * that matters is which nodes are unusually connected FOR THIS GRAPH.
 *
 * TWO GATES ON TOP OF DEGREE, because degree alone gets this WRONG (Matt, 2026-08-28: "note file
 * names (log level) can be classified as a hub because of other rules of connection count").
 *
 *   1. SUBSTANTIVE DEGREE. A dictated note accumulates one kpred:extracted-from edge for every
 *      triple read out of it, so a single sentence can out-rank a real concept on raw count. But
 *      all of those edges are RECORDS: they say the pipeline ran, not that the note means
 *      anything. A node whose every edge is a record or a log is bookkeeping with a high fan-out,
 *      and this rule denies it hub status regardless of degree. It needs no entity type, which
 *      matters because captured note entities carry none.
 *   2. `eligible` — the caller's type gate. Hubs should be concepts, people, organizations; a
 *      Document or Web Page can be a hub but rarely is, so the caller decides from the user's own
 *      type settings. Absent, everything is eligible and only rule 1 applies.
 */
export function hubNodeKeys(
  edges: Statement[],
  limit = Number.POSITIVE_INFINITY,
  opts: { eligible?: (nodeKey: string) => boolean } = {},
): string[] {
  const degrees = new Map<string, number>();
  // A node's SUBSTANTIVE degree: how many of its edges are more than bookkeeping.
  const substantive = new Map<string, number>();

  for (const st of edges) {
    const sk = termKey(st.s);
    const ok = termKey(st.o);
    degrees.set(sk, (degrees.get(sk) ?? 0) + 1);
    degrees.set(ok, (degrees.get(ok) ?? 0) + 1);
    if (ALTITUDE_RANK[altitudeOf(st)] > ALTITUDE_RANK.record) {
      substantive.set(sk, (substantive.get(sk) ?? 0) + 1);
      substantive.set(ok, (substantive.get(ok) ?? 0) + 1);
    }
  }

  // The median is taken over EVERY node, including the ineligible ones. They are really there and
  // really connected; excluding them would make the graph look sparser than it is and drag the
  // threshold down. Eligibility governs who can BE a hub, not what a typical degree looks like.
  const entries = [...degrees.entries()].sort(([, a], [, b]) => b - a);
  if (entries.length === 0) return [];
  const median = entries[Math.floor(entries.length / 2)][1];
  const minDeg = Math.max(median * 2, 3);

  return entries
    .filter(([key, d]) => d >= minDeg && (substantive.get(key) ?? 0) > 0 && (opts.eligible?.(key) ?? true))
    .slice(0, limit)
    .map(([key]) => key);
}

/**
 * Edges where BOTH ends are hubs — the graph of the skeleton, not the skeleton plus everything
 * hanging off it.
 *
 * Keeping edges with only ONE hub end drags every leaf back in, which is the opposite of what the
 * top of a zoom-out ladder is for.
 */
export function hubOnlyEdges(edges: Statement[], hubKeys: Iterable<string>): Statement[] {
  const hubs = new Set(hubKeys);
  return edges.filter((st) => hubs.has(termKey(st.s)) && hubs.has(termKey(st.o)));
}
