/**
 * Reckoning gaps (F268.1) — the distance between a situation and its target, computed.
 *
 * Pure and deterministic: no model, no storage. Given a target shape, the facts the situation
 * rests on, and every fact in the knowledge base, it returns the gaps, each shaped like a partial
 * fact (F32): subject and predicate known, object open. Research and review then speak one form.
 *
 * Two sources of gaps:
 *   1. every requirement `targetReached()` reports missing (REVIEWED facts only, so a pending
 *      fact never closes a gap);
 *   2. open questions (partial facts, still unanswered) whose subject is in the situation or is
 *      the subject of a target requirement.
 *
 * Ranking, stable within each rank: requirements, then questions sharing a subject with a
 * requirement, then the remaining questions.
 *
 * A requirement subject like `?asset` (F223.5 will add one) is reported as a gap with that
 * subject and says so; no variable binding happens here.
 */
import type { Statement } from './types';
import { isIRI } from './types';
import { isPartial } from './partial-facts';
import { targetReached, type TargetShape } from './proposal';

export type GapKind = 'target-requirement' | 'open-question';

export type Gap = {
  /** Subject IRI, or a placeholder such as `?asset`. */
  subject: string;
  predicate: string;
  /** The object the target expects, when it names one. Omitted when any object would do. */
  expectedObject?: string | { literal: string };
  kind: GapKind;
  /** One plain line saying why this is a gap. */
  why: string;
  /** Ids of the facts it relates to (the question itself, or situation facts about the subject). */
  citations: string[];
  /** For a question: the id of the open question. */
  questionId?: string;
};

const iriOf = (t: Statement['s']): string | null => (isIRI(t) ? t.value : null);
const isVariable = (s: string) => s.startsWith('?');

/**
 * `situation` is a list of fact ids or entity IRIs the reckoning rests on. A fact id contributes
 * its subject and object IRIs; an IRI contributes itself.
 */
export function computeGaps(
  target: TargetShape,
  situation: readonly string[],
  statements: readonly Statement[],
): Gap[] {
  const byId = new Map(statements.map((st) => [st.id, st]));
  const situationFacts = new Set<string>();
  const situationSubjects = new Set<string>();
  for (const ref of situation) {
    const st = byId.get(ref);
    if (st) {
      situationFacts.add(st.id);
      for (const t of [st.s, st.o]) { const v = iriOf(t); if (v) situationSubjects.add(v); }
    } else situationSubjects.add(ref);
  }

  const live = (st: Statement) => st.status !== 'rejected' && st.status !== 'superseded';
  const factsAbout = (subject: string) => statements
    .filter((st) => live(st) && !isPartial(st) && situationFacts.has(st.id) && iriOf(st.s) === subject)
    .map((st) => st.id);

  const missing = targetReached(target, statements).missing;
  const requirementSubjects = new Set(missing.map((r) => r.s));
  // Subjects of ALL requirements count for linking questions, met or not: a question about
  // a requirement's subject bears on it either way.
  for (const r of target.requirements) requirementSubjects.add(r.s);

  const requirements: Gap[] = missing.map((r) => ({
    subject: r.s,
    predicate: r.p,
    ...(r.o !== undefined ? { expectedObject: r.o } : {}),
    kind: 'target-requirement',
    why: isVariable(r.s)
      ? `The target needs a fact about ${r.s}, a placeholder subject that is not bound to anything yet; no reviewed fact holds it.`
      : `The target needs a reviewed fact (${r.s}, ${r.p}); none holds it yet.`,
    citations: isVariable(r.s) ? [] : factsAbout(r.s),
  }));

  const questions = statements.filter((st) => isPartial(st) && live(st));
  const seen = new Set<string>();
  const linked: Gap[] = [];
  const rest: Gap[] = [];
  for (const q of questions) {
    const subject = iriOf(q.s);
    if (!subject || seen.has(q.id)) continue;
    const inRequirement = requirementSubjects.has(subject);
    const inSituation = situationSubjects.has(subject);
    if (!inRequirement && !inSituation) continue;
    seen.add(q.id);
    const gap: Gap = {
      subject,
      predicate: q.p.value,
      kind: 'open-question',
      why: inRequirement
        ? `An unanswered question about ${subject}, which the target also needs.`
        : `An unanswered question about ${subject}, which the situation rests on.`,
      citations: [q.id],
      questionId: q.id,
    };
    (inRequirement ? linked : rest).push(gap);
  }

  return [...requirements, ...linked, ...rest];
}
