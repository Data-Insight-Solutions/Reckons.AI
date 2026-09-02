/**
 * One display name for a graph, written to both places that store one.
 *
 * A graph's name lives in TWO stores, and until 2026-08-27 nothing kept them together:
 *
 *   - `KbEntry.name` in the localStorage registry — what /kb lists, what `getCurrentKbName()`
 *     returns, and what `?kb=<name>` resolves against.
 *   - `settings.kbTitle` in the graph's OWN Dexie database — what the header shows, what export
 *     filenames and LLM prompts use.
 *
 * `createKb()` wrote only the first. So a graph created in /kb arrived with an empty title field
 * and the user typed the name a SECOND time (Matt, 2026-08-27: "I created Personal Notes … but had
 * to name it again at the top"). Renaming then diverged the other way: the title box wrote
 * `kbTitle` and left the registry stale, while the list's rename wrote the registry and left the
 * header stale. Two names that can disagree is one name too many.
 *
 * WHY NOT COLLAPSE THEM TO ONE STORE. The registry must be readable WITHOUT opening a graph's
 * database — /kb lists every graph, and `resolveKbParam` has to answer before any database is
 * chosen. `kbTitle` must live INSIDE the graph, or it could not travel with an exported or synced
 * graph. Both locations are load-bearing; what was missing is a single writer.
 */

import { KBaseDB, DEFAULT_SETTINGS } from './db';
import { createKb, updateKbName, getCurrentKbId, type KbEntry } from './kb-registry';

/**
 * Write `name` into a graph's own settings, opening it by id.
 *
 * Opening a second Dexie handle on the ACTIVE graph would be a redundant connection to a database
 * already open, so the caller passes `viaSettings` for that case and this only ever reaches for a
 * fresh handle when the target is some other graph.
 */
async function writeKbTitle(id: string, name: string): Promise<void> {
  const target = new KBaseDB(id);
  try {
    const existing = await target.settings.get('main');
    await target.settings.put({ ...DEFAULT_SETTINGS, ...existing, key: 'main', kbTitle: name });
  } finally {
    target.close();
  }
}

/**
 * Create a graph that already knows its own name.
 *
 * Seeds `kbTitle` in the new graph's database before the caller switches to it, which is what
 * every other creation path (ingest, kb-import, docs leap) already did — /kb's was the one that
 * did not, and it is the one a user reaches for first.
 */
export async function createNamedKb(name: string): Promise<KbEntry> {
  const entry = createKb(name);
  await writeKbTitle(entry.id, name);
  return entry;
}

/**
 * Rename a graph in both stores.
 *
 * `viaSettings` is the active graph's own settings writer (`updateSettings`), used when the target
 * IS the active graph so the in-memory settings store stays reactive — writing straight to Dexie
 * would update the database and leave the UI showing the old name until a reload, which is the
 * "not reactive automatic" half of the original report.
 */
export async function renameKb(
  id: string,
  name: string,
  viaSettings?: (patch: { kbTitle: string }) => Promise<unknown>,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;

  updateKbName(id, trimmed);

  if (viaSettings && id === getCurrentKbId()) {
    await viaSettings({ kbTitle: trimmed });
    return;
  }
  await writeKbTitle(id, trimmed);
}
