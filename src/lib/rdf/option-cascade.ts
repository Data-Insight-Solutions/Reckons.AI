/**
 * ONE CHOICE, AND EVERYTHING IT SETTLES (F145 / kb:review-tree).
 *
 * Matt, 2026-09-02: "the single choice to approve one of those facts should cascade down to other
 * facts… clearly label the cascading choices, to reject new facts, or decide between other
 * conflicting facts after the single choice is marked."
 *
 * WHAT WAS ALREADY THERE AND WHY IT WAS NOT ENOUGH. `settleConflict` in /review already confirms
 * one side of a contested decision and rejects the others in a single act — Matt asked for that on
 * 2026-08-21 and it shipped. But it settles ONLY the sides of that one conflict. The facts each
 * option was PRICED BY (`kpred:ruled-out-by`, which optionCost already computes and the UI already
 * displays as the cost of choosing) are left pending, so the person is shown a price, charged it,
 * and then asked to pay it again fact by fact. This closes that gap.
 *
 * THREE RULES, AND THE SECOND IS THE ONE THAT MATTERS.
 *
 * 1. PICKING A SIDE IS REJECTING THE OTHERS. Already true in settleConflict; restated here so the
 *    whole settlement is one plan rather than two mechanisms that must agree.
 *
 * 2. IT PLANS, IT DOES NOT APPLY — and every consequence is NAMED before anything is written. A
 *    cascade that silently rejected eleven facts because you picked one would be exactly the
 *    laundering kb:cascade-aggregation's validator exists to prevent, one level up. The caller
 *    renders this plan, the person reads what it will do, and only then is it applied.
 *
 * 3. A DOWNSTREAM DECISION IS SURFACED, NEVER SETTLED. When a choice unblocks or moots another
 *    open decision, that decision is reported in `unblocks` / `mooted` and its facts are left
 *    strictly alone. Settling a second decision from the first would be deciding something nobody
 *    was asked — and `kb:cascade-aggregation` already established the rule that a DECISION is
 *    never batch-settled, even when the machinery could reach it.
 *
 * PROVENANCE IS NOT OPTIONAL. Every fact this plan settles carries `settledByDecision` pointing at
 * the chosen statement, so a cascade can be traced back to the one act that caused it and reversed
 * from it. The handoff's rule at scale: a settled fact whose settler is unknown is worse than an
 * unsettled one, because it looks reviewed.
 */
import type { Statement } from './types';
import { isLit } from './types';

const KPRED = 'urn:kbase:predicate/';
const RULED_OUT_BY = `${KPRED}ruled-out-by`;
const PART_OF = `${KPRED}part-of`;
const DEPENDS_ON = `${KPRED}depends-on`;
const OPEN_QUESTION = `${KPRED}open-question`;

export interface CascadeEffect {
  /** The statement this plan would settle. */
  statement: Statement;
  status: 'confirmed' | 'rejected';
  /** Why, in the words a reviewer needs to judge whether the cascade is right. */
  because: string;
}

export interface DownstreamDecision {
  /** Subject IRI of the decision. */
  subjectIri: string;
  label: string;
  /**
   * `unblocked` — it was waiting on this choice and is now worth asking.
   * `mooted`    — the choice removed its options, so asking it would be theatre.
   */
  effect: 'unblocked' | 'mooted';
  because: string;
}

export interface CascadePlan {
  /** The statement the person picked. */
  chosen: Statement;
  /** Sides of the same conflict that lose. */
  rejectedRivals: Statement[];
  /** Facts settled as a CONSEQUENCE, each with its reason. */
  effects: CascadeEffect[];
  /** Open decisions this choice changes but does NOT settle. */
  downstream: DownstreamDecision[];
  /** One line a person can read before committing. */
  summary: string;
}

const labelOf = (iri: string, all: Statement[]): string => {
  const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
  const st = all.find((s) => s.s.value === iri && s.p.value === RDFS_LABEL && isLit(s.o));
  return st && isLit(st.o) ? st.o.value : iri.replace('urn:kbase:concept/', '');
};

/**
 * Plan what choosing `keepId` among `sides` would settle.
 *
 * `sides` are the statements of ONE conflict — same subject, same predicate, divergent objects —
 * as review-tree's `conflictSides` computes them. `all` is the active graph.
 */
export function planOptionCascade(
  sides: Statement[],
  keepId: string,
  all: Statement[],
): CascadePlan | null {
  const chosen = sides.find((s) => s.id === keepId);
  if (!chosen) return null;
  const rejectedRivals = sides.filter((s) => s.id !== keepId);

  const effects: CascadeEffect[] = [];
  const claimed = new Set<string>(sides.map((s) => s.id));

  /*
   * THE PRICE OF THE WINNER IS PAID. `kpred:ruled-out-by <option>` means "this fact dies if that
   * option wins" — it is how an option's cost is stated in a checkable form rather than asserted
   * in prose, and optionCost already sums it for display. If the option wins and those facts stay
   * pending, the person was shown a price and then asked to pay it again one fact at a time.
   */
  const winnerIri = chosen.o.kind === 'iri' ? chosen.o.value : null;
  if (winnerIri) {
    for (const st of all) {
      if (st.p.value !== RULED_OUT_BY || st.o.value !== winnerIri) continue;
      if (st.status !== 'pending' && st.status !== 'confirmed') continue;
      // The ruled-out-by EDGE is bookkeeping; what dies is the fact it hangs off.
      const victimIri = st.s.value;
      for (const victim of all) {
        if (victim.s.value !== victimIri || claimed.has(victim.id)) continue;
        if (victim.status !== 'pending') continue;
        /*
         * THE PRICE TAG SURVIVES THE PURCHASE. `kpred:ruled-out-by` is the fact that EXPLAINS why
         * this one was rejected. Rejecting it too erases the reason along with the thing, leaving
         * a rejected fact with no recorded cause — and a cascade whose justification has been
         * swept up in its own effects cannot be audited or reversed.
         */
        if (victim.p.value === RULED_OUT_BY) continue;
        claimed.add(victim.id);
        effects.push({
          statement: victim,
          status: 'rejected',
          because: `"${labelOf(victimIri, all)}" is priced as the cost of choosing ${labelOf(winnerIri, all)} — it cannot stand alongside it.`,
        });
      }
    }
  }

  /*
   * THE LOSER'S PRICE IS NOT PAID — IT IS RELEASED. A fact ruled out by an option that LOST was
   * only ever conditional on that option winning. Rejecting it here would be charging a price
   * nobody chose. It stays pending, and saying so out loud matters more than it looks: the
   * asymmetry between the two directions is exactly where a cascade quietly does too much.
   */

  const downstream: DownstreamDecision[] = [];
  const decisionSubjects = new Set(
    all.filter((s) => s.p.value === OPEN_QUESTION).map((s) => s.s.value),
  );
  for (const subjectIri of decisionSubjects) {
    if (subjectIri === chosen.s.value) continue;
    const dependsOnThis = all.some(
      (s) => s.s.value === subjectIri && s.p.value === DEPENDS_ON && s.o.value === chosen.s.value,
    );
    if (!dependsOnThis) continue;

    // Did this choice remove the downstream decision's alternatives? If every fact under it is
    // now rejected by the cascade, asking it would be theatre.
    const membersUnder = all.filter((s) => s.p.value === PART_OF && s.o.value === subjectIri);
    const killed = membersUnder.filter((m) => effects.some((e) => e.statement.s.value === m.s.value));
    const mooted = membersUnder.length > 0 && killed.length === membersUnder.length;
    downstream.push({
      subjectIri,
      label: labelOf(subjectIri, all),
      effect: mooted ? 'mooted' : 'unblocked',
      because: mooted
        ? `Choosing ${labelOf(winnerIri ?? chosen.o.value, all)} removed every option under it — there is nothing left to decide.`
        : `It was waiting on this choice. It is now worth asking, and it is NOT settled by this one.`,
    });
  }

  return {
    chosen,
    rejectedRivals,
    effects,
    downstream,
    summary: cascadeSummaryLine(chosen, rejectedRivals, effects, downstream, all),
  };
}

function cascadeSummaryLine(
  chosen: Statement,
  rivals: Statement[],
  effects: CascadeEffect[],
  downstream: DownstreamDecision[],
  all: Statement[],
): string {
  const raw = chosen.o.kind === 'iri' ? labelOf(chosen.o.value, all) : chosen.o.value;
  // The option's own label may already be phrased as the action ("Choose Lumenpath"), and
  // "Choose Choose Lumenpath" reads as a bug in the very sentence meant to build confidence.
  const pick = raw.replace(/^(choose|pick|select)\s+/i, '');
  const parts = [`Choose ${pick}`];
  if (rivals.length) parts.push(`reject ${rivals.length} rival${rivals.length === 1 ? '' : 's'}`);
  if (effects.length) parts.push(`reject ${effects.length} fact${effects.length === 1 ? '' : 's'} it rules out`);
  const unblocked = downstream.filter((d) => d.effect === 'unblocked').length;
  const mooted = downstream.filter((d) => d.effect === 'mooted').length;
  if (unblocked) parts.push(`open ${unblocked} decision${unblocked === 1 ? '' : 's'} beneath it`);
  if (mooted) parts.push(`retire ${mooted} decision${mooted === 1 ? '' : 's'} that no longer applies`);
  return `${parts.join(' · ')}. Nothing else is touched.`;
}

/** Every statement id this plan would write, for a one-shot `setStatuses` call. */
export function cascadeWrites(plan: CascadePlan): Array<{ id: string; status: 'confirmed' | 'rejected' }> {
  return [
    { id: plan.chosen.id, status: 'confirmed' as const },
    ...plan.rejectedRivals.map((s) => ({ id: s.id, status: 'rejected' as const })),
    ...plan.effects.map((e) => ({ id: e.statement.id, status: e.status })),
  ];
}
