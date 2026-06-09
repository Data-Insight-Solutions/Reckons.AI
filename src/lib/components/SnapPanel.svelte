<script lang="ts">
  /**
   * SnapPanel — draggable, resizable, corner-snapping panel.
   *
   * Accepts a named `header` snippet (the drag handle area) and `children`
   * (the scrollable content). Snaps to the nearest screen corner on drag release.
   * Resize handles appear on the two edges that face inward from the snapped corner.
   */
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { registerPanel, unregisterPanel, getColumnMaxH } from '$lib/stores/snap-layout.svelte';

  type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

  let {
    corner   = 'bottom-right' as Corner,
    width    = 320,
    minWidth = 180,
    maxWidth = 800,
    minHeight = 80,
    zIndex   = 300,
    extraStyle = '',
    header,
    children
  } = $props<{
    corner?:    Corner;
    width?:     number;
    minWidth?:  number;
    maxWidth?:  number;
    minHeight?: number;
    zIndex?:    number;
    extraStyle?: string;
    header?:    Snippet;
    children?:  Snippet;
  }>();

  // 60px = SearchBar / top chrome;  52px = NavBar (bottom: 1rem + ~36px tall)
  const TOP_MARGIN    = 60;
  const BOTTOM_MARGIN = 52;
  const EDGE_MARGIN   = 12;
  const SNAP_DIST     = 60; // px from screen edge triggers snap

  let snappedCorner = $state<Corner>(corner);
  let isSnapped     = $state(true);
  let floatLeft     = $state(0);
  let floatTop      = $state(0);
  let panelW        = $state(width);
  let panelH        = $state<number | null>(null); // null = auto

  let panelEl: HTMLDivElement | undefined;

  // ── Column overlap detection ──────────────────────────────────────────────
  const _id = Math.random().toString(36).slice(2, 10);
  let windowH = $state(typeof window !== 'undefined' ? window.innerHeight : 900);

  // Register/re-register whenever the snapped corner changes; clean up on unmount
  $effect(() => {
    registerPanel(_id, snappedCorner);
    return () => unregisterPanel(_id);
  });

  onMount(() => {
    windowH = window.innerHeight;
    function onResize() { windowH = window.innerHeight; }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  // Max-height when a partner panel occupies the same screen column
  const columnMaxH = $derived(isSnapped ? getColumnMaxH(_id, windowH) : null);

  // ── Current position (for snapped panels, compute from corner) ────────────

  function currentPos(): { left: number; top: number } {
    if (!isSnapped) return { left: floatLeft, top: floatTop };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const ph = panelEl?.offsetHeight ?? 300;
    switch (snappedCorner) {
      case 'top-left':     return { left: EDGE_MARGIN, top: TOP_MARGIN };
      case 'top-right':    return { left: vw - panelW - EDGE_MARGIN, top: TOP_MARGIN };
      case 'bottom-left':  return { left: EDGE_MARGIN, top: vh - ph - BOTTOM_MARGIN };
      case 'bottom-right': return { left: vw - panelW - EDGE_MARGIN, top: vh - ph - BOTTOM_MARGIN };
    }
  }

  // ── Drag ─────────────────────────────────────────────────────────────────

  let dragStart = $state<{ mx: number; my: number; left: number; top: number } | null>(null);

  function onDragDown(e: PointerEvent) {
    // Don't initiate drag when clicking interactive elements inside the header
    if ((e.target as Element).closest('button,input,textarea,select,a,[role=button]')) return;
    e.preventDefault();
    const p = currentPos();
    dragStart = { mx: e.clientX, my: e.clientY, left: p.left, top: p.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onDragMove(e: PointerEvent) {
    if (!dragStart) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    floatLeft = Math.max(0, Math.min(vw - panelW, dragStart.left + e.clientX - dragStart.mx));
    floatTop  = Math.max(0, Math.min(vh - 60,     dragStart.top  + e.clientY - dragStart.my));
    isSnapped = false;
  }

  function onDragUp() {
    if (!dragStart) return;
    dragStart = null;

    // Check proximity to each screen corner
    const vw = window.innerWidth, vh = window.innerHeight;
    const ph = panelEl?.offsetHeight ?? 300;
    const L = floatLeft, T = floatTop, R = floatLeft + panelW, B = floatTop + ph;

    if      (L <= SNAP_DIST && T <= TOP_MARGIN + SNAP_DIST)       { snappedCorner = 'top-left';     isSnapped = true; }
    else if (R >= vw - SNAP_DIST && T <= TOP_MARGIN + SNAP_DIST)  { snappedCorner = 'top-right';    isSnapped = true; }
    else if (L <= SNAP_DIST && B >= vh - BOTTOM_MARGIN - SNAP_DIST){ snappedCorner = 'bottom-left'; isSnapped = true; }
    else if (R >= vw - SNAP_DIST && B >= vh - BOTTOM_MARGIN - SNAP_DIST){ snappedCorner = 'bottom-right'; isSnapped = true; }
  }

  // ── Resize ───────────────────────────────────────────────────────────────

  type ResizeEdge = 'left' | 'right' | 'top' | 'bottom';

  let resizeStart = $state<{
    mx: number; my: number;
    edge: ResizeEdge;
    origW: number; origH: number;
    origLeft: number; origTop: number;
  } | null>(null);

  function onResizeDown(e: PointerEvent, edge: ResizeEdge) {
    e.preventDefault();
    e.stopPropagation();
    const p = currentPos();
    resizeStart = {
      mx: e.clientX, my: e.clientY, edge,
      origW: panelW,
      origH: panelEl?.offsetHeight ?? 300,
      origLeft: p.left, origTop: p.top
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onResizeMove(e: PointerEvent) {
    if (!resizeStart) return;
    const dx = e.clientX - resizeStart.mx;
    const dy = e.clientY - resizeStart.my;
    const { edge, origW, origH, origLeft, origTop } = resizeStart;

    if (edge === 'right') {
      panelW = Math.max(minWidth, Math.min(maxWidth, origW + dx));
    } else if (edge === 'left') {
      const newW = Math.max(minWidth, Math.min(maxWidth, origW - dx));
      if (!isSnapped) floatLeft = origLeft + (origW - newW);
      panelW = newW;
    } else if (edge === 'bottom') {
      panelH = Math.max(minHeight, origH + dy);
    } else if (edge === 'top') {
      const newH = Math.max(minHeight, origH - dy);
      if (!isSnapped) floatTop = origTop + (origH - newH);
      panelH = newH;
    }
  }

  function onResizeUp() { resizeStart = null; }

  // ── Which edges are active (face inward from snapped corner) ─────────────

  const edges = $derived.by((): { l: boolean; r: boolean; t: boolean; b: boolean } => {
    if (!isSnapped) return { l: true, r: true, t: true, b: true };
    switch (snappedCorner) {
      case 'top-left':     return { l: false, r: true,  t: false, b: true  };
      case 'top-right':    return { l: true,  r: false, t: false, b: true  };
      case 'bottom-left':  return { l: false, r: true,  t: true,  b: false };
      case 'bottom-right': return { l: true,  r: false, t: true,  b: false };
    }
  });

  // ── Inline style (position + size) ───────────────────────────────────────

  const panelStyle = $derived.by(() => {
    const parts: string[] = [`width: ${panelW}px`, `z-index: ${zIndex}`];

    // When snapped, always cap height so the panel never grows above TOP_MARGIN.
    // columnMaxH provides a tighter constraint when a partner panel shares the column.
    const viewportCap = isSnapped ? windowH - TOP_MARGIN - BOTTOM_MARGIN : null;
    const effectiveCap = columnMaxH !== null
      ? (viewportCap !== null ? Math.min(columnMaxH, viewportCap) : columnMaxH)
      : viewportCap;

    if (panelH !== null) {
      parts.push(`height: ${effectiveCap !== null ? Math.min(panelH, effectiveCap) : panelH}px`);
    } else if (effectiveCap !== null) {
      parts.push(`max-height: ${effectiveCap}px`);
    }
    if (!isSnapped) parts.push(`left: ${floatLeft}px`, `top: ${floatTop}px`);
    return parts.join('; ');
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="snap-panel"
  class:snapped-tl={isSnapped && snappedCorner === 'top-left'}
  class:snapped-tr={isSnapped && snappedCorner === 'top-right'}
  class:snapped-bl={isSnapped && snappedCorner === 'bottom-left'}
  class:snapped-br={isSnapped && snappedCorner === 'bottom-right'}
  style={extraStyle ? `${panelStyle}; ${extraStyle}` : panelStyle}
  bind:this={panelEl}
>
  <!-- Resize handles — on the inward-facing edges -->
  {#if edges.l}
    <div class="rh rh-w"
      onpointerdown={(e) => onResizeDown(e, 'left')}
      onpointermove={onResizeMove}
      onpointerup={onResizeUp}
    ></div>
  {/if}
  {#if edges.r}
    <div class="rh rh-e"
      onpointerdown={(e) => onResizeDown(e, 'right')}
      onpointermove={onResizeMove}
      onpointerup={onResizeUp}
    ></div>
  {/if}
  {#if edges.t}
    <div class="rh rh-n"
      onpointerdown={(e) => onResizeDown(e, 'top')}
      onpointermove={onResizeMove}
      onpointerup={onResizeUp}
    ></div>
  {/if}
  {#if edges.b}
    <div class="rh rh-s"
      onpointerdown={(e) => onResizeDown(e, 'bottom')}
      onpointermove={onResizeMove}
      onpointerup={onResizeUp}
    ></div>
  {/if}

  <!-- Header = drag handle. Shows custom header snippet or a default grip bar. -->
  <div
    class="snap-drag"
    onpointerdown={onDragDown}
    onpointermove={onDragMove}
    onpointerup={onDragUp}
    onpointerleave={onDragUp}
  >
    {#if header}
      {@render header()}
    {:else}
      <span class="grip-dots">· · ·</span>
    {/if}
  </div>

  <!-- Content -->
  <div class="snap-content">
    {@render children?.()}
  </div>
</div>

<style>
  .snap-panel {
    position: fixed;
    background: rgba(14, 14, 20, 0.94);
    backdrop-filter: blur(16px) saturate(140%);
    -webkit-backdrop-filter: blur(16px) saturate(140%);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
    /* max-height is computed dynamically in panelStyle to support column overlap detection */
    overflow: visible;
  }

  /* ── Corner positions ── */
  .snapped-tl { top: 60px;  left: 12px;  }
  .snapped-tr { top: 60px;  right: 12px; }
  .snapped-bl { bottom: 52px; left: 12px;  }
  .snapped-br { bottom: 52px; right: 12px; }

  /* ── Drag handle ── */
  .snap-drag {
    cursor: grab;
    user-select: none;
    flex-shrink: 0;
    border-radius: var(--rad) var(--rad) 0 0;
    overflow: hidden; /* clip header content to rounded corners */
  }
  .snap-drag:active { cursor: grabbing; }

  .grip-dots {
    display: block;
    text-align: center;
    font-size: 0.55rem;
    color: var(--muted);
    padding: 0.25rem;
    letter-spacing: 0.4em;
    opacity: 0.45;
    transition: opacity 0.15s;
  }
  .snap-drag:hover .grip-dots { opacity: 0.9; }

  /* ── Content area ── */
  .snap-content {
    overflow-y: auto;
    overflow-x: hidden;
    flex-shrink: 1;
    min-height: 0;
    border-radius: 0 0 var(--rad) var(--rad);
  }

  /* ── Resize handles ── */
  .rh {
    position: absolute;
    z-index: 2;
    border-radius: 3px;
    transition: background 0.12s;
  }
  .rh:hover, .rh:active { background: rgba(26, 155, 142, 0.3); }

  /* Vertical (left/right) edges */
  .rh-w { left: -4px;  top: 12px; bottom: 12px; width: 8px;  cursor: ew-resize; }
  .rh-e { right: -4px; top: 12px; bottom: 12px; width: 8px;  cursor: ew-resize; }
  /* Horizontal (top/bottom) edges */
  .rh-n { top: -4px;    left: 12px; right: 12px; height: 8px; cursor: ns-resize; }
  .rh-s { bottom: -4px; left: 12px; right: 12px; height: 8px; cursor: ns-resize; }

  /* ── Mobile: full-width panels ── */
  @media (max-width: 600px) {
    .snap-panel {
      /* Override inline width on mobile */
      width: calc(100vw - 1rem) !important;
      max-width: calc(100vw - 1rem) !important;
    }
    .snapped-tl, .snapped-tr { top: 52px; left: 0.5rem; right: 0.5rem; }
    .snapped-bl, .snapped-br { bottom: 52px; left: 0.5rem; right: 0.5rem; }
    .rh-w, .rh-e { display: none; } /* No horizontal resize on mobile */
  }
</style>
