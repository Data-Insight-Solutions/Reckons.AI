import { liveQuery } from 'dexie';
import { db, getSettings } from '$lib/storage/db';
import { getCurrentKbId, getRegistry } from '$lib/storage/kb-registry';
import { loadGraphsForQuery } from '$lib/storage/multi-graph-store';
import { runTripleCheck } from '$lib/storage/triple-check';
import type { EvidenceProposal } from '$lib/rdf/triple-check';
import { persistSourceBatch, prepareStatementsForWrite } from '$lib/stores/kb.svelte';
import { searchTripleCheck, scrapeTripleCheck } from '$lib/integrations/search/triple-check';
import { judgeWebEvidence, judgeSpaceEvidence, tripleCheckProviderError } from '$lib/integrations/llm/triple-check';
let status = $state('');
export const tripleCheckStatus = () => status;
/** Findings land in Review as pending statements from their own source, through the same admission
 *  funnel as any agent's proposals: content policy, and the F52 boundary that keeps them pending. */
async function propose(proposals: EvidenceProposal[]) {
  let added = 0;
  for (const { source, statements } of proposals) {
    added += (await persistSourceBatch(source, await prepareStatementsForWrite(statements, source.id, { origin: 'agent' }))).length;
  }
  return added;
}
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
          judgeSpaces: (claim, sources, signal) => judgeSpaceEvidence(claim, sources, config, signal), propose,
        }, signal);
        status = !result ? 'Watching for new and changed statements.'
          : result.proposed ? `Added ${result.proposed} statement${result.proposed === 1 ? '' : 's'} to Review from what it found.`
          : 'Checked a statement; nothing new to add.';
      });
    } catch { if (!lifetime.signal.aborted) status = 'Check incomplete; it will retry.'; }
    finally { running = false; active = null; }
  }
  void tick(); const timer = setInterval(() => { void tick(); }, 60000);
  return () => { lifetime.abort(); watcher.unsubscribe(); clearInterval(timer); status = ''; };
}
