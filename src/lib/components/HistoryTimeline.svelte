<script lang="ts">
  import { db } from '$lib/storage/db';
  import type { ChangeLogEntry } from '$lib/storage/types';

  interface Props {
    onTimestampChange: (timestamp: number | null) => void;
  }

  let { onTimestampChange }: Props = $props();

  let entries = $state<ChangeLogEntry[]>([]);
  let loaded = $state(false);
  let firstTime = $state<number>(0);
  let lastTime = $state<number>(Date.now());
  let currentTimestamp = $state<number | null>(null);

  // Load changelog on mount
  $effect.root(() => {
    loadChangelog();
  });

  async function loadChangelog() {
    const allEntries = await db.changelog.toArray();
    if (allEntries.length === 0) {
      entries = [];
      loaded = true;
      return;
    }

    entries = allEntries.sort((a, b) => a.timestamp - b.timestamp);
    firstTime = Math.min(...entries.map((e) => e.timestamp));
    lastTime = Math.max(...entries.map((e) => e.timestamp));
    loaded = true;
  }

  function formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function handleSliderChange(e: Event) {
    const target = e.currentTarget as HTMLInputElement;
    const timestamp = parseInt(target.value, 10);
    currentTimestamp = timestamp;
    onTimestampChange(timestamp);
  }

  function handlePlayback() {
    // Step through events one by one
    if (entries.length === 0) return;
    let idx = 0;
    const interval = setInterval(() => {
      if (idx < entries.length) {
        currentTimestamp = entries[idx].timestamp;
        onTimestampChange(entries[idx].timestamp);
        idx++;
      } else {
        clearInterval(interval);
      }
    }, 500);
  }

  function handleReset() {
    currentTimestamp = null;
    onTimestampChange(null);
  }
</script>

<div class="history-timeline">
  {#if !loaded}
    <div class="loading">Loading history...</div>
  {:else if entries.length === 0}
    <div class="empty">No history yet. Statements will appear here as you make changes.</div>
  {:else}
    <div class="controls">
      <button class="btn-playback" on:click={handlePlayback} title="Playback events">
        ▶ Playback
      </button>
      <button class="btn-reset" on:click={handleReset} title="Return to present">
        ↻ Present
      </button>
    </div>

    <div class="timeline-display">
      <div class="time-labels">
        <span class="label-start">{formatTime(firstTime)}</span>
        <span class="label-current">
          {currentTimestamp ? formatTime(currentTimestamp) : 'Live'}
        </span>
        <span class="label-end">{formatTime(lastTime)}</span>
      </div>

      <input
        type="range"
        class="timeline-slider"
        min={firstTime}
        max={lastTime}
        value={currentTimestamp ?? lastTime}
        on:change={handleSliderChange}
      />
    </div>

    <div class="event-count">
      {entries.length} events recorded
    </div>
  {/if}
</div>

<style>
  .history-timeline {
    padding: var(--space-md);
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
  }

  .loading,
  .empty {
    padding: var(--space-md);
    text-align: center;
    color: var(--muted);
    font-size: 0.875rem;
  }

  .controls {
    display: flex;
    gap: var(--space-sm);
    margin-bottom: var(--space-md);
  }

  .btn-playback,
  .btn-reset {
    flex: 1;
    padding: var(--space-sm) var(--space-md);
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--text);
    border-radius: var(--rad-sm);
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 500;
    transition: all 0.15s ease-out;
  }

  .btn-playback:hover,
  .btn-reset:hover {
    background: var(--surface-3);
    border-color: var(--accent);
  }

  .timeline-display {
    margin-bottom: var(--space-md);
  }

  .time-labels {
    display: flex;
    justify-content: space-between;
    margin-bottom: var(--space-sm);
    font-size: 0.75rem;
    color: var(--muted);
  }

  .timeline-slider {
    width: 100%;
    height: 6px;
    border-radius: 3px;
    background: var(--line);
    outline: none;
    -webkit-appearance: none;
    appearance: none;
  }

  .timeline-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--accent);
    cursor: pointer;
    border: 2px solid var(--surface);
    box-shadow: 0 0 0 2px var(--accent);
  }

  .timeline-slider::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--accent);
    cursor: pointer;
    border: 2px solid var(--surface);
    box-shadow: 0 0 0 2px var(--accent);
  }

  .event-count {
    text-align: center;
    font-size: 0.8rem;
    color: var(--muted);
  }
</style>
