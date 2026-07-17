<script module lang="ts">
  /**
   * Module-level GLTF cache shared across all GraphNode instances.
   * Loads each URL once; every instance clones the scene so Three.js
   * parent-ownership rules are satisfied (Object3D can only have one parent).
   */
  import type * as THREE from 'three';

  const _gltfCache = new Map<string, Promise<THREE.Object3D>>();

  export async function loadGltfTemplate(url: string): Promise<THREE.Object3D> {
    if (!_gltfCache.has(url)) {
      const p = (async () => {
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
        const loader = new GLTFLoader();
        // Many GLBs (e.g. Meshy.ai exports) are Draco-compressed; wire a locally
        // served decoder (static/draco/, CSP-safe) or they load to nothing.
        const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js');
        const draco = new DRACOLoader();
        draco.setDecoderPath('/draco/gltf/');
        loader.setDRACOLoader(draco);
        return new Promise<THREE.Object3D>((resolve, reject) =>
          loader.load(url, (gltf) => resolve(gltf.scene), undefined, reject)
        );
      })();
      _gltfCache.set(url, p);
    }
    return _gltfCache.get(url)!;
  }
</script>

<script lang="ts">
  /**
   * GraphNode — single low-poly mesh bound to a Node object whose position is
   * mutated each frame by the parent's force simulation. Owning the mesh
   * ref locally and calling useTask here lets us write directly to
   * mesh.position rather than depending on Svelte to track Vector3 mutation.
   *
   * The geometry and base color can be driven by an EntityTypeDef so each
   * node type gets a distinct low-poly 3D icon.
   */
  import { T, useTask } from '@threlte/core';
  import { Color } from 'three';
  import type { Mesh, Group, Vector3 as Vec3 } from 'three';
  import { GEOMETRY_ARGS, UNKNOWN_TYPE, type EntityTypeDef, type GeometryName } from '$lib/rdf/entity-types';

  type Node = {
    key: string;
    label: string;
    kind: 'concept' | 'literal';
    pos: Vec3;
    degree: number;
  };

  let {
    node,
    typeDef = null,
    icon3dOverride = null,
    selected = false,
    highlighted = false,
    dimMode = false,
    focusHop = null,
    colorOverride = null,
    tripleRank = null,
    isLeapNode = false,
    onclick = () => {},
    onhover = () => {}
  } = $props<{
    node: Node;
    typeDef?: EntityTypeDef | null;
    /** Per-entity GLB URL — takes priority over typeDef.icon3d */
    icon3dOverride?: string | null;
    selected?: boolean;
    highlighted?: boolean;
    dimMode?: boolean;
    /** Hop distance from the focused node (null = not in focus mode) */
    focusHop?: number | null;
    /** Layout-assigned color (source cluster, hub cluster) — overrides type/default color */
    colorOverride?: string | null;
    /**
     * 0–1 normalized triple count within this node's type group.
     * 0 = fewest triples in type, 1 = most. Drives a subtle hue shift.
     */
    tripleRank?: number | null;
    /** True when this node bridges to another KB. Renders an orbiting ring. */
    isLeapNode?: boolean;
    onclick?: (e: { stopPropagation: () => void; ctrlKey?: boolean }) => void;
    onhover?: (key: string | null) => void;
  }>();

  // Thermal color gradient for focus mode: warm/bright (close) → cool/dim (far)
  const FOCUS_HOP_COLORS = ['', '#ff8c42', '#e8b84b', '#6dd3c4', '#3d7cf5', '#2a2a5a'];
  const FOCUS_HOP_EMISSIVE = [0, 0.80, 0.50, 0.30, 0.15, 0.05];
  function focusHopColor(hop: number): string {
    return FOCUS_HOP_COLORS[Math.min(hop, FOCUS_HOP_COLORS.length - 1)];
  }
  function focusHopEmissive(hop: number): number {
    return FOCUS_HOP_EMISSIVE[Math.min(hop, FOCUS_HOP_EMISSIVE.length - 1)];
  }

  /**
   * Scale saturation based on triple rank within the node's type group.
   * rank 0 (fewest) → desaturated/muted; rank 1 (most) → fully saturated.
   * Range: 35% → 100% of the base color's saturation.
   */
  function applyTripleRank(hex: string, rank: number): string {
    const c = new Color(hex);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    const satScale = 0.35 + rank * 0.65;
    c.setHSL(hsl.h, Math.min(hsl.s * satScale, 1.0), hsl.l);
    return '#' + c.getHexString();
  }

  function mutedVariant(hex: string): string {
    const c = new Color(hex);
    c.lerp(new Color('#0a0a10'), 0.80);
    return '#' + c.getHexString();
  }

  function vibrantVariant(hex: string): string {
    const c = new Color(hex);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    // Lift the highlight but keep its hue readable — a gentle saturation bump and a
    // modest lightness lift (capped well below white) so the tone survives rather
    // than washing out under the emissive glow.
    c.setHSL(hsl.h, Math.min(hsl.s * 1.12, 1.0), Math.min(hsl.l * 1.22, 0.68));
    return '#' + c.getHexString();
  }

  const baseColor = $derived.by(() => {
    const raw = colorOverride ?? typeDef?.color ?? (node.kind === 'concept' ? '#ff6b35' : '#6dd3c4');
    return tripleRank !== null ? applyTripleRank(raw, tripleRank) : raw;
  });

  let meshRef: Mesh | undefined = $state();
  let iconRef: Group | undefined = $state();
  let ringRef: Mesh | undefined = $state();

  useTask(() => {
    if (meshRef) meshRef.position.copy(node.pos);
    if (iconRef) { iconRef.position.copy(node.pos); iconRef.position.y += scale * 0.55; }
    if (ringRef) {
      ringRef.position.copy(node.pos);
      ringRef.scale.setScalar(scale * 1.6);
      ringRef.rotation.z += 0.006;
      const mat = ringRef.material as import('three').MeshBasicMaterial;
      mat.opacity = 0.35 + 0.25 * Math.sin(Date.now() * 0.0018);
    }
  });

  const degreeScale = $derived(0.85 + 0.45 * Math.log2(1 + node.degree));

  const scale = $derived.by(() => {
    if (selected) return Math.max(degreeScale, 1.0) * 1.6;
    if (highlighted) return Math.max(degreeScale, 1.0) * 1.3;
    if (focusHop !== null && focusHop > 0) return degreeScale * (focusHop === 1 ? 1.05 : 0.92);
    return degreeScale;
  });

  const geometry: GeometryName = $derived(typeDef?.geometry ?? (node.kind === 'concept' ? UNKNOWN_TYPE.geometry : 'sphere'));
  const geoArgs = $derived(GEOMETRY_ARGS[geometry]);

  // Effective 3D icon: per-entity override takes priority over type default
  const effectiveIcon3d = $derived(icon3dOverride || typeDef?.icon3d || null);

  // Per-instance cloned scene — loaded from module-level cache, cloned so each
  // node owns its own Object3D subtree (Three.js single-parent constraint).
  let gltfScene = $state<import('three').Object3D | null>(null);

  $effect(() => {
    const url = effectiveIcon3d;
    if (!url) { gltfScene = null; return; }
    let cancelled = false;
    loadGltfTemplate(url)
      .then(template => { if (!cancelled) gltfScene = template.clone(true); })
      .catch(() => { if (!cancelled) gltfScene = null; });
    return () => { cancelled = true; };
  });

  const focusDimmed = $derived(focusHop !== null && focusHop > 1);

  const color = $derived.by(() => {
    if (focusDimmed) return mutedVariant(baseColor);
    if (dimMode && !highlighted) return '#444444';
    if (highlighted) return vibrantVariant(baseColor);
    if (focusHop !== null && focusHop > 0) return focusHopColor(focusHop);
    if (colorOverride) return colorOverride;
    if (typeDef) return typeDef.color;
    return node.kind === 'concept' ? '#ff6b35' : '#6dd3c4';
  });

  const emissive = $derived.by(() => {
    if (focusDimmed) return mutedVariant(baseColor);
    if (dimMode && !highlighted) return '#222222';
    if (highlighted) return vibrantVariant(baseColor);
    if (focusHop !== null && focusHop > 0) return focusHopColor(focusHop);
    if (colorOverride) return colorOverride;
    return typeDef ? '#1a1a2e' : (node.kind === 'concept' ? '#5a1f0a' : '#1a4a44');
  });

  const emissiveIntensity = $derived.by(() => {
    if (selected) return 1.4;
    if (focusDimmed) return 0.15;
    if (highlighted) return 0.7; // gentle glow — enough to pop, not so bright it washes the hue to white
    if (dimMode) return 0;
    if (focusHop !== null && focusHop > 0) return focusHopEmissive(focusHop);
    return 0.55;
  });
</script>

{#if gltfScene}
  <!-- Cloned GLB scene — each instance owns its own Object3D clone -->
  <T.Group bind:ref={iconRef} scale={scale * 0.8}
    onclick={(e: any) => onclick({ stopPropagation: () => e.stopPropagation(), ctrlKey: e.ctrlKey })}
    onpointerenter={() => onhover(node.key)}
    onpointerleave={() => onhover(null)}>
    <T is={gltfScene} />
  </T.Group>
{/if}

<T.Mesh bind:ref={meshRef} scale={gltfScene ? 0.001 : scale} {onclick}
  onpointerenter={() => onhover(node.key)}
  onpointerleave={() => onhover(null)}
  rotation.x={geometry === 'tetrahedron-inv' ? Math.PI : 0}>
  {#if geometry === 'sphere'}
    <T.SphereGeometry args={geoArgs} />
  {:else if geometry === 'icosahedron'}
    <T.IcosahedronGeometry args={geoArgs} />
  {:else if geometry === 'capsule'}
    <T.CapsuleGeometry args={geoArgs} />
  {:else if geometry === 'torus'}
    <T.TorusGeometry args={geoArgs} />
  {:else if geometry === 'torus-knot'}
    <T.TorusKnotGeometry args={geoArgs} />
  {:else if geometry === 'cylinder'}
    <T.CylinderGeometry args={geoArgs} />
  {:else if geometry === 'cone'}
    <T.ConeGeometry args={geoArgs} />
  {:else if geometry === 'box' || geometry === 'box-flat'}
    <T.BoxGeometry args={geoArgs} />
  {:else if geometry === 'octahedron'}
    <T.OctahedronGeometry args={geoArgs} />
  {:else if geometry === 'tetrahedron'}
    <T.TetrahedronGeometry args={geoArgs} />
  {:else if geometry === 'tetrahedron-inv'}
    <T.TetrahedronGeometry args={geoArgs} />
  {:else if geometry === 'dodecahedron'}
    <T.DodecahedronGeometry args={geoArgs} />
  {:else}
    <T.IcosahedronGeometry args={[0.30, 0]} />
  {/if}
  <T.MeshStandardMaterial
    {color}
    {emissive}
    emissiveIntensity={emissiveIntensity}
    roughness={0.20}
    metalness={0.45}
    flatShading={true}
    transparent={focusHop === null || focusHop <= 3}
    opacity={focusHop !== null && focusHop > 3 ? 0.35 : 1.0}
  />
</T.Mesh>

{#if isLeapNode}
  <!-- Orbiting amber ring that marks this node as a Leap Node -->
  <T.Mesh bind:ref={ringRef} rotation.x={Math.PI / 2.5}>
    <T.TorusGeometry args={[1.0, 0.045, 6, 48]} />
    <T.MeshBasicMaterial color="#f59e0b" transparent opacity={0.5} depthWrite={false} />
  </T.Mesh>
{/if}
