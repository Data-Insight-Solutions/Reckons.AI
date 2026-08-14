/**
 * Age sweep (F97) — decide WHICH entities have aged out of the current window.
 *
 * This is the missing half of the archive feature. `archive.ts` knows how to move facts out and
 * journal the move; `archive-store.ts` knows how to persist that against Dexie. Neither of them
 * has an opinion about *when* something is old, and until this module existed nothing did — so
 * the storage layer, the retention policy and the gallery display all worked and no user action
 * could produce a single archived fact.
 *
 * Everything here is PURE: statements + a threshold + a clock, in; a PLAN, out. Nothing is moved.
 * The plan is meant to be shown to the user before anything happens, because an age sweep is a
 * destructive-shaped operation and "N facts will move" is the only honest way to ask for consent.
 *
 * Three rules decide what is old, and each of them exists to avoid a specific silent loss:
 *
 * 1. An entity is judged by its NEWEST date, not its oldest. A project started in 2019 and touched
 *    last week is current; archiving it because its first fact is old would remove live knowledge
 *    while the user watched a number go down and called it tidying.
 *
 * 2. An UNDATED entity is never swept. The feature's promise is "events older than a threshold",
 *    and an entity carrying no date is not old — it is undated. Falling back to `createdAt` (when
 *    the fact was ingested) would quietly turn this into "archive things I imported a while ago",
 *    which is a different and much more destructive feature than the one the user asked for. The
 *    plan REPORTS how many entities it skipped for this reason rather than hiding the limit.
 *
 * 3. An entity with UNREVIEWED facts is held back. Archiving by subject-or-object would carry
 *    pending facts into the archive graph, and the review queue would silently shrink — the user
 *    would never learn there had been something to decide. Held entities are named, not merely
 *    counted, so the user can go and settle them.
 */

import { statementTouchesEntities } from './archive';
import { EVENT_DATE_PREDICATES, parseGraphDate } from './parse-date';
import type { Statement } from './types';

export interface AgeSweepPolicy {
  /** Facts whose newest event date is older than this many days are eligible. */
  olderThanDays: number;
  /** Injected for testability; defaults to the real clock. */
  now?: number;
}

export interface AgeSweepPlan {
  /** Entity IRIs to archive, sorted. Empty means there is nothing to do. */
  entities: string[];
  /** Exactly how many statements would move, using the mover's own touch rule. */
  statementCount: number;
  /** Instant before which an event counts as aged out. */
  cutoff: number;
  /** Dated entities inside the window — left where they are. */
  recentCount: number;
  /** Entities with no parseable event date. Never swept; reported so the gap is visible. */
  undatedCount: number;
  /** Old enough, but carrying unreviewed facts. Named so the user can settle them. */
  heldForReview: string[];
  /** Newest event date among the entities being archived, or undefined when none are. */
  newestArchived?: number;
}

export class AgeSweepPolicyError extends Error {}

/** Statuses that mean a fact is still awaiting a human decision. */
const UNREVIEWED = new Set(['pending', 'pending-removal']);
/** Statuses whose dates carry no weight — the same rule the timeline layout applies. */
const IGNORED_FOR_DATING = new Set(['rejected', 'superseded']);

const DAY_MS = 86_400_000;

/**
 * Work out what an age sweep would do, without doing any of it.
 *
 * Rejects a non-positive or non-finite threshold rather than defaulting: `olderThanDays: 0` means
 * "everything dated is old", which would move an entire graph into the archive on one click. A
 * threshold the caller failed to supply must not be interpretable as that.
 */
export function planAgeSweep(statements: Statement[], policy: AgeSweepPolicy): AgeSweepPlan {
  const { olderThanDays } = policy;
  if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
    throw new AgeSweepPolicyError(
      `Age threshold must be a positive number of days, received: ${olderThanDays}`,
    );
  }

  const now = policy.now ?? Date.now();
  const cutoff = now - olderThanDays * DAY_MS;

  // Newest event date per entity. Only subjects are dated: `alex --attended--> meetup` says when
  // the MEETUP is, not when Alex is, so crediting the object with the date would age out every
  // person who ever appeared at an old event.
  const newestDate = new Map<string, number>();
  for (const st of statements) {
    if (IGNORED_FOR_DATING.has(st.status)) continue;
    if (!EVENT_DATE_PREDICATES.has(st.p.value)) continue;
    if (st.s.kind !== 'iri') continue;
    const ts = parseGraphDate(st.o.value);
    if (ts === undefined) continue;
    const existing = newestDate.get(st.s.value);
    if (existing === undefined || ts > existing) newestDate.set(st.s.value, ts);
  }

  // Every IRI that appears anywhere, so "undated" counts real graph nodes rather than only the
  // ones that happen to be subjects of something.
  const allEntities = new Set<string>();
  for (const st of statements) {
    if (st.s.kind === 'iri') allEntities.add(st.s.value);
    if (st.o.kind === 'iri') allEntities.add(st.o.value);
  }

  let recentCount = 0;
  const aged: string[] = [];
  for (const entity of allEntities) {
    const ts = newestDate.get(entity);
    if (ts === undefined) continue; // undated — counted below, never swept
    if (ts < cutoff) aged.push(entity);
    else recentCount++;
  }

  const undatedCount = allEntities.size - newestDate.size;

  // Hold anything whose move would swallow an unsettled decision. Checked with the MOVER's rule
  // (subject or object), because that is what would actually be carried into the archive.
  const agedSet = new Set(aged);
  const held = new Set<string>();
  for (const st of statements) {
    if (!UNREVIEWED.has(st.status)) continue;
    if (st.s.kind === 'iri' && agedSet.has(st.s.value)) held.add(st.s.value);
    if (st.o.kind === 'iri' && agedSet.has(st.o.value)) held.add(st.o.value);
  }

  const entities = aged.filter((e) => !held.has(e)).sort();
  const targets = new Set(entities);

  let statementCount = 0;
  for (const st of statements) if (statementTouchesEntities(st, targets)) statementCount++;

  let newestArchived: number | undefined;
  for (const entity of entities) {
    const ts = newestDate.get(entity);
    if (ts !== undefined && (newestArchived === undefined || ts > newestArchived)) {
      newestArchived = ts;
    }
  }

  return {
    entities,
    statementCount,
    cutoff,
    recentCount,
    undatedCount,
    heldForReview: [...held].sort(),
    newestArchived,
  };
}

/**
 * One honest sentence describing what a plan would do — including what it will NOT touch.
 *
 * Written here rather than in the component so the wording is testable, and so the caveats travel
 * with the number. A sweep that says "42 facts" while silently skipping 300 undated nodes has told
 * the user something true and left them with a false picture.
 */
export function describeAgeSweep(plan: AgeSweepPlan): string {
  if (plan.entities.length === 0) {
    const reasons: string[] = [];
    if (plan.heldForReview.length > 0) {
      reasons.push(`${plan.heldForReview.length} held for review`);
    }
    if (plan.undatedCount > 0) reasons.push(`${plan.undatedCount} undated`);
    const tail = reasons.length > 0 ? ` (${reasons.join(', ')})` : '';
    return `Nothing to archive${tail}.`;
  }

  const parts = [
    `${plan.statementCount} fact${plan.statementCount === 1 ? '' : 's'} across ` +
      `${plan.entities.length} entit${plan.entities.length === 1 ? 'y' : 'ies'} would move to the archive.`,
  ];
  if (plan.undatedCount > 0) {
    parts.push(`${plan.undatedCount} undated entit${plan.undatedCount === 1 ? 'y is' : 'ies are'} never swept.`);
  }
  if (plan.heldForReview.length > 0) {
    parts.push(
      `${plan.heldForReview.length} old entit${plan.heldForReview.length === 1 ? 'y is' : 'ies are'} ` +
        `held back because they carry unreviewed facts.`,
    );
  }
  return parts.join(' ');
}
