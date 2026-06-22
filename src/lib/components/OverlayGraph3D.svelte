<script lang="ts">
  import { Canvas } from '@threlte/core';
  import OverlayScene from './OverlayScene.svelte';
  import type { GraphDef, OverlayNode, OverlayEdge } from '$lib/rdf/multi-graph-parse';

  let {
    graphs = [],
    nodes = new Map() as Map<string, OverlayNode>,
    edges = [] as OverlayEdge[],
    activeGraphIds = new Set() as Set<string>,
    activePredicates = new Set() as Set<string>,
  } = $props<{
    graphs: GraphDef[];
    nodes: Map<string, OverlayNode>;
    edges: OverlayEdge[];
    activeGraphIds: Set<string>;
    activePredicates: Set<string>;
  }>();
</script>

<div class="wrap">
  <Canvas>
    <OverlayScene {graphs} {nodes} {edges} {activeGraphIds} {activePredicates} />
  </Canvas>

  <div class="legend">
    <span class="dot-chip"><span class="geo tetra"></span> single project</span>
    <span class="dot-chip"><span class="geo octa"></span> 2-3 projects</span>
    <span class="dot-chip"><span class="geo ico"></span> 4+ projects</span>
    <span class="dot-chip"><span class="geo dodeca"></span> project node</span>
    <span class="dot-chip">ring = shared</span>
  </div>
</div>

<style>
  .wrap {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 500px;
    border-radius: var(--rad);
    overflow: hidden;
    border: 1px solid var(--line);
    background: var(--surface);
  }

  .legend {
    position: absolute;
    bottom: 0.65rem;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 0.75rem;
    align-items: center;
    background: rgba(10, 10, 14, 0.82);
    backdrop-filter: blur(10px);
    border-radius: 999px;
    padding: 0.35rem 1.1rem;
    pointer-events: none;
    white-space: nowrap;
  }

  .dot-chip {
    font-family: var(--font-mono);
    font-size: 0.58rem;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .geo {
    display: inline-block;
    width: 8px;
    height: 8px;
    background: #888;
  }
  .geo.tetra { clip-path: polygon(50% 0%, 0% 100%, 100% 100%); }
  .geo.octa { clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%); }
  .geo.ico { border-radius: 50%; }
  .geo.dodeca {
    border-radius: 50%;
    background: #9b6ee0;
    width: 10px;
    height: 10px;
  }
</style>
