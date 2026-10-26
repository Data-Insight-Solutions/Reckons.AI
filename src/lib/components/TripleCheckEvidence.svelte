<script lang="ts">
  import { statements } from '$lib/stores/kb.svelte';
  import { tripleCheckReports, acknowledgeTripleCheck } from '$lib/stores/triple-check.svelte';
  import { claimFingerprint, checkable, hasConflict, evidenceEstimate } from '$lib/rdf/triple-check';
  let { fingerprint }: { fingerprint?: string } = $props();
  let error = $state('');
  const rows = $derived.by(() => {
    const live = new Set(statements().filter(checkable).map(claimFingerprint));
    const seen = new Set<string>();
    return tripleCheckReports().filter(r => {
      if ((fingerprint && r.fingerprint !== fingerprint) || !live.has(r.fingerprint) || seen.has(r.fingerprint)) return false;
      seen.add(r.fingerprint); return true;
    }).sort((a, b) => Number(hasConflict(b)) - Number(hasConflict(a))).slice(0, fingerprint ? 1 : 30);
  });
  async function reviewed(id: string) { try { await acknowledgeTripleCheck(id); } catch { error = 'Could not save the reviewed marker.'; } }
</script>
{#if rows.length}
<details id={fingerprint ? undefined : 'triple-check'} class="evidence">
  <summary>Triple Check evidence ({rows.length})</summary>
  <p>These are evidence suggestions. You decide which assertions to accept. Shared sources and copied pages do not establish independent agreement.</p>
  {#each rows as report}
    <article>
      <strong>{hasConflict(report) ? '⚠ Possible conflict' : 'Evidence available'}</strong>
      <p>{report.claim}</p>
      <small>{new Date(report.checkedAt).toLocaleString()} · {report.searchedSpaces} other spaces searched · {report.state}</small>
      {#if Date.now() - report.checkedAt > 7 * 86400000}<p>Evidence is out of date.</p>{/if}
      {#if report.web.length}<p>{evidenceEstimate(report.web)}. This is a qualitative estimate from sampled passages.</p>{/if}
      {#each report.web as source}<p><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a> — {source.stance}<br /><q>{source.snippet}</q></p>{/each}
      {#each report.spaces as source}
        <div class="space-evidence"><a data-sveltekit-reload href={`/?kb=${encodeURIComponent(source.spaceId)}&sel=${encodeURIComponent('i:' + source.entity)}`}>{source.spaceName}</a> — {source.stance ?? source.relation}
          <p>{source.claim}</p><small>{source.provenance}; different sources can still repeat the same underlying claim.</small>
          {#if source.explanation}<p>{source.explanation}</p>{/if}
          {#if source.suggestedWording}<p>Suggested wording: {source.suggestedWording}</p>{/if}
        </div>
      {/each}
      {#each report.warnings as warning}<p class="warning">{warning}</p>{/each}
      {#if report.reviewed}<small>Reviewed</small>{:else}<button onclick={() => reviewed(report.id)}>Mark evidence reviewed</button>{/if}
    </article>
  {/each}
  {#if error}<p role="alert">{error}</p>{/if}
</details>
{/if}
<style>
  .evidence { padding: 0.7rem; border: 1px solid var(--line); border-radius: var(--rad); font-size: 0.8rem; max-height: 65vh; overflow: auto; overflow-wrap: anywhere; }
  summary { cursor: pointer; color: var(--accent); }
  article { border-top: 1px solid var(--line); padding: 0.8rem 0; }
  p { margin: 0.4rem 0; line-height: 1.5; } small { color: var(--muted); }
  .space-evidence { margin: 0.5rem 0; padding-left: 0.6rem; border-left: 2px solid var(--accent); }
  .warning { color: var(--muted); } a { color: var(--accent); } button { margin-top: 0.5rem; }
</style>
