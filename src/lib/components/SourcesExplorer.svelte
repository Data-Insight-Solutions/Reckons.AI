<script lang="ts">
  import { liveQuery } from 'dexie';
  import { untrack, type Snippet } from 'svelte';
  import SetBrowser from './SetBrowser.svelte';
  import AdaptivePanel from './AdaptivePanel.svelte';
  import StatementCard from './StatementCard.svelte';
  import ExtractionTrail from './ExtractionTrail.svelte';
  import type { ExtractionRun, Source, Statement } from '$lib/rdf/types';
  import {
    buildProvenanceIndex, filterProvenanceIndex, projectProvenance, statementsForProvenanceNode,
    MAX_PROVENANCE_SOURCES, DEFAULT_PROVENANCE_SOURCES, createProvenanceControls,
  } from '$lib/rdf/provenance-view';
  import { extractionRunsForSource } from '$lib/storage/extraction-runs';
  import { officialKbActive } from '$lib/stores/official-kb.svelte';
  import { isCompact } from '$lib/stores/viewport.svelte';

  let { statements, sources, onentity, onscene, graphTools, assetFor, selected = $bindable(null), controls = $bindable(createProvenanceControls()) } = $props<{
    controls?: ReturnType<typeof createProvenanceControls>;
    statements: Statement[];
    sources: Source[];
    selected?: string | null;
    onscene: (scene: ReturnType<typeof projectProvenance>) => void;
    graphTools?: Snippet;
    assetFor: (iri: string) => { kind: 'image' | 'video' | 'glb'; url: string } | null;
    onentity: (key: string) => void;
  }>();
  const fullIndex = $derived(buildProvenanceIndex(statements, sources));
  const index = $derived(filterProvenanceIndex(fullIndex, controls.reviewState));
  const sourceScope = $derived(index.sources.map((source) => source.id).join('\0'));
  let statementLimit = $state(20);
  let runs = $state<ExtractionRun[]>([]);
  let loadingRuns = $state(false);
  let runError = $state('');
  let pickerOpen = $state(true);
  $effect(() => { pickerOpen = !isCompact(); });

  $effect(() => {
    sourceScope;
    untrack(() => {
      const remaining = controls.selectedIds.filter((id: string) => index.sources.some((s) => s.id === id));
      if (!controls.initialized || (controls.selectedIds.length > 0 && remaining.length === 0)) {
        controls.selectedIds = index.sources.slice(0, DEFAULT_PROVENANCE_SOURCES).map((s) => s.id);
        controls.initialized = index.sources.length > 0;
        controls.expanded = new Set();
      } else controls.selectedIds = remaining;
    });
  });
  const eligibleSources = $derived(index.sources.filter((source) =>
    (controls.sourceKind === 'all' || (source.source?.kind ?? 'unrecorded') === controls.sourceKind) &&
    (!controls.capturedSince || (source.source?.ingestedAt != null && source.source.ingestedAt >= new Date(`${controls.capturedSince}T00:00:00`).getTime()))));
  const scopedIds = $derived(controls.selectedIds.filter((id: string) => eligibleSources.some((s) => s.id === id)));
  const graph = $derived(projectProvenance(index, scopedIds, controls.expanded));
  $effect(() => onscene(graph));
  const node = $derived(selected ? graph.nodes.get(selected) : undefined);
  const nodeStatements = $derived(node ? statementsForProvenanceNode(index, node, scopedIds) : []);
  const nodeSources = $derived(node?.kind === 'source' ? [node.source] : node?.kind === 'group'
    ? graph.sources.filter((s) => s.id === node.group.sourceId)
    : graph.sources.filter((source) => nodeStatements.some((st) => source.statements.includes(st))));
  const matchingSources = $derived(eligibleSources.filter((source) =>
    source.title.toLocaleLowerCase().includes(controls.search.toLocaleLowerCase())));
  const sourceKinds = $derived([...new Set(fullIndex.sources.map((source) => source.source?.kind ?? 'unrecorded'))].sort());

  $effect(() => {
    if (selected && !graph.nodes.has(selected)) selected = null;
  });
  $effect(() => { selected; statementLimit = 20; });
  $effect(() => {
    const ids = nodeSources.map((s) => s.id);
    // Execution records are local to the active database. The official overlay is a different graph.
    const official = officialKbActive();
    runs = [];
    runError = '';
    loadingRuns = ids.length > 0 && !official;
    if (!ids.length || official) return;
    const subscription = liveQuery(() => Promise.all(ids.map(extractionRunsForSource))).subscribe({
      next: (rows) => { runs = rows.flat(); loadingRuns = false; },
      error: () => { runError = 'Extraction records could not be loaded.'; loadingRuns = false; },
    });
    return () => subscription.unsubscribe();
  });
  function toggleSource(id: string) {
    if (controls.selectedIds.includes(id)) controls.selectedIds = controls.selectedIds.filter((value: string) => value !== id);
    else if (controls.selectedIds.length < MAX_PROVENANCE_SOURCES) controls.selectedIds = [...controls.selectedIds, id];
  }
  function toggleGroup(key: string) {
    const next = new Set(controls.expanded);
    if (next.has(key)) next.delete(key); else next.add(key);
    controls.expanded = next;
  }
  function selectNode(key: string | null) {
    if (key && !graph.nodes.has(key)) {
      const containing = graph.sources.flatMap((source) => source.groups.filter((group) => group.members.includes(key)).map((group) => group.key));
      controls.expanded = new Set([...controls.expanded, ...containing]);
    }
    selected = key;
  }
  function webLink(uri: string | undefined): string | null {
    if (!uri) return null;
    try { const url = new URL(uri); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
    catch { return null; }
  }
  const date = (time: number) => new Date(time).toLocaleString();
</script>

<div class="sources-shell" class:graph-mode={controls.presentation === 'graph'}>
  <details class="source-picker" bind:open={pickerOpen}>
    <summary>Sources · {controls.selectedIds.length} selected</summary>
    <div class="presentation-switch" role="group" aria-label="Source presentation">
      {#each ['graph', 'folders', 'list', 'gallery'] as mode}
        <button aria-pressed={controls.presentation === mode} onclick={() => controls.presentation = mode as typeof controls.presentation}>{mode === 'graph' ? 'Graph' : mode === 'folders' ? 'Folders' : mode === 'list' ? 'List' : 'Gallery'}</button>
      {/each}
    </div>
    <p class="intro">Sources → sets → entities. Each set contains only the members this source contributed to.</p>
    {#if controls.presentation === 'graph'}
      <details class="graph-tools"><summary>Graph controls</summary>{@render graphTools?.()}</details>
    {/if}
    <details class="filter-options"><summary>Source filters</summary>
    <fieldset class="provenance-filters"><legend>Filter source contributions</legend>
      <label>Source kind<select bind:value={controls.sourceKind}><option value="all">All kinds</option>
        {#each sourceKinds as kind}<option value={kind}>{kind === 'unrecorded' ? 'Kind not recorded' : kind}</option>{/each}
      </select></label>
      <label>Captured since<input type="date" bind:value={controls.capturedSince} /></label>
      <label>Statement review state<select bind:value={controls.reviewState}>
        <option value="all">All retained statements</option><option value="confirmed">Confirmed or refined</option><option value="pending">Pending review</option>
      </select></label>
      {#if controls.sourceKind !== 'all' || controls.capturedSince || controls.reviewState !== 'all'}
        <button onclick={() => { controls.sourceKind = 'all'; controls.capturedSince = ''; controls.reviewState = 'all'; }}>Reset source filters</button>
      {/if}
    </fieldset>
    </details>
    <label class="source-search">Find a source<input type="search" bind:value={controls.search} placeholder="Source title" /></label>
    <p class="selection-count" aria-live="polite">{controls.selectedIds.length} of {MAX_PROVENANCE_SOURCES} source slots used · {graph.sources.length} shown · {index.sources.length} available</p>
    <div class="source-options">
      {#each matchingSources as source (source.id)}
        <div class="source-option">
          <label>
            <input type="checkbox" checked={controls.selectedIds.includes(source.id)}
              disabled={!controls.selectedIds.includes(source.id) && controls.selectedIds.length >= MAX_PROVENANCE_SOURCES}
              onchange={() => toggleSource(source.id)} />
            <span>{source.title}<small>{source.entityKeys.length} entities · {source.statements.length} retained statements</small></span>
          </label>
          {#if controls.selectedIds.includes(source.id)}
            <button class="inspect-source" aria-label={`Inspect source ${source.title}`} onclick={() => selectNode(source.key)}>↗</button>
          {/if}
        </div>
      {/each}
      {#if !matchingSources.length}<p>No matching sources.</p>{/if}
    </div>
    <button class="clear" onclick={() => { controls.selectedIds = []; selected = null; }} disabled={!controls.selectedIds.length}>Clear selection</button>
  </details>

  {#if controls.presentation !== 'graph'}
    <section class="set-browser-pane" aria-label="Source sets">
      <SetBrowser {index} sources={graph.sources} mode={controls.presentation} {assetFor} onselect={selectNode} />
    </section>
  {/if}
</div>

{#if node}
  <AdaptivePanel corner="bottom-right" width={380} minWidth={280} maxWidth={600} zIndex={360}
    title={node.label} open={true} onOpenChange={(open) => { if (!open) selected = null; }}
    extraStyle="max-height: calc(100dvh - 170px); overflow-y: auto;">
    <section class="source-detail" aria-label="Source details">
      <div class="detail-heading"><div><span class="kind">{node.kind === 'group' ? 'entity group' : node.kind}</span><h3>{node.label}</h3></div>
        <button aria-label="Close source details" onclick={() => selected = null}>✕</button></div>

      {#if node.kind === 'source'}
        {@const source = node.source}
        {#if source.source}
          <p>{source.source.kind} · added {date(source.source.ingestedAt)}</p>
          {@const link = webLink(source.source.uri)}
          {#if link}<a href={link} target="_blank" rel="noopener noreferrer">Open source ↗</a>
          {:else if source.source.uri}<p class="source-uri">{source.source.uri}</p>{/if}
        {:else}
          <p>{source.id === 'manual' ? 'These statements were entered directly by you.' : source.id === '__unrecorded__'
            ? 'No source association was recorded on these statements.'
            : 'The source metadata is unavailable. The recorded source ID remains on the statements.'}</p>
        {/if}
        <div class="lineage" aria-label="Source extraction summary">
          <span>Source</span><span aria-hidden="true">→</span><span>{source.statements.length} retained statements</span><span aria-hidden="true">→</span><span>{source.entityKeys.length} entities</span>
        </div>
        <ExtractionTrail source={source.source} statements={fullIndex.sources.find((s) => s.id === source.id)?.statements ?? []}
          runs={runs.filter((run) => run.sourceId === source.id)} loading={loadingRuns} error={runError} />
        <h4>Extracted entity groups</h4>
        {#each source.groups as group (group.key)}
          <button class="detail-row" onclick={() => selected = group.key}>{group.label} <span>{group.members.length} entities →</span></button>
        {/each}
        {#if !source.groups.length}<p>No active entity statements are retained for this source.</p>{/if}
      {:else if node.kind === 'group'}
        {@const group = node.group}
        <p>{group.setIri ? 'Grouped using an existing set. Only members mentioned by this source are included.' : 'A summary of the entities mentioned by this source.'}</p>
        <button class="expand" aria-expanded={controls.expanded.has(group.key)} onclick={() => toggleGroup(group.key)}>
          {controls.expanded.has(group.key) ? 'Collapse group' : 'Expand group'}
        </button>
        <ul class="members">{#each group.members as key (key)}
          <li><button onclick={() => { controls.expanded = new Set([...controls.expanded, group.key]); selected = key; }}>{index.entities.get(key)?.label ?? key}</button></li>
        {/each}</ul>
      {:else}
        <button class="expand" onclick={() => onentity(node.entityKey)}>Show in knowledge view →</button>
      {/if}

      {#if node.kind !== 'source'}
        <h4>Sources of these statements</h4>
        {#each nodeSources as source (source.id)}
          <button class="detail-row" onclick={() => selected = source.key}>{source.title} <span>extraction history →</span></button>
        {/each}
      {/if}
      <h4>{controls.reviewState === 'all' ? 'Retained' : 'Matching'} statements ({nodeStatements.length})</h4>
      <p class="statement-hint">Each status belongs to the original statement. {controls.reviewState === 'all' ? 'Rejected and superseded records remain in the source history.' : 'The source review-state filter is applied.'}</p>
      <div class="statement-list">
        {#each nodeStatements.slice(0, statementLimit) as statement (statement.id)}
          <div class="original-statement" data-statement-id={statement.id}>
            <small>{index.sources.find((s) => s.id === statement.sourceId)?.title ?? 'Source not recorded'}</small>
            <StatementCard statement={statement.grounded === false ? { ...statement, excerpt: undefined } : statement} showGraph={false} />
            {#if statement.excerpt && statement.grounded !== false}
              <small>{statement.grounded === true ? 'Excerpt matched the source text.' : 'Excerpt retained; a source-text match was not recorded.'}</small>
            {/if}
          </div>
        {/each}
      </div>
      {#if nodeStatements.length > statementLimit}<button onclick={() => statementLimit += 20}>Show more statements</button>{/if}
    </section>
  </AdaptivePanel>
{/if}

<style>
  .sources-shell { position: fixed; inset: 5.4rem 0 5.5rem; z-index: 310; pointer-events: none; display: grid; grid-template-columns: 270px minmax(0, 1fr); gap: 0.75rem; padding: 0.75rem; }
  .source-picker { pointer-events: auto; background: var(--surface); border: 1px solid var(--line); border-radius: var(--rad); padding: 0.9rem; overflow: auto; }
  summary { cursor: pointer; font-weight: 700; }
  p { font-size: 0.83rem; line-height: 1.5; overflow-wrap: anywhere; }
  .intro, .selection-count, .statement-hint { color: var(--muted); }
  .source-search { display: grid; gap: 0.35rem; font-size: 0.8rem; }
  .source-search input { width: 100%; min-width: 0; }
  .provenance-filters { padding: 0.6rem; border: 1px solid var(--line); margin: 0 0 0.8rem; display: grid; gap: 0.6rem; }
  .filter-options { margin-bottom: 0.8rem; }
  .filter-options > summary { padding: 0.5rem 0; font-size: 0.82rem; color: var(--accent); }
  .provenance-filters legend { font-size: 0.78rem; color: var(--accent); }
  .provenance-filters label { display: grid; gap: 0.25rem; font-size: 0.78rem; }
  .provenance-filters input, .provenance-filters select { min-width: 0; width: 100%; }
  .source-options { display: grid; gap: 0.45rem; }
  .source-option { display: flex; gap: 0.35rem; align-items: center; border-bottom: 1px solid var(--line); padding: 0.5rem 0; }
  .source-option label { display: flex; align-items: flex-start; gap: 0.5rem; flex: 1; font-size: 0.84rem; cursor: pointer; overflow-wrap: anywhere; min-width: 0; }
  .source-option input { flex-shrink: 0; width: 17px; height: 17px; margin-top: 0.2rem; }
  small { display: block; font-size: 0.73rem; color: var(--muted); margin: 0.25rem 0; }
  button { cursor: pointer; }
  button:disabled { opacity: 0.45; cursor: default; }
  .inspect-source { min-width: 36px; min-height: 36px; }
  .clear { margin-top: 0.8rem; }
  .source-detail { padding: 0.8rem; }
  .detail-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 0.5rem; }
  .detail-heading button { flex-shrink: 0; }
  .kind { font-size: 0.73rem; color: var(--accent); text-transform: uppercase; }
  h3 { margin: 0.25rem 0; font-size: 1.05rem; overflow-wrap: anywhere; }
  h4 { font-size: 0.9rem; margin: 1rem 0 0.5rem; }
  .source-uri { overflow-wrap: anywhere; color: var(--muted); }
  .lineage { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; margin: 1rem 0; font-size: 0.8rem; color: var(--accent); }
  .lineage span:nth-child(odd) { padding: 0.4rem; border: 1px solid var(--line); border-radius: var(--rad-sm); }
  .detail-row { display: flex; justify-content: space-between; gap: 0.5rem; width: 100%; text-align: left; padding: 0.6rem; margin: 0.3rem 0; overflow-wrap: anywhere; }
  .detail-row span { color: var(--muted); font-size: 0.75rem; }
  .expand { margin: 0.6rem 0; color: var(--accent); }
  .members { padding-left: 1.1rem; max-height: 200px; overflow: auto; }
  .members button { background: transparent; text-align: left; padding: 0.35rem; border: none; }
  .statement-list { display: grid; gap: 0.7rem; }
  @media (max-width: 850px) {
    .sources-shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); inset: 6rem 0 calc(9.5rem + env(safe-area-inset-bottom)); padding: 0.45rem; }
    .source-picker[open] { max-height: 35dvh; }
    .source-picker summary { min-height: 28px; }
    .inspect-source, .members button, .detail-heading button { min-height: 44px; }

  }
  .graph-mode { display: block; }
  .graph-mode .source-picker { width: 280px; max-height: 100%; box-sizing: border-box; }
  .set-browser-pane { pointer-events: auto; overflow: auto; background: var(--bg); border: 1px solid var(--line); border-radius: var(--rad); }
  .presentation-switch { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.15rem; margin: 0.7rem 0; }
  .presentation-switch button { padding: 0.35rem 0.1rem; min-height: 36px; font-size: 0.72rem; }
  .presentation-switch button[aria-pressed='true'] { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
  .graph-tools > summary { padding: 0.4rem 0; font-size: 0.8rem; }
  @media (max-width: 850px) {
    .graph-mode .source-picker { width: 100%; }
    .presentation-switch button { min-height: 44px; }
  }
</style>
