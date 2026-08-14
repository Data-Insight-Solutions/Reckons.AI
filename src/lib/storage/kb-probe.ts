/**
 * Measure a graph WITHOUT switching the app into it.
 *
 * Needed by the duplicate notice on the graphs page: the registry only records a statement
 * count once a graph has been loaded, so a copy that has never been opened shows "not opened"
 * — which is precisely the copy the user cannot judge. Switching into each one to find out is
 * a page reload apiece and loses your place.
 *
 * READ-ONLY, AND IT MUST NOT CREATE ANYTHING. indexedDB.open() on a name that does not exist
 * CREATES an empty database, so probing a dangling registry row would silently manufacture the
 * very thing it was asking about — and the copy would then look real but empty. Every probe is
 * therefore gated on indexedDB.databases() first, and a name not in that list is reported as
 * `exists: false` without being opened at all.
 */

import type { KbEntry } from './kb-registry';
import type { KbProbe } from './kb-duplicate-choice';

/** Names of the IndexedDB databases that actually exist, or null where unsupported. */
async function existingDatabaseNames(): Promise<Set<string> | null> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return null;
  try {
    const list = await indexedDB.databases();
    return new Set(list.map((d) => d.name).filter((n): n is string => !!n));
  } catch {
    return null;
  }
}

function emptyProbe(entry: KbEntry, patch: Partial<KbProbe>): KbProbe {
  return {
    id: entry.id,
    name: entry.name,
    exists: false,
    confirmed: 0,
    pending: 0,
    entities: 0,
    lastEditedAt: 0,
    ...patch,
  };
}

/** Count one graph's statements by cursoring its `statements` store directly. */
function readStatements(entry: KbEntry): Promise<KbProbe> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(entry.id);
    } catch (e) {
      return resolve(emptyProbe(entry, { exists: true, error: String(e) }));
    }
    // An upgrade here means the database did NOT exist and we are creating it. Abort so the
    // probe stays read-only, and report it as absent.
    let creating = false;
    req.onupgradeneeded = () => { creating = true; };
    req.onerror = () => resolve(emptyProbe(entry, { exists: true, error: 'open failed' }));
    req.onsuccess = () => {
      const db = req.result;
      if (creating) {
        db.close();
        indexedDB.deleteDatabase(entry.id);
        return resolve(emptyProbe(entry, { exists: false }));
      }
      if (!db.objectStoreNames.contains('statements')) {
        db.close();
        return resolve(emptyProbe(entry, { exists: true, error: 'no statements store' }));
      }
      let confirmed = 0;
      let pending = 0;
      let lastEditedAt = 0;
      const subjects = new Set<string>();
      try {
        const cursor = db.transaction(['statements'], 'readonly').objectStore('statements').openCursor();
        cursor.onerror = () => { db.close(); resolve(emptyProbe(entry, { exists: true, error: 'read failed' })); };
        cursor.onsuccess = (ev) => {
          const c = (ev.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (c) {
            const v = c.value as { status?: string; s?: { value?: string }; updatedAt?: number; createdAt?: number };
            if (v.status === 'confirmed' || v.status === 'refined') confirmed++;
            else if (v.status === 'pending') pending++;
            const t = Math.max(v.updatedAt ?? 0, v.createdAt ?? 0);
            if (t > lastEditedAt) lastEditedAt = t;
            if (v.s?.value) subjects.add(v.s.value);
            c.continue();
          } else {
            db.close();
            resolve({ id: entry.id, name: entry.name, exists: true, confirmed, pending, entities: subjects.size, lastEditedAt });
          }
        };
      } catch (e) {
        db.close();
        resolve(emptyProbe(entry, { exists: true, error: String(e) }));
      }
    };
  });
}

/** Probe several registry entries. Absent databases are reported, never created. */
export async function probeKbs(entries: readonly KbEntry[]): Promise<KbProbe[]> {
  const names = await existingDatabaseNames();
  const out: KbProbe[] = [];
  for (const entry of entries) {
    if (names && !names.has(entry.id)) {
      out.push(emptyProbe(entry, { exists: false }));
      continue;
    }
    out.push(await readStatements(entry));
  }
  return out;
}
