<script lang="ts">
  /**
   * THE ONE GRAPH CANVAS (F92 kb:one-graph-canvas, step 1).
   *
   * Before this, / and /review each chose between the 2D and 3D renderers themselves, each wrapped 3D
   * in its own error boundary, and the copies had already drifted (/review passes no node order to
   * 2D and shows a different 3D failure). This component owns that choice and the boundary, so every
   * mode that shows a graph mounts the same thing, and a page supplies only WHAT to draw and what its
   * overlays are.
   *
   * Step 1 changes no behaviour: each page passes the props it passed before, per renderer. Moving
   * level-of-detail, labels and node details in here are later steps (see the F92 roadmap entity).
   */
  import type { ComponentProps, Snippet } from 'svelte';
  import { Canvas } from '@threlte/core';
  import KnowledgeGraph from '$lib/3d/KnowledgeGraph.svelte';
  import KnowledgeGraph2D from '$lib/3d/KnowledgeGraph2D.svelte';

  let {
    renderer,
    props2d,
    props3d,
    onFailure,
    overlay,
  }: {
    /** Which renderer draws: the page decides (preference, WebGL support, performance fallback). */
    renderer: '2d' | '3d';
    props2d: ComponentProps<typeof KnowledgeGraph2D>;
    props3d: ComponentProps<typeof KnowledgeGraph>;
    /** What to show when the 3D renderer throws; receives the error. */
    onFailure?: Snippet<[unknown]>;
    /** Anything drawn over the graph: labels, panels, pickers. */
    overlay?: Snippet;
  } = $props();
</script>

{#if renderer === '2d'}
  <KnowledgeGraph2D {...props2d} />
{:else}
  <svelte:boundary>
    <Canvas>
      <KnowledgeGraph {...props3d} />
    </Canvas>
    {#snippet failed(error)}
      {@render onFailure?.(error)}
    {/snippet}
  </svelte:boundary>
{/if}
{@render overlay?.()}
