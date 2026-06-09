<script lang="ts">
  import { Canvas } from '@threlte/core';
  import CompareScene from './CompareScene.svelte';
  import type { Statement } from '$lib/rdf/types';

  let {
    incoming = [],
    existing = [],
    newCount = 0,
    sharedCount = 0,
    kbOnlyCount = 0
  } = $props<{
    incoming: Statement[];
    existing: Statement[];
    newCount: number;
    sharedCount: number;
    kbOnlyCount: number;
  }>();
</script>

<div class="wrap">
  <Canvas>
    <CompareScene {incoming} {existing} />
  </Canvas>

  <!-- Legend -->
  <div class="legend">
    <span class="dot-chip incoming">⬤ {newCount} new</span>
    <span class="dot-chip shared">⬤ {sharedCount} shared</span>
    <span class="dot-chip kb">⬤ {kbOnlyCount} kb only</span>
    {#if incoming.length === 0 && existing.length === 0}
      <span class="empty-hint">ingest something to compare</span>
    {/if}
  </div>
</div>

<style>
  .wrap {
    position: relative;
    width: 100%;
    height: 420px;
    border-radius: var(--rad);
    overflow: hidden;
    border: 1px solid var(--line);
    background: var(--surface);
    margin: 1.25rem 0;
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
    font-size: 0.62rem;
  }
  .dot-chip.incoming { color: #1a9b8e; }
  .dot-chip.shared   { color: #e8b84b; }
  .dot-chip.kb       { color: #3d7cf5; }

  .empty-hint {
    font-family: var(--font-mono);
    font-size: 0.62rem;
    color: var(--muted);
  }
</style>
