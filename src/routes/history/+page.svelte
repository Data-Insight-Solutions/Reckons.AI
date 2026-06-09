<script lang="ts">
  import { db } from '$lib/storage/db';
  import { statements, sources } from '$lib/stores/kb.svelte';
  import type { Statement, Source } from '$lib/rdf/types';
  import type { TrustEvent } from '$lib/storage/types';
  import KnowledgeGraph from '$lib/3d/KnowledgeGraph.svelte';
  import HistoryTimeline from '$lib/components/HistoryTimeline.svelte';

  let historyTimestamp = $state<number | null>(null);
  let historyStatements = $state<Statement[]>([]);
  let historySources = $state<Source[]>([]);

  async function reconstructKBAtTime(timestamp: number | null) {
    if (timestamp === null) {
      // Show current state
      historyStatements = statements();
      historySources = sources();
      return;
    }

    // Reconstruct KB at timestamp
    // Statements: added before T, not deleted before T
    const allStmts = statements();
    const reconstructed: Statement[] = [];

    for (const st of allStmts) {
      // Check if statement was added before T
      const addLog = await db.changelog
        .where('statementId')
        .equals(st.id)
        .filter((e) => e.action === 'add' || e.action === 'ingest')
        .first();

      if (!addLog || addLog.timestamp > timestamp) {
        continue; // Not added yet at T
      }

      // Check if statement was deleted before T
      const deleteLog = await db.changelog
        .where('statementId')
        .equals(st.id)
        .filter((e) => e.action === 'delete')
        .first();

      if (deleteLog && deleteLog.timestamp <= timestamp) {
        continue; // Was deleted before T
      }

      reconstructed.push(st);
    }

    // Reconstruct trust scores
    const allSources = sources();
    const reconstructedSources = await Promise.all(
      allSources.map(async (src) => {
        const trustEvents = await db.trustEvents
          .where('sourceId')
          .equals(src.id)
          .filter((e) => e.timestamp <= timestamp)
          .toArray();

        // Recalculate trustScore at this time with decay
        let score = 0;
        for (const ev of trustEvents) {
          const ageDays = (timestamp - ev.timestamp) / (1000 * 60 * 60 * 24);
          const decayFactor = Math.exp(-0.01 * ageDays);
          score += ev.delta * decayFactor;
        }
        score = Math.max(0, Math.min(1, score));

        return { ...src, trustScore: score };
      })
    );

    historyStatements = reconstructed;
    historySources = reconstructedSources;
  }

  function handleTimestampChange(timestamp: number | null) {
    historyTimestamp = timestamp;
    reconstructKBAtTime(timestamp);
  }
</script>

<div class="history-page">
  <div class="header">
    <h1>Knowledge Base History</h1>
    <p>
      Scrub through past KB states. The graph shows only statements that existed at the selected time.
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
      {/if}

      <KnowledgeGraph
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
