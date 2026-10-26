<script lang="ts">
  import { statements, sources, persistPurposeOrganization } from '$lib/stores/kb.svelte';
  import { settings, updateSettings } from '$lib/stores/settings.svelte';
  import { officialKbActive } from '$lib/stores/official-kb.svelte';
  import { db } from '$lib/storage/db';
  import { snapshotKnowledgeBaseState } from '$lib/storage/kb-snapshots';
  import { checkable } from '$lib/rdf/triple-check';
  import { purposeOrganization, type PurposeGroup } from '$lib/rdf/purpose-organization';
  import { runPartition } from '$lib/rdf/partition-run';
  import type { FactCluster } from '$lib/rdf/fact-aggregation';
  let purpose = $state(settings().analyzeGuidance ?? settings().kbDescription ?? ''), message = $state(''), busy = $state(false), failed = $state(false);
  const prior = $derived(new Set(sources().filter(s => s.uri.startsWith('analysis://purpose/')).map(s => s.id)));
  const scope = $derived(statements().filter(s => checkable(s) && !prior.has(s.sourceId)));
  async function organize() {
    if (busy || officialKbActive()) return;
    const purposes = [...new Set(purpose.split('\n').map(s => s.trim()).filter(Boolean))];
    if (!purposes.length || !scope.length) return;
    busy = true; failed = false; message = '';
    const initial = JSON.parse(JSON.stringify(scope));
    try {
      let groups: PurposeGroup[];
      if (purposes.length === 1) groups = [{ purpose: purposes[0], statementIds: initial.map((s: { id: string }) => s.id) }];
      else {
        if (initial.length > 200) throw new Error('Multiple-purpose model sorting currently supports up to 200 statements. Use one purpose, or organize a smaller space. Nothing changed.');
        const cluster: FactCluster = { id: 'purpose-analysis', basis: 'semantic', key: 'user-purpose', question: 'What is this space for?', members: initial, altitude: 'evidence', proposes: { subject: '', predicate: '', object: '' } };
        const result = await runPartition(cluster, purposes.join('\n'), settings());
        if (result.error || !result.outcome?.parts.length || result.outcome.rejected.length) throw new Error(result.error || 'Could not assign every statement to your exact purposes. Nothing changed.');
        groups = result.outcome.parts.map(p => ({ purpose: p.purpose, statementIds: p.members.map(s => s.id) }));
      }
      if (officialKbActive()) throw new Error('The active space changed. Please retry.');
      const at = Date.now(), sourceId = `purpose-analysis-${crypto.randomUUID()}`;
      const changes = purposeOrganization(purposes, groups, initial, sourceId, at);
      await snapshotKnowledgeBaseState(db, 'Before purpose-based Analyze');
      await persistPurposeOrganization({ id: sourceId, title: 'Purpose-based Analyze', uri: `analysis://purpose/${sourceId}`, kind: 'analysis', ingestedAt: at, trustLevel: 'review' }, changes, initial);
      await updateSettings({ analyzeGuidance: purpose.trim() });
      message = `Applied ${groups.length} purpose set(s) over ${initial.length} statements. Original wording and review decisions are preserved. Recovery snapshot saved in Settings.`;
    } catch (e) { failed = true; message = e instanceof Error ? e.message : 'Analyze failed.'; } finally { busy = false; }
  }
</script>
<section class="purpose-analysis"><h3>Reshape this space around its purpose</h3>
  <p>When your purpose changes, Analyze can apply new organizational links automatically. Factual corrections remain optional Triple Check suggestions.</p>
  <label>Current purposes — one per line<textarea bind:value={purpose} rows="3" disabled={busy}></textarea></label>
  <p>{scope.length} pending and retained assertions. One purpose groups entities directly; several purposes use your configured analysis model (up to 200 assertions).</p>
  <button onclick={organize} disabled={busy || officialKbActive() || !scope.length || !purpose.trim()}>{busy ? 'Organizing…' : 'Analyze and apply organization'}</button>
  {#if message}<p role={failed ? 'alert' : 'status'}>{message}</p>{/if}
  <a href="/settings/triple-check">Continuous validation settings →</a>
</section>
<style>
  .purpose-analysis { border: 1px solid var(--line); padding: 1rem; margin: 1rem 0; border-radius: var(--rad); } label { display: grid; gap: 0.4rem; } textarea { width: 100%; box-sizing: border-box; padding: 0.6rem; background: var(--surface); color: var(--ink); border: 1px solid var(--line); } p { font-size: 0.85rem; line-height: 1.5; } a { display: block; margin-top: 0.6rem; color: var(--accent); }
</style>
