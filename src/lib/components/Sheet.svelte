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

  // Swipe-down-to-dismiss (F36 mobile). Dragging the grabber/header pulls the
  // whole sheet down; releasing past a threshold closes it, otherwise it snaps
  // back. Interactive controls in the header (close button, header snippet
  // buttons) are excluded so taps still register.
  let contentEl = $state<HTMLElement | null>(null);
  let dragging = $state(false);
  let dragY = $state(0);
  let startY = 0;
  const CLOSE_PX = 100; // absolute px threshold
  const CLOSE_FRAC = 0.3; // ...or this fraction of sheet height, whichever is smaller

  function onDragStart(e: PointerEvent) {
    if (e.button != null && e.button > 0) return; // primary pointer only
    if ((e.target as HTMLElement | null)?.closest('button, a, input, textarea, select')) return;
    startY = e.clientY;
    dragY = 0;
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function onDragMove(e: PointerEvent) {
    if (!dragging) return;
    dragY = Math.max(0, e.clientY - startY); // downward only
  }
  function onDragEnd() {
    if (!dragging) return;
    dragging = false;
    const h = contentEl?.offsetHeight ?? 0;
    const shouldClose = dragY > Math.min(CLOSE_PX, h * CLOSE_FRAC);
    dragY = 0;
    if (shouldClose) {
      open = false;
      onOpenChange?.(false);
    }
  }
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay class="sheet-overlay" style="z-index: {zIndex};" />
    <Dialog.Content
      bind:ref={contentEl}
      class="sheet-content"
      style="z-index: {zIndex + 1}; transform: translateY({dragY}px); {dragging ? 'transition: none;' : ''}"
    >
      <!-- Draggable header: grab handle + title live in one cohesive zone so the
           whole top of the sheet reads as "pull down to close". Swipe is the
           primary dismiss; the close button is a subtle, integrated affordance
           kept for pointer/keyboard/screen-reader users. -->
      <div
        class="sheet-drag"
        onpointerdown={onDragStart}
        onpointermove={onDragMove}
        onpointerup={onDragEnd}
        onpointercancel={onDragEnd}
      >
        <div class="sheet-grabber" aria-hidden="true"></div>
        {#if header}
          <!-- Custom header; keep an a11y title for bits-ui/screen readers. -->
          <Dialog.Title class="sheet-sr-only">{title ?? 'Panel'}</Dialog.Title>
          <div class="sheet-header">{@render header()}</div>
        {:else}
          <div class="sheet-header">
            <Dialog.Title class="sheet-title">{title ?? 'Panel'}</Dialog.Title>
            <Dialog.Close class="sheet-close" aria-label="Close">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" />
              </svg>
            </Dialog.Close>
          </div>
        {/if}
      </div>
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
    /* Snap-back after a swipe that didn't cross the close threshold. Suppressed
       inline (transition:none) while a drag is in progress so the sheet tracks
       the finger 1:1. */
    transition: transform 0.2s cubic-bezier(0.32, 0.72, 0, 1);
  }
  @keyframes sheet-up {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.sheet-content) { animation: none; transition: none; }
  }
  .sheet-drag {
    flex: none;
    /* The finger owns vertical panning here — stop the browser from also
       scrolling the page/body while swiping the handle to dismiss. */
    touch-action: none;
    cursor: grab;
    padding-top: 6px;
  }
  .sheet-drag:active {
    cursor: grabbing;
  }
  /* Prominent grab handle — the primary "pull down to close" affordance. Brighter
     and a touch larger than a hairline so it reads as interactive; it subtly
     brightens while dragging. */
  .sheet-grabber {
    width: 40px;
    height: 5px;
    flex: none;
    margin: 6px auto 2px;
    background: var(--muted);
    opacity: 0.5;
    border-radius: 999px;
    transition: opacity 0.15s, width 0.15s;
  }
  .sheet-drag:hover .sheet-grabber,
  .sheet-drag:active .sheet-grabber {
    opacity: 0.9;
    width: 48px;
  }
  /* Integrated header: title flush with the sheet's padding, a hairline divider
     that only appears below it (separating chrome from body), no boxed strip. */
  .sheet-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex: none;
    padding: 0.35rem 0.75rem 0.6rem 1rem;
  }
  :global(.sheet-title) {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 0.8rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--accent);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Subtle, integrated close — a muted disc, not a bare mark. 44px hit area for
     the touch-targets rubric, but a small visual circle so swipe stays the star. */
  :global(.sheet-close) {
    min-width: 44px;
    min-height: 44px;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    border-radius: 999px;
    color: var(--muted);
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  :global(.sheet-close svg) {
    border-radius: 999px;
    padding: 6px;
    box-sizing: content-box;
  }
  :global(.sheet-close:hover),
  :global(.sheet-close:focus-visible) {
    background: var(--surface-3);
    color: var(--ink);
    outline: none;
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
