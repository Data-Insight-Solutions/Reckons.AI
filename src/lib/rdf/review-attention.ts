/**
 * Review at scale — spotlight the decisions (F53, kb:review-attention).
 *
 * Review has an attention budget. Spend it on the few CONTESTED decisions, not the many obvious
 * facts — or the human learns to "accept all" and review becomes theatre. The principles:
 *   - Granularity breeds rubber-stamping: condense to a manageable few at a time.
 *   - Spend attention on DISAGREEMENT, not agreement: conflicts and decisions get the spotlight;
 *     fresh uncontested facts flow through quietly.
 *
 * This layers ON TOP of F88 routing (review-routing.ts). routeQueue already removes what a
 * machine or an agent can settle — this operates on the USER lane, the items only the human can
 * decide, and splits THAT into a small spotlight and a quiet flow. It is pure: it ranks and
 * buckets, it never settles anything.
 */
import type { Statement } from './types';
import type { RoutedItem } from './review-routing';
import { findDichotomies } from './dichotomy';

/** The signals that earn a pending item the human's scarce attention. */
export interface AttentionSignals {
  /** The item is in a CONFLICT (one entity, two incompatible values) — the strongest signal. */
  conflict: boolean;
  /** Transitive blast radius: how much is stalled behind this (from routeQueue). */
  impact: number;
  /** A DECISION the human must make — a partial fact / open question (F32), not a settled value. */
  decision: boolean;
}

const W_CONFLICT = 0.6;
const W_DECISION = 0.3;
const W_IMPACT = 0.3; // scaled by impact / maxImpact
/** At or above this, an item is worth the spotlight even without a conflict/decision flag. */
export const SPOTLIGHT_THRESHOLD = 0.5;
/** "A manageable few at a time" — the default cap on how many decisions we surface at once. */
export const DEFAULT_MAX_SPOTLIGHT = 7;

/**
 * Attention weight in [0,1]. Conflict dominates; a decision is next; blast radius nudges. A plain
 * uncontested fact (no conflict, no decision, low impact) scores near zero — it flows quietly.
 * `maxImpact` normalizes blast radius against the loudest item in the same batch.
 */
export function attentionScore(s: AttentionSignals, maxImpact: number): number {
  let score = 0;
  if (s.conflict) score += W_CONFLICT;
  if (s.decision) score += W_DECISION;
  if (maxImpact > 0 && s.impact > 0) score += W_IMPACT * Math.min(1, s.impact / maxImpact);
  return Math.min(1, score);
}

export type AttentionBucket = 'spotlight' | 'quiet';

export interface AttentionItem {
  statement: Statement;
  score: number;
  bucket: AttentionBucket;
  conflict: boolean;
  decision: boolean;
  impact: number;
}

export interface AttentionQueue {
  /** The few to look at NOW — capped, ranked by score. */
  spotlight: AttentionItem[];
  /** Uncontested items that can flow through quietly / be batch-accepted. */
  quiet: AttentionItem[];
  /** Spotlight-worthy items beyond the cap — waiting for the next pass, NOT quieted. */
  heldBack: number;
}

/** Key an entity+predicate pair the way a conflict is identified, so lookups are O(1). */
const cpKey = (entityIri: string, predicate: string) => `${entityIri}${predicate}`;

/**
 * Split the user lane into a small spotlight and a quiet flow. `allStatements` is the whole graph
 * (conflict detection needs the full picture, not just the pending slice). `maxSpotlight` caps the
 * spotlight so the human is never handed a wall of decisions — the overflow is counted in
 * `heldBack`, never dumped into `quiet` (hiding a contested item is the one thing we must not do).
 */
export function spotlightUserQueue(
  userLane: RoutedItem[],
  allStatements: Statement[],
  opts: { maxSpotlight?: number; minIdentity?: number } = {},
): AttentionQueue {
  const maxSpotlight = opts.maxSpotlight ?? DEFAULT_MAX_SPOTLIGHT;

  // Which (entity, predicate) pairs are in genuine CONFLICT (not a natural multi-valued dichotomy).
  const conflicts = new Set(
    findDichotomies(allStatements, opts.minIdentity)
      .filter((d) => d.kind === 'conflict')
      .map((d) => cpKey(d.entityIri, d.predicate)),
  );

  const maxImpact = userLane.reduce((m, it) => Math.max(m, it.impact), 0);

  const scored: AttentionItem[] = userLane.map((it) => {
    const conflict = conflicts.has(cpKey(it.statement.s.value, it.statement.p.value));
    const decision = it.statement.needsObject === true;
    const score = attentionScore({ conflict, impact: it.impact, decision }, maxImpact);
    const spotlightWorthy = conflict || decision || score >= SPOTLIGHT_THRESHOLD;
    return {
      statement: it.statement,
      score,
      bucket: spotlightWorthy ? 'spotlight' : 'quiet',
      conflict,
      decision,
      impact: it.impact,
    };
  });

  // Highest attention first; ties break toward the OLDER item (a long-unfilled hole is not an
  // accident). Deterministic final tiebreak on id.
  const rank = (a: AttentionItem, b: AttentionItem) =>
    b.score - a.score || a.statement.createdAt - b.statement.createdAt || a.statement.id.localeCompare(b.statement.id);

  const spotlightAll = scored.filter((i) => i.bucket === 'spotlight').sort(rank);
  const quiet = scored.filter((i) => i.bucket === 'quiet').sort(rank);

  return {
    spotlight: spotlightAll.slice(0, maxSpotlight),
    quiet,
    heldBack: Math.max(0, spotlightAll.length - maxSpotlight),
  };
}

/** Honest one-line headline for the attention split. */
export function attentionSummary(q: AttentionQueue): string {
  const shown = q.spotlight.length;
  if (shown === 0 && q.quiet.length === 0) return 'Nothing for you to decide.';
  const more = q.heldBack > 0 ? ` (+${q.heldBack} more waiting)` : '';
  const quiet = q.quiet.length > 0 ? `, ${q.quiet.length} flowing through quietly` : '';
  return `${shown} decision${shown === 1 ? '' : 's'} in the spotlight${more}${quiet}.`;
}
