<script lang="ts">
  import { supportsWorkspace } from '$lib/stores/workspace.svelte';
  import { openRunnerPopup } from '$lib/stores/runner-popup.svelte';
  import { generationJobs as gen } from '$lib/stores/generation-jobs.svelte';

  /**
   * The local generation runner's state and the one connect control, wherever the person already is
   * (Shelly's replies, her job list). Same store and connect flow as the Generated assets story, so
   * generation is not story-mode only. `compact` drops the setup sentence for the job list.
   */
  let { compact = false }: { compact?: boolean } = $props();
  const ready = $derived(!!gen.capabilities?.stages.some(x => x.available));
  const state = $derived(gen.connecting ? 'connecting' : ready ? 'connected' : gen.capabilities ? 'needs install' : 'not connected');
  const label = $derived(state === 'connected' ? 'Local generation runner: connected' : state === 'connecting' ? 'Local generation runner: connecting…' : state === 'needs install' ? 'Local generation: connected, no service installed yet' : 'Local generation runner: not connected');
</script>

<div class="runner-connect" data-runner-state={state}>
  <span class="runner-state" role="status">{label}</span>
  {#if state !== 'connected'}
    {#if supportsWorkspace()}
      <button class="sm" onclick={openRunnerPopup} disabled={gen.connecting}>Connect workspace folder</button>
    {:else}
      <span class="runner-help">Needs a browser with workspace folder access, such as desktop Chrome or Edge.</span>
    {/if}
    {#if !compact}
      <span class="runner-help">Start the agent watcher on your generation machine with <code>npm run agent:watch</code>, then connect its generation folder
        (<a href="/docs/features/generation-setup" target="_blank" rel="noopener noreferrer">setup guide</a>).</span>
    {/if}
    {#if gen.connectionError}<span class="runner-help">{gen.connectionError}</span>{/if}
  {/if}
</div>

<style>
  .runner-connect { display: flex; flex-wrap: wrap; gap: 0.35rem 0.5rem; align-items: center; margin: 0.35rem 0; font-size: 0.78rem; }
  .runner-state { font-family: var(--font-mono); font-size: 0.72rem; color: var(--accent); }
  .runner-help { flex-basis: 100%; color: var(--text-muted, var(--muted)); line-height: 1.4; overflow-wrap: anywhere; }
  code { font: 0.72rem var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
  .sm { padding: 0.25rem 0.6rem; font-size: 0.72rem; border: 1px solid var(--line, currentColor); border-radius: 0.4rem; background: var(--surface-2, transparent); color: inherit; cursor: pointer; font-family: inherit; }
  .sm:disabled { opacity: 0.5; cursor: default; }
</style>
