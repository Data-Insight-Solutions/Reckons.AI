<script lang="ts">
  import { suggestions, dismissSuggestion } from '$lib/stores/disambiguation.svelte';
  import { statements } from '$lib/stores/kb.svelte';

  let sugg = suggestions();
  $effect(() => {
    sugg = suggestions();
  });

  function getEntityLabel(entityKey: string): string {
    return entityKey.split('/').pop() || entityKey;
  }

  function getStatementCountFor(entityKey: string): number {
    const stmts = statements();
    return stmts.filter((s) => s.s.kind === 'iri' && s.s.value === entityKey).length;
  }

  function handleMerge(entityKeyA: string, entityKeyB: string) {
    // Trigger merge flow in parent — emit an event or set a signal
    window.dispatchEvent(
      new CustomEvent('merge-entities', {
        detail: { entityKeyA, entityKeyB }
      })
    );
  }

  function handleDismiss(id: string) {
    dismissSuggestion(id);
  }
</script>

{#if sugg.length > 0}
  <div class="disambiguation-panel">
    <div class="header">
      <h3>Potential Duplicates</h3>
      <p>Similar entity names detected. Review and merge if they're the same concept.</p>
    </div>

    <div class="suggestions">
      {#each sugg as s (s.id)}
        <div class="suggestion-card">
          <div class="entities">
            <div class="entity">
              <strong>{getEntityLabel(s.entityKeyA)}</strong>
              <span class="count">{getStatementCountFor(s.entityKeyA)} statements</span>
            </div>
            <div class="vs">vs</div>
            <div class="entity">
              <strong>{getEntityLabel(s.entityKeyB)}</strong>
              <span class="count">{getStatementCountFor(s.entityKeyB)} statements</span>
            </div>
          </div>

          <div class="similarity">
            Similarity: {(s.similarity * 100).toFixed(0)}%
          </div>

          <div class="actions">
            <button class="btn-merge" on:click={() => handleMerge(s.entityKeyA, s.entityKeyB)}>
              Merge
            </button>
            <button class="btn-dismiss" on:click={() => handleDismiss(s.id)}>
              Keep Separate
            </button>
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .disambiguation-panel {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: var(--space-lg);
    margin-bottom: var(--space-lg);
  }

  .header h3 {
    margin: 0 0 var(--space-sm) 0;
    font-size: 1rem;
    color: var(--text);
  }

  .header p {
    margin: 0;
    font-size: 0.875rem;
    color: var(--muted);
  }

  .suggestions {
    margin-top: var(--space-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .suggestion-card {
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: var(--space-md);
  }

  .entities {
    display: flex;
    align-items: center;
    gap: var(--space-md);
    margin-bottom: var(--space-md);
  }

  .entity {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }

  .entity strong {
    font-size: 0.95rem;
    color: var(--text);
  }

  .count {
    font-size: 0.8rem;
    color: var(--muted);
  }

  .vs {
    color: var(--muted);
    font-size: 0.9rem;
    flex-shrink: 0;
  }

  .similarity {
    font-size: 0.85rem;
    color: var(--data);
    margin-bottom: var(--space-md);
  }

  .actions {
    display: flex;
    gap: var(--space-sm);
  }

  .btn-merge,
  .btn-dismiss {
    flex: 1;
    padding: var(--space-sm) var(--space-md);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    transition: all 0.15s ease-out;
  }

  .btn-merge {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }

  .btn-merge:hover {
    background: var(--accent);
    color: var(--surface);
  }

  .btn-dismiss:hover {
    background: var(--surface-3);
  }
</style>
