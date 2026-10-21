<script lang="ts">
  /**
   * A Three.js example as the graph background (kb:threejs-example-background).
   * Never loads by itself: the bar offers Load. The frame is the same sandboxed session the node
   * viewer uses. It has its own camera and depth, so nodes float in front of it, and it adds a
   * second scene to the GPU's work. Stop and the error/Retry state live in the bar, in the graph
   * view, so the person never has to open node details to get rid of it.
   * The page puts the `.three-bg-layer` behind the graph (z-index -1 in an isolated stage) and
   * lets pointer input through to the graph unless `interact` is on.
   */
  import { onMount } from 'svelte';
  import { ThreeExampleSession, THREE_EXAMPLE_SANDBOX, THREE_EXAMPLE_ALLOW } from '$lib/3d/three-example-session.svelte';

  let { url, interact = $bindable(false), live = $bindable(false) }: {
    url: string; interact?: boolean; live?: boolean;
  } = $props();
  let frame = $state<HTMLIFrameElement>();
  const session = new ThreeExampleSession(() => frame);
  const name = $derived(url.split('/').pop()?.replace('.html', '') ?? 'example');
  onMount(() => session.watch());
  // The page makes the graph see-through only while a frame exists, and input returns to the graph when it goes.
  $effect(() => { live = !!session.source; });
  $effect(() => { if (!session.source) interact = false; });
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && interact) interact = false; }} />

<div class="three-bg-layer" class:interactive={interact} aria-hidden={!interact}>
  {#if session.source}
    <iframe bind:this={frame} src={session.source} title="Three.js example background" sandbox={THREE_EXAMPLE_SANDBOX}
      referrerpolicy="no-referrer" allow={THREE_EXAMPLE_ALLOW}
      onerror={() => session.stop('The example frame could not be loaded.')}></iframe>
  {/if}
</div>

<div class="three-bg-bar mono" role="group" aria-label="Background example">
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
</div>

<style>
  .three-bg-layer { position: absolute; inset: 0; z-index: -1; pointer-events: none; }
  .three-bg-layer.interactive { pointer-events: auto; }
  iframe { width: 100%; height: 100%; border: 0; display: block; background: transparent; }
  .three-bg-layer:not(.interactive) iframe { pointer-events: none; }
  .three-bg-bar { position: absolute; left: 50%; top: 5.6rem; transform: translateX(-50%); z-index: 20;
    display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: .5rem; max-width: min(440px, calc(100% - 2rem));
    padding: .35rem .6rem; font-size: .72rem; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 6px; pointer-events: auto; }
  .state { overflow-wrap: anywhere; }
  button { padding: .3rem .5rem; min-height: 32px; border: 1px solid var(--accent); border-radius: 4px; color: var(--ink); background: var(--surface); cursor: pointer; font-size: .72rem; }
  button[aria-pressed='true'] { background: var(--accent); color: var(--surface); }
</style>
