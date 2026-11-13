/**
 * A fact's standing (F223.9 / kb:fact-standing).
 *
 * One pure function gives every fact a STANDING from fields it already has, with no new
 * status: the review status stays what it is; standing is what the status MEANS on the canvas.
 *
 *   held      confirmed or refined — a person has settled it.
 *   pending   awaiting review, part of no proposal.
 *   proposed  awaiting review AND belonging to an option of a reckoning's proposal.
 *   question  a partial fact: its object is open (needsObject, F32).
 *
 * PROPOSED vs PENDING is the only distinction that needs a new field. A pending fact
 * records which option of a proposal it belongs to in `proposalOption`, the same way F89.4.4
 * records its run — so an option is a group whose MEMBERS ARE DERIVED, not listed: no
 * membership edges to write, nothing to keep in sync when an option gains or loses a row.
 *
 * the marker-level function answers the other half of the phase: a marker's standing is the standing of
 * the facts that touch it, with held winning — a marker a held fact touches is held,
 * whatever else hangs off it.
 *
 * The canvas (F223.10) draws from these; the filters (F223.11) resolve by them. This module
 * decides nothing and draws nothing — it only names what a fact already is.
 */
import type { Statement } from './types';

export type Standing = 'held' | 'pending' | 'proposed' | 'question';

/**
 * The standing of one fact.
 *
 * Order matters and is the rule: a question is a question whatever its status says (the
 * object is open — that outranks everything, because there is nothing to hold or propose
 * until an object exists); then held beats pending; proposed is pending that names an option.
 */
export function standingOf(statement: Statement): Standing {
  if (statement.needsObject === true) return 'question';
  if (statement.status === 'confirmed' || statement.status === 'refined') return 'held';
  if (statement.status === 'pending' && statement.proposalOption) return 'proposed';
  return 'pending';
}

/**
 * The standing of a MARKER, from the facts that touch it.
 *
 * held wins (a marker a held fact touches is held, whatever else hangs off it); else a marker
 * touched ONLY by questions is a question; else a marker touched only by proposed facts
 * (and nothing else) is proposed; else it is pending.
 */
export function nodeStanding(statements: Statement[]): Standing {
  if (statements.some((st) => standingOf(st) === 'held')) return 'held';
  if (statements.length > 0 && statements.every((st) => standingOf(st) === 'question')) return 'question';
  const nonQuestion = statements.filter((st) => standingOf(st) !== 'question');
  if (nonQuestion.length > 0 && nonQuestion.every((st) => standingOf(st) === 'proposed')) return 'proposed';
  return 'pending';
}
