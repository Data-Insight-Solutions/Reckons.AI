<script lang="ts">
  import { db } from '$lib/storage/db';
  import { statements, sources } from '$lib/stores/kb.svelte';
  import type { Statement, Source } from '$lib/rdf/types';
  import { reconstructStatementsAt, reconstructSourcesAt } from '$lib/storage/history';
  // KnowledgeGraph2D (not the 3D KnowledgeGraph): the 3D component calls Threlte's
  // useDOM, which throws "can only be used in a child component to <Canvas>" unless
  // wrapped in <Canvas> — which /history was not, so the whole page failed to render
  // and stuck on the loading splash (fixed 2026-07-21). The 2D graph needs no Canvas
  // or WebGL, works headless, and explicitly supports history mode (historyTimestamp).
  import KnowledgeGraph2D from '$lib/3d/KnowledgeGraph2D.svelte';
  import HistoryTimeline from '$lib/components/HistoryTimeline.svelte';

  let historyTimestamp = $state<number | null>(null);
  let historyStatements = $state<Statement[]>([]);
  let historySources = $state<Source[]>([]);
  /** Facts with no arrival record — we cannot date them, so we say so rather than guess. */
  let undatedCount = $state(0);

  async function reconstructKBAtTime(timestamp: number | null) {
    // The reconstruction itself is pure and tested (storage/history.ts). This function
    // does the I/O and nothing else — that separation is what made two bugs findable:
    // deleted facts could never reappear, and trust scores used a stale copy of the maths.
    const [changelog, trustEvents] = await Promise.all([
      db.changelog.toArray(),
      db.trustEvents.toArray()
    ]);

    const rebuilt = reconstructStatementsAt(statements(), changelog, timestamp);
    historyStatements = rebuilt.statements;
    undatedCount = rebuilt.undated.length;
    historySources = reconstructSourcesAt(sources(), trustEvents, timestamp);
  }

  function handleTimestampChange(timestamp: number | null) {
    historyTimestamp = timestamp;
    reconstructKBAtTime(timestamp);
  }
</script>

<div class="history-page">
  <div class="header">
    <h1>Graph History</h1>
    <p>
      Scrub through past graph states. The graph shows the facts that existed at the selected
      time — including ones you have since deleted. Facts with no recorded arrival cannot be
      dated, and are counted rather than guessed at.
    </p>
  </div>

  <div class="content">
    <div class="sidebar">
      <HistoryTimeline onTimestampChange={handleTimestampChange} />
    </div>

    <div class="graph-container">
      {#if historyTimestamp}
        <div class="history-badge">
          History Mode: {new Date(historyTimestamp).toLocaleString()}
        </div>
        {#if undatedCount > 0}
          <!-- Say the gap out loud. These facts have no arrival record (seeded from TTL,
               or ingested before the changelog), so we cannot honestly place them in time
               — and we will not quietly assume them in or out of the past. -->
          <div class="undated-badge" title="No arrival record in the changelog, so these facts cannot be dated. They are excluded from the reconstruction rather than guessed at.">
            {undatedCount} fact{undatedCount === 1 ? '' : 's'} not shown — undateable
          </div>
        {/if}
      {/if}

      <KnowledgeGraph2D
        statements={historyStatements}
        sources={historySources}
        historyTimestamp={historyTimestamp}
      />
    </div>
  </div>
</div>

<style>
  .history-page {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  .header {
    padding: var(--space-lg);
    background: var(--surface);
    border-bottom: 1px solid var(--line);
  }

  .header h1 {
    margin: 0 0 var(--space-sm) 0;
    font-size: 1.5rem;
    color: var(--text);
  }

  .header p {
    margin: 0;
    color: var(--muted);
    font-size: 0.9rem;
  }

  .content {
    display: grid;
    grid-template-columns: 280px 1fr;
    flex: 1;
    overflow: hidden;
    gap: var(--space-md);
    padding: var(--space-md);
  }

  .sidebar {
    overflow-y: auto;
  }

  .graph-container {
    position: relative;
    overflow: hidden;
    border-radius: var(--rad-sm);
    border: 1px solid var(--line);
    background: var(--surface-2);
  }

  .history-badge {
    position: absolute;
    top: var(--space-md);
    left: var(--space-md);
    z-index: 10;
    padding: var(--space-sm) var(--space-md);
    background: rgba(26, 155, 142, 0.1);
    border: 1px solid var(--accent);
    border-radius: var(--rad-sm);
    color: var(--accent);
    font-size: 0.8rem;
    font-weight: 500;
  }

  .undated-badge {
    position: absolute;
    top: calc(var(--space-md) + 2.25rem);
    left: var(--space-md);
    z-index: 10;
    padding: var(--space-sm) var(--space-md);
    background: var(--surface);
    border: 1px dashed var(--line);
    border-radius: var(--rad-sm);
    color: var(--muted);
    font-size: 0.75rem;
    cursor: help;
  }

  @media (max-width: 900px) {
    .content {
      grid-template-columns: 1fr;
    }

    .sidebar {
      max-height: 200px;
      border-bottom: 1px solid var(--line);
      padding-bottom: var(--space-md);
    }
  }
</style>
