<script lang="ts">
  import { Tooltip } from 'bits-ui';
  import type { Snippet } from 'svelte';

  let {
    content,
    side = 'top',
    delayDuration = 300,
    pinnable = false,
    children,
  } = $props<{
    content: string | Snippet;
    side?: 'top' | 'bottom' | 'left' | 'right';
    delayDuration?: number;
    /** If true, clicking the trigger pins the tooltip open; click again to unpin. */
    pinnable?: boolean;
    children: Snippet;
  }>();

  let open = $state(false);
  let pinned = $state(false);

  function handleOpenChange(v: boolean) {
    if (!v && pinned) return; // keep open while pinned
    open = v;
  }

  function handleTriggerClick() {
    if (!pinnable) return;
    if (pinned) {
      pinned = false;
      open = false;
    } else {
      pinned = true;
      open = true;
    }
  }

  function handleInteractOutside(e: Event) {
    if (pinned) e.preventDefault();
  }
</script>

<Tooltip.Root bind:open onOpenChange={handleOpenChange} {delayDuration}>
  <Tooltip.Trigger onclick={handleTriggerClick} class="ui-tooltip-trigger" data-pinned={pinned || undefined}>
    {@render children()}
  </Tooltip.Trigger>

  <Tooltip.Portal>
    <Tooltip.Content
      class="ui-tooltip-content"
      {side}
      sideOffset={6}
      onInteractOutside={handleInteractOutside}
    >
      {#if typeof content === 'string'}
        {content}
      {:else}
        {@render content()}
      {/if}
      {#if pinnable && pinned}
        <button class="ui-tooltip-unpin" onclick={() => { pinned = false; open = false; }} aria-label="unpin tooltip">✕</button>
      {/if}
    </Tooltip.Content>
  </Tooltip.Portal>
</Tooltip.Root>

<style>
  :global(.ui-tooltip-trigger) {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
  }
  :global(.ui-tooltip-trigger[data-pinned]) {
    outline: 1px solid var(--accent);
    border-radius: var(--rad-sm);
  }

  :global(.ui-tooltip-content) {
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 0.5rem 0.75rem;
    font-size: 0.78rem;
    font-family: var(--font-mono);
    color: var(--fg);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    max-width: 280px;
    line-height: 1.5;
    z-index: 600;
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }

  :global(.ui-tooltip-unpin) {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 0.65rem;
    padding: 0;
    flex-shrink: 0;
    opacity: 0.6;
    line-height: 1;
    align-self: flex-start;
    margin-top: 1px;
  }
  :global(.ui-tooltip-unpin:hover) {
    color: var(--danger);
    opacity: 1;
  }
</style>
