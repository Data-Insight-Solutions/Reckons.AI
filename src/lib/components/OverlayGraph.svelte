<script lang="ts">
  /**
   * OverlayGraph — canvas-based multi-graph Venn visualization.
   * Entities are positioned by a force simulation that anchors each node
   * toward the centroid of its member projects, creating natural Venn-like
   * overlap zones. Nodes use pie-chart coloring to show membership.
   */
  import { onMount, onDestroy } from 'svelte';
  import type { GraphDef, OverlayNode, OverlayEdge } from '$lib/rdf/multi-graph-parse';
  import { MEMBERSHIP_PREDICATES, isProjectIri } from '$lib/rdf/multi-graph-parse';

  let {
    graphs = [],
    nodes = new Map() as Map<string, OverlayNode>,
    edges = [] as OverlayEdge[],
    activeGraphIds = new Set() as Set<string>,
    activePredicates = new Set() as Set<string>,
    selectedKey = null as string | null,
    onselect = (_key: string | null) => {},
  } = $props<{
    graphs: GraphDef[];
    nodes: Map<string, OverlayNode>;
    edges: OverlayEdge[];
    activeGraphIds: Set<string>;
    activePredicates: Set<string>;
    selectedKey?: string | null;
    onselect?: (key: string | null) => void;
  }>();

  // ── Internal types ──────────────────────────────────────────────────────────
  type SimNode = {
    key: string; label: string;
    colors: string[];       // project colors for this node's membership
    memberCount: number;
    isProject: boolean;
    x: number; y: number; vx: number; vy: number;
    anchorX: number; anchorY: number;
    radius: number;
  };
  type SimEdge = { a: SimNode; b: SimNode; predicate: string; };

  // ── State ───────────────────────────────────────────────────────────────────
  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let simNodes: SimNode[] = [];
  let simEdges: SimEdge[] = [];
  let camX = 0, camY = 0, camScale = 22;
  let hoveredKey: string | null = null;
  let rafId = 0;
  let lastTime = 0;
  let dragging = false;
  let dragStartX = 0, dragStartY = 0;
  let dragCamX = 0, dragCamY = 0;

  // Graph color lookup
  const graphColorMap = $derived(new Map(graphs.map(g => [g.id, g.color])));

  // Project anchor positions in a circle
  const projectAnchors = $derived.by(() => {
    const active = graphs.filter(g => activeGraphIds.has(g.id));
    const n = active.length;
    if (n === 0) return new Map<string, { x: number; y: number }>();
    const R = Math.max(16, n * 3.5);
    const map = new Map<string, { x: number; y: number }>();
    active.forEach((g, i) => {
      const theta = (2 * Math.PI * i) / n - Math.PI / 2;
      map.set(g.id, { x: R * Math.cos(theta), y: R * Math.sin(theta) });
    });
    return map;
  });

  // ── Rebuild simulation when data/filters change ─────────────────────────────
  $effect(() => {
    // Filter edges by active predicates and graphs
    const visibleEdges = edges.filter(e => {
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

    // Build simulation node map, preserving positions from previous sim
    const prevPos = new Map(simNodes.map(n => [n.key, { x: n.x, y: n.y }]));
    const nodeMap = new Map<string, SimNode>();

    for (const key of visibleKeys) {
      const node = nodes.get(key);
      if (!node) continue;

      const activeMem = [...node.membership].filter(gid => activeGraphIds.has(gid));
      const isPrj = isProjectIri(key);
      if (activeMem.length === 0 && !isPrj) continue;

      // Anchor = centroid of member project positions
      let ax = 0, ay = 0, anchorCount = 0;
      if (isPrj) {
        const pa = projectAnchors.get(activeMem[0] ?? '');
        if (pa) { ax = pa.x; ay = pa.y; anchorCount = 1; }
      } else {
        for (const gid of activeMem) {
          const pa = projectAnchors.get(gid);
          if (pa) { ax += pa.x; ay += pa.y; anchorCount++; }
        }
        if (anchorCount > 0) { ax /= anchorCount; ay /= anchorCount; }
      }

      const prev = prevPos.get(key);
      const colors = activeMem.map(gid => graphColorMap.get(gid) ?? '#888');

      nodeMap.set(key, {
        key, label: node.label,
        colors: colors.length > 0 ? colors : ['#555'],
        memberCount: activeMem.length,
        isProject: isPrj,
        x: prev?.x ?? ax + (Math.random() - 0.5) * 3,
        y: prev?.y ?? ay + (Math.random() - 0.5) * 3,
        vx: 0, vy: 0,
        anchorX: ax, anchorY: ay,
        radius: isPrj ? 1.4 : 0.35 + activeMem.length * 0.12,
      });
    }

    simNodes = [...nodeMap.values()];

    // Build simulation edges — exclude membership predicates (shown via color)
    simEdges = visibleEdges
      .filter(e => !MEMBERSHIP_PREDICATES.has(e.predicateIri))
      .filter(e => nodeMap.has(e.sourceKey) && nodeMap.has(e.targetKey))
      .map(e => ({ a: nodeMap.get(e.sourceKey)!, b: nodeMap.get(e.targetKey)!, predicate: e.predicate }));
  });

  // ── Physics + render loop ───────────────────────────────────────────────────
  function tick(time: number) {
    const dt = Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;

    const REPEL = 1.8;
    const SPRING = 0.06;
    const ANCHOR = 0.35;
    const CENTER = 0.01;
    const DAMP = 0.75;
    const BASE_REST = 4.0;

    // Repulsion
    for (let i = 0; i < simNodes.length; i++) {
      const a = simNodes[i];
      if (a.isProject) continue;
      for (let j = i + 1; j < simNodes.length; j++) {
        const b = simNodes[j];
        if (b.isProject) continue;
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx * dx + dy * dy + 0.01;
        const f = REPEL / d2;
        const inv = 1 / Math.sqrt(d2);
        a.vx += dx * inv * f * dt; a.vy += dy * inv * f * dt;
        b.vx -= dx * inv * f * dt; b.vy -= dy * inv * f * dt;
      }
    }

    // Spring edges
    for (const e of simEdges) {
      if (e.a.isProject || e.b.isProject) continue;
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const d = Math.hypot(dx, dy) + 0.001;
      const f = (d - BASE_REST) * SPRING;
      e.a.vx += (dx / d) * f * dt * 5; e.a.vy += (dy / d) * f * dt * 5;
      e.b.vx -= (dx / d) * f * dt * 5; e.b.vy -= (dy / d) * f * dt * 5;
    }

    // Anchor + center + damp
    for (const n of simNodes) {
      if (n.isProject) {
        // Pin projects to anchor
        n.x = n.anchorX; n.y = n.anchorY;
        n.vx = 0; n.vy = 0;
        continue;
      }
      n.vx += (n.anchorX - n.x) * ANCHOR * dt;
      n.vy += (n.anchorY - n.y) * ANCHOR * dt;
      n.vx += -n.x * CENTER * dt;
      n.vy += -n.y * CENTER * dt;
      n.vx *= DAMP; n.vy *= DAMP;
      if (Math.abs(n.vx) < 0.001 && Math.abs(n.vy) < 0.001) { n.vx = 0; n.vy = 0; }
      n.x += n.vx; n.y += n.vy;
    }

    // Render
    const el = canvasEl;
    if (el) {
      const w = el.clientWidth, h = el.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
      if (el.width !== bw || el.height !== bh) { el.width = bw; el.height = bh; }
      const ctx = el.getContext('2d');
      if (ctx) { ctx.save(); ctx.scale(dpr, dpr); draw(ctx, w, h); ctx.restore(); }
    }

    rafId = requestAnimationFrame(tick);
  }

  function draw(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2 + camX, h / 2 + camY);
    ctx.scale(camScale, camScale);

    // Project zone halos
    for (const n of simNodes) {
      if (!n.isProject) continue;
      ctx.beginPath();
      ctx.arc(n.x, n.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = n.colors[0] ?? '#555';
      ctx.globalAlpha = 0.06;
      ctx.fill();
      // Smaller inner ring
      ctx.beginPath();
      ctx.arc(n.x, n.y, 3.5, 0, Math.PI * 2);
      ctx.strokeStyle = n.colors[0] ?? '#555';
      ctx.lineWidth = 0.06;
      ctx.globalAlpha = 0.15;
      ctx.stroke();
    }

    // Edges
    ctx.globalAlpha = 0.18;
    for (const e of simEdges) {
      const isHov = hoveredKey && (e.a.key === hoveredKey || e.b.key === hoveredKey);
      const isSel = selectedKey && (e.a.key === selectedKey || e.b.key === selectedKey);
      ctx.beginPath();
      ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y);
      ctx.strokeStyle = isSel ? '#ff6b35' : isHov ? '#e8b84b' : 'rgba(255,255,255,0.5)';
      ctx.lineWidth = (isSel ? 0.06 : isHov ? 0.04 : 0.025);
      ctx.globalAlpha = isSel ? 0.6 : isHov ? 0.4 : 0.18;
      ctx.stroke();
    }

    // Entity nodes
    for (const n of simNodes) {
      if (n.isProject) continue;
      const isHov = n.key === hoveredKey;
      const isSel = n.key === selectedKey;
      const r = isHov ? n.radius * 1.3 : n.radius;

      ctx.globalAlpha = 0.88;

      // Selection ring
      if (isSel) {
        ctx.beginPath(); ctx.arc(n.x, n.y, r * 1.7, 0, Math.PI * 2);
        ctx.strokeStyle = '#ff6b35'; ctx.lineWidth = r * 0.2;
        ctx.globalAlpha = 0.8; ctx.stroke();
      }

      // Pie chart fill
      if (n.colors.length === 1) {
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = n.colors[0]; ctx.globalAlpha = 0.85; ctx.fill();
      } else {
        const slice = (Math.PI * 2) / n.colors.length;
        for (let i = 0; i < n.colors.length; i++) {
          ctx.beginPath();
          ctx.moveTo(n.x, n.y);
          ctx.arc(n.x, n.y, r, i * slice - Math.PI / 2, (i + 1) * slice - Math.PI / 2);
          ctx.closePath();
          ctx.fillStyle = n.colors[i]; ctx.globalAlpha = 0.85; ctx.fill();
        }
      }

      // Thin outline for multi-membership nodes
      if (n.memberCount > 1) {
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = r * 0.12;
        ctx.globalAlpha = 0.4; ctx.stroke();
      }
    }

    // Project labels
    for (const n of simNodes) {
      if (!n.isProject) continue;
      ctx.globalAlpha = 0.9;
      // Project dot
      ctx.beginPath(); ctx.arc(n.x, n.y, 0.7, 0, Math.PI * 2);
      ctx.fillStyle = n.colors[0] ?? '#555'; ctx.fill();
      // Label
      ctx.font = `bold ${0.8}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = n.colors[0] ?? '#ccc';
      ctx.globalAlpha = 0.85;
      ctx.fillText(n.label, n.x, n.y + 1.1);
    }

    // Hover label
    if (hoveredKey) {
      const hn = simNodes.find(n => n.key === hoveredKey);
      if (hn && !hn.isProject) {
        const fontSize = 0.55;
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';

        // Background pill
        const tw = ctx.measureText(hn.label).width;
        const px = 0.3, py = 0.15;
        ctx.fillStyle = 'rgba(10,10,14,0.85)';
        ctx.globalAlpha = 1;
        const rx = hn.x - tw / 2 - px;
        const ry = hn.y - hn.radius - 0.6 - fontSize - py;
        const rw = tw + px * 2;
        const rh = fontSize + py * 2;
        ctx.beginPath();
        ctx.roundRect(rx, ry, rw, rh, 0.15);
        ctx.fill();

        ctx.fillStyle = '#fff';
        ctx.fillText(hn.label, hn.x, hn.y - hn.radius - 0.6);
      }
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ── Interaction ─────────────────────────────────────────────────────────────
  function screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const el = canvasEl!;
    const w = el.clientWidth, h = el.clientHeight;
    return {
      x: (sx - w / 2 - camX) / camScale,
      y: (sy - h / 2 - camY) / camScale
    };
  }

  function hitTest(wx: number, wy: number): SimNode | null {
    let best: SimNode | null = null;
    let bestD = Infinity;
    for (const n of simNodes) {
      const dx = wx - n.x, dy = wy - n.y;
      const d = Math.hypot(dx, dy);
      const hitR = n.isProject ? 1.5 : n.radius * 1.5;
      if (d < hitR && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  function onPointerDown(e: PointerEvent) {
    dragging = true;
    dragStartX = e.clientX; dragStartY = e.clientY;
    dragCamX = camX; dragCamY = camY;
  }

  function onPointerMove(e: PointerEvent) {
    if (dragging) {
      camX = dragCamX + (e.clientX - dragStartX);
      camY = dragCamY + (e.clientY - dragStartY);
      return;
    }
    const rect = canvasEl?.getBoundingClientRect();
    if (!rect) return;
    const { x, y } = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const hit = hitTest(x, y);
    hoveredKey = hit?.key ?? null;
    if (canvasEl) canvasEl.style.cursor = hit ? 'pointer' : 'grab';
  }

  function onPointerUp(e: PointerEvent) {
    const wasDrag = Math.abs(e.clientX - dragStartX) > 4 || Math.abs(e.clientY - dragStartY) > 4;
    dragging = false;
    if (!wasDrag) {
      const rect = canvasEl?.getBoundingClientRect();
      if (!rect) return;
      const { x, y } = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const hit = hitTest(x, y);
      onselect(hit?.key ?? null);
    }
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const rect = canvasEl?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left - rect.width / 2 - camX;
    const my = e.clientY - rect.top - rect.height / 2 - camY;
    camX -= mx * (factor - 1);
    camY -= my * (factor - 1);
    camScale *= factor;
    camScale = Math.max(4, Math.min(120, camScale));
  }

  onMount(() => {
    lastTime = performance.now();
    rafId = requestAnimationFrame(tick);
  });

  onDestroy(() => {
    if (rafId) cancelAnimationFrame(rafId);
  });
</script>

<div class="overlay-wrap">
  <canvas
    bind:this={canvasEl}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointerleave={() => { dragging = false; hoveredKey = null; }}
    onwheel={onWheel}
  ></canvas>

  {#if simNodes.length === 0}
    <div class="empty">
      <span>load TTL files to compare</span>
    </div>
  {/if}
</div>

<style>
  .overlay-wrap {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 500px;
    border-radius: var(--rad);
    overflow: hidden;
    border: 1px solid var(--line);
    background: var(--surface);
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none;
  }
  .empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }
  .empty span {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
</style>
