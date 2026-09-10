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

/**
 * ── ANSWERED BY THE NEXT DOCUMENT (F195) ────────────────────────────────────
 *
 * Matt, 2026-09-09: "a question from a document last week could be accepted and used in graph,
 * then a new document has a decision or new claim about the same thing, there was a meeting and
 * it is now decided. The question triple should be superceded easily by accepting the extracted
 * claim."
 *
 * THE MATCH IS AN EQUALITY TEST, WHICH IS WHY THIS IS CHEAP AND SAFE. An open question is subject
 * S, predicate P, object unknown. An incoming extraction asserting S and P with a real object
 * ANSWERS it. No model, no similarity threshold, no judgment — and therefore no way to hallucinate
 * a match. Everything expensive about this feature is in the presentation, not the detection.
 *
 * IT ONLY FINDS. It applies nothing: `supersede()` in the kb store already marks the old statement
 * superseded and links the replacement, and this returns the pairs a human is asked to confirm.
 * Answering a question is still accepting a claim, and F194 keeps claims in the layer a person
 * settles.
 */

/** An open question, and the incoming claim that would settle it. */
export interface QuestionAnswer {
  /** The open question already in the graph. */
  question: Statement;
  /** The incoming statement whose object answers it. */
  answer: Statement;
  /** What answering it releases — the reason to put this at the top of a queue. */
  unblocks: string[];
}

/** Same term, meaning same VALUE and same KIND — an IRI and a literal that read alike are not equal. */
function sameTerm(a: { kind: string; value: string }, b: { kind: string; value: string }): boolean {
  return a.kind === b.kind && a.value === b.value;
}

/** Does this statement assert a real object, rather than asking for one? */
function isAssertion(st: Statement): boolean {
  return !isPartial(st)
    && st.o.value !== UNKNOWN_OBJECT
    && st.status !== 'rejected'
    && st.status !== 'superseded';
}

/**
 * Which incoming statements answer which open questions.
 *
 * `incoming` is what a new document produced; `existing` is the graph as it stands. They may be
 * the same array — a batch that both asks and answers is legitimate, and a statement is never
 * allowed to answer itself.
 *
 * Ordered by what answering RELEASES, then by the age of the question. That ordering is the
 * feature: a queue sorted by arrival is a chore, and a queue that leads with "this settles
 * something four other things were waiting on" is a report on what happened.
 */
export function answersToOpenQuestions(
  incoming: Statement[],
  existing: Statement[],
): QuestionAnswer[] {
  const questions = openQuestions(existing);
  if (questions.length === 0) return [];

  const pairs: QuestionAnswer[] = [];
  for (const question of questions) {
    for (const answer of incoming) {
      if (answer.id === question.id) continue;              // nothing answers itself
      if (!isAssertion(answer)) continue;
      if (!sameTerm(question.s, answer.s)) continue;
      if (question.p.value !== answer.p.value) continue;
      pairs.push({ question, answer, unblocks: question.blocks ?? [] });
    }
  }

  return pairs.sort(
    (a, b) =>
      b.unblocks.length - a.unblocks.length
      || a.question.createdAt - b.question.createdAt,
  );
}

/**
 * One sentence for the review card.
 *
 * It names the cost of the question rather than describing the triple, because the triple is
 * already on the card and the cost is the part that decides whether to read it now.
 */
export function answerSummary(qa: QuestionAnswer): string {
  const n = qa.unblocks.length;
  const asked = qa.question.question?.trim();
  const head = asked && asked.length > 0
    ? `Answers: ${asked}`
    : `Answers an open question about ${qa.question.s.value}`;
  return n === 0 ? head : `${head} — and unblocks ${n} thing${n === 1 ? '' : 's'}`;
}
