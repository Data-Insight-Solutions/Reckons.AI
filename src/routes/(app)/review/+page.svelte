<script lang="ts">
  import { Canvas } from '@threlte/core';
  import KnowledgeGraph from '$lib/3d/KnowledgeGraph.svelte';
  import KnowledgeGraph2D from '$lib/3d/KnowledgeGraph2D.svelte';
  import CompareGraph from '$lib/components/CompareGraph.svelte';
  import GraphLabels from '$lib/components/GraphLabels.svelte';
  import OverlayGraph from '$lib/components/OverlayGraph.svelte';
  import OverlayGraph3D from '$lib/components/OverlayGraph3D.svelte';
  import DiffEntry from '$lib/components/DiffEntry.svelte';
  import StatementCard from '$lib/components/StatementCard.svelte';
  import SwipeCard from '$lib/components/SwipeCard.svelte';
  import MergeReview from '$lib/components/MergeReview.svelte';
  import AlignmentCard from '$lib/components/AlignmentCard.svelte';
  import KbPicker from '$lib/components/KbPicker.svelte';
  import {
    statements,
    sources,
    confirmedStatements,
    pendingStatements,
    pendingRemovalStatements,
    pendingMergeStatements,
    statementsForSource,
    setStatus,
    updateStatement,
    addStatements,
    addSource,
  } from '$lib/stores/kb.svelte';
  import { getRegistry, getCurrentKbId } from '$lib/storage/kb-registry';
  import { drainAndImportPending, workspaceState } from '$lib/stores/workspace.svelte';
  import {
    computeAlignment, loadKbStatements, applyAlignmentToActiveKb,
    type AlignmentResult, type AlignmentSuggestion,
  } from '$lib/rdf/cross-kb-align';
  import { termKey, isIRI, isLit, isMetaPredicate, type Statement } from '$lib/rdf/types';
  import { computeDiff } from '$lib/rdf/diff';
  import { generateDiffSummary, type DiffSummary } from '$lib/rdf/diff-summary';
  import { semanticEnrichDiff, labelFromIRI } from '$lib/rdf/semantic-diff';
  import { buildReviewPlan, reviewPlanSummary } from '$lib/rdf/review-pipeline';
  import { settings } from '$lib/stores/settings.svelte';
  import { parseMultipleGraphs, MEMBERSHIP_PREDICATES, MEMBERSHIP_LABELS, isProjectIri, type OverlayData, type GraphDef } from '$lib/rdf/multi-graph-parse';
  import {
    RDF_TYPE, KB_URL, KB_LOCAL_PATH,
    KB_ICON2D, KB_ICON3D, KB_MESHY_TASK_ID, KB_MESHY_STATUS,
    KB_COLOR, KB_DESCRIPTION, KB_SCHEMA_PREDICATE
  } from '$lib/rdf/entity-types';
  import { allTypes } from '$lib/stores/entity-types.svelte';
  import { routeQueue, routingSummary } from '$lib/rdf/review-routing';
  import { LEAP_PRED, LEAP_LABEL_PRED } from '$lib/rdf/kb-leap';
  import { requestShellyChat } from '$lib/stores/shelly-bridge.svelte';
  import { ToggleGroup } from 'bits-ui';
  import { onMount } from 'svelte';

  // Predicates that are internal KB metadata
  const GRAPH_EXCLUDED_PREDICATES = new Set([
    KB_ICON2D, KB_ICON3D, KB_MESHY_TASK_ID, KB_MESHY_STATUS,
    KB_COLOR, KB_DESCRIPTION, KB_SCHEMA_PREDICATE,
    LEAP_PRED, LEAP_LABEL_PRED,
  ]);

  function checkWebGL(): boolean {
    if (typeof window === 'undefined') return false;
    try {
      const c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext &&
        (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch { return false; }
  }
  let webglAvailable = checkWebGL();

  // ── Review panel tabs ─────────────────────────────────────────────────────
  type Tab = 'incoming' | 'deletions' | 'merges' | 'align';
  let activeTab = $state<Tab>('incoming');
  /** F32: filter the incoming list to only partial "? question" facts. */
  let questionsOnly = $state(false);

  // ── Graph view mode ───────────────────────────────────────────────────────
  type GraphMode = 'preview' | 'compare' | 'overlay';
  let graphMode = $state<GraphMode>('preview');
  let use2D = $state(settings().prefer2D ?? false);

  // ── Review data ───────────────────────────────────────────────────────────
  const incoming = $derived(pendingStatements());
  const pendingDeletions = $derived(pendingRemovalStatements());
  const pendingMerges = $derived(pendingMergeStatements());

  const existing = $derived(
    statements().filter(
      (s) => s.status !== 'pending' && s.status !== 'rejected' &&
             s.status !== 'superseded' && s.status !== 'pending-removal'
    )
  );

  // Structural diff
  const structuralDiff = $derived(computeDiff(incoming, existing));

  // Semantic diff (async upgrade)
  let semanticDiff = $state<ReturnType<typeof computeDiff> | null>(null);
  let semanticAnalyzing = $state(false);
  let semanticVersion = 0;
  let semanticFailed = false;

  const diff = $derived(semanticDiff ?? structuralDiff);
  // F32: partial "? question" facts, and the list actually shown (optionally filtered).
  const questionEntries = $derived(diff.entries.filter((e) => e.incoming.needsObject));

  // ── F88: route by GATE, rank by BLAST RADIUS ───────────────────────────────
  //
  // The queue used to be one undifferentiated list in arrival order, which quietly asserts
  // two false things: that the user is the competent reviewer for every fact, and that the
  // newest item is the most important one.
  //
  // Neither survives contact with a real graph. "Does src/lib/foo.ts exist" is settled by a
  // script; putting it to a human doesn't just waste their time, it teaches them the queue
  // is mostly noise — and then they click Accept on the one item that mattered. Meanwhile a
  // question with four things stalled behind it sits below fifty pieces of trivia because
  // the trivia arrived later.
  //
  // So: split by who is COMPETENT to judge (rdf/verifiability.ts), rank each lane by how
  // much is actually waiting on it, and default the user's view to THEIRS.
  // subject IRI -> its rdf:type. Needed because AUTHORITY overrides verifiability: every fact
  // about a Tenet or a Decision is the user's to approve, however checkable it looks.
  const subjectTypes = $derived.by(() => {
    const m = new Map<string, string>();
    for (const st of [...existing, ...incoming]) {
      if (st.p.value === RDF_TYPE && st.s.kind === 'iri') m.set(st.s.value, st.o.value);
    }
    return m;
  });
  const routed = $derived(
    routeQueue(diff.entries.map((e) => e.incoming), (iri) => subjectTypes.get(iri)),
  );
  const routingLine = $derived(routingSummary(routed));
  /** statement id -> blast radius, so a card can show what is stalled behind it. */
  const impactById = $derived(
    new Map([...routed.machine, ...routed.agent, ...routed.user].map((i) => [i.statement.id, i.impact])),
  );
  /** statement id -> the gate that should judge it. */
  const gateById = $derived(
    new Map([...routed.machine, ...routed.agent, ...routed.user].map((i) => [i.statement.id, i.gate])),
  );

  /** Which lane the user is looking at. Defaults to `user` — the point is to show them less. */
  let gateFilter = $state<'user' | 'machine' | 'agent' | 'all'>('user');

  const shownEntries = $derived.by(() => {
    let list = questionsOnly ? questionEntries : diff.entries;
    if (gateFilter !== 'all') {
      list = list.filter((e) => (gateById.get(e.incoming.id) ?? 'user') === gateFilter);
    }
    // Most-blocking first. An item with four things stalled behind it is not "newer" or
    // "older" than a curiosity — it is a different kind of item.
    return [...list].sort(
      (a, b) =>
        (impactById.get(b.incoming.id) ?? 0) - (impactById.get(a.incoming.id) ?? 0) ||
        a.incoming.createdAt - b.incoming.createdAt,
    );
  });

  // Review-at-scale (F53/F83/F80.1) — the whole pending set run through the pipeline: dedupe ->
  // route -> spotlight the contested few -> entity cards. Used for the SPOTLIGHT strip and the
  // headline; the actual per-fact controls below still act on shownEntries so nothing is hidden.
  const reviewPlan = $derived(
    buildReviewPlan(incoming, { typeOf: (iri) => subjectTypes.get(iri) }, [...existing, ...incoming]),
  );
  const planHeadline = $derived(reviewPlanSummary(reviewPlan));
  /** subject IRI -> true when it holds a spotlighted (contested) decision, for the entity headers. */
  const spotlightSubjects = $derived(
    new Set(reviewPlan.attention.spotlight.map((i) => i.statement.s.value)),
  );

  /** F83: group the SHOWN entries into per-entity cards so the user decides about things, not rows. */
  let groupByEntity = $state(true);
  const entityGroups = $derived.by(() => {
    const m = new Map<string, typeof shownEntries>();
    for (const e of shownEntries) {
      const k = e.incoming.s.value;
      const g = m.get(k);
      if (g) g.push(e);
      else m.set(k, [e]);
    }
    return [...m.entries()].map(([iri, entries]) => {
      const labelStmt = entries.find(
        (e) => e.incoming.p.value === 'http://www.w3.org/2000/01/rdf-schema#label' && e.incoming.o.kind === 'literal',
      );
      return {
        iri,
        label: labelStmt ? labelStmt.incoming.o.value : labelFromIRI(iri),
        entries,
        gate: gateById.get(entries[0].incoming.id) ?? 'user',
        spotlight: spotlightSubjects.has(iri),
      };
    });
  });

  $effect(() => {
    const inc = incoming;
    const ex = existing;
    const sDiff = computeDiff(inc, ex);
    const myVersion = ++semanticVersion;
    if (sDiff.entries.length === 0) { semanticDiff = null; semanticAnalyzing = false; return; }
    if (semanticFailed) return;
    semanticAnalyzing = true;
    semanticDiff = null;
    semanticEnrichDiff(sDiff, ex).then(enriched => {
      if (myVersion === semanticVersion) { semanticDiff = enriched; semanticAnalyzing = false; }
    }).catch(() => {
      semanticFailed = true;
      if (myVersion === semanticVersion) semanticAnalyzing = false;
    });
  });

  let bumpKey = $state(0);
  let isProcessing = $state(false);
  let error = $state<string | null>(null);

  // ── Diff summary ──────────────────────────────────────────────────────────
  let diffSummary = $state<DiffSummary | null>(null);
  let summaryLoading = $state(false);
  async function loadSummary() {
    summaryLoading = true;
    try { diffSummary = await generateDiffSummary(diff, settings()); }
    catch { /* handled */ }
    finally { summaryLoading = false; }
  }

  function refresh() { bumpKey++; }

  let draining = $state(false);
  let drainResult = $state<string | null>(null);
  async function checkPending() {
    draining = true;
    drainResult = null;
    try {
      const count = await drainAndImportPending();
      drainResult = count > 0 ? `${count} imported` : 'none';
      if (count > 0) refresh();
    } catch { drainResult = 'error'; }
    finally { draining = false; setTimeout(() => drainResult = null, 3000); }
  }

  function sourceLabel(sourceId: string): string {
    return sources().find(s => s.id === sourceId)?.title ?? sourceId;
  }

  // ── Graph: preview mode (confirmed + pending highlighted) ─────────────────
  // Combine confirmed + pending so the graph shows the effect of accepting
  const previewStatements = $derived.by(() => {
    const confirmed = confirmedStatements();
    const pending = incoming;
    // Filter same as main page
    return [...confirmed, ...pending].filter(s => {
      if (isMetaPredicate(s.p.value)) return false;
      if (GRAPH_EXCLUDED_PREDICATES.has(s.p.value)) return false;
      return true;
    });
  });

  // Highlighted keys: entities that come from pending statements
  const pendingKeys = $derived(new Set(incoming.flatMap(s => [termKey(s.s), termKey(s.o)])));

  let selected = $state<string | null>(null);
  /** Camera-fly target: set when a review item is clicked so the graph centers its node */
  let focusKey = $state<string | null>(null);
  /** The specific triple a review card is showing, so its edge (not just its nodes) can be highlighted. */
  let focusedEdge = $state<{ s: string; o: string; p?: string } | null>(null);

  /** 3D node labels — the preview 3D graph emits viewport-space positions via onlabelsmove, and we
   *  render them as fixed HTML overlays (the 3D scene draws no text itself). Without this the 3D
   *  view had NO labels. Cleared whenever we are not in the 3D preview so none linger. */
  let nodeLabels = $state<Array<{ key: string; label: string; x: number; y: number; opacity: number }>>([]);
  $effect(() => {
    if (use2D || graphMode !== 'preview') nodeLabels = [];
  });

  /** Focus the preview graph on a statement's subject node (called from review cards — incoming, deletions, merges, align). */
  function focusStatement(st: Statement) {
    const key = termKey(st.s);
    selected = key;
    focusedEdge = { s: termKey(st.s), o: termKey(st.o), p: st.p.value.split('/').pop() ?? st.p.value };
    focusKey = null; // retrigger even if the same node is focused twice
    requestAnimationFrame(() => { focusKey = key; });
  }

  /** Focus the preview graph on an arbitrary node key (called from the node search box). */
  function focusNode(key: string) {
    selected = key;
    focusedEdge = null;
    focusKey = null;
    requestAnimationFrame(() => { focusKey = key; });
  }

  // ── Browse controls (F30: graph controls ported onto the preview pane) ────
  let previewLayout = $state<'force' | 'focus' | 'hub'>('force');
  let nodeSearchQuery = $state('');
  const nodeSearchResults = $derived.by(() => {
    const q = nodeSearchQuery.trim().toLowerCase();
    if (q.length < 1) return [];
    const seen = new Map<string, string>();
    for (const s of previewStatements) {
      for (const term of [s.s, s.o]) {
        if (term.kind !== 'iri') continue;
        const k = termKey(term);
        if (seen.has(k)) continue;
        const label = term.value.split('/').pop() ?? term.value;
        if (label.toLowerCase().includes(q)) seen.set(k, label);
      }
    }
    return [...seen.entries()].slice(0, 8).map(([key, label]) => ({ key, label }));
  });

  // ── Node details panel (left of the graph pane) ────────────────────────────
  function keyLabelReview(key: string): string {
    if (key.startsWith('i:')) {
      const iri = key.slice(2);
      return iri.split('/').pop() ?? iri;
    }
    if (key.startsWith('l:')) return key.slice(2).split('|')[0].slice(0, 48) || key;
    if (key.startsWith('src:')) {
      const srcId = key.slice(4);
      return sources().find((s) => s.id === srcId)?.title ?? srcId;
    }
    return key;
  }

  const nodeDetails = $derived.by(() => {
    if (!selected || graphMode !== 'preview') return null;
    const label = keyLabelReview(selected);
    const typeStmt = previewStatements.find((s) => termKey(s.s) === selected && s.p.value === RDF_TYPE);
    const typeDef = typeStmt && typeStmt.o.kind === 'iri' ? allTypes().find((t) => t.iri === typeStmt.o.value) ?? null : null;
    const typeLabel = typeDef?.label ?? (typeStmt && typeStmt.o.kind === 'iri' ? (typeStmt.o.value.split('/').pop() ?? typeStmt.o.value) : null);

    const related = statements()
      .filter((s) =>
        s.status !== 'rejected' && s.status !== 'superseded' &&
        s.p.value !== RDF_TYPE &&
        !isMetaPredicate(s.p.value) && !GRAPH_EXCLUDED_PREDICATES.has(s.p.value) &&
        (termKey(s.s) === selected || termKey(s.o) === selected)
      )
      .map((s) => {
        const isSubject = termKey(s.s) === selected;
        const other = isSubject ? s.o : s.s;
        return {
          id: s.id,
          predicate: s.p.value.split('/').pop() ?? s.p.value,
          isSubject,
          otherLabel: other.value == null ? '(empty)'
            : other.kind === 'iri' ? (other.value.split('/').pop() ?? other.value) : other.value.slice(0, 60),
          pending: s.status === 'pending' || s.status === 'pending-removal',
          status: s.status,
        };
      })
      .slice(0, 40);

    return { label, typeLabel, related };
  });

  // Chat scoped to the selected node — reuses the existing Shelly chat machinery
  // (requestShellyChat opens the global TurtleChatPanel mounted in the app layout
  // and auto-sends the message) rather than building a separate chat stack.
  let nodeChatDraft = $state('');
  function sendNodeChat() {
    if (!panelDetails || !nodeChatDraft.trim()) return;
    const ctx = `About the node "${panelDetails.label}"${panelDetails.typeLabel ? ` (${panelDetails.typeLabel})` : ''}: `;
    requestShellyChat(ctx + nodeChatDraft.trim());
    nodeChatDraft = '';
  }
  function openNodeInShelly() {
    if (!panelDetails) return;
    requestShellyChat(`Tell me about "${panelDetails.label}"${panelDetails.typeLabel ? `, a ${panelDetails.typeLabel}` : ''}.`);
  }

  /** Human-readable name of the selected node, shown as a caption over the graph. */
  const focusedLabel = $derived.by(() => {
    if (!selected || !selected.startsWith('i:')) return null;
    const iriVal = selected.slice(2);
    const labelSt = previewStatements.find(
      (s) => s.s.kind === 'iri' && s.s.value === iriVal &&
             s.p.value === 'http://www.w3.org/2000/01/rdf-schema#label' && s.o.kind === 'literal'
    );
    if (labelSt) return labelSt.o.value;
    const local = iriVal.split(/[/#]/).pop() ?? iriVal;
    return local.replace(/-/g, ' ');
  });

  // ── Resizable panel ─────────────────────────────────────────────────────
  let panelWidth = $state(380);
  let isDragging = $state(false);
  const PANEL_MIN = 260;
  const PANEL_MAX = 700;

  function onResizeStart(e: PointerEvent) {
    e.preventDefault();
    isDragging = true;
    const startX = e.clientX;
    const startW = panelWidth;

    function onMove(ev: PointerEvent) {
      const delta = startX - ev.clientX;
      panelWidth = Math.max(PANEL_MIN, Math.min(PANEL_MAX, startW + delta));
    }
    function onUp() {
      isDragging = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // ── Compare mode ──────────────────────────────────────────────────────────
  let compareSourceId = $state<string | null>(null);
  const compareIncoming = $derived(
    compareSourceId ? statementsForSource(compareSourceId).filter(s => s.status === 'pending') : incoming
  );
  const compareExisting = $derived(confirmedStatements().filter(s => s.sourceId !== compareSourceId));
  const compareLegend = $derived.by(() => {
    const inKeys = new Set(compareIncoming.flatMap(s => [s.s.value, s.o.value]));
    const exKeys = new Set(compareExisting.flatMap(s => [s.s.value, s.o.value]));
    let n = 0, sh = 0, kb = 0;
    for (const k of new Set([...inKeys, ...exKeys])) {
      if (inKeys.has(k) && exKeys.has(k)) sh++;
      else if (inKeys.has(k)) n++;
      else kb++;
    }
    return { newCount: n, sharedCount: sh, kbOnlyCount: kb };
  });
  const compareRelevantExisting = $derived.by(() => {
    const inValues = new Set(compareIncoming.flatMap(s => [s.s.value, s.o.value]));
    return compareExisting.filter(s => inValues.has(s.s.value) || inValues.has(s.o.value));
  });
  const pendingSourceIds = $derived(
    [...new Set(pendingStatements().map(s => s.sourceId))].filter(Boolean) as string[]
  );

  // ── Overlay mode ──────────────────────────────────────────────────────────
  import { KBaseDB } from '$lib/storage/db';
  import { toTurtle } from '$lib/rdf/serialize';

  let overlayData = $state<OverlayData | null>(null);
  let overlayLoading = $state(false);
  let overlayActiveGraphIds = $state(new Set<string>());
  const OVERLAY_STRUCTURAL = new Set([
    'urn:reckons:ontology/componentUses',
    'urn:reckons:ontology/relatedTo',
    'urn:reckons:ontology/evolvedInto',
  ]);
  let overlayActivePredicates = $state(new Set<string>([...MEMBERSHIP_PREDICATES, ...OVERLAY_STRUCTURAL]));
  let overlaySelectedKey = $state<string | null>(null);
  let overlayViewIs3D = $state(false);

  /** Node details for OVERLAY mode — the clicked node in the combined multi-graph view. Mirrors
   *  the preview `nodeDetails` shape, but reads from overlayData (which spans several graphs) since
   *  the overlay's nodes are not all in the current KB's statement list. */
  const overlayNodeDetails = $derived.by(() => {
    if (graphMode !== 'overlay' || !overlaySelectedKey || !overlayData) return null;
    const node = overlayData.nodes.get(overlaySelectedKey);
    if (!node) return null;
    const related = overlayData.edges
      .filter((e) => e.sourceKey === overlaySelectedKey || e.targetKey === overlaySelectedKey)
      .map((e, i) => {
        const isSubject = e.sourceKey === overlaySelectedKey;
        const otherKey = isSubject ? e.targetKey : e.sourceKey;
        const other = overlayData!.nodes.get(otherKey);
        const fallback = otherKey.startsWith('i:') ? (otherKey.slice(2).split('/').pop() ?? otherKey) : otherKey;
        return {
          id: `${e.sourceKey}|${e.predicateIri}|${e.targetKey}|${i}`,
          predicate: e.predicate,
          isSubject,
          otherLabel: other?.label ?? fallback,
          pending: false,
          status: 'confirmed' as const,
        };
      })
      .slice(0, 40);
    const typeLabel = node.rdfType ? (node.rdfType.split('/').pop() ?? node.rdfType) : null;
    return { label: node.label, typeLabel, related };
  });

  /** The details the node panel shows — preview OR overlay, whichever mode is active. */
  const panelDetails = $derived(
    graphMode === 'overlay' ? overlayNodeDetails : graphMode === 'preview' ? nodeDetails : null,
  );

  /** Close the node panel, clearing whichever selection drives the active mode. */
  function closeNodePanel() {
    if (graphMode === 'overlay') overlaySelectedKey = null;
    else { selected = null; focusedEdge = null; }
  }

  // KB-based overlay sources
  let overlayKbEntries = $state(getRegistry());
  let overlaySelectedKbIds = $state(new Set<string>());
  let overlayKbTtlCache = new Map<string, string>();
  let overlayLoadingKbIds = $state(new Set<string>());

  // Bundled examples (collapsed by default)
  let overlayShowExamples = $state(false);
  let overlaySelectedExampleIds = $state(new Set<string>());
  const overlayBundledFiles = (() => {
    const mods = import.meta.glob('/docs/reckons-knowledge-graphs/*.ttl', {
      query: '?raw', import: 'default', eager: true
    }) as Record<string, string>;
    return Object.entries(mods).map(([path, content]) => ({
      id: path.split('/').pop()!.replace('.ttl', ''),
      content: content as string
    }));
  })();

  async function loadOverlayKbAsTtl(entry: import('$lib/storage/kb-registry').KbEntry): Promise<string> {
    if (overlayKbTtlCache.has(entry.id)) return overlayKbTtlCache.get(entry.id)!;
    const tempDb = new KBaseDB(entry.id);
    try {
      const stmts = await tempDb.statements.toArray();
      const confirmed = stmts.filter(s => s.status === 'confirmed' || s.status === 'refined');
      if (confirmed.length === 0) return '';
      const ttl = toTurtle(confirmed, { header: entry.name });
      overlayKbTtlCache.set(entry.id, ttl);
      return ttl;
    } finally {
      tempDb.close();
    }
  }

  async function rebuildOverlay() {
    const files: Array<{ id: string; content: string }> = [];

    // Add selected KBs
    for (const kbId of overlaySelectedKbIds) {
      const entry = overlayKbEntries.find(e => e.id === kbId);
      if (!entry) continue;
      overlayLoadingKbIds = new Set([...overlayLoadingKbIds, kbId]);
      try {
        const ttl = await loadOverlayKbAsTtl(entry);
        if (ttl) files.push({ id: entry.name || entry.id, content: ttl });
      } catch (e) { console.warn(`Failed to load KB "${entry.name}":`, e); }
      overlayLoadingKbIds = new Set([...overlayLoadingKbIds].filter(id => id !== kbId));
    }
    overlayLoadingKbIds = new Set();

    // Add selected bundled examples
    if (overlayShowExamples) {
      for (const ex of overlayBundledFiles) {
        if (overlaySelectedExampleIds.has(ex.id)) files.push(ex);
      }
    }

    if (files.length === 0) { overlayData = null; return; }

    overlayLoading = true;
    try {
      overlayData = await parseMultipleGraphs(files);
      overlayActiveGraphIds = new Set(overlayData.graphs.map(g => g.id));
    } catch (e) { console.warn('Overlay parse error:', e); }
    finally { overlayLoading = false; }
  }

  async function toggleOverlayKb(kbId: string) {
    const next = new Set(overlaySelectedKbIds);
    if (next.has(kbId)) next.delete(kbId); else next.add(kbId);
    overlaySelectedKbIds = next;
    await rebuildOverlay();
  }

  function toggleOverlayExample(exId: string) {
    const next = new Set(overlaySelectedExampleIds);
    if (next.has(exId)) next.delete(exId); else next.add(exId);
    overlaySelectedExampleIds = next;
    rebuildOverlay();
  }

  function toggleOverlayShowExamples() {
    overlayShowExamples = !overlayShowExamples;
    if (!overlayShowExamples) {
      overlaySelectedExampleIds = new Set();
      rebuildOverlay();
    }
  }

  function initOverlay() {
    overlayKbEntries = getRegistry();
    // Auto-select current KB if not already loaded
    if (overlaySelectedKbIds.size === 0) {
      overlaySelectedKbIds = new Set([currentKbId]);
      rebuildOverlay();
    }
  }

  function toggleOverlayGraph(id: string) {
    const next = new Set(overlayActiveGraphIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    overlayActiveGraphIds = next;
  }

  function toggleOverlayPredicate(iri: string) {
    const next = new Set(overlayActivePredicates);
    if (next.has(iri)) next.delete(iri); else next.add(iri);
    overlayActivePredicates = next;
  }

  // ── Merge execution ───────────────────────────────────────────────────────
  let showMergeReview = $state(false);
  let mergeEntityA = $state('');
  let mergeEntityB = $state('');

  async function executeMerge(mergeStmt: ReturnType<typeof pendingMergeStatements>[number]) {
    const keepIri = mergeStmt.s.kind === 'iri' ? mergeStmt.s.value : '';
    const dropIri = mergeStmt.o.kind === 'iri' ? mergeStmt.o.value : '';
    if (!keepIri || !dropIri) return;
    // Open MergeReview dialog
    mergeEntityA = `i:${keepIri}`;
    mergeEntityB = `i:${dropIri}`;
    showMergeReview = true;
  }

  async function onMergeConfirm(keepKey: string, conflicts: { keepId: string; rejectId: string }[]) {
    isProcessing = true;
    try {
      const keepIri = keepKey.startsWith('i:') ? keepKey.slice(2) : keepKey;
      const dropIri = (keepKey === mergeEntityA ? mergeEntityB : mergeEntityA);
      const dropVal = dropIri.startsWith('i:') ? dropIri.slice(2) : dropIri;
      const keepNode = { kind: 'iri' as const, value: keepIri };
      const toRedirect = statements().filter(
        s => (s.s.kind === 'iri' && s.s.value === dropVal ||
              s.o.kind === 'iri' && s.o.value === dropVal) &&
             s.status !== 'rejected' && s.status !== 'superseded'
      );
      for (const st of toRedirect) {
        const patch: Partial<typeof st> = {};
        if (st.s.kind === 'iri' && st.s.value === dropVal) patch.s = keepNode;
        if (st.o.kind === 'iri' && st.o.value === dropVal) patch.o = keepNode;
        if (Object.keys(patch).length > 0) await updateStatement(st.id, patch);
      }
      for (const c of conflicts) {
        await setStatus(c.rejectId, 'rejected');
      }
      // Mark original merge suggestion as confirmed
      const mergeStmt = pendingMerges.find(m =>
        (m.s.kind === 'iri' && m.s.value === keepIri && m.o.kind === 'iri' && m.o.value === dropVal) ||
        (m.s.kind === 'iri' && m.s.value === dropVal && m.o.kind === 'iri' && m.o.value === keepIri)
      );
      if (mergeStmt) await setStatus(mergeStmt.id, 'confirmed');
      showMergeReview = false;
      refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally { isProcessing = false; }
  }

  async function dismissMerge(id: string) { await setStatus(id, 'rejected'); refresh(); }

  // ── Bulk actions ──────────────────────────────────────────────────────────
  async function acceptAll() {
    error = null; isProcessing = true;
    try {
      for (const e of diff.entries) {
        // Partial facts (F32) must be filled individually — never bulk-confirm a '?'.
        if (e.incoming.needsObject) continue;
        if (e.kind === 'new' || e.kind === 'reinforces' || e.kind === 'synonym-reinforces')
          await setStatus(e.incoming.id, 'confirmed');
      }
      refresh();
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { isProcessing = false; }
  }
  async function confirmDeletion(id: string) { await setStatus(id, 'rejected'); refresh(); }
  async function keepStatement(id: string) { await setStatus(id, 'confirmed'); refresh(); }

  // Total pending count for graph label
  const totalPending = $derived(incoming.length + pendingDeletions.length + pendingMerges.length);

  // ── Cross-KB alignment ──────────────────────────────────────────────────
  let alignSelectedKbs = $state<Set<string>>(new Set());
  let alignResult = $state<AlignmentResult | null>(null);
  let alignLoading = $state(false);
  let alignError = $state<string | null>(null);
  const currentKbId = getCurrentKbId();
  const currentKbName = $derived(
    getRegistry().find(k => k.id === currentKbId)?.name ?? 'Current Graph'
  );
  const alignPending = $derived(
    alignResult?.suggestions.filter(s => s.decision === 'pending').length ?? 0
  );

  async function runAlignment() {
    alignLoading = true;
    alignError = null;
    alignResult = null;
    try {
      const activeConfirmed = confirmedStatements();
      const allSuggestions: AlignmentSuggestion[] = [];
      const allAligned: import('$lib/rdf/cross-kb-align').AlignedEntity[] = [];

      for (const kbId of alignSelectedKbs) {
        const entry = getRegistry().find(k => k.id === kbId);
        if (!entry) continue;
        const foreignStmts = await loadKbStatements(kbId);
        const result = await computeAlignment(
          currentKbId, activeConfirmed,
          kbId, entry.name,
          foreignStmts, currentKbName,
        );
        allSuggestions.push(...result.suggestions);
        allAligned.push(...result.alignedEntities);
      }

      const summary = {
        additions: allSuggestions.filter(s => s.kind === 'add').length,
        conflicts: allSuggestions.filter(s => s.kind === 'conflict').length,
        reinforcements: allSuggestions.filter(s => s.kind === 'reinforce').length,
        refinements: allSuggestions.filter(s => s.kind === 'refine').length,
      };

      alignResult = { suggestions: allSuggestions, alignedEntities: allAligned, summary };
    } catch (e) {
      alignError = e instanceof Error ? e.message : String(e);
    } finally {
      alignLoading = false;
    }
  }

  async function acceptAlignment(suggestion: AlignmentSuggestion) {
    try {
      await applyAlignmentToActiveKb(suggestion, addStatements, addSource);
      suggestion.decision = 'accepted';
      alignResult = { ...alignResult! };
      refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function rejectAlignment(suggestion: AlignmentSuggestion) {
    suggestion.decision = 'rejected';
    alignResult = { ...alignResult! };
  }

  // ── URL query param helpers ─────────────────────────────────────────────
  function setViewParam(view: string | null) {
    const url = new URL(window.location.href);
    if (view) { url.searchParams.set('view', view); }
    else { url.searchParams.delete('view'); }
    history.replaceState(null, '', url.toString());
  }

  // Auto-populate from URL params
  onMount(() => {
    const params = new URL(window.location.href).searchParams;
    const alignParam = params.get('align');
    if (alignParam) {
      alignSelectedKbs = new Set(alignParam.split(',').filter(Boolean));
      activeTab = 'align';
    }
    const tabParam = params.get('tab');
    if (tabParam && ['incoming', 'deletions', 'merges', 'align'].includes(tabParam)) {
      activeTab = tabParam as Tab;
    }
    const viewParam = params.get('view');
    if (viewParam === 'compare') { graphMode = 'compare'; }
    else if (viewParam === 'overlay') { graphMode = 'overlay'; initOverlay(); }
  });
</script>

<div class="review-layout" class:dragging={isDragging}>
  <!-- ── LEFT: Graph area ──────────────────────────────────────────────── -->
  <section class="graph-pane">
    <!-- Graph mode bar -->
    <div class="graph-mode-bar">
      <button class="mode-btn" class:active={graphMode === 'preview'} onclick={() => { graphMode = 'preview'; setViewParam(null); }}>
        <span class="mode-lbl mono">preview</span>
        {#if totalPending > 0}<span class="mode-badge">{totalPending}</span>{/if}
      </button>
      <button class="mode-btn" class:active={graphMode === 'compare'} onclick={() => { graphMode = 'compare'; setViewParam('compare'); }}>
        <span class="mode-lbl mono">compare</span>
      </button>
      <button class="mode-btn" class:active={graphMode === 'overlay'} onclick={() => { graphMode = 'overlay'; initOverlay(); setViewParam('overlay'); }}>
        <span class="mode-lbl mono">overlay</span>
      </button>
      <span class="mode-spacer"></span>
      {#if graphMode === 'preview'}
        <button class="mode-btn dim-toggle" class:active={!use2D} onclick={() => use2D = !use2D}
          title="Switch between 2D and 3D">
          <span class="mode-lbl mono">{use2D ? '2D' : '3D'}</span>
        </button>
      {/if}
      {#if graphMode === 'overlay'}
        <button class="mode-btn dim-toggle" class:active={overlayViewIs3D} onclick={() => overlayViewIs3D = !overlayViewIs3D}
          title="Switch between 2D and 3D">
          <span class="mode-lbl mono">{overlayViewIs3D ? '3D' : '2D'}</span>
        </button>
      {/if}
    </div>

    <!-- Browse controls (F30: layout + node search ported onto the preview pane) -->
    {#if graphMode === 'preview'}
      <div class="overlay-controls browse-controls">
        <div class="ov-row">
          <span class="ov-label mono">layout</span>
          <ToggleGroup.Root
            type="single"
            value={previewLayout}
            onValueChange={(v) => { if (v) previewLayout = v as typeof previewLayout; }}
            class="tg-row"
          >
            <ToggleGroup.Item value="force" class="tg-chip"><span class="lbl mono">free</span></ToggleGroup.Item>
            <ToggleGroup.Item value="focus" class="tg-chip"><span class="lbl mono">focus</span></ToggleGroup.Item>
            <ToggleGroup.Item value="hub" class="tg-chip"><span class="lbl mono">hub</span></ToggleGroup.Item>
          </ToggleGroup.Root>
          <div class="node-search-wrap">
            <input
              class="node-search-input mono"
              type="text"
              placeholder="find node…"
              bind:value={nodeSearchQuery}
            />
            {#if nodeSearchResults.length > 0}
              <div class="node-search-dropdown">
                {#each nodeSearchResults as r (r.key)}
                  <button class="node-search-row" onclick={() => { focusNode(r.key); nodeSearchQuery = ''; }}>
                    {r.label}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      </div>
    {/if}

    <!-- Overlay controls strip (when overlay mode) -->
    {#if graphMode === 'overlay'}
      <div class="overlay-controls">
        <!-- KB picker row -->
        <div class="ov-row">
          <span class="ov-label mono">Graphs</span>
          {#each overlayKbEntries as entry}
            {@const isActive = overlaySelectedKbIds.has(entry.id)}
            <button
              class="ov-chip"
              class:active={isActive}
              onclick={() => toggleOverlayKb(entry.id)}
              disabled={overlayLoadingKbIds.has(entry.id)}
            >
              {isActive ? '\u2713 ' : ''}{entry.name.length > 16 ? entry.name.slice(0, 14) + '..' : entry.name}
              {#if entry.statementCount}<span class="ov-count">{entry.statementCount}</span>{/if}
              {#if entry.id === currentKbId}<span class="ov-current">*</span>{/if}
            </button>
          {/each}
          <!-- Examples dropdown -->
          <button class="ov-chip" class:active={overlayShowExamples} onclick={toggleOverlayShowExamples}>
            {overlayShowExamples ? '\u25BE' : '\u25B8'} examples
          </button>
        </div>
        {#if overlayShowExamples}
          <div class="ov-row">
            <span class="ov-label mono"></span>
            {#each overlayBundledFiles as ex}
              <button class="ov-chip" class:active={overlaySelectedExampleIds.has(ex.id)} onclick={() => toggleOverlayExample(ex.id)}>
                {ex.id.length > 16 ? ex.id.slice(0, 14) + '..' : ex.id}
              </button>
            {/each}
          </div>
        {/if}
        {#if overlayData}
          <!-- Predicate filters -->
          <div class="ov-row">
            <span class="ov-label mono">show</span>
            {#each [...MEMBERSHIP_PREDICATES] as pred}
              <button class="ov-chip" class:active={overlayActivePredicates.has(pred)} onclick={() => toggleOverlayPredicate(pred)}>
                {MEMBERSHIP_LABELS[pred] ?? pred.split('/').pop()}
              </button>
            {/each}
            {#each [...OVERLAY_STRUCTURAL] as pred}
              <button class="ov-chip" class:active={overlayActivePredicates.has(pred)} onclick={() => toggleOverlayPredicate(pred)} style="font-style:italic">
                {pred.split('/').pop()}
              </button>
            {/each}
          </div>
          <!-- Graph toggles -->
          <div class="ov-row">
            <span class="ov-label mono">graphs</span>
            {#each overlayData.graphs as g}
              <button class="ov-chip" class:active={overlayActiveGraphIds.has(g.id)} onclick={() => toggleOverlayGraph(g.id)}>
                <span class="ov-dot" style="background:{g.color}"></span>
                {g.id.length > 14 ? g.id.slice(0, 12) + '..' : g.id}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Compare source picker (when compare mode) -->
    {#if graphMode === 'compare'}
      <div class="overlay-controls">
        <div class="ov-row">
          <span class="ov-label mono">source</span>
          {#each pendingSourceIds as srcId}
            {@const src = sources().find(s => s.id === srcId)}
            <button class="ov-chip" class:active={compareSourceId === srcId} onclick={() => compareSourceId = srcId}>
              {src ? (src.title.length > 18 ? src.title.slice(0, 16) + '..' : src.title) : srcId}
            </button>
          {/each}
          {#if pendingSourceIds.length === 0}
            <span class="ov-hint mono">no pending sources</span>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Graph render area -->
    <div class="graph-render">
      {#if graphMode === 'preview' && focusedLabel}
        <span class="focus-badge" title={focusedLabel}>◉ {focusedLabel}</span>
      {/if}

      <!-- Node details (left) + scoped chat — shown when a node is selected in preview OR overlay -->
      {#if panelDetails}
        <div class="node-details-pane">
          <div class="ndp-header">
            <div class="ndp-title">
              <span class="ndp-label">{panelDetails.label}</span>
              {#if panelDetails.typeLabel}<span class="ndp-type mono">{panelDetails.typeLabel}</span>{/if}
            </div>
            <button class="ndp-close" onclick={closeNodePanel} title="close">✕</button>
          </div>
          <div class="ndp-stmts">
            {#if panelDetails.related.length === 0}
              <p class="ndp-empty mono">no facts yet</p>
            {:else}
              {#each panelDetails.related as r (r.id)}
                <div class="ndp-stmt" class:ndp-pending={r.pending}>
                  {#if r.pending}<span class="ndp-pending-tag mono">pending</span>{/if}
                  <span class="ndp-pred mono">{r.isSubject ? r.predicate : `← ${r.predicate}`}</span>
                  <span class="ndp-other">{r.otherLabel}</span>
                </div>
              {/each}
            {/if}
          </div>
          <div class="ndp-chat">
            <div class="ndp-chat-row">
              <input
                class="ndp-chat-input mono"
                type="text"
                placeholder="ask Shelly about this node…"
                bind:value={nodeChatDraft}
                onkeydown={(e) => { if (e.key === 'Enter') sendNodeChat(); }}
              />
              <button class="ndp-chat-send" onclick={sendNodeChat} disabled={!nodeChatDraft.trim()} title="ask">➤</button>
            </div>
            <button class="ghost-btn ndp-chat-open" onclick={openNodeInShelly}>open in Shelly →</button>
          </div>
        </div>
      {/if}

      {#if graphMode === 'preview'}
        {#if previewStatements.length === 0}
          <div class="graph-empty">
            <p class="mono">no statements to preview</p>
            <p class="mono small">ingest something to see changes here</p>
          </div>
        {:else if use2D || !webglAvailable}
          <KnowledgeGraph2D
            statements={previewStatements}
            {selected}
            {focusKey}
            layout={previewLayout}
            sources={sources()}
            onselect={(k) => { selected = k; focusedEdge = null; }}
            onhover={() => {}}
            onlabelsmove={() => {}}
            onmarkersmove={() => {}}
            highlighted={[...pendingKeys]}
            highlightedEdges={focusedEdge ? [focusedEdge] : []}
          />
        {:else}
          <svelte:boundary>
            <Canvas>
              <KnowledgeGraph
                statements={previewStatements}
                {selected}
                layout={previewLayout}
                sources={sources()}
                onselect={(k) => { selected = k; focusedEdge = null; }}
                onhover={() => {}}
                onlabelsmove={(labels) => { nodeLabels = labels; }}
                onmarkersmove={() => {}}
                highlighted={[...pendingKeys]}
              />
            </Canvas>
            {#snippet failed()}
              <div class="graph-empty">
                <p class="mono">3D failed — using 2D</p>
              </div>
            {/snippet}
          </svelte:boundary>
        {/if}
      {:else if graphMode === 'compare'}
        {#if compareIncoming.length > 0}
          <CompareGraph
            incoming={compareIncoming}
            existing={compareRelevantExisting}
            newCount={compareLegend.newCount}
            sharedCount={compareLegend.sharedCount}
            kbOnlyCount={compareLegend.kbOnlyCount}
          />
        {:else}
          <div class="graph-empty">
            <p class="mono">select a source above to compare</p>
          </div>
        {/if}
      {:else if graphMode === 'overlay'}
        {#if overlayData}
          {#if overlayViewIs3D}
            <OverlayGraph3D
              graphs={overlayData.graphs}
              nodes={overlayData.nodes}
              edges={overlayData.edges}
              activeGraphIds={overlayActiveGraphIds}
              activePredicates={overlayActivePredicates}
            />
          {:else}
            <OverlayGraph
              graphs={overlayData.graphs}
              nodes={overlayData.nodes}
              edges={overlayData.edges}
              activeGraphIds={overlayActiveGraphIds}
              activePredicates={overlayActivePredicates}
              selectedKey={overlaySelectedKey}
              onselect={(key) => { overlaySelectedKey = key; }}
            />
          {/if}
        {:else}
          <div class="graph-empty">
            <p class="mono">{overlayLoading ? 'loading...' : 'select graphs above to compare'}</p>
          </div>
        {/if}
      {/if}

      <!-- 3D node labels via the SHARED GraphLabels overlay (F92) — same component the main graph
           uses, so review's labels can no longer drift from it. Review needs no asset/leap snippets. -->
      {#if graphMode === 'preview' && !use2D}
        <GraphLabels labels={nodeLabels} {selected} />
      {/if}
    </div>

    <!-- Preview legend -->
    {#if graphMode === 'preview' && incoming.length > 0}
      <div class="preview-legend">
        <span class="pl-chip pl-pending">highlighted = pending ({incoming.length})</span>
        <span class="pl-chip pl-confirmed">dimmed = confirmed ({confirmedStatements().length})</span>
      </div>
    {/if}
  </section>

  <!-- ── Resize handle ──────────────────────────────────────────────── -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="resize-handle" class:active={isDragging} onpointerdown={onResizeStart}></div>

  <!-- ── RIGHT: Review panel ───────────────────────────────────────────── -->
  <aside class="review-panel" style="width:{panelWidth}px">
    <div class="rp-header">
      <h2 class="rp-title">review</h2>
      <p class="rp-sub mono">
        {totalPending} pending change{totalPending !== 1 ? 's' : ''}
        {#if workspaceState() === 'connected'}
          <button class="drain-btn" onclick={checkPending} disabled={draining} title="Check workspace for pending MCP proposals">
            {draining ? '...' : drainResult ?? '↻'}
          </button>
        {/if}
      </p>
    </div>

    <!-- Tab bar -->
    <nav class="rp-tabs">
      <button class:active={activeTab === 'incoming'} onclick={() => activeTab = 'incoming'}>
        incoming
        {#if diff.entries.length > 0}<span class="badge">{diff.entries.length}</span>{/if}
      </button>
      <button class:active={activeTab === 'deletions'} onclick={() => activeTab = 'deletions'}>
        delete
        {#if pendingDeletions.length > 0}<span class="badge badge-danger">{pendingDeletions.length}</span>{/if}
      </button>
      <button class:active={activeTab === 'merges'} onclick={() => activeTab = 'merges'}>
        merge
        {#if pendingMerges.length > 0}<span class="badge badge-merge">{pendingMerges.length}</span>{/if}
      </button>
      <button class:active={activeTab === 'align'} onclick={() => activeTab = 'align'}>
        align
        {#if alignPending > 0}<span class="badge badge-align">{alignPending}</span>{/if}
      </button>
    </nav>

    <!-- Tab content -->
    <div class="rp-content">
    {#key bumpKey}

      {#if activeTab === 'incoming'}
        <!-- Summary chips -->
        <div class="summary">
          <span class="sc new">{diff.summary.new} new</span>
          <span class="sc reinforces">{diff.summary.reinforces} reinforce</span>
          <span class="sc conflict">{diff.summary.conflicts} conflict</span>
          {#if diff.summary.refines > 0}<span class="sc refines">{diff.summary.refines} refine</span>{/if}
          {#if diff.summary.duplicate > 0}<span class="sc duplicate">{diff.summary.duplicate} dup</span>{/if}
          {#if semanticAnalyzing}<span class="sc analyzing">analyzing...</span>{/if}
          {#if questionEntries.length > 0}
            <button class="sc question-filter" class:active={questionsOnly}
              onclick={() => (questionsOnly = !questionsOnly)}
              title="Show only partial facts awaiting an object">
              ❓ {questionEntries.length} question{questionEntries.length !== 1 ? 's' : ''}
            </button>
          {/if}
        </div>

        <!-- F88: who is competent to judge this, and what is stalled behind it.
             Defaults to `yours` — the whole point is to show the user LESS, not more. -->
        {#if diff.entries.length > 0}
          <div class="gates">
            <span class="gate-line mono">{routingLine}</span>
            <div class="gate-chips">
              <button class="gc" class:active={gateFilter === 'user'} onclick={() => (gateFilter = 'user')}
                title="Only you can settle these — your domain, your decision, your principles">
                yours <span class="gc-n">{routed.user.length}</span>
              </button>
              {#if routed.machine.length > 0}
                <button class="gc gc-machine" class:active={gateFilter === 'machine'} onclick={() => (gateFilter = 'machine')}
                  title="A script settles these — a path either exists or it does not. They should never have needed you.">
                  a script can settle <span class="gc-n">{routed.machine.length}</span>
                </button>
              {/if}
              {#if routed.agent.length > 0}
                <button class="gc gc-agent" class:active={gateFilter === 'agent'} onclick={() => (gateFilter = 'agent')}
                  title="A reviewing agent settles these — did the cited passage actually say this?">
                  an agent can settle <span class="gc-n">{routed.agent.length}</span>
                </button>
              {/if}
              <button class="gc gc-all" class:active={gateFilter === 'all'} onclick={() => (gateFilter = 'all')}>
                all <span class="gc-n">{diff.entries.length}</span>
              </button>
            </div>
          </div>
        {/if}

        {#if diffSummary}
          <div class="ds-cards">
            {#if diffSummary.newSummary && diffSummary.newSummary !== 'None.'}
              <div class="ds-card ds-new"><h4 class="ds-h mono">new</h4><p>{diffSummary.newSummary}</p></div>
            {/if}
            {#if diffSummary.reinforcingSummary && diffSummary.reinforcingSummary !== 'None.'}
              <div class="ds-card ds-reinforce"><h4 class="ds-h mono">reinforcing</h4><p>{diffSummary.reinforcingSummary}</p></div>
            {/if}
            {#if diffSummary.conflictingSummary && diffSummary.conflictingSummary !== 'None.'}
              <div class="ds-card ds-conflict"><h4 class="ds-h mono">conflicts</h4><p>{diffSummary.conflictingSummary}</p></div>
            {/if}
          </div>
        {:else if diff.entries.length > 0}
          <button class="ghost-btn" onclick={loadSummary} disabled={summaryLoading}>
            {summaryLoading ? 'summarizing...' : 'summarize changes'}
          </button>
        {/if}

        {#if diff.entries.length === 0}
          <div class="empty-state">
            <p>nothing pending.</p>
            <a href="/ingest">ingest something →</a>
          </div>
        {:else}
          {#snippet entryCard(e: typeof shownEntries[number])}
            <SwipeCard
              acceptLabel={e.incoming.needsObject ? 'fill first' : 'confirm'}
              rejectLabel="reject"
              onaccept={async () => {
                // Partial facts must be filled via the card's picker, not swipe-confirmed.
                if (e.incoming.needsObject) return;
                await setStatus(e.incoming.id, 'confirmed'); refresh();
              }}
              onreject={async () => { await setStatus(e.incoming.id, 'rejected'); refresh(); }}
            >
              <!-- Clicking a review card flies the preview graph to its node -->
              <div
                class="entry-focus-wrap"
                class:entry-focused={selected === termKey(e.incoming.s)}
                role="button"
                tabindex="0"
                onclick={() => focusStatement(e.incoming)}
                onkeydown={(ev) => { if (ev.key === 'Enter') focusStatement(e.incoming); }}
              >
                <DiffEntry entry={e} sourceLabel={sourceLabel(e.incoming.sourceId)} onresolved={refresh} />
              </div>
            </SwipeCard>
          {/snippet}

          <!-- F53/F83/F80.1 review-at-scale: an honest headline, then the contested few, then
               facts grouped into entity cards (decide about things, not rows). The per-fact
               confirm/reject controls are unchanged — nothing is hidden, only better ordered. -->
          <div class="ras-headline mono">{planHeadline}</div>

          {#if reviewPlan.attention.spotlight.length > 0}
            <div class="spotlight" data-testid="spotlight">
              <span class="spotlight-h mono">spotlight — decide these first</span>
              {#each reviewPlan.attention.spotlight as item (item.statement.id)}
                <button class="spot-item" onclick={() => focusStatement(item.statement)}>
                  <span class="spot-flag" class:conflict={item.conflict} class:decision={item.decision}>
                    {item.conflict ? 'conflict' : item.decision ? 'decision' : 'high impact'}
                  </span>
                  <span class="spot-label">{labelFromIRI(item.statement.s.value)}</span>
                  <span class="spot-pred mono">{labelFromIRI(item.statement.p.value)}</span>
                </button>
              {/each}
              {#if reviewPlan.attention.heldBack > 0}
                <span class="spot-held mono">+{reviewPlan.attention.heldBack} more waiting</span>
              {/if}
            </div>
          {/if}

          <div class="bulk-bar">
            <button class="bulk-btn" onclick={acceptAll} disabled={isProcessing}>
              {isProcessing ? 'accepting...' : 'accept all new'}
            </button>
            <button class="group-toggle" class:active={groupByEntity}
              onclick={() => (groupByEntity = !groupByEntity)}
              title="Group facts by the entity they describe">
              {groupByEntity ? 'by entity' : 'flat list'}
            </button>
            {#if error}<p class="error-text">{error}</p>{/if}
          </div>

          {#if groupByEntity}
            <div class="entity-cards" data-testid="entity-cards">
              {#each entityGroups as g (g.iri)}
                <div class="entity-card" class:spotlit={g.spotlight}>
                  <div class="entity-head">
                    <span class="entity-label">{g.label}</span>
                    <span class="entity-count mono">{g.entries.length} fact{g.entries.length === 1 ? '' : 's'}</span>
                    <span class="entity-gate mono gate-{g.gate}">{g.gate}</span>
                  </div>
                  <div class="entry-list">
                    {#each g.entries as e (e.incoming.id)}
                      {@render entryCard(e)}
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          {:else}
            <div class="entry-list">
              {#each shownEntries as e (e.incoming.id)}
                {@render entryCard(e)}
              {/each}
            </div>
          {/if}
        {/if}
      {/if}

      {#if activeTab === 'deletions'}
        {#if pendingDeletions.length === 0}
          <div class="empty-state">
            <p>no suggested deletions.</p>
          </div>
        {:else}
          <div class="entry-list">
            {#each pendingDeletions as st (st.id)}
              <SwipeCard
                acceptLabel="keep"
                rejectLabel="delete"
                onaccept={async () => { await keepStatement(st.id); }}
                onreject={async () => { await confirmDeletion(st.id); }}
              >
                <div
                  class="entry-focus-wrap"
                  class:entry-focused={selected === termKey(st.s)}
                  role="button"
                  tabindex="0"
                  onclick={() => focusStatement(st)}
                  onkeydown={(ev) => { if (ev.key === 'Enter') focusStatement(st); }}
                >
                  <div class="del-card">
                    <span class="del-tag mono">deletion</span>
                    <StatementCard statement={st} compact />
                    <div class="del-actions">
                      <button class="danger-btn" onclick={() => confirmDeletion(st.id)} disabled={isProcessing}>delete</button>
                      <button class="ghost-btn" onclick={() => keepStatement(st.id)} disabled={isProcessing}>keep</button>
                    </div>
                  </div>
                </div>
              </SwipeCard>
            {/each}
          </div>
        {/if}
      {/if}

      {#if activeTab === 'merges'}
        {#if pendingMerges.length === 0}
          <div class="empty-state">
            <p>no suggested merges.</p>
          </div>
        {:else}
          <div class="entry-list">
            {#each pendingMerges as st (st.id)}
              {@const keepIri = st.s.kind === 'iri' ? st.s.value : ''}
              {@const dropIri = st.o.kind === 'iri' ? st.o.value : ''}
              {@const keepLabel = keepIri.split('/').pop() ?? keepIri}
              {@const dropLabel = dropIri.split('/').pop() ?? dropIri}
              <SwipeCard
                acceptLabel="merge"
                rejectLabel="dismiss"
                onaccept={async () => { await executeMerge(st); }}
                onreject={async () => { await dismissMerge(st.id); }}
              >
                <div
                  class="entry-focus-wrap"
                  class:entry-focused={selected === termKey(st.s)}
                  role="button"
                  tabindex="0"
                  onclick={() => focusStatement(st)}
                  onkeydown={(ev) => { if (ev.key === 'Enter') focusStatement(st); }}
                >
                  <div class="merge-card">
                    <span class="merge-tag mono">merge</span>
                    {#if st.gloss}
                      <p class="merge-gloss">{st.gloss}</p>
                    {:else}
                      <p class="merge-gloss">
                        <strong>{dropLabel}</strong> → <strong>{keepLabel}</strong>
                      </p>
                    {/if}
                    <div class="merge-iris mono">
                      <span class="drop">{dropIri.split('/').pop()}</span>
                      <span class="arrow">→</span>
                      <span class="keep">{keepIri.split('/').pop()}</span>
                    </div>
                    <div class="merge-actions">
                      <button class="primary-btn" onclick={() => executeMerge(st)} disabled={isProcessing}>review merge</button>
                      <button class="ghost-btn" onclick={() => dismissMerge(st.id)} disabled={isProcessing}>dismiss</button>
                    </div>
                  </div>
                </div>
              </SwipeCard>
            {/each}
          </div>
        {/if}
      {/if}

      {#if activeTab === 'align'}
        <div class="align-picker">
          <KbPicker bind:selected={alignSelectedKbs} excludeId={currentKbId} />
          <button
            class="bulk-btn"
            onclick={runAlignment}
            disabled={alignSelectedKbs.size === 0 || alignLoading}
          >
            {alignLoading ? 'analyzing...' : `align ${alignSelectedKbs.size} graph${alignSelectedKbs.size !== 1 ? 's' : ''}`}
          </button>
        </div>

        {#if alignError}
          <p class="error-text">{alignError}</p>
        {/if}

        {#if alignResult}
          <div class="summary">
            <span class="sc new">{alignResult.summary.additions} add</span>
            <span class="sc reinforces">{alignResult.summary.reinforcements} reinforce</span>
            <span class="sc conflict">{alignResult.summary.conflicts} conflict</span>
            {#if alignResult.summary.refinements > 0}
              <span class="sc refines">{alignResult.summary.refinements} refine</span>
            {/if}
          </div>

          {#if alignResult.alignedEntities.filter(e => e.matchType === 'label-similarity').length > 0}
            <details class="align-entities-detail">
              <summary class="mono">
                {alignResult.alignedEntities.filter(e => e.matchType === 'label-similarity').length} entities matched by similarity
              </summary>
              <div class="align-entity-list">
                {#each alignResult.alignedEntities.filter(e => e.matchType === 'label-similarity') as ae}
                  <div class="align-entity-row mono">
                    <span class="ae-foreign">{ae.foreignLabel}</span>
                    <span class="ae-arrow">≈</span>
                    <span class="ae-active">{ae.activeLabel}</span>
                    <span class="ae-sim">{Math.round(ae.similarity * 100)}%</span>
                  </div>
                {/each}
              </div>
            </details>
          {/if}

          {#if alignPending === 0}
            <div class="empty-state">
              <p>all suggestions reviewed.</p>
            </div>
          {:else}
            <div class="entry-list">
              {#each alignResult.suggestions.filter(s => s.decision === 'pending') as suggestion (suggestion.id)}
                <SwipeCard
                  acceptLabel="accept"
                  rejectLabel="reject"
                  onaccept={() => acceptAlignment(suggestion)}
                  onreject={() => rejectAlignment(suggestion)}
                >
                  <div
                    class="entry-focus-wrap"
                    class:entry-focused={selected === termKey(suggestion.statement.s)}
                    role="button"
                    tabindex="0"
                    onclick={() => focusStatement(suggestion.statement)}
                    onkeydown={(ev) => { if (ev.key === 'Enter') focusStatement(suggestion.statement); }}
                  >
                    <AlignmentCard
                      {suggestion}
                      onaccept={() => acceptAlignment(suggestion)}
                      onreject={() => rejectAlignment(suggestion)}
                    />
                  </div>
                </SwipeCard>
              {/each}
            </div>
          {/if}
        {:else if !alignLoading}
          <div class="empty-state">
            <p>select KBs above to find alignment opportunities.</p>
          </div>
        {/if}
      {/if}

    {/key}
    </div>
  </aside>
</div>

<!-- Merge review modal -->
{#if showMergeReview}
  <MergeReview
    entityKeyA={mergeEntityA}
    entityKeyB={mergeEntityB}
    onConfirm={onMergeConfirm}
    onCancel={() => { showMergeReview = false; }}
  />
{/if}

<style>
  /* ── Layout ── */
  .review-layout {
    display: flex;
    width: 100vw;
    height: 100vh;
    height: 100dvh;
    overflow: hidden;
    position: fixed;
    top: 0;
    left: 0;
  }
  .review-layout.dragging {
    user-select: none;
    cursor: col-resize;
  }

  /* ── Graph pane ── */
  .graph-pane {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: rgba(10, 10, 11, 0.5);
    position: relative;
  }
  .graph-mode-bar {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--line);
    background: var(--surface);
    z-index: 10;
    flex-shrink: 0;
  }
  .mode-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.3rem 0.65rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: none;
    font-family: var(--font-mono);
    font-size: 0.65rem;
    color: var(--muted);
    cursor: pointer;
    transition: all 0.12s;
  }
  .mode-btn:hover { border-color: var(--accent); color: var(--ink); }
  .mode-btn.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }
  .mode-lbl { text-transform: uppercase; letter-spacing: 0.06em; }
  .mode-badge {
    font-size: 0.55rem;
    background: var(--accent);
    color: var(--surface);
    border-radius: 999px;
    padding: 0.05rem 0.35rem;
    font-weight: 700;
  }
  .mode-spacer { flex: 1; }
  .dim-toggle { margin-left: 0.2rem; }

  .graph-render {
    flex: 1;
    position: relative;
    overflow: hidden;
  }
  /* Focused-node caption (shown while a review item's node is selected) */
  .focus-badge {
    position: absolute;
    top: 0.6rem;
    left: 50%;
    transform: translateX(-50%);
    padding: 0.25rem 0.75rem;
    border-radius: 999px;
    border: 1px solid var(--accent);
    background: color-mix(in srgb, var(--accent) 16%, rgba(10, 15, 20, 0.85));
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    pointer-events: none;
    z-index: 5;
    max-width: 70%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Review card → graph focus affordance */
  .entry-focus-wrap { cursor: pointer; border-left: 2px solid transparent; transition: border-color 0.15s; }
  .entry-focus-wrap:hover { border-left-color: var(--muted-2, var(--muted)); }
  .entry-focus-wrap.entry-focused { border-left-color: var(--accent); }
  .graph-empty {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
  }
  .graph-empty .mono { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .graph-empty .small { font-size: 0.6rem; }

  .preview-legend {
    position: absolute;
    bottom: 0.65rem;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 0.75rem;
    background: rgba(10, 10, 14, 0.82);
    backdrop-filter: blur(10px);
    border-radius: 999px;
    padding: 0.3rem 1rem;
    pointer-events: none;
    white-space: nowrap;
    z-index: 5;
  }
  .pl-chip {
    font-family: var(--font-mono);
    font-size: 0.58rem;
    color: var(--muted);
  }
  .pl-pending { color: var(--accent); }
  .pl-confirmed { color: var(--muted); }

  /* ── Overlay controls strip ── */
  .overlay-controls {
    padding: 0.4rem 0.75rem;
    border-bottom: 1px solid var(--line);
    background: var(--surface);
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    flex-shrink: 0;
    z-index: 10;
  }
  .ov-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-wrap: wrap;
  }
  .ov-label {
    font-size: 0.55rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-right: 0.2rem;
    flex-shrink: 0;
  }
  .ov-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    padding: 0.15rem 0.45rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: none;
    font-family: var(--font-mono);
    font-size: 0.55rem;
    color: var(--muted);
    cursor: pointer;
    transition: all 0.1s;
    white-space: nowrap;
  }
  .ov-chip:hover { border-color: var(--accent); color: var(--ink); }
  .ov-chip.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
  .ov-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .ov-count { font-size: 0.48rem; opacity: 0.5; }
  .ov-current { color: var(--accent); font-size: 0.6rem; }
  .ov-chip:disabled { opacity: 0.5; cursor: wait; }
  .ov-hint { font-size: 0.55rem; color: var(--muted); }

  /* ── Browse controls (F30: layout ToggleGroup + node search on the preview) ── */
  .browse-controls { padding-top: 0.35rem; padding-bottom: 0.35rem; }
  :global(.review-layout .tg-row) {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  :global(.review-layout .tg-chip) {
    display: inline-flex;
    align-items: center;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: none;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.6rem;
    cursor: pointer;
    transition: all 0.12s;
    user-select: none;
  }
  :global(.review-layout .tg-chip:hover) { border-color: var(--accent); color: var(--ink); }
  :global(.review-layout .tg-chip[data-state="on"]) {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }
  .node-search-wrap { position: relative; margin-left: 0.4rem; flex: 1; min-width: 120px; max-width: 220px; }
  .node-search-input {
    width: 100%;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.2rem 0.5rem;
    font-size: 0.62rem;
    color: var(--ink-2);
  }
  .node-search-input:focus { outline: none; border-color: var(--accent); }
  .node-search-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    background: rgba(14, 14, 20, 0.96);
    backdrop-filter: blur(16px);
    border: 1px solid var(--accent);
    border-radius: var(--rad-sm);
    overflow: hidden;
    z-index: 20;
    max-height: 220px;
    overflow-y: auto;
  }
  .node-search-row {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.3rem 0.55rem;
    background: none;
    border: none;
    color: var(--ink-2);
    font-size: 0.68rem;
    cursor: pointer;
  }
  .node-search-row:hover { background: color-mix(in srgb, var(--accent) 12%, var(--surface)); color: var(--accent); }

  /* ── Node details pane (left of graph, F30) ── */
  .node-details-pane {
    position: absolute;
    top: 0.75rem;
    left: 0.75rem;
    bottom: 0.75rem;
    width: 250px;
    max-width: calc(100% - 1.5rem);
    display: flex;
    flex-direction: column;
    background: rgba(14, 14, 20, 0.92);
    backdrop-filter: blur(14px);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    box-shadow: 0 8px 28px rgba(0,0,0,0.4);
    z-index: 6;
    overflow: hidden;
  }
  .ndp-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.4rem;
    padding: 0.6rem 0.65rem 0.45rem;
    border-bottom: 1px solid var(--line);
    flex-shrink: 0;
  }
  .ndp-title { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
  .ndp-label {
    font-family: var(--font-display);
    font-size: 0.9rem;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ndp-type {
    font-size: 0.55rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent);
  }
  .ndp-close {
    flex-shrink: 0;
    background: none;
    border: none;
    color: var(--muted);
    font-size: 0.7rem;
    cursor: pointer;
    padding: 0.1rem;
  }
  .ndp-close:hover { color: var(--danger); }
  .ndp-stmts {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0.65rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    min-height: 0;
  }
  .ndp-empty { color: var(--muted); font-size: 0.65rem; margin: 0; }
  .ndp-stmt {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.3rem;
    font-size: 0.68rem;
    padding: 0.15rem 0;
    border-bottom: 1px solid color-mix(in srgb, var(--line) 60%, transparent);
  }
  .ndp-stmt.ndp-pending { color: var(--accent); }
  .ndp-pending-tag {
    font-size: 0.5rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 999px;
    padding: 0.02rem 0.3rem;
  }
  .ndp-pred { color: var(--muted); }
  .ndp-other { color: var(--ink-2); overflow-wrap: anywhere; }
  .ndp-chat {
    flex-shrink: 0;
    border-top: 1px solid var(--line);
    padding: 0.5rem 0.65rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .ndp-chat-row { display: flex; gap: 0.3rem; }
  .ndp-chat-input {
    flex: 1;
    min-width: 0;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.3rem 0.5rem;
    font-size: 0.65rem;
    color: var(--ink-2);
  }
  .ndp-chat-input:focus { outline: none; border-color: var(--accent); }
  .ndp-chat-send {
    flex-shrink: 0;
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    color: var(--accent);
    border-radius: var(--rad-sm);
    width: 1.9rem;
    cursor: pointer;
    font-size: 0.75rem;
  }
  .ndp-chat-send:disabled { opacity: 0.4; cursor: not-allowed; }
  .ndp-chat-open { align-self: flex-start; }

  /* ── Resize handle ── */
  .resize-handle {
    width: 5px;
    cursor: col-resize;
    background: transparent;
    flex-shrink: 0;
    position: relative;
    z-index: 20;
    transition: background 0.15s;
  }
  .resize-handle::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 2px;
    width: 1px;
    background: var(--line);
  }
  .resize-handle:hover,
  .resize-handle.active {
    background: color-mix(in srgb, var(--accent) 25%, transparent);
  }
  .resize-handle:hover::after,
  .resize-handle.active::after {
    background: var(--accent);
  }

  /* ── Review panel ── */
  .review-panel {
    display: flex;
    flex-direction: column;
    background: var(--surface);
    flex-shrink: 0;
    min-width: 0;
    /* The 3D node labels are position:fixed (viewport coords) at z-index 10, so on this split
       layout they spill over the side panel. The panel is opaque — sit it ABOVE the labels (but
       below the z-20 resize handle) so spilled labels are occluded by the panel instead of
       bleeding across it. */
    position: relative;
    z-index: 15;
  }
  .rp-header {
    padding: 0.75rem 1rem 0.5rem;
    border-bottom: 1px solid var(--line);
  }
  .rp-title {
    font-family: var(--font-display);
    font-size: 1.1rem;
    color: var(--ink);
    margin: 0;
  }
  .rp-sub {
    font-size: 0.6rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 0.15rem 0 0;
  }
  .drain-btn {
    background: none;
    border: 1px solid var(--line);
    color: var(--muted);
    font-size: 0.6rem;
    padding: 0.1rem 0.35rem;
    border-radius: var(--rad-sm);
    cursor: pointer;
    margin-left: 0.5rem;
    vertical-align: middle;
  }
  .drain-btn:hover { color: var(--accent); border-color: var(--accent); }

  .rp-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--line);
    flex-shrink: 0;
  }
  .rp-tabs button {
    flex: 1;
    padding: 0.45rem 0.5rem;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    margin-bottom: -1px;
    transition: color 0.12s, border-color 0.12s;
  }
  .rp-tabs button.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .badge {
    font-size: 0.55rem;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 999px;
    padding: 0.05rem 0.35rem;
  }
  .badge-danger { background: color-mix(in srgb, var(--danger) 15%, var(--surface)); color: var(--danger); }
  .badge-merge { background: color-mix(in srgb, var(--data) 15%, var(--surface)); color: var(--data); }

  .rp-content {
    flex: 1;
    overflow-y: auto;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* Summary chips */
  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-bottom: 0.25rem;
  }
  .sc {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    padding: 0.15rem 0.45rem;
    border-radius: 999px;
    border: 1px solid var(--line);
    color: var(--muted);
  }

  /* ── F88 gate routing ── */
  .gates {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin: 0.5rem 0 0.75rem;
  }
  .gate-line {
    font-size: 0.62rem;
    color: var(--muted);
  }
  .gate-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .gc {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }
  .gc:hover { border-color: var(--accent); color: var(--fg); }
  .gc.active {
    border-color: var(--accent);
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .gc-n { opacity: 0.75; margin-left: 0.2rem; }
  /* The two lanes that are NOT the user's are deliberately quiet — they are what the
     queue is sparing them, not another thing demanding attention. */
  .gc-machine, .gc-agent { opacity: 0.75; }
  .sc.question-filter {
    cursor: pointer;
    background: transparent;
    color: var(--accent);
    border-color: var(--accent);
  }
  .sc.question-filter.active {
    background: var(--accent);
    color: var(--surface);
  }
  .sc.new { color: var(--data); border-color: var(--data); }
  .sc.reinforces { color: var(--ok); border-color: var(--ok); }
  .sc.refines { color: var(--accent); border-color: var(--accent); }
  .sc.conflict { color: var(--danger); border-color: var(--danger); }
  .sc.analyzing { animation: pulse 1.2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }

  /* Diff summary cards */
  .ds-cards {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-bottom: 0.5rem;
  }
  .ds-card {
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.5rem 0.65rem;
  }
  .ds-card p { font-size: 0.72rem; line-height: 1.4; color: var(--ink-2); margin: 0; }
  .ds-h {
    font-size: 0.55rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin: 0 0 0.2rem;
  }
  .ds-new { border-color: color-mix(in srgb, var(--ok) 35%, var(--line)); }
  .ds-new .ds-h { color: var(--ok); }
  .ds-reinforce { border-color: color-mix(in srgb, var(--data) 35%, var(--line)); }
  .ds-reinforce .ds-h { color: var(--data); }
  .ds-conflict { border-color: color-mix(in srgb, var(--danger) 35%, var(--line)); }
  .ds-conflict .ds-h { color: var(--danger); }

  /* Buttons */
  .ghost-btn {
    background: none;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.3rem 0.65rem;
    font-family: var(--font-mono);
    font-size: 0.65rem;
    color: var(--muted);
    cursor: pointer;
    transition: color 0.12s, border-color 0.12s;
  }
  .ghost-btn:hover { color: var(--accent); border-color: var(--accent); }
  .ghost-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .bulk-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .bulk-btn {
    padding: 0.35rem 0.7rem;
    border-radius: var(--rad-sm);
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.65rem;
    cursor: pointer;
  }
  .bulk-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .error-text { color: var(--danger); font-size: 0.7rem; margin: 0; }

  .primary-btn {
    padding: 0.35rem 0.7rem;
    border-radius: var(--rad-sm);
    border: 1px solid var(--data);
    background: color-mix(in srgb, var(--data) 14%, var(--surface));
    color: var(--data);
    font-family: var(--font-mono);
    font-size: 0.65rem;
    cursor: pointer;
  }
  .primary-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .danger-btn {
    padding: 0.35rem 0.7rem;
    border-radius: var(--rad-sm);
    border: 1px solid var(--danger);
    background: color-mix(in srgb, var(--danger) 14%, var(--surface));
    color: var(--danger);
    font-family: var(--font-mono);
    font-size: 0.65rem;
    cursor: pointer;
  }
  .danger-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  /* Entry list */
  .entry-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  /* F53/F83 review-at-scale surface */
  .ras-headline {
    font-size: 0.8rem;
    color: var(--muted, #888);
    margin: 0.2rem 0 0.6rem;
  }
  .spotlight {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 0.6rem;
    margin-bottom: 0.6rem;
    border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line));
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--accent) 6%, transparent);
  }
  .spotlight-h {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--accent);
    width: 100%;
  }
  .spot-item {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.2rem 0.45rem;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    background: var(--surface, transparent);
    cursor: pointer;
    font-size: 0.8rem;
  }
  .spot-item:hover { border-color: var(--accent); }
  .spot-flag {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.05rem 0.3rem;
    border-radius: 0.3rem;
    background: color-mix(in srgb, var(--muted, #888) 18%, transparent);
    color: var(--muted, #888);
  }
  .spot-flag.conflict { background: color-mix(in srgb, var(--danger) 22%, transparent); color: var(--danger); }
  .spot-flag.decision { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent); }
  .spot-pred { font-size: 0.72rem; color: var(--muted, #888); }
  .spot-held { font-size: 0.72rem; color: var(--muted, #888); }
  .group-toggle {
    padding: 0.25rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    background: transparent;
    cursor: pointer;
    font-size: 0.78rem;
  }
  .group-toggle.active { border-color: var(--accent); color: var(--accent); }
  .entity-cards { display: flex; flex-direction: column; gap: 0.7rem; }
  .entity-card {
    border: 1px solid var(--line);
    border-radius: 0.5rem;
    padding: 0.4rem 0.5rem 0.5rem;
  }
  .entity-card.spotlit { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
  .entity-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.1rem 0.15rem 0.45rem;
  }
  .entity-label { font-weight: 600; font-size: 0.9rem; }
  .entity-count { font-size: 0.72rem; color: var(--muted, #888); }
  .entity-gate {
    margin-left: auto;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.05rem 0.35rem;
    border-radius: 0.3rem;
    background: color-mix(in srgb, var(--muted, #888) 15%, transparent);
    color: var(--muted, #888);
  }
  .entity-gate.gate-user { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }

  /* Deletion cards */
  .del-card {
    padding: 0.6rem;
    border: 1px solid color-mix(in srgb, var(--danger) 30%, var(--line));
    border-radius: var(--rad-sm);
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .del-tag {
    font-size: 0.55rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--danger);
  }
  .del-actions {
    display: flex;
    gap: 0.35rem;
  }

  /* Merge cards */
  .merge-card {
    padding: 0.6rem;
    border: 1px solid color-mix(in srgb, var(--data) 30%, var(--line));
    border-radius: var(--rad-sm);
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .merge-tag {
    font-size: 0.55rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--data);
  }
  .merge-gloss { margin: 0; font-size: 0.78rem; }
  .merge-iris {
    font-size: 0.6rem;
    color: var(--muted);
    display: flex;
    gap: 0.3rem;
    align-items: center;
  }
  .merge-iris .drop { color: var(--danger); }
  .merge-iris .keep { color: var(--ok); }
  .merge-iris .arrow { opacity: 0.5; }
  .merge-actions {
    display: flex;
    gap: 0.35rem;
  }

  .empty-state {
    text-align: center;
    color: var(--muted);
    padding: 2rem 0.5rem;
    font-size: 0.82rem;
  }
  .empty-state p { margin: 0.2rem 0; }

  /* ── Align tab ── */
  .badge-align { background: color-mix(in srgb, var(--accent) 15%, var(--surface)); color: var(--accent); }
  .align-picker {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.25rem;
  }
  .align-entities-detail {
    font-size: 0.65rem;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 0.3rem 0.5rem;
  }
  .align-entities-detail summary {
    cursor: pointer;
    font-size: 0.55rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .align-entity-list {
    margin-top: 0.3rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .align-entity-row {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.58rem;
  }
  .ae-foreign { color: var(--data); }
  .ae-active { color: var(--accent); }
  .ae-arrow { opacity: 0.4; }
  .ae-sim { opacity: 0.5; font-size: 0.5rem; }

  /* ── Mobile ── */
  @media (max-width: 700px) {
    .review-layout {
      flex-direction: column;
    }
    .graph-pane {
      height: 45vh;
      min-height: 280px;
    }
    .resize-handle {
      display: none;
    }
    .review-panel {
      width: 100% !important;
      max-width: none;
      min-width: 0;
      border-top: 1px solid var(--line);
      flex: 1;
      /* This route is a fixed full-viewport workspace, so the app shell's main
         padding cannot protect its scrollable decision surface from the nav. */
      padding-bottom: var(--app-nav-clearance);
    }
    .node-details-pane {
      width: calc(100% - 1.5rem);
      max-height: 60%;
      bottom: auto;
    }
    .node-search-wrap {
      max-width: none;
      flex-basis: 100%;
    }
  }
</style>
