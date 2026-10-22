<script lang="ts">
  /**
   * The state line and Load / Stop / Retry / Interact buttons for a Three.js example background.
   * Used by the on-graph bar and by the View settings panel, both reading ONE ThreeExampleSession,
   * so what one shows the other cannot contradict. `onclear` adds a Clear background button.
   */
  import type { ThreeExampleSession } from '$lib/3d/three-example-session.svelte';

  let { session, url, interact = $bindable(false), onclear }: {
    session: ThreeExampleSession; url: string; interact?: boolean; onclear?: () => void;
  } = $props();
  const name = $derived(url.split('/').pop()?.replace('.html', '') ?? 'example');
</script>

<span class="state" role="status">
  {#if session.phase === 'loading'}Loading {name}…
  {:else if session.phase === 'running'}Background running: {name}
  {:else if session.phase === 'failed'}<span role="alert">Background stopped: {session.error}</span>
  {:else}Background: {name}{/if}
</span>
{#if session.source}
  <button aria-pressed={interact} onclick={() => (interact = !interact)}
    title="Send mouse and touch input to the background instead of the graph. Escape or this button returns it.">Interact with background</button>
  <button onclick={() => session.stop()}>Stop</button>
{:else}
  <button onclick={() => session.load(url)}>{session.phase === 'failed' ? 'Retry' : 'Load'}</button>
{/if}
{#if onclear}<button onclick={onclear}>Clear background</button>{/if}

<style>
  .state { overflow-wrap: anywhere; }
  button { padding: .3rem .5rem; min-height: 32px; border: 1px solid var(--accent); border-radius: 4px; color: var(--ink); background: var(--surface); cursor: pointer; font-size: .72rem; }
  button[aria-pressed='true'] { background: var(--accent); color: var(--surface); }
</style>
