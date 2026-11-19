import { persistSourceBatch, prepareStatementsForWrite, statements, deleteStatement, updateStatement, setStatuses } from '$lib/stores/kb.svelte';
import { submitJobs, connectJobs, generationJobs } from '$lib/stores/generation-jobs.svelte';
import { jobEntity } from '$lib/generation/job-node';
import type { Statement } from '$lib/rdf/types';
import { acceptOption, rejectOption, readStoredProposal, settleIfReached, type StoredProposal } from '$lib/rdf/reckoning-accept';
import { officialKbActive } from '$lib/stores/official-kb.svelte';
import { buildProposalRows, proposalRowPrefix, PROPOSAL_PREDICATES, type BuiltProposal, type ParsedProposal } from '$lib/rdf/reckoning-proposal';
import { readReckoning, reckoningSource, reckoningSourceId, reckoningStatements, NO_TARGET, type ReckoningTarget } from '$lib/rdf/reckoning-entity';

/**
 * Save the chosen situation as a Reckoning entity (F223.12.1). Safe to call again with a changed choice: rows
 * with stable ids are kept, rows for facts no longer chosen are removed, a changed sentence is updated.
 * Returns false when the open data is read-only (the official one), so the caller can say nothing was saved.
 */
export async function saveReckoning(id: string, statementIds: readonly string[], note: string, target: ReckoningTarget = NO_TARGET): Promise<boolean> {
  if (officialKbActive()) return false;
  const at = Date.now();
  const rows = reckoningStatements(id, statementIds, note, at, target);
  const wanted = new Set(rows.map((r) => r.id));
  const sourceId = reckoningSourceId(id);
  const proposalPrefix = proposalRowPrefix(id);
  for (const old of statements().filter((s) => s.sourceId === sourceId)) {
    // The proposal's rows carry the same origin but are not part of the choice; saving the choice leaves them be.
    if (old.id.startsWith(proposalPrefix)) continue;
    if (!wanted.has(old.id)) await deleteStatement(old.id);
  }
  const plan = await prepareStatementsForWrite(rows, sourceId, { origin: 'manual' });
  await persistSourceBatch(reckoningSource(id, note, at), plan);
  for (const row of rows) {
    const existing = statements().find((s) => s.id === row.id);
    if (existing && existing.o.value !== row.o.value) await updateStatement(row.id, { o: row.o });
  }
  return true;
}

/**
 * Write a proposal into the knowledge base (F223.12.3): every row pending, option rows stamped with proposalOption, a
 * proposed job recorded but never queued (nothing here calls submitJobs). Replaces an earlier proposal of the
 * same Reckoning. Returns what was written and what the safety filter refused, or null when read-only.
 */
export async function saveProposal(id: string, parsed: ParsedProposal, warnings: BuiltProposal['warnings'] = []): Promise<(BuiltProposal & { written: number }) | null> {
  if (officialKbActive()) return null;
  const reckoning = readReckoning(statements(), id);
  if (!reckoning) return null;
  const at = Date.now();
  const built = buildProposalRows(parsed, { reckoning, at, all: statements(), warnings });
  const sourceId = reckoningSourceId(id);
  const prefix = proposalRowPrefix(id);
  for (const old of statements().filter((s) => s.sourceId === sourceId && s.id.startsWith(prefix))) await deleteStatement(old.id);
  const plan = await prepareStatementsForWrite(built.rows, sourceId, { origin: 'agent' });
  await persistSourceBatch(reckoningSource(id, reckoning.note, at), plan);
  return { ...built, written: plan.statements.length };
}

// ── F223.12.4: weighing the options ────────────────────────────────────────────────

const ACTION_STATUS_TERM = (iri: string): Statement['o'] => ({ kind: 'iri', value: iri });

/** Move the stored action-status row; the person (or the target check) made the change, so it is confirmed. */
async function writeProposalStatus(stored: StoredProposal, to: string) {
  if (!stored.statusRowId) return;
  await updateStatement(stored.statusRowId, { o: ACTION_STATUS_TERM(to), status: 'confirmed' });
}

/**
 * After any change to reviewed facts: close the proposal when its target is reached (closeIfReached).
 * Returns true when it just closed. Safe to call whenever; it does nothing for a proposal that is not active.
 */
export async function closeProposalIfReached(reckoningId: string): Promise<boolean> {
  const stored = readStoredProposal(statements(), reckoningId);
  if (!stored) return false;
  const settled = settleIfReached(stored, statements());
  if (!settled.closed) return false;
  await writeProposalStatus(stored, settled.proposal.status);
  return true;
}

export type AcceptOutcome = { ok: true; queued: number; closed: boolean } | { ok: false; message: string };

/**
 * Accept one option: the person's act. Its jobs go to submitJobs as ONE batch first; if that fails (no runner,
 * another job in flight) NOTHING is changed, so a person never ends up with statements confirmed and no job.
 * Only after the jobs are queued are the option's rows confirmed, the other options superseded, the proposed job
 * records moved to the queued state and linked to the real jobs, and the proposal made active.
 */
export async function acceptProposalOption(reckoningId: string, optionId: string): Promise<AcceptOutcome> {
  if (officialKbActive()) return { ok: false, message: 'This data is read-only, so nothing was changed.' };
  const stored = readStoredProposal(statements(), reckoningId);
  if (!stored) return { ok: false, message: 'No proposal was found for this Reckoning.' };
  const result = acceptOption(stored.proposal, optionId, statements(), stored.statusRowId);
  if (!result.ok) return result;
  const { plan } = result;
  let created: { id: string }[] = [];
  if (plan.jobs.length > 0) {
    // The page may have been opened before the runner was reachable: look once more, without asking for a folder.
    if (!generationJobs.capabilities) await connectJobs();
    try { created = await submitJobs(plan.jobs.map((j) => j.item), 'shelly'); }
    catch (e) { return { ok: false, message: `Nothing was changed: ${e instanceof Error ? e.message : String(e)}` }; }
  }
  await setStatuses([
    ...plan.confirm.map((id) => ({ id, status: 'confirmed' as const })),
    ...plan.jobs.map((j) => ({ id: j.stateRowId, status: 'confirmed' as const })),
    ...plan.supersede.map((id) => ({ id, status: 'superseded' as const })),
  ]);
  for (const j of plan.jobs) await updateStatement(j.stateRowId, { o: { kind: 'literal', value: 'queued' } });
  if (plan.jobs.length > 0) {
    const at = Date.now();
    const reckoning = readReckoning(statements(), reckoningId);
    const sourceId = reckoningSourceId(reckoningId);
    const links: Statement[] = plan.jobs.map((j, i) => ({
      id: `${proposalRowPrefix(reckoningId)}${optionId.slice(-1)}-queued-${i}`, s: { kind: 'iri', value: j.entity },
      p: { kind: 'iri', value: PROPOSAL_PREDICATES.queuedAs }, o: { kind: 'iri', value: jobEntity(created[i].id) },
      g: { kind: 'iri', value: `urn:kbase:source/${sourceId}` }, sourceId, status: 'confirmed', confidence: 1,
      createdAt: at, updatedAt: at, proposalOption: optionId,
    }));
    await persistSourceBatch(reckoningSource(reckoningId, reckoning?.note ?? '', at), await prepareStatementsForWrite(links, sourceId, { origin: 'manual' }));
  }
  await writeProposalStatus(stored, plan.proposal.status);
  const closed = await closeProposalIfReached(reckoningId);
  return { ok: true, queued: created.length, closed };
}

/** Put one option aside. Its rows become rejected (still readable); the proposal stays waiting. */
export async function rejectProposalOption(reckoningId: string, optionId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (officialKbActive()) return { ok: false, message: 'This data is read-only, so nothing was changed.' };
  const stored = readStoredProposal(statements(), reckoningId);
  if (!stored) return { ok: false, message: 'No proposal was found for this Reckoning.' };
  const result = rejectOption(stored.proposal, optionId, statements());
  if (!result.ok) return result;
  await setStatuses(result.plan.reject.map((id) => ({ id, status: 'rejected' as const })));
  return { ok: true };
}

/**
 * The person answers a missing-input question: the row gets the answer and is confirmed (a reviewed fact), then the
 * proposal is checked against its target. Returns true when that answer closed the proposal.
 */
export async function answerOpenQuestion(reckoningId: string, statementId: string, answer: string): Promise<boolean> {
  const text = answer.trim();
  if (!text || officialKbActive()) return false;
  const row = statements().find((st) => st.id === statementId && st.needsObject);
  if (!row) return false;
  await updateStatement(statementId, { o: { kind: 'literal', value: text }, needsObject: false, gloss: undefined });
  await setStatuses([{ id: statementId, status: 'confirmed' }]);
  return closeProposalIfReached(reckoningId);
}
