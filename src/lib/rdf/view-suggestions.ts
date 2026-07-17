/**
 * Context-aware view suggestions (F85 / kb:view-suggestions).
 *
 * Shelly and the notification stack should offer the RIGHT filter or force for what the
 * user is actually looking at — "you have 47 events spanning eight months; want to lay
 * them out on a timeline?" — and say NOTHING otherwise.
 *
 * THE RULE, and it is the same one as everywhere else in this codebase:
 *
 *   A SUGGESTION MUST BE EARNED BY THE DATA.
 *
 * An unearned suggestion is not merely useless, it is corrosive: it trains the user to
 * ignore the suggester, and then the one good suggestion — the one that would have saved
 * them ten minutes in a 1,200-node hairball — goes unread with all the rest. A nag that
 * fires on a timer is a forced link wearing a different costume (kb:predicate-economy):
 * it looks like help and it is not.
 *
 * So every suggestion here carries its EVIDENCE, and no rule fires unless the evidence
 * genuinely exists in the current view. Zero suggestions is the correct and common answer.
 *
 * Pure: no stores, no side effects, testable.
 */
import type { Statement } from './types';
import { isLit, isIRI, termKey } from './types';
import type { GraphFilter } from '../types/turtle-chat';

const XSD_DATE = 'http://www.w3.org/2001/XMLSchema#date';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** Layouts the graph can actually render. Kept in sync with KnowledgeGraph.svelte. */
export type GraphLayout =
  | 'force'
  | 'focus'
  | 'source'
  | 'type'
  | 'hub'
  | 'timeline'
  | 'order'
  | 'hierarchy';

export interface ViewContext {
  /** Statements currently drawn (post-filter). */
  visible: Statement[];
  /** How many nodes are on screen. */
  nodeCount: number;
  /** Layout in use right now — never suggest the one they already have. */
  layout: GraphLayout;
  /** Entity-type IRIs the user has selected, if any. */
  selectedTypes?: Set<string>;
  /** Distinct sources represented in the view. */
  sourceCount?: number;
}

export interface ViewSuggestion {
  id: string;
  /** What we are offering, in the user's language. */
  headline: string;
  /** WHY we are offering it — the evidence. Shown, never implied. */
  evidence: string;
  /** The change to apply if they accept. */
  adjust: { layout?: GraphLayout; filters?: GraphFilter[] };
  /** Higher = more confident it helps. Callers should show at most one or two. */
  weight: number;
}

/** Dates found in the visible facts — the evidence a timeline suggestion needs. */
export interface TemporalSpread {
  count: number;
  min: number;
  max: number;
  spanDays: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Does this view actually contain time?
 *
 * We accept a properly typed xsd:date/dateTime, or an ISO-8601-looking string — because
 * real graphs are full of untyped dates, and refusing to see them would make the feature
 * useless exactly where it is most needed.
 */
export function temporalSpread(statements: Statement[]): TemporalSpread | null {
  const times: number[] = [];

  for (const st of statements) {
    if (!isLit(st.o)) continue;
    const dt = st.o.datatype;
    const looksTemporal = dt === XSD_DATE || dt === XSD_DATETIME || ISO_DATE.test(st.o.value);
    if (!looksTemporal) continue;

    const t = Date.parse(st.o.value);
    if (Number.isFinite(t)) times.push(t);
  }

  if (times.length === 0) return null;

  const min = Math.min(...times);
  const max = Math.max(...times);
  return {
    count: times.length,
    min,
    max,
    spanDays: (max - min) / 86_400_000,
  };
}

/** Distinct rdf:type values present in the view. */
export function typeSpread(statements: Statement[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const st of statements) {
    if (st.p.value !== RDF_TYPE || !isIRI(st.o)) continue;
    counts.set(st.o.value, (counts.get(st.o.value) ?? 0) + 1);
  }
  return counts;
}

/** How lopsided is the connectivity? A few hubs and a long tail is worth saying so. */
export function hubSkew(statements: Statement[]): { topDegree: number; median: number } | null {
  if (statements.length === 0) return null;

  const degree = new Map<string, number>();
  for (const st of statements) {
    const s = termKey(st.s);
    const o = termKey(st.o);
    degree.set(s, (degree.get(s) ?? 0) + 1);
    degree.set(o, (degree.get(o) ?? 0) + 1);
  }

  const sorted = [...degree.values()].sort((a, b) => b - a);
  if (sorted.length === 0) return null;
  return { topDegree: sorted[0], median: sorted[Math.floor(sorted.length / 2)] };
}

// ── Thresholds. Deliberately conservative: a suggestion that fires too easily is worse
// than one that never fires, because it costs the user's trust in ALL of them.
const MIN_DATED_FACTS = 3;
const MIN_SPAN_DAYS = 1;
const MIN_TYPES_FOR_TYPE_LAYOUT = 3;
const CROWDED_NODE_COUNT = 150;
const HUB_SKEW_RATIO = 4;
const MIN_SOURCES_FOR_SOURCE_LAYOUT = 3;

/**
 * What is worth offering, given what is on screen right now.
 *
 * Returns [] — the correct and common answer — when nothing is warranted. Never suggests
 * the layout the user is already in.
 */
export function suggestForView(ctx: ViewContext): ViewSuggestion[] {
  const out: ViewSuggestion[] = [];
  const { visible, nodeCount, layout, selectedTypes, sourceCount = 0 } = ctx;

  if (visible.length === 0) return out;

  // ── Time. The motivating case: the user has selected event/calendar types, and those
  // facts carry real dates. Do NOT offer a timeline for a graph with no time in it.
  const time = temporalSpread(visible);
  if (
    layout !== 'timeline' &&
    time &&
    time.count >= MIN_DATED_FACTS &&
    time.spanDays >= MIN_SPAN_DAYS
  ) {
    const span =
      time.spanDays >= 60
        ? `${Math.round(time.spanDays / 30)} months`
        : `${Math.round(time.spanDays)} days`;
    const scoped = selectedTypes && selectedTypes.size > 0 ? ' in the types you have selected' : '';

    out.push({
      id: 'layout-timeline',
      headline: 'Lay these out on a timeline?',
      evidence: `${time.count} of the facts on screen${scoped} carry dates, spanning ${span}.`,
      adjust: { layout: 'timeline' },
      // Dated facts are strong evidence; a user who selected event types wants time.
      weight: selectedTypes && selectedTypes.size > 0 ? 0.9 : 0.7,
    });
  }

  // ── Types. Many kinds of thing mixed together cluster better when grouped.
  const types = typeSpread(visible);
  if (layout !== 'type' && types.size >= MIN_TYPES_FOR_TYPE_LAYOUT) {
    out.push({
      id: 'layout-type',
      headline: 'Group by entity type?',
      evidence: `There are ${types.size} different kinds of thing on screen.`,
      adjust: { layout: 'type' },
      weight: 0.5,
    });
  }

  // ── Crowding. This is the F83 problem the user hit on the roadmap graph: too much on
  // screen to read. Offer the hubs rather than making them squint at everything.
  const skew = hubSkew(visible);
  if (
    nodeCount >= CROWDED_NODE_COUNT &&
    skew &&
    skew.median > 0 &&
    skew.topDegree / skew.median >= HUB_SKEW_RATIO
  ) {
    out.push({
      id: 'filter-hubs',
      headline: 'Show only the hubs?',
      evidence: `${nodeCount} nodes on screen, and the busiest is ${Math.round(
        skew.topDegree / skew.median,
      )}x more connected than typical — the shape is a few hubs and a long tail.`,
      adjust: { filters: ['hubs'] },
      weight: 0.8,
    });
  }

  // ── Sources. Several documents in one view: grouping shows who said what.
  if (layout !== 'source' && sourceCount >= MIN_SOURCES_FOR_SOURCE_LAYOUT) {
    out.push({
      id: 'layout-source',
      headline: 'Group by source?',
      evidence: `These facts came from ${sourceCount} different sources.`,
      adjust: { layout: 'source' },
      weight: 0.6,
    });
  }

  return out.sort((a, b) => b.weight - a.weight);
}

/**
 * The single best suggestion, or none.
 *
 * Callers should prefer this over the full list. Offering a menu of five things to try is
 * not help — it is homework, and it is how a helpful feature becomes one the user mutes.
 */
export function bestSuggestion(ctx: ViewContext, minWeight = 0.6): ViewSuggestion | null {
  const [top] = suggestForView(ctx);
  return top && top.weight >= minWeight ? top : null;
}
