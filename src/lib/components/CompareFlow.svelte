<script lang="ts">
  /**
   * THE ONE COMPARE FLOW (F264.1). What a note would add, against what is already held, with
   * every label the diff can give (including the semantic ones), the bulk decisions, and a decision
   * per row. It used to live on /compare, with a second, picture-only copy inside Review; both
   * are now this, shown in Review's compare mode.
   */
  import {
    confirmedStatements,
    statements,
    statementsForSource,
    sources,
    setStatus,
    setStatuses,
    updateStatement
  } from '$lib/stores/kb.svelte';
  import { computeDiff, type Diff } from '$lib/rdf/diff';
  import { semanticEnrichDiff } from '$lib/rdf/semantic-diff';
  import { generateDiffSummary, type DiffSummary } from '$lib/rdf/diff-summary';
  import { settings } from '$lib/stores/settings.svelte';
  import KnowledgeGraph2D from '$lib/3d/KnowledgeGraph2D.svelte';
  import { decideContradiction, knownDisagreements, type ContradictionChoice } from '$lib/rdf/compare-decide';
  import type { Statement } from '$lib/rdf/types';
  import { compareOverlay, toCanvasOverlay, localLabel as overlayLabel } from '$lib/rdf/compare-overlay';

  let { sourceId }: { sourceId: string | null } = $props();

  const source = $derived(sources().find((s) => s.id === sourceId));

  /** Incoming = the pending rows of the chosen note. */
  const incoming = $derived(
    sourceId ? statementsForSource(sourceId).filter((s) => s.status === 'pending') : []
  );

  /**
   * What the incoming rows are weighed against: everything already settled, from any other
   * source. Rejected and superseded rows stay in so a claim the person already dismissed is
   * recognised as 'returned' instead of reading as news (F122, as in the Review queue).
   */
  const settled = $derived(
    statements().filter(
      (s) => s.status !== 'pending' && s.status !== 'pending-removal' && s.sourceId !== sourceId
    )
  );
  const confirmedElsewhere = $derived(confirmedStatements().filter((s) => s.sourceId !== sourceId));

  const sourceKeyOf = $derived.by(() => {
    const uri = new Map(sources().map((src) => [src.id, src.uri]));
    return (st: { sourceId: string }) => uri.get(st.sourceId) || st.sourceId;
  });

  const structural = $derived(computeDiff(incoming, settled, { sourceKey: sourceKeyOf }));

  // Semantic labels arrive after the structural ones. They need the embedding model; when it is not
  // already on the device the structural labels stand alone (opening this must never prompt a download).
  let enriched = $state<Diff | null>(null);
  let analyzing = $state(false);
  let enrichVersion = 0;
  $effect(() => {
    const base = structural;
    const against = settled;
    const mine = ++enrichVersion;
    enriched = null;
    if (base.entries.length === 0) { analyzing = false; return; }
    analyzing = true;
    semanticEnrichDiff(base, against, { onlyIfModelReady: true })
      .then((d) => { if (mine === enrichVersion) enriched = d; })
      .catch(() => { /* the structural diff is still valid */ })
      .finally(() => { if (mine === enrichVersion) analyzing = false; });
  });

  // Same-origin newer values are applied by Review without asking; they are not decisions here.
  const diff = $derived.by(() => {
    const d = enriched ?? structural;
    const entries = d.entries.filter((e) => e.kind !== 'updates');
    const count = (...kinds: string[]) => entries.filter((e) => kinds.includes(e.kind)).length;
    return { entries, count };
  });

  /** One chip per label that has at least one row, in the order a person weighs them. */
  const kindOrder = [
    'new', 'reinforces', 'synonym-reinforces', 'near-duplicate', 'duplicate',
    'conflicts', 'antonym-conflicts', 'refines', 'returned'
  ] as const;
  const chips = $derived(
    kindOrder.map((kind) => ({ kind, n: diff.entries.filter((e) => e.kind === kind).length })).filter((c) => c.n > 0)
  );

  // ── the incoming note drawn over the person's own canvas (F264.2) ─────────
  // Nothing here writes: the picture is a reading of the diff, and what you hold stays as it is until a choice.
  const canvasStatements = $derived(confirmedElsewhere);
  const sourceTitle = $derived.by(() => {
    const t = new Map(sources().map((src) => [src.id, src.title || src.uri || src.id]));
    return (st: { sourceId: string }) => t.get(st.sourceId) ?? st.sourceId;
  });
  const overlay = $derived(compareOverlay(diff.entries, canvasStatements, { sourceLabel: sourceTitle }));
  const canvasOverlay = $derived(toCanvasOverlay(overlay));
  const triple = (st: { s: { value: string }; p: { value: string }; o: { value: string } }) =>
    `${overlayLabel(st.s.value)} · ${overlayLabel(st.p.value)} · ${overlayLabel(st.o.value)}`;

  // ── deciding a contradiction in place (F264.3) ─────────────────────────────
  // A choice is applied through the same store path as the review queue; the pair then leaves the
  // overlay (the incoming statement is no longer pending) and is recorded below, with both passages.
  type Decided = { id: string; choice: ContradictionChoice; incoming: Statement; held: Statement[]; incomingSource: string; heldSources: string[] };
  let decided = $state<Decided[]>([]);
  let deciding = $state<string | null>(null);
  let decideError = $state<string | null>(null);
  const choiceWords: Record<ContradictionChoice, string> = {
    'keep-mine': 'kept what you hold; the arriving statement was rejected',
    'take-new': 'took the arriving statement; what you held is marked replaced and stays on record',
    'keep-both': 'kept both, marked as a known disagreement'
  };
  async function decide(c: (typeof overlay.contradictions)[number], choice: ContradictionChoice) {
    deciding = c.id;
    decideError = null;
    try {
      const d = decideContradiction({ incoming: c.incoming, held: c.held }, choice);
      await setStatuses(d.statuses);
      for (const m of d.marks) await updateStatement(m.id, { knownDisagreement: m.disagreesWith });
      decided = [...decided, { id: c.id, choice, incoming: c.incoming, held: c.held, incomingSource: c.incomingSource, heldSources: c.heldSources }];
    } catch (e) {
      decideError = e instanceof Error ? e.message : String(e);
    } finally {
      deciding = null;
    }
  }
  const disagreements = $derived(knownDisagreements(statements()));
  /** The passage a statement was read from, when it carries one that was checked against its source. */
  const passageOf = (st: Statement) => (st.excerpt && st.grounded !== false ? st.excerpt : null);

  // ── difference summary ─────────────────────────────────────────────────────
  let diffSummary = $state<DiffSummary | null>(null);
  let summaryLoading = $state(false);
  let summaryError = $state<string | null>(null);
  async function loadSummary() {
    summaryLoading = true;
    summaryError = null;
    try {
      diffSummary = await generateDiffSummary({ entries: diff.entries, summary: (enriched ?? structural).summary }, settings());
    } catch (e) {
      summaryError = e instanceof Error ? e.message : String(e);
    } finally {
      summaryLoading = false;
    }
  }

  // ── decisions ──────────────────────────────────────────────────────────────
  async function settleWhere(status: 'confirmed' | 'rejected', kinds: string[] | null) {
    const ids = new Set(
      diff.entries.filter((e) => kinds === null || kinds.includes(e.kind)).map((e) => e.incoming.id)
    );
    for (const st of incoming) if (kinds === null ? true : ids.has(st.id)) await setStatus(st.id, status);
  }
  const acceptAll = () => settleWhere('confirmed', null);
  const rejectAll = () => settleWhere('rejected', null);
  const acceptNew = () => settleWhere('confirmed', ['new']);
  const rejectDuplicates = () => settleWhere('rejected', ['duplicate']);

  // ── wording ────────────────────────────────────────────────────────────────
  const kindLabel: Record<string, string> = {
    new: 'new',
    duplicate: 'duplicate',
    reinforces: 'repeat',
    'synonym-reinforces': 'repeat (other wording)',
    'near-duplicate': 'near-duplicate',
    conflicts: 'contradiction',
    'antonym-conflicts': 'contradiction (opposite wording)',
    refines: 'refines',
    returned: 'already dismissed'
  };
  const kindColor: Record<string, string> = {
    new: 'var(--ok)',
    duplicate: 'var(--muted)',
    reinforces: 'var(--data)',
    'synonym-reinforces': 'var(--data)',
    'near-duplicate': 'var(--muted)',
    conflicts: 'var(--danger)',
    'antonym-conflicts': 'var(--danger)',
    refines: 'var(--accent)',
    returned: 'var(--muted)'
  };
  function shortVal(v: string, max = 48): string {
    return v.length > max ? v.slice(0, max) + '…' : v;
  }
  function localLabel(v: string): string {
    return shortVal((v.split('/').pop() ?? v).replace(/-/g, ' '));
  }
  const countOf = (...kinds: string[]) => diff.count(...kinds);
</script>

<div class="compare-flow" data-testid="compare-flow">
  {#if source}<p class="src-label mono">{source.title}</p>{/if}

  <div class="overlay-canvas" data-testid="compare-canvas">
    <KnowledgeGraph2D statements={canvasStatements} sources={sources()} compareOverlay={canvasOverlay} />
    <div class="overlay-legend mono" data-testid="overlay-legend">
      <span class="lg ghost">{overlay.ghosts.length} new, drawn as ghosts</span>
      <span class="lg">{overlay.folded.length} repeat{overlay.folded.length === 1 ? '' : 's'}, folded onto what you hold</span>
      <span class="lg">{overlay.thickened.length} reinforcing, thickening what you hold</span>
      <span class="lg conflict">{overlay.contradictions.length} contradiction{overlay.contradictions.length === 1 ? '' : 's'}</span>
      {#if canvasStatements.length === 0}<span class="lg">nothing confirmed yet to draw over</span>{/if}
    </div>
  </div>

  {#if overlay.contradictions.length > 0}
    <div class="pairs" data-testid="contradiction-pairs">
      {#each overlay.contradictions as c (c.id)}
        <div class="pair" data-testid="contradiction-pair">
          <div class="side held"><span class="side-tag mono">you hold</span>
            {#each c.held as h (h.id)}<div class="mono">{triple(h)}</div>
              {#if passageOf(h)}<q class="passage" data-testid="passage-held">{passageOf(h)}</q>{/if}{/each}
            <span class="src mono">from {c.heldSources.join(', ')}</span></div>
          <div class="vs mono">{c.opposite ? 'opposes' : 'contradicts'}</div>
          <div class="side arriving"><span class="side-tag mono">arriving</span>
            <div class="mono">{triple(c.incoming)}</div>
            {#if passageOf(c.incoming)}<q class="passage" data-testid="passage-incoming">{passageOf(c.incoming)}</q>{/if}
            <span class="src mono">from {c.incomingSource}</span></div>
          {#if c.note}<div class="pair-note mono">{c.note}</div>{/if}
          <div class="pair-actions">
            <button disabled={deciding === c.id} onclick={() => decide(c, 'keep-mine')} title="What you hold stays; the arriving statement is rejected.">keep mine</button>
            <button class="primary" disabled={deciding === c.id} onclick={() => decide(c, 'take-new')} title="The arriving statement is taken; what you hold is marked replaced and stays on record.">take the new one</button>
            <button disabled={deciding === c.id} onclick={() => decide(c, 'keep-both')} title="Both stand, marked as a known disagreement.">keep both</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if decideError}<p class="summary-err">{decideError}</p>{/if}
  {#if decided.length > 0}
    <div class="pairs decided" data-testid="decided-pairs">
      {#each decided as d (d.id)}
        <div class="pair settled" data-testid="decided-pair" data-choice={d.choice}>
          <div class="side held"><span class="side-tag mono">{d.choice === 'take-new' ? 'replaced, still on record' : 'you held'}</span>
            {#each d.held as h (h.id)}<div class="mono">{triple(h)}</div>
              {#if passageOf(h)}<q class="passage">{passageOf(h)}</q>{/if}{/each}
            <span class="src mono">from {d.heldSources.join(', ')}</span></div>
          <div class="vs mono">{d.choice === 'keep-both' ? 'disagree' : '→'}</div>
          <div class="side arriving"><span class="side-tag mono">{d.choice === 'keep-mine' ? 'rejected' : 'arrived'}</span>
            <div class="mono">{triple(d.incoming)}</div>
            {#if passageOf(d.incoming)}<q class="passage">{passageOf(d.incoming)}</q>{/if}
            <span class="src mono">from {d.incomingSource}</span></div>
          <div class="pair-note mono">{choiceWords[d.choice]}</div>
        </div>
      {/each}
    </div>
  {/if}
  {#if disagreements.length > 0}
    <div class="pairs" data-testid="known-disagreements">
      {#each disagreements as d (d.a.id + d.b.id)}
        <div class="pair settled" data-testid="known-disagreement">
          <div class="side"><span class="side-tag mono">known disagreement, seen</span><div class="mono">{triple(d.a)}</div><span class="src mono">from {sourceTitle(d.a)}</span></div>
          <div class="vs mono">and</div>
          <div class="side"><div class="mono">{triple(d.b)}</div><span class="src mono">from {sourceTitle(d.b)}</span></div>
        </div>
      {/each}
    </div>
  {/if}

  <div class="summary-row" data-testid="compare-chips">
    {#each chips as c (c.kind)}
      <span class="pill mono" data-kind={c.kind} style="border-color: {kindColor[c.kind]}; color: {kindColor[c.kind]}">
        {c.n} {kindLabel[c.kind]}
      </span>
    {/each}
    {#if analyzing}<span class="pill mono analyzing">checking similar wording…</span>{/if}
  </div>

  {#if diffSummary}
    <div class="summary-cards">
      {#if diffSummary.newSummary && diffSummary.newSummary !== 'None.'}
        <div class="summary-card new-card"><h3 class="summary-heading mono">new information</h3><p>{diffSummary.newSummary}</p></div>
      {/if}
      {#if diffSummary.reinforcingSummary && diffSummary.reinforcingSummary !== 'None.'}
        <div class="summary-card reinforce-card"><h3 class="summary-heading mono">reinforcing</h3><p>{diffSummary.reinforcingSummary}</p></div>
      {/if}
      {#if diffSummary.conflictingSummary && diffSummary.conflictingSummary !== 'None.'}
        <div class="summary-card conflict-card"><h3 class="summary-heading mono">conflicts &amp; refinements</h3><p>{diffSummary.conflictingSummary}</p></div>
      {/if}
    </div>
  {:else}
    <div class="summary-trigger">
      <button class="ghost" onclick={loadSummary} disabled={summaryLoading || diff.entries.length === 0}>
        {summaryLoading ? 'summarizing…' : 'summarize differences'}
      </button>
      {#if summaryError}<span class="summary-err">{summaryError}</span>{/if}
    </div>
  {/if}

  <div class="actions-row">
    <button class="primary" onclick={acceptAll} disabled={incoming.length === 0}>accept all ({incoming.length})</button>
    <button onclick={acceptNew} disabled={countOf('new') === 0}>accept new only ({countOf('new')})</button>
    <button onclick={rejectDuplicates} disabled={countOf('duplicate') === 0}>drop duplicates ({countOf('duplicate')})</button>
    <button onclick={rejectAll} disabled={incoming.length === 0}>reject all</button>
  </div>

  <div class="diff-list">
    {#each diff.entries as entry (entry.incoming.id)}
      <div class="diff-entry" data-kind={entry.kind}>
        <span class="badge mono" style="color: {kindColor[entry.kind]}">{kindLabel[entry.kind] ?? entry.kind}</span>
        <div class="triple mono">
          <span class="term s">{localLabel(entry.incoming.s.value)}</span>
          <span class="sep">·</span>
          <span class="term p">{localLabel(entry.incoming.p.value)}</span>
          <span class="sep">·</span>
          <span class="term o">{localLabel(entry.incoming.o.value)}</span>
        </div>
        {#if entry.kind !== 'new'}
          {@const held = 'existing' in entry ? (Array.isArray(entry.existing) ? entry.existing : [entry.existing]) : []}
          {#if held.length > 0}
            <div class="existing-val mono">
              you hold: {held.map((e) => `${localLabel(e.s.value)} · ${localLabel(e.p.value)} · ${localLabel(e.o.value)}`).join('; ')}
            </div>
          {/if}
        {/if}
        <div class="entry-actions">
          <button class="sm" aria-label="accept this one" onclick={() => setStatus(entry.incoming.id, 'confirmed')}>✓</button>
          <button class="sm danger" aria-label="reject this one" onclick={() => setStatus(entry.incoming.id, 'rejected')}>✗</button>
        </div>
      </div>
    {/each}
    {#if diff.entries.length === 0}
      <div class="empty">{sourceId ? 'no pending statements for this source.' : 'choose a source above to compare its statements with what you hold.'}</div>
    {/if}
  </div>
</div>

<style>
  .compare-flow { display: flex; flex-direction: column; gap: 0.75rem; overflow-y: auto; height: 100%; padding: 0.5rem 0.25rem; }
  .overlay-canvas { position: relative; width: 100%; height: 360px; flex: none; border: 1px solid var(--line); border-radius: var(--rad); overflow: hidden; background: var(--surface); }
  .overlay-legend { position: absolute; left: 0.5rem; bottom: 0.5rem; display: flex; flex-wrap: wrap; gap: 0.35rem 0.8rem; font-size: 0.65rem; color: var(--muted); background: color-mix(in srgb, var(--surface) 85%, transparent); padding: 0.25rem 0.6rem; border-radius: 999px; pointer-events: none; }
  .lg.ghost { color: #b97a05; }
  .lg.conflict { color: var(--danger); }
  .pairs { display: flex; flex-direction: column; gap: 0.5rem; }
  .pair { display: grid; grid-template-columns: 1fr auto 1fr; gap: 0.5rem 0.8rem; align-items: stretch; border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--line)); border-radius: var(--rad-sm); padding: 0.6rem 0.8rem; background: var(--surface); font-size: 0.75rem; }
  .side { display: flex; flex-direction: column; gap: 0.2rem; }
  .side-tag { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
  .side.arriving .side-tag { color: #b97a05; }
  .src { color: var(--muted); font-size: 0.68rem; }
  .vs { align-self: center; color: var(--danger); font-size: 0.7rem; }
  .pair-actions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .pair.settled { border-color: var(--line); }
  .passage { font-size: 0.7rem; color: var(--ink-2); font-style: italic; }
  .pair-note { grid-column: 1 / -1; color: var(--muted); font-size: 0.68rem; }
  .src-label { color: var(--muted); font-size: 0.8rem; margin: 0; }
  .summary-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .pill { padding: 0.25rem 0.7rem; border-radius: 999px; border: 1px solid; font-size: 0.72rem; text-transform: lowercase; }
  .pill.analyzing { border-color: var(--line); color: var(--muted); }
  .actions-row { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .diff-list { display: flex; flex-direction: column; gap: 0.45rem; }
  .diff-entry {
    display: grid; grid-template-columns: 8rem 1fr auto; grid-template-rows: auto auto; align-items: center;
    gap: 0.2rem 0.7rem; background: var(--surface); border: 1px solid var(--line);
    border-radius: var(--rad-sm); padding: 0.55rem 0.8rem;
  }
  .diff-entry[data-kind='conflicts'], .diff-entry[data-kind='antonym-conflicts'] { border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); }
  .diff-entry[data-kind='new'] { border-color: color-mix(in srgb, var(--ok) 30%, var(--line)); }
  .badge { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em; }
  .triple { font-size: 0.75rem; color: var(--ink-2); display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; }
  .sep { color: var(--muted); }
  .term.s { color: var(--accent); }
  .term.p { color: var(--muted); }
  .term.o { color: var(--data); }
  .existing-val { grid-column: 1 / -1; font-size: 0.7rem; color: var(--muted); }
  .entry-actions { display: flex; gap: 0.3rem; grid-row: 1; grid-column: 3; }
  button.sm { padding: 0.25rem 0.55rem; font-size: 0.8rem; border-radius: var(--rad-sm); min-width: 0; }
  .empty { text-align: center; color: var(--muted); padding: 2rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: var(--rad); }
  .summary-trigger { display: flex; align-items: center; gap: 0.7rem; }
  .summary-err { color: var(--danger); font-size: 0.78rem; }
  .summary-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.65rem; }
  .summary-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--rad); padding: 0.85rem 1rem; }
  .summary-card p { font-size: 0.85rem; line-height: 1.4; color: var(--ink-2); margin: 0; }
  .summary-heading { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.1em; margin: 0 0 0.4rem; }
  .new-card { border-color: color-mix(in srgb, var(--ok) 40%, var(--line)); }
  .new-card .summary-heading { color: var(--ok); }
  .reinforce-card { border-color: color-mix(in srgb, var(--data) 40%, var(--line)); }
  .reinforce-card .summary-heading { color: var(--data); }
  .conflict-card { border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); }
  .conflict-card .summary-heading { color: var(--danger); }
</style>
