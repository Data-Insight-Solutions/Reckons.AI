/**
 * Review-anchored generation — the grounding constraint (F51, kb:review-anchored-generation).
 *
 * The thesis: the graph of REVIEWED facts is the canonical input; text is a cheap, disposable
 * output generated from it. That inversion only works if it is HELD TO ONE RULE:
 *
 *   "Every generated sentence MUST trace back to a confirmed triple. Generation that invents a
 *    claim not in the graph reintroduces hallucination at the render step."
 *
 * The moat is not the generation — it is this constraint. So this module is the ENFORCER, not a
 * generator. A grounded generation carries, per sentence, the ids of the statements it was drawn
 * from; this validates that contract: every sentence cites at least one statement, every cited
 * statement exists, and every cited statement is CONFIRMED (generation anchors to reviewed facts,
 * not pending guesses or rejected claims).
 *
 * This is the GENERATION-side analog of kb:passage-grounding (grounding.ts), where an ingested
 * excerpt must actually occur in its source. There, the claim must trace to the source text; here,
 * the sentence must trace to a confirmed triple. Same principle at the other end of the pipe.
 *
 * Pure and deterministic: it checks the citation contract. It cannot judge whether the prose
 * faithfully paraphrases the triple — that is a model's job — but it can guarantee that nothing
 * was emitted WITHOUT a confirmed triple behind it, which is the half that stops hallucination.
 */
import type { Statement } from './types';

export interface GroundedSentence {
  /** The generated sentence. */
  text: string;
  /** Ids of the statements this sentence claims to be grounded in. */
  citations: string[];
}

export type GroundingViolationKind =
  | 'uncited' //             a sentence with no citation — an unbacked claim
  | 'dangling-citation' //   cites a statement id that is not in the graph
  | 'unconfirmed-citation'; // cites a real statement that is not confirmed (pending/rejected/etc.)

export interface GroundingViolation {
  sentence: string;
  kind: GroundingViolationKind;
  detail: string;
}

const CONFIRMED: Statement['status'] = 'confirmed';

/**
 * Validate a grounded generation against the graph. Returns every violation of the citation
 * contract; an empty array means the generation is fully grounded. `byId` maps statement id to the
 * statement, so callers pass whatever slice of the graph they generated from.
 *
 * A sentence may cite several statements; it is grounded if AT LEAST ONE citation is a confirmed
 * statement (a sentence can legitimately draw on several facts, and one solid anchor makes it
 * traceable). A sentence whose citations are ALL dangling/unconfirmed is not grounded, and each
 * bad citation is reported so the failure is legible, not just "ungrounded".
 */
export function validateGeneration(
  sentences: GroundedSentence[],
  byId: Map<string, Statement>,
): GroundingViolation[] {
  const out: GroundingViolation[] = [];

  for (const s of sentences) {
    if (s.citations.length === 0) {
      out.push({ sentence: s.text, kind: 'uncited', detail: 'no citation — every sentence must trace to a confirmed triple' });
      continue;
    }

    let hasConfirmedAnchor = false;
    const problems: GroundingViolation[] = [];
    for (const id of s.citations) {
      const st = byId.get(id);
      if (!st) {
        problems.push({ sentence: s.text, kind: 'dangling-citation', detail: `cites "${id}", which is not in the graph` });
      } else if (st.status !== CONFIRMED) {
        problems.push({ sentence: s.text, kind: 'unconfirmed-citation', detail: `cites "${id}", which is ${st.status}, not confirmed` });
      } else {
        hasConfirmedAnchor = true;
      }
    }

    // Report the bad citations only when the sentence has NO confirmed anchor at all — a sentence
    // with one solid citation plus an extra weak one is still grounded, and we do not cry wolf.
    // But a sentence anchored to nothing confirmed is a real hallucination risk.
    if (!hasConfirmedAnchor) out.push(...problems);
  }

  return out;
}

/** True when every sentence is anchored to at least one confirmed triple. */
export function isFullyGrounded(sentences: GroundedSentence[], byId: Map<string, Statement>): boolean {
  return validateGeneration(sentences, byId).length === 0;
}

/** Index a statement list by id, for validateGeneration. */
export function statementsById(statements: Statement[]): Map<string, Statement> {
  return new Map(statements.map((s) => [s.id, s]));
}

/** Honest one-line headline: how much of a generation is grounded. */
export function generationGroundingSummary(sentences: GroundedSentence[], byId: Map<string, Statement>): string {
  const violations = validateGeneration(sentences, byId);
  const bad = new Set(violations.map((v) => v.sentence)).size;
  const total = sentences.length;
  if (total === 0) return 'Nothing generated.';
  if (bad === 0) return `All ${total} sentence${total === 1 ? '' : 's'} grounded in confirmed facts.`;
  return `${bad} of ${total} sentence${total === 1 ? '' : 's'} NOT grounded — do not publish until every claim traces to a confirmed triple.`;
}
