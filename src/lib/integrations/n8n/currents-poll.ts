/**
 * Currents poll (F29.2) — the caller that kb:currents-client-unwired said was missing.
 *
 * currents-sync.ts is the n8n client (register / fetch / processArrivals). Until this file
 * existed nothing in the app called it, so whatever the person's n8n Currents Monitor collected
 * never reached the browser. This is the timer that closes that gap.
 *
 * OPT-IN IS THE EXISTING SETTING. The person's own n8n instance (settings.n8nBaseUrl) is the
 * only consent signal: with it unset, or with no enabled current defined in the graph, a tick
 * makes NO network call at all. Nothing here talks to any service the person did not name.
 * (The CSP lets the request out only for builds that know the origin; see src/app.html.)
 *
 * ONE SWEEP, NOT ONE REQUEST PER CURRENT. The items webhook is keyed by graph, not by current
 * (fetchCurrentItems(graphStableId, since)), so a single GET returns every current's new items,
 * each tagged with currentSlug. Fetching per current would multiply requests against the
 * person's own server for no gain. The sweep then groups by slug and calls processArrivals once
 * per current, so each current still keeps its own Source record (provenance stays per-current).
 * Items for a slug that is no longer defined or is disabled are dropped and counted, not imported.
 *
 * FAILURES ARE CONTAINED AND VISIBLE, NOT LOUD. A down n8n must neither break the app nor spam.
 * A failed tick never throws out of the timer; consecutive failures back the poll off
 * exponentially (cap 5 min); and the person gets ONE notification per outage (even if they
 * dismiss it, it does not return until a sweep has succeeded in between).
 *
 * HONEST LIMITS: arrivals are just the article entity (processArrivals does no LLM extraction),
 * repeat protection relies on the `since` cursor plus addStatements' handling of identical
 * statements, and nothing here has been run against a real n8n instance, only against fakes.
 */
import { getCurrentKbId } from '../../storage/kb-registry';
import { readCurrentsSettings, type CurrentDef } from '../../rdf/currents';
import { statements } from '../../stores/kb.svelte';
import { settings, updateSettings } from '../../stores/settings.svelte';
import { pushNotification, dismissNotification } from '../../stores/notifications.svelte';
import { getOrCreateStableId } from '../../storage/kb-fingerprint';
import { fetchCurrentItems, processArrivals, registerCurrent, type CurrentItem } from './currents-sync';

/**
 * Every five minutes, NOT the workspace poll's ten seconds. The workspace poll reads a local folder;
 * this one calls a server the person runs, and their n8n Currents Monitor only collects every 30
 * minutes, so polling faster finds nothing new and costs them ~8,600 requests a day per open tab.
 */
export const CURRENTS_POLL_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const FAILURE_NOTICE_ID = 'currents-n8n-unreachable';

export type SweepResult =
  | { status: 'skipped'; reason: 'no-n8n' | 'no-currents' | 'busy' }
  | { status: 'ok'; fetched: number; processed: number; skipped: number; unknownSlug: number }
  | { status: 'error'; error: string };

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let failures = 0;
let outageReported = false;
/** Currents already registered this session, keyed graph+definition so an edit re-registers. */
const registered = new Set<string>();

function sinceKey(): string {
  return `reckons:currents-since:${getCurrentKbId()}`;
}
function readSince(): string | undefined {
  try { return localStorage.getItem(sinceKey()) ?? undefined; } catch { return undefined; }
}
function writeSince(iso: string): void {
  try { localStorage.setItem(sinceKey(), iso); } catch { /* storage blocked: re-fetch, don't fail */ }
}

async function graphStableId(): Promise<string> {
  return getOrCreateStableId(settings().kbStableId, async (id) => {
    await updateSettings({ kbStableId: id });
  });
}

/** One poll tick. Never throws; the result says what happened. */
export async function runCurrentsSweep(): Promise<SweepResult> {
  if (running) return { status: 'skipped', reason: 'busy' };
  if (!settings().n8nBaseUrl?.trim()) return { status: 'skipped', reason: 'no-n8n' };
  const defs = readCurrentsSettings(statements()).currents.filter((c) => c.enabled);
  if (defs.length === 0) return { status: 'skipped', reason: 'no-currents' };

  running = true;
  try {
    const stableId = await graphStableId();
    const bySlug = new Map<string, CurrentDef>(defs.map((d) => [d.slug, d]));

    // registerCurrent is an idempotent upsert, but there is no reason to repeat it every tick.
    for (const def of defs) {
      const key = `${stableId}|${JSON.stringify(def)}`;
      if (registered.has(key)) continue;
      await registerCurrent(def, stableId);
      registered.add(key);
    }

    const items = await fetchCurrentItems(stableId, readSince());
    let processed = 0;
    let skipped = 0;
    let unknownSlug = 0;
    const grouped = new Map<string, CurrentItem[]>();
    for (const item of items) {
      const def = bySlug.get(item.currentSlug);
      if (!def) { unknownSlug++; continue; }
      grouped.set(def.slug, [...(grouped.get(def.slug) ?? []), item]);
    }
    for (const [slug, group] of grouped) {
      const r = await processArrivals(group, bySlug.get(slug)!, stableId);
      processed += r.processed;
      skipped += r.skipped;
    }

    // Advance the cursor only after every group landed, so a mid-sweep failure re-fetches.
    const newest = items.map((i) => i.fetchedAt).filter(Boolean).sort().pop();
    if (newest) writeSince(newest);

    failures = 0;
    outageReported = false;
    dismissNotification(FAILURE_NOTICE_ID);
    return { status: 'ok', fetched: items.length, processed, skipped, unknownSlug };
  } catch (e) {
    failures++;
    const error = e instanceof Error ? e.message : String(e);
    console.warn('[currents] poll failed:', error);
    if (!outageReported) {
      outageReported = true;
      pushNotification({
        id: FAILURE_NOTICE_ID,
        type: 'warn',
        title: 'Currents: your n8n could not be reached',
        body: `${error} The app keeps working and will retry with a longer wait each time.`,
        action: { label: 'Check n8n settings', href: '/settings/integrations#s-n8n' },
      });
    }
    return { status: 'error', error };
  } finally {
    running = false;
  }
}

function schedule(ms: number): void {
  timer = setTimeout(async () => {
    await runCurrentsSweep().catch((e) => console.warn('[currents] poll cycle failed:', e));
    if (timer !== null) schedule(Math.min(CURRENTS_POLL_MS * 2 ** failures, MAX_BACKOFF_MS));
  }, ms);
}

/** Start the poll (idempotent). Safe to call when nothing is configured: ticks then do nothing. */
export function startCurrentsPolling(ms: number = CURRENTS_POLL_MS): void {
  if (timer !== null || typeof setTimeout === 'undefined') return;
  schedule(ms);
}

export function stopCurrentsPolling(): void {
  if (timer !== null) { clearTimeout(timer); timer = null; }
}

/** TEST ONLY: reset module state between tests. */
export function __resetCurrentsPollForTest(): void {
  stopCurrentsPolling();
  running = false;
  failures = 0;
  outageReported = false;
  registered.clear();
}
