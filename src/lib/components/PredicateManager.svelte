<script lang="ts">
  import { statements, updateStatement, deleteStatement } from '$lib/stores/kb.svelte';
  // Rename/merge logic lives in rdf/predicates.ts so it can be tested. It used to be
  // inline here, which is why three real defects survived in a `production` feature:
  // renaming a standard-vocabulary term rewrote it into our namespace, renaming onto an
  // existing predicate silently merged, and merging created duplicate statements.
  import { listPredicates, planRename, planMerge, type PredicateInfo } from '$lib/rdf/predicates';

  const predicates = $derived(listPredicates(statements()));

  const edgePredicates = $derived(predicates.filter(p => !p.isMeta));
  const metaPredicates = $derived(predicates.filter(p => p.isMeta));

  // ── Rename ───────────────────────────────────────────────────────────────
  let renaming = $state<string | null>(null);
  let renameValue = $state('');
  let processing = $state(false);

  function startRename(p: PredicateInfo) {
    renaming = p.iri;
    renameValue = p.slug;
  }

  function cancelRename() {
    renaming = null;
    renameValue = '';
  }

  let warning = $state<string | null>(null);

  async function commitRename() {
    if (!renaming || processing) return;
    warning = null;

    const plan = planRename(statements(), renaming, renameValue);

    if (plan.unchanged) { cancelRename(); return; }
    if (plan.blocked === 'empty') return;
    if (plan.blocked === 'external-vocabulary') {
      warning = `"${renaming}" is a standard vocabulary term, not one of yours. Renaming it would rewrite it into Reckons.AI's namespace and the graph would stop meaning what it says.`;
      return;
    }
    // Renaming ONTO an existing predicate is a merge. Say so; never do it silently.
    if (plan.collidesWith) {
      const dupes = plan.duplicates?.length ?? 0;
      warning = `"${plan.collidesWith.slug}" already exists (${plan.collidesWith.count} uses). This would MERGE the two`
        + (dupes ? `, discarding ${dupes} duplicate statement${dupes === 1 ? '' : 's'}` : '')
        + `. Use merge if that is what you want.`;
      return;
    }
    if (!plan.ok || !plan.newIri) return;

    processing = true;
    for (const st of plan.affected) {
      await updateStatement(st.id, { p: { kind: 'iri', value: plan.newIri } });
    }
    processing = false;
    cancelRename();
  }

  // ── Merge ────────────────────────────────────────────────────────────────
  let mergeSource = $state<string | null>(null);
  let mergeTarget = $state<string | null>(null);

  function startMerge(iri: string) {
    if (!mergeSource) {
      mergeSource = iri;
    } else if (mergeSource === iri) {
      mergeSource = null;
    } else {
      mergeTarget = iri;
    }
  }

  function cancelMerge() {
    mergeSource = null;
    mergeTarget = null;
  }

  async function commitMerge() {
    if (!mergeSource || !mergeTarget || processing) return;
    warning = null;

    const plan = planMerge(statements(), mergeSource, mergeTarget);
    if (plan.blocked === 'external-vocabulary') {
      warning = `"${mergeSource}" is a standard vocabulary term and cannot be merged away.`;
      return;
    }
    if (!plan.ok) return;

    processing = true;
    const dupeIds = new Set(plan.duplicates.map((s) => s.id));
    for (const st of plan.affected) {
      // A statement that would become an exact twin of one already on the target is
      // DROPPED, not rewritten — otherwise the merge quietly doubles the graph.
      if (dupeIds.has(st.id)) await deleteStatement(st.id);
      else await updateStatement(st.id, { p: { kind: 'iri', value: mergeTarget } });
    }
    processing = false;
    cancelMerge();
  }

  const mergeSourceInfo = $derived(mergeSource ? predicates.find(p => p.iri === mergeSource) : null);
  const mergeTargetInfo = $derived(mergeTarget ? predicates.find(p => p.iri === mergeTarget) : null);
</script>

<div class="pred-mgr">
  <!-- A refusal the user cannot see is as bad as a silent merge. Always say why. -->
  {#if warning}
    <div class="pred-warning" role="alert">
      <span aria-hidden="true">⚠</span>
      <p>{warning}</p>
      <button class="ghost sm mono" onclick={() => (warning = null)}>dismiss</button>
    </div>
  {/if}

  {#if mergeSource && mergeTarget}
    <div class="merge-confirm">
      <p class="merge-msg">
        Merge <strong class="pred-name">{mergeSourceInfo?.slug}</strong>
        <span class="merge-count">({mergeSourceInfo?.count})</span>
        into <strong class="pred-name">{mergeTargetInfo?.slug}</strong>
        <span class="merge-count">({mergeTargetInfo?.count})</span>?
      </p>
      <div class="merge-actions">
        <button class="primary sm" onclick={commitMerge} disabled={processing}>
          {processing ? 'merging...' : 'merge'}
        </button>
        <button class="ghost sm" onclick={cancelMerge} disabled={processing}>cancel</button>
      </div>
    </div>
  {:else if mergeSource}
    <div class="merge-hint">
      <span class="merge-hint-text">
        merging <strong>{mergeSourceInfo?.slug}</strong> — click a target predicate
      </span>
      <button class="ghost sm" onclick={cancelMerge}>cancel</button>
    </div>
  {/if}

  {#if edgePredicates.length > 0}
    <div class="pred-group">
      <h4 class="group-label mono">predicates <span class="group-count">{edgePredicates.length}</span></h4>
      <div class="pred-list">
        {#each edgePredicates as p (p.iri)}
          <div class="pred-row"
            class:merge-src={mergeSource === p.iri}
            class:merge-candidate={mergeSource && mergeSource !== p.iri && !mergeTarget}
          >
            {#if renaming === p.iri}
              <form class="rename-form" onsubmit={(e) => { e.preventDefault(); commitRename(); }}>
                <input
                  type="text"
                  class="rename-input mono"
                  bind:value={renameValue}
                  autofocus
                  disabled={processing}
                />
                <button type="submit" class="sm primary" disabled={processing}>
                  {processing ? '...' : 'save'}
                </button>
                <button type="button" class="sm ghost" onclick={cancelRename} disabled={processing}>
                  cancel
                </button>
              </form>
            {:else}
              <button
                class="pred-slug mono"
                class:clickable={!!mergeSource && mergeSource !== p.iri}
                onclick={() => { if (mergeSource && mergeSource !== p.iri) startMerge(p.iri); }}
                title={p.iri}
              >
                {p.slug}
              </button>
              <span class="pred-count mono">{p.count}</span>
              <div class="pred-actions">
                <button class="act-btn" onclick={() => startRename(p)} title="rename">
                  rename
                </button>
                <button class="act-btn" onclick={() => startMerge(p.iri)} title="merge into another predicate">
                  {mergeSource === p.iri ? 'merging...' : 'merge'}
                </button>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if metaPredicates.length > 0}
    <details class="meta-group">
      <summary class="group-label mono">
        metadata predicates <span class="group-count">{metaPredicates.length}</span>
      </summary>
      <div class="pred-list">
        {#each metaPredicates as p (p.iri)}
          <div class="pred-row meta">
            <span class="pred-slug mono" title={p.iri}>{p.slug}</span>
            <span class="pred-count mono">{p.count}</span>
          </div>
        {/each}
      </div>
    </details>
  {/if}

  {#if predicates.length === 0}
    <p class="empty-msg">no predicates yet. ingest a document to get started.</p>
  {/if}
</div>

<style>
  .pred-warning {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.7rem 0.85rem;
    margin-bottom: 0.85rem;
    border: 1px solid var(--warn, #b8860b);
    border-radius: 6px;
    background: color-mix(in srgb, var(--warn, #b8860b) 10%, transparent);
  }
  .pred-warning p {
    margin: 0;
    flex: 1;
    font-size: 0.85rem;
    line-height: 1.45;
  }

  .pred-mgr {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  /* ── Group headings ── */
  .group-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent);
    margin: 0 0 0.4rem;
    cursor: default;
  }
  .group-count {
    color: var(--muted);
    font-weight: 400;
  }

  /* ── List ── */
  .pred-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .pred-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.6rem;
    border-radius: var(--rad-sm);
    transition: background 0.12s;
  }
  .pred-row:hover { background: var(--surface-2); }
  .pred-row.meta { opacity: 0.7; }
  .pred-row.merge-src {
    background: var(--accent-soft);
    border: 1px solid var(--accent);
  }
  .pred-row.merge-candidate {
    cursor: pointer;
  }
  .pred-row.merge-candidate:hover {
    background: var(--data-soft);
    border: 1px dashed var(--data);
  }

  .pred-slug {
    flex: 1;
    font-size: 0.82rem;
    color: var(--ink);
    background: none;
    border: none;
    padding: 0;
    text-align: left;
    cursor: default;
    font-family: var(--font-mono);
  }
  .pred-slug.clickable {
    cursor: pointer;
    color: var(--data);
  }
  .pred-count {
    font-size: 0.7rem;
    color: var(--muted);
    min-width: 2rem;
    text-align: right;
  }

  /* ── Actions ── */
  .pred-actions {
    display: flex;
    gap: 0.25rem;
    opacity: 0;
    transition: opacity 0.12s;
  }
  .pred-row:hover .pred-actions { opacity: 1; }
  .act-btn {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background: none;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.15rem 0.4rem;
    color: var(--muted);
    cursor: pointer;
    transition: color 0.1s, border-color 0.1s;
  }
  .act-btn:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  /* ── Rename form ── */
  .rename-form {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    flex: 1;
  }
  .rename-input {
    flex: 1;
    font-size: 0.82rem;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--accent);
    border-radius: var(--rad-sm);
    background: var(--surface);
    color: var(--ink);
    font-family: var(--font-mono);
  }

  /* ── Merge UI ── */
  .merge-confirm {
    background: var(--surface-2);
    border: 1px solid var(--accent);
    border-radius: var(--rad);
    padding: 0.65rem 0.85rem;
  }
  .merge-msg {
    font-size: 0.82rem;
    color: var(--ink-2);
    margin: 0 0 0.5rem;
  }
  .pred-name { color: var(--accent); }
  .merge-count { color: var(--muted); font-size: 0.72rem; }
  .merge-actions { display: flex; gap: 0.4rem; }

  .merge-hint {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    border-radius: var(--rad);
    padding: 0.45rem 0.75rem;
    font-size: 0.78rem;
    color: var(--ink-2);
  }
  .merge-hint-text { flex: 1; }

  /* ── Meta group ── */
  .meta-group {
    margin-top: 0.25rem;
  }
  .meta-group > summary {
    cursor: pointer;
    list-style: none;
  }
  .meta-group > summary::before {
    content: '▸ ';
    font-size: 0.65rem;
  }
  .meta-group[open] > summary::before {
    content: '▾ ';
  }

  .empty-msg {
    font-size: 0.82rem;
    color: var(--muted);
    font-style: italic;
  }

  button.sm {
    padding: 0.2rem 0.5rem;
    font-size: 0.72rem;
    border-radius: var(--rad-sm);
  }
</style>
