<script lang="ts">
  import DiffEntry from '$lib/components/DiffEntry.svelte';
  import StatementCard from '$lib/components/StatementCard.svelte';
  import SwipeCard from '$lib/components/SwipeCard.svelte';
  import CalendarGrid from '$lib/components/CalendarGrid.svelte';
  import {
    statements,
    sources,
    pendingStatements,
    pendingRemovalStatements,
    pendingMergeStatements,
    setStatus,
    updateStatement,
    addStatements
  } from '$lib/stores/kb.svelte';
  import { computeDiff } from '$lib/rdf/diff';
  import { generateDiffSummary, type DiffSummary } from '$lib/rdf/diff-summary';
  import { settings } from '$lib/stores/settings.svelte';
  import { semanticEnrichDiff } from '$lib/rdf/semantic-diff';
  import { expandRRule } from '$lib/rdf/recurrence';
  import { v4 as uuid } from 'uuid';

  type Tab = 'incoming' | 'deletions' | 'merges' | 'upcoming';
  let activeTab = $state<Tab>('incoming');

  // ── Upcoming calendar tab ────────��──────────────────────────────────────────
  type ViewMode = 'month' | 'week' | 'day';
  let calViewMode = $state<ViewMode>('week');
  let calCurrentDate = $state(new Date());

  type CalEvent = {
    id: string;
    title: string;
    start: Date;
    end?: Date;
    source?: string;
    conflict?: boolean;
    inKb?: boolean;
    recurring?: boolean;
    recurrencePattern?: string;
  };

  const P = 'urn:kbase:predicate/';
  const M = 'urn:kbase:meta/';

  // Hard limits for recurrence expansion
  const MAX_RECURRENCE_HORIZON_DAYS = 365;
  const MAX_OCCURRENCES_PER_EVENT = 52;

  type CalFilter = 'all' | 'single' | 'recurring' | 'conflicts';
  let calFilter = $state<CalFilter>('all');

  /** Extract confirmed calendar events from KB statements, expanding recurring events */
  const upcomingEvents = $derived.by(() => {
    const confirmed = statements().filter(
      s => s.status === 'confirmed' || s.status === 'refined'
    );
    // Find all entities with a scheduled-at predicate (check both meta/ and predicate/ namespaces)
    const scheduledStmts = confirmed.filter(
      s => s.p.value === `${M}scheduled-at` || s.p.value === `${P}scheduled-at`
    );
    const events: CalEvent[] = [];

    // Helper to find a literal value for a subject + predicate
    const findLiteral = (subjectIri: string, ...predicates: string[]): string | null => {
      for (const pred of predicates) {
        const s = confirmed.find(
          st => st.s.kind === 'iri' && st.s.value === subjectIri && st.p.value === pred
        );
        if (s && s.o.kind === 'literal') return s.o.value;
      }
      return null;
    };

    for (const st of scheduledStmts) {
      const subjectIri = st.s.kind === 'iri' ? st.s.value : '';
      if (!subjectIri) continue;
      const startStr = st.o.kind === 'literal' ? st.o.value : '';
      if (!startStr) continue;
      const start = new Date(startStr);
      if (isNaN(start.getTime())) continue;

      const title = findLiteral(subjectIri, 'http://www.w3.org/2000/01/rdf-schema#label')
        ?? subjectIri.split('/').pop() ?? 'Event';

      const endStr = findLiteral(subjectIri, `${M}ends-at`, `${P}ends-at`);
      let end: Date | undefined;
      if (endStr) {
        const d = new Date(endStr);
        if (!isNaN(d.getTime())) end = d;
      }
      const duration = end ? end.getTime() - start.getTime() : 0;

      // Check for recurrence rule
      const rrule = findLiteral(subjectIri, `${M}recurrence-rule`);
      const pattern = findLiteral(subjectIri, `${M}recurrence-pattern`);

      if (rrule) {
        // Expand into individual occurrences
        const now = new Date();
        const windowStart = new Date(Math.min(start.getTime(), now.getTime()));
        const horizon = new Date(now.getTime() + MAX_RECURRENCE_HORIZON_DAYS * 24 * 60 * 60 * 1000);
        const occurrences = expandRRule(rrule, start, windowStart, horizon, undefined, MAX_OCCURRENCES_PER_EVENT);

        for (let i = 0; i < occurrences.length; i++) {
          const occStart = occurrences[i];
          const occEnd = duration > 0 ? new Date(occStart.getTime() + duration) : undefined;
          events.push({
            id: `${subjectIri}__occ${i}`,
            title,
            start: occStart,
            end: occEnd,
            inKb: true,
            recurring: true,
            recurrencePattern: pattern ?? undefined
          });
        }
      } else {
        // Non-recurring event — add as single occurrence
        events.push({ id: subjectIri, title, start, end, inKb: true });
      }
    }
    return events;
  });

  /** Detect conflicts — events overlapping in time */
  const eventsWithConflicts = $derived.by(() => {
    const evs = [...upcomingEvents];
    for (let i = 0; i < evs.length; i++) {
      const a = evs[i];
      const aEnd = a.end ?? new Date(a.start.getTime() + 3600000); // default 1hr
      for (let j = i + 1; j < evs.length; j++) {
        const b = evs[j];
        const bEnd = b.end ?? new Date(b.start.getTime() + 3600000);
        // Overlap: a starts before b ends AND b starts before a ends
        if (a.start < bEnd && b.start < aEnd) {
          evs[i] = { ...evs[i], conflict: true };
          evs[j] = { ...evs[j], conflict: true };
        }
      }
    }
    return evs;
  });

  const conflictCount = $derived(eventsWithConflicts.filter(e => e.conflict).length);
  const recurringCount = $derived(eventsWithConflicts.filter(e => e.recurring).length);
  const singleCount = $derived(eventsWithConflicts.filter(e => !e.recurring).length);

  // Unique recurrence patterns for the legend
  const recurrencePatterns = $derived.by(() => {
    const patterns = new Map<string, number>();
    for (const ev of eventsWithConflicts) {
      if (ev.recurring && ev.recurrencePattern) {
        patterns.set(ev.recurrencePattern, (patterns.get(ev.recurrencePattern) ?? 0) + 1);
      }
    }
    return patterns;
  });

  const filteredEvents = $derived.by(() => {
    switch (calFilter) {
      case 'single': return eventsWithConflicts.filter(e => !e.recurring);
      case 'recurring': return eventsWithConflicts.filter(e => e.recurring);
      case 'conflicts': return eventsWithConflicts.filter(e => e.conflict);
      default: return eventsWithConflicts;
    }
  });

  function navCalendar(delta: number) {
    const d = new Date(calCurrentDate);
    if (calViewMode === 'month') d.setMonth(d.getMonth() + delta);
    else if (calViewMode === 'week') d.setDate(d.getDate() + delta * 7);
    else d.setDate(d.getDate() + delta);
    calCurrentDate = d;
  }

  const incoming = $derived(pendingStatements());
  const pendingDeletions = $derived(pendingRemovalStatements());
  const pendingMerges = $derived(pendingMergeStatements());

  const existing = $derived(
    statements().filter(
      (s) => s.status !== 'pending' && s.status !== 'rejected' &&
             s.status !== 'superseded' && s.status !== 'pending-removal'
    )
  );

  // Structural diff — computed synchronously for immediate display.
  const structuralDiff = $derived(computeDiff(incoming, existing));

  // Semantic diff — upgraded asynchronously. Falls back to structural while loading.
  let semanticDiff = $state<ReturnType<typeof computeDiff> | null>(null);
  let semanticAnalyzing = $state(false);
  let semanticVersion = 0; // non-reactive version counter to cancel stale runs
  let semanticFailed = false; // non-reactive: don't retry after embedder failure

  const diff = $derived(semanticDiff ?? structuralDiff);

  $effect(() => {
    const inc = incoming;
    const ex = existing;
    const sDiff = computeDiff(inc, ex);
    const myVersion = ++semanticVersion;

    if (sDiff.entries.length === 0) {
      semanticDiff = null;
      semanticAnalyzing = false;
      return;
    }

    // Don't retry if the embedder already failed (ort-web crash)
    if (semanticFailed) return;

    semanticAnalyzing = true;
    semanticDiff = null;

    semanticEnrichDiff(sDiff, ex).then(enriched => {
      if (myVersion === semanticVersion) {
        semanticDiff = enriched;
        semanticAnalyzing = false;
      }
    }).catch(() => {
      semanticFailed = true;
      if (myVersion === semanticVersion) semanticAnalyzing = false;
    });
  });

  let bumpKey = $state(0);
  let isProcessing = $state(false);
  let error = $state<string | null>(null);

  // ── Diff summary ─────────────────────────────────────────────────────────
  let diffSummary = $state<DiffSummary | null>(null);
  let summaryLoading = $state(false);

  async function loadSummary() {
    summaryLoading = true;
    try {
      diffSummary = await generateDiffSummary(diff, settings());
    } catch { /* fallback handled internally */ }
    finally { summaryLoading = false; }
  }

  function refresh() { bumpKey++; }

  /** Source label for provenance display */
  function sourceLabel(sourceId: string): string {
    const src = sources().find(s => s.id === sourceId);
    if (!src) return sourceId;
    return src.title;
  }

  async function acceptAll() {
    error = null;
    isProcessing = true;
    try {
      for (const e of diff.entries) {
        if (e.kind === 'new' || e.kind === 'reinforces' || e.kind === 'synonym-reinforces') {
          await setStatus(e.incoming.id, 'confirmed');
        }
      }
      refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      isProcessing = false;
    }
  }

  // ── Deletion actions ──────────────────────────────────────────────────────
  async function confirmDeletion(id: string) {
    await setStatus(id, 'rejected');
    refresh();
  }
  async function keepStatement(id: string) {
    await setStatus(id, 'confirmed');
    refresh();
  }

  // ── Merge actions ─────────────────────────────────────────────────────────
  async function executeMerge(mergeStmt: ReturnType<typeof pendingMergeStatements>[number]) {
    const keepIri = mergeStmt.s.kind === 'iri' ? mergeStmt.s.value : '';
    const dropIri = mergeStmt.o.kind === 'iri' ? mergeStmt.o.value : '';
    if (!keepIri || !dropIri) return;

    isProcessing = true;
    try {
      const keepNode = { kind: 'iri' as const, value: keepIri };
      const toRedirect = statements().filter(
        s => (s.s.kind === 'iri' && s.s.value === dropIri ||
              s.o.kind === 'iri' && s.o.value === dropIri) &&
             s.status !== 'rejected' && s.status !== 'superseded'
      );
      for (const st of toRedirect) {
        const patch: Partial<typeof st> = {};
        if (st.s.kind === 'iri' && st.s.value === dropIri) patch.s = keepNode;
        if (st.o.kind === 'iri' && st.o.value === dropIri) patch.o = keepNode;
        if (Object.keys(patch).length > 0) await updateStatement(st.id, patch);
      }
      await setStatus(mergeStmt.id, 'confirmed');
      refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      isProcessing = false;
    }
  }

  async function dismissMerge(id: string) {
    await setStatus(id, 'rejected');
    refresh();
  }
</script>

<header class="head">
  <p class="kicker mono">review</p>
  <h1>pending changes</h1>
  <p class="sub">review all unconfirmed statements, suggested deletions, and proposed merges</p>
</header>

<!-- Tab bar -->
<nav class="tabs">
  <button class:active={activeTab === 'incoming'} onclick={() => (activeTab = 'incoming')}>
    incoming
    {#if diff.entries.length > 0}<span class="badge">{diff.entries.length}</span>{/if}
  </button>
  <button class:active={activeTab === 'deletions'} onclick={() => (activeTab = 'deletions')}>
    deletions
    {#if pendingDeletions.length > 0}<span class="badge badge-danger">{pendingDeletions.length}</span>{/if}
  </button>
  <button class:active={activeTab === 'merges'} onclick={() => (activeTab = 'merges')}>
    merges
    {#if pendingMerges.length > 0}<span class="badge badge-merge">{pendingMerges.length}</span>{/if}
  </button>
  <button class:active={activeTab === 'upcoming'} onclick={() => (activeTab = 'upcoming')}>
    upcoming
    {#if conflictCount > 0}<span class="badge badge-danger">{conflictCount}</span>{/if}
  </button>
</nav>

{#key bumpKey}

  <!-- ── Incoming tab ── -->
  {#if activeTab === 'incoming'}
    <section class="summary">
      <span class="chip new">{diff.summary.new} new</span>
      <span class="chip reinforces">{diff.summary.reinforces} reinforce</span>
      <span class="chip refines">{diff.summary.refines} refine</span>
      <span class="chip conflict">{diff.summary.conflicts} conflict</span>
      <span class="chip duplicate">{diff.summary.duplicate} duplicate</span>
      {#if diff.summary.nearDuplicate > 0}
        <span class="chip near-dup">{diff.summary.nearDuplicate} near-duplicate</span>
      {/if}
      {#if diff.summary.synonymReinforces > 0}
        <span class="chip synonym">{diff.summary.synonymReinforces} synonym</span>
      {/if}
      {#if diff.summary.antonymConflicts > 0}
        <span class="chip antonym">{diff.summary.antonymConflicts} contradiction</span>
      {/if}
      {#if semanticAnalyzing}
        <span class="chip analyzing">analyzing…</span>
      {/if}
    </section>

    {#if diffSummary}
      <div class="diff-summary-cards">
        {#if diffSummary.newSummary && diffSummary.newSummary !== 'None.'}
          <div class="ds-card ds-new">
            <h4 class="ds-heading mono">new information</h4>
            <p>{diffSummary.newSummary}</p>
          </div>
        {/if}
        {#if diffSummary.reinforcingSummary && diffSummary.reinforcingSummary !== 'None.'}
          <div class="ds-card ds-reinforce">
            <h4 class="ds-heading mono">reinforcing</h4>
            <p>{diffSummary.reinforcingSummary}</p>
          </div>
        {/if}
        {#if diffSummary.conflictingSummary && diffSummary.conflictingSummary !== 'None.'}
          <div class="ds-card ds-conflict">
            <h4 class="ds-heading mono">conflicts &amp; refinements</h4>
            <p>{diffSummary.conflictingSummary}</p>
          </div>
        {/if}
      </div>
    {:else if diff.entries.length > 0}
      <button class="ghost summary-btn" onclick={loadSummary} disabled={summaryLoading}>
        {summaryLoading ? 'summarizing…' : 'summarize changes'}
      </button>
    {/if}

    {#if diff.entries.length === 0}
      <div class="card empty">
        <p>nothing pending.</p>
        <a href="/ingest">ingest something →</a>
      </div>
    {:else}
      <div class="bulk">
        <button onclick={acceptAll} disabled={isProcessing}>
          {isProcessing ? 'accepting…' : 'accept all new & reinforcing'}
        </button>
        <span class="swipe-hint-inline">or swipe right to confirm, left to reject each.</span>
        {#if error}<p class="error">{error}</p>{/if}
      </div>
      {#each diff.entries as e (e.incoming.id)}
        <SwipeCard
          acceptLabel="✓ confirm"
          rejectLabel="✕ reject"
          onaccept={async () => { await setStatus(e.incoming.id, 'confirmed'); refresh(); }}
          onreject={async () => { await setStatus(e.incoming.id, 'rejected'); refresh(); }}
        >
          <DiffEntry entry={e} sourceLabel={sourceLabel(e.incoming.sourceId)} onresolved={refresh} />
        </SwipeCard>
      {/each}
    {/if}
  {/if}

  <!-- ── Deletions tab ── -->
  {#if activeTab === 'deletions'}
    {#if pendingDeletions.length === 0}
      <div class="card empty">
        <p>no suggested deletions.</p>
        <p class="muted">When Shelly or a re-analysis suggests removing a statement, it appears here for your review.</p>
      </div>
    {:else}
      <p class="section-hint">Confirm to permanently reject each statement, or keep it in the KB. <span class="swipe-hint-inline">Swipe right to keep, left to delete.</span></p>
      {#each pendingDeletions as st (st.id)}
        <SwipeCard
          acceptLabel="✓ keep"
          rejectLabel="✕ delete"
          onaccept={async () => { await keepStatement(st.id); }}
          onreject={async () => { await confirmDeletion(st.id); }}
        >
          <div class="op-card op-deletion">
            <div class="op-header">
              <span class="op-tag danger">suggested deletion</span>
              <span class="op-source mono">{sourceLabel(st.sourceId)}</span>
            </div>
            <StatementCard statement={st} compact />
            <div class="op-actions">
              <button class="danger" onclick={() => confirmDeletion(st.id)} disabled={isProcessing}>
                confirm delete
              </button>
              <button onclick={() => keepStatement(st.id)} disabled={isProcessing}>
                keep
              </button>
            </div>
          </div>
        </SwipeCard>
      {/each}
    {/if}
  {/if}

  <!-- ── Merges tab ── -->
  {#if activeTab === 'merges'}
    {#if pendingMerges.length === 0}
      <div class="card empty">
        <p>no suggested merges.</p>
        <p class="muted">When Shelly or a re-analysis suggests merging two entities, it appears here for review.</p>
      </div>
    {:else}
      <p class="section-hint">Execute a merge to redirect all triples from the dropped entity to the kept one. <span class="swipe-hint-inline">Swipe right to merge, left to dismiss.</span></p>
      {#each pendingMerges as st (st.id)}
        {@const keepIri = st.s.kind === 'iri' ? st.s.value : ''}
        {@const dropIri = st.o.kind === 'iri' ? st.o.value : ''}
        {@const keepLabel = keepIri.split('/').pop() ?? keepIri}
        {@const dropLabel = dropIri.split('/').pop() ?? dropIri}
        <SwipeCard
          acceptLabel="✓ merge"
          rejectLabel="✕ dismiss"
          onaccept={async () => { await executeMerge(st); }}
          onreject={async () => { await dismissMerge(st.id); }}
        >
          <div class="op-card op-merge">
            <div class="op-header">
              <span class="op-tag merge">suggested merge</span>
              <span class="op-source mono">{sourceLabel(st.sourceId)}</span>
            </div>
            {#if st.gloss}
              <p class="merge-gloss">{st.gloss}</p>
            {:else}
              <p class="merge-gloss">
                Merge <strong>{dropLabel}</strong> → <strong>{keepLabel}</strong>
              </p>
            {/if}
            <div class="merge-detail mono">
              <span class="drop-iri">{dropIri}</span>
              <span class="arrow">→</span>
              <span class="keep-iri">{keepIri}</span>
            </div>
            <div class="op-actions">
              <button class="primary" onclick={() => executeMerge(st)} disabled={isProcessing}>
                execute merge
              </button>
              <button onclick={() => dismissMerge(st.id)} disabled={isProcessing}>
                dismiss
              </button>
            </div>
          </div>
        </SwipeCard>
      {/each}
    {/if}
  {/if}

  <!-- ── Upcoming tab ── -->
  {#if activeTab === 'upcoming'}
    <div class="upcoming-controls">
      <div class="view-toggle">
        <button class:active={calViewMode === 'day'} onclick={() => calViewMode = 'day'}>day</button>
        <button class:active={calViewMode === 'week'} onclick={() => calViewMode = 'week'}>week</button>
        <button class:active={calViewMode === 'month'} onclick={() => calViewMode = 'month'}>month</button>
      </div>
      <div class="cal-nav">
        <button onclick={() => navCalendar(-1)}>←</button>
        <button class="today-btn" onclick={() => calCurrentDate = new Date()}>today</button>
        <button onclick={() => navCalendar(1)}>→</button>
      </div>
    </div>

    <!-- Event type filters -->
    {#if eventsWithConflicts.length > 0}
      <div class="cal-filters">
        <button
          class="cal-chip"
          class:active={calFilter === 'all'}
          onclick={() => calFilter = 'all'}
        >all <span class="cal-chip-count">{eventsWithConflicts.length}</span></button>
        <button
          class="cal-chip"
          class:active={calFilter === 'single'}
          onclick={() => calFilter = 'single'}
        >single <span class="cal-chip-count">{singleCount}</span></button>
        <button
          class="cal-chip cal-chip-recurring"
          class:active={calFilter === 'recurring'}
          onclick={() => calFilter = 'recurring'}
        >&#8634; recurring <span class="cal-chip-count">{recurringCount}</span></button>
        {#if conflictCount > 0}
          <button
            class="cal-chip cal-chip-conflict"
            class:active={calFilter === 'conflicts'}
            onclick={() => calFilter = 'conflicts'}
          >conflicts <span class="cal-chip-count">{conflictCount}</span></button>
        {/if}
      </div>

      <!-- Recurrence pattern legend -->
      {#if recurrencePatterns.size > 0 && (calFilter === 'all' || calFilter === 'recurring')}
        <div class="recurrence-legend">
          {#each [...recurrencePatterns] as [pattern, count]}
            <span class="recurrence-tag">
              <span class="recurrence-icon">&#8634;</span>
              {pattern}
              <span class="recurrence-count">{count}</span>
            </span>
          {/each}
        </div>
      {/if}

      {#if conflictCount > 0 && calFilter !== 'conflicts'}
        <p class="conflict-warn">
          {conflictCount} event{conflictCount !== 1 ? 's' : ''} with time conflicts
        </p>
      {/if}

      {#if filteredEvents.length === 0}
        <div class="card empty">
          <p>no {calFilter} events in this view.</p>
        </div>
      {:else}
        <CalendarGrid
          events={filteredEvents}
          viewMode={calViewMode}
          currentDate={calCurrentDate}
          onselect={(ev) => { /* could navigate to entity */ }}
        />
      {/if}
    {:else}
      <div class="card empty">
        <p>no upcoming events in your KB.</p>
        <p class="muted">Import events from the <a href="/ingest">ingest</a> tab (calendar mode) to see them here.</p>
      </div>
    {/if}
  {/if}

{/key}

<style>
  .head { margin-bottom: 1.25rem; }
  .kicker {
    color: var(--accent);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    margin: 0 0 0.5rem;
  }
  .sub { color: var(--muted); margin-top: 0.4rem; }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 0.25rem;
    border-bottom: 1px solid var(--line);
    margin-bottom: 1.5rem;
  }
  .tabs button {
    padding: 0.5rem 1rem;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.8rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: -1px;
    transition: color 0.15s, border-color 0.15s;
  }
  .tabs button.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .badge {
    font-size: 0.65rem;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 999px;
    padding: 0.05rem 0.4rem;
  }
  .badge-danger { background: color-mix(in srgb, var(--danger) 15%, var(--surface)); color: var(--danger); }
  .badge-merge { background: color-mix(in srgb, var(--data) 15%, var(--surface)); color: var(--data); }

  /* Summary chips */
  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 1.5rem;
  }
  .chip {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    padding: 0.25rem 0.6rem;
    border-radius: 999px;
    border: 1px solid var(--line);
    color: var(--muted);
  }
  .chip.new { color: var(--data); border-color: var(--data); }
  .chip.reinforces { color: var(--ok); border-color: var(--ok); }
  .chip.refines { color: var(--accent); border-color: var(--accent); }
  .chip.conflict { color: var(--danger); border-color: var(--danger); }
  .chip.near-dup { color: #f59e0b; border-color: #f59e0b; }
  .chip.synonym { color: var(--ok); border-color: var(--ok); }
  .chip.antonym { color: var(--danger); border-color: var(--danger); }
  .chip.analyzing { color: var(--muted); border-color: var(--line); animation: pulse 1.2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }

  /* Bulk actions */
  .bulk { margin-bottom: 1rem; }
  .bulk button:disabled { opacity: 0.6; cursor: not-allowed; }
  .error { color: var(--danger); font-size: 0.85rem; margin-top: 0.5rem; }

  /* Empty state */
  .empty { text-align: center; color: var(--muted); padding: 2.5rem 1rem; }
  .empty p { margin: 0.3rem 0; }
  .muted { color: var(--muted); }

  /* Operation cards */
  .section-hint {
    color: var(--muted);
    font-size: 0.82rem;
    margin-bottom: 1rem;
  }
  .op-card {
    padding: 1rem;
    border: 1px solid var(--line);
    border-radius: var(--rad);
    margin-bottom: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .op-deletion { border-color: color-mix(in srgb, var(--danger) 35%, var(--line)); }
  .op-merge    { border-color: color-mix(in srgb, var(--data) 35%, var(--line)); }

  .op-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .op-tag {
    font-family: var(--font-mono);
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    border: 1px solid;
  }
  .op-tag.danger  { color: var(--danger); border-color: var(--danger); }
  .op-tag.merge   { color: var(--data);   border-color: var(--data); }
  .op-source {
    font-size: 0.65rem;
    color: var(--muted);
    margin-left: auto;
  }

  .merge-gloss { margin: 0; font-size: 0.9rem; }
  .merge-detail {
    font-size: 0.65rem;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .drop-iri { color: var(--danger); }
  .keep-iri { color: var(--ok); }
  .arrow { opacity: 0.5; }

  .op-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  button:disabled { opacity: 0.6; cursor: not-allowed; }

  .swipe-hint-inline {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    color: var(--muted);
    opacity: 0.7;
  }

  /* ── Upcoming tab ── */
  .upcoming-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .view-toggle {
    display: flex;
    gap: 0.2rem;
  }
  .view-toggle button {
    padding: 0.35rem 0.7rem;
    font-size: 0.72rem;
    font-family: var(--font-mono);
    border-radius: 999px;
    background: none;
    border: 1px solid var(--line);
    color: var(--muted);
    cursor: pointer;
    transition: all 0.12s;
  }
  .view-toggle button:hover { color: var(--ink); }
  .view-toggle button.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }
  .cal-nav {
    display: flex;
    gap: 0.25rem;
    align-items: center;
  }
  .cal-nav button {
    padding: 0.3rem 0.6rem;
    font-size: 0.8rem;
    border-radius: var(--rad-sm);
    background: var(--surface-2);
    border: 1px solid var(--line);
    color: var(--muted);
    cursor: pointer;
  }
  .cal-nav button:hover { color: var(--ink); border-color: var(--ink); }
  .today-btn { font-family: var(--font-mono); font-size: 0.7rem; }
  .conflict-warn {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--danger);
    margin-bottom: 0.75rem;
    padding: 0.4rem 0.75rem;
    background: color-mix(in srgb, var(--danger) 8%, var(--surface));
    border: 1px solid color-mix(in srgb, var(--danger) 30%, var(--line));
    border-radius: var(--rad-sm);
  }

  /* Calendar event filters */
  .cal-filters {
    display: flex;
    gap: 0.3rem;
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
  }
  .cal-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.3rem 0.65rem;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: none;
    color: var(--muted);
    cursor: pointer;
    transition: all 0.12s;
  }
  .cal-chip:hover { color: var(--ink); border-color: var(--muted); }
  .cal-chip.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }
  .cal-chip-recurring { color: var(--data); }
  .cal-chip-recurring:hover { border-color: var(--data); }
  .cal-chip-recurring.active {
    background: var(--data-soft);
    border-color: var(--data);
    color: var(--data);
  }
  .cal-chip-conflict { color: var(--danger); }
  .cal-chip-conflict:hover { border-color: var(--danger); }
  .cal-chip-conflict.active {
    background: color-mix(in srgb, var(--danger) 12%, var(--surface));
    border-color: var(--danger);
    color: var(--danger);
  }
  .cal-chip-count {
    font-size: 0.6rem;
    opacity: 0.7;
    background: color-mix(in srgb, currentColor 12%, transparent);
    padding: 0.05rem 0.3rem;
    border-radius: 999px;
  }

  /* Recurrence pattern legend */
  .recurrence-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.75rem;
  }
  .recurrence-tag {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-family: var(--font-mono);
    font-size: 0.65rem;
    color: var(--data);
    padding: 0.2rem 0.5rem;
    border-radius: var(--rad-sm);
    background: var(--data-soft);
    border: 1px solid color-mix(in srgb, var(--data) 30%, var(--line));
  }
  .recurrence-icon {
    font-size: 0.8em;
    opacity: 0.8;
  }
  .recurrence-count {
    font-size: 0.55rem;
    opacity: 0.6;
    background: color-mix(in srgb, var(--data) 15%, transparent);
    padding: 0 0.25rem;
    border-radius: 999px;
  }

  /* ── Diff summary cards ── */
  .diff-summary-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 0.55rem;
    margin-bottom: 1rem;
  }
  .ds-card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 0.75rem 0.9rem;
  }
  .ds-card p { font-size: 0.82rem; line-height: 1.4; color: var(--ink-2); margin: 0; }
  .ds-heading {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin: 0 0 0.35rem;
  }
  .ds-new { border-color: color-mix(in srgb, var(--ok) 35%, var(--line)); }
  .ds-new .ds-heading { color: var(--ok); }
  .ds-reinforce { border-color: color-mix(in srgb, var(--data) 35%, var(--line)); }
  .ds-reinforce .ds-heading { color: var(--data); }
  .ds-conflict { border-color: color-mix(in srgb, var(--danger) 35%, var(--line)); }
  .ds-conflict .ds-heading { color: var(--danger); }
  .summary-btn { margin-bottom: 0.85rem; }

  /* ── Mobile ── */
  @media (max-width: 500px) {
    .tabs { gap: 0; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .tabs button { padding: 0.4rem 0.65rem; font-size: 0.7rem; white-space: nowrap; flex-shrink: 0; }
  }
</style>
