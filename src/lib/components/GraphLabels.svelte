<script lang="ts">
  /**
   * Shared 3D node-label overlay (F92 — one canvas, no divergent renders).
   *
   * The main graph and /review both draw labels as fixed HTML overlays positioned from
   * viewport-space coords a graph component emits (onlabelsmove). They had drifted into two copies
   * — which is exactly why /review lost its 3D labels. This is the ONE overlay both mount.
   *
   * The CORE (positioning, the label span, and its hover/selected/dim styling) lives here so it can
   * never drift again. The RICH, page-specific bits — a node's asset thumbnail, a leap badge —
   * come in as snippets, rendered inside each label's wrapper, so a page keeps its own extras and
   * their styling (a snippet carries its parent's scope) without this component knowing about them.
   */
  import { fade } from 'svelte/transition';
  import type { Snippet } from 'svelte';

  interface NodeLabel {
    key: string;
    label: string;
    x: number;
    y: number;
    opacity: number;
  }

  let {
    labels = [],
    selected = null,
    hoverTarget = null,
    dimMode = false,
    highlightedSet = new Set<string>(),
    labelFontSize = 11,
    preview,
    after,
  } = $props<{
    labels: NodeLabel[];
    /** The selected node key — styled accent + scaled. */
    selected?: string | null;
    /** The hovered node key — styled bright + scaled. */
    hoverTarget?: string | null;
    /** When true, non-highlighted/non-selected/non-hovered labels fade out (focus mode). */
    dimMode?: boolean;
    highlightedSet?: Set<string>;
    labelFontSize?: number;
    /** Per-label extra rendered BEFORE the label (main uses it for the asset thumbnail). */
    preview?: Snippet<[NodeLabel]>;
    /** Per-label extra rendered AFTER the label (main uses it for the leap badge). */
    after?: Snippet<[NodeLabel]>;
  }>();
</script>

{#each labels as n (n.key)}
  <div
    class="node-label-wrap"
    transition:fade={{ duration: 220 }}
    style="transform: translate3d({n.x}px, {n.y}px, 0); --lfs: {labelFontSize}px; --lop: {n.opacity ?? 0.85};"
  >
    {@render preview?.(n)}
    <span
      class="node-label mono"
      class:hovered={n.key === hoverTarget}
      class:selected-node={n.key === selected}
      class:dim-hidden={dimMode && !highlightedSet.has(n.key) && n.key !== hoverTarget && n.key !== selected}
    >{n.label}</span>
    {@render after?.(n)}
  </div>
{/each}

<style>
  .node-label-wrap {
    position: fixed;
    left: 0;
    top: 0;
    pointer-events: none;
    z-index: 10;
    will-change: transform;
    transition: transform 35ms linear;
  }
  .node-label {
    display: block;
    transform: translate(-50%, calc(-100% - 5px));
    font-size: var(--lfs, 11px);
    font-weight: 700;
    /* --lop is the per-label distance opacity (0.25–0.85); base color alpha multiplied by it */
    color: rgba(232, 234, 240, calc(var(--lop, 0.85) * 0.85));
    white-space: nowrap;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.95), 0 0 6px rgba(0, 0, 0, 0.6);
    transition: transform 0.12s ease-out, color 0.18s ease-out, opacity 0.25s ease-out;
    letter-spacing: 0.02em;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  .node-label.dim-hidden {
    opacity: 0;
    pointer-events: none;
  }
  .node-label.hovered {
    color: rgba(232, 234, 240, 1);
    transform: translate(-50%, calc(-100% - 5px)) scale(1.8);
  }
  .node-label.selected-node {
    color: var(--accent);
    transform: translate(-50%, calc(-100% - 5px)) scale(1.6);
  }
</style>
