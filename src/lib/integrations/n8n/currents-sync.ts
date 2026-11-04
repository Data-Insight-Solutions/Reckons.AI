/**
 * Currents sync (F29.2) — app-side client for the "Reckons Currents Monitor"
 * n8n workflow (mirrors the KB Sync Hub / Source Monitor conventions from
 * F20, see docs/N8N_INTEGRATION.md). Reuses `settings().n8nBaseUrl`, the
 * same base-URL field the cloud-sync scripts use.
 *
 * Two remote calls:
 *  - registerCurrent(): POST /webhook/reckons-currents-register — upserts a
 *    current's definition into the monitor's reckons_currents table so the
 *    scheduled sweep (every 30 min, respecting cadenceMinutes) picks it up.
 *  - fetchCurrentItems(): GET /webhook/reckons-currents-items — pulls new
 *    rows from reckons_currents_items for this graph, optionally since a
 *    timestamp.
 *
 * Plus a browser fallback (fetchCurrentDirect) for CORS-friendly feeds when
 * no n8n instance is configured, and processArrivals() which turns fetched
 * items into pending graph statements via the existing currents model
 * (src/lib/rdf/currents.ts, SHIPPED F29.1 — not modified here).
 */

import { v4 as uuid } from 'uuid';
import type { Source } from '../../rdf/types';
import type { CurrentDef } from '../../rdf/currents';
import { buildArrivalStatements, currentArticleIri } from '../../rdf/currents';
import type { CurrentItem } from '../../rdf/current-ranking';
import { addSource, addStatements, sources as allSources, userStatements } from '../../stores/kb.svelte';
import { settings } from '../../stores/settings.svelte';

export type { CurrentItem };

export type CurrentRequestOptions = { baseUrl?: string; signal?: AbortSignal };

function n8nBase(baseUrl = settings().n8nBaseUrl): string {
  const base = baseUrl?.trim().replace(/\/+$/, '');
  if (!base) {
    throw new Error(
      'n8n base URL not configured. Set settings.n8nBaseUrl (Settings > Integrations) to your n8n instance URL.'
    );
  }
  return base;
}

/**
 * Register (or update) a current's definition with the n8n Currents Monitor.
 * Idempotent — upserts by (graphStableId, slug) on the workflow side.
 */
export async function registerCurrent(def: CurrentDef, graphStableId: string, options: CurrentRequestOptions = {}): Promise<void> {
  const res = await fetch(`${n8nBase(options.baseUrl)}/webhook/reckons-currents-register`, {
    method: 'POST',
    signal: options.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      graphStableId,
      slug: def.slug,
      sourceUrl: def.sourceUrl,
      kind: def.kind,
      cadenceMinutes: def.cadenceMinutes,
      enabled: def.enabled,
      label: def.label
    })
  });
  if (!res.ok) {
    throw new Error(`Failed to register current "${def.slug}" with n8n: HTTP ${res.status}`);
  }
}

/**
 * Fetch new items for this graph from the n8n Currents Monitor's item store.
 * Pass `since` (ISO timestamp) to only pull items fetched after a prior sync.
 */
export async function fetchCurrentItems(graphStableId: string, since?: string, options: CurrentRequestOptions = {}): Promise<CurrentItem[]> {
  const url = new URL(`${n8nBase(options.baseUrl)}/webhook/reckons-currents-items`);
  url.searchParams.set('graphStableId', graphStableId);
  if (since) url.searchParams.set('since', since);

  const res = await fetch(url.toString(), { signal: options.signal });
  if (!res.ok) {
    throw new Error(`Failed to fetch current items from n8n: HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Invalid Currents response: expected an array of items.');
  return data.filter(isCurrentItem);
}

/** Treat webhook responses as data, so one malformed row cannot poison a whole poll. */
export function isCurrentItem(value: unknown): value is CurrentItem {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (!['title', 'url', 'currentSlug', 'graphStableId', 'fetchedAt'].every(
    (key) => typeof row[key] === 'string' && (row[key] as string).trim().length > 0,
  )) return false;
  if (!['publishedAt', 'summary', 'sourceLabel'].every(
    (key) => row[key] === undefined || typeof row[key] === 'string',
  )) return false;
  try { return ['http:', 'https:'].includes(new URL(row.url as string).protocol); }
  catch { return false; }
}

/**
 * Browser-only fallback for CORS-friendly RSS/Atom feeds when no n8n
 * instance is configured. Most feeds don't send CORS headers — this exists
 * for the ones that do (or same-origin proxies); the n8n monitor is the
 * primary, reliable path (F29.2 decision, kb:currents-phase-2).
 */
export async function fetchCurrentDirect(def: CurrentDef, graphStableId = ''): Promise<CurrentItem[]> {
  // A tasks current has no browser fallback and never will. Google Tasks needs an OAuth
  // credential the browser does not hold, and this function parses RSS/Atom XML — pointing it
  // at the Tasks API would fail as "could not parse as RSS", which names the symptom and hides
  // the cause. Say the real thing instead.
  if (def.kind === 'tasks') {
    throw new Error(
      `"${def.label}" is a tasks current, which only the n8n Currents Monitor can fetch: the ` +
        'Google Tasks API requires an OAuth credential and has no push channel, so it is polled ' +
        'server-side. Configure settings.n8nBaseUrl and import ' +
        'static/n8n/google-tasks-current.workflow.json.'
    );
  }

  let res: Response;
  try {
    res = await fetch(def.sourceUrl);
  } catch {
    throw new Error(
      `Direct browser fetch of "${def.label}" failed — most likely CORS, since the source doesn't grant ` +
        'cross-origin access to browsers. Configure the n8n Currents Monitor to fetch this one instead.'
    );
  }
  if (!res.ok) {
    throw new Error(`Direct fetch of "${def.label}" failed: HTTP ${res.status}`);
  }

  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error(`Could not parse "${def.label}" as RSS/Atom XML.`);
  }

  const now = new Date().toISOString();
  const items: CurrentItem[] = [];

  // RSS 2.0 / RSS 1.0 style: <item><title/><link/><pubDate/><description/></item>
  const rssItems = doc.querySelectorAll('item');
  if (rssItems.length > 0) {
    rssItems.forEach((el) => {
      const title = el.querySelector('title')?.textContent?.trim() ?? '';
      const link = el.querySelector('link')?.textContent?.trim() ?? '';
      if (!title || !link) return;
      items.push({
        title,
        url: link,
        publishedAt: el.querySelector('pubDate')?.textContent?.trim() || undefined,
        summary: el.querySelector('description')?.textContent?.trim() || undefined,
        sourceLabel: def.label,
        currentSlug: def.slug,
        graphStableId,
        fetchedAt: now
      });
    });
    return items;
  }

  // Atom: <entry><title/><link href=.../><updated|published/><summary|content/></entry>
  doc.querySelectorAll('entry').forEach((el) => {
    const title = el.querySelector('title')?.textContent?.trim() ?? '';
    const link =
      el.querySelector('link[rel="alternate"]')?.getAttribute('href') ??
      el.querySelector('link')?.getAttribute('href') ??
      '';
    if (!title || !link) return;
    items.push({
      title,
      url: link,
      publishedAt:
        el.querySelector('updated')?.textContent?.trim() ||
        el.querySelector('published')?.textContent?.trim() ||
        undefined,
      summary:
        el.querySelector('summary')?.textContent?.trim() ||
        el.querySelector('content')?.textContent?.trim() ||
        undefined,
      sourceLabel: def.label,
      currentSlug: def.slug,
      graphStableId,
      fetchedAt: now
    });
  });
  return items;
}

function currentSourceUri(graphStableId: string, slug: string): string {
  return `current://${graphStableId}/${slug}`;
}

/** Find or create the (one, stable) Source record that arrivals from this current attach to. */
async function ensureCurrentSource(def: CurrentDef, graphStableId: string): Promise<Source> {
  const uri = currentSourceUri(graphStableId, def.slug);
  const existing = allSources().find((s) => s.uri === uri);
  if (existing) return existing;

  const source: Source = {
    id: uuid(),
    title: def.label,
    uri,
    ingestedAt: Date.now(),
    kind: 'url'
  };
  await addSource(source);
  return source;
}

export interface ProcessArrivalsResult {
  processed: number;
  skipped: number;
  statementCount: number;
}

/**
 * Turn fetched current items into pending graph statements. Full LLM
 * extraction over every arrival is too heavy to run unattended on a 30-min
 * sweep, so this builds just the article/document node (buildArrivalStatements
 * with an empty `extracted` list) — the type gate and review queue still
 * apply via addStatements(..., { origin: 'current' }). Deeper extraction can
 * run later, on demand, from the review UI.
 */
export async function processArrivals(
  items: CurrentItem[],
  def: CurrentDef,
  graphStableId: string,
  signal?: AbortSignal,
): Promise<ProcessArrivalsResult> {
  if (items.length === 0) return { processed: 0, skipped: 0, statementCount: 0 };

  signal?.throwIfAborted();
  const source = await ensureCurrentSource(def, graphStableId);
  let processed = 0;
  let skipped = 0;
  let statementCount = 0;
  const existing = userStatements();
  const knownIds = new Set(existing.map((st) => st.id));
  // Keep pre-URL-identity arrivals intact too, including rejected ones. No migration rewrites a
  // person's review or merges two old title-derived entities behind their back.
  const legacyUrls = new Set(existing.filter((st) => st.id.startsWith('arrival|') &&
    st.p.value === 'urn:kbase:predicate/url' && st.s.value !== currentArticleIri(st.o.value))
    .map((st) => st.o.value));

  for (const item of items) {
    signal?.throwIfAborted();
    if (!isCurrentItem(item) || item.graphStableId !== graphStableId || item.currentSlug !== def.slug ||
      !def.enabled || legacyUrls.has(item.url)) {
      skipped++;
      continue;
    }
    const arrival = buildArrivalStatements({
      title: item.title,
      url: item.url,
      publishedAt: item.publishedAt,
      excerpt: item.summary,
      sourceId: source.id,
      extracted: []
    }).filter((st) => !knownIds.has(st.id));
    if (arrival.length === 0) { skipped++; continue; }
    await addStatements(arrival, source.id, { origin: 'current' });
    for (const st of arrival) knownIds.add(st.id);
    statementCount += arrival.length;
    processed++;
  }

  return { processed, skipped, statementCount };
}
