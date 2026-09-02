/**
 * FREEFORM RE-ANALYSIS OF THE PENDING SET (F139, step 3 of the extraction architecture).
 *
 * Matt, 2026-08-21: "Not all divergence from optimal will be automatically detected from LLMs, and
 * structured processes. The best layer of intelligence is still the human, and if the human can
 * nudge the pending facts closer towards their ideal definition and hierarchy before they enter the
 * graph, that means less graph editing and analysis usage."
 *
 * So this is the MANUAL TRIGGER: the person reads the summary, types what is wrong with the shape
 * of the pending set in their own words, and the model proposes a REORGANIZATION of facts that
 * already exist. Shape the pending set; do not repair the graph.
 *
 * THE LOAD-BEARING RULE IS THAT RE-ANALYSIS MOVES FACTS, IT NEVER MINTS THEM. Every other guard in
 * this codebase protects a different thing: aggregation protects the recorded VALUE, distillation
 * protects the ALTERNATIVES. Here the risk is that a reorganization pass quietly introduces a claim
 * under cover of tidying — the human asked for grouping and got a new assertion they never read.
 * So the operation set is deliberately CLOSED, and every operation names ids that already exist:
 *
 *   attach   put a pending fact under an open decision   (the 1,688 orphaned judgments)
 *   group    gather pending facts into one question       (one answer settles many)
 *   depend   mark one decision as prerequisite of another (hierarchy the extractor missed)
 *   drop     flag a fact as noise or duplicate            (a proposal to reject, never a rejection)
 *
 * There is no `add`, no `edit`, and no `settle`. A re-analysis that cannot invent a fact cannot
 * launder one into the graph, whatever the instruction said and whatever the model returned.
 */
import type { Statement } from './types';

/** The person's own words, recorded so a proposal can be judged against what was asked for. */
export interface ReanalysisRequest {
  /** Verbatim instruction. Never summarized — it is the provenance for every operation. */
  instruction: string;
  /** The pending facts in scope, in the shape the model sees them. */
  facts: Array<{ id: string; subject: string; predicate: string; object: string }>;
  /** Open decisions a fact may be attached to. */
  decisions: Array<{ id: string; subjectIri: string; question: string }>;
}

export type ReanalysisOp =
  | { op: 'attach'; factIds: string[]; decisionId: string; because?: string }
  | { op: 'group'; factIds: string[]; question: string; because?: string }
  | { op: 'depend'; blockerDecisionId: string; blockedDecisionId: string; because?: string }
  | { op: 'drop'; factIds: string[]; because?: string };

export interface ProposedReanalysis { operations: ReanalysisOp[]; }

export interface ReanalysisOutcome {
  operations: ReanalysisOp[];
  /**
   * Every rejection, in full. The rate is the measurement that says whether a freeform pass is
   * worth its triage cost — swallowing them would make a model that ignores the instruction look
   * identical to one that follows it.
   */
  rejected: string[];
}

const OPS = new Set(['attach', 'group', 'depend', 'drop']);

/** Build the payload for a re-analysis. Only PENDING facts are in scope — the graph is not touched. */
export function reanalysisRequest(
  instruction: string,
  pending: Statement[],
  decisions: Array<{ id: string; subjectIri: string; question: string }>,
  opts: { maxFacts?: number } = {},
): ReanalysisRequest {
  const maxFacts = opts.maxFacts ?? 200;
  return {
    instruction: instruction.trim(),
    facts: pending.slice(0, maxFacts).map((st) => ({
      id: st.id,
      subject: st.s.value,
      predicate: st.p.value.replace('urn:kbase:predicate/', 'kpred:'),
      object: st.o.value,
    })),
    decisions,
  };
}

/**
 * Validate a proposed reorganization against the facts and decisions it was given.
 *
 * Rejects, loudly: unknown operations, ids that were not in the request, a fact claimed by two
 * operations, a self-dependency, a group too small to be a grouping, and a question that is not
 * something a person can answer.
 */
export function validateProposedReanalysis(
  proposal: ProposedReanalysis,
  request: ReanalysisRequest,
  opts: { minGroupSize?: number } = {},
): ReanalysisOutcome {
  const minGroup = opts.minGroupSize ?? 2;
  const factIds = new Set(request.facts.map((f) => f.id));
  const decisionIds = new Set(request.decisions.map((d) => d.id));
  const claimed = new Map<string, string>(); // factId -> the op that took it
  const operations: ReanalysisOp[] = [];
  const rejected: string[] = [];

  for (const [i, raw] of (proposal.operations ?? []).entries()) {
    const where = `operation ${i}`;
    const op = (raw as { op?: string })?.op;
    if (!op || !OPS.has(op)) {
      rejected.push(`${where}: "${op ?? 'missing'}" is not one of attach/group/depend/drop — re-analysis moves facts, it never mints them`);
      continue;
    }

    if (op === 'depend') {
      const d = raw as Extract<ReanalysisOp, { op: 'depend' }>;
      if (!decisionIds.has(d.blockerDecisionId) || !decisionIds.has(d.blockedDecisionId)) {
        rejected.push(`${where}: names a decision that was not in the request`);
        continue;
      }
      if (d.blockerDecisionId === d.blockedDecisionId) {
        rejected.push(`${where}: a decision cannot be its own prerequisite`);
        continue;
      }
      operations.push({ op: 'depend', blockerDecisionId: d.blockerDecisionId, blockedDecisionId: d.blockedDecisionId, because: d.because });
      continue;
    }

    const ids = ((raw as { factIds?: string[] }).factIds ?? []).filter(Boolean);
    if (!ids.length) { rejected.push(`${where}: names no facts`); continue; }

    const unknown = ids.filter((id) => !factIds.has(id));
    if (unknown.length) {
      rejected.push(`${where}: names ${unknown.length} fact id(s) not in the request — ${unknown.slice(0, 3).join(', ')}`);
      continue;
    }

    const taken = ids.filter((id) => claimed.has(id));
    if (taken.length) {
      rejected.push(`${where}: ${taken.length} fact(s) already claimed by an earlier ${claimed.get(taken[0])} — two reorganizations must not fight over one fact`);
      continue;
    }

    if (op === 'attach') {
      const a = raw as Extract<ReanalysisOp, { op: 'attach' }>;
      if (!decisionIds.has(a.decisionId)) {
        rejected.push(`${where}: attaches to decision ${a.decisionId}, which was not in the request`);
        continue;
      }
      for (const id of ids) claimed.set(id, 'attach');
      operations.push({ op: 'attach', factIds: ids, decisionId: a.decisionId, because: a.because });
      continue;
    }

    if (op === 'group') {
      const g = raw as Extract<ReanalysisOp, { op: 'group' }>;
      if (ids.length < minGroup) {
        rejected.push(`${where}: ${ids.length} fact(s) is not a grouping — one question per fact reorganizes nothing`);
        continue;
      }
      const q = (g.question ?? '').trim();
      if (q.length < 8 || !q.endsWith('?')) {
        rejected.push(`${where}: "${q.slice(0, 50)}" is not a question a person can answer`);
        continue;
      }
      for (const id of ids) claimed.set(id, 'group');
      operations.push({ op: 'group', factIds: ids, question: q, because: g.because });
      continue;
    }

    // drop
    for (const id of ids) claimed.set(id, 'drop');
    operations.push({ op: 'drop', factIds: ids, because: (raw as Extract<ReanalysisOp, { op: 'drop' }>).because });
  }

  return { operations, rejected };
}

/** A one-line, honest account of what a re-analysis would do — shown before anything is applied. */
export function reanalysisSummary(outcome: ReanalysisOutcome): string {
  if (!outcome.operations.length) {
    return outcome.rejected.length
      ? `Nothing survived validation (${outcome.rejected.length} rejected). The pending set is unchanged.`
      : 'No changes proposed. The pending set is unchanged.';
  }
  const n = (kind: ReanalysisOp['op']) => outcome.operations.filter((o) => o.op === kind).length;
  const facts = outcome.operations.reduce(
    (t, o) => t + ('factIds' in o ? o.factIds.length : 0), 0,
  );
  const parts = [
    n('attach') ? `${n('attach')} attach` : '',
    n('group') ? `${n('group')} group` : '',
    n('depend') ? `${n('depend')} dependency` : '',
    n('drop') ? `${n('drop')} drop` : '',
  ].filter(Boolean);
  return `${parts.join(' · ')} — ${facts} pending fact${facts === 1 ? '' : 's'} affected, nothing settled` +
    `${outcome.rejected.length ? `, ${outcome.rejected.length} rejected` : ''}.`;
}
