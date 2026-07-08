<script lang="ts">
  /**
   * Sheet — a mobile bottom-sheet built on bits-ui Dialog (F36 phase 2).
   *
   * The adaptive counterpart to a floating desktop panel: full-width, anchored
   * to the bottom, slides up, dismiss on backdrop tap. Used by AdaptivePanel to
   * replace SnapPanel on compact viewports, where a px-positioned floating
   * window is unusable. Styling follows the Liquid theme tokens; bits-ui parts
   * are targeted with :global per the project convention.
   */
  import { Dialog } from 'bits-ui';
  import type { Snippet } from 'svelte';

  let {
    open = $bindable(false),
    onOpenChange,
    title,
    zIndex = 500,
    header,
    children,
  }: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Shown as the sheet title (and the a11y label). A `header` snippet overrides the visible row. */
    title?: string;
    zIndex?: number;
    header?: Snippet;
    children?: Snippet;
  } = $props();
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay class="sheet-overlay" style="z-index: {zIndex};" />
    <Dialog.Content class="sheet-content" style="z-index: {zIndex + 1};">
      <div class="sheet-grabber" aria-hidden="true"></div>
      {#if header}
        <!-- Custom header; keep an a11y title for bits-ui/screen readers. -->
        <Dialog.Title class="sheet-sr-only">{title ?? 'Panel'}</Dialog.Title>
        <div class="sheet-header">{@render header()}</div>
      {:else}
        <div class="sheet-header">
          <Dialog.Title class="sheet-title">{title ?? 'Panel'}</Dialog.Title>
          <Dialog.Close class="sheet-close" aria-label="Close">✕</Dialog.Close>
        </div>
      {/if}
      <div class="sheet-body">{@render children?.()}</div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.sheet-overlay) {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(3px);
  }
  :global(.sheet-content) {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border-top: 1px solid var(--line);
    border-radius: var(--rad-lg, 16px) var(--rad-lg, 16px) 0 0;
    box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.4);
    padding-bottom: env(safe-area-inset-bottom, 0);
    animation: sheet-up 0.22s cubic-bezier(0.32, 0.72, 0, 1);
  }
  @keyframes sheet-up {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.sheet-content) { animation: none; }
  }
  .sheet-grabber {
    width: 36px;
    height: 4px;
    flex: none;
    margin: 8px auto 4px;
    background: var(--line);
    border-radius: 999px;
  }
  .sheet-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    flex: none;
    padding: 0.25rem 1rem 0.5rem;
  }
  :global(.sheet-title) {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 0.95rem;
    color: var(--ink);
  }
  :global(.sheet-close) {
    /* >= 44px touch target (kb:web-uiux-rubric touch-targets) */
    min-width: 44px;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    border-radius: var(--rad-sm);
    color: var(--muted);
    font-size: 1.1rem;
    cursor: pointer;
  }
  :global(.sheet-close:hover) {
    background: var(--surface-3);
    color: var(--ink);
  }
  .sheet-body {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 0 1rem 1rem;
  }
  :global(.sheet-sr-only) {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
