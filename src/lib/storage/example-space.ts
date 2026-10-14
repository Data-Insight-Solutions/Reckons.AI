/**
 * Open a bundled example graph AS ITS OWN SPACE (F58.9.4), rather than pouring its facts into the
 * space the person is working in. Opening the same example again refreshes that space in place
 * instead of minting a second one with the same name.
 *
 * Only for files shipped with the app (rooted paths under static/). The facts arrive confirmed,
 * attributed to one source named after the example, the way the Add tab's "import as a new space"
 * treats a file a person chose.
 */
import { v4 as uuid } from 'uuid';
import { KBaseDB, DEFAULT_SETTINGS } from './db';
import { createKb, getRegistry, switchToKb } from './kb-registry';
import { importTurtleFull } from '$lib/rdf/import-ttl';

export async function openExampleSpace(file: string, name: string, opts: { switch?: boolean } = {}): Promise<string> {
  if (!file.startsWith('/')) throw new Error('example spaces load only files shipped with the app');
  const res = await fetch(file);
  if (!res.ok) throw new Error(`Could not fetch ${file}: ${res.status}`);
  const { statements } = await importTurtleFull(await res.text(), { name: file.split('/').pop() });

  const existing = getRegistry().find((k) => k.name === name);
  const entry = existing ?? createKb(name);
  const db = new KBaseDB(entry.id);
  await db.open();
  try {
    if (existing) { await db.statements.clear(); await db.sources.clear(); }
    await db.settings.put({ ...DEFAULT_SETTINGS, kbTitle: name });
    const now = Date.now();
    const sourceId = uuid();
    await db.sources.put({ id: sourceId, title: name, uri: `example://${file}`, kind: 'document', trustLevel: 'trusted', ingestedAt: now });
    await db.statements.bulkPut(statements.map((s) => ({
      ...s, id: uuid(), sourceId, g: { kind: 'iri' as const, value: `urn:kbase:source/${sourceId}` },
      status: 'confirmed' as const, createdAt: now, updatedAt: now,
    })));
  } finally {
    db.close();
  }
  if (opts.switch !== false) switchToKb(entry.id);
  return entry.id;
}
