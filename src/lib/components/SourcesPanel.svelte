<script lang="ts">
  import { sources, statementsForSource, setSourceTrust, autoConfirmTrustedSources } from '$lib/stores/kb.svelte';
  import StatementCard from './StatementCard.svelte';

  let expandedSourceId: string | null = $state(null);
  let isAutoConfirming = $state(false);

  function toggleExpanded(id: string) {
    expandedSourceId = expandedSourceId === id ? null : id;
  }

  async function toggleTrust(id: string, trustLevel: 'trusted' | 'review') {
    await setSourceTrust(id, trustLevel);
  }

  async function handleAutoConfirm() {
    isAutoConfirming = true;
    try {
      await autoConfirmTrustedSources();
    } finally {
      isAutoConfirming = false;
    }
  }

  function getSourceStatementsCount(id: string): number {
    return statementsForSource(id).length;
  }

  function getPendingCount(id: string): number {
    return statementsForSource(id).filter(s => s.status === 'pending').length;
  }

  function getConfirmedCount(id: string): number {
    return statementsForSource(id).filter(s => s.status === 'confirmed' || s.status === 'refined').length;
  }
</script>

<div class="sources-panel">
  <div class="panel-header">
    <h3 class="panel-title mono">sources</h3>
    {#if sources().some(s => s.trustLevel === 'trusted')}
      <button class="auto-confirm-btn primary" onclick={handleAutoConfirm} disabled={isAutoConfirming}>
        {isAutoConfirming ? 'confirming...' : 'confirm trusted'}
      </button>
    {/if}
  </div>

  <div class="sources-list">
    {#each sources() as src (src.id)}
      <div class="source-item">
        <div
          class="source-header"
          role="button"
          tabindex="0"
          aria-expanded={expandedSourceId === src.id}
          aria-label="Toggle {src.title} details"
          onclick={() => toggleExpanded(src.id)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpanded(src.id); } }}
        >
          <div class="source-title">
            <span class="title-text">{src.title}</span>
            <span class="count-badge">{getSourceStatementsCount(src.id)}</span>
          </div>
          <div class="source-controls">
            <div class="trust-toggle">
              <button
                class="trust-btn"
                class:active={src.trustLevel === 'trusted'}
                onclick={(e) => {
                  e.stopPropagation();
                  toggleTrust(src.id, src.trustLevel === 'trusted' ? 'review' : 'trusted');
                }}
                title={src.trustLevel === 'trusted' ? 'Mark as review' : 'Mark as trusted'}
                aria-label={src.trustLevel === 'trusted' ? 'Mark as review' : 'Mark as trusted'}
              >
                ⭐
              </button>
            </div>
            <span class="expand-icon">{expandedSourceId === src.id ? '▼' : '▶'}</span>
          </div>
        </div>

        {#if expandedSourceId === src.id}
          <div class="source-details">
            <div class="stats">
              <span class="stat pending">
                <span class="stat-label">pending:</span>
                <span class="stat-value">{getPendingCount(src.id)}</span>
              </span>
              <span class="stat confirmed">
                <span class="stat-label">confirmed:</span>
                <span class="stat-value">{getConfirmedCount(src.id)}</span>
              </span>
              <span class="stat date">
                <span class="stat-label">ingested:</span>
                <span class="stat-value">{new Date(src.ingestedAt).toLocaleDateString()}</span>
              </span>
              {#if src.extractionModel}
                <span class="stat model" title="Extraction backend: {src.extractionBackend}">
                  <span class="stat-label">model:</span>
                  <span class="stat-value">{src.extractionModel}</span>
                </span>
              {/if}
            </div>

            <div class="statements-preview">
              {#each statementsForSource(src.id).slice(0, 3) as st (st.id)}
                <StatementCard statement={st} compact showGraph={false} />
              {/each}
              {#if statementsForSource(src.id).length > 3}
                <p class="more-statements">+{statementsForSource(src.id).length - 3} more...</p>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .sources-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    height: 100%;
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--line);
  }

  .panel-title {
    font-size: 0.85rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin: 0;
  }

  .auto-confirm-btn {
    font-size: 0.7rem;
    padding: 0.35rem 0.6rem;
  }

  .sources-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    overflow-y: auto;
    flex: 1;
  }

  .source-item {
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    background: var(--surface-2);
    overflow: hidden;
  }

  .source-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 0.75rem;
    cursor: pointer;
    transition: background 0.15s;
  }

  .source-header:hover {
    background: var(--surface-3);
  }

  .source-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
  }

  .title-text {
    font-size: 0.8rem;
    color: var(--ink-2);
    font-weight: 500;
  }

  .count-badge {
    font-size: 0.65rem;
    color: var(--muted);
    background: var(--surface);
    padding: 0.15rem 0.35rem;
    border-radius: var(--rad-sm);
  }

  .source-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .trust-toggle {
    display: flex;
  }

  .trust-btn {
    background: none;
    border: none;
    padding: 0.25rem;
    cursor: pointer;
    font-size: 0.9rem;
    opacity: 0.5;
    transition: opacity 0.15s;
  }

  .trust-btn.active {
    opacity: 1;
  }

  .trust-btn:hover {
    opacity: 0.8;
  }

  .expand-icon {
    font-size: 0.6rem;
    color: var(--muted);
  }

  .source-details {
    padding: 0.75rem;
    border-top: 1px solid var(--line);
    background: var(--surface);
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    font-size: 0.7rem;
  }

  .stat {
    display: flex;
    gap: 0.35rem;
    padding: 0.25rem 0.5rem;
    background: var(--surface-2);
    border-radius: var(--rad-sm);
  }

  .stat-label {
    color: var(--muted);
  }

  .stat-value {
    color: var(--ink-2);
    font-weight: 500;
  }

  .stat.pending .stat-value {
    color: #ffb74d;
  }

  .stat.confirmed .stat-value {
    color: var(--ok);
  }

  .stat.date .stat-value {
    color: var(--data);
  }

  .stat.model {
    max-width: 100%;
  }

  .stat.model .stat-value {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.62rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 180px;
  }

  .statements-preview {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .more-statements {
    font-size: 0.65rem;
    color: var(--muted);
    text-align: center;
    margin: 0.35rem 0 0;
    padding: 0.25rem 0;
  }
</style>
