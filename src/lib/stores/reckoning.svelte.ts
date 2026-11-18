import { persistSourceBatch, prepareStatementsForWrite, statements, deleteStatement, updateStatement } from '$lib/stores/kb.svelte';
import { officialKbActive } from '$lib/stores/official-kb.svelte';
import { buildProposalRows, proposalRowPrefix, type BuiltProposal, type ParsedProposal } from '$lib/rdf/reckoning-proposal';
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
