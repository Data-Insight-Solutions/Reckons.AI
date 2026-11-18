import type { Statement } from './types';
import {
  advanceProposal, closeIfReached, ACTION_STATUS, type Proposal,
} from './proposal';
import { readReckoning, statementIdOfIri, targetShapeFor } from './reckoning-entity';
import {
  PROPOSAL_PREDICATES, PROPOSED_JOB_STATE, proposalEntity, optionEntity, PROPOSAL_OPTION_TYPE,
} from './reckoning-proposal';
import { JOB_PREDICATES } from '../generation/job-node';
import { GENERATION_STAGES, type GenerationStage } from '../generation/protocol';
import type { JobPlanItem } from '../generation/job-plan';

/**
 * F223.12.4: the person weighs the options of a Reckoning's proposal.
 *
 * Pure rules over the stored rows, no model and no storage: each function returns the exact changes, and the
 * store (reckoning.svelte.ts) applies them. Nothing here queues a job; it returns the jobs as plan items, so the
 * caller hands them to submitJobs as ONE batch (one approval, the F166.1.2 pattern) and only then records them as queued.
 *
 * AN AGENT MAY NOT SETTLE ITS OWN PROPOSAL: accepting is the PERSON's act, so the proposal is advanced with
 * `{ person: true }`, and completing it is the deterministic target-state check (closeIfReached), never an opinion.
 */

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment';

export type RowPatch = { id: string; status?: Statement['status']; o?: Statement['o'] };
export type PlannedJob = { entity: string; stateRowId: string; item: JobPlanItem };

/** The stored Proposal, read back from its rows, with the row that holds its action status. */
export type StoredProposal = { proposal: Proposal; statusRowId: string | null; reckoningId: string };

const live = (st: Statement) => st.status !== 'rejected' && st.status !== 'superseded';

/** The Proposal of one Reckoning as the rows say it is; null when none has been written. */
export function readStoredProposal(all: readonly Statement[], reckoningId: string): StoredProposal | null {
  const reckoning = readReckoning(all, reckoningId);
  if (!reckoning) return null;
  const pe = proposalEntity(reckoningId);
  const own = all.filter((st) => st.s.value === pe && live(st));
  const keys = own.filter((st) => st.p.value === PROPOSAL_PREDICATES.hasOption).map((st) => st.o.value);
  if (keys.length === 0) return null;
  const statusRow = own.find((st) => st.p.value === PROPOSAL_PREDICATES.actionStatus) ?? null;
  const recommended = own.find((st) => st.p.value === PROPOSAL_PREDICATES.recommended)?.o.value ?? null;
  const idOf = (iri: string) => iri.replace('urn:kbase:concept/', '');
  const options = keys.map((iri) => {
    const rows = all.filter((st) => st.s.value === iri);
    return {
      id: idOf(iri),
      label: rows.find((st) => st.p.value === LABEL)?.o.value ?? idOf(iri),
      citations: rows.filter((st) => st.p.value === PROPOSAL_PREDICATES.cites)
        .map((st) => statementIdOfIri(st.o.value)).filter((v): v is string => v !== null),
    };
  });
  return {
    reckoningId, statusRowId: statusRow?.id ?? null,
    proposal: {
      id: `reckoning-${reckoningId}-proposal`, proposedBy: 'reckoning-agent',
      status: statusRow?.o.value ?? ACTION_STATUS.potential,
      targetShape: targetShapeFor(reckoning, all),
      options, recommendedId: recommended ? idOf(recommended) : null,
    },
  };
}

/** The option a stored row id belongs to, parsed from `reckoning-<id>-option-<key>`; null when it is not one. */
export function reckoningOfOption(optionId: string): string | null {
  return /^reckoning-(.+)-option-[a-d]$/.exec(optionId)?.[1] ?? null;
}

export type OptionState = 'proposed' | 'accepted' | 'rejected' | 'superseded';

/** Where one option stands, read from its type row (the one row every option has). */
export function optionState(all: readonly Statement[], reckoningId: string, optionId: string): OptionState {
  const key = optionId.slice(optionId.lastIndexOf('-') + 1);
  const type = all.find((st) => st.s.value === optionEntity(reckoningId, key) && st.p.value === RDF_TYPE && st.o.value === PROPOSAL_OPTION_TYPE);
  if (!type) return 'proposed';
  if (type.status === 'confirmed' || type.status === 'refined') return 'accepted';
  if (type.status === 'rejected') return 'rejected';
  if (type.status === 'superseded') return 'superseded';
  return 'proposed';
}

export type AcceptPlan = {
  /** The proposal, now active: the person accepted. */
  proposal: Proposal;
  /** Rows of the accepted option that become confirmed (its statements, job records, metadata). */
  confirm: string[];
  /** Rows of every other option that become superseded: they stay readable. */
  supersede: string[];
  /** Missing-input questions of the accepted option: left open, still asking. */
  stillOpen: string[];
  /** The accepted option's proposed jobs: hand `items` to submitJobs as one batch. */
  jobs: PlannedJob[];
  /** The status of the stored action-status row once accepted. */
  statusRowId: string | null;
};
export type AcceptResult = { ok: true; plan: AcceptPlan } | { ok: false; message: string };

const isProposedJobState = (st: Statement) => st.p.value === JOB_PREDICATES.state && st.o.value === PROPOSED_JOB_STATE;

/** The proposed job records among an option's rows, as plan items. A record with no usable stage or prompt is skipped by name in `skipped`. */
function plannedJobs(rows: readonly Statement[]): { jobs: PlannedJob[]; skipped: string[] } {
  const jobs: PlannedJob[] = [];
  const skipped: string[] = [];
  for (const state of rows.filter(isProposedJobState)) {
    const entity = state.s.value;
    const stage = rows.find((r) => r.s.value === entity && r.p.value === JOB_PREDICATES.stage)?.o.value;
    const prompt = rows.find((r) => r.s.value === entity && r.p.value === COMMENT)?.o.value;
    if (!stage || !prompt || !(GENERATION_STAGES as readonly string[]).includes(stage)) { skipped.push(entity); continue; }
    jobs.push({ entity, stateRowId: state.id, item: { stage: stage as GenerationStage, prompt } });
  }
  return { jobs, skipped };
}

/**
 * The exact changes of accepting one option. Refuses when the proposal is not waiting for a decision, when the
 * option is not one of its options, or when a proposed job record cannot be read back (nothing is half-accepted).
 */
export function acceptOption(proposal: Proposal, optionId: string, all: readonly Statement[], statusRowId: string | null = null): AcceptResult {
  if (!proposal.options.some((o) => o.id === optionId)) return { ok: false, message: 'That is not one of this proposal\'s options.' };
  if (proposal.status !== ACTION_STATUS.potential) return { ok: false, message: 'This proposal has already been decided.' };
  const advanced = advanceProposal(proposal, ACTION_STATUS.active, { person: true });
  if (!advanced.ok) return { ok: false, message: advanced.message };

  const optionIds = new Set(proposal.options.map((o) => o.id));
  const mine = all.filter((st) => st.proposalOption === optionId && st.status === 'pending');
  const { jobs, skipped } = plannedJobs(mine);
  if (skipped.length > 0) return { ok: false, message: 'A proposed job could not be read back, so nothing was accepted.' };
  const jobStateRows = new Set(jobs.map((j) => j.stateRowId));
  const stillOpen = mine.filter((st) => st.needsObject).map((st) => st.id);
  return {
    ok: true,
    plan: {
      proposal: advanced.proposal,
      confirm: mine.filter((st) => !st.needsObject && !jobStateRows.has(st.id)).map((st) => st.id),
      supersede: all.filter((st) => st.proposalOption && st.proposalOption !== optionId && optionIds.has(st.proposalOption) && st.status === 'pending').map((st) => st.id),
      stillOpen, jobs, statusRowId,
    },
  };
}

export type RejectPlan = { reject: string[] };

/** Setting one option aside: all of its pending rows become rejected (readable, never deleted). The proposal stays as it was. */
export function rejectOption(proposal: Proposal, optionId: string, all: readonly Statement[]): { ok: true; plan: RejectPlan } | { ok: false; message: string } {
  if (!proposal.options.some((o) => o.id === optionId)) return { ok: false, message: 'That is not one of this proposal\'s options.' };
  if (proposal.status !== ACTION_STATUS.potential) return { ok: false, message: 'This proposal has already been decided.' };
  return { ok: true, plan: { reject: all.filter((st) => st.proposalOption === optionId && st.status === 'pending').map((st) => st.id) } };
}

/** What the person is told before they confirm. */
export function describeAccept(plan: AcceptPlan): string {
  const n = (c: number, one: string, many = `${one}s`) => `${c} ${c === 1 ? one : many}`;
  const parts = [
    `confirm ${n(plan.confirm.length, 'statement')}`,
    plan.jobs.length ? `queue ${n(plan.jobs.length, 'job')} in one approval` : 'queue no jobs',
    `mark ${n(plan.supersede.length, 'statement')} of the other options as superseded (they stay readable)`,
  ];
  const open = plan.stillOpen.length ? ` ${n(plan.stillOpen.length, 'missing-input question')} stay${plan.stillOpen.length === 1 ? 's' : ''} open until you answer.` : '';
  return `This will ${parts.join(', ')}.${open}`;
}

/**
 * After any change: is the target of the Reckoning now held by reviewed facts? Marks an active proposal completed
 * when so (closeIfReached, the system as actor), and says whether it just did.
 */
export function settleIfReached(stored: StoredProposal, all: readonly Statement[]): { proposal: Proposal; closed: boolean } {
  const t = closeIfReached(stored.proposal, all);
  if (!t.ok) return { proposal: stored.proposal, closed: false };
  return { proposal: t.proposal, closed: t.proposal.status === ACTION_STATUS.completed };
}
