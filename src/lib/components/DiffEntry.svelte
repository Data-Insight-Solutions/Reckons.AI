<script lang="ts">
  import type { DiffEntry } from '$lib/rdf/diff';
  import StatementCard from './StatementCard.svelte';
  import { setStatus, supersede, updateStatement, entityChoices } from '$lib/stores/kb.svelte';
  import { recordAnswer } from '$lib/stores/workspace.svelte';
  import type { Statement, Term } from '$lib/rdf/types';
  import { isLit, iri, lit } from '$lib/rdf/types';
  import { v4 as uuid } from 'uuid';

  let { entry, onresolved = () => {}, sourceLabel = '' } = $props<{
    entry: DiffEntry;
    onresolved?: () => void;
    sourceLabel?: string;
  }>();

  let editing = $state(false);
  let editedObj = $state(isLit(entry.incoming.o) ? entry.incoming.o.value : '');
  let processing = $state(false);
  let error = $state<string | null>(null);

  // ── Partial fact (F32): reviewer fills the object's "loose end" ─────────────
  const isPartial = $derived(!!entry.incoming.needsObject);
  let fillQuery = $state('');
  let fillOpen = $state(false);
  let chosen = $state<{ term: Term; label: string } | null>(null);
  const choices = $derived(entityChoices());
  const fillMatches = $derived.by(() => {
    const q = fillQuery.trim().toLowerCase();
    const list = q === '' ? choices : choices.filter((c) => c.label.toLowerCase().includes(q) || c.iri.toLowerCase().includes(q));
    return list.slice(0, 10);
  });
  const showFillNew = $derived(
    fillQuery.trim().length > 0 &&
    !choices.some((c) => c.label.toLowerCase() === fillQuery.trim().toLowerCase())
  );
  const newEntityIri = $derived(`urn:kbase:concept/${fillQuery.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);

  function chooseExisting(c: { label: string; iri: string }) {
    chosen = { term: iri(c.iri), label: c.label };
    fillQuery = c.label; fillOpen = false;
  }
  function chooseNewEntity() { chosen = { term: iri(newEntityIri), label: fillQuery.trim() }; fillOpen = false; }
  function chooseValue() { chosen = { term: lit(fillQuery.trim()), label: fillQuery.trim() }; fillOpen = false; }

  async function acceptPartial() {
    if (!chosen) return;
    error = null; processing = true;
    try {
      await updateStatement(entry.incoming.id, { o: chosen.term, needsObject: false });
      await setStatus(entry.incoming.id, 'confirmed');
      // Flow the answer back to the waiting sub-agent (F32).
      await recordAnswer({
        subject: entry.incoming.s.value,
        predicate: entry.incoming.p.value,
        object: chosen.term.value,
        objectKind: chosen.term.kind === 'iri' ? 'iri' : 'literal',
        question: entry.incoming.question,
      });
      onresolved();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.error('Failed to fill & accept:', e);
    } finally {
      processing = false;
    }
  }

  async function accept() {
    error = null;
    processing = true;
    try {
      await setStatus(entry.incoming.id, 'confirmed');
      onresolved();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.error('Failed to accept:', e);
    } finally {
      processing = false;
    }
  }
  async function reject() {
    error = null;
    processing = true;
    try {
      await setStatus(entry.incoming.id, 'rejected');
      onresolved();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.error('Failed to reject:', e);
    } finally {
      processing = false;
    }
  }
  async function pickIncoming() {
    if (entry.kind !== 'conflicts' && entry.kind !== 'refines' && entry.kind !== 'antonym-conflicts') return;
    error = null;
    processing = true;
    try {
      for (const e of entry.existing) await setStatus(e.id, 'superseded');
      await setStatus(entry.incoming.id, 'refined');
      onresolved();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.error('Failed to pick incoming:', e);
    } finally {
      processing = false;
    }
  }
  async function pickExisting() {
    if (entry.kind !== 'conflicts' && entry.kind !== 'refines' && entry.kind !== 'antonym-conflicts') return;
    error = null;
    processing = true;
    try {
      for (const e of entry.existing) await setStatus(e.id, 'confirmed');
      await setStatus(entry.incoming.id, 'rejected');
      onresolved();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.error('Failed to pick existing:', e);
    } finally {
      processing = false;
    }
  }
  async function keepBoth() {
    error = null;
    processing = true;
    try {
      // Confirm the incoming alongside the existing — not actually a conflict
      await setStatus(entry.incoming.id, 'confirmed');
      onresolved();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      processing = false;
    }
  }

  async function saveRefinement() {
    if (!isLit(entry.incoming.o)) return;
    error = null;
    processing = true;
    try {
      const refined: Statement = {
        ...entry.incoming,
        id: uuid(),
        o: { ...entry.incoming.o, value: editedObj },
        status: 'refined',
        supersedes: entry.incoming.id,
        updatedAt: Date.now()
      };
      await supersede(entry.incoming.id, refined);
      editing = false;
      onresolved();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.error('Failed to save refinement:', e);
    } finally {
      processing = false;
    }
  }

  const labels: Record<DiffEntry['kind'], string> = {
    new: 'new',
    duplicate: 'duplicate',
    reinforces: 'reinforces',
    conflicts: 'conflicts',
    refines: 'refines',
    'near-duplicate': 'near duplicate',
    'synonym-reinforces': 'synonym',
    'antonym-conflicts': 'contradiction',
  };
</script>

<div class="entry">
  {#if sourceLabel}
    <div class="source-title mono">{sourceLabel}</div>
  {/if}
  <div class="header">
    <span class="tag {entry.kind}">{labels[entry.kind as DiffEntry['kind']]}</span>
    {#if entry.kind === 'reinforces'}
      <span class="muted">new source corroborates existing claim</span>
    {:else if entry.kind === 'duplicate'}
      <span class="muted">exact n-quad already known</span>
    {:else if entry.kind === 'conflicts'}
      <span class="muted">disagrees with {entry.existing.length} prior fact(s)</span>
    {:else if entry.kind === 'refines'}
      <span class="muted">more specific than {entry.existing.length} prior fact(s)</span>
    {:else if entry.kind === 'near-duplicate'}
      <span class="muted">subject matches existing entity ({(entry.subjectSimilarity * 100).toFixed(0)}% similar) — same person?</span>
    {:else if entry.kind === 'synonym-reinforces'}
      <span class="muted">predicate is synonymous with existing claim ({(entry.predicateSimilarity * 100).toFixed(0)}% match)</span>
    {:else if entry.kind === 'antonym-conflicts'}
      <span class="muted">{entry.note}</span>
    {/if}
  </div>

  <StatementCard statement={entry.incoming} compact />
  {#if entry.incoming.excerpt}
    <blockquote class="excerpt">{entry.incoming.excerpt}</blockquote>
  {/if}

  {#if entry.kind === 'conflicts' || entry.kind === 'refines' || entry.kind === 'reinforces' || entry.kind === 'synonym-reinforces' || entry.kind === 'antonym-conflicts'}
    <div class="vs">
      {#each entry.existing as ex}
        <StatementCard statement={ex} compact />
      {/each}
    </div>
  {:else if entry.kind === 'near-duplicate'}
    <div class="vs near-dup-vs">
      <p class="vs-label">closest existing entity:</p>
      <StatementCard statement={entry.existing} compact />
    </div>
  {/if}

  {#if isPartial}
    <div class="partial-fill">
      {#if entry.incoming.question}
        <p class="pf-question">❓ {entry.incoming.question}</p>
      {/if}
      <p class="pf-hint mono">fill the object of this fact — pick an existing entity or add a new one:</p>
      {#if chosen}
        <div class="pf-chosen-row">
          <span class="pf-chosen">{chosen.label}
            <span class="pf-kind mono">{chosen.term.kind === 'iri' ? 'entity' : 'value'}</span>
          </span>
          <button class="ghost" onclick={() => { chosen = null; fillQuery = ''; }} disabled={processing}>change</button>
        </div>
      {:else}
        <div class="pf-picker">
          <input class="pf-input" bind:value={fillQuery}
            oninput={() => (fillOpen = true)} onfocus={() => (fillOpen = true)}
            placeholder="search existing entities or type a new value…" />
          {#if fillOpen && (fillMatches.length > 0 || showFillNew)}
            <ul class="pf-dropdown">
              {#each fillMatches as c (c.key)}
                <li>
                  <button type="button" onclick={() => chooseExisting(c)}>
                    <span class="pf-opt-label">{c.label}</span>
                    <span class="pf-opt-iri mono">{c.iri.split('/').pop()}</span>
                  </button>
                </li>
              {/each}
              {#if showFillNew}
                <li class="pf-new"><button type="button" onclick={chooseNewEntity}>＋ new entity: <b>{fillQuery.trim()}</b></button></li>
                <li class="pf-new"><button type="button" onclick={chooseValue}>＋ use as text value: <b>"{fillQuery.trim()}"</b></button></li>
              {/if}
            </ul>
          {/if}
        </div>
      {/if}
      <div class="actions">
        <button class="primary" onclick={acceptPartial} disabled={processing || !chosen}>
          {processing ? 'saving…' : 'fill & accept'}
        </button>
        <button class="danger" onclick={reject} disabled={processing}>
          {processing ? 'rejecting…' : 'reject'}
        </button>
      </div>
    </div>
  {:else if editing}
    <div class="edit-row">
      <input type="text" bind:value={editedObj} placeholder="Refined value..." />
      <button class="primary" onclick={saveRefinement} disabled={processing}>
        {processing ? 'saving…' : 'save refinement'}
      </button>
      <button class="ghost" onclick={() => (editing = false)} disabled={processing}>cancel</button>
    </div>
  {:else}
    <div class="actions">
      {#if entry.kind === 'new'}
        <button class="primary" onclick={accept} disabled={processing}>
          {processing ? 'accepting…' : 'accept'}
        </button>
        {#if isLit(entry.incoming.o)}
          <button onclick={() => (editing = true)} disabled={processing}>refine</button>
        {/if}
        <button class="danger" onclick={reject} disabled={processing}>
          {processing ? 'rejecting…' : 'reject'}
        </button>
      {:else if entry.kind === 'duplicate'}
        <button onclick={reject} disabled={processing}>
          {processing ? 'dismissing…' : 'dismiss'}
        </button>
      {:else if entry.kind === 'reinforces'}
        <button class="primary" onclick={accept} disabled={processing}>
          {processing ? 'adding…' : 'add as new source citation'}
        </button>
        <button class="danger" onclick={reject} disabled={processing}>
          {processing ? 'dismissing…' : 'dismiss'}
        </button>
      {:else if entry.kind === 'conflicts'}
        <button class="primary" onclick={pickIncoming} disabled={processing}>
          {processing ? 'updating…' : 'keep new'}
        </button>
        <button onclick={pickExisting} disabled={processing}>
          {processing ? 'updating…' : 'keep existing'}
        </button>
        <button onclick={keepBoth} disabled={processing} title="Not actually a conflict — keep both statements">
          {processing ? 'saving…' : 'keep both'}
        </button>
        {#if isLit(entry.incoming.o)}
          <button onclick={() => (editing = true)} disabled={processing}>refine</button>
        {/if}
      {:else if entry.kind === 'refines'}
        <button class="primary" onclick={pickIncoming} disabled={processing}>
          {processing ? 'updating…' : 'accept refinement'}
        </button>
        <button onclick={pickExisting} disabled={processing}>
          {processing ? 'updating…' : 'keep coarser'}
        </button>
      {:else if entry.kind === 'near-duplicate'}
        <button class="primary" onclick={accept} disabled={processing}
          title="Accept as a distinct entity separate from the similar one">
          {processing ? 'accepting…' : 'keep as new entity'}
        </button>
        <button onclick={reject} disabled={processing}>
          {processing ? 'rejecting…' : 'reject'}
        </button>
      {:else if entry.kind === 'synonym-reinforces'}
        <button class="primary" onclick={accept} disabled={processing}>
          {processing ? 'adding…' : 'accept as citation'}
        </button>
        <button onclick={reject} disabled={processing}>
          {processing ? 'dismissing…' : 'dismiss'}
        </button>
      {:else if entry.kind === 'antonym-conflicts'}
        <button class="primary" onclick={pickIncoming} disabled={processing}>
          {processing ? 'updating…' : 'keep new, reject old'}
        </button>
        <button onclick={pickExisting} disabled={processing}>
          {processing ? 'updating…' : 'keep existing'}
        </button>
        <button onclick={keepBoth} disabled={processing} title="Both may be valid at different times">
          {processing ? 'saving…' : 'keep both'}
        </button>
      {/if}
    </div>
  {/if}

  {#if error}
    <div class="error-msg">{error}</div>
  {/if}
</div>

<style>
  .tag {
    font-family: var(--font-mono);
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    border: 1px solid var(--line);
    color: var(--muted);
  }
  .tag.new               { color: var(--data);   border-color: var(--data); }
  .tag.reinforces        { color: var(--ok);     border-color: var(--ok); }
  .tag.refines           { color: var(--accent); border-color: var(--accent); }
  .tag.conflicts         { color: var(--danger); border-color: var(--danger); }
  .tag.near-duplicate    { color: #f59e0b; border-color: #f59e0b; }
  .tag.synonym-reinforces{ color: var(--ok);     border-color: var(--ok); }
  .tag.antonym-conflicts { color: var(--danger); border-color: var(--danger); }

  .source-title {
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--accent);
    letter-spacing: 0.04em;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--line);
    margin-bottom: -0.1rem;
  }
  .entry {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1.1rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    margin-bottom: 1rem;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    font-size: 0.85rem;
  }
  .muted { color: var(--muted); font-style: italic; }
  .vs {
    padding-left: 1rem;
    border-left: 2px dashed var(--line);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .edit-row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .edit-row input { flex: 1 1 200px; }
  button:disabled { opacity: 0.6; cursor: not-allowed; }
  .error-msg { color: var(--danger); font-size: 0.85rem; margin-top: 0.5rem; }

  .near-dup-vs { gap: 0.3rem; }
  .vs-label { font-size: 0.65rem; color: var(--muted); margin: 0 0 0.3rem; font-family: var(--font-mono); }
  .excerpt {
    font-size: 0.78rem;
    font-style: italic;
    color: var(--muted);
    border-left: 2px solid var(--line);
    padding: 0.2rem 0.55rem;
    margin: -0.25rem 0 0 0;
    line-height: 1.3;
  }

  /* ── Partial fact fill (F32) ── */
  .partial-fill { display: flex; flex-direction: column; gap: 0.6rem; }
  .pf-question { font-size: 0.9rem; color: var(--accent); margin: 0; font-weight: 600; }
  .pf-hint { font-size: 0.68rem; color: var(--muted); margin: 0; }
  .pf-picker { position: relative; }
  .pf-input { width: 100%; }
  .pf-dropdown {
    list-style: none; margin: 0.2rem 0 0; padding: 0.2rem;
    position: absolute; z-index: 10; left: 0; right: 0;
    background: var(--surface); border: 1px solid var(--line); border-radius: var(--rad);
    max-height: 220px; overflow-y: auto; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
  }
  .pf-dropdown li { margin: 0; }
  .pf-dropdown button {
    display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;
    width: 100%; text-align: left; padding: 0.35rem 0.5rem; border: none;
    background: transparent; color: inherit; border-radius: 6px; cursor: pointer;
  }
  .pf-dropdown button:hover { background: var(--line); }
  .pf-opt-iri { font-size: 0.65rem; color: var(--muted); }
  .pf-new button { color: var(--accent); }
  .pf-chosen-row { display: flex; align-items: center; gap: 0.6rem; }
  .pf-chosen { font-weight: 600; }
  .pf-kind {
    font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0.05rem 0.4rem;
  }
</style>
