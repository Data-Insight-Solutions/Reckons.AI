<script lang="ts">
  import { Canvas } from '@threlte/core';
  import { goto } from '$app/navigation';
  import KnowledgeGraph from '$lib/3d/KnowledgeGraph.svelte';
  import KnowledgeGraph2D from '$lib/3d/KnowledgeGraph2D.svelte';
  import StatementCard from '$lib/components/StatementCard.svelte';
  import LandingPage from '$lib/components/LandingPage.svelte';
  import SourcesPanel from '$lib/components/SourcesPanel.svelte';
  import RelationBuilder from '$lib/components/RelationBuilder.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import SearchBar from '$lib/components/SearchBar.svelte';
  import {
    statements,
    sources,
    confirmedStatements,
    pendingStatements,
    updateStatement,
    addStatements,
    setStatus
  } from '$lib/stores/kb.svelte';
  import { termKey } from '$lib/rdf/types';
  import MergeReview from '$lib/components/MergeReview.svelte';
  import { allTypes } from '$lib/stores/entity-types.svelte';
  import {
    RDF_TYPE, KB_URL, KB_LOCAL_PATH,
    KB_ICON2D, KB_ICON3D, KB_MESHY_TASK_ID, KB_MESHY_STATUS,
    KB_COLOR, KB_DESCRIPTION, KB_SCHEMA_PREDICATE
  } from '$lib/rdf/entity-types';
  import { setGlb, clearGlb, glbOverrides } from '$lib/stores/glb-overrides.svelte';
  import { gifOverrides, setGif, clearGif } from '$lib/stores/gif-overrides.svelte';
  import { icon2dOverrides, setIcon2d, clearIcon2d } from '$lib/stores/icon2d-overrides.svelte';
  import { LEAP_PRED, LEAP_LABEL_PRED, getLeap, leapNodeKeys } from '$lib/rdf/kb-leap';
  import { findKbByStableId, switchToKb, createKb, registerStableId } from '$lib/storage/kb-registry';

  // Predicates that are internal KB metadata — never shown as graph edges/nodes
  const GRAPH_EXCLUDED_PREDICATES = new Set([
    KB_ICON2D, KB_ICON3D, KB_MESHY_TASK_ID, KB_MESHY_STATUS,
    KB_COLOR, KB_DESCRIPTION, KB_SCHEMA_PREDICATE,
    LEAP_PRED, LEAP_LABEL_PRED,
  ]);
  import { isIRI, isLit } from '$lib/rdf/types';
  import { requestShellyChat, setShellyChatOpen, shellyViewAdjust, clearShellyViewAdjust, shellySpotlight, exploreOpen, startExplore, stopExplore } from '$lib/stores/shelly-bridge.svelte';
  import SnapPanel from '$lib/components/SnapPanel.svelte';
  import { Popover, ToggleGroup } from 'bits-ui';
  import { analysisRunning, lastAnalysisError } from '$lib/stores/auto-analyze.svelte';
  import { onMount, untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { settings, updateSettings } from '$lib/stores/settings.svelte';
  import { replaceState } from '$app/navigation';
  import { page } from '$app/stores';
  import type { GraphFilter } from '$lib/types/turtle-chat';
  import { getSettings, saveSettings } from '$lib/storage/db';
  import { shouldSuggest2D, dismissPerfSuggestion, resetPerfMonitor, currentFps } from '$lib/stores/perf-monitor.svelte';
  import { pushNotification, dismissNotification, notificationStackHeight } from '$lib/stores/notifications.svelte';

  function checkWebGL(): boolean {
    if (typeof window === 'undefined') return false;
    try {
      const c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext &&
        (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch { return false; }
  }
  let webglAvailable = $state(checkWebGL()); // synchronous — no Canvas mounted if false
  let use2D = $state(settings().prefer2D ?? false);

  let selected = $state<string | null>(null);
  let hoverTarget = $state<string | null>(null);

  /** Scale-and-fade reveal used for GIF previews — gentle so it doesn't startle. */
  function gifReveal(_node: Element, { duration = 300 } = {}) {
    return {
      duration,
      css: (t: number) => {
        const e = cubicOut(t);
        return `opacity: ${e}; transform: scale(${0.88 + 0.12 * e});`;
      }
    };
  }

  // ── GIF long-hover overlay ────────────────────────────────────────────────
  let gifHoverKey = $state<string | null>(null);    // node key currently being timed
  let gifActiveKey = $state<string | null>(null);   // node key whose GIF is showing
  let gifPointerX = $state(0);
  let gifPointerY = $state(0);
  let gifTimer: ReturnType<typeof setTimeout> | null = null;

  function iriFromNodeKey(key: string | null): string | null {
    if (!key) return null;
    // Node keys are stored as 'i:<iri>' for IRI nodes, 'l:<value>' for literals
    return key.startsWith('i:') ? key.slice(2) : null;
  }

  function onGraphPointerMove(e: PointerEvent) {
    gifPointerX = e.clientX;
    gifPointerY = e.clientY;
  }

  /** Metadata fields for the currently hovered entity (for hover overlay). */
  const hoverMeta = $derived.by(() => {
    const iri = iriFromNodeKey(hoverTarget);
    if (!iri) return null;
    const typeStmt = confirmedStatements().find(
      s => s.s.kind === 'iri' && s.s.value === iri && s.p.value === RDF_TYPE
    );
    if (!typeStmt) return null;
    const typeDef = allTypes().find(t => t.iri === typeStmt.o.value);
    if (!typeDef?.schemaPredicates?.length) return null;
    const fields: { label: string; value: string }[] = [];
    for (const predIri of typeDef.schemaPredicates) {
      const st = confirmedStatements().find(
        s => s.s.kind === 'iri' && s.s.value === iri && s.p.value === predIri && s.o.kind === 'literal'
      );
      if (st) fields.push({ label: predIri.split('/').pop() ?? predIri, value: st.o.value });
    }
    return fields.length > 0 ? { iri, typeDef, fields } : null;
  });

  $effect(() => {
    const key = hoverTarget;
    const iri = iriFromNodeKey(key);
    const hasGif = iri != null && gifOverrides().has(iri);
    const hasMeta = hoverMeta != null;

    if (gifTimer) { clearTimeout(gifTimer); gifTimer = null; }

    if (!hasGif && !hasMeta) {
      gifHoverKey = null;
      gifActiveKey = null;
      return;
    }

    if (key === gifHoverKey) return; // same node, already timing or showing
    gifHoverKey = key;
    gifActiveKey = null;
    gifTimer = setTimeout(() => {
      gifActiveKey = gifHoverKey;
    }, 700);
  });

  // ── Schema metadata fields (for selected entity) ──────────────────────────
  let showSchemaFields = $state(false);

  const schemaFieldValues = $derived.by(() => {
    if (!selected || !nodeDetails?.typeDef?.schemaPredicates?.length) return new Map<string, string>();
    const entityIri = iriFromNodeKey(selected);
    if (!entityIri) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const predicateIri of nodeDetails.typeDef.schemaPredicates) {
      const st = confirmedStatements().find(
        s => s.s.kind === 'iri' && s.s.value === entityIri
          && s.p.value === predicateIri
          && s.o.kind === 'literal'
      );
      if (st) map.set(predicateIri, st.o.value);
    }
    return map;
  });

  async function setSchemaField(entityIri: string, predicateIri: string, value: string) {
    const { v4: uuidv4 } = await import('uuid');
    const existing = statements().find(
      s => s.s.kind === 'iri' && s.s.value === entityIri
        && s.p.value === predicateIri
        && s.o.kind === 'literal'
        && s.status !== 'rejected' && s.status !== 'superseded'
    );
    if (existing) await setStatus(existing.id, 'rejected');
    const trimmed = value.trim();
    if (!trimmed) return;
    const now = Date.now();
    await addStatements([{
      id: uuidv4(),
      s: { kind: 'iri', value: entityIri },
      p: { kind: 'iri', value: predicateIri },
      o: { kind: 'literal', value: trimmed },
      g: { kind: 'iri', value: 'urn:kbase:source/manual' },
      sourceId: 'manual',
      confidence: 1.0,
      status: 'confirmed',
      createdAt: now,
      updatedAt: now
    }]);
  }

  function predicateInputType(predicateIri: string): string {
    const slug = (predicateIri.split('/').pop() ?? predicateIri).toLowerCase();
    if (slug.includes('date') || slug.endsWith('-at') || slug.includes('born') || slug.includes('founded')) return 'date';
    if (slug.includes('count') || slug.includes('-number') || slug.includes('age') || slug.includes('member')) return 'number';
    if (slug.includes('email')) return 'email';
    return 'text';
  }
  let nodeLabels = $state<Array<{ key: string; label: string; x: number; y: number; opacity: number }>>([]);
  let labelFontSize = $state(11);
  let markerLabels = $state<Array<{ key: string; label: string; color: string; x: number; y: number }>>([]);
  let navHistory = $state<string[]>([]);
  let activeFilters = $state<Set<GraphFilter>>(new Set());
  let selectedSources = $state<Set<string>>(new Set());
  let selectedTypes = $state<Set<string>>(new Set()); // entity type IRIs
  let showSourcesPanel = $state(false);
  let hubLimit = $state(5);
  let layout = $state<'force' | 'focus' | 'source' | 'type' | 'hub' | 'timeline' | 'order'>('force');
  let nodeOrder = $state<string[]>([]); // ordered node keys for 'order' layout
  let timelineZoom = $state(1);
  let timelineCenter = $state<number | null>(null);
  let timelineTimeSource = $state<'event' | 'ingested'>('event');

  // Keep labelFontSize and renderer in sync with settings (e.g. changed from settings page)
  $effect(() => { const sz = settings().nodeLabelFontSize; if (sz != null) labelFontSize = sz; });
  $effect(() => { const p = settings().prefer2D; if (p != null) use2D = p; });

  // ── URL query param sync ──────────────────────────────────────────────────
  // Read initial view state from URL params (enables Shelly-recommended views
  // to be bookmarked and shared within the same browser/device).
  onMount(async () => {
    const params = $page.url.searchParams;
    const l = params.get('layout');
    if (l && ['force','focus','source','type','hub','timeline','order'].includes(l)) layout = l as typeof layout;
    const sel = params.get('sel');
    if (sel) selected = sel;
    const f = params.get('f');
    if (f) activeFilters = new Set(f.split(',').filter(Boolean) as GraphFilter[]);
    const src = params.get('src');
    if (src) selectedSources = new Set(src.split(',').filter(Boolean));
    const typ = params.get('types');
    if (typ) selectedTypes = new Set(typ.split(',').filter(Boolean));

    const s = await getSettings();
    if (s.nodeLabelFontSize != null) labelFontSize = s.nodeLabelFontSize;

    // First-run tip: tell users about Shelly chat and the explore tour
    pushNotification({
      id: 'tip-shelly-explore',
      type: 'info',
      oneTime: true,
      title: 'Meet Shelly',
      body: 'Ask questions, add knowledge, or take a guided tour of your graph.',
      action: { label: 'Open Shelly chat', onclick: () => setShellyChatOpen(true) }
    });
  });

  // Push a notification when 3D performance is poor
  $effect(() => {
    const shouldShow = shouldSuggest2D() && !use2D && webglAvailable;
    const fps = currentFps();
    const hasOverrides = glbOverrides().size > 0;
    // untrack: notification state must not become a reactive dependency here
    untrack(() => {
      if (shouldShow) {
        pushNotification({
          id: 'perf-3d',
          type: 'warn',
          title: `${fps} fps — 3D is slow`,
          body: hasOverrides
            ? 'Removing custom 3D models may help.'
            : 'Consider switching to 2D for better performance.',
          ondismiss: dismissPerfSuggestion,
          action: { label: 'Switch to 2D', onclick: () => { use2D = true; resetPerfMonitor(); dismissNotification('perf-3d'); updateSettings({ prefer2D: true }); } }
        });
      } else {
        dismissNotification('perf-3d');
      }
    });
  });


  // Sync view state → URL whenever it changes (replaceState: no history entry)
  $effect(() => {
    const params = new URLSearchParams();
    if (layout !== 'force') params.set('layout', layout);
    if (selected) params.set('sel', selected);
    if (activeFilters.size > 0) params.set('f', [...activeFilters].join(','));
    if (selectedSources.size > 0) params.set('src', [...selectedSources].join(','));
    if (selectedTypes.size > 0) params.set('types', [...selectedTypes].join(','));
    const qs = params.toString();
    replaceState(qs ? `?${qs}` : '?', {});
  });
  // Auto-populate nodeOrder when switching to order layout
  $effect(() => {
    if (layout === 'order' && nodeOrder.length === 0 && allNodes.size > 0) {
      // Seed order: sort by degree (highest-connected first), then alphabetical
      const sorted = [...allNodes].sort((a, b) => {
        const da = nodeDegrees.get(a) ?? 0, db = nodeDegrees.get(b) ?? 0;
        if (db !== da) return db - da;
        return a.localeCompare(b);
      });
      nodeOrder = sorted;
    }
  });

  let showMergeUI = $state(false);
  let showMergeReview = $state(false);
  let showRelationUI = $state(false);
  let mergeTarget = $state('');
  let showSourceFilter = $state(false);
  let showTypeFilter = $state(false);

  // Build a set of subject IRIs matching the selected entity types
  const typedSubjects = $derived.by(() => {
    if (selectedTypes.size === 0) return null;
    const all = statements();
    const subjects = new Set<string>();
    for (const st of all) {
      if (st.p.value === RDF_TYPE && selectedTypes.has(st.o.value)) {
        subjects.add(st.s.value);
      }
    }
    return subjects;
  });

  const visible = $derived.by(() => {
    let filtered = statements().filter((s) =>
      s.status !== 'rejected' &&
      s.status !== 'superseded' &&
      !GRAPH_EXCLUDED_PREDICATES.has(s.p.value)
    );

    // Apply status filters
    if (activeFilters.has('confirmed') || activeFilters.has('pending')) {
      filtered = filtered.filter((s) => {
        if (activeFilters.has('confirmed') && (s.status === 'confirmed' || s.status === 'refined')) return true;
        if (activeFilters.has('pending') && s.status === 'pending') return true;
        return false;
      });
    }

    // Apply source filters
    if (selectedSources.size > 0) {
      filtered = filtered.filter((s) => selectedSources.has(s.sourceId));
    }

    // Apply entity type filters — keep statements where subject matches typed subjects
    if (typedSubjects !== null) {
      filtered = filtered.filter((s) => typedSubjects.has(s.s.value) || typedSubjects.has(s.o.value));
    }

    // Apply no-type filter — show only nodes that have no rdf:type
    if (activeFilters.has('no-type')) {
      filtered = filtered.filter((s) =>
        (s.s.kind === 'iri' && untypedSubjectIris.has(s.s.value)) ||
        (s.o.kind === 'iri' && untypedSubjectIris.has(s.o.value))
      );
    }

    // Apply no-source filter — show only manually added statements
    if (activeFilters.has('no-source')) {
      filtered = filtered.filter((s) => s.sourceId === 'manual');
    }

    return filtered;
  });

  // Compute node degrees and build adjacency
  const { nodeDegrees, adjacency, allNodes } = $derived.by(() => {
    const degrees = new Map<string, number>();
    const adj = new Map<string, Set<string>>();
    const nodes = new Set<string>();

    for (const st of visible) {
      const sk = termKey(st.s);
      const ok = termKey(st.o);

      degrees.set(sk, (degrees.get(sk) ?? 0) + 1);
      degrees.set(ok, (degrees.get(ok) ?? 0) + 1);

      nodes.add(sk);
      nodes.add(ok);

      if (!adj.has(sk)) adj.set(sk, new Set());
      if (!adj.has(ok)) adj.set(ok, new Set());
      adj.get(sk)!.add(ok);
      adj.get(ok)!.add(sk);
    }

    return { nodeDegrees: degrees, adjacency: adj, allNodes: nodes };
  });

  // Find connected components using BFS
  const islandNodes = $derived.by(() => {
    const visited = new Set<string>();
    const smallComponentNodes = new Set<string>();

    for (const node of allNodes) {
      if (visited.has(node)) continue;

      // BFS to find component
      const component = new Set<string>();
      const queue = [node];
      visited.add(node);
      component.add(node);

      let i = 0;
      while (i < queue.length) {
        const current = queue[i++];
        const neighbors = adjacency.get(current) || new Set();

        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            component.add(neighbor);
            queue.push(neighbor);
          }
        }
      }

      // Mark nodes in small components as islands
      if (component.size <= 3) {
        component.forEach(n => smallComponentNodes.add(n));
      }
    }

    return Array.from(smallComponentNodes);
  });

  // Hub threshold: median degree × 2 or 3, whichever is higher — only truly connected nodes qualify
  const hubs = $derived.by(() => {
    const entries = Array.from(nodeDegrees.entries()).sort(([, a], [, b]) => b - a);
    if (entries.length === 0) return [];
    const degrees = entries.map(([, d]) => d);
    const median = degrees[Math.floor(degrees.length / 2)];
    const minDeg = Math.max(median * 2, 3);
    return entries
      .filter(([, d]) => d >= minDeg)
      .slice(0, hubLimit)
      .map(([key]) => key);
  });

  // All entity IRIs (subjects + non-type-definition objects) in the confirmed KB
  // that have no rdf:type statement. Includes entities that only appear as objects.
  const untypedSubjectIris = $derived.by(() => {
    const stmts = statements().filter(s => s.status === 'confirmed' || s.status === 'refined');
    const allEntityIris = new Set<string>();
    const typedIris = new Set<string>();    // have an rdf:type as subject
    const typeDefIris = new Set<string>(); // appear as object of rdf:type → are type IRIs, not entities
    for (const st of stmts) {
      if (st.s.kind === 'iri') allEntityIris.add(st.s.value);
      if (st.o.kind === 'iri') {
        if (st.p.value === RDF_TYPE) typeDefIris.add(st.o.value);
        else allEntityIris.add(st.o.value);
      }
      if (st.p.value === RDF_TYPE && st.s.kind === 'iri') typedIris.add(st.s.value);
    }
    for (const iri of typeDefIris) allEntityIris.delete(iri);
    return new Set([...allEntityIris].filter(iri => !typedIris.has(iri)));
  });

  // Node keys for untyped entities (used for highlighting)
  const untypedNodeKeys = $derived(
    [...untypedSubjectIris].map(iri => `i:${iri}`)
  );

  // Node keys for entities with leap targets (used for highlighting)
  const leapKeys = $derived([...leapNodeKeys(statements())]);

  // Shared dim/highlight state — used by both the graph components and the label overlay
  const dimMode = $derived(
    activeFilters.has('hubs') || activeFilters.has('islands') || activeFilters.has('no-type') || activeFilters.has('leaps')
  );
  const highlightedSet = $derived(new Set([
    ...Array.from(activeFilters).flatMap(f =>
      f === 'hubs' ? hubs
      : f === 'islands' ? islandNodes
      : f === 'no-type' ? untypedNodeKeys
      : f === 'leaps' ? leapKeys
      : [] as string[]
    ),
    ...shellySpotlight()
  ]));

  // Visible-accurate filter counts (exclude GRAPH_EXCLUDED_PREDICATES like the graph does)
  const visibleConfirmedCount = $derived(
    statements().filter(s =>
      (s.status === 'confirmed' || s.status === 'refined') &&
      !GRAPH_EXCLUDED_PREDICATES.has(s.p.value)
    ).length
  );
  const visiblePendingCount = $derived(
    statements().filter(s =>
      s.status === 'pending' &&
      !GRAPH_EXCLUDED_PREDICATES.has(s.p.value)
    ).length
  );

  // Statements that were added manually (no ingested source)
  const manualStatements = $derived(
    statements().filter(s =>
      (s.status === 'confirmed' || s.status === 'refined') && s.sourceId === 'manual'
    )
  );

  const selectedStatements = $derived(
    selected ? visible.filter((s) => termKey(s.s) === selected || termKey(s.o) === selected) : []
  );

  function toggleFilter(filter: GraphFilter) {
    if (activeFilters.has(filter)) {
      activeFilters.delete(filter);
    } else {
      activeFilters.add(filter);
    }
    activeFilters = new Set(activeFilters);
    selected = null;
  }

  function toggleSource(sourceId: string) {
    if (selectedSources.has(sourceId)) {
      selectedSources.delete(sourceId);
    } else {
      selectedSources.add(sourceId);
    }
    selectedSources = new Set(selectedSources);
  }

  function toggleType(iri: string) {
    if (selectedTypes.has(iri)) {
      selectedTypes.delete(iri);
    } else {
      selectedTypes.add(iri);
    }
    selectedTypes = new Set(selectedTypes);
    selected = null;
  }

  // Count entities per type (confirmed/refined only, consistent with untypedSubjectIris)
  const typeCounts = $derived.by(() => {
    const map = new Map<string, number>();
    for (const st of statements()) {
      if (st.p.value === RDF_TYPE && (st.status === 'confirmed' || st.status === 'refined')) {
        map.set(st.o.value, (map.get(st.o.value) ?? 0) + 1);
      }
    }
    return map;
  });

  // Only show type chips for types that actually appear in the KB
  const activeEntityTypes = $derived(
    allTypes().filter((t) => (typeCounts.get(t.iri) ?? 0) > 0)
  );

  // ── Data for RelationBuilder ──────────────────────────────────────────────

  /** All nodes currently visible: key (termKey), display label, raw IRI */
  const graphNodeList = $derived.by(() => {
    const map = new Map<string, { key: string; label: string; iri: string }>();
    for (const st of visible) {
      for (const term of [st.s, st.o]) {
        const k = termKey(term);
        if (map.has(k)) continue;
        const label = isIRI(term)
          ? (term.value.split('/').pop() ?? term.value)
          : isLit(term)
            ? term.value.slice(0, 48)
            : `_:${term.value}`;
        const iri = isIRI(term) ? term.value : k;
        map.set(k, { key: k, label, iri });
      }
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  });

  /** Unique predicate slug names from the visible graph */
  const existingPredicates = $derived.by(() => {
    const set = new Set<string>();
    for (const st of visible) {
      const slug = st.p.value.split('/').pop() ?? st.p.value;
      if (slug !== 'type') set.add(slug); // skip rdf:type
    }
    return [...set].sort();
  });

  // Decode a termKey into a human-readable short label
  function keyLabel(key: string): string {
    if (key.startsWith('i:')) {
      const iri = key.slice(2);
      return iri.split('/').pop() ?? iri;
    }
    if (key.startsWith('l:')) {
      // l:value|datatype|lang — take just the value part
      return key.slice(2).split('|')[0].slice(0, 48) || key;
    }
    if (key.startsWith('src:')) {
      const srcId = key.slice(4);
      const src = sources().find(s => s.id === srcId);
      return src?.title ?? srcId;
    }
    return key; // blank node
  }

  // Node details modal — shown for any layout when a node is selected
  const nodeDetails = $derived.by(() => {
    if (!selected) return null;
    const label = keyLabel(selected);

    // Source document node — show entities sourced from it
    if (selected.startsWith('src:')) {
      const srcId = selected.slice(4);
      const src = sources().find(s => s.id === srcId);
      const docType = allTypes().find(t => t.iri === 'urn:kbase:type/Document') ?? null;
      const srcStmts = visible.filter(s => s.sourceId === srcId);
      const entityIris = new Set<string>();
      for (const s of srcStmts) {
        if (s.s.kind === 'iri') entityIris.add(s.s.value);
      }
      const outgoing = [...entityIris].slice(0, 30).map(iri => ({
        predicate: 'sources',
        target: iri.split('/').pop() ?? iri,
        targetKey: `i:${iri}`,
        status: 'confirmed' as const
      }));
      return { label: src?.title ?? srcId, typeDef: docType, outgoing, incoming: [] };
    }

    const typeStmt = visible.find(s => termKey(s.s) === selected && s.p.value === RDF_TYPE);
    const typeDef = typeStmt ? allTypes().find(t => t.iri === typeStmt.o.value) ?? null : null;
    const outgoing = visible
      .filter(s => termKey(s.s) === selected && s.p.value !== RDF_TYPE)
      .map(s => ({
        predicate: s.p.value.split('/').pop() ?? s.p.value,
        target: s.o.kind === 'iri' ? (s.o.value.split('/').pop() ?? s.o.value) : s.o.value.slice(0, 48),
        targetKey: termKey(s.o),
        status: s.status
      }));
    const incoming = visible
      .filter(s => termKey(s.o) === selected)
      .map(s => ({
        predicate: s.p.value.split('/').pop() ?? s.p.value,
        source: s.s.kind === 'iri' ? (s.s.value.split('/').pop() ?? s.s.value) : s.s.value.slice(0, 48),
        sourceKey: termKey(s.s),
        status: s.status
      }));

    // Show which sources contribute to this entity
    const entityIri = selected.startsWith('i:') ? selected.slice(2) : null;
    if (entityIri) {
      const entitySrcIds = new Set(visible.filter(s => s.s.kind === 'iri' && s.s.value === entityIri && s.sourceId).map(s => s.sourceId));
      for (const sid of entitySrcIds) {
        const src = sources().find(s => s.id === sid);
        incoming.push({
          predicate: 'sourced-by',
          source: src?.title ?? sid,
          sourceKey: `src:${sid}`,
          status: 'confirmed'
        });
      }
    }

    return { label, typeDef, outgoing, incoming };
  });

  // ── Edge-zone / swipe actions ───────────────────────────────────────────────

  let confirmingDelete = $state(false);
  let expandedTriples = $state(false);

  // All non-rejected triples that involve the selected entity (as s or o),
  // across ALL statements — not just the currently-visible filtered subset.
  const deleteTargets = $derived(
    selected
      ? statements().filter(
          (s) =>
            s.status !== 'rejected' &&
            s.status !== 'superseded' &&
            (termKey(s.s) === selected || termKey(s.o) === selected)
        )
      : []
  );

  async function confirmDelete() {
    if (!selected) return;
    for (const st of deleteTargets) {
      await setStatus(st.id, 'rejected');
    }
    confirmingDelete = false;
    selected = null;
  }

  function deleteSelected() {
    if (!selected) return;
    if (deleteTargets.length > 1) {
      confirmingDelete = true;
    } else {
      confirmDelete();
    }
  }

  // Reset confirmation state whenever the selected entity changes.
  // Safe: reads `selected` (dependency), writes `confirmingDelete` (not read here → no cycle).
  $effect(() => {
    selected;
    confirmingDelete = false;
    addingLink = false;
    newLinkValue = '';
    expandedTriples = false;
  });

  // ── Entity links (URL / local-path) ──────────────────────────────────────
  const entityLinks = $derived.by(() => {
    if (!selected || !selected.startsWith('i:')) return { urls: [] as import('$lib/rdf/types').Statement[], localPaths: [] as import('$lib/rdf/types').Statement[] };
    const entityIri = selected.slice(2);
    const all = statements().filter(s =>
      s.s.kind === 'iri' && s.s.value === entityIri &&
      s.status !== 'rejected' && s.status !== 'superseded'
    );
    return {
      urls: all.filter(s => s.p.value === KB_URL),
      localPaths: all.filter(s => s.p.value === KB_LOCAL_PATH)
    };
  });

  let addingLink = $state(false);
  let newLinkKind = $state<'url' | 'local-path'>('url');
  let newLinkValue = $state('');

  // ── Per-entity GLB model override (editor-level, not stored in KB) ────────
  const entityIcon3dUrl = $derived.by(() => {
    if (!selected || !selected.startsWith('i:')) return '';
    return glbOverrides().get(selected.slice(2)) ?? '';
  });

  let editingIcon3d = $state(false);
  let icon3dDraft = $state('');

  async function saveEntityIcon3d() {
    if (!selected) return;
    const entityIri = selected.startsWith('i:') ? selected.slice(2) : selected;
    if (icon3dDraft.trim()) {
      await setGlb(entityIri, icon3dDraft.trim());
    } else {
      await clearGlb(entityIri);
    }
    editingIcon3d = false;
    icon3dDraft = '';
  }

  async function clearEntityIcon3d() {
    if (!selected) return;
    const entityIri = selected.startsWith('i:') ? selected.slice(2) : selected;
    await clearGlb(entityIri);
    editingIcon3d = false;
  }

  // ── GIF assignment ────────────────────────────────────────────────────────
  const entityGifUrl = $derived.by(() => {
    if (!selected?.startsWith('i:')) return null;
    const iri = selected.slice(2);
    return gifOverrides().get(iri) ?? null;
  });

  async function assignEntityGif(file: File) {
    if (!selected?.startsWith('i:')) return;
    const iri = selected.slice(2);
    await setGif(iri, file, file.name);
  }

  async function clearEntityGif() {
    if (!selected?.startsWith('i:')) return;
    const iri = selected.slice(2);
    await clearGif(iri);
  }

  // ── Per-entity 2D icon override ──────────────────────────────────────────
  const entityIcon2dUrl = $derived.by(() => {
    if (!selected?.startsWith('i:')) return '';
    return icon2dOverrides().get(selected.slice(2)) ?? '';
  });

  let editingIcon2d = $state(false);
  let icon2dDraft = $state('');

  async function saveEntityIcon2d() {
    if (!selected) return;
    const entityIri = selected.startsWith('i:') ? selected.slice(2) : selected;
    if (icon2dDraft.trim()) {
      await setIcon2d(entityIri, icon2dDraft.trim());
    } else {
      await clearIcon2d(entityIri);
    }
    editingIcon2d = false;
    icon2dDraft = '';
  }

  async function clearEntityIcon2d() {
    if (!selected) return;
    const entityIri = selected.startsWith('i:') ? selected.slice(2) : selected;
    await clearIcon2d(entityIri);
    editingIcon2d = false;
  }

  async function saveLink() {
    if (!selected || !newLinkValue.trim()) { addingLink = false; return; }
    const entityIri = selected.startsWith('i:') ? selected.slice(2) : selected;
    const now = Date.now();
    const { v4: uuidv4 } = await import('uuid');
    await addStatements([{
      id: uuidv4(),
      s: { kind: 'iri', value: entityIri },
      p: { kind: 'iri', value: newLinkKind === 'url' ? KB_URL : KB_LOCAL_PATH },
      o: { kind: 'literal', value: newLinkValue.trim() },
      g: { kind: 'iri', value: 'urn:kbase:source/manual' },
      sourceId: 'manual',
      confidence: 1.0,
      status: 'confirmed',
      createdAt: now,
      updatedAt: now
    }]);
    newLinkValue = '';
    addingLink = false;
  }

  function onLinkKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); saveLink(); }
    if (e.key === 'Escape') { addingLink = false; newLinkValue = ''; }
  }

  async function removeLink(stId: string) {
    await setStatus(stId, 'rejected');
  }

  // ── KB Leaps ──────────────────────────────────────────────────────────────
  let addingLeap   = $state(false);
  let newLeapId    = $state('');
  let newLeapLabel = $state('');

  const entityLeap = $derived.by(() => {
    if (!selected || !selected.startsWith('i:')) return null;
    return getLeap(statements(), selected);
  });

  async function saveLeap() {
    if (!selected || !newLeapId.trim()) return;
    const entityIri = selected.slice(2);
    const { v4: uuidv4 } = await import('uuid');
    const now = Date.now();
    const stmts: Parameters<typeof addStatements>[0] = [{
      id: uuidv4(),
      s: { kind: 'iri', value: entityIri },
      p: { kind: 'iri', value: LEAP_PRED },
      o: { kind: 'literal', value: newLeapId.trim() },
      g: { kind: 'iri', value: 'urn:kbase:source/manual' },
      sourceId: 'manual',
      confidence: 1.0,
      status: 'confirmed',
      createdAt: now,
      updatedAt: now
    }];
    if (newLeapLabel.trim()) {
      stmts.push({
        id: uuidv4(),
        s: { kind: 'iri', value: entityIri },
        p: { kind: 'iri', value: LEAP_LABEL_PRED },
        o: { kind: 'literal', value: newLeapLabel.trim() },
        g: { kind: 'iri', value: 'urn:kbase:source/manual' },
        sourceId: 'manual',
        confidence: 1.0,
        status: 'confirmed',
        createdAt: now,
        updatedAt: now
      });
    }
    await addStatements(stmts);
    addingLeap = false;
    newLeapId = '';
    newLeapLabel = '';
  }

  async function removeLeap() {
    if (!entityLeap) return;
    for (const id of entityLeap.statementIds) await setStatus(id, 'rejected');
  }

  /** Map of docs sub-graph stable IDs to their static file paths. */
  const DOCS_KB_MAP: Record<string, { file: string; name: string }> = {
    'a1b2c3d4-e5f6-4a00-b000-000000000000': { file: '/starter-guide.ttl', name: 'Documentation Hub' },
    'a1b2c3d4-e5f6-4a01-b001-000000000001': { file: '/docs-triples-rdf.ttl', name: 'Triples & RDF' },
    'a1b2c3d4-e5f6-4a02-b002-000000000002': { file: '/docs-llm.ttl', name: 'Language Models' },
    'a1b2c3d4-e5f6-4a03-b003-000000000003': { file: '/docs-use-cases.ttl', name: 'Use Cases' },
    'a1b2c3d4-e5f6-4a04-b004-000000000004': { file: '/docs-features.ttl', name: 'Features' },
    'a1b2c3d4-e5f6-4a05-b005-000000000005': { file: '/docs-integrations-tech.ttl', name: 'Integrations & Tech' },
    'a1b2c3d4-e5f6-4a06-b006-000000000006': { file: '/docs-tips-security.ttl', name: 'Tips & Security' },
    'a1b2c3d4-e5f6-4a07-b007-000000000007': { file: '/docs-timeline-ecosystem.ttl', name: 'Timeline & Ecosystem' },
  };

  let leapImporting = $state(false);

  async function jumpToLeap() {
    if (!entityLeap) return;
    if (entityLeap.kind === 'url') {
      window.open(entityLeap.target, '_blank', 'noopener');
    } else if (entityLeap.kind === 'app') {
      goto(entityLeap.target);
    } else {
      // KB stable ID — find and switch
      const found = findKbByStableId(entityLeap.target);
      if (found) {
        switchToKb(found.id);
        return;
      }
      // Auto-import known docs sub-graphs
      const docsEntry = DOCS_KB_MAP[entityLeap.target];
      if (docsEntry) {
        leapImporting = true;
        try {
          const resp = await fetch(docsEntry.file);
          if (!resp.ok) throw new Error(`Failed to fetch ${docsEntry.file}`);
          const ttlText = await resp.text();
          const { importTurtleFull } = await import('$lib/rdf/import-ttl');
          const { KBaseDB, DEFAULT_SETTINGS } = await import('$lib/storage/db');
          const { v4: uuidv4 } = await import('uuid');

          const { statements: rawStmts } = await importTurtleFull(ttlText);
          const newKb = createKb(docsEntry.name);
          const tempDb = new KBaseDB(newKb.id);
          await tempDb.open();
          await tempDb.settings.put({ ...DEFAULT_SETTINGS, kbTitle: docsEntry.name, kbStableId: entityLeap.target });

          const now = Date.now();
          const sourceId = uuidv4();
          await tempDb.sources.put({
            id: sourceId, title: docsEntry.name,
            uri: `file://${docsEntry.file}`, kind: 'document',
            trustLevel: 'trusted', ingestedAt: now,
          });

          const stmts = rawStmts
            .filter(s => s.status === 'confirmed' || s.status === 'refined' || s.status === 'pending')
            .map(s => ({
              ...s, id: uuidv4(), sourceId,
              g: { kind: 'iri' as const, value: `urn:kbase:source/${sourceId}` },
              status: 'confirmed' as const, createdAt: now, updatedAt: now,
            }));
          await tempDb.statements.bulkPut(stmts);
          registerStableId(newKb.id, entityLeap.target, stmts.length);
          tempDb.close();
          switchToKb(newKb.id);
        } catch (e) {
          alert(`Failed to import docs KB: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          leapImporting = false;
        }
      } else {
        alert(`KB not found on this device.\n\nStable ID: ${entityLeap.target.slice(0, 8).toUpperCase()}\n\nImport the target KB's .ttl file as a new KB first\n(Ingest page → upload file → "as new KB" button).`);
      }
    }
  }

  // ── Entity label editing ──────────────────────────────────────────────────
  const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
  let editingLabel = $state(false);
  let labelDraft = $state('');

  // Reset schema fields panel when selected entity changes
  $effect(() => { if (selected) showSchemaFields = false; });

  function startEditLabel() {
    if (!nodeDetails) return;
    labelDraft = nodeDetails.label;
    editingLabel = true;
  }

  async function saveLabel() {
    if (!selected || !labelDraft.trim()) { editingLabel = false; return; }
    const entityIri = selected.startsWith('i:') ? selected.slice(2) : selected;
    const now = Date.now();
    const existing = statements().find(
      s => s.s.kind === 'iri' && s.s.value === entityIri && s.p.value === RDFS_LABEL
    );
    if (existing) {
      await updateStatement(existing.id, { o: { kind: 'literal', value: labelDraft.trim() } });
    } else {
      const { v4: uuid } = await import('uuid');
      await addStatements([{
        id: uuid(),
        s: { kind: 'iri', value: entityIri },
        p: { kind: 'iri', value: RDFS_LABEL },
        o: { kind: 'literal', value: labelDraft.trim() },
        g: { kind: 'iri', value: 'urn:kbase:source/manual' },
        sourceId: 'manual',
        confidence: 1.0,
        status: 'confirmed',
        createdAt: now,
        updatedAt: now
      }]);
    }
    editingLabel = false;
  }

  function onLabelKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); saveLabel(); }
    if (e.key === 'Escape') { editingLabel = false; }
  }

  // ── Shelly view adjustments ───────────────────────────────────────────────
  $effect(() => {
    const adj = shellyViewAdjust();
    if (!adj) return;
    if (adj.selectEntity) selected = `i:${adj.selectEntity}`;
    if (adj.layout) layout = adj.layout;
    if (adj.filters) activeFilters = new Set(adj.filters);
    clearShellyViewAdjust();
  });

  // ── Keyboard graph navigation ─────────────────────────────────────────────
  $effect(() => {
    function onKeydown(e: KeyboardEvent) {
      // Don't intercept when user is typing
      const tag = (e.target as Element)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.key === 'Escape') {
        selected = null;
        navHistory = [];
        showMergeUI = false;
        showRelationUI = false;
        showMergeReview = false;
        return;
      }

      if (e.key === 'Backspace' && !showMergeUI && !showRelationUI) {
        // Navigate back in history
        if (navHistory.length > 0) {
          selected = navHistory[navHistory.length - 1];
          navHistory = navHistory.slice(0, -1);
        } else {
          selected = null;
        }
        e.preventDefault();
        return;
      }

      if (!selected || !nodeDetails) return;

      const conns = [
        ...nodeDetails.outgoing.map(r => r.targetKey),
        ...nodeDetails.incoming.map(r => r.sourceKey)
      ].filter((k, i, arr) => arr.indexOf(k) === i && k !== selected); // unique, exclude self

      if (conns.length === 0) return;

      // Tab / ArrowRight: cycle forward through connections
      if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'ArrowRight') {
        e.preventDefault();
        // Find where we currently are in conns (if we navigated here from one of them)
        const lastNav = navHistory[navHistory.length - 1];
        const curIdx = lastNav ? conns.indexOf(lastNav) : -1;
        const next = conns[(curIdx + 1) % conns.length];
        navHistory = [...navHistory, selected];
        selected = next;
        return;
      }

      // Shift+Tab / ArrowLeft: cycle backward
      if ((e.key === 'Tab' && e.shiftKey) || e.key === 'ArrowLeft') {
        e.preventDefault();
        const lastNav = navHistory[navHistory.length - 1];
        const curIdx = lastNav ? conns.indexOf(lastNav) : 0;
        const prev = conns[(curIdx - 1 + conns.length) % conns.length];
        navHistory = [...navHistory, selected];
        selected = prev;
        return;
      }
    }

    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  // ── Ctrl+click multi-select ──────────────────────────────────────────────
  let multiSelected = $state(new Set<string>());

  const multiSelectedList = $derived(
    [...multiSelected]
      .map(k => graphNodeList.find(n => n.key === k))
      .filter(Boolean) as { key: string; label: string; iri: string }[]
  );

  /**
   * Perform the merge after the user has reviewed conflicts in MergeReview.
   * keepKey  — termKey of the entity whose IRI is kept
   * conflicts — pairs of {keepId, rejectId} from conflict resolution
   */
  async function mergeConcepts(keepKey: string, conflictChoices: { keepId: string; rejectId: string }[]) {
    if (!selected || !mergeTarget.trim()) return;
    const { updateStatement, setStatus } = await import('$lib/stores/kb.svelte');

    const keepIri  = keepKey.startsWith('i:') ? keepKey.slice(2) : keepKey;
    const dropKey  = keepKey === selected ? `i:${mergeTarget}` : selected;
    const keepNode = { kind: 'iri' as const, value: keepIri };

    // 1. Reject the losing side of each conflict
    for (const { rejectId } of conflictChoices) {
      await setStatus(rejectId, 'rejected');
    }

    // 2. Redirect all of dropKey's statements to keepIri
    const toRedirect = statements().filter(
      s => (termKey(s.s) === dropKey || termKey(s.o) === dropKey) &&
           s.status !== 'rejected' && s.status !== 'superseded'
    );
    for (const st of toRedirect) {
      const patch: Partial<typeof st> = {};
      if (termKey(st.s) === dropKey) patch.s = keepNode;
      if (termKey(st.o) === dropKey) patch.o = keepNode;
      if (Object.keys(patch).length > 0) await updateStatement(st.id, patch);
    }

    showMergeReview = false;
    showMergeUI = false;
    mergeTarget = '';
    selected = null;
  }

  async function handleCreateRelation(
    predicateSlug: string,
    targetIri: string,
    newTypeDef?: import('$lib/rdf/entity-types').EntityTypeDef
  ) {
    if (!selected) return;
    const { addStatements } = await import('$lib/stores/kb.svelte');
    const { v4: uuid } = await import('uuid');

    // Extract subject IRI from termKey (strip leading "i:")
    const subjectIri = selected.startsWith('i:') ? selected.slice(2) : selected;
    const now = Date.now();
    const stmts: any[] = [];

    // If creating a new node, first add its rdf:type statement
    if (newTypeDef) {
      stmts.push({
        id: uuid(),
        s: { kind: 'iri', value: targetIri },
        p: { kind: 'iri', value: RDF_TYPE },
        o: { kind: 'iri', value: newTypeDef.iri },
        g: { kind: 'iri', value: 'urn:kbase:source/manual' },
        sourceId: 'manual',
        confidence: 1.0,
        status: 'confirmed',
        createdAt: now,
        updatedAt: now
      });
    }

    // Create the relation itself
    stmts.push({
      id: uuid(),
      s: { kind: 'iri', value: subjectIri },
      p: { kind: 'iri', value: `urn:kbase:predicate/${predicateSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` },
      o: { kind: 'iri', value: targetIri },
      g: { kind: 'iri', value: 'urn:kbase:source/manual' },
      sourceId: 'manual',
      confidence: 1.0,
      status: 'confirmed',
      createdAt: now,
      updatedAt: now
    });

    await addStatements(stmts);
    showRelationUI = false;
  }
</script>

<div class="viewport" onpointermove={onGraphPointerMove}>
  <section class="graph" class:graph-landing={visible.length === 0}>
  {#if visible.length === 0}
    <LandingPage />
  {:else if use2D || !webglAvailable}
    <KnowledgeGraph2D
      statements={visible}
      {selected}
      {layout}
      {timelineZoom}
      {timelineCenter}
      {timelineTimeSource}
      sources={sources()}
      targetKey={hoverTarget}
      onselect={(k, ctrlKey) => {
        if (ctrlKey && k) {
          const next = new Set(multiSelected);
          if (next.has(k)) next.delete(k); else next.add(k);
          multiSelected = next;
        } else {
          multiSelected = new Set();
          navHistory = [];
          selected = k;
        }
      }}
      onhover={(k) => (hoverTarget = k)}
      onlabelsmove={(labels) => { nodeLabels = labels; }}
      onmarkersmove={(m) => { markerLabels = m; }}
      ontimelinepan={(c) => { timelineCenter = c; }}
      {nodeOrder}
      onreorder={(order) => { nodeOrder = order; }}
      highlighted={[...highlightedSet]}
      {dimMode}
    />
  {:else}
    <svelte:boundary>
      <Canvas>
        <KnowledgeGraph
          statements={visible}
          {selected}
          {layout}
          {timelineZoom}
          {timelineCenter}
          {timelineTimeSource}
          sources={sources()}
          targetKey={hoverTarget}
          onselect={(k, ctrlKey) => {
        if (ctrlKey && k) {
          const next = new Set(multiSelected);
          if (next.has(k)) next.delete(k); else next.add(k);
          multiSelected = next;
        } else {
          multiSelected = new Set();
          navHistory = [];
          selected = k;
        }
      }}
          onhover={(k) => (hoverTarget = k)}
          onlabelsmove={(labels) => { nodeLabels = labels; }}
          onmarkersmove={(m) => { markerLabels = m; }}
          ontimelinepan={(c) => { timelineCenter = c; }}
          highlighted={[...highlightedSet]}
          {dimMode}
        />
      </Canvas>
      {#snippet failed(error)}
        <div class="no-webgl">
          <p class="no-webgl-title mono">3D graph error</p>
          <p class="no-webgl-sub">{error?.message ?? 'WebGL context could not be created.'}</p>
          <button class="cta" style="margin-top:0.75rem;" onclick={() => { use2D = true; webglAvailable = false; resetPerfMonitor(); updateSettings({ prefer2D: true }); }}>switch to 2D view →</button>
        </div>
      {/snippet}
    </svelte:boundary>
  {/if}

  </section>
</div>

<!-- Floating filter UI overlay — hidden on landing page (no nodes yet) -->
{#if visible.length > 0}
<SnapPanel corner="top-left" width={360} minWidth={240} maxWidth={800} zIndex={300}>
<div class="overlay-inner">

  <!-- FILTERS -->
  <div class="overlay-group">
    <span class="group-label mono">filters</span>
    <div class="chip-row">
      <button class="chip" class:active={activeFilters.has('hubs')} onclick={() => toggleFilter('hubs')}>
        <span class="num">{hubs.length}</span>
        <span class="lbl mono">hubs</span>
      </button>
      <button class="chip" class:active={activeFilters.has('islands')} onclick={() => toggleFilter('islands')}>
        <span class="num">{islandNodes.length}</span>
        <span class="lbl mono">islands</span>
      </button>
      {#if leapKeys.length > 0}
        <button class="chip" class:active={activeFilters.has('leaps')} onclick={() => toggleFilter('leaps')}>
          <span class="num">{leapKeys.length}</span>
          <span class="lbl mono">leaps</span>
        </button>
      {/if}
      <button class="chip" class:active={activeFilters.has('confirmed')} onclick={() => toggleFilter('confirmed')}>
        <span class="num">{visibleConfirmedCount}</span>
        <span class="lbl mono">confirmed</span>
      </button>
      <button class="chip" class:active={activeFilters.has('pending')} onclick={() => toggleFilter('pending')}>
        <span class="num">{visiblePendingCount}</span>
        <span class="lbl mono">pending</span>
      </button>
      <!-- Sources filter chip -->
      <Popover.Root bind:open={showSourceFilter} onOpenChange={(o) => { if (o) showTypeFilter = false; }}>
        <Popover.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              class="chip"
              class:active={selectedSources.size > 0 || activeFilters.has('no-source') || showSourceFilter}
            >
              <span class="num">{selectedSources.size > 0 || activeFilters.has('no-source') ? selectedSources.size + (activeFilters.has('no-source') ? 1 : 0) : sources().filter(s => s.kind !== 'analysis').length}</span>
              <span class="lbl mono">sources</span>
              <span class="arr mono">{showSourceFilter ? '▲' : '▼'}</span>
            </button>
          {/snippet}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content class="filter-popover" sideOffset={6}>
            {#each sources().filter(s => s.kind !== 'analysis') as src (src.id)}
              <button class="chip small" class:active={selectedSources.has(src.id)} onclick={() => toggleSource(src.id)}>
                {src.title.length > 24 ? src.title.slice(0, 24) + '…' : src.title}
              </button>
            {/each}
            {#if manualStatements.length > 0}
              <button
                class="chip small"
                class:active={activeFilters.has('no-source')}
                onclick={() => toggleFilter('no-source')}
              >
                <span class="lbl mono">manual</span>
                <span class="num">{manualStatements.length}</span>
              </button>
            {/if}
            {#if selectedSources.size > 0 || activeFilters.has('no-source')}
              <button class="chip small chip-clear" onclick={() => { selectedSources = new Set(); activeFilters.delete('no-source'); activeFilters = new Set(activeFilters); }}>clear</button>
            {/if}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <!-- Types filter chip -->
      {#if activeEntityTypes.length > 0 || untypedSubjectIris.size > 0}
        <Popover.Root bind:open={showTypeFilter} onOpenChange={(o) => { if (o) showSourceFilter = false; }}>
          <Popover.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                class="chip"
                class:active={selectedTypes.size > 0 || activeFilters.has('no-type') || showTypeFilter}
              >
                <span class="num">{selectedTypes.size > 0 || activeFilters.has('no-type') ? selectedTypes.size + (activeFilters.has('no-type') ? 1 : 0) : activeEntityTypes.length}</span>
                <span class="lbl mono">types</span>
                <span class="arr mono">{showTypeFilter ? '▲' : '▼'}</span>
              </button>
            {/snippet}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content class="filter-popover" sideOffset={6}>
              {#each activeEntityTypes as t}
                <button
                  class="chip small type-chip"
                  class:active={selectedTypes.has(t.iri)}
                  onclick={() => toggleType(t.iri)}
                  style="--type-color: {t.color}"
                >
                  <span class="type-dot" style="background: {t.color}"></span>
                  <span class="lbl mono">{t.label}</span>
                  <span class="num">{typeCounts.get(t.iri) ?? 0}</span>
                </button>
              {/each}
              {#if untypedSubjectIris.size > 0}
                <button
                  class="chip small"
                  class:active={activeFilters.has('no-type')}
                  onclick={() => toggleFilter('no-type')}
                >
                  <span class="lbl mono">no type</span>
                  <span class="num">{untypedSubjectIris.size}</span>
                </button>
              {/if}
              {#if selectedTypes.size > 0 || activeFilters.has('no-type')}
                <button class="chip small chip-clear" onclick={() => { selectedTypes = new Set(); activeFilters.delete('no-type'); activeFilters = new Set(activeFilters); }}>clear</button>
              {/if}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      {/if}
    </div>
  </div>

  <!-- FORCE -->
  <div class="overlay-group">
    <span class="group-label mono">force</span>
    <ToggleGroup.Root
      type="single"
      value={layout}
      onValueChange={(v) => { if (v) layout = v as typeof layout; }}
      class="tg-row"
    >
      <ToggleGroup.Item value="force" class="tg-chip"><span class="lbl mono">free</span></ToggleGroup.Item>
      <ToggleGroup.Item value="focus" class="tg-chip"><span class="lbl mono">focus</span></ToggleGroup.Item>
      {#if sources().filter(s => s.kind !== 'analysis').length > 1}
        <ToggleGroup.Item value="source" class="tg-chip"><span class="lbl mono">source</span></ToggleGroup.Item>
      {/if}
      {#if activeEntityTypes.length > 0}
        <ToggleGroup.Item value="type" class="tg-chip"><span class="lbl mono">type</span></ToggleGroup.Item>
      {/if}
      <ToggleGroup.Item value="hub" class="tg-chip"><span class="lbl mono">hub</span></ToggleGroup.Item>
      <ToggleGroup.Item value="timeline" class="tg-chip"><span class="lbl mono">time</span></ToggleGroup.Item>
      <ToggleGroup.Item value="order" class="tg-chip"><span class="lbl mono">order</span></ToggleGroup.Item>
    </ToggleGroup.Root>
  </div>

  <!-- TIMELINE CONTROLS (visible only when timeline layout is active) -->
  {#if layout === 'timeline'}
  <div class="overlay-group">
    <span class="group-label mono">timeline</span>
    <div class="timeline-controls">
      <div class="timeline-row">
        <span class="timeline-label mono">zoom</span>
        <input
          type="range"
          min="1"
          max="50"
          step="0.5"
          bind:value={timelineZoom}
          class="timeline-slider"
        />
        <span class="timeline-value mono">{timelineZoom.toFixed(0)}x</span>
      </div>
      <div class="timeline-row">
        <span class="timeline-label mono">show</span>
        <div class="chip-row">
          <button
            class="chip chip-sm"
            class:active={timelineTimeSource === 'event'}
            onclick={() => { timelineTimeSource = 'event'; timelineCenter = null; }}
          ><span class="lbl mono">event dates</span></button>
          <button
            class="chip chip-sm"
            class:active={timelineTimeSource === 'ingested'}
            onclick={() => { timelineTimeSource = 'ingested'; timelineCenter = null; }}
          ><span class="lbl mono">ingested</span></button>
        </div>
      </div>
      {#if timelineCenter !== null}
      <div class="timeline-row">
        <button
          class="chip chip-sm"
          onclick={() => { timelineCenter = null; timelineZoom = 1; }}
        ><span class="lbl mono">reset view</span></button>
      </div>
      {/if}
    </div>
  </div>
  {/if}



</div>
</SnapPanel>
{/if}

{#if visible.length > 0}
<SearchBar
  statements={statements()}
  onselectnode={(key) => { selected = key; }}
  onselectstatement={(_, subjectKey) => { selected = subjectKey; }}
  onshellyquery={(q) => requestShellyChat(q)}
  onshellyopen={() => setShellyChatOpen(true)}
/>
{/if}

<!-- Multi-select action panel — shown when 2+ nodes selected via Ctrl+click -->
{#if multiSelected.size >= 2}
  {@const [nodeA, nodeB] = multiSelectedList}
  <div class="multisel-panel">
    <span class="multisel-count mono">{multiSelected.size} selected</span>
    <div class="multisel-nodes">
      {#each multiSelectedList as n (n.key)}
        <span class="multisel-tag mono">{n.label}</span>
      {/each}
    </div>
    <div class="multisel-actions">
      <button class="np-act-btn" onclick={() => {
        selected = nodeA.key;
        mergeTarget = nodeB.iri;
        multiSelected = new Set();
        showMergeUI = true;
      }}>⟷ merge</button>
      <button class="np-act-btn np-act-primary" onclick={() => {
        selected = nodeA.key;
        multiSelected = new Set();
        showRelationUI = true;
      }}>+ relate</button>
      <button class="np-act-btn" onclick={() => (multiSelected = new Set())}>✕ clear</button>
    </div>
  </div>
{/if}

<!-- Always-visible node labels — outer wrapper positions (GPU), inner handles hover scale -->
<!-- transition:fade handles distance-culling enter/exit; dim-hidden handles dimMode + selected -->
{#each nodeLabels as n (n.key)}
  <div
    class="node-label-wrap"
    transition:fade={{ duration: 220 }}
    style="transform: translate3d({n.x}px, {n.y}px, 0); --lfs: {labelFontSize}px; --lop: {n.opacity ?? 0.85};"
  >
    <span
      class="node-label mono"
      class:hovered={n.key === hoverTarget}
      class:selected-node={n.key === selected}
      class:dim-hidden={dimMode && !highlightedSet.has(n.key) && n.key !== hoverTarget && n.key !== selected}
    >{n.label}</span>
  </div>
{/each}

<!-- Layout anchor labels (source/type/hub cluster markers) -->
{#each markerLabels as m (m.key)}
  <div
    class="marker-label mono"
    style="left: {m.x}px; top: {m.y}px; --mc: {m.color};"
  >
    {m.label}
  </div>
{/each}

<!-- Long-hover preview (GIF and/or metadata card) -->
{#if gifActiveKey}
  {@const activeIri = iriFromNodeKey(gifActiveKey)}
  {@const gifSrc = activeIri ? gifOverrides().get(activeIri) : null}
  {@const activeMeta = hoverMeta?.iri === activeIri ? hoverMeta : null}
  {#if gifSrc || activeMeta}
    <div
      class="gif-preview"
      style="left: {gifPointerX + 16}px; top: {gifPointerY - 8}px;"
      in:gifReveal
      out:fade={{ duration: 120 }}
    >
      {#if gifSrc}
        <img src={gifSrc} alt="entity preview" />
      {/if}
      {#if activeMeta}
        <div class="hover-meta-card">
          <span class="hover-meta-type mono">{activeMeta.typeDef.icon2d ?? ''} {activeMeta.typeDef.label}</span>
          {#each activeMeta.fields as f}
            <div class="hover-meta-row">
              <span class="hover-meta-label mono">{f.label}</span>
              <span class="hover-meta-value">{f.value}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
{/if}

<!-- Keyboard nav hint (shown briefly when a node is selected) -->
{#if selected && navHistory.length === 0}
  <div class="kb-hint mono">
    <span>tab/→ next</span>
    <span>⌫ back</span>
    <span>esc deselect</span>
  </div>
{/if}

<!-- Sources panel (independent overlay) -->
{#if showSourcesPanel}
  <section class="sources-overlay">
    <div class="sources-header">
      <h3 class="sources-title mono">sources</h3>
      <button class="ghost" onclick={() => (showSourcesPanel = false)}>✕</button>
    </div>
    <SourcesPanel />
  </section>
{/if}

<!-- Unified node panel — shown when a node is selected -->
{#if selected && nodeDetails}
  {@const info = nodeDetails}
  <SnapPanel corner="bottom-right" width={320} minWidth={240} maxWidth={800} zIndex={300} extraStyle="max-height: calc(100vh - {124 + notificationStackHeight.get()}px)">
    {#snippet header()}
    <!-- Header: name + type + close -->
    <div class="np-header">
      <div class="np-title-row">
        {#if editingLabel}
          <input
            class="np-label-input mono"
            bind:value={labelDraft}
            onkeydown={onLabelKeydown}
            onblur={saveLabel}
            autofocus
          />
        {:else}
          <button class="np-label-btn" onclick={startEditLabel} title="click to edit label">
            <h3 class="np-label mono">{info.label}</h3>
            <span class="edit-hint mono">✎</span>
          </button>
        {/if}
        <Select
          value={info.typeDef?.iri ?? ''}
          class="np-type-select"
          options={[{value: '', label: 'no type'}, ...allTypes().map(t => ({value: t.iri, label: t.label}))]}
          onchange={async (newTypeIri) => {
            const entityIri = selected!.startsWith('i:') ? selected!.slice(2) : selected!;
            const { v4: uuidv4 } = await import('uuid');
            const oldType = statements().find(s =>
              s.s.kind === 'iri' && s.s.value === entityIri && s.p.value === RDF_TYPE &&
              s.status !== 'rejected' && s.status !== 'superseded'
            );
            if (oldType) await setStatus(oldType.id, 'rejected');
            if (newTypeIri) {
              const now = Date.now();
              await addStatements([{
                id: uuidv4(),
                s: { kind: 'iri', value: entityIri },
                p: { kind: 'iri', value: RDF_TYPE },
                o: { kind: 'iri', value: newTypeIri },
                g: { kind: 'iri', value: 'urn:kbase:source/manual' },
                sourceId: 'manual',
                confidence: 1.0,
                status: 'confirmed',
                createdAt: now,
                updatedAt: now
              }]);
            }
          }}
        />
      </div>
      <button class="ghost np-close-btn" onclick={() => { selected = null; editingLabel = false; showMergeUI = false; showRelationUI = false; showMergeReview = false; }}>✕</button>
    </div>
    {/snippet}
    <div class="np-body">

    <!-- Action row — always visible, at the top (not for source nodes) -->
    {#if !showMergeUI && !showRelationUI && !selected?.startsWith('src:')}
      {#if confirmingDelete}
        <div class="np-action-row np-action-confirm">
          <span class="np-confirm-label mono">delete {deleteTargets.length} triple{deleteTargets.length !== 1 ? 's' : ''}?</span>
          <button class="np-act-btn np-act-danger" onclick={confirmDelete}>confirm</button>
          <button class="np-act-btn" onclick={() => (confirmingDelete = false)}>cancel</button>
        </div>
      {:else}
        <div class="np-action-row">
          <button class="np-act-btn" onclick={() => (showMergeUI = true)}>⟷ merge</button>
          <button class="np-act-btn np-act-primary" onclick={() => (showRelationUI = true)}>+ relate</button>
          <button class="np-act-btn np-act-danger" onclick={deleteSelected}>✕ delete</button>
        </div>
      {/if}
    {/if}

    <!-- Quick connections -->
    {#if info.outgoing.length > 0 || info.incoming.length > 0}
      <div class="np-connections">
        {#if info.outgoing.length > 0}
          <p class="np-conn-title mono">outgoing</p>
          {#each info.outgoing.slice(0, 5) as rel}
            <button class="np-conn-row" onclick={() => (selected = rel.targetKey)}>
              <span class="conn-pred mono">·{rel.predicate}·</span>
              <span class="conn-target">{rel.target}</span>
            </button>
          {/each}
          {#if info.outgoing.length > 5}
            <span class="np-more mono">+{info.outgoing.length - 5} more</span>
          {/if}
        {/if}
        {#if info.incoming.length > 0}
          <p class="np-conn-title mono" style="margin-top: 0.5rem;">incoming</p>
          {#each info.incoming.slice(0, 5) as rel}
            <button class="np-conn-row" onclick={() => (selected = rel.sourceKey)}>
              <span class="conn-source">{rel.source}</span>
              <span class="conn-pred mono">·{rel.predicate}·</span>
            </button>
          {/each}
          {#if info.incoming.length > 5}
            <span class="np-more mono">+{info.incoming.length - 5} more</span>
          {/if}
        {/if}
      </div>
    {/if}

    <!-- Links: URL and local-path -->
    {#if selected?.startsWith('i:')}
      {@const isDocument = info.typeDef?.iri === 'urn:kbase:type/Document'}
      {@const hasLinks = entityLinks.urls.length > 0 || entityLinks.localPaths.length > 0}
      {#if hasLinks || addingLink || isDocument}
        <div class="np-links" class:prominent={isDocument}>
          <p class="np-conn-title mono" style={isDocument ? '' : 'margin-top: 0.5rem;'}>links</p>

          {#each entityLinks.urls as st (st.id)}
            <div class="link-row">
              <a href={st.o.value} target="_blank" rel="noopener noreferrer" class="link-url mono" title={st.o.value}>
                ↗ {st.o.value.length > 44 ? st.o.value.slice(0, 44) + '…' : st.o.value}
              </a>
              <button class="link-rm" onclick={() => removeLink(st.id)} title="remove">✕</button>
            </div>
          {/each}

          {#each entityLinks.localPaths as st (st.id)}
            <div class="link-row link-row--local">
              <span class="link-path mono" title={st.o.value}>📁 {st.o.value.length > 38 ? '…' + st.o.value.slice(-38) : st.o.value}</span>
              <button class="link-rm" onclick={() => removeLink(st.id)} title="remove">✕</button>
            </div>
            <p class="link-warn-inline mono">⚠ local path — only resolves on this machine</p>
          {/each}

          {#if addingLink}
            <div class="link-add-form">
              <div class="link-kind-row">
                <label class="link-kind-opt mono"><input type="radio" bind:group={newLinkKind} value="url"> url</label>
                <label class="link-kind-opt mono"><input type="radio" bind:group={newLinkKind} value="local-path"> local path</label>
              </div>
              {#if newLinkKind === 'local-path'}
                <p class="link-warn-banner mono">⚠ local paths export to .ttl as literal strings but only resolve on this machine.</p>
              {/if}
              <input
                class="link-input"
                type={newLinkKind === 'url' ? 'url' : 'text'}
                placeholder={newLinkKind === 'url' ? 'https://…' : '/path/to/file'}
                bind:value={newLinkValue}
                onkeydown={onLinkKeydown}
                autofocus
              />
              <div class="link-add-buttons">
                <button class="primary" onclick={saveLink} disabled={!newLinkValue.trim()}>save</button>
                <button onclick={() => { addingLink = false; newLinkValue = ''; }}>cancel</button>
              </div>
            </div>
          {:else}
            <button class="link-add-btn mono" onclick={() => { addingLink = true; newLinkKind = 'url'; }}>+ add link</button>
          {/if}
        </div>
      {:else}
        <button class="link-add-btn mono link-add-btn--inline" onclick={() => { addingLink = true; newLinkKind = 'url'; }}>+ add url / path</button>
      {/if}
    {/if}

    <!-- Per-entity 3D model -->
    {#if selected?.startsWith('i:')}
      <div class="np-icon3d">
        <span class="np-conn-title mono" style="margin-top:0.4rem;">3D model</span>
        {#if editingIcon3d}
          <input
            class="link-input"
            type="url"
            placeholder="https://…/model.glb"
            bind:value={icon3dDraft}
            onkeydown={(e) => { if (e.key === 'Enter') saveEntityIcon3d(); if (e.key === 'Escape') { editingIcon3d = false; icon3dDraft = ''; } }}
            autofocus
          />
          <div class="link-add-buttons">
            <button class="primary" onclick={saveEntityIcon3d} disabled={!icon3dDraft.trim()}>save</button>
            <button onclick={() => { editingIcon3d = false; icon3dDraft = ''; }}>cancel</button>
          </div>
        {:else if entityIcon3dUrl}
          <div class="link-row">
            <span class="link-url mono" title={entityIcon3dUrl}>
              ◈ {entityIcon3dUrl.length > 40 ? '…' + entityIcon3dUrl.slice(-38) : entityIcon3dUrl}
            </span>
            <button class="link-rm" onclick={() => { icon3dDraft = entityIcon3dUrl; editingIcon3d = true; }} title="edit">✎</button>
            <button class="link-rm" onclick={clearEntityIcon3d} title="remove">✕</button>
          </div>
        {:else}
          <div class="icon3d-pick-row">
            <label class="icon3d-file-btn mono">
              📁 choose .glb
              <input type="file" accept=".glb,.gltf" style="display:none"
                onchange={async (e) => {
                  const file = (e.currentTarget as HTMLInputElement).files?.[0];
                  if (!file) return;
                  const dataUrl = await new Promise<string>((res) => {
                    const r = new FileReader();
                    r.onload = () => res(r.result as string);
                    r.readAsDataURL(file);
                  });
                  icon3dDraft = dataUrl;
                  await saveEntityIcon3d();
                  (e.currentTarget as HTMLInputElement).value = '';
                }} />
            </label>
            <span class="icon3d-or mono">or</span>
            <button class="link-add-btn mono" onclick={() => { editingIcon3d = true; icon3dDraft = ''; }}>paste url</button>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Per-entity image preview (hover card) -->
    {#if selected?.startsWith('i:')}
      <div class="np-icon3d">
        <span class="np-conn-title mono" style="margin-top:0.4rem;">image preview</span>
        {#if entityGifUrl}
          <div class="gif-thumb-row">
            <img class="gif-thumb" src={entityGifUrl} alt="entity preview" />
            <button class="link-rm" onclick={clearEntityGif} title="remove image">✕</button>
          </div>
        {:else}
          <label class="icon3d-file-btn mono">
            📁 choose image
            <input type="file" accept="image/*,.svg" style="display:none"
              onchange={async (e) => {
                const file = (e.currentTarget as HTMLInputElement).files?.[0];
                if (!file) return;
                await assignEntityGif(file);
                (e.currentTarget as HTMLInputElement).value = '';
              }} />
          </label>
        {/if}
      </div>
    {/if}

    <!-- Per-entity 2D icon (replaces emoji on 2D graph nodes) -->
    {#if selected?.startsWith('i:')}
      <div class="np-icon3d">
        <span class="np-conn-title mono" style="margin-top:0.4rem;">2D icon</span>
        {#if editingIcon2d}
          <input
            class="link-input"
            type="url"
            placeholder="https://…/icon.svg or /path/to/icon.png"
            bind:value={icon2dDraft}
            onkeydown={(e) => { if (e.key === 'Enter') saveEntityIcon2d(); if (e.key === 'Escape') { editingIcon2d = false; icon2dDraft = ''; } }}
            autofocus
          />
          <div class="link-add-buttons">
            <button class="primary" onclick={saveEntityIcon2d} disabled={!icon2dDraft.trim()}>save</button>
            <button onclick={() => { editingIcon2d = false; icon2dDraft = ''; }}>cancel</button>
          </div>
        {:else if entityIcon2dUrl}
          <div class="link-row">
            <img class="icon2d-thumb" src={entityIcon2dUrl} alt="2D icon" />
            <span class="link-url mono" title={entityIcon2dUrl}>
              {entityIcon2dUrl.length > 30 ? '…' + entityIcon2dUrl.slice(-28) : entityIcon2dUrl}
            </span>
            <button class="link-rm" onclick={() => { icon2dDraft = entityIcon2dUrl; editingIcon2d = true; }} title="edit">✎</button>
            <button class="link-rm" onclick={clearEntityIcon2d} title="remove">✕</button>
          </div>
        {:else}
          <div class="icon3d-pick-row">
            <label class="icon3d-file-btn mono">
              📁 choose image
              <input type="file" accept="image/*,.svg" style="display:none"
                onchange={async (e) => {
                  const file = (e.currentTarget as HTMLInputElement).files?.[0];
                  if (!file) return;
                  const dataUrl = await new Promise<string>((res) => {
                    const r = new FileReader();
                    r.onload = () => res(r.result as string);
                    r.readAsDataURL(file);
                  });
                  icon2dDraft = dataUrl;
                  await saveEntityIcon2d();
                  (e.currentTarget as HTMLInputElement).value = '';
                }} />
            </label>
            <span class="icon3d-or mono">or</span>
            <button class="link-add-btn mono" onclick={() => { editingIcon2d = true; icon2dDraft = ''; }}>paste url</button>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Schema metadata fields (from entity type definition) -->
    {#if selected?.startsWith('i:') && info.typeDef?.schemaPredicates?.length}
      {@const entityIri = iriFromNodeKey(selected)!}
      <div class="np-schema-fields">
        <button
          class="np-schema-toggle mono"
          onclick={() => (showSchemaFields = !showSchemaFields)}
        >
          metadata {showSchemaFields ? '▲' : '▼'}
          {#if schemaFieldValues.size > 0}
            <span class="schema-filled-badge">{schemaFieldValues.size}</span>
          {/if}
        </button>
        {#if showSchemaFields}
          <div class="schema-fields-body">
            {#each info.typeDef.schemaPredicates as predIri (predIri)}
              {@const slug = predIri.split('/').pop() ?? predIri}
              {@const inputType = predicateInputType(predIri)}
              {@const currentVal = schemaFieldValues.get(predIri) ?? ''}
              <div class="schema-field-row">
                <label class="schema-field-label mono">{slug}</label>
                <input
                  class="schema-field-input mono"
                  type={inputType}
                  value={currentVal}
                  placeholder="—"
                  onblur={(e) => setSchemaField(entityIri, predIri, (e.target as HTMLInputElement).value)}
                  onkeydown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- KB Leap -->
    {#if selected?.startsWith('i:')}
      <div class="np-leap">
        <p class="np-conn-title mono" style="margin-top: 0.5rem;">kb leap</p>
        {#if entityLeap}
          <div class="link-row">
            <button class="leap-jump mono" onclick={jumpToLeap} disabled={leapImporting} title={entityLeap.kind === 'url' ? 'open in new tab' : entityLeap.kind === 'app' ? 'navigate' : 'jump to target KB'}>
              {leapImporting ? '...' : entityLeap.kind === 'url' ? '↗' : '⟶'}
            </button>
            <span class="leap-id mono" title={entityLeap.target}>
              {entityLeap.label ?? (entityLeap.kind === 'kb' ? entityLeap.target.slice(0, 8).toUpperCase() : entityLeap.target)}
            </span>
            <button class="link-rm" onclick={() => navigator.clipboard.writeText(entityLeap!.target)} title="copy target">⎘</button>
            <button class="link-rm" onclick={removeLeap} title="remove leap">✕</button>
          </div>
          {#if entityLeap.label && entityLeap.kind === 'kb'}
            <span class="leap-target-id mono">{entityLeap.target.slice(0, 8).toUpperCase()}</span>
          {/if}
        {:else if addingLeap}
          <div class="link-add-form">
            <input
              class="link-input"
              type="text"
              placeholder="KB ID, URL, or app path"
              bind:value={newLeapId}
              onkeydown={(e) => { if (e.key === 'Enter') saveLeap(); if (e.key === 'Escape') { addingLeap = false; newLeapId = ''; newLeapLabel = ''; } }}
              autofocus
            />
            <input
              class="link-input"
              type="text"
              placeholder="label (optional)"
              bind:value={newLeapLabel}
              onkeydown={(e) => { if (e.key === 'Enter') saveLeap(); if (e.key === 'Escape') { addingLeap = false; newLeapId = ''; newLeapLabel = ''; } }}
            />
            <div class="link-add-buttons">
              <button class="primary" onclick={saveLeap} disabled={!newLeapId.trim()}>save</button>
              <button onclick={() => { addingLeap = false; newLeapId = ''; newLeapLabel = ''; }}>cancel</button>
            </div>
          </div>
        {:else}
          <button class="link-add-btn mono" onclick={() => { addingLeap = true; }}>+ add leap</button>
        {/if}
      </div>
    {/if}

    <!-- Statement accordion — collapsed by default -->
    {#if selectedStatements.length > 0}
      <button class="np-stmts-toggle" onclick={() => (expandedTriples = !expandedTriples)}>
        <span class="mono">{selectedStatements.length} statement{selectedStatements.length !== 1 ? 's' : ''}</span>
        <span class="np-stmts-arrow mono">{expandedTriples ? '▲' : '▼'}</span>
      </button>
      {#if expandedTriples}
        <div class="stack">
          {#each selectedStatements as st (st.id)}
            <StatementCard
              statement={st}
              compact={true}
              onclicksubject={(k) => (selected = k)}
              onclickpredicate={(k) => (selected = k)}
              onclickobject={(k) => (selected = k)}
              onhoverterm={(k) => (hoverTarget = k)}
            />
          {/each}
        </div>
      {/if}
    {:else}
      <p class="np-empty">no statements for this node</p>
    {/if}

    <!-- Merge form -->
    {#if showMergeUI}
      {@const mergeExists = statements().some((s) => s.s.value === mergeTarget || s.o.value === mergeTarget)}
      <div class="np-divider"></div>
      <div class="action-form">
        <p class="hint mono">merge <strong style="color:var(--accent)">{info.label}</strong> into:</p>
        <input
          type="text"
          bind:value={mergeTarget}
          list="merge-candidates"
          placeholder="search by name or paste IRI…"
          autocomplete="off"
        />
        <datalist id="merge-candidates">
          {#each graphNodeList.filter(n => n.key.startsWith('i:') && n.key !== selected) as node (node.key)}
            <option value={node.iri}>{node.label}</option>
          {/each}
        </datalist>
        {#if mergeTarget.trim()}
          <p class="target-preview mono">{mergeTarget.split('/').pop() || mergeTarget}</p>
          <p class="hint" style="margin-top: 0.3rem;">
            {mergeExists ? '✓ entity exists — review differences before merging.' : '○ new entity will be created.'}
          </p>
        {/if}
        <div class="form-buttons">
          {#if mergeTarget.trim() && mergeExists}
            <button class="primary" onclick={() => { showMergeReview = true; }}>review differences</button>
          {:else}
            <button class="primary" onclick={() => mergeConcepts(selected!, [])} disabled={!mergeTarget.trim()}>confirm merge</button>
          {/if}
          <button onclick={() => { showMergeUI = false; mergeTarget = ''; showMergeReview = false; }}>cancel</button>
        </div>
      </div>
    {/if}

    <!-- Relation builder -->
    {#if showRelationUI}
      <div class="np-divider"></div>
      <RelationBuilder
        subjectLabel={info.label}
        nodeList={graphNodeList}
        predicateList={existingPredicates}
        typeList={allTypes()}
        oncreate={handleCreateRelation}
        oncancel={() => (showRelationUI = false)}
      />
    {/if}

    </div><!-- np-body -->
  </SnapPanel>
{/if}

<!-- Full-screen merge review overlay -->
{#if showMergeReview && mergeTarget && selected}
  <MergeReview
    entityKeyA={selected}
    entityKeyB={`i:${mergeTarget}`}
    onConfirm={(keepKey: string, conflicts: { keepId: string; rejectId: string }[]) => mergeConcepts(keepKey, conflicts)}
    onCancel={() => { showMergeReview = false; }}
  />
{/if}

<!-- Analysis status / error toast -->
{#if analysisRunning()}
  <div class="analyze-toast running">
    <span class="toast-glyph">◈</span>
    <span class="toast-msg mono">analyzing…</span>
  </div>
{:else if lastAnalysisError()}
  <div class="analyze-toast error">
    <span class="toast-glyph">⚠</span>
    <span class="toast-msg mono">{lastAnalysisError()}</span>
  </div>
{/if}

<style>
  /* ── Analysis toast ── */
  .analyze-toast {
    position: fixed;
    z-index: 380;
    bottom: calc(max(1rem, env(safe-area-inset-bottom)) + 68px);
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 1rem;
    border-radius: 999px;
    font-size: 0.75rem;
    backdrop-filter: blur(14px);
    pointer-events: none;
    animation: toast-in 0.2s ease-out;
  }
  @keyframes toast-in {
    from { opacity: 0; transform: translateX(-50%) translateY(8px); }
    to   { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
  .analyze-toast.running {
    background: rgba(20, 20, 26, 0.85);
    border: 1px solid var(--data);
    color: var(--data);
  }
  .analyze-toast.error {
    background: color-mix(in srgb, var(--danger) 12%, rgba(20,20,26,0.9));
    border: 1px solid var(--danger);
    color: var(--danger);
    max-width: min(480px, 90vw);
    pointer-events: auto;
  }
  .toast-glyph {
    font-size: 0.85rem;
    flex-shrink: 0;
  }
  .toast-msg {
    font-size: 0.72rem;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .analyze-toast.running .toast-glyph {
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  .viewport {
    position: fixed;
    inset: 0;
    z-index: 3;
  }

  .graph {
    width: 100%;
    height: 100%;
    border: none;
    border-radius: 0;
    background: rgba(10, 10, 11, 0.5);
    overflow: hidden;
    margin: 0;
    position: relative;
  }
  .graph-landing {
    overflow: visible; /* landing page scrolls inside its own container */
  }

  .overlay-inner {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.6rem 0.7rem;
  }

  .overlay-group {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .group-label {
    font-size: 0.52rem;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    color: var(--muted);
    padding: 0 0.2rem;
    opacity: 0.7;
  }

  .chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  :global(.filter-popover) {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    padding: 0.5rem 0.6rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
    max-width: 260px;
    z-index: 500;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0.7rem;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    cursor: pointer;
    transition: all 0.15s;
  }
  .chip:hover {
    border-color: var(--muted-2);
    color: var(--ink-2);
  }
  .chip.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }
  .chip.small {
    font-size: 0.68rem;
    padding: 0.2rem 0.55rem;
  }
  .chip-clear {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 30%, var(--line));
  }
  .chip-clear:hover {
    background: color-mix(in srgb, var(--danger) 12%, var(--surface));
    color: var(--danger);
  }
  .chip .num {
    font-size: 1.1rem;
    font-family: var(--font-display);
  }
  .chip .lbl {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.14em;
  }
  .chip .arr {
    font-size: 0.5rem;
    opacity: 0.6;
  }
  .chip-disabled {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.3rem 0.7rem;
    border-radius: var(--rad-sm);
    border: 1px solid color-mix(in srgb, var(--line) 40%, transparent);
    background: var(--surface);
    cursor: not-allowed;
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: color-mix(in srgb, currentColor 35%, transparent);
  }
  .timeline-controls {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .timeline-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .timeline-label {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
    min-width: 2.2rem;
  }
  .timeline-slider {
    flex: 1;
    min-width: 80px;
    max-width: 140px;
    accent-color: var(--accent);
    height: 4px;
  }
  .timeline-value {
    font-size: 0.65rem;
    color: var(--muted);
    min-width: 2rem;
    text-align: right;
  }
  .chip-sm {
    padding: 0.2rem 0.5rem;
  }
  .chip-sm .lbl {
    font-size: 0.56rem;
  }
  .type-chip.active {
    background: color-mix(in srgb, var(--type-color) 15%, var(--surface));
    border-color: var(--type-color);
    color: var(--type-color);
  }
  .type-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .empty, .no-webgl {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    gap: 0.5rem;
  }
  .no-webgl-title {
    font-size: 1.1rem;
    color: var(--ink-2);
    margin: 0;
    font-weight: 600;
  }
  .no-webgl-sub {
    font-size: 0.8rem;
    color: var(--muted);
    margin: 0;
    text-align: center;
    max-width: 380px;
    line-height: 1.5;
  }
  .no-webgl-links {
    display: flex;
    gap: 1rem;
    margin-top: 0.5rem;
  }
  .empty .wordmark {
    font-family: var(--font-display);
    font-size: 2.8rem;
    font-weight: 700;
    color: var(--accent);
    letter-spacing: -0.03em;
    margin: 0;
  }
  .tagline {
    font-size: 0.85rem;
    color: var(--muted);
    text-align: center;
    line-height: 1.5;
    margin: 0;
  }
  .cta {
    margin-top: 0.75rem;
    font-family: var(--font-mono);
    font-size: 0.82rem;
    color: var(--accent);
  }
  /* ── Sources overlay (independent panel, bottom-right) ── */
  .sources-overlay {
    position: fixed;
    right: 36px; /* clear the right edge zone */
    bottom: 1rem;
    width: 320px;
    max-width: calc(100vw - 80px); /* 36px right + 36px left + breathing room */
    max-height: calc(100vh - 5rem);
    background: rgba(20, 20, 26, 0.92);
    backdrop-filter: blur(12px);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1rem 1.1rem;
    overflow-y: auto;
    z-index: 310;
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
  }
  .sources-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }
  .sources-title {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--accent);
    margin: 0;
  }

  /* ── Node panel body (inside SnapPanel) ── */
  .np-body {
    padding: 0.75rem 1rem 1rem;
  }
  /* The node panel SnapPanel gets an accent-colored border */
  :global(.snap-panel:has(.np-header)) {
    border-color: var(--accent);
    box-shadow: 0 8px 36px rgba(0,0,0,0.45),
                0 0 24px color-mix(in srgb, var(--accent) 10%, transparent);
  }

  /* Panel header (drag handle area inside SnapPanel) */
  .np-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.75rem 1rem 0.5rem;
    border-bottom: 1px solid var(--line);
    background: rgba(26, 155, 142, 0.06);
  }
  .np-title-row {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.4rem;
    flex: 1;
  }
  .np-label-btn {
    display: flex; align-items: baseline; gap: 0.35rem;
    background: none; border: none; cursor: pointer; padding: 0;
    text-align: left;
  }
  .np-label-btn:hover .edit-hint { opacity: 1; }
  .edit-hint {
    font-size: 0.62rem; color: var(--muted); opacity: 0;
    transition: opacity 0.15s;
  }
  .np-label {
    font-size: 1.05rem;
    color: var(--accent);
    margin: 0;
    font-weight: 700;
    letter-spacing: -0.01em;
    word-break: break-all;
  }
  .np-label-input {
    font-size: 1rem;
    font-family: var(--font-mono);
    font-weight: 700;
    color: var(--accent);
    background: var(--surface-2);
    border: 1px solid var(--accent);
    border-radius: var(--rad-sm);
    padding: 0.15rem 0.45rem;
    width: 100%;
    min-width: 120px;
    outline: none;
  }
  /* np-type-select is passed as class to Select → applied to .ui-select-trigger */
  :global(.np-type-select.ui-select-trigger) {
    font-size: 0.65rem;
    border-radius: 999px;
    padding: 0.1rem 0.5rem;
    min-width: 0;
    max-width: 140px;
  }
  .np-type-badge {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--c);
    border: 1px solid var(--c);
    border-radius: 999px;
    padding: 0.1rem 0.45rem;
    opacity: 0.85;
    white-space: nowrap;
  }
  .np-close-btn {
    flex-shrink: 0;
    padding: 0.15rem 0.4rem;
    font-size: 0.85rem;
    align-self: flex-start;
  }
  /* Action row */
  .np-action-row {
    display: flex;
    gap: 0.35rem;
    margin: 0.5rem 0 0.6rem;
    flex-wrap: wrap;
  }
  .np-action-confirm {
    align-items: center;
    flex-wrap: nowrap;
  }
  .np-confirm-label {
    font-size: 0.67rem;
    color: var(--danger);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .np-act-btn {
    font-family: var(--font-mono);
    font-size: 0.67rem;
    text-transform: lowercase;
    letter-spacing: 0.04em;
    padding: 0.3rem 0.65rem;
    border-radius: var(--rad-sm);
    border: 1px solid var(--line);
    background: var(--surface-2);
    color: var(--ink-2);
    cursor: pointer;
    transition: all 0.12s;
    white-space: nowrap;
  }
  .np-act-btn:hover { border-color: var(--muted); color: var(--ink); }
  .np-act-primary {
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--surface-2));
  }
  .np-act-primary:hover { background: var(--accent-soft); border-color: var(--accent); }
  .np-act-danger {
    border-color: color-mix(in srgb, var(--danger) 35%, transparent);
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 8%, var(--surface-2));
  }
  .np-act-danger:hover { background: var(--danger); color: #fff; border-color: var(--danger); }
  /* Statement accordion */
  .np-leap {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding-top: 0.25rem;
    padding: 0 0.75rem 0.5rem;
  }
  .leap-jump {
    font-size: 0.8rem;
    color: #f59e0b;
    background: none;
    border: 1px solid transparent;
    border-radius: var(--rad-sm);
    cursor: pointer;
    padding: 0.1rem 0.3rem;
    transition: background 0.15s, border-color 0.15s;
  }
  .leap-jump:hover {
    background: rgba(245, 158, 11, 0.15);
    border-color: #f59e0b;
  }
  .leap-id {
    flex: 1;
    font-size: 0.72rem;
    color: #f59e0b;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .leap-target-id {
    font-size: 0.62rem;
    color: var(--muted);
    padding: 0 0.1rem;
  }

  .np-icon3d {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding-top: 0.25rem;
  }
  .icon3d-pick-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .icon3d-file-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.65rem;
    padding: 0.2rem 0.55rem;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    background: var(--surface-2);
    cursor: pointer;
    transition: border-color 0.12s, color 0.12s;
  }
  .icon3d-file-btn:hover { border-color: var(--accent); color: var(--accent); }
  .icon3d-or {
    font-size: 0.6rem;
    color: var(--muted);
    opacity: 0.6;
  }

  .np-stmts-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 0.4rem 0.5rem;
    margin-top: 0.5rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    font-size: 0.72rem;
    color: var(--muted);
    cursor: pointer;
    transition: border-color 0.12s, background 0.12s;
    text-align: left;
  }
  .np-stmts-toggle:hover { border-color: var(--muted); color: var(--ink-2); background: var(--surface-2); }
  .np-stmts-arrow { font-size: 0.55rem; opacity: 0.6; }
  .np-divider {
    height: 1px;
    background: var(--line);
    margin: 0.75rem 0;
  }

  /* Quick connections */
  .np-connections {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .np-conn-title {
    font-size: 0.58rem;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    color: var(--muted);
    margin: 0 0 0.25rem;
  }
  .np-conn-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.28rem 0.5rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    font-size: 0.75rem;
    cursor: pointer;
    text-align: left;
    transition: border-color 0.12s, background 0.12s;
    color: var(--ink-2);
    min-height: 36px; /* touch-friendly tap target */
  }
  .np-conn-row:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .conn-pred { font-size: 0.63rem; color: var(--muted); flex-shrink: 0; }
  .conn-target { color: var(--data); }
  .conn-source { color: var(--accent); }
  .np-more { font-size: 0.63rem; color: var(--muted); padding: 0.1rem 0.4rem; }
  .np-empty { font-size: 0.8rem; color: var(--muted); margin: 0; }

  /* Links section */
  .np-links {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.5rem 0.6rem;
    margin-top: 0.6rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
  }
  .np-links.prominent {
    background: color-mix(in srgb, var(--data) 6%, var(--surface));
    border-color: color-mix(in srgb, var(--data) 35%, transparent);
    margin-top: 0.35rem;
  }
  .link-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 28px;
  }
  .link-url {
    flex: 1;
    font-size: 0.72rem;
    color: var(--data);
    text-decoration: none;
    word-break: break-all;
    transition: color 0.12s;
  }
  .link-url:hover { color: var(--accent); text-decoration: underline; }
  .link-row--local { flex-wrap: wrap; align-items: flex-start; }
  .link-path {
    flex: 1;
    font-size: 0.72rem;
    color: var(--ink-2);
    word-break: break-all;
  }
  .link-rm {
    font-size: 0.6rem;
    color: var(--muted);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.1rem 0.25rem;
    border-radius: var(--rad-sm);
    flex-shrink: 0;
    transition: color 0.1s, background 0.1s;
  }
  .link-rm:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
  .link-warn-inline {
    font-size: 0.62rem;
    color: #e8a030;
    margin: 0 0 0.15rem;
    padding: 0.15rem 0.35rem;
    background: color-mix(in srgb, #e8a030 8%, transparent);
    border-radius: var(--rad-sm);
    line-height: 1.4;
  }
  .link-warn-banner {
    font-size: 0.62rem;
    color: #e8a030;
    margin: 0;
    padding: 0.3rem 0.4rem;
    background: color-mix(in srgb, #e8a030 10%, transparent);
    border: 1px solid color-mix(in srgb, #e8a030 30%, transparent);
    border-radius: var(--rad-sm);
    line-height: 1.4;
  }
  .link-add-btn {
    font-size: 0.62rem;
    color: var(--muted);
    background: none;
    border: 1px dashed var(--line);
    border-radius: var(--rad-sm);
    padding: 0.2rem 0.5rem;
    cursor: pointer;
    align-self: flex-start;
    transition: color 0.12s, border-color 0.12s;
    margin-top: 0.1rem;
  }
  .link-add-btn:hover { color: var(--data); border-color: var(--data); }
  .link-add-btn--inline {
    margin-top: 0.5rem;
    font-size: 0.6rem;
  }
  .link-add-form {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding-top: 0.2rem;
  }
  .link-kind-row {
    display: flex;
    gap: 0.75rem;
  }
  .link-kind-opt {
    font-size: 0.68rem;
    color: var(--ink-2);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .link-input {
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    background: var(--surface-2);
    font-size: 0.78rem;
    color: var(--ink);
    font-family: var(--font-mono);
    outline: none;
    transition: border-color 0.12s;
  }
  .link-input:focus { border-color: var(--data); }
  .link-add-buttons { display: flex; gap: 0.4rem; }
  .link-add-buttons button { font-size: 0.78rem; padding: 0.3rem 0.65rem; }

  /* Statement stack */
  .stack { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.4rem; }

  /* Merge / relate forms */
  .action-form { display: flex; flex-direction: column; gap: 0.55rem; padding: 0.25rem 0; }
  .action-form input {
    padding: 0.45rem 0.5rem;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    background: var(--surface-2);
    font-size: 0.82rem;
    color: var(--ink);
    outline: none;
    transition: border-color 0.12s;
  }
  .action-form input:focus { border-color: var(--accent); }
  .form-buttons { display: flex; gap: 0.45rem; flex-wrap: wrap; }
  .form-buttons button { font-size: 0.8rem; padding: 0.4rem 0.75rem; }
  .hint { font-size: 0.75rem; color: var(--muted); margin: 0; }
  .target-preview {
    font-size: 0.78rem; color: var(--data); margin: 0;
    padding: 0.2rem 0.45rem; background: var(--data-soft); border-radius: var(--rad-sm);
  }

  /* ── Multi-select panel ── */
  .multisel-panel {
    position: fixed;
    bottom: 1.5rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 320;
    background: rgba(20, 20, 26, 0.92);
    backdrop-filter: blur(12px);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 260px;
    max-width: 420px;
  }
  .multisel-count {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--accent);
  }
  .multisel-nodes {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .multisel-tag {
    font-size: 0.68rem;
    padding: 0.15rem 0.5rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--muted);
  }
  .multisel-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  /* ── Always-visible node labels ── */
  /* Outer wrapper: GPU-composited positioning, transitions to fill 3-frame update gaps */
  .node-label-wrap {
    position: fixed;
    left: 0;
    top: 0;
    pointer-events: none;
    z-index: 10;
    will-change: transform;
    transition: transform 35ms linear;
  }
  /* Inner span: centering + hover scale — separate from position transition */
  .node-label {
    display: block;
    transform: translate(-50%, calc(-100% - 5px));
    font-size: var(--lfs, 11px);
    font-weight: 700;
    /* --lop is the per-label distance opacity (0.25–0.85); base color alpha multiplied by it */
    color: rgba(232, 234, 240, calc(var(--lop, 0.85) * 0.85));
    white-space: nowrap;
    /* Tighter shadow — less blur-radius for crisp text on Firefox */
    text-shadow: 0 1px 2px rgba(0,0,0,0.95), 0 0 6px rgba(0,0,0,0.6);
    transition: transform 0.12s ease-out, color 0.18s ease-out, opacity 0.25s ease-out;
    letter-spacing: 0.02em;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  .node-label.dim-hidden {
    opacity: 0;
    pointer-events: none;
  }
  .node-label.hovered {
    color: rgba(232, 234, 240, 1);
    transform: translate(-50%, calc(-100% - 5px)) scale(1.8);
  }
  .node-label.selected-node {
    color: var(--accent);
    transform: translate(-50%, calc(-100% - 5px)) scale(1.6);
  }
  .node-label.hovered.selected-node {
    transform: translate(-50%, calc(-100% - 5px)) scale(2.0);
  }

  /* ── bits-ui ToggleGroup (layout selector) ── */
  :global(.tg-row) {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  :global(.tg-chip) {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0.7rem;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    cursor: pointer;
    transition: all 0.15s;
    user-select: none;
  }
  :global(.tg-chip:hover) {
    border-color: var(--muted-2, var(--muted));
    color: var(--ink-2, var(--ink));
  }
  :global(.tg-chip[data-state="on"]) {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }

  /* ── Layout anchor labels (source / type / hub cluster markers) ── */
  .marker-label {
    position: fixed;
    transform: translate(-50%, -50%);
    padding: 0.18rem 0.55rem;
    background: color-mix(in srgb, var(--mc, var(--accent)) 18%, rgba(14,14,20,0.82));
    border: 1px solid color-mix(in srgb, var(--mc, var(--accent)) 60%, transparent);
    border-radius: 999px;
    font-size: 0.65rem;
    color: var(--mc, var(--accent));
    pointer-events: none;
    white-space: nowrap;
    z-index: 10;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  /* ── Image thumb in node panel ── */
  .gif-thumb-row {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    margin-top: 0.25rem;
  }
  .gif-thumb {
    display: block;
    max-width: 120px;
    max-height: 120px;
    border-radius: var(--rad-sm);
    border: 1px solid var(--line);
  }
  .icon2d-thumb {
    width: 28px;
    height: 28px;
    object-fit: contain;
    border-radius: var(--rad-sm);
    border: 1px solid var(--line);
    background: var(--surface-2);
    flex-shrink: 0;
  }

  /* ── GIF long-hover preview + metadata overlay ── */
  .gif-preview {
    position: fixed;
    z-index: 500;
    pointer-events: none;
    border-radius: var(--rad);
    overflow: hidden;
    box-shadow: 0 4px 24px rgba(0,0,0,0.55);
    border: 1px solid var(--line);
    background: var(--surface-2);
    transform-origin: top left;
    min-width: 160px;
    max-width: 220px;
  }
  .gif-preview img {
    display: block;
    max-width: 220px;
    max-height: 180px;
    width: 100%;
    height: auto;
  }
  .hover-meta-card {
    padding: 0.55rem 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .hover-meta-type {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--accent);
    margin-bottom: 0.1rem;
  }
  .hover-meta-row {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
  }
  .hover-meta-label {
    font-size: 0.6rem;
    color: var(--muted);
    min-width: 70px;
    flex-shrink: 0;
  }
  .hover-meta-value {
    font-size: 0.72rem;
    color: var(--ink-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── Schema metadata fields in node detail ── */
  .np-schema-fields {
    border-top: 1px solid var(--line);
    padding-top: 0.45rem;
    margin-top: 0.2rem;
  }
  .np-schema-toggle {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    background: none;
    border: none;
    padding: 0.15rem 0;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    width: 100%;
    text-align: left;
  }
  .np-schema-toggle:hover { color: var(--ink-2); }
  .schema-filled-badge {
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 999px;
    font-size: 0.55rem;
    padding: 0.05rem 0.35rem;
    font-family: var(--font-mono);
  }
  .schema-fields-body {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding-top: 0.35rem;
  }
  .schema-field-row {
    display: grid;
    grid-template-columns: minmax(80px, 1fr) 2fr;
    gap: 0.4rem;
    align-items: center;
  }
  .schema-field-label {
    font-size: 0.62rem;
    color: var(--muted);
    text-overflow: ellipsis;
    overflow: hidden;
    white-space: nowrap;
  }
  .schema-field-input {
    font-size: 0.72rem;
    padding: 0.18rem 0.4rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    color: var(--ink);
    outline: none;
    width: 100%;
  }
  .schema-field-input:focus { border-color: var(--accent); }

  /* ── Keyboard hint strip ── */
  .kb-hint {
    position: fixed;
    bottom: 0.6rem;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 1rem;
    padding: 0.28rem 0.9rem;
    background: rgba(14, 14, 20, 0.72);
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
    pointer-events: none;
    z-index: 350;
    backdrop-filter: blur(6px);
  }

  /* Performance suggestion banner */
  .perf-banner {
    position: fixed;
    top: 4rem;
    right: 1rem;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.5rem;
    padding: 0.65rem 0.9rem;
    background: color-mix(in srgb, var(--surface-2) 96%, transparent);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    backdrop-filter: blur(8px);
    z-index: 600;
    font-size: 0.8rem;
    box-shadow: 0 4px 16px #0004;
    max-width: 280px;
  }
  .perf-banner-msg { color: var(--muted); line-height: 1.5; }
  .perf-fps { color: var(--accent); font-size: 0.85rem; }
  .perf-glb-hint { display: block; color: var(--muted); font-style: italic; margin-top: 0.2rem; }
  .perf-banner-actions { display: flex; gap: 0.4rem; align-items: center; }
  .perf-btn-models {
    padding: 0.25rem 0.65rem;
    border-radius: var(--rad-sm);
    background: transparent;
    border: 1px solid var(--accent);
    color: var(--accent);
    font-size: 0.78rem;
    cursor: pointer;
    font-family: var(--font-mono);
    text-decoration: none;
  }
  .perf-btn-models:hover { background: var(--accent-soft); }
  .perf-btn-switch {
    padding: 0.25rem 0.65rem;
    border-radius: var(--rad-sm);
    background: var(--accent);
    color: #fff;
    font-size: 0.78rem;
    cursor: pointer;
    border: none;
    font-family: var(--font-mono);
  }
  .perf-btn-switch:hover { opacity: 0.85; }
  .perf-btn-dismiss {
    padding: 0.25rem 0.55rem;
    border-radius: var(--rad-sm);
    background: transparent;
    border: 1px solid var(--line);
    color: var(--muted);
    font-size: 0.78rem;
    cursor: pointer;
    font-family: var(--font-mono);
  }
  .perf-btn-dismiss:hover { color: var(--accent); border-color: var(--accent); }

  /* ── Mobile responsive ── */
  @media (max-width: 600px) {
    .sources-overlay {
      right: 0.5rem;
      left: 0.5rem;
      bottom: 4.5rem;
      width: auto;
      max-width: none;
      max-height: 50vh;
    }
    .multisel-panel {
      left: 0.5rem;
      right: 0.5rem;
      transform: none;
      min-width: 0;
      max-width: none;
      bottom: 5rem;
    }
    /* Larger touch targets for filter chips */
    .chip { font-size: 0.72rem; padding: 0.4rem 0.6rem; min-height: 36px; }
    .chip .num { font-size: 0.95rem; }
    .chip .lbl { font-size: 0.58rem; }
    .chip-row { gap: 0.4rem; }
    .np-label { font-size: 0.95rem; }
    .np-body { padding: 0.5rem 0.75rem 0.75rem; }
    .np-header { padding: 0.5rem 0.75rem 0.4rem; }
    .np-act-btn { font-size: 0.65rem; padding: 0.35rem 0.6rem; min-height: 36px; }
    .analyze-toast { bottom: calc(max(0.5rem, env(safe-area-inset-bottom)) + 56px); }
    .perf-banner {
      top: 3rem;
      right: 0.5rem;
      left: 0.5rem;
      max-width: none;
      font-size: 0.75rem;
    }
    :global(.filter-popover) { max-width: calc(100vw - 2rem); }
    .overlay-inner { padding: 0.4rem 0.5rem; }
    .kb-hint { display: none; } /* keyboard nav hint not useful on touch devices */
    .gif-preview { display: none; } /* hover-triggered GIF preview not useful on touch */
    .node-label-wrap { pointer-events: none; } /* prevent label divs from stealing touch events */
  }
</style>
