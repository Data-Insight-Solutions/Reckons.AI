/**
 * Partial facts — the well-formed absence (F32 / F80 / kb:mission).
 *
 * A partial fact is a triple whose object is unknown: subject and predicate asserted,
 * object `?`, `needsObject: true`. The Review tab renders an entity picker instead of
 * accept/reject, and answering it flows back to the agent that asked.
 *
 * THIS IS NOT A GAP IN THE MODEL. IT IS THE POINT OF IT.
 *
 * The knowledge you need to decide something is usually a few people away — a distance
 * problem, not an information problem. And the reason it stays a few people away is not
 * that you cannot reach them: IT IS THAT YOU DO NOT KNOW WHAT TO ASK. You cannot walk to
 * someone's desk with a question you have not discovered you have.
 *
 * A well-formed absence — subject known, predicate known, object open, AND WHAT IT BLOCKS —
 * turns "go find out what we're missing" into "answer this one question, and four blocked
 * things unblock".
 *
 * The `blocks` half is what makes it a priority rather than a to-do. It was being DROPPED
 * on import (2026-07-13), so the graph knew it had a hole but not what the hole cost.
 */
import type { Statement, Term } from './types';
import { isIRI } from './types';

/** The placeholder object of an unanswered question. */
export const UNKNOWN_OBJECT = '?';

/** Is this an unanswered question rather than an asserted fact? */
export function isPartial(st: Statement): boolean {
  return st.needsObject === true;
}

/** Unanswered questions, newest first. */
export function openQuestions(statements: Statement[]): Statement[] {
  return statements
    .filter((st) => isPartial(st) && st.status !== 'rejected' && st.status !== 'superseded')
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * What is stalled, and behind which question.
 *
 * This is the query the whole idea exists to serve: not "what don't we know?" (a list of
 * holes, which is demoralizing and unactionable) but "what would answering THIS unblock?"
 */
export function blockedWork(statements: Statement[]): Map<string, Statement[]> {
  const byBlocked = new Map<string, Statement[]>();

  for (const q of openQuestions(statements)) {
    for (const target of q.blocks ?? []) {
      const list = byBlocked.get(target) ?? [];
      list.push(q);
      byBlocked.set(target, list);
    }
  }
  return byBlocked;
}

/**
 * Rank open questions by how much they unblock.
 *
 * A question blocking four things is not four times as urgent as one blocking one — it is
 * the difference between a decision and a curiosity. Ties break toward the older question,
 * because a hole nobody has filled in a week is evidence that nobody will fill it by
 * accident.
 */
export function questionsByImpact(statements: Statement[]): { question: Statement; blocks: number }[] {
  return openQuestions(statements)
    .map((question) => ({ question, blocks: question.blocks?.length ?? 0 }))
    .sort((a, b) => b.blocks - a.blocks || a.question.createdAt - b.question.createdAt);
}

export interface ResolvedPartial {
  /** Patch to apply to the statement: the object is now known. */
  patch: { o: Term; needsObject: false };
  /** The answer to flow back to the agent that asked (knowledge.answers.jsonl). */
  answer: {
    subject: string;
    predicate: string;
    object: string;
    objectKind: 'iri' | 'literal';
    /** Which agent asked — WITHOUT this, an answer cannot be claimed when several are waiting. */
    agent?: string;
    question?: string;
  };
  /** Entities that this answer unblocks. */
  unblocks: string[];
}

/**
 * Resolve a partial fact with the object the human chose.
 *
 * Pure: produces the patch and the answer, and applies neither. The caller writes them.
 */
export function resolvePartial(st: Statement, chosen: Term): ResolvedPartial {
  if (!isPartial(st)) {
    throw new Error(`resolvePartial called on a fact that is not a question: ${st.id}`);
  }

  return {
    patch: { o: chosen, needsObject: false },
    answer: {
      subject: st.s.value,
      predicate: st.p.value,
      object: chosen.value,
      objectKind: isIRI(chosen) ? 'iri' : 'literal',
      agent: st.askedBy,       // was being dropped — an unattributed answer is unclaimable
      question: st.question,
    },
    unblocks: st.blocks ?? [],
  };
}

/**
 * A human sentence for the question — used in the review card and by Shelly.
 *
 * Says what it costs, because a question with a price is answered and one without is not.
 */
export function questionSummary(st: Statement): string {
  const q = st.question?.trim();
  const n = st.blocks?.length ?? 0;

  const head = q && q.length > 0 ? q : `What is the object of "${st.s.value} ${st.p.value}"?`;
  if (n === 0) return head;
  return `${head} (blocks ${n} thing${n === 1 ? '' : 's'})`;
}
