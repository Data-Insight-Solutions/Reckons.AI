<script lang="ts">
  /**
   * VoiceInput — SUPERSEDED by ShellyVoice.svelte.
   * NOT YET IMPLEMENTED. Kept as architectural reference only.
   *
   * This was the original voice-to-text stub. The active voice interface
   * is ShellyVoice.svelte which uses the Hume EVI SDK directly.
   *
   * See ROADMAP.md F5 for current voice interface status.
   */

  import { settings } from '$lib/stores/settings.svelte';
  import type { ExtractedTriple } from '$lib/integrations/llm/extractor';

  let isRecording = $state(false);
  let isProcessing = $state(false);
  let transcript = $state('');
  let transcribedTriples = $state<ExtractedTriple[]>([]);
  let error = $state('');

  async function startRecording() {
    error = '';
    isRecording = true;
    transcript = '';
    transcribedTriples = [];

    try {
      // TODO: Implement Hume.AI voice streaming
      // 1. Initialize Hume voice client with API key
      // 2. Start audio capture (browser getUserMedia)
      // 3. Stream to Hume.AI speech-to-text endpoint
      // 4. Collect transcript events
      // 5. On stop, process final transcript through extractor

      // Placeholder: show API key requirement
      if (!settings().humeAiApiKey) {
        error = 'Hume.AI API key not configured. Add it in settings.';
        isRecording = false;
        return;
      }

      console.log('[VoiceInput] Recording started — awaiting Hume.AI integration');
      // await recordAndTranscribe();
    } catch (e) {
      error = (e as Error).message || 'Recording failed';
      isRecording = false;
    }
  }

  function stopRecording() {
    isRecording = false;
    // TODO: Stop audio stream and finalize Hume.AI session
  }

  async function processTranscript() {
    if (!transcript.trim()) return;

    isProcessing = true;
    error = '';

    try {
      // TODO: Feed transcript through existing semantic extractor
      // const { extractWithClaude } = await import('$lib/integrations/llm/claude');
      // const triples = await extractWithClaude(transcript, 'voice-input', {});
      // transcribedTriples = triples;

      console.log('[VoiceInput] Would extract triples from:', transcript);
    } catch (e) {
      error = (e as Error).message || 'Extraction failed';
    } finally {
      isProcessing = false;
    }
  }

  function clearTranscript() {
    transcript = '';
    transcribedTriples = [];
    error = '';
  }
</script>

<div class="voice-input">
  <div class="voice-controls">
    {#if !isRecording && !transcript}
      <button class="voice-btn primary" onclick={startRecording}>
        🎤 start recording
      </button>
    {:else if isRecording}
      <button class="voice-btn danger" onclick={stopRecording}>
        ⏹ stop recording
      </button>
      <p class="recording-indicator">●●● recording...</p>
    {/if}
  </div>

  {#if transcript}
    <div class="transcript-preview">
      <p class="transcript-label mono">transcript:</p>
      <p class="transcript-text">{transcript}</p>
      <div class="transcript-actions">
        <button class="btn-small primary" onclick={processTranscript} disabled={isProcessing}>
          {isProcessing ? 'extracting...' : 'extract terms'}
        </button>
        <button class="btn-small" onclick={clearTranscript}>clear</button>
      </div>
    </div>
  {/if}

  {#if transcribedTriples.length > 0}
    <div class="extracted-triples">
      <p class="triples-label mono">extracted:</p>
      {#each transcribedTriples as triple (triple.subject + triple.predicate + triple.object)}
        <div class="triple-item">
          <span class="triple-subject">{triple.subject}</span>
          <span class="triple-predicate">{triple.predicate}</span>
          <span class="triple-object">{triple.object}</span>
          {#if triple.confidence}
            <span class="triple-confidence">{(triple.confidence * 100).toFixed(0)}%</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if error}
    <div class="error-message">{error}</div>
  {/if}
</div>

<style>
  .voice-input {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.75rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad);
  }

  .voice-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .voice-btn {
    padding: 0.5rem 0.85rem;
    font-size: 0.8rem;
    flex: 1;
  }

  .voice-btn.danger {
    background: var(--danger);
    border-color: var(--danger);
    color: white;
  }

  .voice-btn.danger:hover {
    opacity: 0.9;
  }

  .recording-indicator {
    font-size: 0.7rem;
    color: var(--danger);
    margin: 0;
    animation: pulse 1s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  .transcript-preview {
    padding: 0.6rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
  }

  .transcript-label {
    font-size: 0.65rem;
    color: var(--muted);
    margin: 0 0 0.4rem;
  }

  .transcript-text {
    font-size: 0.8rem;
    color: var(--ink-2);
    margin: 0 0 0.5rem;
    line-height: 1.4;
    max-height: 100px;
    overflow-y: auto;
  }

  .transcript-actions {
    display: flex;
    gap: 0.4rem;
  }

  .btn-small {
    padding: 0.3rem 0.5rem;
    font-size: 0.7rem;
    flex: 1;
  }

  .extracted-triples {
    padding: 0.6rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
  }

  .triples-label {
    font-size: 0.65rem;
    color: var(--muted);
    margin: 0 0 0.4rem;
  }

  .triple-item {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.3rem 0;
    font-size: 0.7rem;
    flex-wrap: wrap;
  }

  .triple-subject {
    color: var(--accent);
    font-weight: 500;
  }

  .triple-predicate {
    color: var(--muted);
    font-style: italic;
  }

  .triple-object {
    color: var(--data);
  }

  .triple-confidence {
    color: var(--muted);
    font-size: 0.65rem;
    margin-left: auto;
  }

  .error-message {
    padding: 0.5rem;
    background: var(--danger);
    color: white;
    border-radius: var(--rad-sm);
    font-size: 0.75rem;
  }
</style>
