import { persistSourceBatch, prepareStatementsForWrite, statements, deleteStatement, updateStatement } from '$lib/stores/kb.svelte';
import { officialKbActive } from '$lib/stores/official-kb.svelte';
import { reckoningSource, reckoningSourceId, reckoningStatements } from '$lib/rdf/reckoning-entity';

/**
 * Save the chosen situation as a Reckoning entity (F223.12.1). Safe to call again with a changed choice: rows
 * with stable ids are kept, rows for facts no longer chosen are removed, a changed sentence is updated.
 * Returns false when the open data is read-only (the official one), so the caller can say nothing was saved.
 */
export async function saveReckoning(id: string, statementIds: readonly string[], note: string): Promise<boolean> {
  if (officialKbActive()) return false;
  const at = Date.now();
  const rows = reckoningStatements(id, statementIds, note, at);
  const wanted = new Set(rows.map((r) => r.id));
  const sourceId = reckoningSourceId(id);
  for (const old of statements().filter((s) => s.sourceId === sourceId)) {
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
