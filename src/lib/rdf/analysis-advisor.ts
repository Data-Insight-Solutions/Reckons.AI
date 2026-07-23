/**
 * Analysis advisor — "given the state this graph is actually in, what should the user do next?"
 *
 * The app offers five LLM analyses (enrich, merge, entity-types, delete, align) plus two
 * model-free prunes. That is a menu, and a menu is a tax on the user: picking the wrong analysis
 * costs tokens AND produces suggestions that bury the ones that mattered. The commonest failure
 * is not picking wrong, though — it is OVERFILL: the user adds sources enthusiastically, the
 * pending queue outruns their reviewing, and the graph stalls behind a wall of unreviewed facts.
 *
 * DETERMINISTIC AND MODEL-FREE, by design (F74.3 work-tiering). Every signal below is countable
 * from the statements themselves, so this runs offline, in CI, at zero tokens, and cannot
 * hallucinate a recommendation. A model is only worth promoting to when a rule provably cannot
 * express the judgment — that is not the case for "your pending queue is 400 deep".
 *
 * HONEST LIMITS — these are thresholds, not intelligence:
 *  - Duplicate detection is exact-match on normalized labels. It finds "Acme Corp" vs "acme corp",
 *    NOT "Acme Corp" vs "Acme Corporation". That is what the `merge` ANALYSIS is for; this only
 *    decides whether running it is likely to be worth the tokens.
 *  - Thresholds are judgment calls, not measured optima. They are exposed in AdvisorOptions so the
 *    upcoming fixture benchmark can tune them against real accept-rates rather than guesswork.
 *  - A recommendation is a SUGGESTION for a human, never an action. Nothing here mutates a graph.
 */

import type { Statement } from './types';
import { isMetaPredicate } from './types';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** What the advisor can point the user at. Superset of AnalysisType: includes the free prunes. */
export type AdvisedAction =
  | 'review'
  | 'prune-suggestions'
  | 'prune-nodes'
  | 'merge'
  | 'entity-types'
  | 'enrich'
  | 'answer-questions'
  | 'align'
  | 'inspect-churn';

/** Countable facts about the graph's current state. All cheap, all model-free. */
export interface GraphSignals {
  totalStatements: number;
  /** Statements awaiting review (pending + pending-removal). */
  pendingCount: number;
  /** Pending as a fraction of all statements — the "overfill" signal. */
  pendingRatio: number;
  /** Distinct sources that have contributed at least one still-pending statement. */
  unreviewedSources: number;
  /** Distinct IRI subjects among active statements. */
  entityCount: number;
  /** Fraction of entities sharing a normalized label with another entity. */
  duplicateLabelRate: number;
  /** Fraction of entities carrying no rdf:type. */
  untypedRate: number;
  /** Fraction of entities with <=2 non-meta edges from a single source. */
  islandRate: number;
  /** Partial facts (F32) whose object is still an open question. */
  openQuestions: number;
  /** Open questions that block at least one other entity — these cost the most to leave. */
  blockingQuestions: number;
}

export interface Recommendation {
  action: AdvisedAction;
  /** 0..1 urgency. Sorted descending; the caller usually shows the top 1-3. */
  urgency: number;
  /** Why this is being suggested, in the user's terms. Shown in the UI. */
  reason: string;
  /** True when this action costs no tokens (deterministic or pure review). */
  free: boolean;
}

export interface AdvisorOptions {
  /** pendingRatio above this means the queue is outrunning review. Default 0.35. */
  overfillRatio?: number;
  /** Absolute pending count that is overwhelming regardless of ratio. Default 150. */
  overfillCount?: number;
  /** duplicateLabelRate above this makes `merge` worth its tokens. Default 0.08. */
  duplicateFloor?: number;
  /** untypedRate above this makes `entity-types` worth its tokens. Default 0.3. */
  untypedFloor?: number;
  /** islandRate above this makes `enrich` worth its tokens. Default 0.25. */
  islandFloor?: number;
  /** Graph is too small for LLM analysis to have anything to work with. Default 12. */
  minEntitiesForAnalysis?: number;
  /**
   * Entities the archive journal reports as churning (F97.6). Passed in rather than computed here
   * so this module stays free of any archive dependency — the advisor reasons about signals, it
   * does not go and fetch them.
   */
  churningEntities?: string[];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const localName = (iri: string) => iri.split(/[/#]/).pop() ?? iri;
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

const isPending = (st: Statement) => st.status === 'pending' || st.status === 'pending-removal';
/** Statements that count as "in the graph" — excludes rejected/superseded noise. */
const isActive = (st: Statement) =>
  st.status === 'confirmed' || st.status === 'refined' || isPending(st);

/**
 * Compute every signal in one pass over the statements. Pure: same input, same output, no clock
 * and no I/O, so it is safe to call on every graph change and trivial to test.
 */
export function computeSignals(statements: Statement[]): GraphSignals {
  const active = statements.filter(isActive);
  const pending = active.filter(isPending);

  const degree = new Map<string, number>();
  const sources = new Map<string, Set<string>>();
  const labels = new Map<string, string>();
  const typed = new Set<string>();

  for (const st of active) {
    if (st.s.kind !== 'iri') continue;
    const s = st.s.value;
    if (!degree.has(s)) { degree.set(s, 0); sources.set(s, new Set()); }
    sources.get(s)!.add(st.sourceId);

    if (st.p.value === RDF_TYPE) { typed.add(s); continue; }
    if (isMetaPredicate(st.p.value)) continue;
    if (st.p.value === RDFS_LABEL) { labels.set(s, st.o.value); continue; }
    degree.set(s, (degree.get(s) ?? 0) + 1);
  }

  const entities = [...degree.keys()];
  const entityCount = entities.length;

  // Duplicate labels: entities that share a normalized label with at least one other entity.
  const byLabel = new Map<string, number>();
  for (const e of entities) {
    const l = norm(labels.get(e) ?? localName(e));
    byLabel.set(l, (byLabel.get(l) ?? 0) + 1);
  }
  let duplicated = 0;
  for (const n of byLabel.values()) if (n > 1) duplicated += n;

  const untyped = entities.filter((e) => !typed.has(e)).length;
  const islands = entities.filter((e) => (degree.get(e) ?? 0) <= 2 && (sources.get(e)?.size ?? 0) <= 1).length;

  const openQ = active.filter((st) => st.needsObject);
  const blockingQ = openQ.filter((st) => (st.blocks?.length ?? 0) > 0);

  const div = (n: number, d: number) => (d === 0 ? 0 : n / d);

  return {
    totalStatements: active.length,
    pendingCount: pending.length,
    pendingRatio: div(pending.length, active.length),
    unreviewedSources: new Set(pending.map((st) => st.sourceId)).size,
    entityCount,
    duplicateLabelRate: div(duplicated, entityCount),
    untypedRate: div(untyped, entityCount),
    islandRate: div(islands, entityCount),
    openQuestions: openQ.length,
    blockingQuestions: blockingQ.length,
  };
}

/**
 * Turn signals into an ordered list of what to do next.
 *
 * ORDERING PRINCIPLE: free actions that UNBLOCK come before paid actions that ADD. Recommending
 * an LLM enrich to someone with 400 unreviewed facts is actively harmful — it deepens the queue
 * they are already drowning in. So review and prune outrank every analysis while the queue is hot.
 */
export function recommendActions(signals: GraphSignals, opts: AdvisorOptions = {}): Recommendation[] {
  const {
    overfillRatio = 0.35,
    overfillCount = 150,
    duplicateFloor = 0.08,
    untypedFloor = 0.3,
    islandFloor = 0.25,
    minEntitiesForAnalysis = 12,
    churningEntities = [],
  } = opts;

  const recs: Recommendation[] = [];

  // ── Churn (F97.6): the archive is telling us the PIPELINE is noisy ──────────
  // Deliberately framed as a source/prompt problem, not a user problem: an entity that keeps
  // coming back and being archived again means something upstream keeps re-extracting it.
  if (churningEntities.length > 0) {
    recs.push({
      action: 'inspect-churn',
      urgency: Math.min(0.85, 0.5 + 0.05 * churningEntities.length),
      reason:
        `${churningEntities.length} entit${churningEntities.length === 1 ? 'y keeps' : 'ies keep'} ` +
        `being re-added and archived. That usually means a noisy source or extraction prompt, not indecision.`,
      free: true,
    });
  }
  const overfilled = signals.pendingRatio > overfillRatio || signals.pendingCount > overfillCount;

  // ── The overfill case: added a lot, reviewed little ──────────────────────────
  if (overfilled) {
    // Urgency scales with how far past the line they are, capped at 1.
    const byRatio = signals.pendingRatio / Math.max(overfillRatio, 0.01);
    const byCount = signals.pendingCount / Math.max(overfillCount, 1);
    recs.push({
      action: 'review',
      urgency: Math.min(1, 0.6 + 0.4 * Math.min(1, Math.max(byRatio, byCount) - 1)),
      reason:
        `${signals.pendingCount} facts from ${signals.unreviewedSources} source(s) are waiting for review ` +
        `(${Math.round(signals.pendingRatio * 100)}% of the graph). Adding more before reviewing will bury them.`,
      free: true,
    });
    // Prune the QUEUE, not the graph — clears re-derivable/stale noise so review is tractable.
    recs.push({
      action: 'prune-suggestions',
      urgency: 0.7,
      reason: 'Clear re-derivable, empty, and stale entries so the review queue is worth reading.',
      free: true,
    });
  }

  // ── Open questions: the highest-value thing a graph can tell you (F80) ───────
  if (signals.blockingQuestions > 0) {
    recs.push({
      action: 'answer-questions',
      urgency: Math.min(0.95, 0.5 + 0.05 * signals.blockingQuestions),
      reason:
        `${signals.blockingQuestions} unanswered question(s) are blocking other facts. ` +
        `Answering them unblocks more than they cost.`,
      free: true,
    });
  } else if (signals.openQuestions > 0) {
    recs.push({
      action: 'answer-questions',
      urgency: 0.4,
      reason: `${signals.openQuestions} partial fact(s) still have an open object.`,
      free: true,
    });
  }

  // ── Paid analyses: only once there is enough graph for them to reason over ───
  const bigEnough = signals.entityCount >= minEntitiesForAnalysis;

  if (bigEnough && signals.duplicateLabelRate > duplicateFloor) {
    recs.push({
      action: 'merge',
      urgency: Math.min(0.8, 0.3 + signals.duplicateLabelRate * 2),
      reason:
        `${Math.round(signals.duplicateLabelRate * 100)}% of entities share a label with another. ` +
        `Merge analysis will find the ones that are the same thing.`,
      free: false,
    });
  }

  if (bigEnough && signals.untypedRate > untypedFloor) {
    recs.push({
      action: 'entity-types',
      urgency: Math.min(0.7, 0.25 + signals.untypedRate * 0.6),
      reason: `${Math.round(signals.untypedRate * 100)}% of entities have no type. Typing them improves grouping and filtering.`,
      free: false,
    });
  }

  if (bigEnough && signals.islandRate > islandFloor) {
    // Islands are ambiguous: they are either under-connected (enrich) or clutter (prune). Offer
    // the FREE read first — prune costs nothing and tells you which of the two you are looking at.
    recs.push({
      action: 'prune-nodes',
      urgency: 0.45,
      reason: `${Math.round(signals.islandRate * 100)}% of entities are weakly connected. Score them before spending tokens enriching clutter.`,
      free: true,
    });
    recs.push({
      action: 'enrich',
      urgency: 0.35,
      reason: 'Sparse entities may be missing relations that connect them to the rest of the graph.',
      free: false,
    });
  }

  return recs.sort((a, b) => b.urgency - a.urgency);
}

/** Convenience: signals → ordered recommendations in one call. */
export function adviseGraph(statements: Statement[], opts: AdvisorOptions = {}): Recommendation[] {
  return recommendActions(computeSignals(statements), opts);
}
