<script lang="ts">
  /**
   * AdaptivePanel — one panel, two presentations (F36 phase 2).
   *
   * Desktop  → SnapPanel (draggable, corner-snapping floating window).
   * Compact  → Sheet (bottom sheet), because a px-positioned floating window is
   *            unusable on a phone/tablet.
   *
   * Chooses at render time from the viewport store (isCompact = mobile OR
   * tablet). `open` controls visibility on BOTH surfaces: on compact it drives
   * the sheet open/close; on desktop `open === false` simply unmounts the panel.
   * Migrate a floating SnapPanel by swapping the tag and giving it an `open`
   * source (a toggle button for the compact case).
   */
  import type { Snippet } from 'svelte';
  import { isCompact } from '$lib/stores/viewport.svelte';
  import SnapPanel from './SnapPanel.svelte';
  import Sheet from './Sheet.svelte';

  type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

  let {
    open = $bindable(true),
    onOpenChange,
    title,
    corner = 'bottom-right' as Corner,
    width = 320,
    zIndex = 300,
    header,
    children,
  }: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Sheet title / a11y label (compact only; on desktop supply a `header`). */
    title?: string;
    corner?: Corner;
    width?: number;
    zIndex?: number;
    header?: Snippet;
    children?: Snippet;
  } = $props();
</script>

{#if isCompact()}
  <Sheet bind:open {onOpenChange} {title} zIndex={Math.max(zIndex, 500)} {header} {children} />
{:else if open}
  <SnapPanel {corner} {width} {zIndex} {header} {children} />
{/if}
