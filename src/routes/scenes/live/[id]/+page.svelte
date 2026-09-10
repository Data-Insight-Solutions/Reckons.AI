<script lang="ts">
  import { onMount } from 'svelte';
  let { data } = $props();
  let host: HTMLDivElement;
  let failed = $state<string | null>(null);

  /**
   * Scenes are registered here rather than passed in through the URL. A page that evaluated
   * arbitrary source from a query string would be a script-injection hole reachable from any link,
   * and this frame is embedded in documentation that anyone can share.
   */
  const SCENES: Record<string, (T: typeof import('three'), scene: any, camera: any) => (t: number) => void> = {
    'graph-ring': (T, scene, camera) => {
      camera.position.set(0, 0, 6);
      scene.add(new T.AmbientLight(0xffffff, 0.55));
      const key = new T.DirectionalLight(0xffffff, 1.1);
      key.position.set(4, 5, 6);
      scene.add(key);
      const group = new T.Group();
      const nodes: any[] = [];
      const N = 9;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        const m = new T.Mesh(
          new T.IcosahedronGeometry(0.34, 2),
          new T.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.35, metalness: 0.1 }),
        );
        m.position.set(Math.cos(a) * 2.6, Math.sin(a) * 1.5, Math.sin(a * 2) * 0.6);
        group.add(m);
        nodes.push(m);
      }
      const edge = new T.LineBasicMaterial({ color: 0x8899aa, transparent: true, opacity: 0.55 });
      for (let i = 0; i < N; i++) {
        for (const j of [i + 1, i + 3]) {
          const g = new T.BufferGeometry().setFromPoints([nodes[i].position, nodes[j % N].position]);
          group.add(new T.Line(g, edge));
        }
      }
      scene.add(group);
      return (t: number) => { group.rotation.y = t * 0.0003; };
    },
  };

  onMount(() => {
    const build = SCENES[data.id];
    if (!build) { failed = `No scene named "${data.id}".`; return; }
    let raf = 0;
    let cleanup = () => {};
    (async () => {
      const T = await import('three');
      const scene = new T.Scene();
      const camera = new T.PerspectiveCamera(50, host.clientWidth / host.clientHeight, 0.1, 1000);
      const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.setSize(host.clientWidth, host.clientHeight);
      host.appendChild(renderer.domElement);
      const tick = build(T, scene, camera);
      // Motion is opt-out for anyone who has asked their system for less of it.
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const loop = (t: number) => { if (!still) tick(t); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);
      const onResize = () => {
        camera.aspect = host.clientWidth / host.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(host.clientWidth, host.clientHeight);
      };
      addEventListener('resize', onResize);
      cleanup = () => { cancelAnimationFrame(raf); removeEventListener('resize', onResize); renderer.dispose(); };
    })().catch((e) => { failed = String(e); });
    return () => cleanup();
  });
</script>

<svelte:head><title>Scene — {data.id}</title></svelte:head>

<div class="host" bind:this={host}>
  {#if failed}<p class="failed">{failed}</p>{/if}
</div>

<style>
  :global(html, body) { margin: 0; background: transparent; }
  .host { width: 100vw; height: 100vh; }
  .failed { font: 14px/1.5 system-ui, sans-serif; color: #b00; padding: 1rem; }
</style>
