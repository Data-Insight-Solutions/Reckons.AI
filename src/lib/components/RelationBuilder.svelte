<script lang="ts">
  import type { EntityTypeDef } from '$lib/rdf/entity-types';

  let {
    subjectLabel,
    nodeList,
    predicateList,
    typeList,
    oncreate,
    oncancel
  } = $props<{
    subjectLabel: string;
    /** All nodes currently in the graph: {key: termKey, label, iri} */
    nodeList: { key: string; label: string; iri: string }[];
    /** Unique predicate slug names already used in the KB */
    predicateList: string[];
    typeList: EntityTypeDef[];
    oncreate: (predicateSlug: string, targetIri: string, newTypeDef?: EntityTypeDef) => void;
    oncancel: () => void;
  }>();

  // ── State ────────────────────────────────────────────────────────────────────

  let predQuery = $state('');
  let targetQuery = $state('');
  let targetOpen = $state(false);
  let selectedTarget = $state<{ key: string; label: string; iri: string; isNew: boolean } | null>(null);
  let selectedTypeDef = $state<EntityTypeDef | null>(null);

  // ── Derived ──────────────────────────────────────────────────────────────────

  // Predicate chip suggestions: KB predicates + schema predicates for selected type
  const predSuggestions = $derived.by(() => {
    const schema = selectedTypeDef?.schemaPredicates ?? [];
    const all = [...new Set([...schema, ...predicateList])];
    const q = predQuery.toLowerCase();
    return all.filter(p => q === '' || p.toLowerCase().includes(q)).slice(0, 16);
  });

  // Target search results
  const targetResults = $derived.by(() => {
    if (targetQuery.length < 1) return [];
    const q = targetQuery.toLowerCase();
    return nodeList
      .filter((n: { key: string; label: string; iri: string }) => n.label.toLowerCase().includes(q) || n.iri.toLowerCase().includes(q))
      .slice(0, 8);
  });

  const showCreateNew = $derived(
    targetQuery.trim().length > 1 &&
    !nodeList.some((n: { key: string; label: string; iri: string }) => n.label.toLowerCase() === targetQuery.trim().toLowerCase())
  );

  const newTargetIri = $derived(
    `urn:kbase:concept/${targetQuery.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  );

  const canConfirm = $derived(
    predQuery.trim().length > 0 &&
    selectedTarget !== null &&
    (!selectedTarget.isNew || selectedTypeDef !== null)
  );

  // ── Handlers ─────────────────────────────────────────────────────────────────

  function choosePred(p: string) {
    predQuery = p;
  }

  function chooseTarget(node: { key: string; label: string; iri: string }) {
    selectedTarget = { ...node, isNew: false };
    targetQuery = node.label;
    targetOpen = false;
  }

  function chooseCreateNew() {
    selectedTarget = { key: newTargetIri, label: targetQuery.trim(), iri: newTargetIri, isNew: true };
    selectedTypeDef = null;
    targetOpen = false;
  }

  function clearTarget() {
    selectedTarget = null;
    targetQuery = '';
    selectedTypeDef = null;
    targetOpen = false;
  }

  function confirm() {
    if (!canConfirm || !selectedTarget) return;
    oncreate(
      predQuery.trim(),
      selectedTarget.isNew ? newTargetIri : selectedTarget.iri,
      selectedTarget.isNew ? (selectedTypeDef ?? undefined) : undefined
    );
  }

  function onTargetKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { targetOpen = false; }
    else if (e.key === 'ArrowDown' && targetResults.length > 0) {
      (document.querySelector('.rb-option') as HTMLElement)?.focus();
      e.preventDefault();
    }
  }
</script>

<div class="rb">
  <!-- Context: from node -->
  <div class="rb-context">
    <span class="rb-from mono">from</span>
    <span class="rb-subject">{subjectLabel}</span>
  </div>

  <!-- ── Step 1: Predicate ── -->
  <div class="rb-field">
    <label class="rb-lbl mono">predicate</label>
    <input
      class="rb-input"
      type="text"
      bind:value={predQuery}
      placeholder="e.g. knows, is-part-of, created-by…"
      spellcheck="false"
    />
    {#if predSuggestions.length > 0}
      <div class="rb-chips" role="list">
        {#each predSuggestions as p (p)}
          <button
            class="rb-chip"
            class:active={predQuery === p}
            class:schema={selectedTypeDef?.schemaPredicates?.includes(p)}
            onclick={() => choosePred(p)}
            role="listitem"
          >{p}</button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- ── Step 2: Target (shown once predicate is non-empty) ── -->
  {#if predQuery.trim()}
    <div class="rb-field">
      <label class="rb-lbl mono">target node</label>

      {#if selectedTarget}
        <!-- Selected target chip -->
        <div class="rb-selected" class:is-new={selectedTarget.isNew}>
          <span class="rb-selected-label">{selectedTarget.label}</span>
          {#if selectedTarget.isNew}
            <span class="rb-new-badge mono">new</span>
          {:else}
            <span class="rb-exists-badge mono">existing</span>
          {/if}
          <button class="ghost rb-clear-btn" onclick={clearTarget} title="clear">✕</button>
        </div>
      {:else}
        <!-- Search input -->
        <div class="rb-search-wrap">
          <input
            class="rb-input"
            type="text"
            bind:value={targetQuery}
            onfocus={() => (targetOpen = true)}
            oninput={() => (targetOpen = true)}
            onkeydown={onTargetKeydown}
            placeholder="search nodes or type a new name…"
            spellcheck="false"
            autocomplete="off"
          />
          {#if targetOpen && (targetResults.length > 0 || showCreateNew)}
            <div class="rb-dropdown">
              {#each targetResults as n (n.key)}
                <button class="rb-option" onclick={() => chooseTarget(n)}>
                  <span class="rb-opt-label">{n.label}</span>
                  <span class="rb-opt-iri mono">{n.iri.split('/').pop()}</span>
                </button>
              {/each}
              {#if showCreateNew}
                <button class="rb-option rb-option-new" onclick={chooseCreateNew}>
                  <span class="rb-opt-plus">+</span>
                  <span>Create <strong class="rb-opt-name">{targetQuery.trim()}</strong></span>
                  <span class="rb-opt-iri mono">{newTargetIri.split('/').pop()}</span>
                </button>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <!-- ── Step 3: Type picker (only for new nodes) ── -->
  {#if selectedTarget?.isNew}
    <div class="rb-field">
      <label class="rb-lbl mono">
        entity type
        <span class="rb-required">required</span>
      </label>
      <div class="rb-type-grid">
        {#each typeList as t (t.iri)}
          <button
            class="rb-type-btn"
            class:active={selectedTypeDef?.iri === t.iri}
            onclick={() => (selectedTypeDef = selectedTypeDef?.iri === t.iri ? null : t)}
            style="--c: {t.color}"
            title={t.description}
          >
            <span class="rb-type-dot" style="background:{t.color}"></span>
            <span class="rb-type-label">{t.label}</span>
          </button>
        {/each}
      </div>
      {#if selectedTypeDef?.description}
        <p class="rb-type-desc">{selectedTypeDef.description}</p>
      {/if}
    </div>
  {/if}

  <!-- ── Preview ── -->
  {#if predQuery.trim() && selectedTarget}
    <div class="rb-preview">
      <span class="rb-prev-s">{subjectLabel}</span>
      <span class="rb-prev-arrow">·{predQuery}·</span>
      <span class="rb-prev-o" class:is-new={selectedTarget.isNew}>{selectedTarget.label}</span>
    </div>
  {/if}

  <!-- ── Actions ── -->
  <div class="rb-footer">
    <button class="primary" onclick={confirm} disabled={!canConfirm}>
      {selectedTarget?.isNew ? 'create node + relation' : 'create relation'}
    </button>
    <button onclick={oncancel}>cancel</button>
  </div>
</div>

<style>
  .rb { display: flex; flex-direction: column; gap: 0.8rem; }

  /* Context row */
  .rb-context {
    display: flex; align-items: center; gap: 0.4rem;
    padding: 0.4rem 0.6rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    font-size: 0.78rem;
  }
  .rb-from { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted); }
  .rb-subject { color: var(--accent); font-weight: 600; }

  /* Field */
  .rb-field { display: flex; flex-direction: column; gap: 0.3rem; }
  .rb-lbl {
    font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.14em; color: var(--muted);
    display: flex; align-items: center; gap: 0.4rem;
  }
  .rb-required {
    font-size: 0.55rem; color: var(--danger); border: 1px solid var(--danger);
    border-radius: 999px; padding: 0.05rem 0.35rem; letter-spacing: 0.08em;
  }

  /* Input */
  .rb-input {
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    background: var(--surface-2);
    font-size: 0.82rem;
    color: var(--ink-2);
    transition: border-color 0.12s;
  }
  .rb-input:focus { border-color: var(--accent); outline: none; }

  /* Predicate chips */
  .rb-chips { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .rb-chip {
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.68rem;
    cursor: pointer;
    transition: all 0.12s;
  }
  .rb-chip:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  .rb-chip.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
  .rb-chip.schema { border-style: dashed; }

  /* Target search */
  .rb-search-wrap { position: relative; }
  .rb-dropdown {
    position: absolute;
    top: calc(100% + 2px);
    left: 0; right: 0;
    background: var(--surface-3);
    border: 1px solid var(--accent);
    border-radius: var(--rad-sm);
    overflow: hidden;
    z-index: 200;
    box-shadow: 0 6px 20px rgba(0,0,0,0.35);
    max-height: 240px;
    overflow-y: auto;
  }
  .rb-option {
    width: 100%; display: flex; align-items: center; gap: 0.5rem;
    padding: 0.55rem 0.75rem;
    border: none; border-bottom: 1px solid var(--line);
    background: none; text-align: left; cursor: pointer;
    transition: background 0.1s;
    font-size: 0.82rem;
    color: var(--ink-2);
    min-height: 40px;
  }
  .rb-option:last-child { border-bottom: none; }
  .rb-option:hover, .rb-option:focus { background: var(--accent-soft); outline: none; }
  .rb-opt-label { flex: 1; color: var(--ink-2); }
  .rb-opt-iri { font-size: 0.62rem; color: var(--muted); }
  .rb-option-new { color: var(--data); }
  .rb-option-new:hover, .rb-option-new:focus { background: color-mix(in srgb, var(--data) 10%, var(--surface)); }
  .rb-opt-plus { font-size: 1.1rem; color: var(--data); line-height: 1; }
  .rb-opt-name { color: var(--data); }

  /* Selected target pill */
  .rb-selected {
    display: flex; align-items: center; gap: 0.4rem;
    padding: 0.4rem 0.65rem;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    background: var(--surface-2);
    font-size: 0.82rem;
  }
  .rb-selected.is-new { border-color: var(--data); background: color-mix(in srgb, var(--data) 6%, var(--surface)); }
  .rb-selected-label { flex: 1; color: var(--ink-2); }
  .rb-new-badge, .rb-exists-badge {
    font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.1em;
    border-radius: 999px; padding: 0.1rem 0.4rem;
  }
  .rb-new-badge { color: var(--data); border: 1px solid var(--data); }
  .rb-exists-badge { color: var(--muted); border: 1px solid var(--line); }
  .rb-clear-btn { font-size: 0.75rem; padding: 0.1rem 0.3rem; color: var(--muted); }

  /* Type grid */
  .rb-type-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
    gap: 0.35rem;
  }
  .rb-type-btn {
    display: flex; align-items: center; gap: 0.35rem;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    background: var(--surface);
    cursor: pointer;
    font-size: 0.75rem;
    color: var(--ink-2);
    transition: all 0.12s;
    text-align: left;
    min-height: 36px;
  }
  .rb-type-btn:hover { border-color: var(--c); background: color-mix(in srgb, var(--c) 8%, var(--surface)); }
  .rb-type-btn.active { border-color: var(--c); background: color-mix(in srgb, var(--c) 14%, var(--surface)); color: var(--c); }
  .rb-type-dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; flex-shrink: 0; }
  .rb-type-label { font-size: 0.72rem; }
  .rb-type-desc { font-size: 0.7rem; color: var(--muted); margin: 0.1rem 0 0; line-height: 1.35; }

  /* Preview */
  .rb-preview {
    display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;
    padding: 0.5rem 0.75rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    font-size: 0.78rem;
  }
  .rb-prev-s { color: var(--accent); font-weight: 600; }
  .rb-prev-arrow { color: var(--muted); font-family: var(--font-mono); font-size: 0.7rem; }
  .rb-prev-o { color: var(--data); }
  .rb-prev-o.is-new { color: var(--data); font-style: italic; }

  /* Footer */
  .rb-footer { display: flex; gap: 0.5rem; flex-wrap: wrap; padding-top: 0.1rem; }
  .rb-footer button { font-size: 0.85rem; padding: 0.5rem 0.85rem; }
</style>
