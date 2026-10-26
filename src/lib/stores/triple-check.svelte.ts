import { liveQuery } from 'dexie';
import { db, getSettings } from '$lib/storage/db';
import { getCurrentKbId, getRegistry } from '$lib/storage/kb-registry';
import { loadGraphsForQuery } from '$lib/storage/multi-graph-store';
import { runTripleCheck } from '$lib/storage/triple-check';
import type { TripleCheckReport } from '$lib/rdf/triple-check';
import { searchTripleCheck, scrapeTripleCheck } from '$lib/integrations/search/triple-check';
import { judgeWebEvidence, judgeSpaceEvidence, tripleCheckProviderError } from '$lib/integrations/llm/triple-check';
let reports = $state<TripleCheckReport[]>([]), status = $state('');
export const tripleCheckReports = () => reports;
export const tripleCheckStatus = () => status;
export const statementTripleCheck = (fingerprint: string) => reports.find(r => r.fingerprint === fingerprint);
export function observeTripleChecks() {
  const sub = liveQuery(() => db.tripleChecks.orderBy('checkedAt').reverse().toArray()).subscribe({ next: rows => { reports = rows; }, error: () => { status = 'Evidence could not be loaded.'; } });
  return () => sub.unsubscribe();
}
export async function acknowledgeTripleCheck(id: string) { await db.tripleChecks.update(id, { reviewed: true }); }
export function startTripleCheck() {
  const lifetime = new AbortController(); let running = false, active: AbortController | null = null, permission = '';
  const permissionKey = (row: unknown) => JSON.stringify(row);
  const watcher = liveQuery(() => db.settings.get('main')).subscribe(row => { if (active && permissionKey(row) !== permission) active.abort(); });
  const spaceId = getCurrentKbId();
  async function tick() {
    if (running || lifetime.signal.aborted) return; running = true;
    try {
      if (!navigator.locks) { status = 'Triple Check needs Web Locks support in this browser.'; return; }
      await navigator.locks.request(`reckons-triple-check:${spaceId}`, { ifAvailable: true }, async lock => {
        if (!lock || lifetime.signal.aborted) return;
        const config = await getSettings(); if (!config.tripleCheckEnabled) return;
        permission = permissionKey(await db.settings.get('main')); active = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, active.signal, AbortSignal.timeout(180000)]);
        status = 'Checking statements…';
        const result = await runTripleCheck(db, spaceId, config, {
          loadSpaces: () => { const ids = getRegistry().filter(g => g.id !== spaceId && !g.archiveOf).map(g => g.id); return loadGraphsForQuery({ ids, maxGraphs: ids.length }); },
          providerError: navigator.onLine ? tripleCheckProviderError(config) : 'Web not checked: offline.',
          search: (q, signal) => searchTripleCheck(config, q, signal), scrape: (s, signal) => scrapeTripleCheck(config, s, signal),
          judge: (claim, sources, signal) => judgeWebEvidence(claim, sources, config, signal),
          judgeSpaces: (claim, sources, signal) => judgeSpaceEvidence(claim, sources, config, signal),
        }, signal);
        status = result ? 'Evidence is ready in Review.' : 'Watching for new and changed statements.';
      });
    } catch { if (!lifetime.signal.aborted) status = 'Check incomplete; it will retry. See Review for partial evidence.'; }
    finally { running = false; active = null; }
  }
  void tick(); const timer = setInterval(() => { void tick(); }, 60000);
  return () => { lifetime.abort(); watcher.unsubscribe(); clearInterval(timer); status = ''; };
}
