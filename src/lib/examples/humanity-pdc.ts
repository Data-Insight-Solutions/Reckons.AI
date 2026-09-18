/** Shared example entry. Counts are checked against the generated graph in the fixture test. */
export const HUMANITY_PDC_EXAMPLE = {
  id: 'humanity-pdc', icon: '◇', title: 'Humanity AI + PDC',
  body: 'A guided story: local AI for learning and research, then grant opportunity + seeker graphs brought together to examine alignment.',
  file: '/example-humanity-pdc.ttl', entities: 73, triples: 440, sources: 12,
  stableId: '66f8f00c-f2f9-51e3-aac3-60852f7c49d1',
};

/** Open an editable example of its own. A second visit never replaces the user's reviewed copy. */
export async function openHumanityPdcExample(): Promise<void> {
  const { findKbByStableId, kbUrl } = await import('../storage/kb-registry');
  const existing = findKbByStableId(HUMANITY_PDC_EXAMPLE.stableId);
  if (existing) { window.location.assign(kbUrl(existing.id)); return; }
  const response = await fetch(HUMANITY_PDC_EXAMPLE.file);
  if (!response.ok) throw new Error(`Could not load the example (${response.status})`);
  const ttl = await response.text();
  const { importTurtleFull } = await import('../rdf/import-ttl');
  if (!(await importTurtleFull(ttl)).statements.length) throw new Error('The example graph is empty');
  const { ingestNewKb } = await import('../stores/kb-import');
  const result = await ingestNewKb({ ttl, assets: new Map() },
    { name: HUMANITY_PDC_EXAMPLE.title, stableId: HUMANITY_PDC_EXAMPLE.stableId },
    HUMANITY_PDC_EXAMPLE.file, { asPending: true });
  if (!result?.count) throw new Error('The example graph could not be imported');
  window.location.assign(kbUrl(result.kbId));
}
