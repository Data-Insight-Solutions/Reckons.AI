<script lang="ts">
  /**
   * MergeReview — full-screen overlay for reviewing and confirming a merge
   * between two KB entities.
   *
   * Relations are classified into four categories:
   *   shared   — same predicate + object in both entities → kept automatically
   *   conflict — same predicate, different objects → user picks one value
   *   only-a   — predicate exists only on A
   *   only-b   — predicate exists only on B
   *
   * Incoming — statements where A or B is the *object* — will be silently
   * redirected to the kept IRI.
   */

  import { statements, sources } from '$lib/stores/kb.svelte';
  import { termKey, isIRI, isLit, type Statement } from '$lib/rdf/types';
  import { RDF_TYPE } from '$lib/rdf/entity-types';
  import { findTemporalConflicts } from '$lib/rdf/temporal';
  import { analyzeMerge } from '$lib/integrations/llm/merge-analysis';

  interface Props {
    entityKeyA: string;
    entityKeyB: string;
    /** keepKey = termKey of entity to keep; conflicts = list of {keepId, rejectId} pairs */
    onConfirm: (keepKey: string, conflicts: { keepId: string; rejectId: string }[]) => void;
    onCancel: () => void;
  }
  let { entityKeyA, entityKeyB, onConfirm, onCancel }: Props = $props();

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function iriOf(key: string) { return key.startsWith('i:') ? key.slice(2) : key; }
  function labelOf(key: string) {
    const iri = iriOf(key);
    return iri.split('/').pop() ?? iri;
  }
  function termLabel(t: Statement['s']) {
    if (isIRI(t)) return t.value.split('/').pop() ?? t.value;
    if (isLit(t)) return t.value.slice(0, 60);
    return `_:${t.value}`;
  }
  function predLabel(p: Statement['p']) {
    return p.value.split('/').pop() ?? p.value;
  }

  // ── Source map ───────────────────────────────────────────────────────────────

  const srcMap = $derived.by(() => {
    const m = new Map<string, { id: string; title: string; trustLevel?: 'trusted' | 'review' }>();
    for (const s of sources()) m.set(s.id, { id: s.id, title: s.title, trustLevel: s.trustLevel });
    return m;
  });

  // ── All statements for each entity (active only) ─────────────────────────────

  const allA = $derived(
    statements().filter(
      s => s.status !== 'rejected' && s.status !== 'superseded' &&
           (termKey(s.s) === entityKeyA || termKey(s.o) === entityKeyA)
    )
  );
  const allB = $derived(
    statements().filter(
      s => s.status !== 'rejected' && s.status !== 'superseded' &&
           (termKey(s.s) === entityKeyB || termKey(s.o) === entityKeyB)
    )
  );

  // ── Outgoing (entity is subject) ─────────────────────────────────────────────

  const outA = $derived(allA.filter(s => termKey(s.s) === entityKeyA && s.p.value !== RDF_TYPE));
  const outB = $derived(allB.filter(s => termKey(s.s) === entityKeyB && s.p.value !== RDF_TYPE));

  const typeA = $derived(allA.find(s => termKey(s.s) === entityKeyA && s.p.value === RDF_TYPE));
  const typeB = $derived(allB.find(s => termKey(s.s) === entityKeyB && s.p.value === RDF_TYPE));

  // ── Incoming (entity is object — will be silently redirected) ────────────────

  const inA = $derived(allA.filter(s => termKey(s.o) === entityKeyA));
  const inB = $derived(allB.filter(s => termKey(s.o) === entityKeyB));

  // ── Relation categorisation ──────────────────────────────────────────────────

  type Shared   = { kind: 'shared';   pred: string; obj: string; stmts: Statement[] };
  type Conflict = { kind: 'conflict'; pred: string; valA: string; valB: string; stA: Statement; stB: Statement };
  type OnlyA    = { kind: 'only-a';   pred: string; obj: string; st: Statement };
  type OnlyB    = { kind: 'only-b';   pred: string; obj: string; st: Statement };
  type Category = Shared | Conflict | OnlyA | OnlyB;

  const categories = $derived.by((): Category[] => {
    // Group outgoing by predicate
    const byPredA = new Map<string, Statement[]>();
    const byPredB = new Map<string, Statement[]>();
    for (const st of outA) {
      const p = st.p.value;
      if (!byPredA.has(p)) byPredA.set(p, []);
      byPredA.get(p)!.push(st);
    }
    for (const st of outB) {
      const p = st.p.value;
      if (!byPredB.has(p)) byPredB.set(p, []);
      byPredB.get(p)!.push(st);
    }

    const all = new Set([...byPredA.keys(), ...byPredB.keys()]);
    const result: Category[] = [];

    for (const pred of all) {
      const stmtsA = byPredA.get(pred) ?? [];
      const stmtsB = byPredB.get(pred) ?? [];

      if (stmtsA.length === 0) {
        for (const st of stmtsB)
          result.push({ kind: 'only-b', pred: predLabel(st.p), obj: termLabel(st.o), st });
        continue;
      }
      if (stmtsB.length === 0) {
        for (const st of stmtsA)
          result.push({ kind: 'only-a', pred: predLabel(st.p), obj: termLabel(st.o), st });
        continue;
      }

      // Both have this predicate — check for value overlap
      for (const stA of stmtsA) {
        const objKeyA = termKey(stA.o);
        const matchB = stmtsB.find(stB => termKey(stB.o) === objKeyA);
        if (matchB) {
          result.push({ kind: 'shared', pred: predLabel(stA.p), obj: termLabel(stA.o), stmts: [stA, matchB] });
        } else {
          // Each B value is a conflict candidate
          for (const stB of stmtsB) {
            result.push({
              kind: 'conflict',
              pred: predLabel(stA.p),
              valA: termLabel(stA.o),
              valB: termLabel(stB.o),
              stA,
              stB
            });
          }
        }
      }
      // B values with no match in A were already handled above
    }

    return result;
  });

  const shared    = $derived(categories.filter((c): c is Shared   => c.kind === 'shared'));
  const conflicts = $derived(categories.filter((c): c is Conflict => c.kind === 'conflict'));
  const onlyA     = $derived(categories.filter((c): c is OnlyA    => c.kind === 'only-a'));
  const onlyB     = $derived(categories.filter((c): c is OnlyB    => c.kind === 'only-b'));

  // ── Conflict resolutions (pred → 'a' | 'b' | 'both') ────────────────────────

  let resolutions = $state<Record<string, 'a' | 'b' | 'both'>>({});

  const unresolvedCount = $derived(
    conflicts.filter(c => !resolutions[c.stA.id + '|' + c.stB.id]).length
  );

  function resolveConflict(stAid: string, stBid: string, pick: 'a' | 'b' | 'both') {
    resolutions = { ...resolutions, [`${stAid}|${stBid}`]: pick };
  }

  // ── Temporal conflicts ───────────────────────────────────────────────────────

  const temporalConflicts = $derived(findTemporalConflicts([...allA, ...allB]));

  // ── Summary counts ───────────────────────────────────────────────────────────

  const labelA = $derived(labelOf(entityKeyA));
  const labelB = $derived(labelOf(entityKeyB));
  const iriA   = $derived(iriOf(entityKeyA));
  const iriB   = $derived(iriOf(entityKeyB));

  // ── AI analysis ──────────────────────────────────────────────────────────────

  let aiOpen = $state(false);
  let aiMessages = $state<{ role: 'user' | 'assistant'; content: string }[]>([]);
  let aiQuestion = $state('');
  let aiLoading = $state(false);
  let aiInitialized = $state(false);

  async function initAI() {
    if (aiInitialized) return;
    aiInitialized = true;
    aiLoading = true;
    try {
      const analysis = await analyzeMerge({
        entityKeyA, entityKeyB,
        statementsA: allA, statementsB: allB,
        sourcesInfo: [...srcMap.values()]
      });
      aiMessages = [{ role: 'assistant', content: analysis }];
    } catch { /* silent */ }
    finally { aiLoading = false; }
  }

  async function askAI() {
    if (!aiQuestion.trim()) return;
    const q = aiQuestion;
    aiQuestion = '';
    aiMessages = [...aiMessages, { role: 'user', content: q }];
    aiLoading = true;
    try {
      const analysis = await analyzeMerge({
        entityKeyA, entityKeyB,
        statementsA: allA, statementsB: allB,
        sourcesInfo: [...srcMap.values()],
        followUpQuestion: q,
        previousAnalysis: aiMessages.find(m => m.role === 'assistant')?.content
      });
      aiMessages = [...aiMessages, { role: 'assistant', content: analysis }];
    } catch { /* silent */ }
    finally { aiLoading = false; }
  }

  // ── Confirm ──────────────────────────────────────────────────────────────────

  function doConfirm(keepKey: string) {
    const conflictChoices = conflicts.flatMap(c => {
      const pick = resolutions[c.stA.id + '|' + c.stB.id] ?? 'a';
      if (pick === 'both') return [];
      return [{ keepId: pick === 'a' ? c.stA.id : c.stB.id, rejectId: pick === 'a' ? c.stB.id : c.stA.id }];
    });
    onConfirm(keepKey, conflictChoices);
  }
</script>

<!-- Full-screen overlay -->
<div
  class="mr-backdrop"
  onclick={() => onCancel()}
  onkeydown={(e) => { if (e.key === 'Escape') onCancel(); }}
  role="dialog"
  aria-modal="true"
  aria-label="Merge review"
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="mr-modal" onclick={(e) => e.stopPropagation()}>

    <!-- ── Header ── -->
    <div class="mr-header">
      <div class="mr-entities">
        <div class="mr-entity mr-entity-a">
          <span class="mr-entity-label mono">{labelA}</span>
          {#if typeA}
            <span class="mr-type-pill">{termLabel(typeA.o)}</span>
          {/if}
          <span class="mr-count">{allA.length} stmts</span>
        </div>
        <span class="mr-merge-icon">⟷</span>
        <div class="mr-entity mr-entity-b">
          <span class="mr-entity-label mono">{labelB}</span>
          {#if typeB}
            <span class="mr-type-pill">{termLabel(typeB.o)}</span>
          {/if}
          <span class="mr-count">{allB.length} stmts</span>
        </div>
      </div>
      <button class="ghost mr-close-btn" onclick={onCancel}>✕</button>
    </div>

    <!-- ── Merge action bar ── -->
    <div class="mr-actions-bar">
      <p class="mr-actions-hint mono">
        {unresolvedCount > 0
          ? `resolve ${unresolvedCount} conflict${unresolvedCount !== 1 ? 's' : ''} before merging`
          : `choose which IRI to keep — the other entity's statements are redirected`}
      </p>
      <div class="mr-keep-btns">
        <button
          class="mr-keep-btn mr-keep-a"
          onclick={() => doConfirm(entityKeyA)}
          disabled={unresolvedCount > 0}
        >
          keep <strong>{labelA}</strong>
        </button>
        <button
          class="mr-keep-btn mr-keep-b"
          onclick={() => doConfirm(entityKeyB)}
          disabled={unresolvedCount > 0}
        >
          keep <strong>{labelB}</strong>
        </button>
        <button class="mr-cancel-btn" onclick={onCancel}>cancel</button>
      </div>
    </div>

    <!-- ── Scrollable content ── -->
    <div class="mr-body">

      <!-- Side-by-side raw statement view -->
      <div class="mr-side-by-side">
        <div class="mr-side mr-side-a">
          <p class="mr-side-title mono"><span class="mr-side-label-a">{labelA}</span> · triples</p>
          {#each outA as st (st.id)}
            <div class="mr-triple">
              <span class="mr-triple-pred mono">·{predLabel(st.p)}·</span>
              <span class="mr-triple-obj">{termLabel(st.o)}</span>
              <span class="mr-triple-src mono">{srcMap.get(st.sourceId)?.title?.slice(0, 12) ?? '—'}</span>
            </div>
          {/each}
          {#if outA.length === 0}
            <p class="mr-side-empty">no outgoing triples</p>
          {/if}
          {#if typeA}
            <div class="mr-triple mr-triple-type">
              <span class="mr-triple-pred mono">·type·</span>
              <span class="mr-triple-obj">{termLabel(typeA.o)}</span>
            </div>
          {/if}
        </div>
        <div class="mr-side-divider"></div>
        <div class="mr-side mr-side-b">
          <p class="mr-side-title mono"><span class="mr-side-label-b">{labelB}</span> · triples</p>
          {#each outB as st (st.id)}
            <div class="mr-triple">
              <span class="mr-triple-pred mono">·{predLabel(st.p)}·</span>
              <span class="mr-triple-obj">{termLabel(st.o)}</span>
              <span class="mr-triple-src mono">{srcMap.get(st.sourceId)?.title?.slice(0, 12) ?? '—'}</span>
            </div>
          {/each}
          {#if outB.length === 0}
            <p class="mr-side-empty">no outgoing triples</p>
          {/if}
          {#if typeB}
            <div class="mr-triple mr-triple-type">
              <span class="mr-triple-pred mono">·type·</span>
              <span class="mr-triple-obj">{termLabel(typeB.o)}</span>
            </div>
          {/if}
        </div>
      </div>

      <!-- Shared relations -->
      {#if shared.length > 0}
        <section class="mr-section">
          <h4 class="mr-section-title">
            <span class="mr-badge mr-badge-shared">✓ {shared.length} shared</span>
            both entities already have these — kept automatically
          </h4>
          <div class="mr-rows">
            {#each shared as r (r.pred + r.obj)}
              <div class="mr-row mr-row-shared">
                <span class="mr-pred mono">·{r.pred}·</span>
                <span class="mr-obj">{r.obj}</span>
                <span class="mr-row-badge mono">both</span>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <!-- Conflicts -->
      {#if conflicts.length > 0}
        <section class="mr-section">
          <h4 class="mr-section-title">
            <span class="mr-badge mr-badge-conflict">⚠ {conflicts.length} conflict{conflicts.length !== 1 ? 's' : ''}</span>
            same predicate, different values — pick one or keep both
          </h4>
          <div class="mr-rows">
            {#each conflicts as c (c.stA.id + '|' + c.stB.id)}
              {@const key = c.stA.id + '|' + c.stB.id}
              {@const pick = resolutions[key]}
              <div class="mr-conflict" class:resolved={pick !== undefined}>
                <span class="mr-pred mono">·{c.pred}·</span>
                <div class="mr-conflict-values">
                  <button
                    class="mr-conflict-val mr-val-a"
                    class:chosen={pick === 'a'}
                    onclick={() => resolveConflict(c.stA.id, c.stB.id, 'a')}
                  >
                    <span class="mr-val-src mono">A</span>
                    <span class="mr-val-text">{c.valA}</span>
                    {#if pick === 'a'}<span class="mr-chosen-mark">✓</span>{/if}
                  </button>
                  <span class="mr-vs mono">vs</span>
                  <button
                    class="mr-conflict-val mr-val-b"
                    class:chosen={pick === 'b'}
                    onclick={() => resolveConflict(c.stA.id, c.stB.id, 'b')}
                  >
                    <span class="mr-val-src mono">B</span>
                    <span class="mr-val-text">{c.valB}</span>
                    {#if pick === 'b'}<span class="mr-chosen-mark">✓</span>{/if}
                  </button>
                  <button
                    class="mr-conflict-val mr-val-both"
                    class:chosen={pick === 'both'}
                    onclick={() => resolveConflict(c.stA.id, c.stB.id, 'both')}
                    title="Keep both values on the merged entity"
                  >
                    <span class="mr-val-text">keep both</span>
                    {#if pick === 'both'}<span class="mr-chosen-mark">✓</span>{/if}
                  </button>
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <!-- Unique to each entity — two-column on desktop -->
      {#if onlyA.length > 0 || onlyB.length > 0}
        <div class="mr-unique-grid">
          {#if onlyA.length > 0}
            <section class="mr-section">
              <h4 class="mr-section-title">
                <span class="mr-badge mr-badge-a">{onlyA.length} only in {labelA}</span>
                kept when keeping {labelA}, added when keeping {labelB}
              </h4>
              <div class="mr-rows">
                {#each onlyA as r (r.st.id)}
                  <div class="mr-row mr-row-a">
                    <span class="mr-pred mono">·{r.pred}·</span>
                    <span class="mr-obj">{r.obj}</span>
                    <span class="mr-src-tag mono">{srcMap.get(r.st.sourceId)?.title?.slice(0, 16) ?? '—'}</span>
                  </div>
                {/each}
              </div>
            </section>
          {/if}

          {#if onlyB.length > 0}
            <section class="mr-section">
              <h4 class="mr-section-title">
                <span class="mr-badge mr-badge-b">{onlyB.length} only in {labelB}</span>
                kept when keeping {labelB}, added when keeping {labelA}
              </h4>
              <div class="mr-rows">
                {#each onlyB as r (r.st.id)}
                  <div class="mr-row mr-row-b">
                    <span class="mr-pred mono">·{r.pred}·</span>
                    <span class="mr-obj">{r.obj}</span>
                    <span class="mr-src-tag mono">{srcMap.get(r.st.sourceId)?.title?.slice(0, 16) ?? '—'}</span>
                  </div>
                {/each}
              </div>
            </section>
          {/if}
        </div>
      {/if}

      <!-- Incoming relations -->
      {#if inA.length > 0 || inB.length > 0}
        <section class="mr-section">
          <h4 class="mr-section-title">
            <span class="mr-badge mr-badge-in">{inA.length + inB.length} incoming</span>
            other nodes pointing here — silently redirected to kept entity
          </h4>
          <div class="mr-rows">
            {#each inA as st (st.id)}
              <div class="mr-row mr-row-in">
                <span class="mr-in-sub">{termLabel(st.s)}</span>
                <span class="mr-pred mono">·{predLabel(st.p)}·</span>
                <span class="mr-in-target mr-val-a">→ {labelA}</span>
              </div>
            {/each}
            {#each inB as st (st.id)}
              <div class="mr-row mr-row-in">
                <span class="mr-in-sub">{termLabel(st.s)}</span>
                <span class="mr-pred mono">·{predLabel(st.p)}·</span>
                <span class="mr-in-target mr-val-b">→ {labelB}</span>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <!-- Temporal conflicts -->
      {#if temporalConflicts.length > 0}
        <section class="mr-section mr-section-temporal">
          <h4 class="mr-section-title">
            <span class="mr-badge mr-badge-conflict">{temporalConflicts.length} temporal</span>
            overlapping time ranges for the same predicate
          </h4>
          <div class="mr-rows">
            {#each temporalConflicts as tc (tc.subject + tc.predicate)}
              <div class="mr-row mr-row-conflict">
                <span class="mr-pred mono">·{labelOf(tc.predicate)}·</span>
                <div class="mr-tc-vals">
                  {#each tc.values as v}
                    <span class="mr-tc-val">{v.value} <span class="mono">← {srcMap.get(v.sourceId)?.title ?? v.sourceId}</span></span>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <!-- AI Analysis (lazy) -->
      <section class="mr-section mr-ai-section">
        <button
          class="mr-ai-toggle"
          onclick={() => { aiOpen = !aiOpen; if (aiOpen) initAI(); }}
        >
          <span class="mr-badge mr-badge-ai">AI</span>
          semantic analysis
          <span class="mr-ai-chevron">{aiOpen ? '▲' : '▼'}</span>
        </button>

        {#if aiOpen}
          <div class="mr-ai-body">
            <div class="mr-ai-messages">
              {#if aiLoading && aiMessages.length === 0}
                <p class="mr-ai-loading mono">analysing…</p>
              {/if}
              {#each aiMessages as m}
                <div class="mr-ai-msg" class:user={m.role === 'user'}>
                  {m.content}
                </div>
              {/each}
              {#if aiLoading && aiMessages.length > 0}
                <p class="mr-ai-loading mono">…</p>
              {/if}
            </div>
            <div class="mr-ai-input">
              <input
                type="text"
                bind:value={aiQuestion}
                placeholder="ask about differences or implications…"
                onkeydown={(e) => e.key === 'Enter' && askAI()}
                disabled={aiLoading}
              />
              <button onclick={askAI} disabled={!aiQuestion.trim() || aiLoading} class="primary">ask</button>
            </div>
          </div>
        {/if}
      </section>

      <!-- IRI reference -->
      <div class="mr-iri-ref">
        <span class="mono">A: {iriA}</span>
        <span class="mono">B: {iriB}</span>
      </div>

    </div><!-- /mr-body -->
  </div>
</div>

<style>
  /* ── Backdrop ── */
  .mr-backdrop {
    position: fixed;
    inset: 0;
    z-index: 500;
    background: rgba(6, 6, 10, 0.75);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 1rem;
    overflow-y: auto;
  }

  .mr-modal {
    width: 100%;
    max-width: 860px;
    background: rgba(14, 14, 20, 0.98);
    border: 1px solid var(--accent);
    border-radius: var(--rad);
    box-shadow: 0 16px 48px rgba(0,0,0,0.6);
    display: flex;
    flex-direction: column;
    min-height: 0;
    margin: auto;
  }

  /* ── Header ── */
  .mr-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem 1.25rem 0.75rem;
    border-bottom: 1px solid var(--line);
  }
  .mr-entities {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 1;
    flex-wrap: wrap;
  }
  .mr-entity {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .mr-entity-label {
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--ink-2);
  }
  .mr-entity-a .mr-entity-label { color: var(--accent); }
  .mr-entity-b .mr-entity-label { color: var(--data); }
  .mr-type-pill {
    font-family: var(--font-mono);
    font-size: 0.58rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0.1rem 0.4rem;
  }
  .mr-count { font-size: 0.68rem; color: var(--muted); }
  .mr-merge-icon { font-size: 1.1rem; color: var(--muted); flex-shrink: 0; }
  .mr-close-btn { font-size: 0.85rem; color: var(--muted); padding: 0.25rem 0.5rem; flex-shrink: 0; }

  /* ── Actions bar ── */
  .mr-actions-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1.25rem;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
    background: rgba(0,0,0,0.15);
  }
  .mr-actions-hint {
    font-size: 0.7rem;
    color: var(--muted);
    margin: 0;
    flex: 1;
    min-width: 0;
  }
  .mr-keep-btns { display: flex; gap: 0.45rem; flex-shrink: 0; flex-wrap: wrap; }
  .mr-keep-btn {
    padding: 0.4rem 0.85rem;
    border-radius: var(--rad-sm);
    font-size: 0.82rem;
    cursor: pointer;
    transition: all 0.12s;
    font-family: inherit;
  }
  .mr-keep-btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .mr-keep-a {
    background: color-mix(in srgb, var(--accent) 14%, var(--surface));
    border: 1px solid var(--accent);
    color: var(--accent);
  }
  .mr-keep-a:not(:disabled):hover { background: var(--accent); color: #0a0a0e; }
  .mr-keep-b {
    background: color-mix(in srgb, var(--data) 14%, var(--surface));
    border: 1px solid var(--data);
    color: var(--data);
  }
  .mr-keep-b:not(:disabled):hover { background: var(--data); color: #0a0a0e; }
  .mr-cancel-btn {
    padding: 0.4rem 0.85rem;
    border-radius: var(--rad-sm);
    font-size: 0.82rem;
    background: none;
    border: 1px solid var(--line);
    color: var(--muted);
    cursor: pointer;
  }
  .mr-cancel-btn:hover { border-color: var(--muted); color: var(--ink-2); }

  /* ── Scrollable body ── */
  .mr-body {
    padding: 1rem 1.25rem 1.5rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-height: calc(100vh - 14rem);
  }

  /* ── Side-by-side raw view ── */
  .mr-side-by-side {
    display: grid;
    grid-template-columns: 1fr 1px 1fr;
    gap: 0;
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    overflow: hidden;
    background: var(--surface);
  }
  .mr-side { padding: 0.65rem 0.75rem; display: flex; flex-direction: column; gap: 0.18rem; min-height: 60px; }
  .mr-side-divider { background: var(--line); }
  .mr-side-title {
    font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.12em;
    color: var(--muted); margin: 0 0 0.35rem;
  }
  .mr-side-label-a { color: var(--accent); font-weight: 700; }
  .mr-side-label-b { color: var(--data); font-weight: 700; }
  .mr-triple {
    display: flex; align-items: baseline; gap: 0.35rem; flex-wrap: wrap;
    padding: 0.18rem 0.3rem; border-radius: 3px;
    font-size: 0.72rem;
  }
  .mr-triple:hover { background: var(--surface-2); }
  .mr-triple-type { background: color-mix(in srgb, var(--accent) 5%, transparent); }
  .mr-triple-pred { font-size: 0.6rem; color: var(--muted); flex-shrink: 0; }
  .mr-triple-obj { color: var(--ink-2); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mr-triple-src { font-size: 0.58rem; color: var(--muted); margin-left: auto; opacity: 0.7; }
  .mr-side-empty { font-size: 0.72rem; color: var(--muted); margin: 0.25rem 0; font-style: italic; }
  @media (max-width: 560px) {
    .mr-side-by-side { grid-template-columns: 1fr; }
    .mr-side-divider { width: 100%; height: 1px; }
  }

  /* ── Sections ── */
  .mr-section { display: flex; flex-direction: column; gap: 0.4rem; }
  .mr-section-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.72rem;
    color: var(--muted);
    margin: 0;
    font-weight: 400;
    flex-wrap: wrap;
  }

  /* Badges */
  .mr-badge {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    border-radius: 999px;
    padding: 0.1rem 0.5rem;
  }
  .mr-badge-shared   { background: color-mix(in srgb, var(--ok) 15%, var(--surface)); border: 1px solid var(--ok); color: var(--ok); }
  .mr-badge-conflict { background: color-mix(in srgb, var(--danger) 12%, var(--surface)); border: 1px solid var(--danger); color: var(--danger); }
  .mr-badge-a        { background: color-mix(in srgb, var(--accent) 12%, var(--surface)); border: 1px solid var(--accent); color: var(--accent); }
  .mr-badge-b        { background: color-mix(in srgb, var(--data) 12%, var(--surface)); border: 1px solid var(--data); color: var(--data); }
  .mr-badge-in       { background: var(--surface-2); border: 1px solid var(--line); color: var(--muted); }
  .mr-badge-ai       { background: color-mix(in srgb, purple 12%, var(--surface)); border: 1px solid purple; color: purple; }

  /* ── Rows ── */
  .mr-rows { display: flex; flex-direction: column; gap: 0.25rem; }
  .mr-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.38rem 0.65rem;
    border-radius: var(--rad-sm);
    font-size: 0.78rem;
    border: 1px solid transparent;
    flex-wrap: wrap;
  }
  .mr-row-shared   { background: color-mix(in srgb, var(--ok) 5%, var(--surface)); border-color: color-mix(in srgb, var(--ok) 20%, transparent); }
  .mr-row-a        { background: color-mix(in srgb, var(--accent) 5%, var(--surface)); border-color: color-mix(in srgb, var(--accent) 20%, transparent); }
  .mr-row-b        { background: color-mix(in srgb, var(--data) 5%, var(--surface)); border-color: color-mix(in srgb, var(--data) 20%, transparent); }
  .mr-row-in       { background: var(--surface-2); border-color: var(--line); }
  .mr-row-conflict { background: color-mix(in srgb, var(--danger) 5%, var(--surface)); border-color: color-mix(in srgb, var(--danger) 20%, transparent); }

  .mr-pred { font-size: 0.65rem; color: var(--muted); flex-shrink: 0; }
  .mr-obj  { flex: 1; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mr-row-badge { font-family: var(--font-mono); font-size: 0.58rem; color: var(--muted); margin-left: auto; }
  .mr-src-tag { font-size: 0.6rem; color: var(--muted); margin-left: auto; max-width: 10rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mr-in-sub { color: var(--ink-2); }
  .mr-in-target { font-family: var(--font-mono); font-size: 0.65rem; margin-left: auto; }
  .mr-in-target.mr-val-a { color: var(--accent); }
  .mr-in-target.mr-val-b { color: var(--data); }

  /* ── Conflict cards ── */
  .mr-conflict {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.55rem 0.7rem;
    border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
    border-radius: var(--rad-sm);
    background: color-mix(in srgb, var(--danger) 5%, var(--surface));
    flex-wrap: wrap;
  }
  .mr-conflict.resolved {
    border-color: color-mix(in srgb, var(--ok) 30%, transparent);
    background: color-mix(in srgb, var(--ok) 4%, var(--surface));
  }
  .mr-conflict-values { display: flex; align-items: center; gap: 0.4rem; flex: 1; flex-wrap: wrap; }
  .mr-conflict-val {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0.55rem;
    border-radius: var(--rad-sm);
    border: 1px solid var(--line);
    background: var(--surface);
    cursor: pointer;
    font-size: 0.78rem;
    transition: all 0.12s;
    color: var(--ink-2);
  }
  .mr-val-a:hover, .mr-val-a.chosen { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--surface)); color: var(--accent); }
  .mr-val-b:hover, .mr-val-b.chosen { border-color: var(--data); background: color-mix(in srgb, var(--data) 12%, var(--surface)); color: var(--data); }
  .mr-val-both:hover, .mr-val-both.chosen { border-color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, var(--surface)); color: var(--ok); }
  .mr-val-src { font-size: 0.6rem; font-weight: 700; }
  .mr-val-text { }
  .mr-chosen-mark { font-size: 0.75rem; }
  .mr-vs { font-size: 0.62rem; color: var(--muted); }

  /* ── Unique grid (2-col desktop) ── */
  .mr-unique-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }
  @media (max-width: 600px) {
    .mr-unique-grid { grid-template-columns: 1fr; }
  }

  /* ── Temporal ── */
  .mr-tc-vals { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.73rem; }
  .mr-tc-val { color: var(--danger); }
  .mr-tc-val .mono { color: var(--muted); }

  /* ── AI ── */
  .mr-ai-section { border: 1px solid var(--line); border-radius: var(--rad-sm); overflow: hidden; }
  .mr-ai-toggle {
    width: 100%; display: flex; align-items: center; gap: 0.5rem;
    padding: 0.65rem 0.85rem;
    background: var(--surface-2); border: none; cursor: pointer;
    font-size: 0.78rem; color: var(--ink-2); text-align: left;
    transition: background 0.12s;
  }
  .mr-ai-toggle:hover { background: var(--surface-3); }
  .mr-ai-chevron { margin-left: auto; font-size: 0.6rem; color: var(--muted); }
  .mr-ai-body { padding: 0.75rem; display: flex; flex-direction: column; gap: 0.65rem; }
  .mr-ai-messages {
    display: flex; flex-direction: column; gap: 0.6rem;
    max-height: 240px; overflow-y: auto;
    background: var(--surface-3); border-radius: var(--rad-sm); padding: 0.65rem;
    min-height: 60px;
  }
  .mr-ai-msg { font-size: 0.8rem; color: var(--ink-2); line-height: 1.45; white-space: pre-wrap; }
  .mr-ai-msg.user { color: var(--data); text-align: right; }
  .mr-ai-loading { font-size: 0.75rem; color: var(--muted); margin: 0; }
  .mr-ai-input { display: flex; gap: 0.4rem; }
  .mr-ai-input input {
    flex: 1; padding: 0.4rem 0.6rem;
    border: 1px solid var(--line); border-radius: var(--rad-sm);
    background: var(--surface-2); font-size: 0.82rem; color: var(--ink-2);
  }
  .mr-ai-input input:focus { border-color: var(--accent); outline: none; }

  /* ── IRI reference ── */
  .mr-iri-ref {
    display: flex; gap: 1rem; flex-wrap: wrap;
    font-size: 0.6rem; color: var(--muted); padding-top: 0.5rem;
    border-top: 1px solid var(--line);
  }
</style>
