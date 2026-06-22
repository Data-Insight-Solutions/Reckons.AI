<script lang="ts">
  /**
   * OverlayScene — 3D force-directed multi-graph Venn visualization.
   * Entities are positioned by physics that anchor each node toward
   * the 3D centroid of its member projects. Multi-membership nodes
   * use blended colors. Project nodes orbit in a ring.
   */
  import { T, useTask } from '@threlte/core';
  import { OrbitControls } from '@threlte/extras';
  import * as THREE from 'three';
  import type { GraphDef, OverlayNode, OverlayEdge } from '$lib/rdf/multi-graph-parse';
  import { MEMBERSHIP_PREDICATES, isProjectIri } from '$lib/rdf/multi-graph-parse';

  let {
    graphs = [],
    nodes = new Map() as Map<string, OverlayNode>,
    edges = [] as OverlayEdge[],
    activeGraphIds = new Set() as Set<string>,
    activePredicates = new Set() as Set<string>,
  } = $props<{
    graphs: GraphDef[];
    nodes: Map<string, OverlayNode>;
    edges: OverlayEdge[];
    activeGraphIds: Set<string>;
    activePredicates: Set<string>;
  }>();

  // ── Types ──────────────────────────────────────────────────────────────────
  type ONode = {
    key: string;
    label: string;
    isProject: boolean;
    colors: string[];
    memberCount: number;
    pos: THREE.Vector3;
    vel: THREE.Vector3;
    anchorX: number;
    anchorY: number;
    anchorZ: number;
    degree: number;
  };
  type OEdge = { a: ONode; b: ONode };

  // ── State ──────────────────────────────────────────────────────────────────
  let onodes: ONode[] = [];
  let oedges: OEdge[] = [];
  let lineGeom: THREE.BufferGeometry | undefined = $state();
  const meshGroup = new THREE.Group();
  const labelGroup = new THREE.Group();
  const MAX_EDGES = 1500;
  const linePositions = new Float32Array(MAX_EDGES * 6);

  // Project anchor positions in 3D circle (XZ plane, slightly elevated)
  function computeProjectAnchors(): Map<string, { x: number; y: number; z: number }> {
    const active = graphs.filter((g: GraphDef) => activeGraphIds.has(g.id));
    const n = active.length;
    if (n === 0) return new Map();
    const R = Math.max(10, n * 2.5);
    const map = new Map<string, { x: number; y: number; z: number }>();
    active.forEach((g: GraphDef, i: number) => {
      const theta = (2 * Math.PI * i) / n - Math.PI / 2;
      map.set(g.id, { x: R * Math.cos(theta), y: 0, z: R * Math.sin(theta) });
    });
    return map;
  }

  // Blend multiple hex colors
  function blendColors(colors: string[]): string {
    if (colors.length === 0) return '#555555';
    if (colors.length === 1) return colors[0];
    let r = 0, g = 0, b = 0;
    for (const c of colors) {
      const hex = c.replace('#', '');
      r += parseInt(hex.slice(0, 2), 16);
      g += parseInt(hex.slice(2, 4), 16);
      b += parseInt(hex.slice(4, 6), 16);
    }
    const n = colors.length;
    const toH = (v: number) => Math.round(v / n).toString(16).padStart(2, '0');
    return `#${toH(r)}${toH(g)}${toH(b)}`;
  }

  // Darken a color for emissive
  function darkenColor(hex: string): string {
    const c = hex.replace('#', '');
    const r = Math.round(parseInt(c.slice(0, 2), 16) * 0.15);
    const g = Math.round(parseInt(c.slice(2, 4), 16) * 0.15);
    const b = Math.round(parseInt(c.slice(4, 6), 16) * 0.15);
    const toH = (v: number) => v.toString(16).padStart(2, '0');
    return `#${toH(r)}${toH(g)}${toH(b)}`;
  }

  function createNodeGeometry(isProject: boolean, memberCount: number): THREE.BufferGeometry {
    if (isProject) return new THREE.DodecahedronGeometry(0.55, 0);
    if (memberCount > 3) return new THREE.IcosahedronGeometry(0.35, 0);
    if (memberCount > 1) return new THREE.OctahedronGeometry(0.38);
    return new THREE.TetrahedronGeometry(0.34);
  }

  function createNodeMaterial(blended: string): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color: blended,
      emissive: darkenColor(blended),
      emissiveIntensity: 0.6,
      roughness: 0.22,
      metalness: 0.45,
      flatShading: true
    });
  }

  // Create a sprite label for project nodes
  function createLabel(text: string, color: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    canvas.width = 512;
    canvas.height = 64;
    ctx.clearRect(0, 0, 512, 64);
    ctx.font = 'bold 32px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text.length > 24 ? text.slice(0, 22) + '..' : text, 256, 32);

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.9, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(8, 1, 1);
    return sprite;
  }

  function buildGraph() {
    // Clean up existing meshes
    for (const child of [...meshGroup.children]) {
      (child as THREE.Mesh).geometry?.dispose();
      ((child as THREE.Mesh).material as THREE.Material)?.dispose();
      meshGroup.remove(child);
    }
    for (const child of [...labelGroup.children]) {
      ((child as THREE.Sprite).material as THREE.SpriteMaterial)?.map?.dispose();
      ((child as THREE.Sprite).material as THREE.SpriteMaterial)?.dispose();
      labelGroup.remove(child);
    }
    onodes = [];
    oedges = [];

    const projectAnchors = computeProjectAnchors();
    const graphColorMap = new Map<string, string>(graphs.map((g: GraphDef) => [g.id, g.color]));

    // Filter edges by active predicates and graphs
    const visibleEdges = edges.filter((e: OverlayEdge) => {
      if (!activePredicates.has(e.predicateIri)) return false;
      for (const gid of e.graphIds) {
        if (activeGraphIds.has(gid)) return true;
      }
      return false;
    });

    // Collect visible node keys
    const visibleKeys = new Set<string>();
    for (const e of visibleEdges) {
      visibleKeys.add(e.sourceKey);
      visibleKeys.add(e.targetKey);
    }
    for (const [key, node] of nodes) {
      for (const gid of node.membership) {
        if (activeGraphIds.has(gid)) { visibleKeys.add(key); break; }
      }
    }

    // Build nodes
    const nodeMap = new Map<string, ONode>();

    for (const key of visibleKeys) {
      const node = nodes.get(key);
      if (!node) continue;

      const activeMem = [...node.membership].filter(gid => activeGraphIds.has(gid));
      const isPrj = isProjectIri(key);
      if (activeMem.length === 0 && !isPrj) continue;

      // Anchor = centroid of member project positions in 3D
      let ax = 0, ay = 0, az = 0, anchorCount = 0;
      if (isPrj) {
        const pa = projectAnchors.get(activeMem[0] ?? '');
        if (pa) { ax = pa.x; ay = pa.y; az = pa.z; anchorCount = 1; }
      } else {
        for (const gid of activeMem) {
          const pa = projectAnchors.get(gid);
          if (pa) { ax += pa.x; ay += pa.y; az += pa.z; anchorCount++; }
        }
        if (anchorCount > 0) { ax /= anchorCount; ay /= anchorCount; az /= anchorCount; }
      }

      const colors = activeMem.map(gid => graphColorMap.get(gid) ?? '#888');

      nodeMap.set(key, {
        key,
        label: node.label,
        isProject: isPrj,
        colors: colors.length > 0 ? colors : ['#555'],
        memberCount: activeMem.length,
        pos: new THREE.Vector3(
          ax + (Math.random() - 0.5) * 3,
          ay + (Math.random() - 0.5) * 3,
          az + (Math.random() - 0.5) * 3
        ),
        vel: new THREE.Vector3(),
        anchorX: ax, anchorY: ay, anchorZ: az,
        degree: 0
      });
    }

    // Build edges — exclude membership predicates (shown via color)
    const filteredEdges = visibleEdges
      .filter((e: OverlayEdge) => !MEMBERSHIP_PREDICATES.has(e.predicateIri))
      .filter((e: OverlayEdge) => nodeMap.has(e.sourceKey) && nodeMap.has(e.targetKey));

    for (const e of filteredEdges) {
      const a = nodeMap.get(e.sourceKey)!;
      const b = nodeMap.get(e.targetKey)!;
      a.degree++;
      b.degree++;
      oedges.push({ a, b });
    }

    onodes = [...nodeMap.values()];

    // Create meshes
    for (const n of onodes) {
      const geo = createNodeGeometry(n.isProject, n.memberCount);
      const blended = blendColors(n.colors);
      const mat = createNodeMaterial(blended);
      const scale = n.isProject
        ? 1.6
        : Math.max(0.7, 0.7 + 0.3 * Math.log2(1 + n.degree) + n.memberCount * 0.12);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.setScalar(scale);
      mesh.position.copy(n.pos);

      // Multi-membership ring
      if (n.memberCount > 1 && !n.isProject) {
        const ringGeo = new THREE.TorusGeometry(0.55 * scale, 0.04, 8, 24);
        const ringMat = new THREE.MeshStandardMaterial({
          color: '#ffffff',
          emissive: '#444444',
          emissiveIntensity: 0.4,
          roughness: 0.3,
          metalness: 0.6,
          transparent: true,
          opacity: 0.5
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = Math.PI / 2;
        mesh.add(ring);
      }

      meshGroup.add(mesh);
    }

    // Create labels for project nodes
    for (const n of onodes) {
      if (!n.isProject) continue;
      const sprite = createLabel(n.label, n.colors[0] ?? '#ccc');
      sprite.position.set(n.pos.x, n.pos.y - 1.8, n.pos.z);
      labelGroup.add(sprite);
    }
  }

  // Track changes and rebuild
  let prevSig = '';
  $effect(() => {
    const sig = `${graphs.length}:${nodes.size}:${edges.length}:${[...activeGraphIds].sort().join(',')}:${[...activePredicates].sort().join(',')}`;
    if (sig === prevSig) return;
    prevSig = sig;
    buildGraph();
  });

  // ── Physics ────────────────────────────────────────────────────────────────
  const REPEL  = 1.4;
  const SPRING = 0.10;
  const ANCHOR = 0.12;
  const BASE_R = 2.5;
  const DAMP   = 0.84;
  const CENTER = 0.012;

  useTask((delta) => {
    if (onodes.length === 0) return;
    const dt = Math.min(delta, 0.05);

    // Repulsion between non-project nodes
    for (let i = 0; i < onodes.length; i++) {
      const a = onodes[i];
      if (a.isProject) continue;
      for (let j = i + 1; j < onodes.length; j++) {
        const b = onodes[j];
        if (b.isProject) continue;
        const dx = a.pos.x - b.pos.x;
        const dy = a.pos.y - b.pos.y;
        const dz = a.pos.z - b.pos.z;
        const d2 = dx * dx + dy * dy + dz * dz + 0.01;
        const f = REPEL / d2;
        const inv = 1 / Math.sqrt(d2);
        a.vel.x += dx * inv * f * dt; a.vel.y += dy * inv * f * dt; a.vel.z += dz * inv * f * dt;
        b.vel.x -= dx * inv * f * dt; b.vel.y -= dy * inv * f * dt; b.vel.z -= dz * inv * f * dt;
      }
    }

    // Spring edges
    for (const e of oedges) {
      if (e.a.isProject || e.b.isProject) continue;
      const dx = e.b.pos.x - e.a.pos.x;
      const dy = e.b.pos.y - e.a.pos.y;
      const dz = e.b.pos.z - e.a.pos.z;
      const d = Math.hypot(dx, dy, dz) + 0.001;
      const f = (d - BASE_R) * SPRING;
      e.a.vel.x += (dx / d) * f * dt * 6; e.a.vel.y += (dy / d) * f * dt * 6; e.a.vel.z += (dz / d) * f * dt * 6;
      e.b.vel.x -= (dx / d) * f * dt * 6; e.b.vel.y -= (dy / d) * f * dt * 6; e.b.vel.z -= (dz / d) * f * dt * 6;
    }

    // Anchor + center + damp
    for (const n of onodes) {
      if (n.isProject) {
        n.pos.x = n.anchorX; n.pos.y = n.anchorY; n.pos.z = n.anchorZ;
        n.vel.set(0, 0, 0);
        continue;
      }
      n.vel.x += (n.anchorX - n.pos.x) * ANCHOR * dt;
      n.vel.y += (n.anchorY - n.pos.y) * ANCHOR * dt;
      n.vel.z += (n.anchorZ - n.pos.z) * ANCHOR * dt;
      n.vel.x += -n.pos.x * CENTER * dt;
      n.vel.y += -n.pos.y * CENTER * dt;
      n.vel.z += -n.pos.z * CENTER * dt;
      n.vel.multiplyScalar(DAMP);
      n.pos.x += n.vel.x; n.pos.y += n.vel.y; n.pos.z += n.vel.z;
    }

    // Sync mesh positions
    const meshes = meshGroup.children as THREE.Mesh[];
    for (let i = 0; i < onodes.length; i++) {
      meshes[i]?.position.copy(onodes[i].pos);
    }

    // Sync project labels
    let labelIdx = 0;
    for (const n of onodes) {
      if (!n.isProject) continue;
      const sprite = labelGroup.children[labelIdx] as THREE.Sprite | undefined;
      if (sprite) {
        sprite.position.set(n.pos.x, n.pos.y - 1.8, n.pos.z);
      }
      labelIdx++;
    }

    // Update edge line positions
    if (lineGeom) {
      const limit = Math.min(oedges.length, MAX_EDGES);
      for (let i = 0; i < limit; i++) {
        const e = oedges[i];
        linePositions[i * 6]     = e.a.pos.x; linePositions[i * 6 + 1] = e.a.pos.y; linePositions[i * 6 + 2] = e.a.pos.z;
        linePositions[i * 6 + 3] = e.b.pos.x; linePositions[i * 6 + 4] = e.b.pos.y; linePositions[i * 6 + 5] = e.b.pos.z;
      }
      const attr = lineGeom.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (attr) { attr.needsUpdate = true; lineGeom.setDrawRange(0, limit * 2); }
    }
  });
</script>

<T is={meshGroup} />
<T is={labelGroup} />

<!-- Edge lines -->
<T.LineSegments>
  <T.BufferGeometry bind:ref={lineGeom}>
    <T.BufferAttribute attach="attributes.position" args={[linePositions, 3]} />
  </T.BufferGeometry>
  <T.LineBasicMaterial color="#8899cc" transparent opacity={0.15} />
</T.LineSegments>

<!-- Lighting -->
<T.AmbientLight intensity={0.45} />
<T.DirectionalLight position={[8, 12, 6]} intensity={1.0} color="#ffd6b0" />
<T.PointLight position={[-10, -5, 8]} intensity={0.5} color="#6dd3c4" />
<T.PointLight position={[4, 8, -10]} intensity={0.3} color="#9b6ee0" />

<!-- Camera -->
<T.PerspectiveCamera makeDefault position={[0, 14, 28]} fov={50}>
  <OrbitControls
    enablePan={false}
    enableZoom={true}
    autoRotate={true}
    autoRotateSpeed={0.2}
    minDistance={10}
    maxDistance={55}
  />
</T.PerspectiveCamera>
