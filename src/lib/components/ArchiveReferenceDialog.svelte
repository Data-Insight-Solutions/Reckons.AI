<script lang="ts">
  import { onMount } from 'svelte';
  import { Dialog } from 'bits-ui';
  import {
    mountArchiveDecisionDialog,
    pendingArchiveDecision,
    resolveArchiveDecision,
  } from '$lib/stores/archive-decision.svelte';

  const pending = $derived(pendingArchiveDecision());
  const visibleReferences = $derived(pending?.references.slice(0, 6) ?? []);
  const hiddenCount = $derived(Math.max(0, (pending?.references.length ?? 0) - visibleReferences.length));

  onMount(() => mountArchiveDecisionDialog());
</script>

<Dialog.Root
  open={!!pending}
  onOpenChange={(open) => { if (!open) resolveArchiveDecision('cancel'); }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="archive-reference-overlay" />
    <Dialog.Content class="archive-reference-dialog">
      {#if pending}
        <Dialog.Title class="archive-reference-title mono">
          archived {pending.references.length === 1 ? 'entity' : 'entities'} mentioned
        </Dialog.Title>
        <Dialog.Description class="archive-reference-body">
          <strong>{pending.sourceTitle}</strong> refers to
          {pending.references.length === 1 ? ' something' : ` ${pending.references.length} things`}
          currently in this graph’s archive. Restore the existing
          {pending.references.length === 1 ? ' identity' : ' identities'} to avoid silently
          creating a duplicate.
        </Dialog.Description>

        <ul class="archive-reference-list" aria-label="Archived entities mentioned by this ingest">
          {#each visibleReferences as reference}
            <li>
              <span>{reference.label}</span>
              <code>{reference.entity}</code>
            </li>
          {/each}
          {#if hiddenCount > 0}
            <li class="more">and {hiddenCount} more…</li>
          {/if}
        </ul>

        <div class="archive-reference-actions">
          <button
            type="button"
            class="archive-reference-btn primary"
            onclick={() => resolveArchiveDecision('restore')}
          >
            Restore archived
          </button>
          <button
            type="button"
            class="archive-reference-btn"
            onclick={() => resolveArchiveDecision('keep-new')}
          >
            Keep as new
          </button>
          <button
            type="button"
            class="archive-reference-btn"
            onclick={() => resolveArchiveDecision('cancel')}
          >
            Cancel ingest
          </button>
        </div>

        <p class="archive-reference-hint">
          Restoring is journalled and reversible. New facts from this ingest still enter review as
          pending. “Keep as new” leaves the archived identity untouched and may create a duplicate.
        </p>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.archive-reference-overlay) {
    position: fixed;
    inset: 0;
    z-index: 620;
    background: rgba(0, 0, 0, 0.58);
    backdrop-filter: blur(2px);
  }

  :global(.archive-reference-dialog) {
    position: fixed;
    left: 50%;
    top: 50%;
    z-index: 621;
    width: calc(100vw - 2rem);
    max-width: 480px;
    max-height: calc(100vh - 2rem);
    overflow-y: auto;
    transform: translate(-50%, -50%);
    padding: 1.5rem;
    border: 1px solid var(--line);
    border-radius: var(--rad);
    background: var(--surface);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.34);
  }

  :global(.archive-reference-title) {
    margin: 0 0 0.75rem;
    color: var(--accent);
    font-size: 0.85rem;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  :global(.archive-reference-body) {
    display: block;
    margin: 0 0 1rem;
    color: var(--ink-2);
    font-size: 0.82rem;
    line-height: 1.5;
  }

  .archive-reference-list {
    display: grid;
    gap: 0.4rem;
    margin: 0 0 1rem;
    padding: 0;
    list-style: none;
  }

  .archive-reference-list li {
    display: grid;
    gap: 0.15rem;
    padding: 0.55rem 0.65rem;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    background: var(--surface-2);
  }

  .archive-reference-list span {
    color: var(--ink);
    font-size: 0.82rem;
  }

  .archive-reference-list code {
    overflow: hidden;
    color: var(--muted);
    font-size: 0.68rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .archive-reference-list .more {
    color: var(--muted);
    font-size: 0.72rem;
    text-align: center;
  }

  .archive-reference-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }

  .archive-reference-btn {
    min-height: 44px;
    padding: 0.6rem 0.75rem;
    cursor: pointer;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    background: var(--surface-2);
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: 0.8rem;
    transition: background 0.12s;
  }

  .archive-reference-btn:hover {
    background: var(--surface-3);
  }

  .archive-reference-btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
  }

  .archive-reference-btn.primary:hover {
    opacity: 0.9;
  }

  .archive-reference-btn:last-child {
    grid-column: 1 / -1;
  }

  .archive-reference-hint {
    margin: 0.75rem 0 0;
    color: var(--muted);
    font-size: 0.7rem;
    line-height: 1.45;
    text-align: center;
  }

  @media (max-width: 420px) {
    .archive-reference-actions {
      grid-template-columns: 1fr;
    }

    .archive-reference-btn:last-child {
      grid-column: auto;
    }
  }
</style>
