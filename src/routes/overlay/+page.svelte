<script lang="ts">
  import { onMount } from 'svelte';
  import OverlayGraph from '$lib/components/OverlayGraph.svelte';
  import OverlayGraph3D from '$lib/components/OverlayGraph3D.svelte';
  import {
    parseMultipleGraphs,
    MEMBERSHIP_PREDICATES,
    MEMBERSHIP_LABELS,
    isProjectIri,
    type OverlayData, type GraphDef
  } from '$lib/rdf/multi-graph-parse';
  import { getRegistry, getCurrentKbId, type KbEntry } from '$lib/storage/kb-registry';
  import { KBaseDB } from '$lib/storage/db';
  import { toTurtle } from '$lib/rdf/serialize';

  // ── Bundled example files via Vite glob ─────────────────────────────────────
  const ttlModules = import.meta.glob('/docs/reckons-knowledge-graphs/*.ttl', {
    query: '?raw', import: 'default', eager: true
  }) as Record<string, string>;
  const bundledFiles = Object.entries(ttlModules).map(([path, content]) => ({
    id: path.split('/').pop()!.replace('.ttl', ''),
    content: content as string
  }));

  // ── State ───────────────────────────────────────────────────────────────────
  let data = $state<OverlayData | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let activeGraphIds = $state(new Set<string>());
  let activePredicates = $state(new Set<string>(MEMBERSHIP_PREDICATES));
  let selectedKey = $state<string | null>(null);
  let viewMode = $state<'2d' | '3d'>('2d');

  // ── KB registry sources ─────────────────────────────────────────────────────
  let kbEntries = $state<KbEntry[]>([]);
  let selectedKbIds = $state(new Set<string>());
  let kbTtlCache = $state(new Map<string, string>()); // kbId → TTL content
  let loadingKbIds = $state(new Set<string>());
  let showExamples = $state(false);
  let selectedExampleIds = $state(new Set<string>());

  // Also include non-membership predicates that create inter-entity edges
  const STRUCTURAL_PREDICATES = new Set([
    'urn:reckons:ontology/componentUses',
    'urn:reckons:ontology/relatedTo',
    'urn:reckons:ontology/evolvedInto',
  ]);
  // Initialize with both membership + structural predicates
  for (const p of STRUCTURAL_PREDICATES) activePredicates.add(p);

  // ── Derived stats ───────────────────────────────────────────────────────────
  const stats = $derived.by(() => {
    if (!data) return null;
    let total = 0, shared = 0, uniquePerGraph = new Map<string, number>();
    for (const g of data.graphs) uniquePerGraph.set(g.id, 0);

    for (const [key, node] of data.nodes) {
      if (isProjectIri(key)) continue;
      const activeMem = [...node.membership].filter(gid => activeGraphIds.has(gid));
      if (activeMem.length === 0) continue;
      total++;
      if (activeMem.length > 1) shared++;
      if (activeMem.length === 1) {
        uniquePerGraph.set(activeMem[0], (uniquePerGraph.get(activeMem[0]) ?? 0) + 1);
      }
    }
    return { total, shared, uniquePerGraph };
  });

  const selectedNode = $derived(selectedKey ? data?.nodes.get(selectedKey) ?? null : null);
  const selectedGraphs = $derived.by(() => {
    if (!selectedNode || !data) return [] as GraphDef[];
    return data.graphs.filter(g => selectedNode.membership.has(g.id));
  });

  const currentKbId = typeof window !== 'undefined' ? getCurrentKbId() : 'kbase';

  // ── Load a single KB's statements as TTL ──────────────────────────────────
  async function loadKbAsTtl(entry: KbEntry): Promise<string> {
    if (kbTtlCache.has(entry.id)) return kbTtlCache.get(entry.id)!;
    const tempDb = new KBaseDB(entry.id);
    try {
      const stmts = await tempDb.statements.toArray();
      const confirmed = stmts.filter(s => s.status === 'confirmed' || s.status === 'refined');
      if (confirmed.length === 0) return '';
      const ttl = toTurtle(confirmed, { header: entry.name });
      kbTtlCache.set(entry.id, ttl);
      return ttl;
    } finally {
      tempDb.close();
    }
  }

  // ── Rebuild overlay from all selected sources ─────────────────────────────
  async function rebuildOverlay() {
    const files: Array<{ id: string; content: string }> = [];

    // Add selected KB entries
    for (const kbId of selectedKbIds) {
      const entry = kbEntries.find(e => e.id === kbId);
      if (!entry) continue;
      loadingKbIds.add(kbId);
      loadingKbIds = new Set(loadingKbIds);
      try {
        const ttl = await loadKbAsTtl(entry);
        if (ttl) files.push({ id: entry.name || entry.id, content: ttl });
      } catch (e) {
        console.warn(`Failed to load KB "${entry.name}":`, e);
      }
      loadingKbIds.delete(kbId);
    }
    loadingKbIds = new Set();

    // Add selected bundled examples
    if (showExamples) {
      for (const ex of bundledFiles) {
        if (selectedExampleIds.has(ex.id)) files.push(ex);
      }
    }

    if (files.length === 0) {
      data = null;
      return;
    }

    loading = true;
    error = null;
    try {
      data = await parseMultipleGraphs(files);
      activeGraphIds = new Set(data.graphs.map(g => g.id));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  // ── Toggle a KB selection ─────────────────────────────────────────────────
  async function toggleKb(kbId: string) {
    const next = new Set(selectedKbIds);
    if (next.has(kbId)) next.delete(kbId); else next.add(kbId);
    selectedKbIds = next;
    await rebuildOverlay();
  }

  function toggleExample(exId: string) {
    const next = new Set(selectedExampleIds);
    if (next.has(exId)) next.delete(exId); else next.add(exId);
    selectedExampleIds = next;
    rebuildOverlay();
  }

  function toggleShowExamples() {
    showExamples = !showExamples;
    if (!showExamples) {
      selectedExampleIds = new Set();
      rebuildOverlay();
    }
  }

  // ── Toggle helpers ──────────────────────────────────────────────────────
  function toggleGraph(id: string) {
    const next = new Set(activeGraphIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    activeGraphIds = next;
  }

  function togglePredicate(iri: string) {
    const next = new Set(activePredicates);
    if (next.has(iri)) next.delete(iri); else next.add(iri);
    activePredicates = next;
  }

  function shortType(iri: string | null): string {
    if (!iri) return '';
    const slash = iri.lastIndexOf('/');
    return slash >= 0 ? iri.slice(slash + 1) : iri;
  }

  function selectAll() {
    selectedKbIds = new Set(kbEntries.map(e => e.id));
    rebuildOverlay();
  }

  function selectNone() {
    selectedKbIds = new Set();
    selectedExampleIds = new Set();
    data = null;
  }

  onMount(() => {
    // Show all registered KBs — those without a recorded count might still have data
    kbEntries = getRegistry();
    // Auto-select current KB
    const current = kbEntries.find(e => e.id === currentKbId);
    if (current) {
      selectedKbIds = new Set([current.id]);
      rebuildOverlay();
    }
  });
</script>

<div class="page">
  <header class="head">
    <p class="kicker mono">overlay</p>
    <h1>multi-graph comparison</h1>
    <p class="subtitle">venn-style overlay of multiple knowledge graphs</p>
  </header>

  <!-- ── KB source picker ───────────────────────────────────────────────── -->
  <div class="source-picker">
    <div class="picker-header">
      <span class="picker-label mono">knowledge bases</span>
      <div class="picker-actions">
        <button class="ghost-sm" onclick={selectAll}>all</button>
        <button class="ghost-sm" onclick={selectNone}>none</button>
      </div>
    </div>

    {#if kbEntries.length === 0}
      <p class="no-kbs mono">No knowledge bases with data found. Ingest some sources first.</p>
    {:else}
      <div class="kb-chips">
        {#each kbEntries as entry}
          {@const isActive = selectedKbIds.has(entry.id)}
          {@const isCurrent = entry.id === currentKbId}
          {@const isLoading = loadingKbIds.has(entry.id)}
          <button
            class="kb-chip"
            class:active={isActive}
            class:current={isCurrent}
            onclick={() => toggleKb(entry.id)}
            style:--kb-color={entry.color || 'var(--accent)'}
            disabled={isLoading}
          >
            <span class="kb-check">{isActive ? '\u2713' : ''}</span>
            <span class="kb-name">{entry.name}</span>
            {#if entry.statementCount}
              <span class="kb-count">{entry.statementCount}</span>
            {/if}
            {#if isCurrent}
              <span class="kb-current-badge">current</span>
            {/if}
            {#if isLoading}
              <span class="kb-loading">...</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}

    <!-- Examples folder -->
    <div class="examples-folder">
      <button class="examples-toggle ghost-sm" onclick={toggleShowExamples}>
        <span class="folder-arrow">{showExamples ? '\u25BE' : '\u25B8'}</span>
        Reckons.AI examples
        <span class="examples-count">{bundledFiles.length}</span>
      </button>
      {#if showExamples}
        <div class="example-chips">
          {#each bundledFiles as ex}
            <button
              class="chip"
              class:active={selectedExampleIds.has(ex.id)}
              onclick={() => toggleExample(ex.id)}
            >
              {ex.id}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <div class="file-row">
      <div class="view-toggle">
        <button class="toggle-btn" class:active={viewMode === '2d'} onclick={() => viewMode = '2d'}>2D</button>
        <button class="toggle-btn" class:active={viewMode === '3d'} onclick={() => viewMode = '3d'}>3D</button>
      </div>
    </div>
  </div>

  {#if error}
    <div class="error-bar">{error}</div>
  {/if}

  {#if loading}
    <div class="loading-bar mono">loading knowledge bases...</div>
  {/if}

  {#if data}
    <!-- ── Predicate filters ───────────────────────────────────────────── -->
    <div class="filter-section">
      <span class="filter-label mono">show</span>
      {#each [...MEMBERSHIP_PREDICATES] as pred}
        <button
          class="chip"
          class:active={activePredicates.has(pred)}
          onclick={() => togglePredicate(pred)}
        >
          {MEMBERSHIP_LABELS[pred] ?? pred.split('/').pop()}
        </button>
      {/each}
      {#each [...STRUCTURAL_PREDICATES] as pred}
        <button
          class="chip structural"
          class:active={activePredicates.has(pred)}
          onclick={() => togglePredicate(pred)}
        >
          {pred.split('/').pop()}
        </button>
      {/each}
    </div>

    <!-- ── Project toggles ─────────────────────────────────────────────── -->
    <div class="filter-section">
      <span class="filter-label mono">graphs</span>
      {#each data.graphs as g}
        <button
          class="chip project-chip"
          class:active={activeGraphIds.has(g.id)}
          onclick={() => toggleGraph(g.id)}
          style="--chip-color: {g.color}"
        >
          <span class="color-dot" style="background: {g.color}"></span>
          {g.id}
          <span class="chip-count">{g.tripleCount}</span>
        </button>
      {/each}
    </div>

    <!-- ── Graph canvas ────────────────────────────────────────────────── -->
    <div class="graph-area">
      {#if viewMode === '2d'}
        <OverlayGraph
          graphs={data.graphs}
          nodes={data.nodes}
          edges={data.edges}
          {activeGraphIds}
          {activePredicates}
          {selectedKey}
          onselect={(key) => { selectedKey = key; }}
        />
      {:else}
        <OverlayGraph3D
          graphs={data.graphs}
          nodes={data.nodes}
          edges={data.edges}
          {activeGraphIds}
          {activePredicates}
        />
      {/if}
    </div>

    <!-- ── Stats + detail ──────────────────────────────────────────────── -->
    <div class="bottom-row">
      {#if stats}
        <div class="stats-panel">
          <div class="stat">
            <span class="stat-num">{stats.total}</span>
            <span class="stat-label mono">entities</span>
          </div>
          <div class="stat">
            <span class="stat-num shared">{stats.shared}</span>
            <span class="stat-label mono">shared</span>
          </div>
          {#each data.graphs.filter(g => activeGraphIds.has(g.id)) as g}
            <div class="stat">
              <span class="stat-num" style="color: {g.color}">{stats.uniquePerGraph.get(g.id) ?? 0}</span>
              <span class="stat-label mono" title={g.label}>unique {g.id.length > 12 ? g.id.slice(0, 12) + '...' : g.id}</span>
            </div>
          {/each}
        </div>
      {/if}

      {#if selectedNode}
        <div class="detail-panel">
          <h3 class="detail-name">{selectedNode.label}</h3>
          {#if selectedNode.rdfType}
            <span class="detail-type mono">{shortType(selectedNode.rdfType)}</span>
          {/if}
          <div class="detail-membership">
            <span class="detail-sub mono">member of</span>
            {#each selectedGraphs as g}
              <span class="detail-member" style="color: {g.color}">
                <span class="color-dot" style="background: {g.color}"></span>
                {g.label}
              </span>
            {/each}
            {#if selectedGraphs.length === 0}
              <span class="detail-none">none (filtered out)</span>
            {/if}
          </div>
          <button class="ghost detail-close" onclick={() => { selectedKey = null; }}>close</button>
        </div>
      {/if}
    </div>

    <!-- ── Legend ───────────────────────────────────────────────────────── -->
    <div class="legend">
      <span class="legend-item"><span class="legend-dot" style="background: #fff; opacity: 0.5"></span> single project</span>
      <span class="legend-item"><span class="legend-pie"></span> shared (pie = projects)</span>
      <span class="legend-item"><span class="legend-dot big" style="background: #888"></span> more shared = larger</span>
    </div>
  {:else if !loading}
    <!-- Empty state -->
    <div class="empty-state">
      <p class="empty-title">Select knowledge bases above to compare</p>
      <p class="empty-sub mono">Pick two or more KBs to see a venn-style overlay of shared and unique entities</p>
    </div>
  {/if}
</div>

<style>
  .page {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem 1.5rem 6rem;
  }
  .head {
    margin-bottom: 1.5rem;
  }
  .kicker {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 0 0 0.25rem;
  }
  h1 {
    font-family: var(--font-display);
    font-size: 1.6rem;
    color: var(--ink);
    margin: 0 0 0.3rem;
  }
  .subtitle {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--muted);
    margin: 0;
  }

  /* Source picker */
  .source-picker {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
  }
  .picker-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }
  .picker-label {
    font-family: var(--font-mono);
    font-size: 0.65rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .picker-actions {
    display: flex;
    gap: 0.35rem;
  }
  .ghost-sm {
    background: none;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.25rem 0.5rem;
    font-family: var(--font-mono);
    font-size: 0.6rem;
    color: var(--muted);
    cursor: pointer;
    transition: color 0.12s, border-color 0.12s;
  }
  .ghost-sm:hover { color: var(--accent); border-color: var(--accent); }
  .no-kbs {
    font-size: 0.7rem;
    color: var(--muted);
    margin: 0.5rem 0;
  }

  /* KB chips */
  .kb-chips {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
    margin-bottom: 0.5rem;
  }
  .kb-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0.3rem 0.7rem;
    font-family: var(--font-mono);
    font-size: 0.65rem;
    color: var(--muted);
    cursor: pointer;
    transition: all 0.12s;
    white-space: nowrap;
  }
  .kb-chip:hover { border-color: var(--kb-color); color: var(--ink); }
  .kb-chip.active {
    background: color-mix(in srgb, var(--kb-color) 12%, transparent);
    border-color: var(--kb-color);
    color: var(--kb-color);
  }
  .kb-chip.current { font-weight: 600; }
  .kb-chip:disabled { opacity: 0.6; cursor: wait; }
  .kb-check {
    width: 1em;
    font-size: 0.7rem;
    text-align: center;
  }
  .kb-name { max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
  .kb-count {
    font-size: 0.52rem;
    opacity: 0.5;
  }
  .kb-current-badge {
    font-size: 0.48rem;
    background: var(--accent-soft);
    color: var(--accent);
    padding: 0.1rem 0.3rem;
    border-radius: 999px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .kb-loading {
    font-size: 0.6rem;
    animation: pulse 0.8s ease-in-out infinite;
  }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

  /* Examples folder */
  .examples-folder {
    margin-bottom: 0.5rem;
  }
  .examples-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .folder-arrow {
    font-size: 0.7rem;
    width: 0.8em;
    display: inline-block;
  }
  .examples-count {
    font-size: 0.5rem;
    opacity: 0.5;
  }
  .example-chips {
    display: flex;
    gap: 0.35rem;
    flex-wrap: wrap;
    margin-top: 0.4rem;
    padding-left: 1rem;
  }

  /* File row */
  .file-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .view-toggle {
    display: flex;
    margin-left: auto;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    overflow: hidden;
  }
  .toggle-btn {
    background: none;
    border: none;
    padding: 0.4rem 0.7rem;
    font-family: var(--font-mono);
    font-size: 0.65rem;
    color: var(--muted);
    cursor: pointer;
    transition: all 0.12s;
  }
  .toggle-btn:hover { color: var(--ink); }
  .toggle-btn.active {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .toggle-btn + .toggle-btn {
    border-left: 1px solid var(--line);
  }
  .error-bar {
    background: rgba(232, 83, 75, 0.15);
    border: 1px solid rgba(232, 83, 75, 0.3);
    border-radius: var(--rad-sm);
    padding: 0.5rem 0.8rem;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: #e8534b;
    margin-bottom: 1rem;
  }
  .loading-bar {
    text-align: center;
    padding: 1rem;
    font-size: 0.7rem;
    color: var(--muted);
    animation: pulse 1s ease-in-out infinite;
  }

  /* Empty state */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 300px;
    text-align: center;
    gap: 0.5rem;
  }
  .empty-title {
    font-family: var(--font-display);
    font-size: 1.1rem;
    color: var(--ink);
    margin: 0;
  }
  .empty-sub {
    font-size: 0.7rem;
    color: var(--muted);
    margin: 0;
    max-width: 400px;
  }

  /* Controls (legacy class for detail-close) */
  .ghost {
    background: none;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.4rem 0.8rem;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--muted);
    cursor: pointer;
    transition: color 0.12s, border-color 0.12s;
  }
  .ghost:hover { color: var(--accent); border-color: var(--accent); }

  /* Filters */
  .filter-section {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-bottom: 0.6rem;
    flex-wrap: wrap;
  }
  .filter-label {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-right: 0.25rem;
    flex-shrink: 0;
  }
  .chip {
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0.25rem 0.6rem;
    font-family: var(--font-mono);
    font-size: 0.6rem;
    color: var(--muted);
    cursor: pointer;
    transition: all 0.12s;
    white-space: nowrap;
  }
  .chip:hover { border-color: var(--accent); color: var(--ink); }
  .chip.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
  .chip.structural { font-style: italic; }
  .project-chip { display: inline-flex; align-items: center; gap: 0.3rem; }
  .project-chip.active { border-color: var(--chip-color, var(--accent)); color: var(--chip-color, var(--accent)); background: color-mix(in srgb, var(--chip-color, var(--accent)) 12%, transparent); }
  .color-dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .chip-count {
    font-size: 0.52rem;
    opacity: 0.5;
  }

  /* Graph area */
  .graph-area {
    height: clamp(400px, 60vh, 700px);
    margin-bottom: 1rem;
  }

  /* Stats + detail */
  .bottom-row {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
  }
  .stats-panel {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 0.75rem 1rem;
    flex: 1;
    min-width: 200px;
  }
  .stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
  }
  .stat-num {
    font-family: var(--font-display);
    font-size: 1.3rem;
    color: var(--ink);
  }
  .stat-num.shared { color: var(--data); }
  .stat-label {
    font-family: var(--font-mono);
    font-size: 0.52rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    white-space: nowrap;
  }
  .detail-panel {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 0.75rem 1rem;
    min-width: 200px;
    max-width: 300px;
  }
  .detail-name {
    font-family: var(--font-display);
    font-size: 1rem;
    color: var(--ink);
    margin: 0 0 0.25rem;
  }
  .detail-type {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .detail-membership {
    margin-top: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .detail-sub {
    font-family: var(--font-mono);
    font-size: 0.55rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .detail-member {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-family: var(--font-mono);
    font-size: 0.7rem;
  }
  .detail-none {
    font-family: var(--font-mono);
    font-size: 0.65rem;
    color: var(--muted);
  }
  .detail-close {
    margin-top: 0.5rem;
    font-size: 0.6rem;
    padding: 0.2rem 0.5rem;
  }

  /* Legend */
  .legend {
    display: flex;
    gap: 1.2rem;
    align-items: center;
    justify-content: center;
    padding: 0.5rem;
    flex-wrap: wrap;
  }
  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-family: var(--font-mono);
    font-size: 0.58rem;
    color: var(--muted);
  }
  .legend-dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
  }
  .legend-dot.big { width: 12px; height: 12px; }
  .legend-pie {
    display: inline-block;
    width: 10px; height: 10px;
    border-radius: 50%;
    background: conic-gradient(#1a9b8e 0deg 120deg, #3d7cf5 120deg 240deg, #e8534b 240deg 360deg);
  }

  .mono {
    font-family: var(--font-mono);
  }

  /* ── Mobile responsive ── */
  @media (max-width: 600px) {
    .page { padding: 1.5rem 0.75rem 4rem; }
    h1 { font-size: 1.2rem; }
    .graph-area { height: clamp(300px, 50vh, 500px); }
    .ghost { min-height: 44px; padding: 0.5rem 0.8rem; font-size: 0.75rem; }
    .ghost-sm { min-height: 36px; padding: 0.3rem 0.5rem; }
    .chip { min-height: 36px; padding: 0.35rem 0.6rem; font-size: 0.65rem; }
    .kb-chip { min-height: 40px; padding: 0.35rem 0.7rem; }
    .toggle-btn { min-height: 44px; padding: 0.5rem 0.8rem; }
    .bottom-row { flex-direction: column; }
    .detail-panel { max-width: none; }
    .stats-panel { gap: 0.6rem; padding: 0.6rem 0.75rem; }
    .stat-num { font-size: 1.1rem; }
    .legend { gap: 0.6rem; }
    .legend-item { font-size: 0.55rem; }
    .source-picker { padding: 0.6rem 0.75rem; }
    .kb-name { max-width: 140px; }
    .empty-state { min-height: 200px; }
  }
</style>
