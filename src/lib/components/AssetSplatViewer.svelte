<script lang="ts">
  /**
   * Standalone Gaussian splat viewer for the large/fullscreen asset viewer (F58.9.2) — an orbitable,
   * slowly turning splat on its own Threlte canvas, the splat counterpart of AssetGlbViewer.
   */
  import { Canvas, T } from '@threlte/core';
  import { OrbitControls } from '@threlte/extras';
  import SplatLayer from '$lib/3d/SplatLayer.svelte';

  let { url }: { url: string } = $props();
  let status = $state<'loading' | 'ready' | 'failed'>('loading');
</script>

<div class="splat-viewer" data-splat-status={status}>
  <Canvas>
    <T.PerspectiveCamera makeDefault position={[0, 0.6, 3.2]} fov={45}>
      <OrbitControls enableDamping autoRotate autoRotateSpeed={1.2} target={[0, 0, 0]} />
    </T.PerspectiveCamera>
    <SplatLayer
      items={[{ key: 'asset', url, radius: 1 }]}
      onstatus={(loaded, failed) => (status = loaded ? 'ready' : failed ? 'failed' : 'loading')}
    />
  </Canvas>
  {#if status !== 'ready'}
    <p class="splat-status mono">{status === 'failed' ? 'This splat could not be loaded.' : 'Loading splat…'}</p>
  {/if}
</div>

<style>
  .splat-viewer { position: relative; width: 100%; height: 100%; }
  .splat-status {
    position: absolute; inset: auto 0 12px 0; margin: 0; text-align: center;
    font-size: 0.8rem; color: var(--text-muted, #9aa); pointer-events: none;
  }
</style>
