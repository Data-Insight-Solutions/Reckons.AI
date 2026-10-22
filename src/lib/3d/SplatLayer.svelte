<script lang="ts" module>
  import type * as THREE_NS from 'three';
  export type SplatItem = {
    /** Stable identity (a node key, or 'background'). */
    key: string;
    url: string;
    /** World radius the splat is scaled to. */
    radius: number;
    opacity?: number;
    /** Axis convention of the file (default: TripoSplat's). A reconstructed room uses 'none'. */
    orientation?: 'triposplat' | 'none';
    /** Read every frame; the splat follows it (a node's live position). Omitted = origin. */
    position?: () => THREE_NS.Vector3 | undefined;
    /** Keep the file's own scale (one file unit = one world unit, times the group's scale) instead of normalising to `radius`. */
    keepScale?: boolean;
    /** Extra rotation [x,y,z,w] applied over the file's own orientation; read every frame. */
    quaternion?: () => [number, number, number, number] | undefined;
    /** Radians per second about the vertical axis. */
    spin?: number;
    /** Read every frame: a world radius that overrides `radius` (e.g. sized to the graph). */
    size?: () => number;
    /** F58.9.13: write a depth-only proxy so markers and edges behind this splat are hidden. Entity splats only; a background room never opts in. */
    occludes?: boolean;
    /** Node splats: held back when over NODE_SPLAT_STARTUP_BUDGET, until splatDemand.request(key). Never the background. */
    deferrable?: boolean;
  };
</script>

<script lang="ts">
  /**
   * Draws Gaussian splats into the enclosing Threlte scene (F58.9.2 / F58.9.3): one
   * GaussianSplatRenderer for the scene, one normalised splat per item. Used by the 3D graph (node
   * splats and the space background) and by AssetSplatViewer (one splat, orbitable).
   *
   * Loading is lazy and per item; an item that fails to load is simply absent, so the node keeps its
   * ordinary marker. Splats are never raycast, so graph picking and hover are unchanged.
   */
  import * as THREE from 'three';
  import { useTask, useThrelte } from '@threlte/core';
  import { onDestroy } from 'svelte';
  import { loadSplatLib, createNormalizedSplat } from './splat';
  import { occluderRadius } from './splat-occlusion';
  import { overStartupBudget, readSplatGaussianCount } from './splat-budget';
  import { splatDemand } from '$lib/stores/splat-demand.svelte';

  let { items, onstatus, onloadedkeys }: {
    items: SplatItem[];
    onstatus?: (loaded: number, failed: number) => void;
    /** The keys whose splat is loaded and drawn, so a caller can stop drawing what it replaces. */
    onloadedkeys?: (keys: Set<string>) => void;
  } = $props();
  let loadedKeys = $state(new Set<string>());
  $effect(() => onloadedkeys?.(loadedKeys));

  const { renderer, scene } = useThrelte();
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  type Live = { url: string; radius: number; orientation?: string; keepScale?: boolean; group?: THREE.Group; inner?: THREE.Group; mesh?: { opacity: number }; baseQuaternion?: THREE.Quaternion; baseScale?: number; dispose?: () => void; failed?: boolean };
  const live = new Map<string, Live>();
  // F58.9.13: one shared unit sphere; BackSide so only the far hemisphere writes depth and the splat
  // (in front of it) is not clipped. colorWrite off: it paints nothing. Drawn first (renderOrder < 0).
  const proxyGeometry = new THREE.SphereGeometry(1, 20, 14);
  const proxyMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true, side: THREE.BackSide });
  const proxies: Record<string, THREE.Mesh> = {};
  // Reachable from tests and devtools: the proxies, so a check can switch them off and compare.
  scene.userData.splatOccluders = proxies;
  let splatRenderer: (THREE.Object3D & { dispose(): void }) | null = null;
  let destroyed = false;
  let loaded = $state(0);
  let failed = $state(0);

  $effect(() => onstatus?.(loaded, failed));

  // On-demand loading: per key, true = over the startup budget (wait to be asked), false = load now.
  // Absent = the header has not been read yet. Keyed by url too, so a replaced file is re-measured.
  let budgetVerdict = $state<Record<string, { url: string; over: boolean }>>({});
  const measuring = new Set<string>();
  function measure(item: SplatItem) {
    const id = item.key + '\n' + item.url;
    if (measuring.has(id)) return;
    measuring.add(id);
    void readSplatGaussianCount(item.url).then((count) => {
      if (destroyed) return;
      const over = overStartupBudget(count);
      if (over && count !== undefined) { splatDemand.deferred.add(item.key); splatDemand.counts.set(item.key, count); }
      budgetVerdict = { ...budgetVerdict, [item.key]: { url: item.url, over } };
    });
  }

  async function ensureRenderer() {
    if (splatRenderer) return;
    const { GaussianSplatRenderer } = await loadSplatLib();
    if (destroyed || splatRenderer) return;
    splatRenderer = new GaussianSplatRenderer({ renderer: renderer as never }) as never;
    scene.add(splatRenderer!);
  }

  $effect(() => {
    const wanted = new Map(items.map((i) => [i.key, i]));
    for (const [key, l] of live) {
      const w = wanted.get(key);
      if (!w || w.url !== l.url || w.radius !== l.radius || w.orientation !== l.orientation || w.keepScale !== l.keepScale) {
        l.dispose?.();
        live.delete(key);
        if (loadedKeys.has(key)) { const next = new Set(loadedKeys); next.delete(key); loadedKeys = next; }
      }
    }
    for (const k of [...splatDemand.deferred]) if (!wanted.has(k)) { splatDemand.deferred.delete(k); splatDemand.counts.delete(k); }
    for (const item of items) {
      if (live.has(item.key)) continue;
      if (item.deferrable && !splatDemand.requested.has(item.key)) {
        const v = budgetVerdict[item.key];
        if (!v || v.url !== item.url) { measure(item); continue; }
        if (v.over) continue;
      }
      splatDemand.deferred.delete(item.key);
      const entry: Live = { url: item.url, radius: item.radius, orientation: item.orientation, keepScale: item.keepScale };
      live.set(item.key, entry);
      (async () => {
        try {
          await ensureRenderer();
          const made = await createNormalizedSplat(THREE, item.url, item.radius, { opacity: item.opacity, orientation: item.orientation, keepScale: item.keepScale });
          if (destroyed || live.get(item.key) !== entry) { made.dispose(); return; }
          entry.group = made.group;
          entry.inner = made.inner;
          entry.mesh = made.mesh;
          entry.baseQuaternion = made.baseQuaternion;
          entry.baseScale = made.group.scale.x;
          entry.dispose = made.dispose;
          scene.add(made.group);
          loaded++;
          loadedKeys = new Set([...loadedKeys, item.key]);
        } catch (e) {
          entry.failed = true;
          failed++;
          console.warn(`[splat] could not load ${item.url}:`, e);
        }
      })();
    }
  });

  useTask((delta) => {
    for (const item of items) {
      const l = live.get(item.key);
      const g = l?.group;
      if (!g) continue;
      if (item.size && l.baseScale) g.scale.setScalar((l.baseScale * item.size()) / item.radius);
      const p = item.position?.();
      if (p) g.position.copy(p);
      if (item.occludes) {
        let proxy = proxies[item.key];
        if (!proxy) {
          proxy = new THREE.Mesh(proxyGeometry, proxyMaterial);
          proxy.renderOrder = -10;
          proxy.raycast = () => {}; // never a picking target
          proxy.frustumCulled = false;
          proxies[item.key] = proxy;
          scene.add(proxy);
        }
        proxy.position.copy(g.position);
        const pr = occluderRadius(item.size ? item.size() : item.radius);
        proxy.scale.x = proxy.scale.y = proxy.scale.z = pr;
      }
      // Settings change live without reloading the file.
      if (item.opacity !== undefined && l.mesh && l.mesh.opacity !== item.opacity) l.mesh.opacity = item.opacity;
      const q = item.quaternion?.();
      if (q && l.inner && l.baseQuaternion) l.inner.quaternion.set(q[0], q[1], q[2], q[3]).multiply(l.baseQuaternion);
      // Reduced motion stops the slow turn (an F58.9.3 gap).
      if (item.spin && !still) g.rotation.y += item.spin * delta;
    }
  });

  // A proxy goes when its item stops occluding or is gone/replaced.
  $effect(() => {
    const keep = items.filter((i) => i.occludes && loadedKeys.has(i.key)).map((i) => i.key);
    for (const [k, m] of Object.entries(proxies)) if (!keep.includes(k)) { scene.remove(m); delete proxies[k]; }
  });

  onDestroy(() => {
    destroyed = true;
    splatDemand.reset();
    for (const [k, m] of Object.entries(proxies)) { scene.remove(m); delete proxies[k]; }
    delete scene.userData.splatOccluders;
    proxyGeometry.dispose();
    proxyMaterial.dispose();
    for (const l of live.values()) l.dispose?.();
    live.clear();
    if (splatRenderer) { scene.remove(splatRenderer); splatRenderer.dispose(); }
  });
</script>
