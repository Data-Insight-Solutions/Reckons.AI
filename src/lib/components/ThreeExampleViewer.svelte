<script lang="ts">
  import { onMount } from 'svelte';
  import { threeExampleUrl, THREE_EXAMPLE_LOAD_MS, THREE_EXAMPLE_HEARTBEAT_MS } from '$lib/3d/three-example';
  let { url }: { url: string } = $props();
  let frame = $state<HTMLIFrameElement>();
  let source = $state('');
  let phase = $state<'idle' | 'loading' | 'running' | 'stopped' | 'failed'>('idle');
  let error = $state('');
  let token = '';
  let started = 0;
  let heartbeat = 0;
  const canonical = $derived(threeExampleUrl(url));
  function stop(message = '') {
    // Removing the browsing context stops its timers, workers, and scene. No example code runs
    // in the graph's renderer. Browser/driver crashes remain beyond this isolation boundary.
    source = '';
    token = '';
    error = message;
    phase = message ? 'failed' : 'stopped';
  }
  function load() {
    if (!canonical) { stop('Only official WebGL and WebGPU example URLs are supported.'); return; }
    token = crypto.randomUUID();
    started = heartbeat = Date.now();
    error = '';
    phase = 'loading';
    source = `/three-example.html?example=${encodeURIComponent(canonical)}&token=${token}`;
  }
  onMount(() => {
    function receive(event: MessageEvent) {
      const data = event.data;
      if (!source || event.source !== frame?.contentWindow || !data || data.channel !== 'reckons-three-example' || data.token !== token) return;
      if (data.type === 'error') stop(typeof data.message === 'string' ? data.message.slice(0, 300) : 'The example failed.');
      if (data.type === 'heartbeat') heartbeat = Date.now();
      // The bridge observes a GPU draw/submit. A frame load event alone never marks it ready.
      if (data.type === 'rendered') { phase = 'running'; heartbeat = Date.now(); }
    }
    function foreground() { if (!document.hidden) { heartbeat = Date.now(); started = Date.now(); } }
    window.addEventListener('message', receive);
    document.addEventListener('visibilitychange', foreground);
    const watchdog = setInterval(() => {
      if (!source || document.hidden) return;
      const now = Date.now();
      if (phase === 'loading' && now - started > THREE_EXAMPLE_LOAD_MS) stop('The example did not render within 45 seconds. It may be incompatible or unable to load its assets.');
      else if (now - heartbeat > THREE_EXAMPLE_HEARTBEAT_MS) stop('The example stopped responding. It has been unloaded.');
    }, 1000);
    return () => { clearInterval(watchdog); window.removeEventListener('message', receive); document.removeEventListener('visibilitychange', foreground); };
  });
</script>

<section class="three-example-viewer" aria-label="Three.js example viewer">
  <div class="toolbar">
    <span role="status">{phase === 'loading' ? 'Loading example…' : phase === 'running' ? 'Example running' : 'Three.js example'}</span>
    {#if source}<button onclick={() => stop()}>Stop example</button>{/if}
  </div>
  {#if source}
    <iframe bind:this={frame} src={source} title="Interactive Three.js example" sandbox="allow-scripts" referrerpolicy="no-referrer"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; xr-spatial-tracking 'none'"
      onerror={() => stop('The example frame could not be loaded.')}></iframe>
  {:else}
    <div class="intro">
      {#if error}<p role="alert">{error}</p>{/if}
      {#if phase === 'stopped'}<p>Example stopped and unloaded.</p>{/if}
      <p>Load this interactive example from threejs.org? It runs third-party code and uses your device’s graphics hardware.</p>
      <p>Examples run in a sandbox with error and timeout handling. Some need unsupported assets or permissions. Browser and GPU-driver crashes cannot be fully contained.</p>
      <button onclick={load} disabled={!canonical}>{phase === 'failed' ? 'Retry example' : 'Load example'}</button>
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
