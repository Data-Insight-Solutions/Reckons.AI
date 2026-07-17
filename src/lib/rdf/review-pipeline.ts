/**
 * The review pipeline — one front door to the review-at-scale system.
 *
 * Four pieces, composed in the order that makes review humane:
 *   1. DEDUPE (F80.1) — fold exact-duplicate pending facts, so the same finding is never triaged
 *      twice. (Partial facts are left alone; see dedupeCompletePending.)
 *   2. ROUTE (F88) — split what remains by WHO is competent to settle it: machine / agent / user.
 *      Most of the queue never needed the human.
 *   3. SPOTLIGHT (F53) — within the USER lane, surface the few CONTESTED decisions and let the
 *      uncontested flow quietly, capped to a manageable number.
 *   4. ENTITY CARDS (F83) — group the user lane by subject, so the human decides about THINGS
 *      (~233 cards) rather than rows (~1888).
 *
 * This is a pure read over the graph: it plans the review, it settles nothing. The UI renders the
 * plan; approving still goes through the normal per-statement flow. Having ONE function means the
 * order and the composition are tested in one place, not re-assembled (differently) at each call
 * site.
 */
import type { Statement } from './types';
import { dedupeCompletePending, findMergeSuggestions, type DuplicateGroup } from './pending-dedup';
import { routeQueue, type RoutedQueue } from './review-routing';
import { spotlightUserQueue, type AttentionQueue } from './review-attention';
import { groupPendingByEntity, type EntityReviewCard } from './entity-review';

export interface ReviewPlan {
  /** Facts after exact-duplicate folding — the input to everything downstream. */
  deduped: Statement[];
  /** How many exact duplicates were folded away before review. */
  folded: number;
  /** The queue split by competence (machine / agent / user), each ranked by blast radius. */
  routed: RoutedQueue;
  /** Within the user lane: the capped spotlight of contested decisions + the quiet flow. */
  attention: AttentionQueue;
  /** The user lane grouped into per-entity cards (decide about things, not rows). */
  entityCards: EntityReviewCard[];
  /**
   * Near-duplicate merge SUGGESTIONS (F80.1 suggest tier, the 0.5-0.9 band) — same-predicate
   * facts a human might want to merge. Empty unless a `similarity` function is supplied; these are
   * surfaced for review, never acted on.
   */
  mergeSuggestions: DuplicateGroup[];
}

export interface ReviewPlanOptions {
  /** Resolve a subject IRI to its rdf:type, so F88 authority reservations hold. */
  typeOf?: (subjectIri: string) => string | undefined;
  /** Cap on spotlighted decisions (F53). */
  maxSpotlight?: number;
  /**
   * Semantic similarity between two facts (embeddings, injected so the pipeline stays pure). When
   * given, the suggest tier runs and populates `mergeSuggestions`; when omitted, only exact
   * duplicates are handled and `mergeSuggestions` is empty.
   */
  similarity?: (a: Statement, b: Statement) => number;
}

/**
 * Build the whole review plan from a pending set. `allStatements` defaults to the same pending
 * set, but pass the WHOLE graph when you have it — conflict detection (F53) reads better against
 * the full picture than the pending slice alone.
 */
export function buildReviewPlan(
  pending: Statement[],
  opts: ReviewPlanOptions = {},
  allStatements: Statement[] = pending,
): ReviewPlan {
  const typeOf = opts.typeOf ?? (() => undefined);

  // 1. DEDUPE
  const { kept: deduped, folded } = dedupeCompletePending(pending);

  // 2. ROUTE by competence
  const routed = routeQueue(deduped, typeOf);

  // 3. SPOTLIGHT the user lane's contested few
  const attention = spotlightUserQueue(routed.user, allStatements, { maxSpotlight: opts.maxSpotlight });

  // 4. ENTITY CARDS for the user lane (decide about things, not rows)
  const entityCards = groupPendingByEntity(
    routed.user.map((it) => it.statement),
    typeOf,
  );

  // 5. SUGGEST tier (optional): near-duplicate merges, only when a similarity source is supplied.
  const mergeSuggestions = opts.similarity ? findMergeSuggestions(deduped, opts.similarity) : [];

  return { deduped, folded, routed, attention, entityCards, mergeSuggestions };
}

/** One honest headline for the whole plan: what was spared, what needs you. */
export function reviewPlanSummary(plan: ReviewPlan): string {
  const machineOrAgent = plan.routed.machine.length + plan.routed.agent.length;
  const yours = plan.routed.user.length;
  const parts: string[] = [];
  if (plan.folded) parts.push(`${plan.folded} duplicate${plan.folded === 1 ? '' : 's'} folded`);
  if (machineOrAgent) parts.push(`${machineOrAgent} settled without you`);
  if (yours === 0) return `${parts.join(', ') || 'Nothing pending'} — nothing left for you to decide.`;
  const spotlight = plan.attention.spotlight.length;
  const held = plan.attention.heldBack > 0 ? ` (+${plan.attention.heldBack} waiting)` : '';
  parts.push(`${plan.entityCards.length} entit${plan.entityCards.length === 1 ? 'y' : 'ies'} yours, ${spotlight} in the spotlight${held}`);
  return `${parts.join('; ')}.`;
}
