/**
 * Filters by standing, exact to the fact (F223.11 / kb:standing-filters), and focus on one
 * option of a proposal.
 *
 * A status filter used to resolve to marker keys and an edge was lit when both its ends matched, so
 * 'pending' also lit every held edge between two pending markers. Here a filter resolves to the
 * matching FACTS as well as their markers, and an edge is lit only when its own fact
 * matches. Nothing is removed from the layout: what does not match dims and keeps its place.
 */
import type { Statement } from './types';
import { termKey } from './types';
import { standingOf } from './statement-standing';
import { isQuestionEnd, questionEndKey } from './graph-view';

export type StandingFilter = 'confirmed' | 'pending' | 'proposed' | 'questions';
export const STANDING_FILTERS: readonly StandingFilter[] = ['confirmed', 'pending', 'proposed', 'questions'];

/** Is this filter one of the status filters (as opposed to hubs, origins or types)? */
export function isStandingFilter(f: string): f is StandingFilter {
  return (STANDING_FILTERS as readonly string[]).includes(f);
}

/**
 * Does one fact pass the active status filters? They UNION ("confirmed + questions" asks for
 * both kinds); no status filter active means every fact passes.
 *
 * 'confirmed' = held (confirmed or refined). 'pending' = every fact still awaiting review by
 * status, which includes proposed ones and questions, as the chip has always counted. 'proposed' and
 * 'questions' are the narrower standings.
 */
export function passesStandingFilters(st: Statement, active: ReadonlySet<string>): boolean {
  const wants = STANDING_FILTERS.filter((f) => active.has(f));
  if (wants.length === 0) return true;
  const standing = standingOf(st);
  return wants.some((f) =>
    f === 'confirmed' ? standing === 'held'
      : f === 'pending' ? st.status === 'pending'
      : f === 'proposed' ? standing === 'proposed'
      : standing === 'question');
}

/** The marker keys one fact puts on the canvas: its subject and its object (a question's own end). */
export function statementNodeKeys(st: Statement): [string, string] {
  return [termKey(st.s), isQuestionEnd(st) ? questionEndKey(st.id) : termKey(st.o)];
}

export interface OptionFocus {
  /** The option's own facts: lit at full strength. */
  lit: Set<string>;
  /** Held facts the option cites: readable at a second, quieter strength. */
  quiet: Set<string>;
  /** Markers of both groups, so labels and markers of what is lit are not dimmed. */
  nodeKeys: Set<string>;
}

/**
 * FOCUS ONE OPTION: which facts light when one option of a proposal is shown on the canvas.
 *
 * `optionId` matches `proposalOption` on a fact. `citations` are the ids the option rests on
 * (ProposalOption.citations); those not already in the option light quietly. Open questions whose
 * `blocks` names an entity the option is about, plus any ids given in `blockers`, light with it at full strength.
 * Switching to another option is another call with another id: the layout never reads this, so no
 * marker moves and two options compare by flipping between them.
 */
export function focusOption(
  statements: readonly Statement[],
  optionId: string,
  opts: { citations?: readonly string[]; blockers?: readonly string[] } = {},
): OptionFocus {
  const cited = new Set(opts.citations ?? []);
  const blockers = new Set(opts.blockers ?? []);
  const lit = new Set<string>();
  const quiet = new Set<string>();
  const nodeKeys = new Set<string>();
  // The gaps that block the proposal (F268.1) are its questions: an open question whose `blocks` names
  // an entity the option's own facts are about lights with the option.
  const optionEntities = new Set<string>();
  for (const st of statements) {
    if (st.proposalOption !== optionId) continue;
    optionEntities.add(st.s.value);
    if (st.o.kind === 'iri') optionEntities.add(st.o.value);
  }
  for (const st of statements) {
    if (st.needsObject && st.blocks?.some((b) => optionEntities.has(b))) blockers.add(st.id);
  }
  for (const st of statements) {
    const inOption = st.proposalOption === optionId || blockers.has(st.id);
    const isCited = !inOption && cited.has(st.id);
    if (!inOption && !isCited) continue;
    (inOption ? lit : quiet).add(st.id);
    for (const k of statementNodeKeys(st)) nodeKeys.add(k);
  }
  return { lit, quiet, nodeKeys };
}
