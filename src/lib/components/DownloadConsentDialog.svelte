<script lang="ts">
  import { pendingConsent, resolveConsent } from '$lib/stores/download-consent.svelte';

  const pending = $derived(pendingConsent());

  function shortName(model: string): string {
    const parts = model.split('/');
    return parts[parts.length - 1] || model;
  }
</script>

{#if pending}
  <div class="consent-backdrop" role="presentation" onclick={() => resolveConsent(false)}>
    <div class="consent-dialog" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
      <p class="consent-title mono">download model?</p>
      <p class="consent-body">
        <strong>{shortName(pending.model)}</strong> needs to download
        <strong>~{pending.approxMB} MB</strong> on first use.
        The model is cached in your browser after download and works offline.
      </p>
      <div class="consent-actions">
        <button class="consent-btn primary" onclick={() => resolveConsent(true)}>
          Download ({pending.approxMB} MB)
        </button>
        <button class="consent-btn" onclick={() => resolveConsent(false)}>
          Not now
        </button>
      </div>
      <p class="consent-hint">
        You can also sideload models from disk in <a href="/settings/integrations#s-models">Settings</a>.
      </p>
    </div>
  </div>
{/if}

<style>
  .consent-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }
  .consent-dialog {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.5rem;
    max-width: 380px;
    width: 100%;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  }
  .consent-title {
    font-size: 0.85rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 0.75rem;
  }
  .consent-body {
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
    padding: 0.5rem 0.75rem;
    font-size: 0.8rem;
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
  .consent-hint a {
    color: var(--accent);
  }
</style>
