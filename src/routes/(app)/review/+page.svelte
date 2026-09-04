<script lang="ts">
  import { Canvas } from '@threlte/core';
  import { replaceState } from '$app/navigation';
  import { Popover } from 'bits-ui';
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
    setStatuses,
    updateStatement,
    addStatements,
    addSource,
  } from '$lib/stores/kb.svelte';
  import { getRegistry, getCurrentKbId } from '$lib/storage/kb-registry';
  import { drainAndImportPending, workspaceState, supportsWorkspace } from '$lib/stores/workspace.svelte';
  import { runPartition } from '$lib/rdf/partition-run';
  import { planOptionCascade, cascadeWrites } from '$lib/rdf/option-cascade';
  import {
    computeAlignment, loadKbStatements, applyAlignmentToActiveKb,
    type AlignmentResult, type AlignmentSuggestion,
  } from '$lib/rdf/cross-kb-align';
  import { termKey, isIRI, isLit, isMetaPredicate, type Statement } from '$lib/rdf/types';
  import { newAliasValues, primaryLabelAfterMerge, buildAliasStatements } from '$lib/rdf/merge-aliases';
  import { computeDiff } from '$lib/rdf/diff';
  import { generateDiffSummary, type DiffSummary } from '$lib/rdf/diff-summary';
  import { semanticEnrichDiff, labelFromIRI } from '$lib/rdf/semantic-diff';
  import { buildReviewPlan, reviewPlanSummary } from '$lib/rdf/review-pipeline';
  import { buildReviewTree, reviewTreeSummary, questionText } from '$lib/rdf/review-tree';
  import { reanalysisRequest, reanalysisSummary } from '$lib/rdf/reanalysis';
  import { runReanalysis, type ReanalysisRun } from '$lib/rdf/reanalysis-run';
  import { altitudeOf, ALTITUDE_META, ALTITUDE_RANK, type Altitude } from '$lib/rdf/fact-altitude';
  import { applyPartition,
    clusterForCascade, applyCascade, cascadeSummary, needsPurposeQuestion, purposeQuestion,
    BASIS_META, type FactCluster, type CascadeAction,
  } from '$lib/rdf/fact-aggregation';
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
  let graphSettled = $state(false);

  // ── Review data ───────────────────────────────────────────────────────────
  // LOG-ALTITUDE FACTS ARE NOT REVIEW WORK. A dictated sentence stored whole
  // (`kpred:captured-note`) asserts only that somebody said something, and the person who would
  // be asked to confirm it is the person who said it — F139 calls queueing one "not inefficient,
  // it is incoherent". The KNOWLEDGE in a note is whatever extraction reads out of it, and those
  // triples queue normally on their own merits.
  //
  // FILTERED FOR DISPLAY, NOT AUTO-CONFIRMED ON IMPORT. The queue is a proposal transport, not an
  // authentication channel: letting a JSONL row carry a predicate that settles it would let any
  // writer of that file mint confirmed facts. So the status stays `pending` and the QUEUE decides
  // not to ask about it. Extraction settles it properly a moment later.
  const allIncoming = $derived(pendingStatements());

  // DETAIL — the same ladder the graph view uses, on the queue (Matt, 2026-08-28: "I need
  // depth/detail/altitude in the review screen, for sure").
  //
  // This queue ALREADY hid logs, with a hardcoded `!== 'log'` and no way to see past it. The
  // default below reproduces that behaviour exactly, so nothing changes for anyone who does not
  // touch the control — what changes is that the floor is now visible, adjustable, and says what
  // it costs. `hubs` is deliberately absent: a hub is a shape in a graph, not a property of a
  // fact awaiting a decision.
  type ReviewDetailId = 'all' | 'detailed' | 'evidence' | 'judgments' | 'decisions';
  const REVIEW_DETAIL_LEVELS: { id: ReviewDetailId; label: string; floor: Altitude | null; title: string }[] = [
    { id: 'all', label: 'all', floor: null, title: 'Everything, including logs — notes and timestamps that assert only that something happened' },
    { id: 'detailed', label: 'detailed', floor: 'record', title: 'Above logs — the default, and what this queue has always shown' },
    { id: 'evidence', label: 'evidence', floor: 'evidence', title: 'Measurements and up — drops mechanical records a script settles' },
    { id: 'judgments', label: 'judgments', floor: 'judgment', title: 'Verdicts no check can settle, and the decisions above them' },
    { id: 'decisions', label: 'decisions', floor: 'decision', title: 'Only facts that foreclose options' },
  ];
  let reviewDetail = $state<ReviewDetailId>('detailed');
  // `?? 'record'` would be WRONG here: the `all` rung's floor is deliberately null, and ?? treats
  // null as nullish — so selecting "all" would have silently kept the log floor on. Resolve the
  // LEVEL, then read its floor.
  const reviewLevel = $derived(
    REVIEW_DETAIL_LEVELS.find((l) => l.id === reviewDetail) ?? REVIEW_DETAIL_LEVELS[1],
  );
  const reviewFloor = $derived(reviewLevel.floor);

  // RAW ALTITUDE, NOT LIFTED — and this is a correction, recorded because it is not obvious.
  // The graph view's ladder uses liftedAltitudes so a log under an open decision stays visible.
  // Making this queue match broke `review.test.ts` ("unplanned work is asked for its PURPOSE"):
  // lifting raises log facts INTO the queue, and cascade aggregation refuses decision- and
  // judgment-altitude members by design (kb:cascade-aggregation), so the purpose row never
  // formed. The two surfaces genuinely want different things — the canvas is showing you a
  // picture, the queue is assembling a decision — so the queue keeps raw altitude and the
  // difference is stated rather than smoothed over. Revisit with the cascade validator in hand,
  // not by changing this line.
  const incoming = $derived(
    reviewFloor === null
      ? allIncoming
      : allIncoming.filter((s) => ALTITUDE_RANK[altitudeOf(s)] >= ALTITUDE_RANK[reviewFloor]),
  );
  /** Said out loud rather than silently dropped — a hidden row must look hidden, not absent. */
  const hiddenLogCount = $derived(allIncoming.length - incoming.length);
  const pendingDeletions = $derived(pendingRemovalStatements());
  const pendingMerges = $derived(pendingMergeStatements());

  // Everything that is not itself in the review queue. Rejected and superseded statements ARE
  // included deliberately (F122): computeDiff needs to see a settled decision to recognise a
  // fact coming back, and it keeps them out of its own active indexes, so they can never be
  // reported as a duplicate, conflict or refinement of a live claim. Filtering them out here
  // instead — as this did — silently bypassed that and let an already-rejected fact render as
  // 'new' on the one surface where the user would meet it.
  const existing = $derived(
    statements().filter(
      (s) => s.status !== 'pending' && s.status !== 'pending-removal'
    )
  );

  // Structural diff
  const structuralDiff = $derived(computeDiff(incoming, existing));

  // Semantic diff (async upgrade)
  let semanticDiff = $state<ReturnType<typeof computeDiff> | null>(null);
  let semanticAnalyzing = $state(false);
  let semanticReady = $state(false);
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

  // ── F139 ALTITUDE + F139.1 CASCADE ────────────────────────────────────────
  // The tree reads the USER LANE only: routeQueue has already removed what a script or a reviewing
  // agent can settle, so the tree never asks the human about a fact that was never theirs.
  /**
   * SIZE GUARD — above this many facts the tree and the cascade are not computed at all.
   *
   * Measured 2026-08-19: buildReviewTree over a 40,433-fact synced graph costs ~210ms and
   * clusterForCascade ~40ms, and both are $derived, so they re-run on every accept. That is a
   * visible stall per click. The residual cost is honest linear work — roughly ten passes over the
   * graph — not a hot spot left to remove, so the answer is to stop doing it rather than to shave it.
   *
   * IT MUST SAY SO RATHER THAN SILENTLY DEGRADE. A review surface that quietly stops surfacing
   * decisions on a large graph is worse than one that is slow, because the user cannot tell the
   * difference between "no decisions" and "not looked". The headline states the skip and the reason.
   */
  const TREE_FACT_LIMIT = 12_000;
  const graphForTree = $derived([...existing, ...incoming]);
  const treeTooBig = $derived(graphForTree.length > TREE_FACT_LIMIT);

  const reviewTree = $derived(
    treeTooBig
      ? { decisions: [], suppressed: { record: 0, log: 0 }, orphans: [], machineSettleable: [], standingDescription: 0, considered: 0 }
      : buildReviewTree(
          reviewPlan.routed.user.map((it) => it.statement),
          graphForTree,
          { typeOf: (iri) => subjectTypes.get(iri) },
        ),
  );
  const treeHeadline = $derived(
    treeTooBig
      ? `Decision tree skipped: ${graphForTree.length.toLocaleString()} facts is over the ${TREE_FACT_LIMIT.toLocaleString()} limit, and computing it on every change would stall this page. Narrow the graph, or raise the limit deliberately.`
      : reviewTreeSummary(reviewTree),
  );

  /**
   * The CASCADE lane: clusters of bookkeeping that ONE question settles (F139.1).
   *
   * Built from the facts the tree files as noise — the record/log altitudes plus the orphan tail —
   * because those are exactly the rows a person should never be asked to click through one at a
   * time. Only the deterministic floor runs in the browser; the agent-tier proposals arrive through
   * the normal pending queue like any other agent output.
   */
  const cascadeClusters = $derived.by(() => {
    if (treeTooBig) return [];
    // Cascades exist to keep low-altitude bookkeeping OUT of the row-by-row queue while still
    // giving a person one honest way to settle it. Building this from `incoming` made the visible
    // detail floor erase the very logs this lane aggregates: the six unplanned completion notes
    // disappeared at the default `detailed` rung, so their required purpose question never formed.
    // Detail controls individual rows; cascade aggregation must inspect the complete pending set.
    const candidates = allIncoming.filter((st) => {
      const a = altitudeOf(st);
      return a === 'log' || a === 'record' || a === 'evidence';
    });
    return clusterForCascade(candidates, { subjectLabel: labelFromIRI });
  });
  const cascadeHeadline = $derived(cascadeSummary(cascadeClusters));

  /** A subject is "planned" when it is a typed Feature/Phase — decides purpose vs truth question. */
  const isPlannedSubject = (iri: string) => {
    const t = subjectTypes.get(iri);
    return t === 'urn:kbase:type/Feature' || t === 'urn:kbase:type/Phase';
  };

  /** Which cascade cluster is expanded to show its members. */
  let openCluster = $state<string | null>(null);
  /** Which decision root is expanded to show the case beneath it. */
  let openDecision = $state<string | null>(null);

  /**
   * Resolve an entity's own rdfs:label, falling back to its IRI slug.
   *
   * The facts an option rules out are the option's PRICE, so they have to read as the things they
   * are ("Content history in git, diffable and revertible") rather than as bare IRIs. A cost the
   * reviewer cannot read is not a cost they can weigh.
   */
  const entityLabels = $derived.by(() => {
    const m = new Map<string, string>();
    if (treeTooBig) return m;
    for (const st of graphForTree) {
      if (st.p.value === 'http://www.w3.org/2000/01/rdf-schema#label' && st.o.kind === 'literal') {
        m.set(st.s.value, st.o.value);
      }
    }
    return m;
  });
  const labelForIri = (iri: string) => entityLabels.get(iri) ?? labelFromIRI(iri);
  /** Free-text answer for a purpose question, keyed by cluster id. */
  let purposeAnswers = $state<Record<string, string>>({});

  /**
   * Settle a whole cluster with one answer.
   *
   * The human is at the keyboard and the channel is recorded, which is what keeps F52 intact: this
   * is a person settling many facts at once, not an agent settling anything.
   */
  let cascadeBusy = $state<string | null>(null);
  let cascadeEffect = $state<string | null>(null);

  /** Which cluster the last purpose failure belongs to, so the message sits on the right card. */
  let purposeError = $state<string | null>(null);
  let purposeErrorCluster = $state<string | null>(null);

  /**
   * Settle a purpose cluster with the user's own words.
   *
   * The model only SORTS: `validateProposedPartition` drops any purpose not built from words the
   * person actually used, so a hallucinated goal cannot become a work unit. A single-purpose
   * answer is legitimate and cannot be partitioned (applyPartition needs two parts), so it falls
   * back to settling the whole cluster — the user still said what the work was for.
   */
  async function settlePurpose(cluster: FactCluster) {
    const answer = (purposeAnswers[cluster.id] ?? '').trim();
    if (!answer || cascadeBusy) return;
    cascadeBusy = cluster.id;
    purposeError = null;
    purposeErrorCluster = cluster.id;
    try {
      const run = await runPartition(cluster, answer, settings());
      if (!run.outcome || run.error) {
        purposeError = run.error ?? 'The model returned nothing usable.';
        return;
      }
      if (run.outcome.parts.length < 2) {
        purposeError =
          'You named one goal, so there is nothing to split — settling the whole set under it.';
        await settleCluster(cluster, 'confirm');
        return;
      }
      const result = applyPartition(run.outcome, cluster, answer, {
        actor: 'user',
        channel: 'app:review',
      });
      await addStatements(result.recorded, 'manual');
      for (const st of result.updated) await setStatus(st.id, st.status);
      cascadeEffect = result.effect;
      purposeAnswers[cluster.id] = '';
      openCluster = null;
      if (run.outcome.rejected.length > 0) {
        purposeError = `${run.outcome.rejected.length} proposed group(s) used words you did not, and were dropped.`;
      }
    } catch (err) {
      purposeError = err instanceof Error ? err.message : String(err);
    } finally {
      cascadeBusy = null;
    }
  }

  async function settleCluster(cluster: FactCluster, answer: CascadeAction) {
    if (cascadeBusy) return;
    cascadeBusy = cluster.id;
    try {
      const result = applyCascade(cluster, answer, { actor: 'user', channel: 'app:review' });
      // The user's own fact first, so the decision exists before anything points at it.
      await addStatements([result.recorded], 'manual');
      for (const st of result.updated) await setStatus(st.id, st.status);
      cascadeEffect = result.effect;
      openCluster = null;
    } finally {
      cascadeBusy = null;
    }
  }

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
    semanticReady = false;
    if (sDiff.entries.length === 0) {
      semanticDiff = null;
      semanticAnalyzing = false;
      semanticReady = true;
      return;
    }
    // Clear the spinner on the way out. This returned without touching it, so once enrichment had
    // failed one run — after which every later run takes this branch — a stale `true` could never
    // be cleared by anything, and "analyzing…" stayed on the summary row for the rest of the session.
    if (semanticFailed) { semanticAnalyzing = false; semanticReady = true; return; }
    semanticAnalyzing = true;
    semanticDiff = null;
    semanticEnrichDiff(sDiff, ex).then(enriched => {
      if (myVersion === semanticVersion) {
        semanticDiff = enriched;
        semanticAnalyzing = false;
        semanticReady = true;
      }
    }).catch(() => {
      semanticFailed = true;
      if (myVersion === semanticVersion) {
        semanticAnalyzing = false;
        semanticReady = true;
      }
    });
  });

  let isProcessing = $state(false);
  let error = $state<string | null>(null);

  /*
   * ── F139 step 3: FREEFORM RE-ANALYSIS OF THE PENDING SET ────────────────────
   *
   * Matt, 2026-08-21: the summary and the analyze actions are a start, but what is missing is a
   * way to prompt DIRECTLY AFTER THE SUMMARY and suggest a re-analysis in your own words. The
   * principle behind it: not every divergence from the intended shape is detectable by a model or
   * a rule, the human is still the best layer of intelligence, and nudging pending facts toward
   * their ideal hierarchy BEFORE they enter the graph costs far less than editing the graph after.
   *
   * It proposes only: attach / group / depend / drop, over facts that already exist. Nothing is
   * applied until the person applies it, and nothing here can mint a fact.
   */
  let reanalysisInstruction = $state('');
  let reanalysisBusy = $state(false);
  let reanalysisRun = $state<ReanalysisRun | null>(null);

  async function runPendingReanalysis() {
    const instruction = reanalysisInstruction.trim();
    if (!instruction || reanalysisBusy || !semanticReady) return;
    reanalysisBusy = true;
    reanalysisRun = null;
    try {
      const req = reanalysisRequest(
        instruction,
        pendingStatements(),
        reviewTree.decisions.map((d) => ({
          id: d.question.id,
          subjectIri: d.subjectIri,
          question: questionText(d),
        })),
      );
      reanalysisRun = await runReanalysis(req, settings());
    } finally {
      reanalysisBusy = false;
    }
  }

  // ── Diff summary ──────────────────────────────────────────────────────────
  let diffSummary = $state<DiffSummary | null>(null);
  let summaryLoading = $state(false);
  async function loadSummary() {
    summaryLoading = true;
    try { diffSummary = await generateDiffSummary(diff, settings()); }
    catch { /* handled */ }
    finally { summaryLoading = false; }
  }


  let draining = $state(false);
  let drainResult = $state<string | null>(null);

  /** What the last bulk accept actually did — including when the honest answer is "nothing". */
  let bulkResult = $state<string | null>(null);
  async function checkPending() {
    draining = true;
    drainResult = null;
    try {
      // Distinguish the three ways a drain yields nothing. They used to all report 'none', so
      // "this graph has no queued rows" was indistinguishable from "I cannot read the queue at
      // all" — which is what an unlinked folder, or a non-secure origin where the File System
      // Access API does not exist, actually means. Silence on the failure that needs an action.
      if (!supportsWorkspace()) {
        drainResult = 'unavailable here — open over localhost or https';
        return;
      }
      if (workspaceState() !== 'connected') {
        drainResult = 'no folder linked for this graph';
        return;
      }
      const count = await drainAndImportPending();
      drainResult = count > 0 ? `${count} imported` : 'none queued for this graph';
      // store update is reactive — no manual refresh needed
    } catch { drainResult = 'error'; }
    finally { draining = false; setTimeout(() => drainResult = null, 6000); }
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

  // How many edges the tree layout can actually build a hierarchy from.
  //
  // `buildHierarchyAnchors` returns an empty anchor map when the graph states no parent edges, and
  // the force layout then takes over — so choosing "tree" on a graph without them looks exactly
  // like a broken button. It is not: the graph genuinely has no hierarchy to draw. Say which of
  // the two it is, rather than making the user guess from a layout that quietly did nothing.
  const hierarchyEdgeCount = $derived(
    previewStatements.filter(
      (s) =>
        s.o.kind === 'iri' &&
        (s.p.value === 'http://www.w3.org/2004/02/skos/core#broader' ||
          s.p.value === 'urn:kbase:predicate/depends-on'),
    ).length,
  );

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
  /*
   * ── BI-DIRECTIONAL SELECTION (Matt, 2026-08-21) ────────────────────────────────────────────
   *
   * "if graph node selected, go to any entity pending facts. If the entity is selected from the
   * pending fact, show it on the graph."
   *
   * The panel -> graph half already worked: clicking a card calls focusStatement and the preview
   * flies to the node. The graph -> panel half did NOT: selecting a node highlighted matching rows
   * with .entry-focused and left them wherever they were, which on a 145-fact queue is usually off
   * screen — a highlight nobody can see is the same as no feedback at all.
   *
   * WHY THE SOURCE IS TRACKED. Scrolling on every `selected` change would also fire when the user
   * clicks a card, yanking the row they just clicked out from under the cursor. So the scroll runs
   * only for selections that came FROM the graph. Same state, two directions, one of which must
   * not echo.
   */
  let selectionSource = $state<'graph' | 'panel' | null>(null);

  /** A selectable graph entity can occur on either side of a pending relation. */
  function statementHasKey(st: Statement, key: string): boolean {
    return termKey(st.s) === key || termKey(st.o) === key;
  }

  /** Select from the GRAPH: highlight the entity's rows and bring the first one into view. */
  function selectFromGraph(key: string | null) {
    // The renderers emit null on deselect (clicking empty space). That is a real state, not a
    // missing one: it clears the highlight rather than leaving the last entity looking selected.
    selectionSource = key ? 'graph' : null;
    selected = key;
    focusedEdge = null;
  }

  $effect(() => {
    const key = selected;
    if (!key || selectionSource !== 'graph') return;

    /*
     * If the selected entity has nothing pending in the ACTIVE tab, look for it in the others and
     * switch. Otherwise selecting a node whose only pending fact is a deletion silently does
     * nothing, which reads as the feature being broken rather than as the tab being wrong.
     */
    const tabsWith: Tab[] = [];
    if (diff.entries.some((e) => statementHasKey(e.incoming, key))) tabsWith.push('incoming');
    if (pendingDeletions.some((st: Statement) => statementHasKey(st, key))) tabsWith.push('deletions');
    if (pendingMerges.some((st: Statement) => statementHasKey(st, key))) tabsWith.push('merges');
    if (tabsWith.length && !tabsWith.includes(activeTab)) activeTab = tabsWith[0];

    // After the tab (and therefore the list) has rendered.
    requestAnimationFrame(() => {
      const el = document.querySelector('.entry-focused');
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  });

  function focusStatement(st: Statement) {
    selectionSource = 'panel';
    const key = termKey(st.s);
    selected = key;
    focusedEdge = { s: termKey(st.s), o: termKey(st.o), p: st.p.value.split('/').pop() ?? st.p.value };
    focusKey = null; // retrigger even if the same node is focused twice
    requestAnimationFrame(() => { focusKey = key; });
  }

  /**
   * Keep the convenient "click anywhere on the card" graph focus without making the whole card
   * an interactive accessibility container. Review entries contain their own buttons and inputs;
   * nesting those inside a role=button wrapper produced an invalid control tree and let an inner
   * accept/refine click also fly the graph. Keyboard users get the adjacent native focus button.
   */
  function focusStatementFromCard(event: MouseEvent, st: Statement) {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest('button, a[href], input, select, textarea, summary, [role="button"], [contenteditable="true"]')
    ) return;
    focusStatement(st);
  }

  /** Attach pointer-only card chrome behavior without claiming the content container is a control. */
  function cardGraphFocus(node: HTMLElement, initialStatement: Statement) {
    let statement = initialStatement;
    const handleClick = (event: MouseEvent) => focusStatementFromCard(event, statement);
    node.addEventListener('click', handleClick);
    return {
      update(nextStatement: Statement) { statement = nextStatement; },
      destroy() { node.removeEventListener('click', handleClick); },
    };
  }

  function statementFocusLabel(st: Statement): string {
    return `Show ${labelFromIRI(st.s.value)} in the preview graph`;
  }

  /** Focus the preview graph on an arbitrary node key (called from the node search box). */
  function focusNode(key: string) {
    selectionSource = 'panel';
    selected = key;
    focusedEdge = null;
    focusKey = null;
    requestAnimationFrame(() => { focusKey = key; });
  }

  // ── Browse controls (F30: graph controls ported onto the preview pane) ────
  /*
   * ALL EIGHT LAYOUTS, the same set the main graph view offers (F30: graph controls ported onto
   * the preview pane). Review had four; a reviewer looking at the same graph should not have a
   * poorer set of ways to look at it than someone browsing it.
   *
   * Two are GUARDED, exactly as they are on the main view, because a chip that cannot do anything
   * is worse than an absent one — that is precisely how the "tree" chip read as broken while it
   * was working correctly on a graph with no hierarchy to draw.
   */
  const PREVIEW_LAYOUTS = ['force', 'focus', 'source', 'type', 'hub', 'timeline', 'order', 'hierarchy'] as const;
  type PreviewLayout = (typeof PREVIEW_LAYOUTS)[number];
  let previewLayout = $state<PreviewLayout>('force');
  let showPreviewLayoutMenu = $state(false);
  let showReviewDetailMenu = $state(false);
  /**
   * Layout options as data, so LAYOUT and DETAIL render as two matching dropdowns.
   *
   * Matt, 2026-08-28, after I fixed the wrong page twice: the detail control was crammed into the
   * panel header beside "2 pending changes · 27 not shown · ↻", where it read as a status line
   * rather than a control. It belongs next to layout, and layout should be a dropdown too.
   */
  const PREVIEW_LAYOUT_OPTIONS: { value: PreviewLayout; label: string; title: string; available?: () => boolean }[] = [
    { value: 'force', label: 'free', title: 'Free force layout' },
    { value: 'focus', label: 'focus', title: 'Focus the selected node and its neighbours' },
    { value: 'source', label: 'source', title: 'Cluster nodes by the source they came from',
      available: () => previewSourceCount > 1 },
    { value: 'type', label: 'type', title: 'Cluster nodes by entity type',
      available: () => previewEntityTypes.length > 0 },
    { value: 'hub', label: 'hub', title: 'Pull the most-connected hubs toward the centre' },
    { value: 'timeline', label: 'time', title: 'Lay nodes out left-to-right by date; undated nodes get a labelled lane rather than a fake date' },
    { value: 'order', label: 'arrange', title: 'Arrange nodes on a grid — pending subjects first' },
    { value: 'hierarchy', label: 'tree', title: 'Prerequisites above dependents, from skos:broader and kpred:depends-on' },
  ];
  const availablePreviewLayouts = $derived(PREVIEW_LAYOUT_OPTIONS.filter((l) => l.available?.() ?? true));

  /** Sources worth clustering by. Analysis output is not a source a reviewer is comparing. */
  const previewSourceCount = $derived(sources().filter((s) => s.kind !== 'analysis').length);
  /** Entity types actually present in the preview — clustering by type needs at least one. */
  const previewEntityTypes = $derived.by(() => {
    const t = new Set<string>();
    for (const st of previewStatements) {
      const ty = subjectTypes.get(st.s.value);
      if (ty) t.add(ty);
    }
    return [...t];
  });
  /**
   * The grid sequence for the "arrange" layout.
   *
   * buildOrderAnchors() returns NOTHING when nodeOrder is empty, so shipping this chip without
   * supplying an order would add a control that silently does nothing. Pending subjects come
   * first because they are what the reviewer is here for, then everything else by label, so the
   * grid is stable between renders instead of reshuffling on every recompute.
   */
  const previewNodeOrder = $derived.by(() => {
    const pendingFirst: string[] = [];
    const rest: string[] = [];
    const seen = new Set<string>();
    for (const st of previewStatements) {
      for (const term of [st.s, st.o]) {
        if (term.kind !== 'iri') continue;
        const k = termKey(term);
        if (seen.has(k)) continue;
        seen.add(k);
        (pendingKeys.has(k) ? pendingFirst : rest).push(k);
      }
    }
    return [...pendingFirst, ...rest.sort()];
  });
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
      // Work out the names this merge would otherwise destroy BEFORE mutating anything.
      // A losing rdfs:label is about to be rejected, and the dropped IRI is about to stop
      // existing — both are names the entity genuinely answered to, and both are what the
      // next import will arrive as. Preserving them as skos:altLabel is what stops the same
      // duplicate being merged by hand a second time. (kb:merge-synonyms)
      const rejectedIds = new Set(conflicts.map(c => c.rejectId));
      const survivingLabel = primaryLabelAfterMerge(keepIri, statements(), rejectedIds)
        ?? primaryLabelAfterMerge(dropVal, statements(), rejectedIds);
      const aliasValues = newAliasValues(keepIri, dropVal, statements(), survivingLabel);

      for (const st of toRedirect) {
        const patch: Partial<typeof st> = {};
        if (st.s.kind === 'iri' && st.s.value === dropVal) patch.s = keepNode;
        if (st.o.kind === 'iri' && st.o.value === dropVal) patch.o = keepNode;
        if (Object.keys(patch).length > 0) await updateStatement(st.id, patch);
      }
      for (const c of conflicts) {
        await setStatus(c.rejectId, 'rejected');
      }
      if (aliasValues.length > 0) {
        const donor = toRedirect[0];
        await addStatements(buildAliasStatements(
          keepIri,
          aliasValues,
          { g: donor?.g ?? { kind: 'iri', value: 'urn:kbase:source/manual' }, sourceId: donor?.sourceId ?? 'manual' },
          () => crypto.randomUUID(),
        ));
      }
      // Mark original merge suggestion as confirmed
      const mergeStmt = pendingMerges.find(m =>
        (m.s.kind === 'iri' && m.s.value === keepIri && m.o.kind === 'iri' && m.o.value === dropVal) ||
        (m.s.kind === 'iri' && m.s.value === dropVal && m.o.kind === 'iri' && m.o.value === keepIri)
      );
      if (mergeStmt) await setStatus(mergeStmt.id, 'confirmed');
      showMergeReview = false;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally { isProcessing = false; }
  }

  async function dismissMerge(id: string) { await setStatus(id, 'rejected'); }

  // ── Bulk actions ──────────────────────────────────────────────────────────
  async function acceptAll() {
    error = null; isProcessing = true;
    bulkResult = null;
    let accepted = 0, dismissed = 0, skippedPartial = 0, skippedKind = 0;
    try {
      for (const e of diff.entries) {
        // Partial facts (F32) must be filled individually — never bulk-confirm a '?'.
        if (e.incoming.needsObject) { skippedPartial++; continue; }

        // An exact duplicate is the SAME (s,p,o) in the SAME graph — byte-identical to a fact
        // already held. There is no decision in it: confirming adds nothing and rejecting loses
        // nothing, so making a human dismiss each one by hand is pure tax. `reinforces` is the
        // case that actually carries information (same claim, NEW source) and is confirmed below,
        // which is what records the extra citation.
        if (e.kind === 'duplicate') {
          await setStatus(e.incoming.id, 'rejected');
          dismissed++;
          continue;
        }

        if (e.kind === 'new' || e.kind === 'reinforces' || e.kind === 'synonym-reinforces') {
          await setStatus(e.incoming.id, 'confirmed');
          accepted++;
        } else {
          skippedKind++;
        }
      }
      // Say what happened, including when the answer is "nothing". A whole graph can consist of
      // partial facts — every code-review finding is a question with no object — and this button
      // then correctly confirms none of them while looking broken. Silence is the bug; refusing
      // to bulk-confirm a '?' is not.
      bulkResult = accepted > 0 || dismissed > 0
        ? [
            accepted ? `confirmed ${accepted}` : null,
            dismissed ? `dismissed ${dismissed} exact duplicate(s)` : null,
            skippedPartial ? `${skippedPartial} need an answer first` : null,
            skippedKind ? `${skippedKind} need a decision` : null,
          ].filter(Boolean).join(', ')
        : skippedPartial > 0
          ? `nothing to confirm — ${skippedPartial} partial fact(s) need an object before they can be accepted`
          : skippedKind > 0
            ? `nothing to confirm — ${skippedKind} entr(y/ies) are conflicts or refinements, which need a decision`
            : 'nothing pending';
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { isProcessing = false; setTimeout(() => (bulkResult = null), 8000); }
  }
  /**
   * SETTLE A CONTESTED DECISION IN ONE ACTION (Matt, 2026-08-21).
   *
   * "The current state is accept one fact then the other is a conflict with a second decision to
   * keep existing, which is a bit redundant." It is: picking a side IS rejecting the others, so
   * asking again is the same decision wearing a different hat. This confirms the chosen statement
   * and rejects every other side of the same conflict together, the way MergeReview already
   * resolves a predicate conflict with one pick.
   *
   * It does NOT quietly replace the reckoning path. Where two HUMAN-attested claims disagree
   * (escalate === 'stp') the tree's own rule stands — accept/reject discards the losing side's
   * reasoning — so the UI offers this pick and the reckoning side by side and says which is which.
   */
  let settlingDecision = $state<string | null>(null);
  async function settleConflict(sides: Statement[], keepId: string, decisionId: string) {
    if (settlingDecision) return;
    settlingDecision = decisionId;
    try {
      /*
       * THE PICK PAYS ITS OWN PRICE (Matt, 2026-09-02: "the single choice to approve one of those
       * facts should cascade down to other facts"). planOptionCascade adds the facts the winning
       * option was PRICED BY — the ones the UI has already shown as the cost of choosing it — so a
       * person is not shown a price, charged it, and then asked to pay it again fact by fact. It
       * deliberately does NOT settle a downstream decision: those are surfaced, never decided.
       */
      const plan = planOptionCascade(sides, keepId, statements());
      await setStatuses(plan
        ? cascadeWrites(plan)
        : sides.map((st) => ({ id: st.id, status: st.id === keepId ? 'confirmed' : 'rejected' })));
    } finally {
      settlingDecision = null;
    }
  }

  /**
   * An option's own words. A conflict side whose object is a LINK renders as a raw IRI otherwise —
   * "urn:kbase:concept/opt-lumenpath" is not a choice anybody can make.
   */
  function labelForTerm(o: Statement['o']): string {
    if (o.kind !== 'iri') return o.value.slice(0, 60);
    const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
    const lbl = statements().find((st) => st.s.value === o.value && st.p.value === RDFS_LABEL);
    return (lbl && lbl.o.kind === 'literal' ? lbl.o.value : o.value.split('/').pop() ?? o.value).slice(0, 60);
  }

  /** The plan for one option, computed for the PREVIEW so nothing is settled unseen. */
  function cascadeFor(sides: Statement[], keepId: string) {
    return planOptionCascade(sides, keepId, statements());
  }

  async function confirmDeletion(id: string) { await setStatus(id, 'rejected'); }
  async function keepStatement(id: string) { await setStatus(id, 'confirmed'); }

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
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function rejectAlignment(suggestion: AlignmentSuggestion) {
    suggestion.decision = 'rejected';
    alignResult = { ...alignResult! };
  }

  // ── URL query param helpers ─────────────────────────────────────────────
  //
  // These EDIT the existing URL rather than rebuilding the query string, so `?kb=` and the other
  // params survive. Rebuilding from a fresh URLSearchParams (as the main graph page does) silently
  // drops every param the rebuild does not know about — including the one naming the graph.
  function setViewParam(view: string | null) {
    const url = new URL(window.location.href);
    if (view) { url.searchParams.set('view', view); }
    else { url.searchParams.delete('view'); }
    replaceState(url, {});
  }

  /** Keep the chosen layout in the URL so a reload — forced or otherwise — comes back to it. */
  function setLayoutParam(next: PreviewLayout) {
    const url = new URL(window.location.href);
    if (next === 'force') url.searchParams.delete('layout');  // the default needs no param
    else url.searchParams.set('layout', next);
    replaceState(url, {});
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

    const layoutParam = params.get('layout');
    if (layoutParam && PREVIEW_LAYOUTS.includes(layoutParam as PreviewLayout)) {
      previewLayout = layoutParam as PreviewLayout;
    }
  });
</script>

<div class="review-layout" class:dragging={isDragging}>
  <!-- ── LEFT: Graph area ──────────────────────────────────────────────── -->
  <section
    class="graph-pane"
    data-graph-settled={graphMode !== 'preview' || previewStatements.length === 0 || graphSettled}
  >
    <!-- Graph mode bar -->
    <div class="graph-mode-bar">
      <button class="mode-btn" class:active={graphMode === 'preview'} aria-pressed={graphMode === 'preview'} onclick={() => { graphMode = 'preview'; setViewParam(null); }}>
        <span class="mode-lbl mono">preview</span>
        {#if totalPending > 0}<span class="mode-badge">{totalPending}</span>{/if}
      </button>
      <button class="mode-btn" class:active={graphMode === 'compare'} aria-pressed={graphMode === 'compare'} onclick={() => { graphMode = 'compare'; setViewParam('compare'); }}>
        <span class="mode-lbl mono">compare</span>
      </button>
      <button class="mode-btn" class:active={graphMode === 'overlay'} aria-pressed={graphMode === 'overlay'} onclick={() => { graphMode = 'overlay'; initOverlay(); setViewParam('overlay'); }}>
        <span class="mode-lbl mono">overlay</span>
      </button>
      <span class="mode-spacer"></span>
      {#if graphMode === 'preview'}
        <button class="mode-btn dim-toggle" class:active={!use2D} onclick={() => { graphSettled = false; use2D = !use2D; }}
          aria-pressed={!use2D}
          title="Switch between 2D and 3D">
          <span class="mode-lbl mono">{use2D ? '2D' : '3D'}</span>
        </button>
      {/if}
      {#if graphMode === 'overlay'}
        <button class="mode-btn dim-toggle" class:active={overlayViewIs3D} onclick={() => overlayViewIs3D = !overlayViewIs3D}
          aria-pressed={overlayViewIs3D}
          title="Switch between 2D and 3D">
          <span class="mode-lbl mono">{overlayViewIs3D ? '3D' : '2D'}</span>
        </button>
      {/if}
    </div>

    <!-- Browse controls (F30). ONE ROW: layout · detail · search.
         DETAIL renders in every graph mode because it filters the QUEUE, which is on screen in
         all three; LAYOUT and SEARCH only in preview, the one mode they steer. -->
    <div class="overlay-controls browse-controls">
      <div class="ov-row control-row">
        {#if graphMode === 'preview'}
          <Popover.Root bind:open={showPreviewLayoutMenu}>
            <Popover.Trigger>
              {#snippet child({ props })}
                <button {...props} class="chip" class:active={showPreviewLayoutMenu}
                  title={availablePreviewLayouts.find((l) => l.value === previewLayout)?.title}>
                  <span class="lbl mono">{availablePreviewLayouts.find((l) => l.value === previewLayout)?.label ?? previewLayout}</span>
                  <span class="arr mono">{showPreviewLayoutMenu ? '▲' : '▼'}</span>
                </button>
              {/snippet}
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content class="filter-popover" sideOffset={6}>
                {#each availablePreviewLayouts as l (l.value)}
                  <button class="chip small" class:active={previewLayout === l.value} title={l.title}
                    onclick={() => { previewLayout = l.value; setLayoutParam(previewLayout); showPreviewLayoutMenu = false; }}>
                    <span class="lbl mono">{l.label}</span>
                  </button>
                {/each}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        {/if}

        <Popover.Root bind:open={showReviewDetailMenu}>
          <Popover.Trigger>
            {#snippet child({ props })}
              <button {...props} class="chip" class:active={reviewDetail !== 'detailed' || showReviewDetailMenu}
                title={reviewLevel.title}>
                <span class="lbl mono">{reviewLevel.label}</span>
                <span class="arr mono">{showReviewDetailMenu ? '▲' : '▼'}</span>
              </button>
            {/snippet}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content class="filter-popover" sideOffset={6}>
              {#each REVIEW_DETAIL_LEVELS as level (level.id)}
                <button class="chip small" class:active={reviewDetail === level.id} title={level.title}
                  onclick={() => { reviewDetail = level.id; showReviewDetailMenu = false; }}>
                  <span class="lbl mono">{level.label}</span>
                </button>
              {/each}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>

        {#if graphMode === 'preview'}
          <div class="node-search-wrap">
            <input
              class="node-search-input mono"
              type="text"
              placeholder="find node…"
              aria-label="Find graph node"
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
        {/if}
        {#if hiddenLogCount > 0}
          <!-- Inline, not on a line of its own: it is a footnote to the detail control beside it,
               and a whole row for three words was the thing that made it look like a status bar. -->
          <span class="log-hidden mono" title="Hidden from this queue only. Every fact is still in the graph — lower the detail level to see them.">
            {hiddenLogCount} not shown
          </span>
        {/if}
      </div>
    </div>

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
            nodeOrder={previewNodeOrder}
            sources={sources()}
            onselect={(k) => selectFromGraph(k)}
            onhover={() => {}}
            onlabelsmove={() => {}}
            onmarkersmove={() => {}}
            onsettledchange={(settled) => { graphSettled = settled; }}
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
                onselect={(k) => selectFromGraph(k)}
                onhover={() => {}}
                onlabelsmove={(labels) => { nodeLabels = labels; }}
                onmarkersmove={() => {}}
                onsettledchange={(settled) => { graphSettled = settled; }}
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
        <GraphLabels labels={nodeLabels} {selected} onselect={(key) => selectFromGraph(key)} />
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
      <p class="rp-sub mono" data-testid="review-pending-count">
        {totalPending} pending change{totalPending !== 1 ? 's' : ''}
        {#if workspaceState() === 'connected'}
          <button class="drain-btn" onclick={checkPending} disabled={draining} title="Check workspace for pending MCP proposals">
            {draining ? '...' : drainResult ?? '↻'}
          </button>
        {/if}
      </p>
    </div>

    <!-- Tab bar -->
    <nav class="rp-tabs" aria-label="Review queue sections">
      <button class:active={activeTab === 'incoming'} aria-pressed={activeTab === 'incoming'} onclick={() => activeTab = 'incoming'}>
        incoming
        {#if diff.entries.length > 0}<span class="badge">{diff.entries.length}</span>{/if}
      </button>
      <button class:active={activeTab === 'deletions'} aria-pressed={activeTab === 'deletions'} onclick={() => activeTab = 'deletions'}>
        delete
        {#if pendingDeletions.length > 0}<span class="badge badge-danger">{pendingDeletions.length}</span>{/if}
      </button>
      <button class:active={activeTab === 'merges'} aria-pressed={activeTab === 'merges'} onclick={() => activeTab = 'merges'}>
        merge
        {#if pendingMerges.length > 0}<span class="badge badge-merge">{pendingMerges.length}</span>{/if}
      </button>
      <button class:active={activeTab === 'align'} aria-pressed={activeTab === 'align'} onclick={() => activeTab = 'align'}>
        align
        {#if alignPending > 0}<span class="badge badge-align">{alignPending}</span>{/if}
      </button>
    </nav>

    <!-- Tab content -->
    <div class="rp-content">
    <!--
      No {#key} wrapper here, deliberately.

      This block used to be keyed on a counter that every decision incremented, which destroyed and
      rebuilt all four tabs — list, summary chips, graph preview and scroll position — for a change
      affecting ONE row. That read as a full page reload after each confirm/reject.

      It was never needed. setStatus reassigns the _statements rune (kb.svelte.ts), so `incoming`,
      `existing` and `structuralDiff` are $derived and recompute on their own, and the $effect above
      re-runs to re-enrich the semantic diff. Svelte then updates only the entry that changed.
    -->

      {#if activeTab === 'incoming'}
        <!-- Summary chips -->
        <div class="summary">
          <span class="sc new">{diff.summary.new} new</span>
          <span class="sc reinforces">{diff.summary.reinforces} reinforce</span>
          <span class="sc conflict">{diff.summary.conflicts} conflict{diff.summary.conflicts === 1 ? '' : 's'} with graph</span>
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
                await setStatus(e.incoming.id, 'confirmed');
              }}
              onreject={async () => { await setStatus(e.incoming.id, 'rejected'); }}
            >
              <!-- Clicking a review card flies the preview graph to its node -->
              <!-- The native button below is the keyboard equivalent; the card action preserves
                   pointer focus on non-control card chrome without assigning a nested ARIA role. -->
              <div
                class="entry-focus-wrap"
                class:entry-focused={selected !== null && statementHasKey(e.incoming, selected)}
                use:cardGraphFocus={e.incoming}
              >
                <button
                  type="button"
                  class="entry-focus-action mono"
                  aria-label={statementFocusLabel(e.incoming)}
                  onclick={(event) => { event.stopPropagation(); focusStatement(e.incoming); }}
                ><span aria-hidden="true">⌖</span> show in graph</button>
                <!-- No onresolved handler: DiffEntry mutates statements through the store, and the
                     derived diff picks that up. It defaults to a no-op. -->
                <DiffEntry entry={e} sourceLabel={sourceLabel(e.incoming.sourceId)} />
              </div>
            </SwipeCard>
          {/snippet}

          <!-- F53/F83/F80.1 review-at-scale: an honest headline, then the contested few, then
               facts grouped into entity cards (decide about things, not rows). The per-fact
               confirm/reject controls are unchanged — nothing is hidden, only better ordered. -->
          <div class="ras-headline mono">{planHeadline}</div>
          <!-- F139: the same set read by ALTITUDE — what is a decision, and what is bookkeeping.
               Deliberately NOT .ras-headline: that class identifies the F53 pipeline headline and
               a second element carrying it makes every existing selector for it ambiguous. -->
          <div class="alt-headline mono" data-testid="altitude-headline">{treeHeadline}</div>

          <!-- F139 step 3 — the manual trigger. Right after the summary, because that is where a
               person has just read what the shape IS and can say what it should be instead. -->
          <div class="reanalyze" data-testid="reanalyze">
            <div class="reanalyze-row">
              <input
                class="reanalyze-input mono"
                type="text"
                bind:value={reanalysisInstruction}
                placeholder="re-analyze these pending facts — e.g. 'these are all about the March deploy, group them'"
                data-testid="reanalyze-input"
                disabled={reanalysisBusy || !semanticReady}
                onkeydown={(e) => { if (e.key === 'Enter') runPendingReanalysis(); }}
              />
              <button
                class="ghost-btn"
                onclick={runPendingReanalysis}
                disabled={reanalysisBusy || !semanticReady || !reanalysisInstruction.trim()}
                data-testid="reanalyze-run"
              >{reanalysisBusy ? 'analyzing...' : 're-analyze'}</button>
            </div>

            {#if reanalysisRun}
              {#if reanalysisRun.error}
                <div class="reanalyze-note mono err">{reanalysisRun.error}</div>
              {:else}
                <div class="reanalyze-note mono">{reanalysisSummary(reanalysisRun)}</div>
                {#each reanalysisRun.operations as op, i (i)}
                  <div class="reanalyze-op">
                    <span class="op-kind mono">{op.op}</span>
                    {#if op.op === 'group'}
                      <span class="op-what">{op.question} <span class="op-n">({op.factIds.length} facts)</span></span>
                    {:else if op.op === 'attach'}
                      <span class="op-what">{op.factIds.length} fact{op.factIds.length === 1 ? '' : 's'} under an open decision</span>
                    {:else if op.op === 'depend'}
                      <span class="op-what">settle one decision before another</span>
                    {:else}
                      <span class="op-what">{op.factIds.length} fact{op.factIds.length === 1 ? '' : 's'} flagged as noise</span>
                    {/if}
                    {#if op.because}<span class="op-why">{op.because}</span>{/if}
                  </div>
                {/each}
                <!-- Rejections are shown, never swallowed: a pass that ignored the instruction must
                     not look identical to one that followed it. -->
                {#if reanalysisRun.rejected.length}
                  <details class="reanalyze-rejected">
                    <summary class="mono">{reanalysisRun.rejected.length} proposal(s) rejected</summary>
                    {#each reanalysisRun.rejected as r, i (i)}<div class="rej-line">{r}</div>{/each}
                  </details>
                {/if}
                {#if reanalysisRun.operations.length}
                  <div class="reanalyze-note mono dim">Nothing has been applied. These are proposals about pending facts — the graph is untouched.</div>
                {/if}
              {/if}
            {/if}
          </div>

          {#if cascadeEffect}
            <div class="cascade-effect mono" role="status">{cascadeEffect}</div>
          {/if}

          <!-- F139.1 CASCADE LANE — aggregate the noise, ask ONE question, settle all of it.
               50 datetime stamps are not 50 decisions; they are one question about one day. -->
          {#if cascadeClusters.length > 0}
            <div class="cascade" data-testid="cascade-lane">
              <span class="cascade-h mono">{cascadeHeadline}</span>
              {#each cascadeClusters as cluster (cluster.id)}
                {@const purpose = needsPurposeQuestion(cluster, isPlannedSubject)}
                <div class="cascade-row" class:purpose>
                  <button
                    class="cascade-q"
                    onclick={() => (openCluster = openCluster === cluster.id ? null : cluster.id)}
                    aria-expanded={openCluster === cluster.id}
                  >
                    <span class="cascade-count mono">{cluster.members.length}</span>
                    <span class="cascade-text">{purpose ? purposeQuestion(cluster) : cluster.question}</span>
                    <span class="cascade-basis mono" class:guessed={!BASIS_META[cluster.basis].deterministic}>
                      {BASIS_META[cluster.basis].label}
                    </span>
                  </button>

                  {#if purpose}
                    <!-- Unplanned work cannot be settled yes/no: the missing information is a
                         REASON, not a truth value. The answer re-partitions the set (F139.1). -->
                    <div class="cascade-purpose mono">
                      This work is tied to no planned feature, so answering it in your own words
                      splits the set and labels each part. The purposes come from YOUR wording —
                      anything the model invents is dropped.
                    </div>
                    <div class="cascade-answer">
                      <textarea
                        class="cascade-answer-input mono"
                        rows="2"
                        bind:value={purposeAnswers[cluster.id]}
                        placeholder="e.g. 'half of this was the capture pipeline, the rest was fixing the workspace sync'"
                        disabled={cascadeBusy === cluster.id}
                        data-testid="purpose-answer"
                      ></textarea>
                      <button
                        class="cascade-yes"
                        disabled={cascadeBusy === cluster.id || !purposeAnswers[cluster.id]?.trim()}
                        onclick={() => settlePurpose(cluster)}
                      >{cascadeBusy === cluster.id ? 'sorting...' : `answer — settle all ${cluster.members.length}`}</button>
                    </div>
                    {#if purposeError && purposeErrorCluster === cluster.id}
                      <!-- Said out loud. A failure that reads as "nothing happened" is what stops
                           somebody answering the next one. -->
                      <div class="cascade-purpose-error mono">{purposeError}</div>
                    {/if}
                  {:else}
                    <div class="cascade-acts">
                      <button
                        class="cascade-yes"
                        disabled={cascadeBusy === cluster.id}
                        onclick={() => settleCluster(cluster, 'confirm')}
                      >yes — settle all {cluster.members.length}</button>
                      <button
                        class="cascade-no"
                        disabled={cascadeBusy === cluster.id}
                        onclick={() => settleCluster(cluster, 'reject')}
                      >no</button>
                    </div>
                  {/if}

                  {#if openCluster === cluster.id}
                    <ul class="cascade-members mono">
                      {#each cluster.members.slice(0, 40) as m (m.id)}
                        <li>
                          <span class="alt-chip alt-{altitudeOf(m)}">{altitudeOf(m)}</span>
                          {m.p.value.replace('urn:kbase:predicate/', 'kpred:')}
                          <span class="cm-obj">{m.o.value.slice(0, 90)}</span>
                        </li>
                      {/each}
                      {#if cluster.members.length > 40}
                        <li class="cm-more">… {cluster.members.length - 40} more</li>
                      {/if}
                    </ul>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

          <!-- F139 DECISION TREE — the open decisions, the options with their computed costs, and
               the case beneath each one. Records and logs are a count, never rows. -->
          {#if reviewTree.decisions.length > 0}
            <div class="dtree" data-testid="decision-tree">
              <span class="dtree-h mono">decisions — the only things here that are yours to settle</span>
              {#each reviewTree.decisions as d (d.question.id)}
                <div class="dnode" class:contested={d.contested}>
                  <div class="dnode-top">
                    <span class="alt-chip alt-decision">decision</span>
                    <span class="dnode-label">{d.label}</span>
                    {#if d.contested}
                      <span class="dflag contested-flag">contested</span>
                    {/if}
                    {#if d.impliedBy === 'conflict'}
                      <span class="dflag implied">nobody asked it</span>
                    {/if}
                    {#if d.escalate === 'stp'}
                      <span class="dflag stp">needs a reckoning</span>
                    {/if}
                    {#if d.status}<span class="dstat mono">{d.status}</span>{/if}
                    {#if d.unlocks}<span class="dstat mono">unlocks {d.unlocks}</span>{/if}
                  </div>

                  <p class="dquestion">{questionText(d)}</p>

                  {#if d.conflictSides && d.conflictSides.length > 1}
                    <!-- One pick settles the whole conflict: the chosen side is confirmed and every
                         other side rejected, instead of accepting one fact and meeting the next as
                         a fresh decision. -->
                    <div class="dpick" data-testid="decision-pick">
                      <span class="dpick-h mono">which holds?</span>
                      {#each d.conflictSides as side (side.id)}
                        {@const plan = cascadeFor(d.conflictSides!, side.id)}
                        <button
                          class="dpick-btn"
                          disabled={settlingDecision !== null}
                          onclick={() => settleConflict(d.conflictSides!, side.id, d.question.id)}
                          title={plan?.summary ?? 'Confirm this one and reject the others'}
                        >
                          <span class="dpick-val">{labelForTerm(side.o)}</span>
                          <span class="dpick-src mono">{sourceLabel(side.sourceId)}</span>
                          <!-- WHAT THIS PICK COSTS, ON THE CONTROL THAT SPENDS IT. A cascade that
                               settles facts the person never saw named is the laundering the
                               validator elsewhere in this codebase exists to prevent. -->
                          {#if plan}
                            <span class="dpick-cascade mono">
                              {#if plan.effects.length}
                                also rejects {plan.effects.length}
                              {:else}
                                nothing else
                              {/if}
                              {#each plan.downstream as ds}
                                · {ds.effect === 'mooted' ? 'retires' : 'opens'} “{ds.label}”
                              {/each}
                            </span>
                          {/if}
                        </button>
                      {/each}
                    </div>
                    <p class="dnote mono">
                      Picking one confirms it, rejects the other{d.conflictSides.length > 2 ? 's' : ''}, and rejects the facts that option was priced by — one action, not several. A decision beneath it is surfaced, never settled for you.
                      {#if d.escalate === 'stp'}
                        Both sides are human-attested, so a pick DISCARDS the losing side's reasoning; a reckoning keeps both and supersedes them.
                      {/if}
                    </p>
                  {/if}

                  {#if d.options.length > 0}
                    <div class="dopts">
                      {#each d.options as o (o.iri)}
                        <div class="dopt">
                          <span class="dopt-label">{o.label}</span>
                          <span class="dopt-cost mono">costs {o.rulesOut.length} fact{o.rulesOut.length === 1 ? '' : 's'}</span>
                          <ul class="dopt-kills">
                            {#each o.rulesOut as k (k.id)}
                              <li>{labelForIri(k.s.value)}</li>
                            {/each}
                          </ul>
                        </div>
                      {/each}
                    </div>
                    <p class="dnote mono">Each option is priced by the facts it would delete — computed from the graph, not described.</p>
                  {:else}
                    <p class="dnote mono">
                      No options modelled yet, so there is nothing to weigh side by side.
                      {#if d.escalate === 'stp'}Two attested claims disagree, and no check settles that — accept/reject would discard the reasoning.{/if}
                    </p>
                  {/if}

                  <button
                    class="dexpand mono"
                    onclick={() => (openDecision = openDecision === d.question.id ? null : d.question.id)}
                    aria-expanded={openDecision === d.question.id}
                  >
                    {d.standing.length} standing · {d.judgments.length} judgments · {d.evidence.length} evidence · ⌄ {d.hidden.length} hidden
                  </button>

                  {#if openDecision === d.question.id}
                    <div class="dcase">
                      {#each [['decision', d.standing], ['judgment', d.judgments], ['evidence', d.evidence], ['record', d.hidden]] as [kind, list]}
                        {#if (list as typeof d.standing).length > 0}
                          <ul class="dcase-list mono">
                            {#each (list as typeof d.standing).slice(0, 12) as f (f.id)}
                              <li>
                                <span class="alt-chip alt-{kind}">{kind === 'record' ? 'hidden' : kind}</span>
                                <span class="dcase-obj">{f.o.value.slice(0, 130)}</span>
                              </li>
                            {/each}
                            {#if (list as typeof d.standing).length > 12}
                              <li class="cm-more">… {(list as typeof d.standing).length - 12} more</li>
                            {/if}
                          </ul>
                        {/if}
                      {/each}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

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
            {#if bulkResult}<p class="bulk-result mono">{bulkResult}</p>{/if}
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
                  class:entry-focused={selected !== null && statementHasKey(st, selected)}
                  use:cardGraphFocus={st}
                >
                  <button
                    type="button"
                    class="entry-focus-action mono"
                    aria-label={statementFocusLabel(st)}
                    onclick={(event) => { event.stopPropagation(); focusStatement(st); }}
                  ><span aria-hidden="true">⌖</span> show in graph</button>
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
                  class:entry-focused={selected !== null && statementHasKey(st, selected)}
                  use:cardGraphFocus={st}
                >
                  <button
                    type="button"
                    class="entry-focus-action mono"
                    aria-label={statementFocusLabel(st)}
                    onclick={(event) => { event.stopPropagation(); focusStatement(st); }}
                  ><span aria-hidden="true">⌖</span> show in graph</button>
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
                    class:entry-focused={selected !== null && statementHasKey(suggestion.statement, selected)}
                    use:cardGraphFocus={suggestion.statement}
                  >
                    <button
                      type="button"
                      class="entry-focus-action mono"
                      aria-label={statementFocusLabel(suggestion.statement)}
                      onclick={(event) => { event.stopPropagation(); focusStatement(suggestion.statement); }}
                    ><span aria-hidden="true">⌖</span> show in graph</button>
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
    z-index: 30;
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
  .entry-focus-action {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    min-height: 30px;
    margin: 0 0 0.35rem 0.4rem;
    padding: 0.2rem 0.55rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface);
    color: var(--muted);
    font-size: 0.62rem;
    cursor: pointer;
  }
  .entry-focus-action:hover,
  .entry-focus-action:focus-visible {
    border-color: var(--accent);
    color: var(--accent);
  }
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
    position: relative;
    z-index: 30;
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

  /* ── Browse controls (F30: layout + detail dropdowns, node search on the preview) ── */
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
  .log-hidden {
    opacity: 0.6;
    font-size: 0.75rem;
  }

  .cascade-answer {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
    margin-top: 0.4rem;
  }
  .cascade-answer-input {
    flex: 1;
    min-width: 0;
    resize: vertical;
    padding: 0.4rem 0.5rem;
    font-size: 0.8rem;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .cascade-answer-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .cascade-purpose-error {
    margin-top: 0.35rem;
    font-size: 0.75rem;
    color: var(--accent);
  }

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
  .bulk-result { color: var(--text-muted); font-size: 0.7rem; margin: 0; }

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
  /* ── F139 decision tree ───────────────────────────────────────────────────── */
  .dtree { display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 0.85rem; }
  .dtree-h {
    font-size: 0.68rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .dnode {
    border: 1px solid var(--accent);
    border-left-width: 3px;
    border-radius: 3px;
    background: var(--surface);
    padding: 0.65rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  /* A live disagreement is the one thing that must never look like routine work. */
  .dpick { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; margin: 0.35rem 0; }
  .dpick-h { font-size: 0.7rem; color: var(--text-dim); text-transform: uppercase; }
  .dpick-btn {
    display: flex; flex-direction: column; align-items: flex-start; gap: 0.1rem;
    padding: 0.3rem 0.55rem; border: 1px solid var(--border); border-radius: 4px;
    background: var(--surface-2); color: var(--text); cursor: pointer; text-align: left;
  }
  .dpick-btn:hover:not(:disabled) { border-color: var(--accent); }
  .dpick-btn:disabled { opacity: 0.5; cursor: default; }
  .dpick-val { font-size: 0.82rem; }
  .dpick-src { font-size: 0.66rem; color: var(--text-dim); }
  /* The cost of the pick, on the control that spends it. Dim rather than loud: it must be
     readable before committing without competing with the option's own name. */
  .dpick-cascade {
    font-size: 0.62rem;
    color: var(--text-dim);
    display: block;
    margin-top: 0.15rem;
    line-height: 1.35;
  }

  .dnode.contested { border-left-color: var(--danger); }

  .dnode-top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem; }
  .dnode-label { font-size: 0.9rem; font-weight: 600; color: var(--ink); }
  .dflag {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    border: 1px solid currentColor;
    border-radius: 2px;
    padding: 0 0.25rem;
  }
  .contested-flag { color: var(--danger); }
  .implied { color: var(--muted); }
  .stp { color: var(--accent); }
  .dstat { font-size: 0.62rem; color: var(--muted); }

  .dquestion { margin: 0; font-size: 0.85rem; line-height: 1.5; color: var(--ink); }

  .dopts { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .dopt {
    flex: 1 1 14rem;
    border: 1px solid var(--surface-2, var(--surface));
    border-top: 2px solid var(--ok);
    border-radius: 3px;
    padding: 0.45rem 0.55rem;
    background: var(--bg);
  }
  .dopt-label { display: block; font-size: 0.82rem; font-weight: 600; color: var(--ink); }
  .dopt-cost { display: block; font-size: 0.65rem; color: var(--ok); margin-top: 0.1rem; }
  .dopt-kills {
    list-style: none;
    margin: 0.35rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    font-size: 0.68rem;
    color: var(--muted);
  }
  .dopt-kills li::before { content: "✗ "; color: var(--danger); }

  .dnote { font-size: 0.66rem; color: var(--muted); margin: 0; line-height: 1.5; }

  .dexpand {
    align-self: flex-start;
    background: none;
    border: 1px solid var(--muted);
    border-radius: 2px;
    color: var(--muted);
    font-size: 0.64rem;
    padding: 0.15rem 0.4rem;
    cursor: pointer;
  }
  .dexpand:hover { color: var(--accent); border-color: var(--accent); }

  .dcase { display: flex; flex-direction: column; gap: 0.3rem; }
  .dcase-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.12rem;
    font-size: 0.66rem;
  }
  .dcase-list li { display: flex; gap: 0.35rem; align-items: baseline; }
  .dcase-obj { color: var(--ink); opacity: 0.8; }

  /* ── F139 step 3: freeform re-analysis prompt ─────────────────────────────── */
  .reanalyze { margin: 0.5rem 0 0.75rem; display: flex; flex-direction: column; gap: 0.4rem; }
  .reanalyze-row { display: flex; gap: 0.5rem; align-items: center; }
  .reanalyze-input {
    flex: 1; min-width: 0; padding: 0.45rem 0.6rem;
    background: var(--surface-2); color: var(--text);
    border: 1px solid var(--border); border-radius: 4px; font-size: 0.8rem;
  }
  .reanalyze-input:focus { outline: none; border-color: var(--accent); }
  .reanalyze-note { font-size: 0.75rem; color: var(--accent); }
  .reanalyze-note.err { color: var(--danger, #e06c75); }
  .reanalyze-note.dim { color: var(--text-dim); }
  .reanalyze-op {
    display: flex; gap: 0.5rem; align-items: baseline; flex-wrap: wrap;
    font-size: 0.78rem; padding: 0.25rem 0.5rem;
    background: var(--surface-2); border-left: 2px solid var(--accent); border-radius: 3px;
  }
  .op-kind { text-transform: uppercase; font-size: 0.68rem; color: var(--accent); }
  .op-n { color: var(--text-dim); }
  .op-why { color: var(--text-dim); font-size: 0.72rem; }
  .reanalyze-rejected { font-size: 0.72rem; color: var(--text-dim); }
  .reanalyze-rejected .rej-line { padding: 0.15rem 0 0.15rem 0.75rem; }

  /* ── F139 altitude headline + F139.1 cascade lane ────────────────────────── */
  .alt-headline {
    font-size: 0.7rem;
    color: var(--muted);
    margin-bottom: 0.5rem;
    line-height: 1.5;
  }

  .cascade-effect {
    font-size: 0.72rem;
    color: var(--ok);
    border: 1px solid var(--ok);
    background: color-mix(in srgb, var(--ok) 8%, transparent);
    border-radius: 3px;
    padding: 0.4rem 0.6rem;
    margin-bottom: 0.5rem;
  }

  .cascade {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    border: 1px solid var(--accent);
    border-radius: 4px;
    padding: 0.6rem;
    margin-bottom: 0.75rem;
    background: var(--accent-soft);
  }
  .cascade-h {
    font-size: 0.68rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .cascade-row {
    border: 1px solid var(--surface-2, var(--surface));
    border-radius: 3px;
    background: var(--surface);
    padding: 0.45rem 0.55rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  /* An unplanned-work question is a different KIND of question — it wants prose, not yes/no. */
  .cascade-row.purpose { border-left: 2px solid var(--danger); }

  .cascade-q {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    background: none;
    border: 0;
    padding: 0;
    text-align: left;
    color: var(--ink);
    cursor: pointer;
    font: inherit;
    width: 100%;
  }
  .cascade-q:hover .cascade-text { text-decoration: underline; }
  .cascade-count {
    flex: 0 0 auto;
    font-size: 0.7rem;
    font-weight: 700;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 2px;
    padding: 0.05rem 0.3rem;
    font-variant-numeric: tabular-nums;
  }
  .cascade-text { flex: 1 1 auto; font-size: 0.85rem; }
  .cascade-basis { flex: 0 0 auto; font-size: 0.64rem; color: var(--muted); }
  /* A grouping a model guessed must never look like one a script computed. */
  .cascade-basis.guessed { color: var(--danger); }

  .cascade-acts { display: flex; gap: 0.4rem; }
  .cascade-acts button {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    padding: 0.22rem 0.5rem;
    border-radius: 2px;
    cursor: pointer;
    background: none;
  }
  .cascade-yes { border: 1px solid var(--ok); color: var(--ok); }
  .cascade-no { border: 1px solid var(--muted); color: var(--muted); }
  .cascade-acts button:disabled { opacity: 0.5; cursor: default; }

  .cascade-purpose { font-size: 0.7rem; color: var(--muted); line-height: 1.5; }

  .cascade-members {
    list-style: none;
    margin: 0;
    padding: 0.3rem 0 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    max-height: 14rem;
    overflow-y: auto;
    font-size: 0.66rem;
    color: var(--muted);
  }
  .cascade-members li { display: flex; gap: 0.35rem; align-items: baseline; }
  .cm-obj { color: var(--ink); opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cm-more { color: var(--muted); font-style: italic; }

  /* The altitude scale — one colour set, so it reads the same everywhere it appears. */
  /* Chip + popover, copied verbatim from the graph view (Matt: "I like the previews dropdown
     styling much better"). Duplicated rather than shared because these are two independent
     Svelte components with their own scoped styles — if a third surface needs them, that is the
     point to extract a component rather than paste a third time. */
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
  .chip:hover { border-color: var(--muted-2); color: var(--ink-2); }
  .chip.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }
  .chip.small { font-size: 0.68rem; padding: 0.2rem 0.55rem; }
  .chip .lbl { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.14em; }
  .chip .arr { font-size: 0.5rem; opacity: 0.6; }

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

  /* One row: layout · detail · search. Each control is sized to its own content — stretching
     a dropdown to fill the row makes a five-character value look like a text field, and it was
     what pushed the search onto a line of its own. */
  .control-row {
    display: flex;
    gap: 0.4rem;
    align-items: flex-end;
    flex-wrap: nowrap;
  }
  .control {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    flex: 0 0 auto;
  }
  .control-select {
    background: var(--surface);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 0.25rem;
    font-size: 0.62rem;
    padding: 0.2rem 0.25rem;
    width: auto;
  }
  /* The search takes whatever is left, because it is the only one whose content is unbounded. */
  .control-row .node-search-wrap { flex: 1 1 auto; min-width: 0; }
  /* The hidden count rides at the end of the same row, sized to its text. */
  .control-row .log-hidden { flex: 0 0 auto; white-space: nowrap; align-self: center; }

  .review-detail {
    background: var(--surface);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 0.25rem;
    font-size: 0.6rem;
    padding: 0.1rem 0.25rem;
    margin-left: 0.4rem;
  }

  .alt-chip {
    flex: 0 0 auto;
    font-size: 0.58rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border: 1px solid currentColor;
    border-radius: 2px;
    padding: 0 0.22rem;
  }
  .alt-decision { color: var(--accent); }
  .alt-judgment { color: #d9a94a; }
  .alt-evidence { color: var(--ok); }
  .alt-record { color: var(--muted); }
  .alt-log { color: var(--muted); opacity: 0.7; }

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
  .empty-state a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    padding: 0 0.5rem;
  }

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
      flex: 0 0 min(45dvh, 360px);
      height: auto;
      min-height: 260px;
      overflow: hidden;
    }
    .resize-handle {
      display: none;
    }
    .review-panel {
      width: 100% !important;
      max-width: none;
      min-width: 0;
      border-top: 1px solid var(--line);
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
    }
    .rp-content {
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding-bottom: calc(0.75rem + var(--app-nav-clearance));
    }
    .mode-btn,
    :global(.review-layout .tg-chip),
    .node-search-input,
    .node-search-row,
    .rp-tabs button,
    .gc,
    .ghost-btn,
    .reanalyze-input,
    .bulk-btn,
    .group-toggle {
      /* A 45px box remains above 44px after the app's narrow-screen scale. */
      min-height: 45px;
      min-width: 44px;
    }
    .entry-focus-action {
      min-height: 45px;
      min-width: 44px;
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
