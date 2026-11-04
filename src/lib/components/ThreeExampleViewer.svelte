<script lang="ts">
  import { onMount } from 'svelte';
  import { threeExampleUrl } from '$lib/3d/three-example';
  import { ThreeExampleSession, THREE_EXAMPLE_SANDBOX, THREE_EXAMPLE_ALLOW } from '$lib/3d/three-example-session.svelte';
  let { url }: { url: string } = $props();
  let frame = $state<HTMLIFrameElement>();
  const session = new ThreeExampleSession(() => frame);
  const canonical = $derived(threeExampleUrl(url));
  onMount(() => session.watch());
</script>

<section class="three-example-viewer" aria-label="Three.js example viewer">
  <div class="toolbar">
    <span role="status">{session.phase === 'loading' ? 'Loading example…' : session.phase === 'running' ? 'Example running' : 'Three.js example'}</span>
    {#if session.source}<button onclick={() => session.stop()}>Stop example</button>{/if}
  </div>
  {#if session.source}
    <iframe bind:this={frame} src={session.source} title="Interactive Three.js example" sandbox={THREE_EXAMPLE_SANDBOX} referrerpolicy="no-referrer"
      allow={THREE_EXAMPLE_ALLOW} onerror={() => session.stop('The example frame could not be loaded.')}></iframe>
  {:else}
    <div class="intro">
      {#if session.error}<p role="alert">{session.error}</p>{/if}
      {#if session.phase === 'stopped'}<p>Example stopped and unloaded.</p>{/if}
      <p>Load this interactive example from threejs.org? It runs third-party code and uses your device’s graphics hardware.</p>
      <p>Examples run in a sandbox with error and timeout handling. Some need unsupported assets or permissions. Browser and GPU-driver crashes cannot be fully contained.</p>
      <button onclick={() => session.load(url)} disabled={!canonical}>{session.phase === 'failed' ? 'Retry example' : 'Load example'}</button>
      <a href={canonical ?? 'https://threejs.org/examples/'} target="_blank" rel="noopener noreferrer">View original ↗</a>
    </div>
  {/if}
</section>

<style>
  .three-example-viewer { width: 100%; height: 100%; min-height: 240px; display: flex; flex-direction: column; background: var(--surface); color: var(--ink); border-radius: 8px; overflow: hidden; }
  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: .5rem; padding: .65rem 4.5rem .65rem .75rem; font-size: .8rem; flex: 0 0 auto; }
  .intro { padding: 1rem; overflow: auto; font-size: .85rem; }
  p { margin: 0 0 1rem; line-height: 1.5; }
  iframe { flex: 1; width: 100%; min-height: 180px; border: 0; background: #171717; }
  button { padding: .4rem .65rem; background: var(--surface); color: var(--ink); border: 1px solid var(--accent); border-radius: 5px; cursor: pointer; }
  a { color: var(--accent); margin-left: .7rem; }
</style>
