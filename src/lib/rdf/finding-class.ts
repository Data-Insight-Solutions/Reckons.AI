/**
 * WHAT KIND OF WRONG IS THIS? — separating FORM errors, DRIFT, and DEFECTS.
 *
 * Matt, 2026-08-14: "can we clearly classify drift from other syntax or functional errors?"
 * Measured answer at the time: no. `drift-warning` was emitted by claim-audit (a claim
 * contradicting reality), server-health (a server being down) and shacl-validate (a node
 * missing a label) — three different kinds of wrong under one label, from nine different
 * agents across 54 queue entries, with NO entity anywhere defining what drift is.
 *
 * This matters for routing, not tidiness. THE THREE CLASSES DIFFER IN WHO CAN SETTLE THEM
 * AND WHERE THE FIX GOES:
 *
 *   FORM    The artifact is malformed. Decidable without knowing anything about the world —
 *           a parser or a shape settles it. One right answer, fixable mechanically, and SAFE
 *           TO BLOCK A BUILD ON because there is nothing to judge.
 *           (TTL that will not parse, a SHACL violation, a status outside the enum.)
 *
 *   DRIFT   The graph's CLAIM disagrees with REALITY. Requires knowing both, and has TWO
 *           possible fixes — correct the graph, or correct the world — so choosing is a
 *           judgement and it MUST reach a human. Auto-resolving drift is how a graph quietly
 *           becomes fiction (kb:honest-status, and the F52 agents-propose boundary).
 *           (has-status "functional" on something that does not work; tested-by pointing at
 *           a deleted file; a README claim the code contradicts.)
 *
 *   DEFECT  Something in the world is broken. The graph may be perfectly accurate about
 *           intent; the code or the service is what is wrong, so the fix does not touch the
 *           graph at all.
 *           (CSP blocking a shipped feature, a server down, a failing test.)
 *
 * THE DISCRIMINATING TEST, and the reason DEFECT is not just a flavour of drift:
 *
 *     If you repaired the world, would the graph become TRUE without editing it?
 *       yes -> DEFECT   (the claim was right; reality had not caught up)
 *       no  -> DRIFT    (the claim itself was wrong and must change)
 *
 * That test is what separated the two cases this project actually hit. "repo-ingest is
 * functional" while CSP blocked every request LOOKS like drift — the graph and the world
 * disagreed — but adding the origin to connect-src made the graph true without touching it,
 * so it was a DEFECT. Whereas SAFETY.md claiming "we gate publishing" while F66 was merely
 * planned could not be repaired by building anything quickly; the sentence was false and the
 * sentence had to change. That was DRIFT.
 */

export type FindingClass = 'form' | 'drift' | 'defect';

/** The queue's existing `type` values (CLAUDE.md), kept as-is — this is a second axis. */
export type FindingType =
  | 'observation'
  | 'question'
  | 'suggestion'
  | 'status-update'
  | 'drift-warning';

export const FINDING_CLASSES: Record<
  FindingClass,
  { label: string; settledBy: string; fixLands: string; blockable: boolean }
> = {
  form: {
    label: 'Form — the artifact is malformed',
    settledBy: 'a parser or a shape; no judgement required',
    fixLands: 'in the artifact',
    // Nothing to weigh, so a gate here cannot be wrong about intent.
    blockable: true,
  },
  drift: {
    label: 'Drift — the claim disagrees with reality',
    settledBy: 'a human deciding WHICH SIDE is wrong',
    fixLands: 'in the graph, or in the world — that is the decision',
    // Blocking would force a fast answer to the question that most needs a slow one.
    blockable: false,
  },
  defect: {
    label: 'Defect — the world is broken',
    settledBy: 'whoever owns the code or the service',
    fixLands: 'in the code or the infrastructure, not the graph',
    blockable: true,
  },
};

export function isFindingClass(v: string): v is FindingClass {
  return v === 'form' || v === 'drift' || v === 'defect';
}

/**
 * Apply the discriminating test.
 *
 * `graphWouldBecomeTrue` answers: if the world were repaired, would the graph be correct
 * as written? Undefined means the caller does not know — and the honest result is DRIFT,
 * because that is the class that routes to a human rather than the one that blocks a build.
 * Guessing DEFECT would silently claim the graph is already right.
 */
export function classifyFinding(input: {
  /** True when a parser, schema or shape settles it with no reference to the world. */
  decidableFromArtifactAlone: boolean;
  /** True when repairing the world makes the graph true without editing the graph. */
  graphWouldBecomeTrue?: boolean;
}): FindingClass {
  if (input.decidableFromArtifactAlone) return 'form';
  return input.graphWouldBecomeTrue === true ? 'defect' : 'drift';
}

/** One line explaining the classification, for a report or a queue note. */
export function explainClass(c: FindingClass): string {
  const m = FINDING_CLASSES[c];
  return `${m.label}. Settled by ${m.settledBy}; the fix lands ${m.fixLands}.`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * SCOPE — a second, orthogonal axis, about a CHANGE rather than a discrepancy.
 *
 * Matt, 2026-08-14: "there are different classifications of scope increase
 * (aligned) — like new dependency or touching other features that were not
 * predicted to be needed — [and] scope increase (not aligned, drift)."
 *
 * Correct, and the existing metric cannot express it. scripts/kb-align.ts computes
 * scopeScore = 1 - (unmatched / changed) * 0.8, which penalises EVERY unmatched change
 * identically — so discovering a dependency you genuinely needed scores the same as
 * wandering off the plan. That makes the score punish the honest case and quietly
 * encourages under-reporting what a change actually touched.
 *
 * The discriminating test mirrors the one above:
 *
 *     Does the extra work serve the STATED INTENT of the thing you set out to do?
 *       yes -> EXPANDED-ALIGNED    legitimate discovery. The PLAN was incomplete, which
 *                                  F114 already says is normal: "design completeness is
 *                                  relative to the use cases known at the time". The fix
 *                                  is to AMEND THE PLAN — record the new dependency — not
 *                                  to dock a score.
 *       no  -> EXPANDED-UNALIGNED  the work drifted from the plan. This IS drift, at the
 *                                  plan level rather than the fact level, and it needs a
 *                                  decision: split it out as its own feature, or revert.
 *
 * Both are worth RECORDING; only the second is worth flagging. Treating them alike is
 * what makes a scope metric something people route around.
 * ──────────────────────────────────────────────────────────────────────────── */

export type ScopeClass = 'planned' | 'expanded-aligned' | 'expanded-unaligned';

export const SCOPE_CLASSES: Record<
  ScopeClass,
  { label: string; response: string; flag: boolean }
> = {
  planned: {
    label: 'Planned — the change is what the plan said it would be',
    response: 'nothing to record',
    flag: false,
  },
  'expanded-aligned': {
    label: 'Expanded, aligned — unpredicted work that still serves the intent',
    response: 'amend the plan to record the dependency or the feature it had to touch',
    flag: false,
  },
  'expanded-unaligned': {
    label: 'Expanded, unaligned — the work left the intent',
    response: 'split it into its own feature, or revert it; this is drift at the plan level',
    flag: true,
  },
};

export function isScopeClass(v: string): v is ScopeClass {
  return v === 'planned' || v === 'expanded-aligned' || v === 'expanded-unaligned';
}

/**
 * Classify a change's scope.
 *
 * `servesStatedIntent` is deliberately required rather than optional: unlike the finding
 * test, there is no safe default here. Guessing "aligned" would launder a wander into
 * legitimate discovery, and guessing "unaligned" would flag the normal case of a plan
 * turning out to be incomplete. Somebody has to answer it.
 */
export function classifyScope(input: {
  /** Was this work named in the plan before it started? */
  wasPredicted: boolean;
  /** Does it serve the stated intent of the thing it was done under? */
  servesStatedIntent: boolean;
}): ScopeClass {
  if (input.wasPredicted) return 'planned';
  return input.servesStatedIntent ? 'expanded-aligned' : 'expanded-unaligned';
}

export function explainScope(c: ScopeClass): string {
  const m = SCOPE_CLASSES[c];
  return `${m.label}. Response: ${m.response}.`;
}
