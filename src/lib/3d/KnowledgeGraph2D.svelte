<script lang="ts">
  /**
   * KnowledgeGraph2D — canvas-based 2D force-directed graph.
   * Same prop interface as KnowledgeGraph.svelte so the parent can swap them.
   * Physics constants mirror the 3D version; camScale bridges the unit gap.
   */
  import { onMount, onDestroy } from 'svelte';
  import type { Statement } from '$lib/rdf/types';
  import { termKey, isIRI, isLit, isMetaPredicate } from '$lib/rdf/types';
  import { typeMap } from '$lib/stores/entity-types.svelte';
  import { RDF_TYPE, RDFS_LABEL, type EntityTypeDef, type GeometryName } from '$lib/rdf/entity-types';
  import { leapNodeKeys } from '$lib/rdf/kb-leap';
  import { icon2dOverrides } from '$lib/stores/icon2d-overrides.svelte';

  let {
    statements = [],
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
    nodeOrder = [] as string[],
    onselect = () => {},
    onhover = () => {},
    onnodemove = () => {},
    onhovermove = () => {},
    onmarkersmove = () => {},
    onlabelsmove = () => {},
    ontimelinepan = () => {},
    onreorder = (_order: string[]) => {}
  } = $props<{
    statements?: Statement[];
    selected?: string | null;
    highlighted?: string[];
    dimMode?: boolean;
    targetKey?: string | null;
    historyTimestamp?: number | null;
    sources?: any[];
    layout?: 'force' | 'focus' | 'source' | 'type' | 'hub' | 'timeline' | 'order';
    timelineZoom?: number;
    timelineCenter?: number | null;
    timelineTimeSource?: 'event' | 'ingested';
    nodeOrder?: string[];
    onselect?: (key: string | null, ctrlKey?: boolean) => void;
    onhover?: (key: string | null) => void;
    onnodemove?: (key: string, x: number, y: number) => void;
    onhovermove?: (key: string | null, label: string | null, x: number, y: number) => void;
    onmarkersmove?: (markers: Array<{ key: string; label: string; color: string; x: number; y: number }>) => void;
    onlabelsmove?: (labels: Array<{ key: string; label: string; x: number; y: number; opacity: number }>) => void;
    ontimelinepan?: (center: number) => void;
    onreorder?: (order: string[]) => void;
  }>();

  const isHistoryMode = $derived(historyTimestamp !== null);

  // ── Types ────────────────────────────────────────────────────────────────────
  type Node = {
    key: string; label: string;
    kind: 'concept' | 'literal';
    x: number; y: number; vx: number; vy: number;
    degree: number;
  };
  type Edge = { a: Node; b: Node; predicate: string; confidence: number; semanticDist: number; isSourceEdge?: boolean; };
  type Marker = { key: string; label: string; color: string; x: number; y: number; };

  // ── Graph data ───────────────────────────────────────────────────────────────
  // Plain (non-reactive) — mutated by effects + RAF loop
  let nodes: Node[] = [];
  let edges: Edge[] = [];
  const nodePositionCache = new Map<string, { x: number; y: number }>();

  const nodeTypeMap = $derived.by(() => {
    const map = new Map<string, EntityTypeDef>();
    const tm = typeMap();
    for (const st of statements as Statement[]) {
      if (st.p.value === RDF_TYPE && st.s.kind === 'iri') {
        const def = tm.get(st.o.value);
        if (def) map.set(termKey(st.s), def);
      }
    }
    // Source nodes → Document type
    const docType = tm.get('urn:kbase:type/Document');
    if (docType) {
      for (const src of sources as any[]) {
        map.set(`src:${src.id}`, docType);
      }
    }
    return map;
  });

  /** Set of node keys that have a KB Leap defined. */
  const leapKeys = $derived(leapNodeKeys(statements as Statement[]));

  /** Per-entity icon image URL — editor overrides take priority, then kpred:icon2d KB statements. */
  const entityIconUrlMap = $derived.by(() => {
    const map = new Map<string, string>();
    for (const st of statements as Statement[]) {
      if (st.p.value === 'urn:kbase:predicate/icon2d' && st.s.kind === 'iri' && st.o.kind === 'literal') {
        const url = st.o.value;
        if (url.startsWith('/') || url.startsWith('http') || url.startsWith('data:')) {
          map.set(termKey(st.s), url);
        }
      }
    }
    // Editor-level overrides take priority
    for (const [iri, url] of icon2dOverrides()) {
      map.set('i:' + iri, url);
    }
    return map;
  });

  /** Cache loaded Image objects for entity icon URLs. */
  const iconImageCache = new Map<string, HTMLImageElement>();
  function getIconImage(url: string): HTMLImageElement | null {
    const cached = iconImageCache.get(url);
    if (cached) return cached.complete ? cached : null;
    const img = new Image();
    img.src = url;
    iconImageCache.set(url, img);
    return null; // will be available next frame
  }

  function edgeDist(isLit: boolean, pred: string, conf: number): number {
    let d = 1.0;
    if (isLit)           d *= 0.70;
    if (pred === 'type') d *= 0.65;
    if (conf > 0.85)     d *= 0.88;
    else if (conf < 0.5) d *= 1.25;
    return d;
  }

  $effect(() => {
    const nodeMap = new Map<string, Node>();
    const e: Edge[] = [];
    for (const st of statements as Statement[]) {
      if (st.status === 'rejected' || st.status === 'superseded') continue;
      if (st.p.value === RDF_TYPE) {
        const k = termKey(st.s);
        if (!nodeMap.has(k) && st.s.kind === 'iri') {
          const label = st.s.value.split('/').pop() ?? st.s.value;
          const c = nodePositionCache.get(k);
          const x = c?.x ?? (Math.random() - 0.5) * 8;
          const y = c?.y ?? (Math.random() - 0.5) * 8;
          nodeMap.set(k, { key: k, label, kind: 'concept', x, y, vx: 0, vy: 0, degree: 0 });
        }
        continue;
      }
      // Metadata predicates are node properties, not graph edges
      if (isMetaPredicate(st.p.value)) continue;
      // rdfs:label sets the display name of the subject node, not an edge
      if (st.p.value === RDFS_LABEL && st.o.kind === 'literal') {
        const k = termKey(st.s);
        const existing = nodeMap.get(k);
        if (existing) {
          existing.label = st.o.value;
        } else if (st.s.kind === 'iri') {
          const c = nodePositionCache.get(k);
          const x = c?.x ?? (Math.random() - 0.5) * 8;
          const y = c?.y ?? (Math.random() - 0.5) * 8;
          nodeMap.set(k, { key: k, label: st.o.value, kind: 'concept', x, y, vx: 0, vy: 0, degree: 0 });
        }
        continue;
      }
      for (const term of [st.s, st.o]) {
        const k = termKey(term);
        if (!nodeMap.has(k)) {
          const label = isIRI(term) ? term.value.split('/').pop() ?? term.value
            : isLit(term) ? term.value.slice(0, 24) : `_:${term.value}`;
          const c = nodePositionCache.get(k);
          const x = c?.x ?? (Math.random() - 0.5) * 8;
          const y = c?.y ?? (Math.random() - 0.5) * 8;
          nodeMap.set(k, { key: k, label, kind: isIRI(term) ? 'concept' : 'literal', x, y, vx: 0, vy: 0, degree: 0 });
        }
      }
      const a = nodeMap.get(termKey(st.s))!;
      const b = nodeMap.get(termKey(st.o))!;
      a.degree++; b.degree++;
      const pred = st.p.value.split('/').pop() ?? st.p.value;
      e.push({ a, b, predicate: pred, confidence: st.confidence,
        semanticDist: edgeDist(!isIRI(st.o), pred, st.confidence) });
    }
    // ── Inject source document nodes + edges ──────────────────────────────────
    const entitySources = new Map<string, Set<string>>();
    for (const st of statements as Statement[]) {
      if (st.status === 'rejected' || st.status === 'superseded' || !st.sourceId) continue;
      for (const term of [st.s, st.o]) {
        if (term.kind !== 'iri') continue;
        const k = termKey(term);
        if (!nodeMap.has(k)) continue; // only visible entity nodes
        if (!entitySources.has(k)) entitySources.set(k, new Set());
        entitySources.get(k)!.add(st.sourceId);
      }
    }
    for (const src of sources as any[]) {
      const srcKey = `src:${src.id}`;
      const c = nodePositionCache.get(srcKey);
      const x = c?.x ?? (Math.random() - 0.5) * 12;
      const y = c?.y ?? (Math.random() - 0.5) * 12;
      nodeMap.set(srcKey, { key: srcKey, label: src.title ?? src.id, kind: 'concept', x, y, vx: 0, vy: 0, degree: 0 });
    }
    // One edge per unique (entity, source) pair
    for (const [nk, srcIds] of entitySources) {
      const entityNode = nodeMap.get(nk);
      if (!entityNode) continue;
      for (const sid of srcIds) {
        const srcNode = nodeMap.get(`src:${sid}`);
        if (!srcNode) continue;
        srcNode.degree++;
        e.push({ a: entityNode, b: srcNode, predicate: '◆source', confidence: 1.0, semanticDist: 2.5, isSourceEdge: true });
      }
    }

    nodes = [...nodeMap.values()];
    edges = e;
    rebuildLayout();
  });

  // Separate effect for layout/selection changes (nodes don't change, just anchors)
  $effect(() => {
    layout; selected; timelineZoom; timelineCenter; timelineTimeSource; // reactive deps
    rebuildLayout();
  });

  // ── Layout ───────────────────────────────────────────────────────────────────
  const SOURCE_COLORS = ['#1a9b8e', '#3d7cf5', '#e8534b', '#9b6ee0', '#e8b84b', '#5db876'];
  const HUB_COLORS   = ['#ff6b35', '#3d7cf5', '#9b6ee0', '#e8534b', '#e8b84b', '#5db876'];
  const FOCUS_R = 5.5; // world units — matches 3D

  let activeAnchors  = new Map<string, { x: number; y: number }>();
  let anchorStrength = 0.25;
  let markerData: Marker[] = [];
  let nodeColorMap   = new Map<string, string>();
  let hubNodeKeys: string[] = [];

  function rebuildLayout() {
    if (layout === 'focus') {
      activeAnchors  = buildFocusAnchors();
      anchorStrength = 0.72;
      markerData     = [];
      nodeColorMap   = new Map();
      hubNodeKeys    = [];
    } else if (layout === 'source') {
      const r = buildSourceAnchors();
      activeAnchors  = r.anchors; markerData = r.markers;
      anchorStrength = 0.80; nodeColorMap = r.nodeColors; hubNodeKeys = [];
    } else if (layout === 'type') {
      const r = buildTypeAnchors();
      activeAnchors  = r.anchors; markerData = r.markers;
      anchorStrength = 0.82; nodeColorMap = new Map(); hubNodeKeys = [];
    } else if (layout === 'hub') {
      const r = buildHubAnchors();
      activeAnchors  = r.anchors; markerData = r.markers;
      anchorStrength = 0.78; nodeColorMap = r.nodeColors; hubNodeKeys = r.hubKeys;
    } else if (layout === 'timeline') {
      const r = buildTimelineAnchors2D();
      activeAnchors = r.anchors; markerData = r.markers;
      anchorStrength = 0.85; nodeColorMap = new Map(); hubNodeKeys = [];
    } else if (layout === 'order') {
      activeAnchors  = buildOrderAnchors();
      anchorStrength = 0.90;
      markerData     = [];
      nodeColorMap   = new Map();
      hubNodeKeys    = [];
    } else {
      activeAnchors  = new Map(); markerData = []; nodeColorMap = new Map(); hubNodeKeys = [];
      anchorStrength = 0.25;
    }
  }

  const TIMELINE_PREDICATES_2D = new Set([
    'urn:kbase:predicate/scheduled-at', 'urn:kbase:predicate/ends-at',
    'urn:kbase:predicate/due-at', 'urn:kbase:predicate/created-at',
    'urn:kbase:meta/scheduled-at', 'urn:kbase:meta/ends-at',
    'urn:kbase:meta/due-at', 'urn:kbase:meta/created-at'
  ]);

  function buildTimelineAnchors2D(): { anchors: Map<string, { x: number; y: number }>; markers: Marker[] } {
    const nodeTime = new Map<string, number>();
    const useIngested = timelineTimeSource === 'ingested';

    if (!useIngested) {
      for (const st of statements as Statement[]) {
        if (st.status === 'rejected' || st.status === 'superseded') continue;
        if (!TIMELINE_PREDICATES_2D.has(st.p.value)) continue;
        const key = termKey(st.s);
        const ts = new Date(st.o.value).getTime();
        if (isNaN(ts)) continue;
        const existing = nodeTime.get(key);
        if (!existing || ts < existing) nodeTime.set(key, ts);
      }
    }

    // Ingested mode: use createdAt for all nodes; event mode: fallback only
    for (const st of statements as Statement[]) {
      if (st.status === 'rejected' || st.status === 'superseded') continue;
      const sk = termKey(st.s);
      const ok = termKey(st.o);
      if (!nodeTime.has(sk) && st.createdAt) nodeTime.set(sk, st.createdAt);
      if (!nodeTime.has(ok) && st.createdAt) nodeTime.set(ok, st.createdAt);
    }

    if (nodeTime.size === 0) return { anchors: new Map(), markers: [] };

    const times = [...nodeTime.values()];
    const dataMin = Math.min(...times);
    const dataMax = Math.max(...times);
    const dataRange = dataMax - dataMin || 1;
    const visibleRange = dataRange / timelineZoom;
    const center = timelineCenter ?? (dataMin + dataRange / 2);
    const viewMin = center - visibleRange / 2;
    const viewMax = center + visibleRange / 2;

    const SPREAD_X = 40;
    const SPREAD_Y = 12;

    const anchors = new Map<string, { x: number; y: number }>();
    for (const n of nodes) {
      const t = nodeTime.get(n.key);
      if (t !== undefined) {
        const frac = (t - viewMin) / (viewMax - viewMin);
        const x = (frac - 0.5) * SPREAD_X;
        const hash = n.key.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
        const y = ((hash % 100) / 100 - 0.5) * SPREAD_Y;
        anchors.set(n.key, { x, y });
      } else {
        anchors.set(n.key, { x: 0, y: -SPREAD_Y * 0.7 });
      }
    }

    // Adaptive tick marks
    const markers: Marker[] = [];
    const MS_HOUR = 3600000; const MS_DAY = 86400000;
    const MS_WEEK = MS_DAY * 7; const MS_MONTH = MS_DAY * 30; const MS_YEAR = MS_DAY * 365;
    let tickInterval: number;
    let formatTick: (d: Date) => string;

    if (visibleRange <= MS_DAY * 2) {
      tickInterval = MS_HOUR * (visibleRange <= MS_HOUR * 12 ? 1 : 3);
      formatTick = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } else if (visibleRange <= MS_WEEK * 2) {
      tickInterval = MS_DAY;
      formatTick = (d) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    } else if (visibleRange <= MS_MONTH * 3) {
      tickInterval = MS_WEEK;
      formatTick = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } else if (visibleRange <= MS_YEAR * 2) {
      tickInterval = MS_MONTH;
      formatTick = (d) => d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    } else {
      tickInterval = MS_YEAR;
      formatTick = (d) => d.getFullYear().toString();
    }

    const firstTick = Math.ceil(viewMin / tickInterval) * tickInterval;
    let idx = 0;
    for (let ts = firstTick; ts <= viewMax; ts += tickInterval) {
      const frac = (ts - viewMin) / (viewMax - viewMin);
      const x = (frac - 0.5) * SPREAD_X;
      markers.push({ key: `tl-${idx++}`, label: formatTick(new Date(ts)), color: '#7a8a9d', x, y: -SPREAD_Y * 0.5 - 1.5 });
    }

    return { anchors, markers };
  }

  function buildFocusAnchors(): Map<string, { x: number; y: number }> {
    if (!selected) return new Map();
    const dist = new Map<string, number>([[selected, 0]]);
    const queue = [selected]; let qi = 0;
    while (qi < queue.length) {
      const cur = queue[qi++]; const d = dist.get(cur)!;
      for (const e of edges) {
        const other = e.a.key === cur ? e.b.key : e.b.key === cur ? e.a.key : null;
        if (other && !dist.has(other)) { dist.set(other, d + 1); queue.push(other); }
      }
    }
    const anchors = new Map<string, { x: number; y: number }>([[selected, { x: 0, y: 0 }]]);
    const angleMap = new Map<string, number>();
    const maxD = dist.size > 0 ? Math.max(...dist.values()) : 0;

    const outGroups = new Map<string, string[]>(); const inGroups = new Map<string, string[]>();
    for (const e of edges) {
      if (e.a.key === selected && dist.get(e.b.key) === 1) {
        if (!outGroups.has(e.predicate)) outGroups.set(e.predicate, []);
        if (!outGroups.get(e.predicate)!.includes(e.b.key)) outGroups.get(e.predicate)!.push(e.b.key);
      }
      if (e.b.key === selected && dist.get(e.a.key) === 1) {
        if (!inGroups.has(e.predicate)) inGroups.set(e.predicate, []);
        if (!inGroups.get(e.predicate)!.includes(e.a.key)) inGroups.get(e.predicate)!.push(e.a.key);
      }
    }
    const outCount = [...outGroups.values()].reduce((s, a) => s + a.length, 0);
    const inCount  = [...inGroups.values()].reduce((s, a) => s + a.length, 0);
    const total    = outCount + inCount;
    if (total > 0) {
      const GAP = 0.30;
      let outArc: number, inArc: number, outStart: number, inStart: number;
      if (inCount === 0)  { outArc = 2*Math.PI; outStart = -Math.PI; inArc = 0; inStart = 0; }
      else if (outCount === 0) { inArc = 2*Math.PI; inStart = -Math.PI; outArc = 0; outStart = 0; }
      else {
        const fOut = Math.max(0.22, Math.min(0.78, outCount / total));
        outArc = fOut*(2*Math.PI)-GAP; inArc = (1-fOut)*(2*Math.PI)-GAP;
        outStart = Math.PI/2 - outArc/2; inStart = -Math.PI/2 - inArc/2;
      }
      const placeArc = (groups: Map<string, string[]>, tot: number, start: number, arc: number) => {
        let angle = start;
        for (const [, keys] of groups) {
          if (!keys.length) continue;
          const sector = arc * (keys.length / tot);
          const mid = angle + sector / 2;
          keys.forEach((k, i) => {
            const fa = keys.length === 1 ? mid : angle + (i + 0.5) * (sector / keys.length);
            anchors.set(k, { x: FOCUS_R*Math.cos(fa), y: FOCUS_R*Math.sin(fa) });
            angleMap.set(k, fa);
          });
          angle += sector;
        }
      };
      placeArc(outGroups, outCount, outStart, outArc);
      placeArc(inGroups,  inCount,  inStart,  inArc);
    }
    for (let hop = 2; hop <= maxD; hop++) {
      const hopNodes = [...dist.entries()].filter(([,d]) => d === hop).map(([k]) => k);
      const parentGroups = new Map<string, string[]>();
      for (const k of hopNodes) {
        let pk: string | null = null;
        for (const e of edges) {
          if (e.a.key === k && dist.get(e.b.key) === hop-1) { pk = e.b.key; break; }
          if (e.b.key === k && dist.get(e.a.key) === hop-1) { pk = e.a.key; break; }
        }
        const g = pk ?? '__none__';
        if (!parentGroups.has(g)) parentGroups.set(g, []);
        parentGroups.get(g)!.push(k);
      }
      const r = hop * FOCUS_R;
      for (const [pk, siblings] of parentGroups) {
        const base = pk === '__none__' ? 0 : (angleMap.get(pk) ?? 0);
        const fan  = Math.min(Math.PI*0.35, Math.PI*0.7/Math.max(siblings.length, 1));
        siblings.forEach((k, i) => {
          const fa = base + (siblings.length === 1 ? 0 : (i - (siblings.length-1)/2) * fan);
          anchors.set(k, { x: r*Math.cos(fa), y: r*Math.sin(fa) });
          angleMap.set(k, fa);
        });
      }
    }
    const unreachable = nodes.filter(n => !anchors.has(n.key));
    unreachable.forEach((n, i) => {
      const r2 = (maxD + 2.5) * FOCUS_R;
      const theta = (2*Math.PI*i) / Math.max(unreachable.length, 1);
      anchors.set(n.key, { x: r2*Math.cos(theta), y: r2*Math.sin(theta) });
    });
    return anchors;
  }

  function buildSourceAnchors() {
    // Find source nodes injected into the graph
    const srcNodes = nodes.filter(n => n.key.startsWith('src:'));
    if (!srcNodes.length) return { anchors: new Map<string, {x:number;y:number}>(), markers: [] as Marker[], nodeColors: new Map<string, string>() };

    // Arrange source nodes in a circle
    const R = srcNodes.length === 1 ? 0 : 16;
    const srcAnchor = new Map<string, { x: number; y: number }>();
    srcNodes.forEach((sn, i) => {
      const theta = (2 * Math.PI * i) / srcNodes.length - Math.PI / 2;
      srcAnchor.set(sn.key, { x: R * Math.cos(theta), y: R * Math.sin(theta) });
    });

    // Map sourceId → srcKey for lookup
    const sidToKey = new Map<string, string>();
    for (const sn of srcNodes) sidToKey.set(sn.key.slice(4), sn.key);

    // Map each entity node → its source IDs
    const nodeSrcs = new Map<string, Set<string>>();
    for (const st of statements as Statement[]) {
      if (st.status === 'rejected' || st.status === 'superseded' || !st.sourceId) continue;
      for (const term of [st.s, st.o]) {
        const k = termKey(term);
        if (k.startsWith('src:')) continue;
        if (!nodeSrcs.has(k)) nodeSrcs.set(k, new Set());
        nodeSrcs.get(k)!.add(st.sourceId);
      }
    }

    // Compute hub nodes for fallback
    const hubNodes = nodes
      .filter(n => !n.key.startsWith('src:'))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 5);
    const hubKeySet = new Set(hubNodes.map(h => h.key));

    const anchors = new Map<string, { x: number; y: number }>();
    const nodeColors = new Map<string, string>();

    // Place source nodes at circle positions
    for (const sn of srcNodes) {
      const pos = srcAnchor.get(sn.key)!;
      anchors.set(sn.key, pos);
      const idx = srcNodes.indexOf(sn);
      nodeColors.set(sn.key, SOURCE_COLORS[idx % SOURCE_COLORS.length]);
    }

    // Place entity nodes near their source(s)
    for (const [nk, srcs] of nodeSrcs) {
      let ax = 0, ay = 0, cnt = 0, firstColor = '';
      for (const sid of srcs) {
        const srcKey = sidToKey.get(sid);
        if (srcKey) {
          const a = srcAnchor.get(srcKey);
          if (a) { ax += a.x; ay += a.y; cnt++; }
          if (!firstColor) {
            const idx = srcNodes.findIndex(sn => sn.key === srcKey);
            if (idx >= 0) firstColor = SOURCE_COLORS[idx % SOURCE_COLORS.length];
          }
        }
      }

      // Fallback 1: cluster near a connected hub
      if (cnt === 0) {
        for (const e of edges) {
          if (e.isSourceEdge) continue;
          const other = e.a.key === nk ? e.b.key : e.b.key === nk ? e.a.key : null;
          if (other && hubKeySet.has(other)) {
            const ha = anchors.get(other);
            if (ha) { ax = ha.x; ay = ha.y; cnt = 1; break; }
          }
        }
      }

      // Fallback 2: center (cluster naturally via force)
      if (cnt === 0) { ax = 0; ay = 0; cnt = 1; }
      else { ax /= cnt; ay /= cnt; }

      anchors.set(nk, { x: ax, y: ay });
      if (firstColor) nodeColors.set(nk, firstColor);
    }

    const markers: Marker[] = srcNodes.map((sn, i) => ({
      key: sn.key, label: sn.label,
      color: SOURCE_COLORS[i % SOURCE_COLORS.length],
      x: srcAnchor.get(sn.key)!.x, y: srcAnchor.get(sn.key)!.y
    }));
    return { anchors, markers, nodeColors };
  }

  function buildTypeAnchors() {
    const tm = typeMap();
    const nodeTypeIri = new Map<string, string>();
    for (const st of statements as Statement[]) {
      if (st.status === 'rejected' || st.status === 'superseded') continue;
      if (st.p.value === RDF_TYPE && st.s.kind === 'iri') nodeTypeIri.set(termKey(st.s), st.o.value);
    }
    const typeList = [...new Set(nodeTypeIri.values())];
    if (!typeList.length) return { anchors: new Map<string, {x:number;y:number}>(), markers: [] as Marker[] };
    const R = typeList.length === 1 ? 0 : 18;
    const typeAnchor = new Map<string, { x: number; y: number }>();
    typeList.forEach((iri, i) => {
      const theta = (2*Math.PI*i)/typeList.length - Math.PI/2;
      typeAnchor.set(iri, { x: R*Math.cos(theta), y: R*Math.sin(theta) });
    });
    const anchors = new Map<string, { x: number; y: number }>();
    for (const n of nodes) {
      const iri = nodeTypeIri.get(n.key);
      anchors.set(n.key, iri && typeAnchor.has(iri) ? { ...typeAnchor.get(iri)! } : { x: 0, y: 0 });
    }
    const markers: Marker[] = typeList.map(iri => {
      const def = tm.get(iri); const p = typeAnchor.get(iri)!;
      return { key: iri, label: def?.label ?? iri.split('/').pop() ?? iri, color: def?.color ?? '#e8b84b', x: p.x, y: p.y };
    });
    return { anchors, markers };
  }

  // ── Order layout: grid positions based on nodeOrder array ───────────────────
  function buildOrderAnchors(): Map<string, { x: number; y: number }> {
    const anchors = new Map<string, { x: number; y: number }>();
    if (!nodeOrder.length) return anchors;
    // Lay out nodes in a grid, reading left-to-right then down
    const cols = Math.max(1, Math.ceil(Math.sqrt(nodeOrder.length * 1.5)));
    const spacing = 8; // world units between nodes
    for (let i = 0; i < nodeOrder.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const totalCols = Math.min(cols, nodeOrder.length - row * cols);
      const x = (col - (totalCols - 1) / 2) * spacing;
      const y = (row - Math.floor(nodeOrder.length / cols) / 2) * spacing;
      anchors.set(nodeOrder[i], { x, y });
    }
    return anchors;
  }

  function buildHubAnchors() {
    const empty = { anchors: new Map<string, {x:number;y:number}>(), markers: [] as Marker[], nodeColors: new Map<string, string>(), hubKeys: [] as string[] };
    if (!nodes.length) return empty;
    const sorted = [...nodes].sort((a, b) => b.degree - a.degree);
    const N = Math.min(6, sorted.filter(n => n.degree > 1).length);
    if (!N) return empty;
    const hubNodes  = sorted.slice(0, N);
    const hubKeySet = new Set(hubNodes.map(n => n.key));
    const R = N === 1 ? 0 : 16;
    const hubPos = new Map<string, { x: number; y: number }>();
    hubNodes.forEach((n, i) => {
      const theta = (2*Math.PI*i)/N - Math.PI/2;
      hubPos.set(n.key, { x: R*Math.cos(theta), y: R*Math.sin(theta) });
    });
    const nodeHubIdx = new Map<string, number>();
    for (const node of nodes) {
      if (hubKeySet.has(node.key)) continue;
      let bestIdx = 0, bestCnt = -1;
      hubNodes.forEach((hub, i) => {
        const cnt = edges.filter(e => (e.a.key === node.key && e.b.key === hub.key) || (e.b.key === node.key && e.a.key === hub.key)).length;
        if (cnt > bestCnt) { bestCnt = cnt; bestIdx = i; }
      });
      nodeHubIdx.set(node.key, bestIdx);
    }
    const anchors = new Map<string, { x: number; y: number }>();
    for (const hub of hubNodes) anchors.set(hub.key, hubPos.get(hub.key)!);
    for (const node of nodes) {
      if (hubKeySet.has(node.key)) continue;
      anchors.set(node.key, { ...hubPos.get(hubNodes[nodeHubIdx.get(node.key) ?? 0].key)! });
    }
    const nodeColors = new Map<string, string>();
    hubNodes.forEach((hub, i) => nodeColors.set(hub.key, HUB_COLORS[i % HUB_COLORS.length]));
    for (const node of nodes) {
      if (hubKeySet.has(node.key)) continue;
      nodeColors.set(node.key, HUB_COLORS[(nodeHubIdx.get(node.key) ?? 0) % HUB_COLORS.length]);
    }
    const markers: Marker[] = hubNodes.map((n, i) => ({
      key: n.key, label: n.label, color: HUB_COLORS[i % HUB_COLORS.length],
      x: hubPos.get(n.key)!.x, y: hubPos.get(n.key)!.y
    }));
    return { anchors, markers, nodeColors, hubKeys: hubNodes.map(n => n.key) };
  }

  // ── Canvas + camera ──────────────────────────────────────────────────────────
  let canvasEl = $state<HTMLCanvasElement | null>(null);
  // Camera: center of canvas = world origin (0,0); scale = px per world unit
  let camX = 0, camY = 0, camScale = 40;
  let prevW = 0, prevH = 0;
  // Cached viewport rect — updated once per tick to avoid repeated layout queries
  let _rect = { left: 0, top: 0, width: 0, height: 0 };

  function worldToScreen(wx: number, wy: number): { x: number; y: number } {
    // Returns viewport (fixed-position) coordinates using cached rect
    return {
      x: wx * camScale + _rect.width  / 2 + camX + _rect.left,
      y: wy * camScale + _rect.height / 2 + camY + _rect.top
    };
  }

  function nodeRadius(n: Node): number {
    return 5 + Math.min(4, Math.sqrt(n.degree));
  }

  /** Draw a 2D shape on ctx2d centered at (cx,cy) with half-size r. Path is open — caller fills/strokes. */
  function applyShape(ctx2d: CanvasRenderingContext2D, cx: number, cy: number, r: number, geom: GeometryName) {
    ctx2d.beginPath();
    switch (geom) {
      case 'sphere':
      case 'dodecahedron':
        // Circle
        ctx2d.arc(cx, cy, r, 0, Math.PI * 2);
        break;
      case 'box':
        // Square
        ctx2d.rect(cx - r, cy - r, r * 2, r * 2);
        break;
      case 'box-flat':
        // Wide flat rect (document)
        ctx2d.rect(cx - r * 1.5, cy - r * 0.55, r * 3, r * 1.1);
        break;
      case 'capsule':
      case 'cylinder': {
        // Tall rounded pill
        const pw = r * 0.72, ph = r * 1.35, rad = pw * 0.55;
        ctx2d.roundRect(cx - pw, cy - ph, pw * 2, ph * 2, rad);
        break;
      }
      case 'cone':
      case 'tetrahedron': {
        // Upward-pointing triangle
        const h3 = r * 1.15;
        ctx2d.moveTo(cx,          cy - h3);
        ctx2d.lineTo(cx + r,      cy + h3 * 0.55);
        ctx2d.lineTo(cx - r,      cy + h3 * 0.55);
        ctx2d.closePath();
        break;
      }
      case 'octahedron': {
        // Diamond
        ctx2d.moveTo(cx,      cy - r * 1.2);
        ctx2d.lineTo(cx + r,  cy);
        ctx2d.lineTo(cx,      cy + r * 1.2);
        ctx2d.lineTo(cx - r,  cy);
        ctx2d.closePath();
        break;
      }
      case 'icosahedron': {
        // Hexagon
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 3) * i - Math.PI / 6;
          i === 0 ? ctx2d.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
                  : ctx2d.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
        }
        ctx2d.closePath();
        break;
      }
      case 'torus': {
        // Ring — two arcs (outer fill minus inner)
        ctx2d.arc(cx, cy, r,        0, Math.PI * 2);
        ctx2d.moveTo(cx + r * 0.52, cy);
        ctx2d.arc(cx, cy, r * 0.52, 0, Math.PI * 2, true); // inner hole (counterclockwise)
        break;
      }
      case 'torus-knot': {
        // 6-point star
        const outer = r, inner = r * 0.45;
        for (let i = 0; i < 12; i++) {
          const a = (Math.PI / 6) * i - Math.PI / 2;
          const rr = i % 2 === 0 ? outer : inner;
          i === 0 ? ctx2d.moveTo(cx + rr * Math.cos(a), cy + rr * Math.sin(a))
                  : ctx2d.lineTo(cx + rr * Math.cos(a), cy + rr * Math.sin(a));
        }
        ctx2d.closePath();
        break;
      }
      default:
        ctx2d.arc(cx, cy, r, 0, Math.PI * 2);
    }
  }

  function draw(ctx2d: CanvasRenderingContext2D, w: number, h: number) {
    ctx2d.clearRect(0, 0, w, h);
    ctx2d.save();
    ctx2d.translate(w / 2 + camX, h / 2 + camY);
    ctx2d.scale(camScale, camScale);

    const isHistory = isHistoryMode;
    const baseAlpha = (dimMode || isHistory) ? 0.45 : 1.0;

    // Draw layout markers
    if (layout === 'timeline' && markerData.length > 0) {
      // Timeline: axis line + tick marks
      const axisY = markerData[0]?.y ?? -7.5;
      ctx2d.beginPath();
      ctx2d.moveTo(-21, axisY); ctx2d.lineTo(21, axisY);
      ctx2d.strokeStyle = '#7a8a9d'; ctx2d.lineWidth = 0.03;
      ctx2d.globalAlpha = 0.4 * baseAlpha; ctx2d.stroke();
      for (const m of markerData) {
        ctx2d.beginPath();
        ctx2d.moveTo(m.x, m.y - 0.5); ctx2d.lineTo(m.x, m.y + 0.5);
        ctx2d.strokeStyle = m.color; ctx2d.lineWidth = 0.04;
        ctx2d.globalAlpha = 0.5 * baseAlpha; ctx2d.stroke();
      }
    } else {
      // Standard cluster markers (rings)
      for (const m of markerData) {
        ctx2d.beginPath(); ctx2d.arc(m.x, m.y, 0.35, 0, Math.PI * 2);
        ctx2d.fillStyle = m.color; ctx2d.globalAlpha = 0.55 * baseAlpha; ctx2d.fill();
        ctx2d.beginPath(); ctx2d.arc(m.x, m.y, 2.0, 0, Math.PI * 2);
        ctx2d.strokeStyle = m.color; ctx2d.lineWidth = 0.055 / camScale * 40;
        ctx2d.globalAlpha = 0.10 * baseAlpha; ctx2d.stroke();
      }
    }

    // Edges
    for (const e of edges) {
      const isSel = selected && (e.a.key === selected || e.b.key === selected);
      const isHov = hoveredKey && (e.a.key === hoveredKey || e.b.key === hoveredKey);
      ctx2d.beginPath(); ctx2d.moveTo(e.a.x, e.a.y); ctx2d.lineTo(e.b.x, e.b.y);
      if (e.isSourceEdge) {
        ctx2d.strokeStyle = isSel ? 'rgba(96,165,250,0.45)' : isHov ? 'rgba(96,165,250,0.30)' : 'rgba(96,165,250,0.08)';
        ctx2d.lineWidth = (isSel ? 0.04 : 0.02) / camScale * 40;
      } else {
        ctx2d.strokeStyle = isSel ? 'rgba(255,107,53,0.65)' : isHov ? 'rgba(255,107,53,0.40)' : 'rgba(255,107,53,0.20)';
        ctx2d.lineWidth = (isSel ? 0.06 : 0.035) / camScale * 40;
      }
      ctx2d.globalAlpha = baseAlpha;
      ctx2d.stroke();
    }

    // Nodes
    const tm = nodeTypeMap;
    for (const n of nodes) {
      const r        = nodeRadius(n) / camScale * 40 * 0.1; // world units
      const isSel    = n.key === selected;
      const isHov    = n.key === hoveredKey;
      const isHL     = highlighted.includes(n.key);
      const isDimmed = dimMode && !isHL && !isSel;
      const typeDef  = tm.get(n.key);
      const overrideColor = nodeColorMap.get(n.key);
      const baseColor = overrideColor ?? typeDef?.color ?? (n.kind === 'literal' ? '#3d7cf5' : '#1a9b8e');
      const geom: GeometryName = typeDef?.geometry ?? (n.kind === 'literal' ? 'sphere' : 'octahedron');
      const drawR = isHov ? r * 1.25 : r;

      ctx2d.globalAlpha = isDimmed ? 0.18 * baseAlpha : baseAlpha;

      // Leap ring (amber dashed ring for KB Leap nodes)
      if (leapKeys.has(n.key)) {
        ctx2d.save();
        ctx2d.beginPath(); ctx2d.arc(n.x, n.y, r * 1.6, 0, Math.PI * 2);
        ctx2d.strokeStyle = '#f59e0b'; ctx2d.lineWidth = r * 0.18;
        ctx2d.setLineDash([r * 0.4, r * 0.25]);
        ctx2d.globalAlpha = 0.7 * baseAlpha; ctx2d.stroke();
        ctx2d.restore();
      }

      // Selection ring
      if (isSel) {
        ctx2d.beginPath(); ctx2d.arc(n.x, n.y, r * 1.8, 0, Math.PI * 2);
        ctx2d.strokeStyle = '#ff6b35'; ctx2d.lineWidth = r * 0.22;
        ctx2d.globalAlpha = 0.85 * baseAlpha; ctx2d.stroke();
      }

      // Node body — shape from entity type geometry
      const fillAlpha = isDimmed ? 0.22 * baseAlpha : (isHL ? 1.0 : 0.82) * baseAlpha;
      ctx2d.globalAlpha = fillAlpha;
      ctx2d.fillStyle = baseColor;
      if (geom === 'torus') {
        // Torus: fill the ring area using evenodd winding
        ctx2d.save();
        applyShape(ctx2d, n.x, n.y, drawR, 'torus');
        ctx2d.fill('evenodd');
        ctx2d.restore();
      } else {
        applyShape(ctx2d, n.x, n.y, drawR, geom);
        ctx2d.fill();
      }

      // Entity icon — per-entity image URL takes priority, then type emoji
      if (!isDimmed) {
        const iconUrl = entityIconUrlMap.get(n.key);
        const iconImg = iconUrl ? getIconImage(iconUrl) : null;
        if (iconImg) {
          const imgSize = drawR * 2.0;
          ctx2d.globalAlpha = baseAlpha * (isHov ? 1.0 : 0.88);
          ctx2d.drawImage(iconImg, n.x - imgSize / 2, n.y - imgSize / 2, imgSize, imgSize);
        } else if (typeDef?.icon2d) {
          const emojiSize = drawR * 1.35; // world units → font size
          ctx2d.globalAlpha = baseAlpha * (isHov ? 1.0 : 0.88);
          ctx2d.font = `${emojiSize}px serif`;
          ctx2d.textAlign = 'center';
          ctx2d.textBaseline = 'middle';
          ctx2d.fillStyle = 'white';
          ctx2d.fillText(typeDef.icon2d, n.x, n.y);
        }
      }

      // Order number badge
      if (layout === 'order') {
        const orderIdx = nodeOrder.indexOf(n.key);
        if (orderIdx !== -1) {
          const numStr = String(orderIdx + 1);
          const badgeR = r * 0.55;
          const bx = n.x + drawR * 0.75, by = n.y - drawR * 0.75;
          ctx2d.globalAlpha = 0.92 * baseAlpha;
          ctx2d.fillStyle = '#1a9b8e';
          ctx2d.beginPath(); ctx2d.arc(bx, by, badgeR, 0, Math.PI * 2); ctx2d.fill();
          ctx2d.fillStyle = '#fff';
          ctx2d.font = `bold ${badgeR * 1.3}px sans-serif`;
          ctx2d.textAlign = 'center'; ctx2d.textBaseline = 'middle';
          ctx2d.fillText(numStr, bx, by);
        }
      }
    }
    ctx2d.textAlign = 'left'; ctx2d.textBaseline = 'alphabetic'; // reset canvas text state

    ctx2d.restore();
    ctx2d.globalAlpha = 1.0;
  }

  // ── Physics + render loop ────────────────────────────────────────────────────
  let hoveredKey: string | null = null;
  let rafId = 0;
  let lastTime = 0;

  function tick(time: number) {
    const dt = Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;

    // Physics — tuned for 2D (fewer DOF than 3D, needs stronger damping + wider spacing)
    const REPEL     = 2.2;
    const SPRING    = layout === 'force' ? 0.15 : 0.08;
    const CENTER    = activeAnchors.size > 0 ? 0.008 : 0.04;
    const DAMP      = 0.78;
    const BASE_REST = 3.2;
    const VEL_FLOOR = 0.001; // clamp micro-velocities to zero to stop jitter

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx*dx + dy*dy + 0.01;
        const f = REPEL / d2, inv = 1 / Math.sqrt(d2);
        a.vx += dx*inv*f*dt; a.vy += dy*inv*f*dt;
        b.vx -= dx*inv*f*dt; b.vy -= dy*inv*f*dt;
      }
    }
    for (const e of edges) {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const d = Math.hypot(dx, dy) + 0.001;
      const k = e.isSourceEdge ? SPRING * 0.25 : SPRING;
      const f = (d - BASE_REST * e.semanticDist) * k;
      e.a.vx += (dx/d)*f*dt*5; e.a.vy += (dy/d)*f*dt*5;
      e.b.vx -= (dx/d)*f*dt*5; e.b.vy -= (dy/d)*f*dt*5;
    }
    for (const n of nodes) {
      if (activeAnchors.size > 0) {
        const anc = activeAnchors.get(n.key);
        if (anc) { n.vx += (anc.x - n.x)*anchorStrength*dt; n.vy += (anc.y - n.y)*anchorStrength*dt; }
      }
      n.vx += -n.x * CENTER * dt; n.vy += -n.y * CENTER * dt;
      n.vx *= DAMP; n.vy *= DAMP;
      // Clamp micro-velocities to zero — prevents infinite low-amplitude jitter
      if (Math.abs(n.vx) < VEL_FLOOR && Math.abs(n.vy) < VEL_FLOOR) { n.vx = 0; n.vy = 0; }
      n.x += n.vx; n.y += n.vy;
      nodePositionCache.set(n.key, { x: n.x, y: n.y });
    }

    const el = canvasEl;
    if (el) {
      const w = el.clientWidth, h = el.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
      if (el.width !== bw || el.height !== bh) { el.width = bw; el.height = bh; }
      // Refresh viewport rect once per frame for worldToScreen (viewport-fixed coordinates)
      const r = el.getBoundingClientRect();
      _rect = { left: r.left, top: r.top, width: r.width, height: r.height };
      const ctx2d = el.getContext('2d');
      if (ctx2d) {
        ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
        draw(ctx2d, w, h);
      }

      // Fire label positions — sort by degree (hubs first), suppress overlapping labels
      {
        const sorted = [...nodes].sort((a, b) => b.degree - a.degree);
        const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
        const labelData: Array<{ key: string; label: string; x: number; y: number; opacity: number }> = [];
        const charW = 6.6; // monospace ~0.6em at 11px
        const lblH = 16;
        for (const n of sorted) {
          const s = worldToScreen(n.x, n.y);
          const lblW = Math.min(n.label.length * charW, 180);
          const lx = s.x - lblW / 2;
          const ly = s.y - lblH - 5;
          const isSel = n.key === selected;
          const isHov = n.key === hoveredKey;
          // Always show selected/hovered labels
          if (isSel || isHov) {
            placed.push({ x: lx, y: ly, w: lblW, h: lblH });
            labelData.push({ key: n.key, label: n.label, x: s.x, y: s.y, opacity: 1.0 });
            continue;
          }
          let overlaps = false;
          for (const p of placed) {
            if (lx < p.x + p.w && lx + lblW > p.x && ly < p.y + p.h && ly + lblH > p.y) {
              overlaps = true; break;
            }
          }
          if (!overlaps) {
            placed.push({ x: lx, y: ly, w: lblW, h: lblH });
            labelData.push({ key: n.key, label: n.label, x: s.x, y: s.y, opacity: 0.85 });
          } else {
            // Hidden but still in DOM for hover to reveal
            labelData.push({ key: n.key, label: n.label, x: s.x, y: s.y, opacity: 0 });
          }
        }
        onlabelsmove(labelData);
      }

      // Fire marker positions
      if (layout === 'hub' && hubNodeKeys.length) {
        onmarkersmove(hubNodeKeys.flatMap(key => {
          const n = nodes.find(nd => nd.key === key);
          if (!n) return [];
          const s = worldToScreen(n.x, n.y);
          return [{ key, label: n.label, color: nodeColorMap.get(key) ?? '#ff6b35', x: s.x, y: s.y }];
        }));
      } else if (markerData.length) {
        onmarkersmove(markerData.map(m => { const s = worldToScreen(m.x, m.y); return { ...m, x: s.x, y: s.y }; }));
      } else {
        onmarkersmove([]);
      }

      if (selected) {
        const sn = nodes.find(n => n.key === selected);
        if (sn) { const s = worldToScreen(sn.x, sn.y); onnodemove(selected, s.x, s.y); }
      }
      if (hoveredKey) {
        const hn = nodes.find(n => n.key === hoveredKey);
        if (hn) { const s = worldToScreen(hn.x, hn.y); onhovermove(hoveredKey, hn.label, s.x, s.y); }
      } else {
        onhovermove(null, null, 0, 0);
      }
    }

    rafId = requestAnimationFrame(tick);
  }

  // ── Interaction ───────────────────────────────────────────────────────────────
  let isPointerDown = false;
  let isDragging = false;
  let dragStart = { x: 0, y: 0, cx: 0, cy: 0 };
  let dragStartHit: Node | null = null; // node under pointer at drag start — suppresses pan
  let orderDragNode: Node | null = null; // node being dragged in order layout

  function hitTest(clientX: number, clientY: number): Node | null {
    const el = canvasEl;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    // Use rect.width/height (CSS layout size) — NOT el.width/height (canvas buffer size,
    // defaults to 300×150 until the tick runs and can diverge on HiDPI displays).
    const wx = (clientX - rect.left - rect.width  / 2 - camX) / camScale;
    const wy = (clientY - rect.top  - rect.height / 2 - camY) / camScale;
    for (const n of [...nodes].reverse()) {
      const r = (nodeRadius(n) / camScale * 40 * 0.1) * 2.2; // generous hit target
      if ((n.x - wx)**2 + (n.y - wy)**2 <= r*r) return n;
    }
    return null;
  }

  // ── Right-click timeline scrubbing state ────────────────────────────
  let timelineDragging = false;
  let timelineDragStartX = 0;
  let timelineDragStartCenter = 0;

  function getTimelineDataRange(): { dataMin: number; dataMax: number; dataRange: number } | null {
    const nodeTime = new Map<string, number>();
    const useIngested = timelineTimeSource === 'ingested';
    for (const st of statements as Statement[]) {
      if (st.status === 'rejected' || st.status === 'superseded') continue;
      if (useIngested) {
        const sk = termKey(st.s);
        if (!nodeTime.has(sk) && st.createdAt) nodeTime.set(sk, st.createdAt);
      } else {
        if (TIMELINE_PREDICATES_2D.has(st.p.value)) {
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
    if (times.length === 0) return null;
    const dataMin = Math.min(...times);
    const dataMax = Math.max(...times);
    return { dataMin, dataMax, dataRange: dataMax - dataMin || 1 };
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button === 2 && layout === 'timeline') {
      // Right-click: start timeline scrub
      timelineDragging = true;
      timelineDragStartX = e.clientX;
      const range = getTimelineDataRange();
      timelineDragStartCenter = timelineCenter ?? (range ? (range.dataMin + range.dataRange / 2) : 0);
      canvasEl?.setPointerCapture(e.pointerId);
      return;
    }
    isPointerDown = true;
    isDragging    = false;
    dragStart     = { x: e.clientX, y: e.clientY, cx: camX, cy: camY };
    dragStartHit  = hitTest(e.clientX, e.clientY);
    canvasEl?.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (timelineDragging) {
      const range = getTimelineDataRange();
      if (range) {
        const visibleRange = range.dataRange / timelineZoom;
        const dx = e.clientX - timelineDragStartX;
        const timeDelta = -(dx / (canvasEl?.clientWidth ?? 800)) * visibleRange;
        ontimelinepan(timelineDragStartCenter + timeDelta);
      }
      return;
    }
    // Only pan/drag when a button is held — never on bare hover
    if (isPointerDown) {
      const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
      if (layout === 'order' && dragStartHit && Math.hypot(dx, dy) > 6) {
        // Order layout: drag node to reorder
        isDragging = true;
        orderDragNode = dragStartHit;
        // Move the node to cursor position in world space
        const wx = (e.clientX - _rect.left - _rect.width / 2 - camX) / camScale;
        const wy = (e.clientY - _rect.top - _rect.height / 2 - camY) / camScale;
        orderDragNode.x = wx;
        orderDragNode.y = wy;
      } else if (!dragStartHit && Math.hypot(dx, dy) > 10) {
        isDragging = true;
        camX = dragStart.cx + dx;
        camY = dragStart.cy + dy;
      }
    }
    const hit = hitTest(e.clientX, e.clientY);
    const newKey = hit?.key ?? null;
    if (newKey !== hoveredKey) {
      hoveredKey = newKey;
      onhover(hoveredKey);
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (timelineDragging) {
      timelineDragging = false;
      canvasEl?.releasePointerCapture(e.pointerId);
      return;
    }
    // Order layout: finalize reorder on drop
    if (orderDragNode && layout === 'order' && nodeOrder.length > 0) {
      // Find nearest grid slot by distance to each anchor
      const dragKey = orderDragNode.key;
      const dragX = orderDragNode.x, dragY = orderDragNode.y;
      let bestIdx = 0, bestDist = Infinity;
      for (let i = 0; i < nodeOrder.length; i++) {
        const anchor = activeAnchors.get(nodeOrder[i]);
        if (!anchor) continue;
        const d = Math.hypot(dragX - anchor.x, dragY - anchor.y);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      const curIdx = nodeOrder.indexOf(dragKey);
      if (curIdx !== -1 && curIdx !== bestIdx) {
        const newOrder = [...nodeOrder];
        newOrder.splice(curIdx, 1);
        newOrder.splice(bestIdx, 0, dragKey);
        onreorder(newOrder);
      }
      orderDragNode = null;
    }
    // Use the node captured at pointerdown (dragStartHit) for selection — the node may
    // have moved by 1-2 physics frames between press and release, so a fresh hit test
    // at the release position can miss it.
    if (!isDragging && !isHistoryMode) {
      const hit = dragStartHit ?? hitTest(e.clientX, e.clientY);
      onselect(hit?.key ?? null, e.ctrlKey);
    }
    isPointerDown = false;
    isDragging    = false;
    dragStartHit  = null;
  }

  function onPointerCancel() {
    isPointerDown = false;
    isDragging    = false;
    dragStartHit  = null;
    orderDragNode = null;
    timelineDragging = false;
  }

  function onContextMenu2D(e: Event) {
    if (layout === 'timeline') e.preventDefault();
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const el = canvasEl;
    if (!el) { camScale = Math.max(4, Math.min(400, camScale * factor)); return; }
    const rect = el.getBoundingClientRect();
    // Use rect dimensions (CSS layout) for coordinate accuracy
    const px = e.clientX - rect.left - rect.width  / 2;
    const py = e.clientY - rect.top  - rect.height / 2;
    const newScale = Math.max(4, Math.min(400, camScale * factor));
    camX = px - (px - camX) * (newScale / camScale);
    camY = py - (py - camY) * (newScale / camScale);
    camScale = newScale;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────
  onMount(() => {
    lastTime = performance.now();
    rafId = requestAnimationFrame(tick);
  });
  onDestroy(() => {
    cancelAnimationFrame(rafId);
    onlabelsmove([]);
    onmarkersmove([]);
  });
</script>

<canvas
  bind:this={canvasEl}
  class="graph2d"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerCancel}
  onwheel={onWheel}
  oncontextmenu={onContextMenu2D}
></canvas>

<style>
  .graph2d {
    width: 100%;
    height: 100%;
    display: block;
    cursor: grab;
    touch-action: none;
    user-select: none;
  }
  .graph2d:active { cursor: grabbing; }
</style>
