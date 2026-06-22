<script lang="ts">
  import { getRegistry, type KbEntry } from '$lib/storage/kb-registry';

  let {
    selected = $bindable(new Set<string>()),
    excludeId = '',
    max = 0,
  }: {
    selected: Set<string>;
    excludeId?: string;
    max?: number;
  } = $props();

  const kbs = $derived(
    getRegistry().filter(k => k.id !== excludeId)
  );

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      if (max > 0 && next.size >= max) return;
      next.add(id);
    }
    selected = next;
  }
</script>

<div class="kb-picker">
  {#each kbs as kb (kb.id)}
    <button
      class="kp-chip"
      class:active={selected.has(kb.id)}
      onclick={() => toggle(kb.id)}
      disabled={!selected.has(kb.id) && max > 0 && selected.size >= max}
    >
      <span class="kp-dot" style="background:{kb.color ?? 'var(--accent)'}"></span>
      <span class="kp-name">{kb.name}</span>
      {#if kb.statementCount != null}
        <span class="kp-count">{kb.statementCount}</span>
      {/if}
    </button>
  {/each}
  {#if kbs.length === 0}
    <span class="kp-empty">no other KBs found</span>
  {/if}
</div>

<style>
  .kb-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .kp-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: none;
    font-family: var(--font-mono);
    font-size: 0.6rem;
    color: var(--muted);
    cursor: pointer;
    transition: all 0.1s;
    white-space: nowrap;
  }
  .kp-chip:hover { border-color: var(--accent); color: var(--ink); }
  .kp-chip.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }
  .kp-chip:disabled { opacity: 0.35; cursor: not-allowed; }
  .kp-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .kp-count {
    font-size: 0.5rem;
    opacity: 0.6;
  }
  .kp-empty {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    color: var(--muted);
  }
</style>
