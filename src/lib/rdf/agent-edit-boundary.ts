/**
 * The agent-edit boundary — the wall of F52 (kb:control-model), "the key differentiating feature".
 *
 * The principle, verbatim from the roadmap:
 *   "The human holds the fact-edit right. Agents PROPOSE (pending) on knowledge/facts and may
 *    edit plan/code/roadmap TTL directly — that boundary is control, and today it is CONVENTION,
 *    NOT ENFORCEMENT. Make it a wall: fact-level agent writes go through review."
 *
 * This module turns that convention into an enforceable rule. It is pure: it does not write, it
 * decides. The decision is deliberately one-directional and fail-safe — when in doubt, an agent's
 * fact write is DOWNGRADED to a proposal, never upgraded to a settled fact. A silently-settled
 * agent write is exactly the failure the whole product exists to prevent: an unverifiable claim,
 * entered by the party that benefits, presented as established knowledge.
 *
 * Composition with F88 (verifiability): this decides WHO MAY WRITE a fact (agents propose,
 * humans hold the edit right). F88's competentGate then decides WHO MAY APPROVE the resulting
 * pending item (machine for code/test-checkable facts, a human otherwise). F52 routes to review;
 * F88 clears review. They are orthogonal and must both hold.
 */
import type { ReviewStatus } from './types';

/** Who is making the write. An agent is any non-human writer (local model, MCP client, script). */
export type Actor = 'agent' | 'human';

/**
 * A settled status asserts the fact as established. An agent may never land one directly — that
 * is the whole boundary. (pending / pending-removal are proposals; rejected / superseded are
 * terminal dispositions a review produced, not fresh assertions.)
 */
export const SETTLED_STATUSES: readonly ReviewStatus[] = ['confirmed', 'refined'];

export function isSettled(status: ReviewStatus): boolean {
  return SETTLED_STATUSES.includes(status);
}

export interface WriteDecision {
  /** The status the write is actually allowed to land with. */
  status: ReviewStatus;
  /** True if the requested status was changed to honour the boundary. */
  coerced: boolean;
  /** Why — for logs and for showing the user that the wall held. */
  reason: string;
}

/**
 * Gate a fact write against the boundary. Humans pass through untouched — they hold the fact-edit
 * right over their own graph. An agent asking to land a SETTLED fact is downgraded to `pending`:
 * it becomes a proposal a competent reviewer must clear, never a silent assertion. An agent write
 * that is already a proposal (pending / pending-removal) passes through unchanged.
 */
export function gateFactWrite(actor: Actor, requestedStatus: ReviewStatus): WriteDecision {
  if (actor === 'human') {
    return { status: requestedStatus, coerced: false, reason: 'human holds the fact-edit right' };
  }
  if (isSettled(requestedStatus)) {
    return {
      status: 'pending',
      coerced: true,
      reason: `agent may not settle a fact directly (requested "${requestedStatus}") — downgraded to a proposal for review`,
    };
  }
  return { status: requestedStatus, coerced: false, reason: 'agent write is already a proposal' };
}

/**
 * What an agent is trying to write, at the coarse grain the boundary cares about. FACTS live in a
 * knowledge graph and are the user's to settle; PLAN/CODE/ROADMAP are the versioned artefacts an
 * agent edits directly (git + PR is their review, not the in-app queue).
 */
export type EditTarget = 'fact' | 'plan' | 'code' | 'roadmap-ttl';

/** Whether an agent may write this target directly, or must route it through review. */
export type TargetPolicy = 'direct' | 'propose';

/**
 * The boundary as a table, for the targets an agent can address. Only FACTS must be proposed;
 * plan/code/roadmap edits are direct because they are versioned and reviewed by git/PR (F33).
 * "roadmap-ttl" is direct on purpose: the graph is the plan, and editing the plan is how agents
 * work — that edit lands in a branch and a human merges it, which IS the review.
 */
export function agentTargetPolicy(target: EditTarget): TargetPolicy {
  return target === 'fact' ? 'propose' : 'direct';
}
