<script lang="ts">
  /**
   * Standalone GLB/3D asset viewer for the large/fullscreen asset viewer — an
   * orbitable, auto-rotating model on its own threlte canvas. Reuses the shared
   * GLTF loader/cache from GraphNode so models load once.
   */
  import { Canvas, T } from '@threlte/core';
  import { OrbitControls } from '@threlte/extras';
  import { loadGltfTemplate } from './GraphNode.svelte';
  import { Box3, Vector3 } from 'three';

  let { url }: { url: string } = $props();

  let scene = $state<import('three').Object3D | null>(null);
  let dist = $state(3);

  $effect(() => {
    let cancelled = false;
    scene = null;
    loadGltfTemplate(url)
      .then((template) => {
        if (cancelled) return;
        const s = template.clone(true);
        // Center at the origin and frame the camera to the model's size.
        const box = new Box3().setFromObject(s);
        const center = box.getCenter(new Vector3());
        const size = box.getSize(new Vector3());
        s.position.sub(center);
        dist = (Math.max(size.x, size.y, size.z) || 1) * 2.4;
        scene = s;
      })
      .catch(() => { scene = null; });
    return () => { cancelled = true; };
  });
</script>

<Canvas>
  <T.PerspectiveCamera makeDefault position={[0, dist * 0.25, dist]} fov={45}>
    <OrbitControls enableDamping autoRotate autoRotateSpeed={1.4} target={[0, 0, 0]} />
  </T.PerspectiveCamera>
  <T.AmbientLight intensity={1.3} />
  <T.DirectionalLight position={[6, 8, 6]} intensity={1.6} />
  <T.DirectionalLight position={[-6, -2, -4]} intensity={0.5} />
  {#if scene}
    <T is={scene} />
  {/if}
</Canvas>
