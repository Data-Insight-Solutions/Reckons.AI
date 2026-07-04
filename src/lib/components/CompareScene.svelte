<script lang="ts">
  /**
   * CompareScene — full force-directed graph comparing two statement sets.
   *
   * Nodes are colored by group membership:
   *   teal  (#1a9b8e) = incoming source only
   *   gold  (#e8b84b) = shared (appears in both)
   *   blue  (#3d7cf5) = existing KB only
   *
   * Node geometry is driven by entity type (same shapes as the main graph).
   * Soft left/right anchors keep the two sources visually separated.
   */
  import { T, useTask } from '@threlte/core';
  import { OrbitControls } from '@threlte/extras';
  import * as THREE from 'three';
  import type { Statement } from '$lib/rdf/types';
  import { termKey, isIRI, isLit, isMetaPredicate } from '$lib/rdf/types';
  import { GEOMETRY_ARGS, UNKNOWN_TYPE, RDF_TYPE, RDFS_LABEL, type EntityTypeDef } from '$lib/rdf/entity-types';
  import { typeMap } from '$lib/stores/entity-types.svelte';

  let {
    incoming = [],
    existing = []
  } = $props<{
    incoming: Statement[];
    existing: Statement[];
  }>();

  const COLOR_IN = '#1a9b8e';
  const COLOR_KB = '#3d7cf5';
  const COLOR_SH = '#e8b84b';
  const EM_IN    = '#0b2e2b';
  const EM_KB    = '#0a1630';
  const EM_SH    = '#302800';

  type GNode = {
    key: string;
    group: 'incoming' | 'kb' | 'shared';
    typeDef: EntityTypeDef | null;
    isLiteral: boolean;
    pos: THREE.Vector3;
    vel: THREE.Vector3;
    degree: number;
  };
  type GEdge = { a: GNode; b: GNode };

  let gnodes: GNode[] = [];
  let gedges: GEdge[] = [];
  let lineGeom: THREE.BufferGeometry | undefined = $state();
  const meshGroup = new THREE.Group();
  const MAX_EDGES = 1000;
  const linePositions = new Float32Array(MAX_EDGES * 6);

  // Attach the position attribute imperatively with a direct THREE import — survives
  // minification, unlike <T.BufferAttribute> (whose class-name heuristic breaks in builds).
  $effect(() => {
    if (lineGeom && !lineGeom.getAttribute('position')) {
      lineGeom.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
    }
  });


  function createGeometry(typeDef: EntityTypeDef | null, isLiteral: boolean): THREE.BufferGeometry {
    const name = typeDef?.geometry ?? (isLiteral ? 'sphere' : UNKNOWN_TYPE.geometry);
    const a = GEOMETRY_ARGS[name];
    switch (name) {
      case 'sphere':       return new THREE.SphereGeometry(a[0], a[1], a[2]);
      case 'icosahedron':  return new THREE.IcosahedronGeometry(a[0], a[1]);
      case 'octahedron':   return new THREE.OctahedronGeometry(a[0], a[1] ?? 0);
      case 'tetrahedron':  return new THREE.TetrahedronGeometry(a[0], a[1] ?? 0);
      case 'tetrahedron-inv': {
        const g = new THREE.TetrahedronGeometry(a[0], 0);
        g.rotateX(Math.PI);
        return g;
      }
      case 'dodecahedron': return new THREE.DodecahedronGeometry(a[0], a[1] ?? 0);
      case 'box':
      case 'box-flat':     return new THREE.BoxGeometry(a[0], a[1], a[2]);
      case 'cylinder':     return new THREE.CylinderGeometry(a[0], a[1], a[2], a[3]);
      case 'cone':         return new THREE.ConeGeometry(a[0], a[1], a[2]);
      case 'capsule':      return new THREE.CapsuleGeometry(a[0], a[1], a[2], a[3]);
      case 'torus':        return new THREE.TorusGeometry(a[0], a[1], a[2], a[3]);
      case 'torus-knot':   return new THREE.TorusKnotGeometry(a[0], a[1], a[2], a[3], a[4], a[5]);
      default:             return new THREE.IcosahedronGeometry(0.30, 0);
    }
  }

  function createMaterial(grp: GNode['group']): THREE.MeshStandardMaterial {
    const color   = grp === 'incoming' ? COLOR_IN : grp === 'kb' ? COLOR_KB : COLOR_SH;
    const emissive = grp === 'incoming' ? EM_IN    : grp === 'kb' ? EM_KB    : EM_SH;
    return new THREE.MeshStandardMaterial({
      color, emissive, emissiveIntensity: 0.6,
      roughness: 0.22, metalness: 0.45, flatShading: true
    });
  }

  function buildGraph() {
    for (const child of [...meshGroup.children]) {
      (child as THREE.Mesh).geometry?.dispose();
      ((child as THREE.Mesh).material as THREE.Material)?.dispose();
      meshGroup.remove(child);
    }
    gnodes = [];
    gedges = [];

    const tm = typeMap();

    // Entity type lookup from all statements
    const entityTypeMap = new Map<string, EntityTypeDef>();
    for (const st of [...incoming, ...existing]) {
      if (st.p.value === RDF_TYPE && st.s.kind === 'iri') {
        const def = tm.get(st.o.value);
        if (def) entityTypeMap.set(termKey(st.s), def);
      }
    }

    // Classify node keys by group
    const inKeys = new Set<string>();
    const exKeys = new Set<string>();
    for (const st of incoming) { inKeys.add(termKey(st.s)); inKeys.add(termKey(st.o)); }
    for (const st of existing) { exKeys.add(termKey(st.s)); exKeys.add(termKey(st.o)); }

    const nodeMap = new Map<string, GNode>();

    function ensureNode(term: Statement['s']): GNode {
      const k = termKey(term);
      if (nodeMap.has(k)) return nodeMap.get(k)!;
      const inIn = inKeys.has(k);
      const inEx = exKeys.has(k);
      const grp: GNode['group'] = (inIn && inEx) ? 'shared' : inIn ? 'incoming' : 'kb';
      const xBias = grp === 'incoming' ? -5.5 : grp === 'kb' ? 5.5 : 0;
      const literal = !isIRI(term);
      const n: GNode = {
        key: k, group: grp,
        typeDef: entityTypeMap.get(k) ?? null,
        isLiteral: literal,
        pos: new THREE.Vector3(xBias + (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 1.5),
        vel: new THREE.Vector3(),
        degree: 0
      };
      nodeMap.set(k, n);
      return n;
    }

    const edgeSig = new Set<string>();

    for (const st of incoming) {
      if (st.p.value === RDF_TYPE) { ensureNode(st.s); continue; }
      if (isMetaPredicate(st.p.value)) continue;
      if (st.p.value === RDFS_LABEL) { ensureNode(st.s); continue; }
      const a = ensureNode(st.s);
      const b = ensureNode(st.o);
      a.degree++; b.degree++;
      const sig = `${a.key}|${b.key}`;
      edgeSig.add(sig);
      gedges.push({ a, b });
    }

    for (const st of existing) {
      if (st.p.value === RDF_TYPE) { ensureNode(st.s); continue; }
      if (isMetaPredicate(st.p.value)) continue;
      if (st.p.value === RDFS_LABEL) { ensureNode(st.s); continue; }
      const a = ensureNode(st.s);
      const b = ensureNode(st.o);
      const sig = `${a.key}|${b.key}`;
      if (!edgeSig.has(sig)) {
        edgeSig.add(sig);
        a.degree++; b.degree++;
        gedges.push({ a, b });
      }
    }

    gnodes = [...nodeMap.values()];

    for (const n of gnodes) {
      const geo = createGeometry(n.typeDef, n.isLiteral);
      const mat = createMaterial(n.group);
      const scale = Math.max(0.75, 0.75 + 0.28 * Math.log2(1 + n.degree));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.setScalar(scale);
      mesh.position.copy(n.pos);
      meshGroup.add(mesh);
    }
  }

  let prevSig = '';
  $effect(() => {
    const tm = typeMap();
    const sig = `${incoming.length}:${existing.length}:${tm.size}`;
    if (sig === prevSig) return;
    prevSig = sig;
    buildGraph();
  });

  const REPEL  = 1.2;
  const SPRING = 0.12;
  const ANCHOR = 0.10;
  const BASE_R = 2.2;
  const DAMP   = 0.86;
  const CENTER = 0.015;

  useTask((delta) => {
    if (gnodes.length === 0) return;
    const dt = Math.min(delta, 0.05);

    for (let i = 0; i < gnodes.length; i++) {
      const a = gnodes[i];
      for (let j = i + 1; j < gnodes.length; j++) {
        const b = gnodes[j];
        const dx = a.pos.x - b.pos.x, dy = a.pos.y - b.pos.y, dz = a.pos.z - b.pos.z;
        const d2 = dx*dx + dy*dy + dz*dz + 0.01;
        const f = REPEL / d2, inv = 1 / Math.sqrt(d2);
        a.vel.x += dx*inv*f*dt; a.vel.y += dy*inv*f*dt; a.vel.z += dz*inv*f*dt;
        b.vel.x -= dx*inv*f*dt; b.vel.y -= dy*inv*f*dt; b.vel.z -= dz*inv*f*dt;
      }
    }

    for (const e of gedges) {
      const dx = e.b.pos.x - e.a.pos.x, dy = e.b.pos.y - e.a.pos.y, dz = e.b.pos.z - e.a.pos.z;
      const d = Math.hypot(dx, dy, dz) + 0.001;
      const f = (d - BASE_R) * SPRING;
      e.a.vel.x += (dx/d)*f*dt*8; e.a.vel.y += (dy/d)*f*dt*8; e.a.vel.z += (dz/d)*f*dt*8;
      e.b.vel.x -= (dx/d)*f*dt*8; e.b.vel.y -= (dy/d)*f*dt*8; e.b.vel.z -= (dz/d)*f*dt*8;
    }

    for (const n of gnodes) {
      const xTarget = n.group === 'incoming' ? -6 : n.group === 'kb' ? 6 : 0;
      n.vel.x += (xTarget - n.pos.x) * ANCHOR * dt;
      n.vel.x += -n.pos.x * CENTER * dt;
      n.vel.y += -n.pos.y * CENTER * dt;
      n.vel.z += -n.pos.z * CENTER * dt;
      n.vel.multiplyScalar(DAMP);
      n.pos.x += n.vel.x; n.pos.y += n.vel.y; n.pos.z += n.vel.z;
    }

    const meshes = meshGroup.children as THREE.Mesh[];
    for (let i = 0; i < gnodes.length; i++) {
      meshes[i]?.position.copy(gnodes[i].pos);
    }

    if (lineGeom) {
      const limit = Math.min(gedges.length, MAX_EDGES);
      for (let i = 0; i < limit; i++) {
        const e = gedges[i];
        linePositions[i*6]   = e.a.pos.x; linePositions[i*6+1] = e.a.pos.y; linePositions[i*6+2] = e.a.pos.z;
        linePositions[i*6+3] = e.b.pos.x; linePositions[i*6+4] = e.b.pos.y; linePositions[i*6+5] = e.b.pos.z;
      }
      const attr = lineGeom.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (attr) { attr.needsUpdate = true; lineGeom.setDrawRange(0, limit * 2); }
    }
  });
</script>

<T is={meshGroup} />

<!-- Edge lines -->
<T.LineSegments>
  <!-- position attribute set imperatively (minification-safe) — see $effect in script -->
  <T.BufferGeometry bind:ref={lineGeom} />
  <T.LineBasicMaterial color="#8899cc" transparent opacity={0.20} />
</T.LineSegments>

<T.AmbientLight intensity={0.5} />
<T.DirectionalLight position={[6, 10, 4]} intensity={1.0} color="#ffd6b0" />
<T.PointLight position={[-8, -4, 6]} intensity={0.6} color="#6dd3c4" />

<T.PerspectiveCamera makeDefault position={[0, 0, 22]} fov={50}>
  <OrbitControls
    enablePan={false}
    enableZoom={true}
    autoRotate={true}
    autoRotateSpeed={0.25}
    minDistance={8}
    maxDistance={35}
  />
</T.PerspectiveCamera>
