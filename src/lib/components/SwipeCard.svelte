<script lang="ts">
  import { tick } from 'svelte';
  import type { Snippet } from 'svelte';

  let {
    onaccept,
    onreject,
    acceptLabel = '✓ accept',
    rejectLabel = '✕ reject',
    children
  }: {
    onaccept: () => void;
    onreject: () => void;
    acceptLabel?: string;
    rejectLabel?: string;
    children: Snippet;
  } = $props();

  const THRESHOLD = 80;

  let startX = 0;
  let dx = $state(0);
  let dragging = $state(false);
  let committed = $state(false);

  function onpointerdown(e: PointerEvent) {
    if ((e.target as Element).closest('button, a, input, select, textarea')) return;
    startX = e.clientX;
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onpointermove(e: PointerEvent) {
    if (!dragging) return;
    dx = e.clientX - startX;
  }

  async function onpointerup(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    const W = (e.view as Window | null)?.innerWidth ?? window.innerWidth;
    if (dx > THRESHOLD) {
      committed = true;
      dx = W + 200;
      await tick();
      onaccept();
    } else if (dx < -THRESHOLD) {
      committed = true;
      dx = -(W + 200);
      await tick();
      onreject();
    } else {
      dx = 0;
    }
  }
</script>

<div
  class="swipe-card"
  class:dragging
  class:committed
  style="transform: translateX({dx}px)"
  onpointerdown={onpointerdown}
  onpointermove={onpointermove}
  onpointerup={onpointerup}
  onpointercancel={() => { dragging = false; dx = 0; }}
  role="listitem"
>
  {#if dx > 20}
    <div class="swipe-overlay accept" style="opacity: {Math.min(1, (dx - 20) / THRESHOLD)}">
      <span>{acceptLabel}</span>
    </div>
  {:else if dx < -20}
    <div class="swipe-overlay reject" style="opacity: {Math.min(1, (-dx - 20) / THRESHOLD)}">
      <span>{rejectLabel}</span>
    </div>
  {/if}
  {@render children()}
</div>

<style>
  .swipe-card {
    position: relative;
    transition: transform 0.15s ease, opacity 0.2s ease;
    touch-action: pan-y;
    cursor: grab;
  }
  .swipe-card.dragging {
    transition: none;
    cursor: grabbing;
    user-select: none;
  }
  .swipe-card.committed {
    transition: transform 0.25s ease, opacity 0.25s ease;
    opacity: 0;
    pointer-events: none;
  }
  .swipe-overlay {
    position: absolute;
    inset: 0;
    border-radius: var(--rad);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono);
    font-size: 1rem;
    font-weight: 600;
    pointer-events: none;
    z-index: 2;
    letter-spacing: 0.05em;
  }
  .swipe-overlay.accept {
    background: color-mix(in srgb, var(--ok, #2a9d5c) 22%, transparent);
    color: var(--ok, #2a9d5c);
    border: 2px solid color-mix(in srgb, var(--ok, #2a9d5c) 45%, transparent);
  }
  .swipe-overlay.reject {
    background: color-mix(in srgb, var(--danger, #e05) 18%, transparent);
    color: var(--danger, #e05);
    border: 2px solid color-mix(in srgb, var(--danger, #e05) 40%, transparent);
  }
</style>
