<script lang="ts">
  /**
   * "Compare two documents" on the Ingest page (F306.1). Two inputs (a web address or a file each)
   * and a name. Both go through the ordinary ingest pipeline; the pair is recorded as one named
   * comparison, and a direct link opens the main canvas in the comparison layout.
   * Elapsed time per document is the real clock, not an estimate (kb:honest-status).
   */
  import { onDestroy } from 'svelte';
  import { ingest } from '$lib/stores/ingest.svelte';
  import { addStatements } from '$lib/stores/kb.svelte';
  import {
    runTwoSourceComparison, readFileForIngest, blankSide,
    type SourceSpec, type SideState, type TwoSourceResult,
  } from '$lib/ingest/two-source';
  import { formatElapsed } from '$lib/rdf/source-comparison';

  type Draft = { url: string; file: File | null };
  let name = $state('');
  let a = $state<Draft>({ url: '', file: null });
  let b = $state<Draft>({ url: '', file: null });
  let busy = $state(false);
  let sides = $state<{ a: SideState; b: SideState } | null>(null);
  let result = $state<TwoSourceResult | null>(null);
  let tick = $state(Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;

  const spec = (d: Draft): SourceSpec | null =>
    d.file ? { kind: 'file', file: d.file } : d.url.trim() ? { kind: 'url', url: d.url.trim() } : null;
  const ready = $derived(!busy && name.trim().length > 0 && spec(a) !== null && spec(b) !== null);

  function elapsed(s: SideState): string {
    if (s.startedAt == null) return '';
    return formatElapsed((s.endedAt ?? tick) - s.startedAt);
  }
  const STATUS: Record<SideState['status'], string> = {
    waiting: 'waiting', running: 'working', done: 'added', failed: 'failed',
  };

  async function start() {
    const sa = spec(a), sb = spec(b);
    if (!sa || !sb || !ready) return;
    busy = true;
    result = null;
    sides = { a: blankSide('A', sa), b: blankSide('B', sb) };
    timer = setInterval(() => (tick = Date.now()), 1000);
    try {
      result = await runTwoSourceComparison(
        { name, a: sa, b: sb },
        (s) => (sides = s),
        {
          ingest: (input, onProgress) => ingest(input, onProgress),
          record: (sts) => addStatements(sts, undefined, { origin: 'manual' }),
          readFile: readFileForIngest,
          now: () => Date.now(),
        },
      );
      sides = { a: result.a, b: result.b };
      // Printed so a run on a real machine leaves its measured wall clock in the console.
      console.info(`[two-documents] comparison "${name}" took ${result.totalMs} ms; ` +
        `A ${(result.a.endedAt ?? 0) - (result.a.startedAt ?? 0)} ms, B ${(result.b.endedAt ?? 0) - (result.b.startedAt ?? 0)} ms`);
    } finally {
      if (timer) clearInterval(timer);
      timer = null;
      busy = false;
    }
  }
  onDestroy(() => { if (timer) clearInterval(timer); });
</script>

<div class="card two-source" data-testid="two-source">
  <p class="hint">
    Two web pages, two PDFs, or one of each. Each goes through the same reading as anything you add,
    then the pair is saved as one named comparison. Each document is read in turn, and how long each
    takes depends on your model and the length of the document.
  </p>
  <label>
    <span class="lbl mono">comparison name</span>
    <input type="text" bind:value={name} placeholder="e.g. pricing page vs competitor page" data-testid="cmp-name" />
  </label>
  <div class="pair">
    {#each [{ k: 'A', d: a, id: 'a' }, { k: 'B', d: b, id: 'b' }] as side}
      <fieldset class="side">
        <legend class="mono">document {side.k}</legend>
        <label>
          <span class="lbl mono">web address</span>
          <input type="url" bind:value={side.d.url} disabled={busy || !!side.d.file} placeholder="https://..." data-testid="cmp-url-{side.id}" />
        </label>
        <label>
          <span class="lbl mono">or a file (pdf, text)</span>
          <input type="file" accept=".pdf,.txt,.md,.markdown,application/pdf,text/*" disabled={busy}
            data-testid="cmp-file-{side.id}"
            onchange={(e) => (side.d.file = (e.currentTarget as HTMLInputElement).files?.[0] ?? null)} />
        </label>
      </fieldset>
    {/each}
  </div>
  <div class="row">
    <span class="hint mono">saved as one comparison; every statement keeps the document it came from</span>
    <button class="primary" onclick={start} disabled={!ready} data-testid="cmp-start">
      {busy ? 'working…' : 'compare these two →'}
    </button>
  </div>

  {#if sides}
    <ul class="progress" role="status" aria-live="polite" data-testid="cmp-progress">
      {#each [sides.a, sides.b] as s}
        <li data-status={s.status} data-testid="cmp-side-{s.label.toLowerCase()}">
          <strong class="mono">{s.label}</strong>
          <span class="what">{s.what}</span>
          <span class="mono state">
            {STATUS[s.status]}{s.phase ? ` (${s.phase})` : ''}{s.status === 'done' ? `, ${s.statementCount} statements` : ''}
            {#if elapsed(s)} · {elapsed(s)}{/if}
          </span>
          {#if s.error}<span class="err" role="alert">{s.error}</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if result}
    <div class="done" data-testid="cmp-done">
      {#if result.link}
        <a class="open" href={result.link} data-testid="cmp-link">open "{name.trim()}" in the graph →</a>
        {#if result.a.status === 'failed' || result.b.status === 'failed'}
          <p class="hint">Only the document that arrived is in this link; the one that failed is recorded as failed.</p>
        {/if}
      {:else}
        <p class="err" role="alert">Neither document could be added, so there is nothing to open. The reasons are above.</p>
      {/if}
      <p class="hint mono" data-testid="cmp-total">whole run: {formatElapsed(result.totalMs)} (measured on this device)</p>
    </div>
  {/if}
</div>

<style>
  .two-source { display: flex; flex-direction: column; gap: 1rem; }
  label { display: flex; flex-direction: column; gap: 0.35rem; }
  .lbl { color: var(--muted); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.12em; }
  .hint { color: var(--muted); font-size: 0.75rem; margin: 0; }
  .err { color: var(--danger); font-family: var(--font-mono); font-size: 0.8rem; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  @media (max-width: 640px) { .pair { grid-template-columns: 1fr; } }
  .side { border: 1px solid var(--border, rgba(255,255,255,0.12)); border-radius: 8px; padding: 0.8rem; display: flex; flex-direction: column; gap: 0.8rem; margin: 0; min-width: 0; }
  .side legend { color: var(--accent); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; padding: 0 0.4rem; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
  .progress { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .progress li { display: grid; grid-template-columns: auto 1fr; gap: 0.2rem 0.7rem; font-size: 0.85rem; }
  .progress .what { overflow-wrap: anywhere; }
  .progress .state { grid-column: 2; color: var(--muted); font-size: 0.75rem; }
  .progress li[data-status='failed'] .state { color: var(--danger); }
  .progress li .err { grid-column: 2; }
  .done { display: flex; flex-direction: column; gap: 0.4rem; }
  .open { color: var(--accent); font-family: var(--font-mono); font-size: 0.95rem; }
</style>
