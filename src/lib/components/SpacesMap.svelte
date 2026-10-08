<script lang="ts">
  /**
   * The Spaces map (F218 phase 1) — each space a node, leaps between spaces one weighted edge per
   * pair, sets as clusters. Layout and aggregation live in $lib/rdf/space-graph.ts; this file only
   * draws them. SVG with no dependencies and no simulation, so it is the same picture every time.
   */
  import { buildSpaceGraph, edgeWidth, placeLabels, BASE_SIZE, type SetInput, type SpaceInput, type SpaceNode } from '$lib/rdf/space-graph';

  let {
    spaces,
    sets,
    currentId,
    onOpen,
    counting = null,
    failures = [],
  }: {
    spaces: SpaceInput[];
    sets: SetInput[];
    currentId: string;
    onOpen: (id: string) => void;
    /** Progress of the background count over other spaces, or null when idle. */
    counting?: { done: number; total: number } | null;
    /** Spaces the background read could not open, each with its reason. */
    failures?: { id: string; name: string; reason: string; notOnDevice: boolean }[];
  } = $props();
  const notOnDevice = $derived(failures.filter((f) => f.notOnDevice));
  const readErrors = $derived(failures.filter((f) => !f.notOnDevice));

  const graph = $derived(buildSpaceGraph(spaces, sets));
  const byId = $derived(new Map(graph.nodes.map((n) => [n.id, n])));
  let selectedId = $state<string | null>(null);
  let hoverId = $state<string | null>(null);
  /** Marks keep their on-screen size however large the drawing grows to fit its pools. */
  const k = $derived(graph.width / BASE_SIZE);
  const labels = $derived(new Map(placeLabels(graph, { currentId, selectedId, hoverId }).map((l) => [l.id, l])));
  const selected = $derived(selectedId ? byId.get(selectedId) ?? null : null);
  const totalUnresolved = $derived(graph.nodes.reduce((sum, n) => sum + n.unresolvedLeaps, 0));

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

  /*
   * THE TANK (Matt, 2026-09-29: "a cute undersea theme ... or a fish tank"). Starfish in tide pools is
   * the metaphor Matt chose on 2026-09-23 (kb:meta-graph-view): a space is a starfish, a set is the
   * pool holding them. Two traps recorded with that decision shape the drawing: a starfish's arms must
   * not read as connections (so arms are short and fixed, and a connection is a trail of bubbles that
   * looks nothing like an arm), and the edge must not be called a "current" (that word is F29's).
   * Everything here is decoration over the same layout; the words stay "spaces" and "sets".
   */
  const STAR_COLORS = ['#ff8a65', '#f48fb1', '#ffb74d', '#ce93d8', '#ff7043', '#f06292'];
  function starColor(id: string): string {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return STAR_COLORS[h % STAR_COLORS.length];
  }
  /** A plump five-armed star centred on (cx, cy): short arms, so it reads as a body, not as spokes. */
  function starPath(cx: number, cy: number, r: number): string {
    const pts: string[] = [];
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 === 0 ? r : r * 0.55;
      pts.push(`${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`);
    }
    return `M${pts.join('L')}Z`;
  }
  // Fixed scenery, positioned in the drawing's own coordinates so it never shifts between visits.
  const BUBBLES = [0.12, 0.27, 0.46, 0.63, 0.81, 0.92].map((fx, i) => ({ fx, r: 2.5 + (i % 3) * 1.5, delay: i * 1.7, dur: 7 + (i % 4) * 1.5 }));
  const WEEDS = [0.06, 0.15, 0.86, 0.94].map((fx, i) => ({ fx, h: 70 + (i % 2) * 34, delay: i * 0.9 }));

  function nodeAria(n: SpaceNode): string {
    const links = connectionsOf(n.id).length;
    return `${n.name}: ${n.statementCount} statements, ${n.leapsCounted ? `${links} connected space${links === 1 ? '' : 's'}` : 'not read yet'}${n.id === currentId ? ', current space' : ''}`;
  }

  function onNodeKey(e: KeyboardEvent, id: string) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectedId = id; }
    if (e.key === 'Escape') selectedId = null;
  }
</script>

<div class="spaces-map">
  <p class="map-summary mono">
    {graph.nodes.length} space{graph.nodes.length === 1 ? '' : 's'} · {graph.edges.length} connection{graph.edges.length === 1 ? '' : 's'}
    {#if counting}
      · <span class="counting" role="status">reading leaps in other spaces… {counting.done}/{counting.total}</span>
    {:else if readErrors.length > 0}
      · <span class="uncounted">{readErrors.length} space{readErrors.length === 1 ? '' : 's'} could not be read</span>
    {/if}
    {#if !counting && notOnDevice.length > 0}
      · <span class="muted">{notOnDevice.length} not on this device yet</span>
    {/if}
  </p>

  {#if !counting && failures.length > 0}
    <details class="read-report">
      <summary class="mono">why some spaces are not drawn with their connections</summary>
      <ul>
        {#each failures as f (f.id)}
          <li><strong>{f.name}</strong> <span class="mono muted">{f.notOnDevice ? 'not on this device yet — open it once to load it' : f.reason}</span></li>
        {/each}
      </ul>
    </details>
  {/if}

  <svg viewBox={`0 0 ${graph.width} ${graph.height}`} class="map-svg" role="group" aria-label="Map of your spaces and the leaps between them">
    <defs>
      <linearGradient id="tank-water" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#0f5f73" />
        <stop offset="55%" stop-color="#0b3f57" />
        <stop offset="100%" stop-color="#082a40" />
      </linearGradient>
      <radialGradient id="tank-pool" cx="50%" cy="45%" r="60%">
        <stop offset="0%" stop-color="#1b7d8f" stop-opacity="0.55" />
        <stop offset="100%" stop-color="#0d4d63" stop-opacity="0.35" />
      </radialGradient>
    </defs>

    <!-- scenery: water, light, sand, seaweed, bubbles. Hidden from assistive tech; decoration only. -->
    <g aria-hidden="true" class="scenery">
      <rect x="0" y="0" width={graph.width} height={graph.height} fill="url(#tank-water)" />
      <polygon class="ray" points={`${graph.width * 0.18},0 ${graph.width * 0.3},0 ${graph.width * 0.42},${graph.height} ${graph.width * 0.22},${graph.height}`} />
      <polygon class="ray ray-2" points={`${graph.width * 0.6},0 ${graph.width * 0.68},0 ${graph.width * 0.8},${graph.height} ${graph.width * 0.64},${graph.height}`} />
      <path class="sand" d={`M0,${graph.height - 26} Q${graph.width * 0.25},${graph.height - 40} ${graph.width * 0.5},${graph.height - 28} T${graph.width},${graph.height - 30} L${graph.width},${graph.height} L0,${graph.height} Z`} />
      {#each WEEDS as w (w.fx)}
        <path class="weed" style={`animation-delay:${w.delay}s; transform-origin:${w.fx * graph.width}px ${graph.height - 24}px`}
          d={`M${w.fx * graph.width},${graph.height - 24} q-12,${-w.h / 3} 0,${-w.h / 1.8} t0,${-w.h / 2.2}`} />
      {/each}
      {#each BUBBLES as b (b.fx)}
        <circle class="bubble" cx={b.fx * graph.width} cy={graph.height - 30} r={b.r} style={`animation-delay:${b.delay}s; animation-duration:${b.dur}s`} />
      {/each}
    </g>

    {#each graph.regions as region (region.id)}
      <g class="region" aria-hidden="true">
        <circle class="pool" cx={region.x} cy={region.y} r={region.r} />
        <circle class="pool-rim" cx={region.x} cy={region.y} r={region.r} style={`stroke-width:${5 * k}px; stroke-dasharray:${2 * k} ${9 * k}`} />
        <text x={region.x} y={region.y - region.r - 8 * k} text-anchor="middle" class="region-title" style={`font-size:${18 * k}px; stroke-width:${4 * k}px`}>
          {region.title}{#if BASIS_LABEL[region.basis]}<tspan class="region-basis"> · {BASIS_LABEL[region.basis]}</tspan>{/if}
        </text>
      </g>
    {/each}

    {#each graph.edges as edge (edge.a + edge.b)}
      {@const a = byId.get(edge.a)}
      {@const b = byId.get(edge.b)}
      {#if a && b}
        <!-- a connection is a trail of bubbles: nothing like a starfish arm -->
        <line
          x1={a.x} y1={a.y} x2={b.x} y2={b.y}
          stroke-width={edgeWidth(edge.total) * k}
          stroke-dasharray={`0 ${edgeWidth(edge.total) * k * 2.2}`}
          class="edge"
          class:edge-selected={selectedId === edge.a || selectedId === edge.b}
        >
          <title>{a.name} → {b.name}: {edge.aToB} · {b.name} → {a.name}: {edge.bToA}</title>
        </line>
      {/if}
    {/each}

    {#each graph.nodes as n (n.id)}
      {@const R = n.r * k}
      {@const L = labels.get(n.id)}
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
        onpointerenter={() => (hoverId = n.id)}
        onpointerleave={() => { if (hoverId === n.id) hoverId = null; }}
        onfocus={() => (hoverId = n.id)}
        onblur={() => { if (hoverId === n.id) hoverId = null; }}
      >
        <circle class="hit" cx={n.x} cy={n.y} r={Math.max(R + 6 * k, 22 * k)} />
        {#if n.id === currentId || n.id === selectedId}<circle class="halo" cx={n.x} cy={n.y} r={R + 7 * k} style={`stroke-width:${2.5 * k}px`} />{/if}
        <path class="star" d={starPath(n.x, n.y, R)} fill={starColor(n.id)} style={`stroke-width:${1.5 * k}px`} />
        <circle class="eye" cx={n.x - R * 0.2} cy={n.y - R * 0.05} r={Math.max(1.4 * k, R * 0.09)} />
        <circle class="eye" cx={n.x + R * 0.2} cy={n.y - R * 0.05} r={Math.max(1.4 * k, R * 0.09)} />
        <path class="smile" d={`M${n.x - R * 0.16},${n.y + R * 0.14} q${R * 0.16},${R * 0.14} ${R * 0.32},0`} style={`stroke-width:${1.3 * k}px`} />
        {#if L}
          <text x={L.x} y={L.y} text-anchor={L.anchor} class:label-hidden={!L.shown} style={`font-size:${L.fontSize}px; stroke-width:${4 * k}px`}>{L.text}</text>
        {/if}
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
        <p class="detail-line muted">This space has not been read yet, so its connections are unknown rather than none.</p>
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
  {:else if graph.edges.length === 0 && !counting && graph.nodes.length > 1}
    <p class="detail-line muted">
      No lines yet because none of these spaces links to another. A line appears when a node in one space
      jumps to a different space: select a node in the explorer, choose <strong>+ add jump</strong>, and enter the
      other space's graph ID.{#if totalUnresolved > 0} {totalUnresolved === 1 ? '1 jump points' : `${totalUnresolved} jumps point`} at a space that is not on this device.{/if}
    </p>
  {/if}
</div>

<style>
  .spaces-map { display: flex; flex-direction: column; gap: 0.5rem; }
  .map-summary { font-size: 0.75rem; color: var(--muted); display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; margin: 0; }
  .uncounted { color: var(--warn); }
  .counting { color: var(--accent); }
  .read-report { font-size: 0.75rem; color: var(--muted); }
  .read-report summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; }
  .read-report ul { margin: 0.25rem 0 0; padding-left: 1rem; display: flex; flex-direction: column; gap: 0.2rem; }
  .map-svg { width: 100%; max-width: 560px; height: auto; align-self: center; border: 1px solid var(--line); border-radius: var(--rad); overflow: hidden; }
  .ray { fill: #bff6ff; opacity: 0.06; }
  .ray-2 { opacity: 0.045; }
  .sand { fill: #c9a86a; opacity: 0.55; }
  .weed { fill: none; stroke: #2e8b57; stroke-width: 5; stroke-linecap: round; opacity: 0.75; animation: sway 6s ease-in-out infinite alternate; }
  .bubble { fill: none; stroke: #d7fbff; stroke-width: 1.2; opacity: 0; animation: rise 8s linear infinite; }
  @keyframes sway { from { transform: rotate(-5deg); } to { transform: rotate(5deg); } }
  @keyframes rise { 0% { transform: translateY(0); opacity: 0; } 10% { opacity: 0.7; } 90% { opacity: 0.5; } 100% { transform: translateY(-520px); opacity: 0; } }
  .pool { fill: url(#tank-pool); }
  .pool-rim { fill: none; stroke: #8d7b68; stroke-linecap: round; opacity: 0.8; }
  .region-title { font-family: var(--font-mono); fill: #e6fbff; paint-order: stroke; stroke: #06283a; }
  .region-basis { fill: #9fd9e6; font-size: 0.83em; }
  .edge { stroke: #b2f1ff; stroke-opacity: 0.75; stroke-linecap: round; }
  .edge-selected { stroke: #ffffff; stroke-opacity: 1; }
  .node { cursor: pointer; outline: none; }
  .node .hit { fill: transparent; }
  .star { stroke: rgba(255, 255, 255, 0.55); stroke-linejoin: round; transition: transform 0.25s ease-out; transform-box: fill-box; transform-origin: center; }
  .node:hover .star, .node:focus-visible .star, .node.selected .star { transform: scale(1.12) rotate(8deg); }
  .node.uncounted .star { filter: saturate(0.35); stroke-dasharray: 3 3; }
  .halo { fill: none; stroke: #fff6a8; opacity: 0.85; }
  .node:focus-visible .halo, .node:focus-visible .star { stroke: #ffffff; }
  .eye { fill: #3b2330; }
  .smile { fill: none; stroke: #3b2330; stroke-linecap: round; }
  .node text { fill: #ffffff; pointer-events: none; paint-order: stroke; stroke: #06283a; opacity: 1; transition: opacity 0.28s ease-out; }
  .node text.label-hidden { opacity: 0; }
  @media (prefers-reduced-motion: reduce) {
    .node text { transition: none; }
    .weed, .bubble { animation: none; }
    .bubble { opacity: 0.35; }
    .star { transition: none; }
  }
  .map-detail { border: 1px solid var(--line); border-radius: var(--rad-sm); padding: 0.6rem 0.75rem; background: var(--surface); display: flex; flex-direction: column; gap: 0.35rem; }
  .detail-head { display: flex; align-items: center; gap: 0.5rem; }
  .tag { font-size: 0.6rem; color: var(--accent); text-transform: uppercase; }
  .detail-line { margin: 0; font-size: 0.8rem; }
  .muted { color: var(--muted); }
  .detail-links { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.8rem; }
  .detail-links li { display: flex; justify-content: space-between; gap: 0.75rem; }
  .linklike { background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; font: inherit; text-align: left; min-height: 44px; }
</style>
