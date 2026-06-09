<script lang="ts">
  import { sources, statementsForSource, setStatus, statements } from '$lib/stores/kb.svelte';
  import { runAndStoreAnalysis, analysisRunning, lastAnalysisError } from '$lib/stores/auto-analyze.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import type { Source, Statement } from '$lib/rdf/types';
  import { RDF_TYPE } from '$lib/rdf/entity-types';
  import { type AnalysisType, ANALYSIS_TYPE_LABELS } from '$lib/integrations/llm/re-analyze';

  let { onclose = () => {} } = $props<{ onclose?: () => void }>();

  // ── Analysis source history ─────────────────────────────────────────────
  const analysisSources = $derived(
    sources().filter(s => s.kind === 'analysis').sort((a, b) => b.ingestedAt - a.ingestedAt)
  );

  let expandedId = $state<string | null>(null);

  // ── Pending statements (type + relation only) for the expanded run ───────
  const expandedStatements = $derived(
    expandedId
      ? statementsForSource(expandedId).filter(s =>
          s.status === 'pending' &&
          s.p.value !== 'urn:kbase:predicate/potential-merge-with' &&
          s.p.value !== 'urn:kbase:predicate/should-prune'
        )
      : []
  );

  // ── Action suggestions from source metadata ───────────────────────────────
  const expandedSource = $derived(
    expandedId ? analysisSources.find(s => s.id === expandedId) ?? null : null
  );

  // Track dismissed actions in local state (resets on reload — acceptable)
  let dismissedMerges = $state(new Set<string>());
  let dismissedPrunes = $state(new Set<string>());

  const pendingMerges = $derived(
    (expandedSource?.analysisActions?.merges ?? []).filter(
      m => !dismissedMerges.has(`${m.entityAIri}|${m.entityBIri}`)
    )
  );
  const pendingPrunes = $derived(
    (expandedSource?.analysisActions?.prunes ?? []).filter(
      p => !dismissedPrunes.has(p.entityIri)
    )
  );

  function dismissMerge(a: string, b: string) {
    dismissedMerges = new Set([...dismissedMerges, `${a}|${b}`]);
  }
  function dismissPrune(iri: string) {
    dismissedPrunes = new Set([...dismissedPrunes, iri]);
  }

  // Prune: reject all statements where this entity is the subject
  async function pruneEntity(entityIri: string) {
    const toReject = statements().filter(
      s => s.s.kind === 'iri' && s.s.value === entityIri &&
           s.status !== 'rejected' && s.status !== 'superseded'
    );
    for (const st of toReject) await setStatus(st.id, 'rejected');
    dismissPrune(entityIri);
  }

  function statementKind(st: Statement): 'type' | 'relation' {
    if (st.p.value === RDF_TYPE) return 'type';
    return 'relation';
  }

  function shortIri(iri: string) {
    return iri.split('/').pop() ?? iri;
  }

  function triggerLabel(t?: string) {
    return t === 'import' ? 'after import' : t === 'schedule' ? 'scheduled' : 'manual';
  }

  // ── Cost warning / confirm ───────────────────────────────────────────────
  const ANALYSIS_TYPES: AnalysisType[] = ['new-triples', 'merge', 'entity-types', 'delete'];

  let showWarning = $state(false);
  let pendingType = $state<AnalysisType | null>(null);

  function requestRun(type: AnalysisType) {
    showWarning = true;
    pendingType = type;
  }

  async function confirmRun() {
    showWarning = false;
    const id = await runAndStoreAnalysis('manual', pendingType ?? 'new-triples');
    if (id) expandedId = id;
    pendingType = null;
  }

  function cancelRun() {
    showWarning = false;
    pendingType = null;
  }

  function focusLabel(focus?: string): string {
    if (!focus) return '—';
    return ANALYSIS_TYPE_LABELS[focus as AnalysisType] ?? focus;
  }
</script>

<div class="panel">
  <div class="panel-header">
    <h3 class="title mono">re-analysis</h3>
    <button class="ghost" onclick={onclose}>✕</button>
  </div>

  <!-- Cost warning modal -->
  {#if showWarning}
    <div class="warning-box">
      <p class="warn-title mono">api cost warning</p>
      <p class="warn-body">
        <strong>{pendingType ? focusLabel(pendingType) : ''}</strong> analysis sends your confirmed KB
        entities to <strong>{settings().analyzeBackend ?? settings().preferredBackend}</strong>.
        Each run costs API credits.
      </p>
      <div class="warn-actions">
        <button class="primary sm" onclick={confirmRun}>run anyway</button>
        <button class="sm" onclick={cancelRun}>cancel</button>
      </div>
    </div>
  {:else}
    <div class="run-grid">
      {#each ANALYSIS_TYPES as type}
        <button
          class="run-type-btn"
          onclick={() => requestRun(type)}
          disabled={analysisRunning()}
          title={type}
        >
          <span class="run-type-icon">{type === 'new-triples' ? '＋' : type === 'merge' ? '⟷' : type === 'entity-types' ? '◈' : '✕'}</span>
          <span class="run-type-label">{ANALYSIS_TYPE_LABELS[type]}</span>
        </button>
      {/each}
    </div>

    {#if analysisRunning()}
      <p class="running-msg mono">analyzing…</p>
    {/if}

    {#if lastAnalysisError()}
      <p class="err">{lastAnalysisError()}</p>
    {/if}
  {/if}

  <!-- History ─────────────────────────────────────────────────────────── -->
  {#if analysisSources.length === 0}
    <p class="empty">no analysis runs yet.</p>
  {:else}
    <div class="history">
      {#each analysisSources as run (run.id)}
        {@const isOpen = expandedId === run.id}
        <div class="run-card" class:open={isOpen}>
          <button class="run-header" onclick={() => (expandedId = isOpen ? null : run.id)}>
            <div class="run-meta">
              <span class="run-date mono">{new Date(run.ingestedAt).toLocaleString()}</span>
              <span class="run-trigger mono">{triggerLabel(run.analysisTrigger)}</span>
            </div>
            <div class="run-info">
              {#if run.analysisFocus}
                <span class="run-focus mono">{focusLabel(run.analysisFocus)}</span>
              {/if}
              <span class="run-model mono">{run.analysisModel ?? '—'}</span>
              <span class="run-count">{run.analysisTotalSuggestions ?? 0} suggestions</span>
            </div>
            <span class="chevron">{isOpen ? '▲' : '▼'}</span>
          </button>

          {#if isOpen}
            {@const totalPending = expandedStatements.length + pendingMerges.length + pendingPrunes.length}
            <div class="run-body">

              {#if totalPending === 0}
                <p class="empty-run">all suggestions reviewed.</p>
              {:else}

                <!-- ── Merge actions ───────────────────────────────────── -->
                {#if pendingMerges.length > 0}
                  <div class="action-group">
                    <p class="action-group-label mono">merge suggestions</p>
                    {#each pendingMerges as m (`${m.entityAIri}|${m.entityBIri}`)}
                      <div class="action-card action-merge">
                        <div class="action-content">
                          <div class="action-entities">
                            <span class="entity-a">{m.entityALabel}</span>
                            <span class="merge-arrow">⟷</span>
                            <span class="entity-b">{m.entityBLabel}</span>
                            <span class="confidence mono">{Math.round(m.confidence * 100)}%</span>
                          </div>
                          <p class="action-reason">{m.reason}</p>
                          <p class="action-hint mono">use the graph view to select either node and merge →</p>
                        </div>
                        <button class="sm ghost dismiss-btn" onclick={() => dismissMerge(m.entityAIri, m.entityBIri)} title="dismiss">✕</button>
                      </div>
                    {/each}
                  </div>
                {/if}

                <!-- ── Prune actions ───────────────────────────────────── -->
                {#if pendingPrunes.length > 0}
                  <div class="action-group">
                    <p class="action-group-label mono">prune suggestions</p>
                    {#each pendingPrunes as p (p.entityIri)}
                      <div class="action-card action-prune">
                        <div class="action-content">
                          <div class="action-entities">
                            <span class="entity-a">{p.entityLabel}</span>
                            <span class="confidence mono">{Math.round(p.confidence * 100)}%</span>
                          </div>
                          <p class="action-reason">{p.reason}</p>
                        </div>
                        <div class="action-btns">
                          <button class="sm danger" onclick={() => pruneEntity(p.entityIri)}>prune</button>
                          <button class="sm ghost dismiss-btn" onclick={() => dismissPrune(p.entityIri)} title="dismiss">✕</button>
                        </div>
                      </div>
                    {/each}
                  </div>
                {/if}

                <!-- ── Type + relation statement suggestions ───────────── -->
                {#if expandedStatements.length > 0}
                  <div class="action-group">
                    <p class="action-group-label mono">graph edits</p>
                    {#each expandedStatements as st (st.id)}
                      {@const kind = statementKind(st)}
                      <div class="suggestion" data-kind={kind}>
                        <div class="sug-content">
                          <span class="sug-kind mono">{kind}</span>
                          {#if kind === 'type'}
                            <span class="sug-text">
                              <span class="term-s">{shortIri(st.s.value)}</span>
                              <span class="arrow">→</span>
                              <span class="term-o">{shortIri(st.o.value)}</span>
                            </span>
                          {:else}
                            <span class="sug-text mono">
                              <span class="term-s">{shortIri(st.s.value)}</span>
                              <span class="term-p">·{shortIri(st.p.value)}·</span>
                              <span class="term-o">{shortIri(st.o.value)}</span>
                            </span>
                          {/if}
                          {#if st.gloss}
                            <p class="reason">{st.gloss.replace(/^\[.*?\]\s*/, '').split('. ').slice(1).join('. ')}</p>
                          {/if}
                        </div>
                        <div class="sug-actions">
                          <button class="sm primary" onclick={() => setStatus(st.id, 'confirmed')}>✓</button>
                          <button class="sm" onclick={() => setStatus(st.id, 'rejected')}>✗</button>
                        </div>
                      </div>
                    {/each}
                  </div>
                {/if}

              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .panel { display: flex; flex-direction: column; gap: 0.75rem; }

  .panel-header {
    display: flex; align-items: center; justify-content: space-between;
  }
  .title {
    font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.15em;
    color: var(--accent); margin: 0;
  }

  .run-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem;
  }

  .run-type-btn {
    display: flex; flex-direction: column; align-items: center; gap: 0.2rem;
    padding: 0.55rem 0.4rem;
    background: var(--surface-2); border: 1px solid var(--line);
    border-radius: var(--rad-sm); cursor: pointer;
    font-family: inherit; transition: background 0.15s, border-color 0.15s;
  }
  .run-type-btn:hover:not(:disabled) {
    background: var(--accent-soft); border-color: var(--accent);
  }
  .run-type-btn:disabled { opacity: 0.45; cursor: not-allowed; }

  .run-type-icon { font-size: 0.9rem; color: var(--accent); line-height: 1; }
  .run-type-label { font-size: 0.65rem; color: var(--ink-2); text-align: center; line-height: 1.2; }

  .running-msg {
    font-size: 0.72rem; color: var(--muted); margin: 0; text-align: center;
  }

  .err { color: var(--danger); font-size: 0.78rem; margin: 0; }

  .empty {
    color: var(--muted); font-size: 0.82rem; margin: 0; padding: 0.75rem;
    text-align: center; border: 1px solid var(--line); border-radius: var(--rad-sm);
  }

  /* ── Cost warning ── */
  .warning-box {
    background: color-mix(in srgb, var(--danger) 8%, var(--surface));
    border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--line));
    border-radius: var(--rad-sm);
    padding: 0.85rem;
    display: flex; flex-direction: column; gap: 0.5rem;
  }
  .warn-title {
    font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.15em;
    color: var(--danger); margin: 0;
  }
  .warn-body { font-size: 0.78rem; color: var(--ink-2); margin: 0; line-height: 1.45; }
  .warn-actions { display: flex; gap: 0.4rem; }

  /* ── History ── */
  .history { display: flex; flex-direction: column; gap: 0.4rem; }

  .run-card {
    border: 1px solid var(--line); border-radius: var(--rad-sm);
    background: var(--surface); overflow: hidden;
  }
  .run-card.open { border-color: var(--accent); }

  .run-header {
    width: 100%; display: flex; align-items: center; gap: 0.5rem;
    padding: 0.6rem 0.75rem; background: none; border: none;
    cursor: pointer; text-align: left;
  }
  .run-header:hover { background: var(--surface-2); }

  .run-meta { display: flex; flex-direction: column; gap: 0.1rem; flex: 1; }
  .run-date { font-size: 0.7rem; color: var(--ink-2); }
  .run-trigger {
    font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--muted);
  }
  .run-info { display: flex; flex-direction: column; align-items: flex-end; gap: 0.1rem; }
  .run-focus {
    font-size: 0.6rem; color: var(--accent);
    text-transform: uppercase; letter-spacing: 0.08em;
  }
  .run-model { font-size: 0.62rem; color: var(--muted); }
  .run-count { font-size: 0.72rem; color: var(--accent); }
  .chevron { font-size: 0.6rem; color: var(--muted); }

  /* ── Run body ── */
  .run-body {
    border-top: 1px solid var(--line);
    display: flex; flex-direction: column; gap: 0;
  }

  .empty-run {
    color: var(--muted); font-size: 0.78rem;
    padding: 0.6rem 0.75rem; margin: 0;
  }

  /* ── Action groups ── */
  .action-group {
    border-bottom: 1px solid var(--line);
    padding: 0.5rem 0.75rem;
    display: flex; flex-direction: column; gap: 0.4rem;
  }
  .action-group:last-child { border-bottom: none; }

  .action-group-label {
    font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.12em;
    color: var(--muted); margin: 0 0 0.2rem;
  }

  /* ── Merge / Prune action cards ── */
  .action-card {
    display: flex; align-items: flex-start; gap: 0.5rem;
    padding: 0.5rem 0.6rem;
    border-radius: var(--rad-sm);
    border: 1px solid var(--line);
  }
  .action-merge {
    background: color-mix(in srgb, var(--data) 5%, var(--surface));
    border-color: color-mix(in srgb, var(--data) 20%, var(--line));
  }
  .action-prune {
    background: color-mix(in srgb, var(--danger) 5%, var(--surface));
    border-color: color-mix(in srgb, var(--danger) 20%, var(--line));
  }

  .action-content { flex: 1; display: flex; flex-direction: column; gap: 0.25rem; }

  .action-entities {
    display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap;
    font-size: 0.78rem;
  }
  .entity-a { color: var(--accent); font-weight: 600; }
  .entity-b { color: var(--data); font-weight: 600; }
  .merge-arrow { color: var(--muted); font-size: 0.85rem; }
  .confidence {
    font-size: 0.6rem; color: var(--muted);
    background: var(--surface-2); border: 1px solid var(--line);
    border-radius: 4px; padding: 0.05rem 0.3rem;
    margin-left: auto;
  }

  .action-reason { font-size: 0.72rem; color: var(--ink-2); margin: 0; line-height: 1.4; }
  .action-hint {
    font-size: 0.62rem; color: var(--muted); margin: 0;
    font-style: italic;
  }

  .action-btns { display: flex; flex-direction: column; gap: 0.25rem; flex-shrink: 0; }
  .dismiss-btn { padding: 0.2rem 0.45rem; font-size: 0.7rem; color: var(--muted); }

  /* ── Type / relation statements ── */
  .suggestion {
    display: flex; align-items: flex-start; gap: 0.5rem;
    padding: 0.5rem 0.6rem;
    border-radius: var(--rad-sm);
    border: 1px solid var(--line);
  }
  .suggestion[data-kind='type'] { background: color-mix(in srgb, var(--accent) 5%, var(--surface)); }

  .sug-content { flex: 1; display: flex; flex-direction: column; gap: 0.2rem; }
  .sug-kind {
    font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--muted);
  }
  .sug-text {
    font-size: 0.78rem; display: flex; flex-wrap: wrap; gap: 0.25rem; align-items: center;
  }
  .term-s { color: var(--accent); }
  .term-p { color: var(--muted); }
  .term-o { color: var(--data); }
  .arrow { color: var(--muted); }

  .reason {
    font-size: 0.7rem; color: var(--muted); margin: 0; line-height: 1.35;
  }

  .sug-actions { display: flex; gap: 0.3rem; flex-shrink: 0; padding-top: 0.1rem; }
  button.sm { padding: 0.25rem 0.55rem; font-size: 0.75rem; }
</style>
