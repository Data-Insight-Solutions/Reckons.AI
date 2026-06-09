<script lang="ts">
  import { page } from '$app/state';
  import {
    confirmedStatements,
    statementsForSource,
    sources,
    setStatus
  } from '$lib/stores/kb.svelte';
  import { computeDiff } from '$lib/rdf/diff';
  import { generateDiffSummary, type DiffSummary } from '$lib/rdf/diff-summary';
  import { settings } from '$lib/stores/settings.svelte';
  import CompareGraph from '$lib/components/CompareGraph.svelte';

  // ── source context ─────────────────────────────────────────────────────────
  const sourceId = $derived(page.url.searchParams.get('source'));
  const source = $derived(sources().find((s) => s.id === sourceId));

  // Incoming = pending statements from this source
  const incoming = $derived(
    sourceId
      ? statementsForSource(sourceId).filter((s) => s.status === 'pending')
      : []
  );

  // Existing confirmed KB (excluding this source)
  const existing = $derived(confirmedStatements().filter((s) => s.sourceId !== sourceId));

  const diff = $derived(computeDiff(incoming, existing));

  // ── graph legend counts ─────────────────────────────────────────────────────
  // Count unique entity IDs by membership (for the graph legend)
  const legendCounts = $derived.by(() => {
    const inKeys = new Set(incoming.flatMap(s => [s.s.value, s.o.value]));
    const exKeys = new Set(existing.flatMap(s => [s.s.value, s.o.value]));
    const allKeys = new Set([...inKeys, ...exKeys]);
    let n = 0, sh = 0, kb = 0;
    for (const k of allKeys) {
      if (inKeys.has(k) && exKeys.has(k)) sh++;
      else if (inKeys.has(k)) n++;
      else kb++;
    }
    return { newCount: n, sharedCount: sh, kbOnlyCount: kb };
  });

  // Only show existing KB statements that share entities with the incoming source
  // (avoids flooding the graph with unrelated KB data)
  const relevantExisting = $derived.by(() => {
    const inValues = new Set(incoming.flatMap(s => [s.s.value, s.o.value]));
    return existing.filter(s => inValues.has(s.s.value) || inValues.has(s.o.value));
  });

  // ── diff summary ──────────────────────────────────────────────────────────
  let diffSummary = $state<DiffSummary | null>(null);
  let summaryLoading = $state(false);
  let summaryError = $state<string | null>(null);

  async function loadSummary() {
    summaryLoading = true;
    summaryError = null;
    try {
      diffSummary = await generateDiffSummary(diff, settings());
    } catch (e) {
      summaryError = e instanceof Error ? e.message : String(e);
    } finally {
      summaryLoading = false;
    }
  }

  // ── actions ────────────────────────────────────────────────────────────────
  async function acceptAll() {
    for (const st of incoming) {
      await setStatus(st.id, 'confirmed');
    }
  }

  async function rejectAll() {
    for (const st of incoming) {
      await setStatus(st.id, 'rejected');
    }
  }

  async function acceptNew() {
    const newIds = new Set(
      diff.entries.filter((e) => e.kind === 'new').map((e) => e.incoming.id)
    );
    for (const st of incoming) {
      if (newIds.has(st.id)) await setStatus(st.id, 'confirmed');
    }
  }

  async function rejectDuplicates() {
    const dupIds = new Set(
      diff.entries.filter((e) => e.kind === 'duplicate').map((e) => e.incoming.id)
    );
    for (const st of incoming) {
      if (dupIds.has(st.id)) await setStatus(st.id, 'rejected');
    }
  }

  // ── display helpers ────────────────────────────────────────────────────────
  const kindLabel: Record<string, string> = {
    new: 'new',
    duplicate: 'duplicate',
    reinforces: 'reinforces',
    conflicts: 'conflicts',
    refines: 'refines'
  };

  const kindColor: Record<string, string> = {
    new: 'var(--ok)',
    duplicate: 'var(--muted)',
    reinforces: 'var(--data)',
    conflicts: 'var(--danger)',
    refines: 'var(--accent)'
  };

  function shortVal(v: string, max = 48): string {
    return v.length > max ? v.slice(0, max) + '…' : v;
  }
</script>

<header class="head">
  <p class="kicker mono">compare</p>
  <h1>incoming vs. knowledge base</h1>
  {#if source}
    <p class="src-label mono">{source.title}</p>
  {/if}
</header>

<!-- ── 3D Compare Graph ──────────────────────────────────────────────────── -->
<CompareGraph
  {incoming}
  existing={relevantExisting}
  newCount={legendCounts.newCount}
  sharedCount={legendCounts.sharedCount}
  kbOnlyCount={legendCounts.kbOnlyCount}
/>

<!-- ── Summary pills ────────────────────────────────────────────────────── -->
<div class="summary-row">
  {#each Object.entries(diff.summary) as [kind, count]}
    {#if count > 0}
      <span class="pill mono" style="border-color: {kindColor[kind]}; color: {kindColor[kind]}">
        {count} {kindLabel[kind]}
      </span>
    {/if}
  {/each}
</div>

<!-- ── Diff Summary ─────────────────────────────────────────────────────── -->
{#if diffSummary}
  <div class="summary-cards">
    {#if diffSummary.newSummary && diffSummary.newSummary !== 'None.'}
      <div class="summary-card new-card">
        <h3 class="summary-heading mono">new information</h3>
        <p>{diffSummary.newSummary}</p>
      </div>
    {/if}
    {#if diffSummary.reinforcingSummary && diffSummary.reinforcingSummary !== 'None.'}
      <div class="summary-card reinforce-card">
        <h3 class="summary-heading mono">reinforcing</h3>
        <p>{diffSummary.reinforcingSummary}</p>
      </div>
    {/if}
    {#if diffSummary.conflictingSummary && diffSummary.conflictingSummary !== 'None.'}
      <div class="summary-card conflict-card">
        <h3 class="summary-heading mono">conflicts &amp; refinements</h3>
        <p>{diffSummary.conflictingSummary}</p>
      </div>
    {/if}
  </div>
{:else}
  <div class="summary-trigger">
    <button class="ghost" onclick={loadSummary} disabled={summaryLoading || diff.entries.length === 0}>
      {summaryLoading ? 'summarizing…' : 'summarize differences'}
    </button>
    {#if summaryError}<span class="summary-err">{summaryError}</span>{/if}
  </div>
{/if}

<!-- ── Batch actions ────────────────────────────────────────────────────── -->
<div class="actions-row">
  <button class="primary" onclick={acceptAll} disabled={incoming.length === 0}>
    accept all ({incoming.length})
  </button>
  <button onclick={acceptNew} disabled={diff.summary.new === 0}>
    accept new only ({diff.summary.new})
  </button>
  <button onclick={rejectDuplicates} disabled={diff.summary.duplicate === 0}>
    drop duplicates ({diff.summary.duplicate})
  </button>
  <button onclick={rejectAll} disabled={incoming.length === 0}>
    reject all
  </button>
</div>

<!-- ── Diff list ─────────────────────────────────────────────────────────── -->
<div class="diff-list">
  {#each diff.entries as entry (entry.incoming.id)}
    <div class="diff-entry" data-kind={entry.kind}>
      <span class="badge mono" style="color: {kindColor[entry.kind]}">{entry.kind}</span>
      <div class="triple mono">
        <span class="term s">{shortVal(entry.incoming.s.value)}</span>
        <span class="sep">·</span>
        <span class="term p">{shortVal(entry.incoming.p.value.split('/').pop() ?? entry.incoming.p.value)}</span>
        <span class="sep">·</span>
        <span class="term o">{shortVal(entry.incoming.o.value)}</span>
      </div>
      {#if entry.kind === 'conflicts' || entry.kind === 'refines'}
        <div class="existing-val mono">
          existing: {entry.existing.map((e) => shortVal(e.o.value, 36)).join(', ')}
        </div>
      {/if}
      <div class="entry-actions">
        <button class="sm" onclick={() => setStatus(entry.incoming.id, 'confirmed')}>✓</button>
        <button class="sm danger" onclick={() => setStatus(entry.incoming.id, 'rejected')}>✗</button>
      </div>
    </div>
  {/each}
  {#if diff.entries.length === 0}
    <div class="empty">no pending statements for this source.</div>
  {/if}
</div>

<style>
  .head { margin-bottom: 1rem; }
  .kicker {
    color: var(--accent);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    margin: 0 0 0.5rem;
  }
  .src-label {
    color: var(--muted);
    font-size: 0.8rem;
    margin: 0.3rem 0 0;
  }

  /* ── Summary pills ── */
  .summary-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 1rem;
  }
  .pill {
    padding: 0.25rem 0.7rem;
    border-radius: 999px;
    border: 1px solid;
    font-size: 0.72rem;
    text-transform: lowercase;
  }

  /* ── Actions ── */
  .actions-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 1.25rem;
  }

  /* ── Diff list ── */
  .diff-list {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  .diff-entry {
    display: grid;
    grid-template-columns: 5.5rem 1fr auto;
    grid-template-rows: auto auto;
    align-items: center;
    gap: 0.2rem 0.7rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.55rem 0.8rem;
  }
  .diff-entry[data-kind='conflicts'] { border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); }
  .diff-entry[data-kind='new'] { border-color: color-mix(in srgb, var(--ok) 30%, var(--line)); }
  .badge {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .triple {
    font-size: 0.75rem;
    color: var(--ink-2);
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    align-items: center;
  }
  .sep { color: var(--muted); }
  .term.s { color: var(--accent); }
  .term.p { color: var(--muted); }
  .term.o { color: var(--data); }
  .existing-val {
    grid-column: 1 / -1;
    font-size: 0.7rem;
    color: var(--muted);
    padding-left: 0.1rem;
  }
  .entry-actions {
    display: flex;
    gap: 0.3rem;
    grid-row: 1;
    grid-column: 3;
  }
  button.sm {
    padding: 0.25rem 0.55rem;
    font-size: 0.8rem;
    border-radius: var(--rad-sm);
    min-width: 0;
  }
  .empty {
    text-align: center;
    color: var(--muted);
    padding: 2rem 1rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
  }

  /* ── Diff Summary ── */
  .summary-trigger {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    margin-bottom: 1rem;
  }
  .summary-err {
    color: var(--danger);
    font-size: 0.78rem;
  }
  .summary-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0.65rem;
    margin-bottom: 1.25rem;
  }
  .summary-card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 0.85rem 1rem;
  }
  .summary-card p {
    font-size: 0.85rem;
    line-height: 1.4;
    color: var(--ink-2);
    margin: 0;
  }
  .summary-heading {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin: 0 0 0.4rem;
  }
  .new-card { border-color: color-mix(in srgb, var(--ok) 40%, var(--line)); }
  .new-card .summary-heading { color: var(--ok); }
  .reinforce-card { border-color: color-mix(in srgb, var(--data) 40%, var(--line)); }
  .reinforce-card .summary-heading { color: var(--data); }
  .conflict-card { border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); }
  .conflict-card .summary-heading { color: var(--danger); }
</style>
