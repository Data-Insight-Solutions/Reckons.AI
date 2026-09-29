<script lang="ts">
  /**
   * The Spaces map (F218 phase 1) — each space a node, leaps between spaces one weighted edge per
   * pair, sets as clusters. Layout and aggregation live in $lib/rdf/space-graph.ts; this file only
   * draws them. SVG with no dependencies and no simulation, so it is the same picture every time.
   */
  import { buildSpaceGraph, edgeWidth, type SetInput, type SpaceInput, type SpaceNode } from '$lib/rdf/space-graph';

  let {
    spaces,
    sets,
    currentId,
    onOpen,
    onCountAll,
    counting = null,
  }: {
    spaces: SpaceInput[];
    sets: SetInput[];
    currentId: string;
    onOpen: (id: string) => void;
    onCountAll: () => void;
    /** Progress of an explicit count over every space, or null when idle. */
    counting?: { done: number; total: number } | null;
  } = $props();

  const graph = $derived(buildSpaceGraph(spaces, sets));
  const byId = $derived(new Map(graph.nodes.map((n) => [n.id, n])));
  let selectedId = $state<string | null>(null);
  const selected = $derived(selectedId ? byId.get(selectedId) ?? null : null);

  const BASIS_LABEL: Record<string, string> = { derived: 'by name', folder: 'by folder', declared: 'declared', defined: 'your set' };

  /** Every connection of one space, with the count each way, strongest first. */
  function connectionsOf(id: string) {
    return graph.edges
      .filter((e) => e.a === id || e.b === id)
      .map((e) => {
        const other = e.a === id ? e.b : e.a;
        return { other, name: byId.get(other)?.name ?? other, out: e.a === id ? e.aToB : e.bToA, in: e.a === id ? e.bToA : e.aToB };
      });
  }

  function label(n: SpaceNode): string {
    return n.name.length > 18 ? `${n.name.slice(0, 17)}…` : n.name;
  }

  function nodeAria(n: SpaceNode): string {
    const links = connectionsOf(n.id).length;
    return `${n.name}: ${n.statementCount} statements, ${n.leapsCounted ? `${links} connected space${links === 1 ? '' : 's'}` : 'leaps not counted yet'}${n.id === currentId ? ', current space' : ''}`;
  }

  function onNodeKey(e: KeyboardEvent, id: string) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectedId = id; }
    if (e.key === 'Escape') selectedId = null;
  }
</script>

<div class="spaces-map">
  <p class="map-summary mono">
    {graph.nodes.length} space{graph.nodes.length === 1 ? '' : 's'} · {graph.edges.length} connection{graph.edges.length === 1 ? '' : 's'}
    {#if graph.uncounted > 0}
      · <span class="uncounted">leaps not counted in {graph.uncounted}</span>
      <button class="count-all mono" onclick={onCountAll} disabled={counting !== null}>
        {counting ? `counting ${counting.done}/${counting.total}…` : 'count leaps in every space'}
      </button>
    {/if}
  </p>

  <svg viewBox={`0 0 ${graph.width} ${graph.height}`} class="map-svg" role="group" aria-label="Map of your spaces and the leaps between them">
    {#each graph.regions as region (region.id)}
      <g class="region" aria-hidden="true">
        <circle cx={region.x} cy={region.y} r={region.r} />
        <text x={region.x} y={region.y - region.r - 6} text-anchor="middle" class="region-title">
          {region.title}{#if BASIS_LABEL[region.basis]}<tspan class="region-basis"> · {BASIS_LABEL[region.basis]}</tspan>{/if}
        </text>
      </g>
    {/each}

    {#each graph.edges as edge (edge.a + edge.b)}
      {@const a = byId.get(edge.a)}
      {@const b = byId.get(edge.b)}
      {#if a && b}
        <line
          x1={a.x} y1={a.y} x2={b.x} y2={b.y}
          stroke-width={edgeWidth(edge.total)}
          class="edge"
          class:edge-selected={selectedId === edge.a || selectedId === edge.b}
        >
          <title>{a.name} → {b.name}: {edge.aToB} · {b.name} → {a.name}: {edge.bToA}</title>
        </line>
      {/if}
    {/each}

    {#each graph.nodes as n (n.id)}
      <g
        class="node"
        class:current={n.id === currentId}
        class:selected={n.id === selectedId}
        class:uncounted={!n.leapsCounted}
        role="button"
        tabindex="0"
        aria-label={nodeAria(n)}
        aria-pressed={n.id === selectedId}
        onclick={() => (selectedId = selectedId === n.id ? null : n.id)}
        onkeydown={(e) => onNodeKey(e, n.id)}
      >
        <circle cx={n.x} cy={n.y} r={n.r} />
        <text x={n.lx} y={n.ly} text-anchor={n.anchor}>{label(n)}</text>
      </g>
    {/each}
  </svg>

  {#if selected}
    {@const links = connectionsOf(selected.id)}
    <div class="map-detail" aria-live="polite">
      <div class="detail-head">
        <strong>{selected.name}</strong>
        {#if selected.id === currentId}<span class="mono tag">current</span>{/if}
      </div>
      <p class="mono detail-line">{selected.statementCount} statements</p>
      {#if !selected.leapsCounted}
        <p class="detail-line muted">Leaps from this space have not been counted yet, so its connections are unknown rather than none.</p>
      {:else if links.length === 0}
        <p class="detail-line muted">No leaps between this space and any other.</p>
      {:else}
        <ul class="detail-links">
          {#each links as l (l.other)}
            <li>
              <button class="linklike" onclick={() => (selectedId = l.other)}>{l.name}</button>
              <span class="mono muted">{l.out} out · {l.in} in</span>
            </li>
          {/each}
        </ul>
      {/if}
      {#if selected.unresolvedLeaps > 0}
        <p class="detail-line muted">{selected.unresolvedLeaps === 1 ? '1 leap points' : `${selected.unresolvedLeaps} leaps point`} at a space not on this device.</p>
      {/if}
      {#if selected.id !== currentId}
        <button class="sm mono" onclick={() => onOpen(selected.id)}>open this space →</button>
      {/if}
    </div>
  {:else if graph.edges.length === 0 && graph.uncounted === 0 && graph.nodes.length > 1}
    <p class="detail-line muted">No leaps between your spaces yet. A leap is a node that links to another space; add one from a node's panel in the explorer.</p>
  {/if}
</div>

<style>
  .spaces-map { display: flex; flex-direction: column; gap: 0.5rem; }
  .map-summary { font-size: 0.75rem; color: var(--muted); display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; margin: 0; }
  .uncounted { color: var(--warn); }
  .count-all { font-size: 0.75rem; min-height: 44px; padding: 0 0.75rem; color: var(--accent); border: 1px solid var(--accent); border-radius: var(--rad-sm); background: transparent; cursor: pointer; }
  .count-all:disabled { opacity: 0.6; cursor: progress; }
  .map-svg { width: 100%; max-width: 560px; height: auto; align-self: center; background: var(--surface); border: 1px solid var(--line); border-radius: var(--rad); }
  .region circle { fill: var(--surface-2); stroke: var(--line); stroke-dasharray: 3 4; }
  .region-title { font-family: var(--font-mono); font-size: 18px; fill: var(--ink-2); }
  .region-basis { fill: var(--muted); font-size: 15px; }
  .edge { stroke: var(--accent); stroke-opacity: 0.45; stroke-linecap: round; }
  .edge-selected { stroke-opacity: 0.9; }
  .node { cursor: pointer; outline: none; }
  .node circle { fill: var(--surface); stroke: var(--accent); stroke-width: 1.5; }
  .node.current circle { fill: var(--accent-soft); stroke-width: 3; }
  .node.uncounted circle { stroke-dasharray: 4 3; stroke: var(--muted); }
  .node.selected circle, .node:focus-visible circle { stroke-width: 3.5; stroke: var(--accent); }
  .node text { font-size: 19px; fill: var(--ink); pointer-events: none; paint-order: stroke; stroke: var(--surface); stroke-width: 3px; }
  .map-detail { border: 1px solid var(--line); border-radius: var(--rad-sm); padding: 0.6rem 0.75rem; background: var(--surface); display: flex; flex-direction: column; gap: 0.35rem; }
  .detail-head { display: flex; align-items: center; gap: 0.5rem; }
  .tag { font-size: 0.6rem; color: var(--accent); text-transform: uppercase; }
  .detail-line { margin: 0; font-size: 0.8rem; }
  .muted { color: var(--muted); }
  .detail-links { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.8rem; }
  .detail-links li { display: flex; justify-content: space-between; gap: 0.75rem; }
  .linklike { background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; font: inherit; text-align: left; min-height: 44px; }
</style>
