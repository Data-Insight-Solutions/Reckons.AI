/**
 * Source refresh — re-ingests existing sources to pick up changes.
 *
 * Refreshable source kinds:
 *  - url: re-scrape via Jina/Firecrawl, re-extract triples
 *  - repository: delta via GitHub Compare API or full re-walk
 *  - calendar: re-sync Google Calendar events
 *
 * Non-refreshable (static content):
 *  - document, note, reminder, semfile, analysis
 *
 * Refresh creates a new source entry linked to the same URI so the
 * compare/diff pipeline shows what changed. The old source is preserved.
 */

import type { Source, Statement } from '../rdf/types';
import { ingest, type IngestInput, type IngestProgress } from './ingest.svelte';
import { sources, statementsForSource } from './kb.svelte';
import { settings } from './settings.svelte';

export type RefreshableKind = 'url' | 'repository' | 'calendar';

const REFRESHABLE_KINDS = new Set<string>(['url', 'repository', 'calendar']);

export function isRefreshable(source: Source): boolean {
  return REFRESHABLE_KINDS.has(source.kind);
}

export function refreshableSources(): Source[] {
  return sources().filter(isRefreshable);
}

export type RefreshResult = {
  sourceId: string;
  title: string;
  status: 'refreshed' | 'unchanged' | 'skipped' | 'error';
  newSourceId?: string;
  statementCount?: number;
  error?: string;
};

export type RefreshProgress = {
  current: number;
  total: number;
  currentTitle: string;
  results: RefreshResult[];
};

/**
 * Refresh a single source by re-ingesting its content.
 */
export async function refreshSource(
  source: Source,
  onProgress?: (p: IngestProgress) => void,
): Promise<RefreshResult> {
  const s = settings();

  try {
    let input: IngestInput;

    switch (source.kind) {
      case 'url':
        input = { kind: 'url', url: source.uri };
        break;

      case 'repository': {
        if (!source.repoOwner || !source.repoName) {
          return { sourceId: source.id, title: source.title, status: 'error', error: 'Missing repo metadata' };
        }
        const repoUrl = `${source.repoOwner}/${source.repoName}`;
        input = { kind: 'repository', repoUrl, token: s.githubToken || undefined };
        break;
      }

      case 'calendar':
        // Calendar refresh requires Google auth — skip if not available
        return { sourceId: source.id, title: source.title, status: 'skipped', error: 'Calendar refresh not yet automated' };

      default:
        return { sourceId: source.id, title: source.title, status: 'skipped' };
    }

    const result = await ingest(input, onProgress);

    // Check if content actually changed by comparing hashes
    if (result.source.hash === source.hash) {
      return { sourceId: source.id, title: source.title, status: 'unchanged' };
    }

    return {
      sourceId: source.id,
      title: source.title,
      status: 'refreshed',
      newSourceId: result.source.id,
      statementCount: result.statements.length,
    };
  } catch (e) {
    return {
      sourceId: source.id,
      title: source.title,
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Refresh all refreshable sources. Returns results for each source.
 */
export async function refreshAllSources(
  onProgress?: (p: RefreshProgress) => void,
): Promise<RefreshResult[]> {
  const toRefresh = refreshableSources();
  const results: RefreshResult[] = [];

  for (let i = 0; i < toRefresh.length; i++) {
    const source = toRefresh[i];
    onProgress?.({
      current: i,
      total: toRefresh.length,
      currentTitle: source.title,
      results,
    });

    const result = await refreshSource(source);
    results.push(result);
  }

  onProgress?.({
    current: toRefresh.length,
    total: toRefresh.length,
    currentTitle: '',
    results,
  });

  return results;
}

// ── Auto-refresh scheduler ──────────────────────────────────────────────────

let _refreshTimer: ReturnType<typeof setInterval> | null = null;
let _refreshRunning = false;

/**
 * Start the auto-refresh scheduler based on settings.
 * Call this on app load and whenever settings change.
 */
export function startAutoRefreshScheduler(): void {
  stopAutoRefreshScheduler();

  const s = settings();
  const intervalMinutes = s.autoRefreshIntervalMinutes ?? 0;
  if (intervalMinutes <= 0) return;

  const intervalMs = intervalMinutes * 60 * 1000;
  _refreshTimer = setInterval(async () => {
    if (_refreshRunning) return; // skip if previous run still in progress
    _refreshRunning = true;
    try {
      const results = await refreshAllSources();
      const refreshed = results.filter(r => r.status === 'refreshed');
      if (refreshed.length > 0) {
        console.log(`[auto-refresh] Refreshed ${refreshed.length} source(s):`,
          refreshed.map(r => r.title).join(', '));
      }
    } catch (e) {
      console.warn('[auto-refresh] Failed:', e);
    } finally {
      _refreshRunning = false;
    }
  }, intervalMs);
}

export function stopAutoRefreshScheduler(): void {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}

/**
 * Run a one-shot refresh of all sources (e.g., on KB open).
 */
export async function refreshOnOpen(): Promise<RefreshResult[]> {
  const s = settings();
  if (!s.autoRefreshOnOpen) return [];
  return refreshAllSources();
}
