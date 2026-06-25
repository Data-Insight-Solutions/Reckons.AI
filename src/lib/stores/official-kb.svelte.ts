/**
 * Official KB — a read-only shared knowledge base managed by the Reckons.AI team.
 *
 * When active, `statements()` and `sources()` in kb.svelte.ts return the official
 * KB data instead of the user's personal KB. All mutations are blocked.
 *
 * Users can optionally ingest the official KB into their own KB if they want a copy.
 */

import type { Statement, Source } from '../rdf/types';
import { importTurtleFull } from '../rdf/import-ttl';

const OFFICIAL_KB_FILE = '/starter-guide.ttl';
const OFFICIAL_SOURCE_ID = '__official_reckons_docs__';

let _active = $state(false);
let _statements = $state<Statement[]>([]);
let _sources = $state<Source[]>([]);
let _loaded = $state(false);
let _loading = $state(false);

export function officialKbActive(): boolean { return _active; }
export function officialKbStatements(): Statement[] { return _statements; }
export function officialKbSources(): Source[] { return _sources; }
export function officialKbLoaded(): boolean { return _loaded; }
export function officialKbLoading(): boolean { return _loading; }

/**
 * Load the official KB from the static file (cached after first load).
 */
async function ensureLoaded(): Promise<void> {
  if (_loaded || _loading) return;
  _loading = true;
  try {
    const res = await fetch(OFFICIAL_KB_FILE);
    if (!res.ok) throw new Error(`Failed to fetch official KB: ${res.status}`);
    const ttl = await res.text();
    const { statements: parsed } = await importTurtleFull(ttl);

    const now = Date.now();
    const source: Source = {
      id: OFFICIAL_SOURCE_ID,
      title: 'Reckons.AI Official Documentation',
      uri: 'urn:reckons:official-kb',
      kind: 'turtle',
      trustLevel: 'trusted',
      ingestedAt: now,
    };

    // Mark all statements as confirmed and attach to the official source
    const stmts = parsed.map(st => ({
      ...st,
      sourceId: OFFICIAL_SOURCE_ID,
      status: 'confirmed' as const,
    }));
    console.log(`[official-kb] Loaded ${stmts.length} statements from ${OFFICIAL_KB_FILE}`);
    _statements = stmts;
    _sources = [source];
    _loaded = true;
  } catch (e) {
    console.error('[official-kb] Failed to load:', e);
  } finally {
    _loading = false;
  }
}

/**
 * Start fetching and parsing the official KB in the background.
 * Safe to call multiple times — only loads once.
 */
export function preloadOfficialKb(): void {
  ensureLoaded();
}

/**
 * Switch to the official documentation KB (read-only).
 */
export async function activateOfficialKb(): Promise<void> {
  await ensureLoaded();
  _active = true;
}

/**
 * Switch back to the user's personal KB.
 */
export function deactivateOfficialKb(): void {
  _active = false;
}
