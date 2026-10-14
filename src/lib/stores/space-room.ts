/**
 * Writes for a space's room: importing a scan (F58.9.7) and the space's background settings
 * (F58.9.8). The reading side is pure and lives in $lib/3d/splat.
 */
import { v4 as uuid } from 'uuid';
import { statements, addStatements, setStatus } from './kb.svelte';
import { importSplatFile, type ImportedSplat } from '$lib/storage/splat-files';
import { scanStatements, scanEntityIri, SPACE_SUBJECT, BACKGROUND_SPLAT_PREDICATE, type SplatOrigin } from '$lib/3d/splat';

/** Replace-one setting on a subject: reject any live value, then write the new one (empty clears). */
export async function setMeta(subject: string, predicate: string, value: string): Promise<void> {
  for (const st of statements()) {
    if (st.s.kind === 'iri' && st.s.value === subject && st.p.value === predicate && st.o.kind === 'literal'
      && st.status !== 'rejected' && st.status !== 'superseded') await setStatus(st.id, 'rejected');
  }
  const v = value.trim();
  if (!v) return;
  const now = Date.now();
  await addStatements([{
    id: uuid(), s: { kind: 'iri', value: subject }, p: { kind: 'iri', value: predicate }, o: { kind: 'literal', value: v },
    g: { kind: 'iri', value: 'urn:kbase:source/manual' }, sourceId: 'manual', confidence: 1, status: 'confirmed', createdAt: now, updatedAt: now,
  }]);
}

/** Check, store and add a chosen file as the space's background. A refused file changes nothing. */
export async function importScan(file: File, origin: SplatOrigin): Promise<ImportedSplat & { entity?: string }> {
  const res = await importSplatFile(file);
  if (!res.ok) return res;
  const entity = scanEntityIri(res.url);
  const label = file.name.replace(/\.(ply|spz)$/i, '');
  const known = statements().some((s) => s.s.kind === 'iri' && s.s.value === entity && s.status !== 'rejected');
  if (!known) await addStatements(scanStatements(res.url, label, origin, uuid));
  await setMeta(SPACE_SUBJECT, BACKGROUND_SPLAT_PREDICATE, res.url);
  return { ...res, entity };
}
