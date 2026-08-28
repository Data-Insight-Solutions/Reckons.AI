<script lang="ts">
  /**
   * KnowledgeGraph — a 3D force-directed visualization of the KB.
   *
   * Layout modes:
   *   force  — default spring/repulsion sim
   *   focus  — selected node at center, BFS-distance rings radiating outward
   *   source — nodes pulled toward their source cluster anchors
   *   type   — nodes pulled toward their entity-type cluster anchors
   *   hub    — high-degree hubs at center, leaves at periphery
   */
  import { T, useTask, useThrelte } from '@threlte/core';
  import { interactivity, OrbitControls } from '@threlte/extras';
  import * as THREE from 'three';
  import type { Statement } from '$lib/rdf/types';
  import { termKey, isIRI, isLit, isMetaPredicate, displayLiteralLabel } from '$lib/rdf/types';
  import { parseGraphDate, EVENT_DATE_PREDICATES } from '$lib/rdf/parse-date';
  import { buildNodeTimes, timelineRange, undatedCount } from '$lib/rdf/timeline-layout';
  import { cameraPosition, CAMERA_PRESETS, type CameraSpec } from './camera-presets';
  import { resolveOverlaps, previewWorldRadius } from './preview-collage';
  import GraphNode from '$lib/components/GraphNode.svelte';
  import { typeMap } from '$lib/stores/entity-types.svelte';
  import { RDF_TYPE, RDFS_LABEL, type EntityTypeDef } from '$lib/rdf/entity-types';
  import { glbOverrides } from '$lib/stores/glb-overrides.svelte';
  import { recordFrame } from '$lib/stores/perf-monitor.svelte';
  import { leapNodeKeys } from '$lib/rdf/kb-leap';
  import { hopDistances, adjacencyFromPairs } from '$lib/rdf/n-hop';
  import { buildHierarchyParentMaps, NAV_ORDER, NAV_LAYER } from '$lib/rdf/hierarchy';

  interactivity();

  let {
    statements = [],
    topologyStatements = null,
    flooredStatementIds = null,
    selected = null,
    highlighted = [],
    dimMode = false,
    targetKey = null,
    historyTimestamp = null,
    sources = [],
    layout = 'force',
    timelineZoom = 1,
    timelineCenter = null,
    timelineTimeSource = 'event' as 'event' | 'ingested',
    cameraSpec = null,
    previewKeys = null,
    previewSizePx = 96,
    onselect = () => {},
    onhover = () => {},
    onnodemove = () => {},
    onhovermove = () => {},
    onmarkersmove = () => {},
    onlabelsmove = () => {},
    ontimelinepan = () => {},
    onsettledchange = (_settled: boolean) => {},
    onready = () => {}
  } = $props<{
    statements?: Statement[];
    /**
     * Statements allowed to create visible edges. `statements` remains the complete input so
     * labels, rdf:type styling and presentation metadata still work. When omitted, every normal
     * statement remains topology-compatible for callers that have not split attributes yet.
     */
    topologyStatements?: Statement[] | null;
    /** Statements removed by the detail floor — see the guard in the build loop. */
    flooredStatementIds?: Set<string> | null;
    selected?: string | null;
    highlighted?: string[];
    dimMode?: boolean;
    targetKey?: string | null;
    historyTimestamp?: number | null;
    sources?: any[];
    layout?: 'force' | 'focus' | 'source' | 'type' | 'hub' | 'timeline' | 'order' | 'hierarchy';
    /** Camera angle. Null keeps the historical straight-on view, so existing baselines are
     *  unaffected; a spec aims the camera so a visual test can actually SEE the z axis. */
    cameraSpec?: CameraSpec | null;
    timelineZoom?: number;
    timelineCenter?: number | null;
    timelineTimeSource?: 'event' | 'ingested';
    /**
     * F133 all-previews MODIFIER. Keys of nodes currently rendering a preview thumbnail. Null (or
     * empty) means the modifier is off and the simulation behaves exactly as before.
     *
     * This is a modifier, not a layout: it never decides WHERE nodes go, it only makes whichever
     * force is running leave enough room for what the nodes are showing. So it composes with all
     * eight layout values rather than being a ninth.
     */
    previewKeys?: Set<string> | null;
    /** On-screen size of a preview thumbnail in px (settings.nodePreviewSize). */
    previewSizePx?: number;
    onselect?: (key: string | null, ctrlKey?: boolean) => void;
    onhover?: (key: string | null) => void;
    onnodemove?: (key: string, x: number, y: number) => void;
    onhovermove?: (key: string | null, label: string | null, x: number, y: number) => void;
    onmarkersmove?: (markers: Array<{ key: string; label: string; color: string; x: number; y: number }>) => void;
    onlabelsmove?: (labels: Array<{ key: string; label: string; x: number; y: number; opacity: number }>) => void;
    ontimelinepan?: (center: number) => void;
    /** Exposes the simulation's real cooling boundary to UI/performance consumers. */
    onsettledchange?: (settled: boolean) => void;
    /** Fired after a non-empty scene has completed at least one animation frame. */
    onready?: () => void;
  }>();

  const isHistoryMode = $derived(historyTimestamp !== null);

  const nodeTypeMap = $derived.by(() => {
    const map = new Map<string, EntityTypeDef>();
    const tm = typeMap();
    for (const st of statements as Statement[]) {
      if (st.p.value === RDF_TYPE && st.s.kind === 'iri') {
        const def = tm.get(st.o.value);
        if (def) map.set(termKey(st.s), def); // use termKey so it matches n.key
      }
    }
    return map;
  });

  /**
   * Per-node triple rank (0–1), normalized within each type group.
   * 0 = fewest triples in that type, 1 = most. Used for subtle hue shifting in GraphNode.
   */
  const nodeTypeRankMap = $derived.by(() => {
    const groups = new Map<string, typeof nodes>();
    for (const n of nodes) {
      const typeKey = nodeTypeMap.get(n.key)?.label ?? '__default__';
      if (!groups.has(typeKey)) groups.set(typeKey, []);
      groups.get(typeKey)!.push(n);
    }
    const rankMap = new Map<string, number>();
    for (const group of groups.values()) {
      let min = Infinity, max = -Infinity;
      for (const n of group) { if (n.degree < min) min = n.degree; if (n.degree > max) max = n.degree; }
      const range = max - min;
      for (const n of group) {
        rankMap.set(n.key, range === 0 ? 0.5 : (n.degree - min) / range);
      }
    }
    return rankMap;
  });

  /** Set of node keys that have a KB Leap defined. */
  const leapKeys = $derived(leapNodeKeys(statements as Statement[]));

  /** Per-entity GLB override: entity node key → glb URL (editor store + statement-level refs) */
  const entityIcon3dMap = $derived.by(() => {
    const overrides = glbOverrides();
    const map = new Map<string, string>();
    for (const [iri, url] of overrides) {
      map.set('i:' + iri, url);
    }
    // Also pick up urn:kbase:meta/glbModel from statements (TTL-embedded GLB refs)
    for (const st of statements as Statement[]) {
      if (st.p.value === 'urn:kbase:meta/glbModel' && st.s.kind === 'iri' && st.o.kind === 'literal') {
        const k = 'i:' + st.s.value;
        if (!map.has(k)) map.set(k, st.o.value);
      }
    }
    return map;
  });

  type Node = {
    key: string;
    label: string;
    kind: 'concept' | 'literal';
    pos: THREE.Vector3;
    vel: THREE.Vector3;
    degree: number;
    /** Full text for hover display (literals: full value; IRIs: label only) */
    fullText?: string;
  };
  type Edge = {
    a: Node; b: Node;
    predicate: string;
    confidence: number;
    /** Multiplier on spring REST length: < 1 = tighter, > 1 = looser */
    semanticDist: number;
  };
  type LayoutMarker = {
    key: string; pos: THREE.Vector3; label: string; color: string;
    /** 'cluster' = source/type anchor sphere; 'sector' = focus predicate indicator; 'hub-node' = actual hub node (no extra sphere rendered) */
    kind?: 'cluster' | 'sector' | 'hub-node';
  };

  let nodes = $state<Node[]>([]);
  let edges = $state<Edge[]>([]);
  let lineGeom: THREE.BufferGeometry | undefined = $state();
  let orbitRef: any = $state();
  // Persistent position cache — lives outside the $effect so reading it doesn't
  // create a reactive dependency that would cause a write→read cycle.
  // The physics useTask mutates node.pos in place, so the Vector3 refs stay current.
  const nodePositionCache = new Map<string, THREE.Vector3>();
  // Per-node color assigned by the current layout (source cluster, hub cluster).
  let nodeColorMap = $state<Map<string, string>>(new Map());
  // Keys of hub nodes in hub mode (projected from actual node.pos, not anchor pos).
  let hubNodeKeys = $state<string[]>([]);
  let cameraTarget = new THREE.Vector3(0, 0, 0);
  const projVec = new THREE.Vector3();
  const { camera, renderer } = useThrelte();
  let previousCanvasWidth = 0;
  let previousCanvasHeight = 0;
  let previousCameraAspect = 0;

  /** Fit a structured tree as a whole; its orphan lane is part of the visible composition too. */
  function fitHierarchyCamera3D(anchors: Map<string, THREE.Vector3>) {
    if (cameraSpec || anchors.size === 0 || !camera.current) return;
    const cam = camera.current as THREE.PerspectiveCamera;
    if (!cam.isPerspectiveCamera) return;
    const sphere = new THREE.Sphere();
    new THREE.Box3().setFromPoints([...anchors.values()]).getBoundingSphere(sphere);
    const previousTarget = orbitRef?.target ?? cameraTarget;
    const direction = cam.position.clone().sub(previousTarget);
    if (direction.lengthSq() === 0) direction.set(0, 0, 1);
    direction.normalize();
    const verticalFov = THREE.MathUtils.degToRad(cam.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * Math.max(cam.aspect, 0.1));
    const limitingHalfFov = Math.max(0.05, Math.min(verticalFov, horizontalFov) / 2);
    const distance = Math.max(8, (sphere.radius / Math.sin(limitingHalfFov)) * 1.18);

    cameraTarget.copy(sphere.center);
    cam.position.copy(sphere.center).addScaledVector(direction, distance);
    cam.near = Math.max(0.01, distance - sphere.radius * 1.5);
    cam.far = Math.max(100, distance + sphere.radius * 3);
    cam.lookAt(sphere.center);
    cam.updateProjectionMatrix();
    if (orbitRef?.target) {
      orbitRef.target.copy(sphere.center);
      orbitRef.update?.();
    }
  }

  // ── Semantic distance heuristic ─────────────────────────────────────────────
  /**
   * Returns a REST-length multiplier for a spring edge.
   * Smaller  (<1) = nodes pulled together (properties, high-confidence, taxonomic).
   * Larger   (>1) = nodes rest farther apart (uncertain, cross-domain).
   */
  function edgeSemanticDist(isLiteralTarget: boolean, predicate: string, confidence: number): number {
    let d = 1.0;
    if (isLiteralTarget)      d *= 0.70; // literal = property, stay close
    if (predicate === 'type') d *= 0.65; // taxonomic = tight
    if (confidence > 0.85)    d *= 0.88;
    else if (confidence < 0.5) d *= 1.25;
    return d;
  }

  // ── Layout state ────────────────────────────────────────────────────────────
  // Plain (used in useTask, not template)
  let activeAnchors: Map<string, THREE.Vector3> = new Map();
  let anchorStrength = 0.25;
  // Reactive (used in template for visual indicators)
  let layoutMarkers = $state<LayoutMarker[]>([]);     // positioned spheres (source / type)
  let layoutRingRadii = $state<number[]>([]);         // concentric rings (focus / hub)
  let focusDistances = $state<Map<string, number>>(new Map()); // hop distance from selected node


  $effect(() => {
    const nodeMap = new Map<string, Node>();
    const e: Edge[] = [];
    const topologyIds = topologyStatements === null
      ? null
      : new Set((topologyStatements as Statement[]).map((st) => st.id));
    for (const st of statements as Statement[]) {
      if (st.status === 'rejected' || st.status === 'superseded') continue;
      // THE DETAIL FLOOR HAS TO BE CONSULTED BEFORE ANY NODE IS CREATED, not only in the topology
      // branch below. rdf:type and rdfs:label each mint a node of their own, and both classify as
      // RECORD — so at a `decisions` floor they are hidden and were STILL creating the node, which
      // is why filtering to decisions left almost every node on screen. It decorates freely and
      // creates nothing: a label on a node that survives for other reasons is welcome; a label
      // that RESURRECTS a hidden node is the bug.
      const floored = flooredStatementIds?.has(st.id) ?? false;
      // rdf:type triples style the subject node (nodeTypeMap) but must not
      // create a visible type-IRI node or edge in the graph.
      if (st.p.value === RDF_TYPE) {
        // Ensure the typed subject node still exists even if it has no other triples.
        const k = termKey(st.s);
        if (!floored && !nodeMap.has(k) && st.s.kind === 'iri') {
          const label = st.s.value.split('/').pop() ?? st.s.value;
          const pos = nodePositionCache.get(k)
            ?? new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
          nodeMap.set(k, { key: k, label, kind: 'concept', pos, vel: new THREE.Vector3(), degree: 0 });
          nodePositionCache.set(k, pos);
        }
        continue;
      }
      // Metadata predicates (urn:kbase:meta/*) are node properties, not graph edges.
      // They're shown in the detail panel but don't create nodes or edges.
      if (isMetaPredicate(st.p.value)) continue;
      // rdfs:label sets the display name of the subject node, not an edge
      if (st.p.value === RDFS_LABEL && st.o.kind === 'literal') {
        const k = termKey(st.s);
        const existing = nodeMap.get(k);
        if (existing) {
          existing.label = st.o.value;
        } else if (!floored && st.s.kind === 'iri') {
          const pos = nodePositionCache.get(k)
            ?? new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
          nodeMap.set(k, { key: k, label: st.o.value, kind: 'concept', pos, vel: new THREE.Vector3(), degree: 0 });
          nodePositionCache.set(k, pos);
        }
        continue;
      }
      if (topologyIds && !topologyIds.has(st.id)) {
        // ...but a fact the DETAIL FLOOR removed is a different case: resurrecting its subject
        // here would undo exactly what the floor was asked to do. A dictated note whose every
        // edge is provenance would keep its node and the graph would look unfiltered.
        if (floored) continue;
        // A unique literal is an attribute, not a leaf node. Keep its subject visible even when
        // this is the entity's only fact; the detail panel still reads the full `statements` set.
        const k = termKey(st.s);
        if (!nodeMap.has(k) && st.s.kind === 'iri') {
          const label = st.s.value.split('/').pop() ?? st.s.value;
          const pos = nodePositionCache.get(k)
            ?? new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
          nodeMap.set(k, { key: k, label, kind: 'concept', pos, vel: new THREE.Vector3(), degree: 0 });
          nodePositionCache.set(k, pos);
        }
        continue;
      }
      for (const term of [st.s, st.o]) {
        const k = termKey(term);
        if (!nodeMap.has(k)) {
          const isLiteral = isLit(term);
          const fullVal = isLiteral ? term.value : undefined;
          const label = isIRI(term)
            ? term.value.split('/').pop() ?? term.value
            : isLiteral
              ? displayLiteralLabel(term.value)
              : `_:${term.value}`;
          // Reuse cached position so filter toggles don't scatter the graph;
          // fall back to a random spawn only for genuinely new nodes.
          const pos = nodePositionCache.get(k)
            ?? new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
          nodeMap.set(k, { key: k, label, kind: isIRI(term) ? 'concept' : 'literal', pos, vel: new THREE.Vector3(), degree: 0, fullText: fullVal });
          nodePositionCache.set(k, pos); // ensure new nodes are cached
        }
      }
      const a = nodeMap.get(termKey(st.s))!;
      const b = nodeMap.get(termKey(st.o))!;
      a.degree++; b.degree++;
      const pred = st.p.value.split('/').pop() ?? st.p.value;
      e.push({
        a, b, predicate: pred, confidence: st.confidence,
        semanticDist: edgeSemanticDist(!isIRI(st.o), pred, st.confidence)
      });
    }
    nodes = [...nodeMap.values()];
    edges = e;
    reheat(); // new topology is a new layout problem
  });

  // ── Layout builders ─────────────────────────────────────────────────────────

  const FOCUS_RING_R = 5.5; // world-units between hop rings

  function buildFocusAnchors(): { anchors: Map<string, THREE.Vector3>; radii: number[]; distances: Map<string, number> } {
    if (!selected) return { anchors: new Map(), radii: [], distances: new Map() };

    // ── 1. BFS hop distances ─────────────────────────────────────────────────
    // Shared traversal (rdf/n-hop.ts) — this was a verbatim copy of the 2D version, and
    // both rescanned the entire EDGE LIST per dequeued node (O(V*E)). Building an
    // adjacency map first makes it O(V+E).
    const distances = hopDistances(adjacencyFromPairs(edges.map((e) => [e.a.key, e.b.key] as const)), selected);

    // ── 2. Classify hop-1 neighbors by predicate + direction ────────────────
    // 'out' = selected is the subject (→ target)
    // 'in'  = selected is the object  (source →)
    const outGroups = new Map<string, string[]>(); // pred → nodeKeys
    const inGroups  = new Map<string, string[]>();
    const nodeAngle  = new Map<string, number>();  // remembered for hop-2+ inheritance

    for (const e of edges) {
      if (e.a.key === selected && distances.get(e.b.key) === 1) {
        if (!outGroups.has(e.predicate)) outGroups.set(e.predicate, []);
        if (!outGroups.get(e.predicate)!.includes(e.b.key)) outGroups.get(e.predicate)!.push(e.b.key);
      }
      if (e.b.key === selected && distances.get(e.a.key) === 1) {
        if (!inGroups.has(e.predicate)) inGroups.set(e.predicate, []);
        if (!inGroups.get(e.predicate)!.includes(e.a.key)) inGroups.get(e.predicate)!.push(e.a.key);
      }
    }

    const outCount   = [...outGroups.values()].reduce((s, a) => s + a.length, 0);
    const inCount    = [...inGroups.values()].reduce((s, a) => s + a.length, 0);
    const totalDirect = outCount + inCount;

    const anchors = new Map<string, THREE.Vector3>();
    anchors.set(selected, new THREE.Vector3(0, 0, 0));

    // ── 3. Arc allocation (out = top, in = bottom) ───────────────────────────
    if (totalDirect > 0) {
      const GAP = 0.30; // radians gap between the two arcs when both are present

      let outArc: number, inArc: number, outStart: number, inStart: number;

      if (inCount === 0) {
        // Only outgoing — use the full circle, start at top
        outArc = 2 * Math.PI; outStart = Math.PI / 2 - Math.PI; // start at "left" so it fans nicely
        inArc  = 0;           inStart  = 0;
      } else if (outCount === 0) {
        // Only incoming — full circle, start at top
        inArc  = 2 * Math.PI; inStart  = Math.PI / 2 - Math.PI;
        outArc = 0;           outStart = 0;
      } else {
        // Both present: proportional split with minimums, centered top/bottom
        const fOut = Math.max(0.22, Math.min(0.78, outCount / totalDirect));
        outArc   = fOut * (2 * Math.PI) - GAP;
        inArc    = (1 - fOut) * (2 * Math.PI) - GAP;
        outStart = Math.PI / 2 - outArc / 2;   // centered at 12 o'clock
        inStart  = -Math.PI / 2 - inArc / 2;   // centered at 6 o'clock
      }

      const placeArc = (groups: Map<string, string[]>, total: number, arcStart: number, totalArc: number) => {
        let angle = arcStart;
        for (const [, nodeKeys] of groups) {
          if (nodeKeys.length === 0) continue;
          const sectorArc = totalArc * (nodeKeys.length / total);
          const midAngle  = angle + sectorArc / 2;
          nodeKeys.forEach((k, i) => {
            const fa = nodeKeys.length === 1 ? midAngle : angle + (i + 0.5) * (sectorArc / nodeKeys.length);
            const zOff = (i % 2 === 0 ? 1 : -1) * 0.55;
            anchors.set(k, new THREE.Vector3(FOCUS_RING_R * Math.cos(fa), FOCUS_RING_R * Math.sin(fa), zOff));
            nodeAngle.set(k, fa);
          });
          angle += sectorArc;
        }
      };

      placeArc(outGroups, outCount, outStart, outArc);
      placeArc(inGroups,  inCount,  inStart,  inArc);
    }

    // ── 4. Hop 2+ nodes: radiate behind their hop-1 parent ──────────────────
    const maxD = distances.size > 0 ? Math.max(...distances.values()) : 0;

    for (let hop = 2; hop <= maxD; hop++) {
      const hopNodes = [...distances.entries()].filter(([, d]) => d === hop).map(([k]) => k);

      // Group siblings by shared parent so we can fan them together
      const parentGroups = new Map<string, string[]>();
      for (const k of hopNodes) {
        let parentKey: string | null = null;
        for (const e of edges) {
          if (e.a.key === k && distances.get(e.b.key) === hop - 1) { parentKey = e.b.key; break; }
          if (e.b.key === k && distances.get(e.a.key) === hop - 1) { parentKey = e.a.key; break; }
        }
        const pk = parentKey ?? '__none__';
        if (!parentGroups.has(pk)) parentGroups.set(pk, []);
        parentGroups.get(pk)!.push(k);
      }

      const r = hop * FOCUS_RING_R;
      for (const [pk, siblings] of parentGroups) {
        const base = pk === '__none__' ? 0 : (nodeAngle.get(pk) ?? 0);
        // Fan siblings symmetrically around the parent's angle, narrowing as hop increases
        const fanStep = Math.min(Math.PI * 0.35, Math.PI * 0.7 / Math.max(siblings.length, 1));
        siblings.forEach((k, i) => {
          const offset = siblings.length === 1 ? 0 : (i - (siblings.length - 1) / 2) * fanStep;
          const fa = base + offset;
          const zOff = ((i + hop) % 2 === 0 ? 1 : -1) * hop * 0.45;
          anchors.set(k, new THREE.Vector3(r * Math.cos(fa), r * Math.sin(fa), zOff));
          nodeAngle.set(k, fa);
        });
      }
    }

    // ── 5. Disconnected nodes: outer orbit ───────────────────────────────────
    const unreachable = nodes.filter(n => !anchors.has(n.key));
    unreachable.forEach((n, i) => {
      const r = (maxD + 2.5) * FOCUS_RING_R;
      const theta = (2 * Math.PI * i) / Math.max(unreachable.length, 1);
      anchors.set(n.key, new THREE.Vector3(r * Math.cos(theta), r * Math.sin(theta), (i % 3 - 1) * 2));
    });

    const radii: number[] = [];
    for (let d = 1; d <= maxD; d++) radii.push(d * FOCUS_RING_R);
    return { anchors, radii, distances };
  }

  const SOURCE_COLORS = ['#1a9b8e', '#3d7cf5', '#e8534b', '#9b6ee0', '#e8b84b', '#5db876'];

  function buildSourceAnchors(): { anchors: Map<string, THREE.Vector3>; markers: LayoutMarker[]; nodeColors: Map<string, string> } {
    const sourceSet = new Set<string>();
    for (const st of statements as Statement[]) {
      if (st.status === 'rejected' || st.status === 'superseded') continue;
      if (st.sourceId) sourceSet.add(st.sourceId);
    }
    const sourceList = [...sourceSet];
    const n = sourceList.length;
    if (n === 0) return { anchors: new Map(), markers: [], nodeColors: new Map() };

    const RADIUS = n === 1 ? 0 : 16.0;
    const srcAnchors = new Map<string, THREE.Vector3>();
    sourceList.forEach((sid, i) => {
      const theta = (2 * Math.PI * i) / n - Math.PI / 2;
      srcAnchors.set(sid, new THREE.Vector3(RADIUS * Math.cos(theta), RADIUS * Math.sin(theta), 0));
    });

    const nodeSrcs = new Map<string, Set<string>>();
    for (const st of statements as Statement[]) {
      if (st.status === 'rejected' || st.status === 'superseded') continue;
      const sk = termKey(st.s);
      const ok = termKey(st.o);
      if (!nodeSrcs.has(sk)) nodeSrcs.set(sk, new Set());
      if (!nodeSrcs.has(ok)) nodeSrcs.set(ok, new Set());
      if (st.sourceId) { nodeSrcs.get(sk)!.add(st.sourceId); nodeSrcs.get(ok)!.add(st.sourceId); }
    }

    // Multi-source nodes: anchor = centroid of their sources; color = first source's color
    const anchors = new Map<string, THREE.Vector3>();
    const nodeColors = new Map<string, string>();
    for (const [nk, srcs] of nodeSrcs) {
      const avg = new THREE.Vector3();
      let count = 0;
      let firstColor = '';
      for (const sid of srcs) {
        const a = srcAnchors.get(sid);
        if (a) { avg.add(a); count++; }
        if (!firstColor) {
          const idx = sourceList.indexOf(sid);
          if (idx >= 0) firstColor = SOURCE_COLORS[idx % SOURCE_COLORS.length];
        }
      }
      if (count > 0) avg.divideScalar(count);
      anchors.set(nk, avg.clone());
      if (firstColor) nodeColors.set(nk, firstColor);
    }

    const markers: LayoutMarker[] = sourceList.map((sid, i) => {
      const src = (sources as any[]).find((s: any) => s.id === sid);
      return { key: sid, pos: srcAnchors.get(sid)!, label: src?.title ?? sid, color: SOURCE_COLORS[i % SOURCE_COLORS.length] };
    });

    return { anchors, markers, nodeColors };
  }

  function buildTypeAnchors(): { anchors: Map<string, THREE.Vector3>; markers: LayoutMarker[] } {
    const tm = typeMap();

    // Find rdf:type assignments
    const nodeTypeIri = new Map<string, string>();
    for (const st of statements as Statement[]) {
      if (st.status === 'rejected' || st.status === 'superseded') continue;
      if (st.p.value === RDF_TYPE && st.s.kind === 'iri') {
        nodeTypeIri.set(termKey(st.s), st.o.value);
      }
    }

    const typeSet = new Set(nodeTypeIri.values());
    const typeList = [...typeSet];
    if (typeList.length === 0) return { anchors: new Map(), markers: [] };

    const RADIUS = typeList.length === 1 ? 0 : 18.0;
    const typeAnchors = new Map<string, THREE.Vector3>();
    typeList.forEach((iri, i) => {
      const theta = (2 * Math.PI * i) / typeList.length - Math.PI / 2;
      typeAnchors.set(iri, new THREE.Vector3(RADIUS * Math.cos(theta), RADIUS * Math.sin(theta), 0));
    });

    const anchors = new Map<string, THREE.Vector3>();
    for (const n of nodes) {
      const typeIri = nodeTypeIri.get(n.key);
      if (typeIri && typeAnchors.has(typeIri)) {
        anchors.set(n.key, typeAnchors.get(typeIri)!.clone());
      } else {
        // Untyped nodes cluster loosely at center
        anchors.set(n.key, new THREE.Vector3(0, 0, 0));
      }
    }

    const markers: LayoutMarker[] = typeList.map(iri => {
      const def = tm.get(iri);
      return {
        key: iri,
        pos: typeAnchors.get(iri)!,
        label: def?.label ?? iri.split('/').pop() ?? iri,
        color: def?.color ?? '#e8b84b'
      };
    });

    return { anchors, markers };
  }

  const HUB_COLORS = ['#ff6b35', '#3d7cf5', '#9b6ee0', '#e8534b', '#e8b84b', '#5db876'];

  function buildHubAnchors(): { anchors: Map<string, THREE.Vector3>; markers: LayoutMarker[]; nodeColors: Map<string, string>; hubKeys: string[] } {
    if (nodes.length === 0) return { anchors: new Map(), markers: [], nodeColors: new Map(), hubKeys: [] };

    // Top N nodes by degree become the force anchors (the actual hub nodes)
    const sorted = [...nodes].sort((a, b) => b.degree - a.degree);
    const N = Math.min(6, sorted.filter(n => n.degree > 1).length);
    if (N === 0) return { anchors: new Map(), markers: [], nodeColors: new Map(), hubKeys: [] };

    const hubNodes = sorted.slice(0, N);
    const hubKeySet = new Set(hubNodes.map(n => n.key));

    const RADIUS = N === 1 ? 0 : 16.0;
    const hubAnchorPos = new Map<string, THREE.Vector3>();
    hubNodes.forEach((n, i) => {
      const theta = (2 * Math.PI * i) / N - Math.PI / 2;
      hubAnchorPos.set(n.key, new THREE.Vector3(RADIUS * Math.cos(theta), RADIUS * Math.sin(theta), 0));
    });

    // Assign each non-hub node to the hub it shares the most direct edges with
    const nodeHubIdx = new Map<string, number>();
    for (const node of nodes) {
      if (hubKeySet.has(node.key)) continue;
      let bestIdx = 0;
      let bestCount = -1;
      hubNodes.forEach((hub, i) => {
        const count = edges.filter(e =>
          (e.a.key === node.key && e.b.key === hub.key) ||
          (e.b.key === node.key && e.a.key === hub.key)
        ).length;
        if (count > bestCount) { bestCount = count; bestIdx = i; }
      });
      nodeHubIdx.set(node.key, bestIdx);
    }

    const anchors = new Map<string, THREE.Vector3>();
    for (const hub of hubNodes) anchors.set(hub.key, hubAnchorPos.get(hub.key)!);
    for (const node of nodes) {
      if (hubKeySet.has(node.key)) continue;
      const idx = nodeHubIdx.get(node.key) ?? 0;
      anchors.set(node.key, hubAnchorPos.get(hubNodes[idx].key)!.clone());
    }

    const nodeColors = new Map<string, string>();
    hubNodes.forEach((hub, i) => nodeColors.set(hub.key, HUB_COLORS[i % HUB_COLORS.length]));
    for (const node of nodes) {
      if (hubKeySet.has(node.key)) continue;
      const idx = nodeHubIdx.get(node.key) ?? 0;
      nodeColors.set(node.key, HUB_COLORS[idx % HUB_COLORS.length]);
    }

    // Markers use hub node's label; kind='hub-node' suppresses the extra 3D sphere
    const markers: LayoutMarker[] = hubNodes.map((n, i) => ({
      key: n.key,
      pos: hubAnchorPos.get(n.key)!,
      label: n.label,
      color: HUB_COLORS[i % HUB_COLORS.length],
      kind: 'hub-node' as const
    }));

    return { anchors, markers, nodeColors, hubKeys: hubNodes.map(n => n.key) };
  }

  function buildHierarchyAnchors3D(): { anchors: Map<string, THREE.Vector3>; markers: LayoutMarker[] } {
    const active = (statements as Statement[]).filter(s => s.status !== 'rejected' && s.status !== 'superseded');

    // Build the same tree the 2D renderer shows. Both predicates name the parent in the object;
    // an explicit taxonomic parent wins over a dependency parent regardless of statement order.
    const { parentOf, childrenOf, allIris } = buildHierarchyParentMaps(active, true);
    const orderOf = new Map<string, number>();
    const labels = new Map<string, string>();

    for (const s of active) {
      if (s.s.kind !== 'iri') continue;
      if (s.p.value === NAV_ORDER && s.o.kind === 'literal') {
        orderOf.set(s.s.value, parseInt(s.o.value, 10));
      }
      if (s.p.value === RDFS_LABEL && s.o.kind === 'literal') {
        labels.set(s.s.value, s.o.value);
      }
    }
    // Map node keys ↔ IRIs
    const keyToIri = new Map<string, string>();
    const iriToKey = new Map<string, string>();
    for (const n of nodes) {
      if (n.key.startsWith('i:')) {
        keyToIri.set(n.key, n.key.slice(2));
        iriToKey.set(n.key.slice(2), n.key);
      }
    }

    // Find roots (no parent, has children)
    const rootIris = [...allIris].filter(iri => !parentOf.has(iri)).sort();
    if (rootIris.length === 0) return { anchors: new Map(), markers: [] };

    // BFS depth assignment
    const depthOf = new Map<string, number>();
    const queue: string[] = [];
    for (const r of rootIris) { depthOf.set(r, 0); queue.push(r); }
    let qi = 0;
    while (qi < queue.length) {
      const cur = queue[qi++];
      const d = depthOf.get(cur)!;
      const children = childrenOf.get(cur) ?? [];
      children.sort((a, b) => (orderOf.get(a) ?? 999) - (orderOf.get(b) ?? 999));
      for (const child of children) {
        if (!depthOf.has(child)) { depthOf.set(child, d + 1); queue.push(child); }
      }
    }

    const maxDepth = Math.max(0, ...depthOf.values());
    const byDepth = new Map<number, string[]>();
    for (const [iri, d] of depthOf) {
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d)!.push(iri);
    }

    // Sort each ring by parent angle → own order
    for (const [, iris] of byDepth) {
      iris.sort((a, b) => {
        const pa = parentOf.get(a), pb = parentOf.get(b);
        if (pa === pb) return (orderOf.get(a) ?? 999) - (orderOf.get(b) ?? 999);
        return (orderOf.get(pa!) ?? 999) - (orderOf.get(pb!) ?? 999);
      });
    }

    // STACKED RINGS, not concentric shells.
    //
    // Depth used to be radius: every level a sphere around a common centre. In 3D that buries the
    // shallow levels INSIDE the deep ones — the roots end up at the middle of the ball, hidden
    // behind everything that depends on them, and "prerequisite" has no visible direction.
    //
    // Now each level is a ring in the horizontal plane and depth descends the vertical axis, so the
    // tree reads as a cone: level 0 is a small ring on top, and each level below is further down AND
    // wider. Ring size grows with depth as well as population, which is what makes the widening
    // legible rather than a stack of same-sized discs.
    const SHELL_SPACING = 7;   // retained: base unit for ring size
    const LEVEL_DROP    = 9;   // vertical gap between one level's ring and the next
    const anchors = new Map<string, THREE.Vector3>();
    const markers: LayoutMarker[] = [];
    const parentAngles = new Map<string, { theta: number; phi: number }>();

    /** Ring radius for a level: widens with depth, and with how many nodes must fit on it. */
    const ringRadius = (depth: number, count: number) =>
      depth === 0 && count <= 1 ? 0 : Math.max(SHELL_SPACING * (0.5 + depth * 0.55), count * 1.1);

    /*
     * CENTRED ON THE ORIGIN. Levels used to run from 0 down to -(maxDepth * LEVEL_DROP), so the
     * tree's centroid sat half its own height below the point the camera frames — Matt, 2026-08-21:
     * "the graph appears below the central focus of the screen and I needed to manually drag each
     * load." Centring costs one subtraction and removes the drag.
     *
     * Sign stays NEGATIVE-for-deeper here: three.js Y is up, so the root belongs at the top. (Its
     * 2D twin in rdf/hierarchy.ts needs the opposite sign, because canvas Y grows downward — that
     * mismatch is what put the 2D root at the BOTTOM.)
     */
    const span = maxDepth * LEVEL_DROP;
    const yOfDepth3D = (d: number) => (span / 2 - d * LEVEL_DROP) || 0;

    for (let d = 0; d <= maxDepth; d++) {
      const iris = byDepth.get(d) ?? [];
      const levelY = yOfDepth3D(d);

      if (d === 0) {
        // Roots share the top ring; a lone root sits at its centre.
        const r = ringRadius(0, iris.length);
        iris.forEach((iri, i) => {
          const theta = (2 * Math.PI * i) / iris.length;
          const key = iriToKey.get(iri);
          if (key) {
            anchors.set(key, new THREE.Vector3((r * Math.cos(theta)) || 0, levelY, (r * Math.sin(theta)) || 0));
            parentAngles.set(iri, { theta, phi: Math.PI / 2 });
          }
        });
      } else {
        const r = ringRadius(d, iris.length);
        // Group children by parent for sector allocation
        const groups = new Map<string, string[]>();
        for (const iri of iris) {
          const p = parentOf.get(iri) ?? '__orphan__';
          if (!groups.has(p)) groups.set(p, []);
          groups.get(p)!.push(iri);
        }

        const totalChildren = iris.length;
        for (const [pIri, children] of groups) {
          const pAngle = parentAngles.get(pIri) ?? { theta: 0, phi: Math.PI / 2 };
          const sector = (2 * Math.PI * children.length) / Math.max(totalChildren, 1);
          const startTheta = pAngle.theta - sector / 2;

          // Children keep their parent's BEARING around the ring, so a branch descends in one
          // direction instead of scattering. Elevation is no longer a free axis to spread across:
          // it now means depth, and nudging a node off its level would misreport its position in
          // the tree — the one thing this layout exists to show.
          children.forEach((iri, i) => {
            const theta = children.length === 1
              ? pAngle.theta
              : startTheta + (i + 0.5) * (sector / children.length);

            const key = iriToKey.get(iri);
            if (key) {
              anchors.set(
                key,
                new THREE.Vector3((r * Math.cos(theta)) || 0, levelY, (r * Math.sin(theta)) || 0),
              );
              parentAngles.set(iri, { theta, phi: pAngle.phi });
            }
          });
        }
      }

      // One label per level, sitting AT that level. These were all pinned to the origin, which
      // read correctly when a level was a shell around it; with levels stacked, every label would
      // pile up at the top ring and name the wrong rings.
      if (d > 0) {
        markers.push({
          key: `hierarchy-ring-${d}`,
          pos: new THREE.Vector3(0, levelY, 0),
          label: `Layer ${maxDepth - d}`,
          color: '#f59e0b',
          kind: 'cluster'
        });
      }
    }

    // Nodes the hierarchy says nothing about get their own ring below the cone — not an outer
    // shell, which would wrap the whole tree and read as its deepest, widest level. They are
    // unplaced, not subordinate. Also no longer randomized: a layout that moves every time it is
    // recomputed cannot be read, and jitter here was hiding that these nodes have no place at all.
    const placedKeys = new Set(anchors.keys());
    const unplaced = nodes.filter(n => !placedKeys.has(n.key));
    if (unplaced.length > 0) {
      // Bounded concentric rings — see the 2D twin in rdf/hierarchy.ts. Sizing ONE ring by
      // population put hundreds of unplaced nodes on a radius of ~700 against level rings of 7-20,
      // so the tree shrank to a dot and the simulation had to settle bodies across a hundred times
      // the useful area. That presents as a frozen graph, not as a bad-looking one.
      // Below the tree — which in a y-up scene means a SMALLER y. Unplaced, not superior to the root.
      const orphanY = yOfDepth3D(maxDepth + 1.6);
      const PER_RING = 24;
      unplaced.forEach((n, i) => {
        const ring = Math.floor(i / PER_RING);
        const idx = i % PER_RING;
        const inRing = Math.min(PER_RING, unplaced.length - ring * PER_RING);
        const r = SHELL_SPACING * (1 + ring * 0.6);
        const theta = (2 * Math.PI * idx) / inRing;
        anchors.set(n.key, new THREE.Vector3(
          (r * Math.cos(theta)) || 0,
          orphanY,
          (r * Math.sin(theta)) || 0,
        ));
      });
    }

    return { anchors, markers };
  }

  // The canonical list lives in rdf/parse-date.ts so the timeline, the age sweep and the
  // layout rule cannot drift apart — there were three copies of it until 2026-08-13.
  const TIMELINE_PREDICATES = EVENT_DATE_PREDICATES;

  function buildTimelineAnchors(): { anchors: Map<string, THREE.Vector3>; markers: LayoutMarker[] } {
    const nodeTime = buildNodeTimes(
      statements as Statement[],
      timelineTimeSource === 'ingested' ? 'ingested' : 'event',
    );

    // The two branches here used to be byte-identical (`if (useIngested) A else if
    // (!useIngested) A`), and both applied the createdAt fallback — so in EVENT mode every
    // undated node was placed at its ingestion time. One shared rule now, and in event mode
    // an undated node is deliberately absent from the map so it lands in the lane below.
    const range = timelineRange(nodeTime);
    if (!range) return { anchors: new Map(), markers: [] };
    const { dataMin, dataRange } = range;

    // Visible range narrows as zoom increases
    const visibleRange = dataRange / timelineZoom;
    const center = timelineCenter ?? (dataMin + dataRange / 2);
    const viewMin = center - visibleRange / 2;
    const viewMax = center + visibleRange / 2;

    const SPREAD_X = 40;
    const SPREAD_Y = 12;

    const anchors = new Map<string, THREE.Vector3>();
    for (const n of nodes) {
      const t = nodeTime.get(n.key);
      if (t !== undefined) {
        const frac = (t - viewMin) / (viewMax - viewMin);
        const x = (frac - 0.5) * SPREAD_X;
        const hash = n.key.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
        const y = ((hash % 100) / 100 - 0.5) * SPREAD_Y;
        anchors.set(n.key, new THREE.Vector3(x, y, 0));
      } else {
        // UNDATED LANE — must clear the ±SPREAD_Y/2 band the dated nodes occupy, and spread
        // over enough rows that 165 nodes are not shoulder to shoulder. Kept identical to the
        // 2D renderer so switching views does not move a node.
        const hash = n.key.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
        const ux = ((hash % 997) / 997 - 0.5) * SPREAD_X;
        const row = (hash >> 3) % 5;
        anchors.set(n.key, new THREE.Vector3(ux, -SPREAD_Y * 1.15 - row * 1.5, 0));
      }
    }

    // Adaptive tick marks based on visible range
    const markers: LayoutMarker[] = [];
    const MS_HOUR = 3600000;
    const MS_DAY = 86400000;
    const MS_WEEK = MS_DAY * 7;
    const MS_MONTH = MS_DAY * 30;
    const MS_YEAR = MS_DAY * 365;

    // Pick tick interval + format based on visible range
    let tickInterval: number;
    let formatTick: (d: Date) => string;

    if (visibleRange <= MS_DAY * 2) {
      // ≤2 days: show hours
      tickInterval = MS_HOUR * (visibleRange <= MS_HOUR * 12 ? 1 : 3);
      formatTick = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } else if (visibleRange <= MS_WEEK * 2) {
      // ≤2 weeks: show days
      tickInterval = MS_DAY;
      formatTick = (d) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    } else if (visibleRange <= MS_MONTH * 3) {
      // ≤3 months: show weeks
      tickInterval = MS_WEEK;
      formatTick = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } else if (visibleRange <= MS_YEAR * 2) {
      // ≤2 years: show months
      tickInterval = MS_MONTH;
      formatTick = (d) => d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    } else {
      // >2 years: show years
      tickInterval = MS_YEAR;
      formatTick = (d) => d.getFullYear().toString();
    }

    // Snap first tick to a clean boundary
    const firstTick = Math.ceil(viewMin / tickInterval) * tickInterval;
    let idx = 0;
    for (let ts = firstTick; ts <= viewMax; ts += tickInterval) {
      const frac = (ts - viewMin) / (viewMax - viewMin);
      const x = (frac - 0.5) * SPREAD_X;
      markers.push({
        key: `timeline-${idx++}`,
        pos: new THREE.Vector3(x, -SPREAD_Y * 0.5 - 1.5, 0),
        label: formatTick(new Date(ts)),
        color: '#7a8a9d',
        kind: 'sector'
      });
    }

    return { anchors, markers };
  }

  // Rebuild layout anchors whenever layout mode or relevant graph data changes
  $effect(() => {
    reheat(); // anchors are about to move, so the nodes have somewhere new to go
    if (layout === 'focus') {
      const { anchors, radii, distances } = buildFocusAnchors();
      activeAnchors = anchors;
      layoutRingRadii = radii;
      layoutMarkers = [];
      focusDistances = distances;
      anchorStrength = 0.72;
      nodeColorMap = new Map();
      hubNodeKeys = [];
    } else if (layout === 'source') {
      const { anchors, markers, nodeColors } = buildSourceAnchors();
      activeAnchors = anchors;
      layoutMarkers = markers;
      layoutRingRadii = [];
      anchorStrength = 0.80;
      nodeColorMap = nodeColors;
      hubNodeKeys = [];
    } else if (layout === 'type') {
      const { anchors, markers } = buildTypeAnchors();
      activeAnchors = anchors;
      layoutMarkers = markers;
      layoutRingRadii = [];
      anchorStrength = 0.82;
      nodeColorMap = new Map(); // type colors come from typeDef, no override needed
      hubNodeKeys = [];
    } else if (layout === 'hub') {
      const { anchors, markers, nodeColors, hubKeys } = buildHubAnchors();
      activeAnchors = anchors;
      layoutMarkers = markers;
      layoutRingRadii = [];
      anchorStrength = 0.78;
      nodeColorMap = nodeColors;
      hubNodeKeys = hubKeys;
    } else if (layout === 'timeline') {
      // Reference zoom/center/timeSource so the effect re-runs when they change
      void timelineZoom; void timelineCenter; void timelineTimeSource;
      const { anchors, markers } = buildTimelineAnchors();
      activeAnchors = anchors;
      layoutMarkers = markers;
      layoutRingRadii = [];
      anchorStrength = 0.85;
      nodeColorMap = new Map();
      hubNodeKeys = [];
    } else if (layout === 'hierarchy') {
      const { anchors, markers } = buildHierarchyAnchors3D();
      activeAnchors = anchors;
      // Hierarchy coordinates encode stated depth. Snap to them once on entry so alpha cooling
      // cannot stop a large graph halfway between its prior free layout and its actual tree.
      for (const node of nodes) {
        const anchor = anchors.get(node.key);
        if (!anchor) continue;
        node.pos.copy(anchor);
        node.vel.set(0, 0, 0);
      }
      fitHierarchyCamera3D(anchors);
      layoutMarkers = markers;
      layoutRingRadii = [];
      anchorStrength = 0.85;
      nodeColorMap = new Map();
      hubNodeKeys = [];
    } else {
      activeAnchors = new Map();
      layoutMarkers = [];
      layoutRingRadii = [];
      focusDistances = new Map();
      nodeColorMap = new Map();
      hubNodeKeys = [];
    }
  });

  const MAX_EDGES = 2000;
  const linePositions = new Float32Array(MAX_EDGES * 6);
  const hlLinePositions = new Float32Array(MAX_EDGES * 6); // highlighted edges (selected node)
  let lineGeomHl: THREE.BufferGeometry | undefined = $state();
  let reportedReady = false;

  // Attach position attributes imperatively with a direct THREE import — survives
  // minification, unlike <T.BufferAttribute> (see comment at the template markup).
  $effect(() => {
    if (lineGeom && !lineGeom.getAttribute('position')) {
      lineGeom.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
    }
    if (lineGeomHl && !lineGeomHl.getAttribute('position')) {
      lineGeomHl.setAttribute('position', new THREE.BufferAttribute(hlLinePositions, 3));
    }
  });
  let _labelFrame = 0;

  /* ── COOLING SCHEDULE (F141) — see the long note in KnowledgeGraph2D.svelte ─────
   *
   * Same defect, same fix, and this is the renderer that matters most because 3D is the DEFAULT
   * (settings.prefer2D is false). Measured on a production build, RTX 3090: 110 lines took 8.7s to
   * settle, 451 lines never settled inside 45s. There was no termination condition — only a constant
   * per-frame DAMP, with forces re-injecting energy forever.
   *
   * Alpha scales the FORCES only; damping and position integration keep raw dt. Below the floor the
   * physics is skipped entirely, so a settled graph stops costing an O(n^2) repulsion pass per frame.
   */
  const SIM_ALPHA_DECAY = 0.0228;
  // The final 0.05 -> 0.001 tail consumes ~170 additional frames while contributing only the
  // last 5% of the force integral. Stop at the perceptual floor instead: the layout keeps 95% of
  // its convergence work but reaches an actual idle state in ~2.2s at 60Hz rather than ~5s.
  const SIM_ALPHA_MIN   = 0.05;
  let simAlpha = 1;
  let reportedSettled = false;
  let lastEmittedSettled: boolean | null = null;
  function emitSettled(settled: boolean) {
    if (lastEmittedSettled === settled) return;
    lastEmittedSettled = settled;
    onsettledchange(settled);
  }
  /** Put energy back only when the layout problem genuinely changed — see reheat() in the 2D file. */
  function reheat(to = 1) {
    simAlpha = Math.max(simAlpha, to);
    if (simAlpha >= SIM_ALPHA_MIN) {
      reportedSettled = false;
      // Publish the initial cooling state too. A newly-mounted renderer can inherit a parent's
      // prior `true` value (for example compare -> preview), even though this local simulation has
      // never settled. Only flipping after a local true report leaves that parent probe stale.
      emitSettled(false);
    }
  }

  useTask((delta) => {
    recordFrame(delta);
    const dt = Math.min(delta, 0.05);
    // Skip the whole simulation once cooled: a settled graph must not run an O(n^2) repulsion
    // pass every frame forever. This is the gate that turns "finished" into "stopped".
    if (simAlpha >= SIM_ALPHA_MIN) {
    /** Force timestep, scaled by the cooling schedule. Damping and integration use raw dt. */
    const fdt = dt * simAlpha;
    const REPEL      = 1.6;
    const SPRING     = layout === 'force' ? 0.18 : 0.10;
    const CENTER     = activeAnchors.size > 0 ? 0.008 : 0.04;
    const DAMP       = 0.86;
    const BASE_REST  = 2.4;
    const LOCK_TIMELINE_X = layout === 'timeline';
    const LOCK_HIERARCHY_Y = layout === 'hierarchy';

    // F133 — how much world room each node needs THIS FRAME.
    //
    // Computed once, up front, and then held fixed for the whole frame. Two things depend on it
    // and they must agree: the edge springs below (so they WANT the spread) and the collision pass
    // at the end (so it enforces it). Recomputing per relaxation pass makes the solver chase
    // itself, because a node pushed further from the camera immediately demands more room.
    const collageOn = !!previewKeys && previewKeys.size > 0 && !!camera.current && !!renderer;
    const radii = new Map<string, number>();
    if (collageOn) {
      const camPos = camera.current!.position;
      const halfH = renderer!.domElement.clientHeight * 0.5;
      for (const n of nodes) {
        const base = (0.85 + 0.45 * Math.log2(1 + n.degree)) * 0.32;
        radii.set(
          n.key,
          previewKeys!.has(n.key)
            // A thumbnail is a fixed pixel size, so the world room it needs grows with camera
            // distance — which is what keeps the separation honest at every zoom, not just one.
            ? Math.max(base, previewWorldRadius(previewSizePx, camPos.distanceTo(n.pos), halfH))
            : base,
        );
      }
    }
    const radiusOf = (n: { key: string }) => radii.get(n.key) ?? 0.32;

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.pos.x - b.pos.x, dy = a.pos.y - b.pos.y, dz = a.pos.z - b.pos.z;
        const d2 = dx * dx + dy * dy + dz * dz + 0.01;
        const f = REPEL / d2, inv = 1 / Math.sqrt(d2);
        a.vel.x += dx * inv * f * fdt; a.vel.y += dy * inv * f * fdt; a.vel.z += dz * inv * f * fdt;
        b.vel.x -= dx * inv * f * fdt; b.vel.y -= dy * inv * f * fdt; b.vel.z -= dz * inv * f * fdt;
      }
    }

    for (const e of edges) {
      const dx = e.b.pos.x - e.a.pos.x, dy = e.b.pos.y - e.a.pos.y, dz = e.b.pos.z - e.a.pos.z;
      const d = Math.hypot(dx, dy, dz) + 0.001;
      // F133: a spring whose rest length is shorter than the room its two nodes need will pull
      // them back into each other for as long as the modifier is on, and the collision pass spends
      // every frame undoing it — a tug-of-war that settles with visible overlap rather than
      // converging. Lengthening the rest so it never asks for less than the nodes occupy makes the
      // two agree, so the spread is where the layout WANTS to be instead of where it is forced.
      let rest = BASE_REST * e.semanticDist;
      if (collageOn) rest = Math.max(rest, radiusOf(e.a) + radiusOf(e.b));
      const f = (d - rest) * SPRING;
      e.a.vel.x += (dx / d) * f * fdt * 8; e.a.vel.y += (dy / d) * f * fdt * 8; e.a.vel.z += (dz / d) * f * fdt * 8;
      e.b.vel.x -= (dx / d) * f * fdt * 8; e.b.vel.y -= (dy / d) * f * fdt * 8; e.b.vel.z -= (dz / d) * f * fdt * 8;
    }

    for (const n of nodes) {
      // Anchor attraction for structured layouts
      if (activeAnchors.size > 0) {
        const anchor = activeAnchors.get(n.key);
        if (anchor) {
          n.vel.x += (anchor.x - n.pos.x) * anchorStrength * fdt;
          n.vel.y += (anchor.y - n.pos.y) * anchorStrength * fdt;
          n.vel.z += (anchor.z - n.pos.z) * anchorStrength * fdt;
        }
      }
      n.vel.x += -n.pos.x * CENTER * fdt;
      n.vel.y += -n.pos.y * CENTER * fdt;
      n.vel.z += -n.pos.z * CENTER * fdt;
      n.vel.multiplyScalar(DAMP);
      n.pos.x += n.vel.x; n.pos.y += n.vel.y; n.pos.z += n.vel.z;

      // TIMELINE: x IS THE DATE — data, not a force outcome. Repulsion, edge springs (×8) and
      // centering all act on x too, so an anchored node only ever settled NEAR its date and the
      // axis could not be read against its own markers. Pin x to the anchor and let the other
      // forces spread nodes vertically instead. Tuning the constants can never fix this; the
      // date axis has to be authoritative, not negotiated.
      if (LOCK_TIMELINE_X) {
        const dateAnchor = activeAnchors.get(n.key);
        if (dateAnchor) { n.pos.x = dateAnchor.x; n.vel.x = 0; }
      }
      if (LOCK_HIERARCHY_Y) {
        const hierarchyAnchor = activeAnchors.get(n.key);
        if (hierarchyAnchor) { n.pos.y = hierarchyAnchor.y; n.vel.y = 0; }
      }
    }

    // F133 ALL-PREVIEWS MODIFIER — make room for what the nodes are showing.
    //
    // Runs AFTER integration and after the timeline x-lock, so it corrects positions rather than
    // negotiating with the other forces. That ordering is the point: repulsion above is size-blind
    // (one REPEL constant for every node regardless of what it renders), so previews would settle
    // wherever the springs balanced and simply overlap. "All visible" is a property, and a
    // property that must hold gets asserted, not approached — the same reason the date axis is
    // pinned rather than tuned.
    if (collageOn) {
      // The camera's right and up vectors, pulled from its world matrix. Separation happens in
      // THIS plane: pushing two nodes apart along the view axis satisfies the arithmetic and
      // changes nothing a viewer can see, which is exactly how the first version converged while
      // still painting a pile.
      const m = camera.current!.matrixWorld.elements;
      const basis = {
        right: { x: m[0], y: m[1], z: m[2] },
        up: { x: m[4], y: m[5], z: m[6] },
      };
      resolveOverlaps(
        nodes,
        radiusOf,
        // Full strength, iterated to convergence. Easing (0.35, one pass) measurably lost to the
        // edge springs: on the 9-photo fixture it reported 16 overlapping pairs every frame and
        // painted a pile. Running last in the frame and converging is what turns "spread out a
        // bit" into the property the feature is named for.
        { lockX: LOCK_TIMELINE_X, strength: 1, iterations: 12, basis },
      );
    }

    // Cool. Below the floor everything above — repulsion, springs, integration and the F133
    // collage correction — stops running. Edge geometry below still updates, so the last frame
    // rendered is the settled one.
    simAlpha += (0 - simAlpha) * SIM_ALPHA_DECAY;
    if (simAlpha < SIM_ALPHA_MIN) simAlpha = 0;
    } // end if (simAlpha >= SIM_ALPHA_MIN) — cooled, simulation at rest
    if (simAlpha === 0 && !reportedSettled) {
      reportedSettled = true;
      emitSettled(true);
    }

    if (lineGeom) {
      const limit = Math.min(edges.length, MAX_EDGES);
      let hlCount = 0;
      for (let i = 0; i < limit; i++) {
        const e = edges[i];
        linePositions[i * 6]     = e.a.pos.x; linePositions[i * 6 + 1] = e.a.pos.y; linePositions[i * 6 + 2] = e.a.pos.z;
        linePositions[i * 6 + 3] = e.b.pos.x; linePositions[i * 6 + 4] = e.b.pos.y; linePositions[i * 6 + 5] = e.b.pos.z;
        // Collect edges connected to the selected node
        if (selected && (e.a.key === selected || e.b.key === selected) && hlCount < MAX_EDGES) {
          hlLinePositions[hlCount * 6]     = e.a.pos.x; hlLinePositions[hlCount * 6 + 1] = e.a.pos.y; hlLinePositions[hlCount * 6 + 2] = e.a.pos.z;
          hlLinePositions[hlCount * 6 + 3] = e.b.pos.x; hlLinePositions[hlCount * 6 + 4] = e.b.pos.y; hlLinePositions[hlCount * 6 + 5] = e.b.pos.z;
          hlCount++;
        }
      }
      const attr = lineGeom.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (attr) { attr.needsUpdate = true; lineGeom.setDrawRange(0, limit * 2); }
      if (lineGeomHl) {
        const hlAttr = lineGeomHl.getAttribute('position') as THREE.BufferAttribute | undefined;
        if (hlAttr) { hlAttr.needsUpdate = true; lineGeomHl.setDrawRange(0, hlCount * 2); }
      }
    }

    // Camera smoothly follows the selected node
    if (selected) {
      const sn = nodes.find(n => n.key === selected);
      if (sn) { cameraTarget.lerp(sn.pos, 0.06); if (orbitRef?.target) orbitRef.target.copy(cameraTarget); }
    }

    if (renderer && camera.current) {
      const canvas = renderer.domElement;
      const cam = camera.current as THREE.PerspectiveCamera;
      const canvasWidth = canvas.clientWidth;
      const canvasHeight = canvas.clientHeight;
      const aspect = cam.isPerspectiveCamera ? cam.aspect : 0;
      if (
        canvasWidth !== previousCanvasWidth ||
        canvasHeight !== previousCanvasHeight ||
        Math.abs(aspect - previousCameraAspect) > 0.0001
      ) {
        previousCanvasWidth = canvasWidth;
        previousCanvasHeight = canvasHeight;
        previousCameraAspect = aspect;
        // Hierarchy framing depends on the limiting horizontal/vertical FOV. Re-fit after a
        // renderer resize (including rotation and split panes) without reheating the simulation.
        if (layout === 'hierarchy' && activeAnchors.size > 0) {
          fitHierarchyCamera3D(activeAnchors);
        }
      }

      if (!reportedReady && nodes.length > 0 && canvas.width > 0 && canvas.height > 0) {
        reportedReady = true;
        // Threlte renders after its update tasks. Report on the following
        // browser frame so this signal cannot mean only "the branch mounted".
        requestAnimationFrame(onready);
      }

      // Project selected node for overlay positioning
      if (selected) {
        const sn = nodes.find(n => n.key === selected);
        if (sn) {
          projVec.copy(sn.pos).project(camera.current);
          onnodemove(selected, (projVec.x * 0.5 + 0.5) * canvas.clientWidth, (-projVec.y * 0.5 + 0.5) * canvas.clientHeight);
        }
      }

      // Project hovered node for label tooltip
      if (targetKey) {
        const hn = nodes.find(n => n.key === targetKey);
        if (hn) {
          projVec.copy(hn.pos).project(camera.current);
          onhovermove(targetKey, hn.label, (projVec.x * 0.5 + 0.5) * canvas.clientWidth, (-projVec.y * 0.5 + 0.5) * canvas.clientHeight);
        } else {
          onhovermove(null, null, 0, 0);
        }
      } else {
        onhovermove(null, null, 0, 0);
      }

      // Project layout markers for HTML labels.
      // Hub mode: project actual node positions (dynamic); source/type: project anchor positions.
      if (layout === 'hub' && hubNodeKeys.length > 0) {
        const projected = hubNodeKeys.flatMap(key => {
          const n = nodes.find(nd => nd.key === key);
          if (!n) return [];
          projVec.copy(n.pos).project(camera.current);
          return [{ key, label: n.label, color: nodeColorMap.get(key) ?? '#ff6b35',
            x: (projVec.x * 0.5 + 0.5) * canvas.clientWidth,
            y: (-projVec.y * 0.5 + 0.5) * canvas.clientHeight }];
        });
        onmarkersmove(projected);
      } else if (layoutMarkers.length > 0) {
        // For timeline layout, include sector markers (date labels) in the projection
        const showSectors = layout === 'timeline';
        const projected = layoutMarkers
          .filter(m => showSectors ? m.kind === 'sector' : m.kind !== 'sector')
          .map(m => {
            projVec.set(m.pos.x, m.pos.y, m.pos.z).project(camera.current);
            return { key: m.key, label: m.label, color: m.color,
              x: (projVec.x * 0.5 + 0.5) * canvas.clientWidth,
              y: (-projVec.y * 0.5 + 0.5) * canvas.clientHeight };
          });
        onmarkersmove(projected);
      } else {
        onmarkersmove([]);
      }

      // Project all nodes for always-visible labels (every 2nd frame for performance).
      // Single pass: compute rawDist, adjDist, and screen-space sphere radius for each node.
      // Labels are then filtered by: distance cutoff → sphere occlusion → proximity dedup → opacity.
      // Hub nodes get an adjDist discount so they stay labelled at greater distances.
      _labelFrame = (_labelFrame + 1) % 2;
      if (_labelFrame === 0) {
        const camPos = camera.current.position;
        // tan(fov/2) for fov=55°; used to project world radius → screen pixels.
        const CAM_HALF_TAN = Math.tan(27.5 * Math.PI / 180);
        const halfH = canvas.clientHeight * 0.5;

        type NodeScreen = {
          key: string; label: string;
          sx: number; sy: number;
          rawDist: number; adjDist: number;
          screenRadius: number; // estimated px radius of node sphere silhouette
        };
        const allProjected: NodeScreen[] = [];

        for (const n of nodes) {
          projVec.copy(n.pos).project(camera.current);
          if (projVec.z > 1) continue; // behind camera
          const rawDist = camPos.distanceTo(n.pos);
          // Hubs with higher degree get a depth discount: divide by (1 + √degree).
          const adjDist = rawDist / (1 + Math.sqrt(n.degree));
          const sx = (projVec.x * 0.5 + 0.5) * canvas.clientWidth;
          const sy = (-projVec.y * 0.5 + 0.5) * canvas.clientHeight;
          // Screen radius: worldRadius / (tan(fov/2) * rawDist) * halfH
          const meshScale = 0.85 + 0.45 * Math.log2(1 + n.degree);
          const screenRadius = (meshScale * 0.32 / (CAM_HALF_TAN * rawDist)) * halfH;
          allProjected.push({ key: n.key, label: n.label, sx, sy, rawDist, adjDist, screenRadius });
        }

        if (allProjected.length > 0) {
          const adjs = allProjected.map(e => e.adjDist);
          const minAdj = Math.min(...adjs);
          const maxAdj = Math.max(...adjs);
          const adjRange = maxAdj - minAdj || 1;

          // Distance cutoff: keep candidates within 55% of adjusted-distance range.
          const cutoff = minAdj + adjRange * 0.55;

          // Sort candidates by adjDist ascending — most important processed first,
          // so hubs win proximity dedup against nearby leaf nodes.
          // F133: a node showing a preview is never a culling candidate. Previews are rendered by
          // the GraphLabels overlay, so a node dropped here paints NO THUMBNAIL — which is why
          // settings.alwaysShowPreviews ("always render entity preview images on nodes") did not
          // actually do that: the label pipeline culled most nodes long before the snippet ran, so
          // on a 9-photo graph exactly one label survived and it was the one node without a photo.
          // The thumbnail is the content the user asked to see, not an incidental annotation.
          const hasPreview = (k: string) => previewKeys != null && previewKeys.has(k);
          const candidates = allProjected
            .filter(e => e.adjDist <= cutoff || e.key === selected || e.key === targetKey || hasPreview(e.key))
            .sort((a, b) => a.adjDist - b.adjDist);

          // Separate rawDist-sorted list for the occlusion check (closer nodes first).
          const byRawDist = [...allProjected].sort((a, b) => a.rawDist - b.rawDist);

          // Labels render ~14px above node center in screen space (CSS translate offset).
          const LABEL_ABOVE = 14;
          const MIN_GAP = 62; // px — minimum screen-space gap between any two kept labels

          type LabelOut = { key: string; label: string; x: number; y: number; opacity: number };
          const kept: LabelOut[] = [];

          for (const entry of candidates) {
            // A preview node is "special" for the same reason the selected node is: it is being
            // shown deliberately. Occlusion and proximity dedup exist to stop TEXT from piling up;
            // applying them to a requested thumbnail silently drops the thing that was requested.
            // Overlap between the thumbnails themselves is the collision pass's job, not this one's.
            const isSpecial = entry.key === selected || entry.key === targetKey || hasPreview(entry.key);

            // 1. Sphere-occlusion: skip if the label position falls inside a closer node's sphere.
            if (!isSpecial) {
              const lx = entry.sx, ly = entry.sy - LABEL_ABOVE;
              let occluded = false;
              for (const closer of byRawDist) {
                if (closer.rawDist >= entry.rawDist) break; // all remaining are farther — stop
                if (closer.key === entry.key) continue;
                const dx = lx - closer.sx, dy = ly - closer.sy;
                const r = closer.screenRadius + 4;
                if (dx * dx + dy * dy < r * r) { occluded = true; break; }
              }
              if (occluded) continue;
            }

            // 2. Proximity dedup: skip if too close to an already-kept label.
            if (!isSpecial) {
              let tooClose = false;
              for (const k of kept) {
                const dx = entry.sx - k.x, dy = entry.sy - k.y;
                if (dx * dx + dy * dy < MIN_GAP * MIN_GAP) { tooClose = true; break; }
              }
              if (tooClose) continue;
            }

            // 3. Per-label opacity: near/important → 0.85, far/unimportant → 0.20.
            const t = (entry.adjDist - minAdj) / adjRange;
            const opacity = isSpecial ? 1.0 : Math.max(0.20, 0.85 - t * 0.65);
            kept.push({ key: entry.key, label: entry.label, x: entry.sx, y: entry.sy, opacity });
          }
          onlabelsmove(kept);
        } else {
          onlabelsmove([]);
        }
      }
    }
  });

  // ── Right-click drag for timeline scrubbing ──────────────────────────────
  $effect(() => {
    if (layout !== 'timeline') return;
    const canvas = renderer?.domElement;
    if (!canvas) return;

    let dragging = false;
    let startX = 0;
    let startCenter = 0;

    function onContextMenu(e: Event) { e.preventDefault(); }

    function onPointerDown(e: PointerEvent) {
      if (e.button !== 2) return; // right-click only
      dragging = true;
      startX = e.clientX;
      // Compute current data range for mapping pixel delta to time delta
      const nodeTime = new Map<string, number>();
      for (const st of statements as Statement[]) {
        if (st.status === 'rejected' || st.status === 'superseded') continue;
        if (timelineTimeSource === 'ingested') {
          const sk = termKey(st.s);
          if (!nodeTime.has(sk) && st.createdAt) nodeTime.set(sk, st.createdAt);
        } else {
          if (TIMELINE_PREDICATES.has(st.p.value)) {
            const ts = new Date(st.o.value).getTime();
            if (!isNaN(ts)) {
              const key = termKey(st.s);
              const existing = nodeTime.get(key);
              if (!existing || ts < existing) nodeTime.set(key, ts);
            }
          }
        }
      }
      const times = [...nodeTime.values()];
      if (times.length === 0) return;
      const dataMin = Math.min(...times);
      const dataMax = Math.max(...times);
      const dataRange = dataMax - dataMin || 1;
      startCenter = timelineCenter ?? (dataMin + dataRange / 2);
      canvas!.setPointerCapture(e.pointerId);
    }

    function onPointerMove(e: PointerEvent) {
      if (!dragging) return;
      const dx = e.clientX - startX;
      // Map pixel delta to time: canvas width ≈ SPREAD_X (40 world units) of visible range
      const nodeTime = new Map<string, number>();
      for (const st of statements as Statement[]) {
        if (st.status === 'rejected' || st.status === 'superseded') continue;
        if (timelineTimeSource === 'ingested') {
          const sk = termKey(st.s);
          if (!nodeTime.has(sk) && st.createdAt) nodeTime.set(sk, st.createdAt);
        } else {
          if (TIMELINE_PREDICATES.has(st.p.value)) {
            const ts = new Date(st.o.value).getTime();
            if (!isNaN(ts)) {
              const key = termKey(st.s);
              const existing = nodeTime.get(key);
              if (!existing || ts < existing) nodeTime.set(key, ts);
            }
          }
        }
      }
      const times = [...nodeTime.values()];
      if (times.length === 0) return;
      const dataMin = Math.min(...times);
      const dataMax = Math.max(...times);
      const dataRange = dataMax - dataMin || 1;
      const visibleRange = dataRange / timelineZoom;
      // Negative dx = dragged left = move forward in time
      const timeDelta = -(dx / canvas!.clientWidth) * visibleRange;
      ontimelinepan(startCenter + timeDelta);
    }

    function onPointerUp(e: PointerEvent) {
      if (!dragging) return;
      dragging = false;
      canvas!.releasePointerCapture(e.pointerId);
    }

    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);

    return () => {
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
    };
  });
</script>

<T.PerspectiveCamera makeDefault position={cameraPosition(cameraSpec ?? CAMERA_PRESETS.front)} fov={55} />
<OrbitControls bind:ref={orbitRef} enableDamping dampingFactor={0.08} />
<T.AmbientLight intensity={0.45} />
<T.DirectionalLight position={[6, 10, 4]} intensity={0.9} color="#ffd6b0" />
<T.PointLight position={[-8, -4, 6]} intensity={0.7} color="#6dd3c4" />

<!-- Edges (all — dimmed further when a node is selected) -->
<!-- Position attributes are set imperatively (see the $effect above): Threlte's
     <T.BufferAttribute> resolves the class by function NAME, which minification
     mangles — in production builds it attached the raw class instead of an
     instance, crashing the renderer (undefined .array → black graph). -->
<T.LineSegments>
  <T.BufferGeometry bind:ref={lineGeom} />
  <T.LineBasicMaterial color="#ff6b35" transparent opacity={selected ? 0.12 : 0.35} />
</T.LineSegments>

<!-- Highlighted edges (connected to selected node) -->
<T.LineSegments>
  <T.BufferGeometry bind:ref={lineGeomHl} />
  <T.LineBasicMaterial color="#6dd3c4" transparent opacity={0.9} linewidth={2} />
</T.LineSegments>

<!-- Nodes -->
{#each nodes as n (n.key)}
  <GraphNode
    node={n}
    typeDef={nodeTypeMap.get(n.key) ?? null}
    icon3dOverride={entityIcon3dMap.get(n.key) ?? null}
    selected={n.key === selected}
    highlighted={highlighted.includes(n.key)}
    dimMode={dimMode || isHistoryMode}
    focusHop={focusDistances.size > 0 ? (focusDistances.get(n.key) ?? null) : null}
    colorOverride={nodeColorMap.get(n.key) ?? null}
    tripleRank={nodeTypeRankMap.get(n.key) ?? 0.5}
    isLeapNode={leapKeys.has(n.key)}
    onhover={(k) => (isHistoryMode ? onhover(null) : onhover(k))}
    onclick={(e) => {
      if (isHistoryMode) return;
      e.stopPropagation();
      onselect(n.key === selected ? null : n.key, e.ctrlKey);
    }}
  />
{/each}

<!-- Concentric rings: focus (teal, hop-distance) and hub (orange, degree-band) -->
{#if layoutRingRadii.length > 0}
  {#each layoutRingRadii as r (r)}
    <T.Mesh>
      <T.TorusGeometry args={[r, 0.05, 6, 96]} />
      <T.MeshBasicMaterial color="#6dd3c4" transparent opacity={0.07} />
    </T.Mesh>
  {/each}
{/if}

<!-- Cluster markers (source / type layouts) and sector indicators (focus layout) -->
{#if layoutMarkers.length > 0}
  {#each layoutMarkers as m (m.key)}
    {#if m.kind === 'sector' && layout === 'timeline'}
      <!-- Timeline layout: tick mark on the time axis -->
      <T.Group position={[m.pos.x, m.pos.y, m.pos.z]}>
        <T.Mesh>
          <T.BoxGeometry args={[0.04, 1.0, 0.04]} />
          <T.MeshBasicMaterial color={m.color} transparent opacity={0.5} />
        </T.Mesh>
      </T.Group>
    {:else if m.kind === 'sector'}
      <!-- Focus layout: small predicate-direction indicator on the sector arc -->
      <T.Group position={[m.pos.x, m.pos.y, m.pos.z]}>
        <T.Mesh>
          <T.SphereGeometry args={[0.18, 6, 6]} />
          <T.MeshBasicMaterial color={m.color} transparent opacity={0.80} />
        </T.Mesh>
        <T.Mesh>
          <T.TorusGeometry args={[0.55, 0.04, 5, 20]} />
          <T.MeshBasicMaterial color={m.color} transparent opacity={0.35} />
        </T.Mesh>
      </T.Group>
    {:else if m.kind !== 'hub-node'}
      <!-- Source / type cluster anchor (hub-node skipped — the GraphNode mesh is already there) -->
      <T.Group position={[m.pos.x, m.pos.y, m.pos.z]}>
        <T.Mesh>
          <T.SphereGeometry args={[0.35, 8, 8]} />
          <T.MeshBasicMaterial color={m.color} transparent opacity={0.55} />
        </T.Mesh>
        <T.Mesh>
          <T.TorusGeometry args={[2.0, 0.055, 6, 48]} />
          <T.MeshBasicMaterial color={m.color} transparent opacity={0.10} />
        </T.Mesh>
      </T.Group>
    {/if}
  {/each}
{/if}

<!-- Timeline axis line -->
{#if layout === 'timeline' && layoutMarkers.length > 0}
  {@const axisY = layoutMarkers[0]?.pos.y ?? -7.5}
  <T.Group position={[0, axisY, 0]}>
    <T.Mesh>
      <T.BoxGeometry args={[42, 0.03, 0.03]} />
      <T.MeshBasicMaterial color="#7a8a9d" transparent opacity={0.4} />
    </T.Mesh>
  </T.Group>
{/if}
