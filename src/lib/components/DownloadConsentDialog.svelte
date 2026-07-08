<script lang="ts">
  /**
   * Model-download consent. Uses bits-ui Dialog (like ManualLLMModal) rather than
   * a hand-rolled div overlay — the custom overlay dropped tap/click events on
   * touch devices. bits-ui handles portal, focus trap, Escape, and touch
   * correctly and consistently.
   */
  import { Dialog } from 'bits-ui';
  import { pendingConsent, resolveConsent } from '$lib/stores/download-consent.svelte';

  const pending = $derived(pendingConsent());

  function shortName(model: string): string {
    const parts = model.split('/');
    return parts[parts.length - 1] || model;
  }
</script>

<Dialog.Root open={!!pending} onOpenChange={(o) => { if (!o) resolveConsent(false); }}>
  <Dialog.Portal>
    <Dialog.Overlay class="consent-overlay" />
    <Dialog.Content class="consent-dialog">
      {#if pending}
        <Dialog.Title class="consent-title mono">download model?</Dialog.Title>
        <Dialog.Description class="consent-body">
          <strong>{shortName(pending.model)}</strong> needs to download
          <strong>~{pending.approxMB} MB</strong> on first use.
          The model is cached in your browser after download and works offline.
        </Dialog.Description>
        <div class="consent-actions">
          <button type="button" class="consent-btn primary" onclick={() => resolveConsent(true)}>
            Download ({pending.approxMB} MB)
          </button>
          <button type="button" class="consent-btn" onclick={() => resolveConsent(false)}>
            Not now
          </button>
        </div>
        <p class="consent-hint">
          You can also sideload models from disk in <a href="/settings/integrations#s-models">Settings</a>.
        </p>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.consent-overlay) {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 600;
    backdrop-filter: blur(2px);
  }
  :global(.consent-dialog) {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    z-index: 601;
    width: calc(100vw - 2rem);
    max-width: 380px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.5rem;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  }
  :global(.consent-title) {
    font-size: 0.85rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 0.75rem;
  }
  :global(.consent-body) {
    display: block;
    font-size: 0.82rem;
    color: var(--ink-2);
    line-height: 1.5;
    margin: 0 0 1rem;
  }
  .consent-actions {
    display: flex;
    gap: 0.5rem;
  }
  .consent-btn {
    flex: 1;
    /* >= 44px touch target (kb:web-uiux-rubric) */
    min-height: 44px;
    padding: 0.6rem 0.75rem;
    font-size: 0.85rem;
    border-radius: var(--rad-sm);
    cursor: pointer;
    border: 1px solid var(--line);
    background: var(--surface-2);
    color: var(--ink-2);
    font-family: var(--font-mono);
    transition: background 0.12s;
  }
  .consent-btn:hover { background: var(--surface-3); }
  .consent-btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
  }
  .consent-btn.primary:hover { opacity: 0.9; }
  .consent-hint {
    font-size: 0.7rem;
    color: var(--muted);
    margin: 0.75rem 0 0;
    text-align: center;
  }
  .consent-hint a { color: var(--accent); }
</style>
