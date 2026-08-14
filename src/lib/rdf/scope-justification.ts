/**
 * JUSTIFYING A SCOPE INCREASE — and routing the judgement to someone accountable.
 *
 * Matt, 2026-08-14: "The idea here is to raise judgement to the human and council. The goal
 * being judgement is made by higher reasoning models and a human that can be accountable for
 * the decision. justifications may be added. In the event of scope increase or creep, the
 * engineer or the designer may have justification for the increase. 'I used the initial
 * version and it now clearly needs this other thing.' or, 'If we change this here we would
 * change this other places for consistency and maintainability.'"
 *
 * So creep is not a verdict — it is the OPENING of a decision. The measurement (rdf/scope.ts)
 * says the expectation grew; this module carries why, who decided, and what they decided.
 *
 * WHY THE JUSTIFICATION IS STRUCTURED RATHER THAN FREE TEXT. Both examples Matt gave are
 * recurring KINDS, not one-offs: discovery-through-use is what happens when a thing is built
 * and then used; consistency-maintenance is what happens when a local change would leave the
 * codebase saying two different things. Naming the kinds makes them countable — a design
 * whose creep is repeatedly discovery-through-use was under-specified in a different way from
 * one whose creep is repeatedly consistency-maintenance, and only the first is fixed by
 * thinking harder up front. Free text alone cannot be counted, so it would tell you a story
 * once and nothing thereafter.
 *
 * ACCOUNTABILITY IS A NAMED PARTY, NEVER "the system". A decision recorded without a decider
 * is one nobody can be asked about later, and the whole purpose of raising judgement is that
 * someone can be asked. An unaccepted increase therefore stays OPEN rather than defaulting to
 * approved — silence is not consent, and the F52 boundary (agents propose, humans settle)
 * applies to scope exactly as it applies to facts.
 */

export type JustificationKind =
  /** "I used the initial version and it now clearly needs this other thing." */
  | 'discovery-through-use'
  /** "If we change this here we would change these other places for consistency." */
  | 'consistency-maintenance'
  /** A dependency the design did not foresee was required to proceed at all. */
  | 'unforeseen-dependency'
  /** The work uncovered a defect that had to be fixed to continue. */
  | 'blocking-defect'
  /** Work that belongs to a different design and was done here anyway. */
  | 'unrelated-work';

export const JUSTIFICATION_KINDS: Record<
  JustificationKind,
  { label: string; refines: 'the design' | 'the process' | 'nothing'; legitimate: boolean }
> = {
  'discovery-through-use': {
    label: 'Using the first version revealed what it still needed',
    // The design could not have known this without building; the fix is to record what was
    // learned, not to demand better foresight.
    refines: 'the design',
    legitimate: true,
  },
  'consistency-maintenance': {
    label: 'Changing one place required changing others to stay consistent',
    refines: 'the design',
    legitimate: true,
  },
  'unforeseen-dependency': {
    label: 'A dependency the design did not foresee was needed to proceed',
    refines: 'the design',
    legitimate: true,
  },
  'blocking-defect': {
    label: 'A defect had to be fixed before the work could continue',
    // Legitimate to do, but it is a signal about process: the defect should become its own
    // record rather than being absorbed silently into an unrelated feature's scope.
    refines: 'the process',
    legitimate: true,
  },
  'unrelated-work': {
    label: 'Work belonging to a different design was done here',
    refines: 'the process',
    legitimate: false,
  },
};

export type Decision = 'accepted' | 'split-out' | 'reverted' | 'open';

export type ScopeJustification = {
  /** Which design's scope grew. */
  design: string;
  kind: JustificationKind;
  /** The engineer's or designer's own words. Structured kind AND prose, not one or the other. */
  rationale: string;
  /** Who is accountable for the decision. Never a system name. */
  decidedBy?: string;
  decision: Decision;
  at: number;
};

/** A justification with no named decider has not been decided, whatever it claims. */
export function isAccountable(j: ScopeJustification): boolean {
  return j.decision !== 'open' && !!j.decidedBy && j.decidedBy.trim().length > 0;
}

/**
 * Who should rule on this?
 *
 * `council` is the multi-model corroboration lane (F102) — reached for where a call is
 * contestable and a single reviewer's judgement is worth checking against others. Everything
 * illegitimate goes to a HUMAN rather than a council, because accepting work that does not
 * belong to a design is an accountability decision, not a technical one, and a model should
 * not be the last word on it.
 */
export function routeForJudgement(j: ScopeJustification): 'human' | 'council' {
  const meta = JUSTIFICATION_KINDS[j.kind];
  if (!meta.legitimate) return 'human';
  return meta.refines === 'the process' ? 'human' : 'council';
}

/**
 * What the graph should learn from an accepted increase.
 *
 * An accepted justification that changes nothing is a rubber stamp. Where the kind refines
 * THE DESIGN, the design's estimate should be amended so the next one starts from what was
 * learned; where it refines THE PROCESS, the lesson is not the estimate's to hold.
 */
export function followUp(j: ScopeJustification): string | null {
  if (j.decision !== 'accepted') return null;
  const meta = JUSTIFICATION_KINDS[j.kind];
  if (meta.refines === 'the design') {
    return `Amend ${j.design}: record what was learned so the next estimate starts from it.`;
  }
  if (meta.refines === 'the process') {
    return `Record this separately from ${j.design} — absorbing it into this design's scope hides it.`;
  }
  return null;
}

/** Summary for a report: what happened, who owns it, and whether it is actually settled. */
export function describeJustification(j: ScopeJustification): string {
  const meta = JUSTIFICATION_KINDS[j.kind];
  const who = j.decidedBy?.trim() ? j.decidedBy : 'nobody yet';
  const settled = isAccountable(j) ? j.decision : `OPEN — needs ${routeForJudgement(j)}`;
  return `${meta.label}. "${j.rationale}" — ${settled}, decided by ${who}.`;
}
