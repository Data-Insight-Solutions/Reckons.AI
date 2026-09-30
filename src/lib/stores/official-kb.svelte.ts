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

let active = $state(false);
let statements = $state<Statement[]>([]);
let sources = $state<Source[]>([]);
let loaded = $state(false);
let loading = $state(false);
let error = $state<string | null>(null);

export function officialKbActive(): boolean { return active; }
export function officialKbStatements(): Statement[] { return statements; }
export function officialKbSources(): Source[] { return sources; }
export function officialKbLoaded(): boolean { return loaded; }
export function officialKbLoading(): boolean { return loading; }
/** Last load error, if the official KB failed to fetch/parse. Cleared on a successful load. */
export function officialKbError(): string | null { return error; }

/**
 * Load the official KB from the static file (cached after first load).
 */
async function ensureLoaded(): Promise<void> {
  if (loaded || loading) return;
  loading = true;
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
    if (stmts.length === 0) {
      // A successful fetch that yields no statements is still a failure for our
      // purposes — activating an empty KB would silently fall back to the landing
      // page (the graph route renders <LandingPage/> when visible.length === 0).
      throw new Error(`Official KB parsed to 0 statements from ${OFFICIAL_KB_FILE}`);
    }
    console.log(`[official-kb] Loaded ${stmts.length} statements from ${OFFICIAL_KB_FILE}`);
    statements = stmts;
    sources = [source];
    loaded = true;
    error = null;
  } catch (e) {
    console.error('[official-kb] Failed to load:', e);
    error = e instanceof Error ? e.message : String(e);
  } finally {
    loading = false;
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
 *
 * Only activates when the KB actually loaded with content — otherwise the graph
 * route's empty-KB guard would fall back to the landing page while the header
 * banner claimed the docs KB was active (the "Open button shows landing page"
 * bug). On failure the error is left in `officialKbError()` for the UI to show.
 * Returns true when activation succeeded.
 */
export async function activateOfficialKb(): Promise<boolean> {
  await ensureLoaded();
  if (loaded && statements.length > 0) {
    active = true;
    return true;
  }
  active = false;
  return false;
}

/**
 * Switch back to the user's personal KB.
 */
export function deactivateOfficialKb(): void {
  active = false;
}
