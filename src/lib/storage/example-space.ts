/**
 * Open a bundled example graph AS ITS OWN SPACE (F58.9.4), rather than pouring its facts into the
 * space the person is working in. Opening the same example again preserves that space in place
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

/** Spaces an example needs beside it. The Triple Check walkthrough is checked against another space,
 *  so opening it without one would show Triple Check finding nothing. Opened first, without switching. */
const COMPANIONS: Record<string, [file: string, name: string][]> = {
  '/starter-triple-check.ttl': [['/starter-triple-check-reference.ttl', "Harbor 10 owners' forum"]],
};

/**
 * Where an opened example space LANDS (F261, extended by F292.4): on the main page, or on that
 * page inside its guided story.
 *
 * `story: true` is the F261 behaviour — `?story` with no value, which startStoryFromLink reads as
 * "the space's own first walk" (its fallback picks the first story with two or more steps). A
 * string names what the link named: a story IRI or a step number, and startStoryFromLink matches
 * it against the imported story's id (a number never matches an IRI and falls to that same
 * fallback, so `story=1` opens the space's walk at step 1 either way).
 *
 * `autoplay` is appended as `autoplay=1` only when asked — startStoryFromLink honours exactly
 * 1|true (F304), and a story a person opens by clicking should not start advancing on its own.
 * `sel` is an entity the main page should open selected (`?sel=i:<iri>`, read on mount at
 * +page.svelte) — where a link a site drops in names one (F292.4: the ring's frames contact sheet).
 * Pure, so the parameter handling is unit-testable without a browser (see __tests__/).
 */
export function exampleLanding(opts: { story?: boolean | string; autoplay?: boolean; sel?: string } = {}): string {
  const qs = new URLSearchParams();
  if (opts.story) {
    qs.set('story', typeof opts.story === 'string' ? opts.story : '');
    if (opts.autoplay) qs.set('autoplay', '1');
  }
  if (opts.sel) qs.set('sel', opts.sel);
  return qs.toString() ? `/?${qs.toString()}` : '/';
}

export async function openExampleSpace(file: string, name: string, opts: { switch?: boolean; story?: boolean | string; autoplay?: boolean; sel?: string } = {}): Promise<string> {
  for (const [companion, companionName] of COMPANIONS[file] ?? []) await openExampleSpace(companion, companionName, { switch: false });
  if (!/^\/(?:starter-[a-z0-9-]+|review-\d[a-z0-9.-]*)\.ttl$/.test(file)) throw new Error('example spaces load only files shipped with the app');
  const res = await fetch(file);
  if (!res.ok) throw new Error(`Could not fetch ${file}: ${res.status}`);
  const imported = await importTurtleFull(await res.text(), { name: file.split('/').pop() });

  let existing: { id: string } | undefined;
  for (const candidate of getRegistry().filter(k => k.name === name)) {
    const test = new KBaseDB(candidate.id);
    try { if ((await test.sources.toArray()).some(s => s.uri === `example://${file}`)) existing = candidate; } finally { test.close(); }
    if (existing) break;
  }
  const entry = existing ?? createKb(name);
  const db = new KBaseDB(entry.id);
  await db.open();
  try {
    if (!existing) {
      const now = Date.now(), sourceId = uuid(), sourceIds = new Set(imported.sources.map(s => s.id));
      await db.transaction('rw', db.settings, db.sources, db.statements, async () => {
        await db.settings.put({ ...DEFAULT_SETTINGS, kbTitle: name, tripleCheckEnabled: false });
        await db.sources.bulkPut([...imported.sources, { id: sourceId, title: name, uri: `example://${file}`, kind: 'document', trustLevel: 'review', ingestedAt: now }]);
        await db.statements.bulkPut(imported.statements.map(s => ({ ...s, id: uuid(), sourceId: sourceIds.has(s.sourceId) ? s.sourceId : sourceId, status: sourceIds.has(s.sourceId) ? s.status : 'confirmed' as const, createdAt: s.createdAt || now, updatedAt: s.updatedAt || now })));
      });
    }
  } finally {
    db.close();
  }
  // Land on the graph: reloading the page the person clicked on hid that the switch happened.
  // `story`: land in the guided story rather than on a notice that offers it (F261); a string
  // carries the ?story= value (a story IRI or a step number) and autoplay=1 through to
  // startStoryFromLink on the main page (F292.4).
  if (opts.switch !== false) switchToKb(entry.id, { to: exampleLanding(opts) });
  return entry.id;
}
