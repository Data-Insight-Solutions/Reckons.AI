<script lang="ts">
  import {
    pendingManualPrompt,
    submitManualLLMResponse,
    cancelManualLLM,
  } from '$lib/stores/manual-llm.svelte';
  import { Dialog } from 'bits-ui';

  let response = $state('');
  let copied = $state(false);
  let parseError = $state('');

  const prompt = $derived(pendingManualPrompt());

  async function copyPrompt() {
    if (!prompt) return;
    await navigator.clipboard.writeText(prompt);
    copied = true;
    setTimeout(() => { copied = false; }, 2000);
  }

  function submit() {
    if (!response.trim()) {
      parseError = 'Paste the LLM response before clicking Process.';
      return;
    }
    parseError = '';
    const text = response.trim();
    response = '';
    submitManualLLMResponse(text);
  }

  function cancel() {
    response = '';
    parseError = '';
    cancelManualLLM();
  }


</script>

<Dialog.Root open={!!prompt} onOpenChange={(o) => { if (!o) cancel(); }}>
  <Dialog.Portal>
    <Dialog.Overlay class="manual-llm-overlay" />
    <Dialog.Content class="manual-llm-modal" aria-describedby="manual-llm-desc">
      <div class="modal-header">
        <Dialog.Title class="modal-title">Paste into any LLM</Dialog.Title>
        <Dialog.Close class="close-btn" aria-label="Cancel">✕</Dialog.Close>
      </div>

      <Dialog.Description id="manual-llm-desc" class="sub">
        Copy the prompt below and paste it into
        <strong>Claude.ai</strong>, <strong>ChatGPT</strong>, <strong>Gemini</strong>,
        or any LLM. Then paste the JSON response into the box beneath it.
        No API key or billing needed.
      </Dialog.Description>

      <div class="prompt-section">
        <div class="section-header">
          <span class="lbl mono">prompt to copy</span>
          <button class="copy-btn mono" onclick={copyPrompt}>
            {copied ? '✓ copied!' : 'copy prompt'}
          </button>
        </div>
        <pre class="prompt-pre">{prompt}</pre>
      </div>

      <div class="response-section">
        <label class="lbl mono" for="manual-response">paste response here</label>
        <textarea
          id="manual-response"
          class="response-area"
          bind:value={response}
          placeholder="Paste the JSON array from the LLM here"
          rows="7"
          spellcheck="false"
        ></textarea>
        {#if parseError}
          <p class="parse-error">{parseError}</p>
        {/if}
      </div>

      <div class="modal-actions">
        <button class="primary" onclick={submit} disabled={!response.trim()}>
          Process Response
        </button>
        <button onclick={cancel}>Cancel</button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.manual-llm-overlay) {
    position: fixed;
    inset: 0;
    z-index: 9998;
    background: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(4px);
  }

  :global(.manual-llm-modal) {
    position: fixed;
    left: 50%;
    top: 50%;
    translate: -50% -50%;
    z-index: 9999;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad-lg, 12px);
    padding: 1.5rem;
    width: calc(100% - 2rem);
    max-width: 680px;
    max-height: 90dvh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  }

  :global(.manual-llm-modal:focus) { outline: none; }

  :global(.manual-llm-modal .modal-title) {
    margin: 0;
    font-size: 1.1rem;
    font-family: var(--font-display);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .modal-header h2 {
    margin: 0;
    font-size: 1.1rem;
    font-family: var(--font-display);
  }

  :global(.manual-llm-modal .close-btn) {
    background: none;
    border: none;
    color: var(--muted);
    font-size: 1rem;
    cursor: pointer;
    padding: 0.2rem 0.4rem;
    border-radius: var(--rad-sm);
    transition: color 0.12s;
  }
  :global(.manual-llm-modal .close-btn:hover) { color: var(--ink); }

  :global(.manual-llm-modal .sub) {
    color: var(--muted);
    font-size: 0.83rem;
    line-height: 1.5;
    margin: 0;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.4rem;
  }

  .lbl {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
  }

  .copy-btn {
    font-size: 0.7rem;
    padding: 0.25rem 0.7rem;
    background: var(--accent-soft, rgba(26,155,142,0.12));
    border: 1px solid var(--accent);
    border-radius: 999px;
    color: var(--accent);
    cursor: pointer;
    transition: background 0.12s;
  }
  .copy-btn:hover { background: var(--accent); color: #fff; }

  .prompt-pre {
    background: var(--surface-2, #1c2230);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.75rem 0.9rem;
    font-family: var(--font-mono, monospace);
    font-size: 0.72rem;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
    margin: 0;
    color: var(--ink-2, #c8ccd8);
  }

  .response-section {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .response-area {
    width: 100%;
    background: var(--surface-2, #1c2230);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    color: var(--ink);
    font-family: var(--font-mono, monospace);
    font-size: 0.78rem;
    line-height: 1.5;
    padding: 0.65rem 0.8rem;
    resize: vertical;
    transition: border-color 0.12s;
  }
  .response-area:focus {
    outline: none;
    border-color: var(--accent);
  }

  .parse-error {
    color: var(--danger, #ef4444);
    font-size: 0.75rem;
    margin: 0;
  }

  .modal-actions {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  button:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
