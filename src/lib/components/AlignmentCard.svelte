<script lang="ts">
  import type { AlignmentSuggestion } from '$lib/rdf/cross-kb-align';
  import StatementCard from './StatementCard.svelte';

  let {
    suggestion,
    onaccept,
    onreject,
  }: {
    suggestion: AlignmentSuggestion;
    onaccept: () => void;
    onreject: () => void;
  } = $props();

  const kindLabel: Record<string, string> = {
    add: 'new',
    conflict: 'conflict',
    reinforce: 'reinforce',
    refine: 'refine',
  };
  const kindClass: Record<string, string> = {
    add: 'kind-add',
    conflict: 'kind-conflict',
    reinforce: 'kind-reinforce',
    refine: 'kind-refine',
  };
</script>

<div class="ac-card {kindClass[suggestion.kind] ?? ''}">
  <div class="ac-top">
    <span class="ac-kind mono">{kindLabel[suggestion.kind] ?? suggestion.kind}</span>
    <span class="ac-flow mono">
      <span class="ac-from">{suggestion.sourceKbName}</span>
      <span class="ac-arrow">→</span>
      <span class="ac-to">{suggestion.targetKbName}</span>
    </span>
  </div>

  <StatementCard statement={suggestion.statement} compact />

  {#if suggestion.entityMatch}
    <div class="ac-match mono">
      entity mapped: {suggestion.entityMatch.foreignLabel} ≈ {suggestion.entityMatch.activeLabel}
      <span class="ac-sim">({Math.round(suggestion.entityMatch.similarity * 100)}%)</span>
    </div>
  {/if}

  <div class="ac-actions">
    <button class="ac-accept" onclick={onaccept}>accept</button>
    <button class="ac-reject" onclick={onreject}>reject</button>
  </div>
</div>

<style>
  .ac-card {
    padding: 0.6rem;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .ac-card.kind-add { border-color: color-mix(in srgb, var(--data) 30%, var(--line)); }
  .ac-card.kind-conflict { border-color: color-mix(in srgb, var(--danger) 30%, var(--line)); }
  .ac-card.kind-reinforce { border-color: color-mix(in srgb, var(--ok) 30%, var(--line)); }
  .ac-card.kind-refine { border-color: color-mix(in srgb, var(--accent) 30%, var(--line)); }

  .ac-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .ac-kind {
    font-size: 0.55rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .kind-add .ac-kind { color: var(--data); }
  .kind-conflict .ac-kind { color: var(--danger); }
  .kind-reinforce .ac-kind { color: var(--ok); }
  .kind-refine .ac-kind { color: var(--accent); }

  .ac-flow {
    font-size: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.2rem;
    color: var(--muted);
  }
  .ac-from { color: var(--data); }
  .ac-to { color: var(--accent); }
  .ac-arrow { opacity: 0.5; }

  .ac-match {
    font-size: 0.55rem;
    color: var(--muted);
    background: var(--surface-2);
    padding: 0.2rem 0.4rem;
    border-radius: var(--rad-sm);
  }
  .ac-sim { opacity: 0.6; }

  .ac-actions {
    display: flex;
    gap: 0.35rem;
    margin-top: 0.1rem;
  }
  .ac-accept {
    padding: 0.25rem 0.55rem;
    border-radius: var(--rad-sm);
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.6rem;
    cursor: pointer;
  }
  .ac-reject {
    padding: 0.25rem 0.55rem;
    border-radius: var(--rad-sm);
    border: 1px solid var(--line);
    background: none;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.6rem;
    cursor: pointer;
  }
  .ac-reject:hover {
    border-color: var(--danger);
    color: var(--danger);
  }
</style>
