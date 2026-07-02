<script lang="ts">
  import { termKey, isIRI, isLit } from '$lib/rdf/types';
  import type { Statement } from '$lib/rdf/types';
  import { officialKbActive } from '$lib/stores/official-kb.svelte';

  let {
    statements = [],
    onselectnode = () => {},
    onselectstatement = () => {},
    onshellyquery = null,
    onshellyopen = null
  } = $props<{
    statements?: Statement[];
    onselectnode?: (key: string) => void;
    onselectstatement?: (statementId: string, subjectKey: string) => void;
    onshellyquery?: ((q: string) => void) | null;
    onshellyopen?: (() => void) | null;
  }>();

  // ── State ────────────────────────────────────────────────────────────────────

  let query = $state('');
  let open = $state(false);
  let focusIdx = $state(-1);
  let inputEl: HTMLInputElement | undefined = $state();

  // ── Search index ─────────────────────────────────────────────────────────────

  type NodeResult = {
    kind: 'node';
    key: string;
    label: string;
    iri: string;
    degree: number;
  };
  type StmtResult = {
    kind: 'statement';
    id: string;
    subjectKey: string;
    sLabel: string;
    pLabel: string;
    oLabel: string;
    status: string;
    gloss: string;
  };
  type Result = NodeResult | StmtResult;

  const results = $derived.by((): Result[] => {
    const q = query.trim().toLowerCase();
    if (q.length < 1) return [];

    const degreeMap = new Map<string, number>();
    const nodeMap = new Map<string, NodeResult>();
    const stmtResults: StmtResult[] = [];

    for (const st of statements) {
      if (st.status === 'rejected' || st.status === 'superseded') continue;

      const sKey = termKey(st.s);
      const oKey = termKey(st.o);
      degreeMap.set(sKey, (degreeMap.get(sKey) ?? 0) + 1);
      degreeMap.set(oKey, (degreeMap.get(oKey) ?? 0) + 1);

      for (const term of [st.s, st.o]) {
        const k = termKey(term);
        if (!nodeMap.has(k)) {
          const label = isIRI(term)
            ? (term.value.split('/').pop() ?? term.value)
            : isLit(term)
              ? term.value.slice(0, 60)
              : `_:${term.value}`;
          nodeMap.set(k, {
            kind: 'node',
            key: k,
            label,
            iri: isIRI(term) ? term.value : '',
            degree: 0
          });
        }
      }

      // Statement-level match
      const sLabel = isIRI(st.s) ? (st.s.value.split('/').pop() ?? st.s.value) : st.s.value;
      const pLabel = st.p.value.split('/').pop() ?? st.p.value;
      const oLabel = isIRI(st.o)
        ? (st.o.value.split('/').pop() ?? st.o.value)
        : isLit(st.o) ? st.o.value : st.o.value;
      const gloss = st.gloss ?? '';
      const haystack = `${sLabel} ${pLabel} ${oLabel} ${gloss}`.toLowerCase();

      if (haystack.includes(q)) {
        stmtResults.push({
          kind: 'statement',
          id: st.id,
          subjectKey: sKey,
          sLabel,
          pLabel,
          oLabel: oLabel.slice(0, 60),
          status: st.status,
          gloss
        });
      }
    }

    // Patch degree counts
    for (const [k, deg] of degreeMap) {
      const n = nodeMap.get(k);
      if (n) n.degree = deg;
    }

    // Node results: filter + rank
    const nodeResults = [...nodeMap.values()].filter(n =>
      n.label.toLowerCase().includes(q) || n.iri.toLowerCase().includes(q)
    );

    nodeResults.sort((a, b) => {
      const score = (n: NodeResult) =>
        n.label.toLowerCase() === q ? 0
        : n.label.toLowerCase().startsWith(q) ? 1 : 2;
      const ds = score(a) - score(b);
      return ds !== 0 ? ds : b.degree - a.degree;
    });

    // Deduplicate stmtResults vs nodeResults: avoid repeating what's already shown
    const shownNodeKeys = new Set(nodeResults.slice(0, 5).map(n => n.key));
    const filteredStmts = stmtResults
      .filter(r => !shownNodeKeys.has(r.subjectKey))
      .slice(0, 6);

    return [...nodeResults.slice(0, 5), ...filteredStmts];
  });

  // A query looks "semantic" (natural language) when it has 2+ words or no keyword hits
  const isSemanticQuery = $derived.by(() => {
    const q = query.trim();
    return q.length > 2 && (q.includes(' ') || results.length === 0);
  });

  function askShelly() {
    const q = query.trim();
    if (q && onshellyquery) {
      onshellyquery(`I'm looking for: "${q}"`);
      query = '';
      open = false;
    } else if (onshellyopen) {
      open = false;
      onshellyopen();
    }
  }

  // ── Keyboard handling ─────────────────────────────────────────────────────────

  function globalKeydown(e: KeyboardEvent) {
    // Ctrl+K or just / when not in an input
    if ((e.ctrlKey && e.key === 'k') || (e.key === '/' && !['INPUT', 'TEXTAREA'].includes((e.target as Element)?.tagName))) {
      e.preventDefault();
      inputEl?.focus();
    }
  }

  function onInputKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      query = '';
      open = false;
      inputEl?.blur();
    } else if (e.key === 'ArrowDown') {
      focusIdx = Math.min(focusIdx + 1, results.length - 1);
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      focusIdx = Math.max(focusIdx - 1, -1);
      e.preventDefault();
    } else if (e.key === 'Enter' && focusIdx >= 0 && focusIdx < results.length) {
      pick(results[focusIdx]);
    }
  }

  function pick(r: Result) {
    if (r.kind === 'node') {
      onselectnode(r.key);
    } else {
      onselectstatement(r.id, r.subjectKey);
    }
    query = '';
    open = false;
    focusIdx = -1;
  }

  function onInput() {
    open = true;
    focusIdx = -1;
  }

  function onFocus() {
    if (query) open = true;
  }

  function onBlur(e: FocusEvent) {
    // Keep open if focus moved inside the dropdown
    const rel = e.relatedTarget as Element | null;
    if (!rel?.closest('.sb-dropdown')) {
      open = false;
      focusIdx = -1;
    }
  }

  function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Highlight the matching part of a string, HTML-escaping all text segments
  function highlight(text: string, q: string): string {
    if (!q) return escHtml(text);
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return escHtml(text);
    return (
      escHtml(text.slice(0, idx)) +
      '<mark>' +
      escHtml(text.slice(idx, idx + q.length)) +
      '</mark>' +
      escHtml(text.slice(idx + q.length))
    );
  }

  const STATUS_ICON: Record<string, string> = {
    confirmed: '✓',
    pending: '·',
    refined: '✎',
  };
</script>

<svelte:window onkeydown={globalKeydown} />

<div class="sb-wrap" class:banner-offset={officialKbActive()}>
  <div class="sb-box" class:open>
    <span class="sb-icon">⌕</span>
    <input
      bind:this={inputEl}
      class="sb-input"
      type="text"
      bind:value={query}
      oninput={onInput}
      onfocus={onFocus}
      onblur={onBlur}
      onkeydown={onInputKeydown}
      placeholder="search nodes or facts…"
      autocomplete="off"
      spellcheck="false"
    />
    {#if query}
      <button class="sb-clear ghost" onclick={() => { query = ''; open = false; inputEl?.focus(); }}>✕</button>
    {:else}
      <kbd class="sb-hint mono">/ or ⌃K</kbd>
    {/if}
    {#if onshellyopen || onshellyquery}
      <button class="sb-shelly-pill" onclick={askShelly} title="Ask Shelly"><img src="/svg/head1.svg" alt="" class="sb-shelly-head" /></button>
    {/if}
  </div>

  {#if open && results.length > 0}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="sb-dropdown" onmousedown={(e) => e.preventDefault()}>

      {#if results.some(r => r.kind === 'node')}
        <p class="sb-section-title mono">nodes</p>
        {#each results.filter(r => r.kind === 'node') as r, i (r.kind === 'node' ? r.key : '')}
          {#if r.kind === 'node'}
            {@const idx = results.indexOf(r)}
            <button
              class="sb-row sb-node-row"
              class:focused={focusIdx === idx}
              onclick={() => pick(r)}
              onmouseenter={() => (focusIdx = idx)}
            >
              <span class="sb-node-label">{@html highlight(r.label, query.trim())}</span>
              {#if r.iri}
                <span class="sb-node-iri mono">{r.iri.split('/').slice(0, -1).join('/').split('/').pop() ?? ''}/{@html highlight(r.iri.split('/').pop() ?? '', query.trim())}</span>
              {/if}
              <span class="sb-degree mono">{r.degree}</span>
            </button>
          {/if}
        {/each}
      {/if}

      {#if results.some(r => r.kind === 'statement')}
        <p class="sb-section-title mono" style="margin-top: 0.4rem;">facts</p>
        {#each results.filter(r => r.kind === 'statement') as r (r.kind === 'statement' ? r.id : '')}
          {#if r.kind === 'statement'}
            {@const idx = results.indexOf(r)}
            <button
              class="sb-row sb-stmt-row"
              class:focused={focusIdx === idx}
              onclick={() => pick(r)}
              onmouseenter={() => (focusIdx = idx)}
            >
              <span class="sb-stmt-status mono">{STATUS_ICON[r.status] ?? '?'}</span>
              <span class="sb-stmt-body">
                <span class="sb-stmt-s">{@html highlight(r.sLabel, query.trim())}</span>
                <span class="sb-stmt-sep mono">·{r.pLabel}·</span>
                <span class="sb-stmt-o">{@html highlight(r.oLabel, query.trim())}</span>
              </span>
            </button>
          {/if}
        {/each}
      {/if}

      {#if onshellyquery && isSemanticQuery}
        <div class="sb-shelly-row">
          <button class="sb-shelly-btn" onclick={askShelly}>
            <img src="/svg/head1.svg" alt="" class="sb-shelly-head" />
            <span class="sb-shelly-label">ask Shelly about "{query.trim()}"</span>
          </button>
        </div>
      {/if}

    </div>
  {:else if open && query.trim().length > 0}
    <div class="sb-dropdown sb-empty">
      <p class="sb-no-results mono">no results for "{query.trim()}"</p>
      {#if onshellyquery}
        <button class="sb-shelly-btn sb-shelly-prominent" onclick={askShelly}>
          <img src="/svg/head1.svg" alt="" class="sb-shelly-head" />
          <span class="sb-shelly-label">ask Shelly</span>
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .sb-wrap {
    position: fixed;
    top: 0.85rem;
    left: 50%;
    transform: translateX(-50%);
    width: 440px;
    max-width: calc(100vw - 2rem);
    z-index: 390;
    transition: top 0.2s ease;
  }
  .sb-wrap.banner-offset {
    top: 2.65rem;
  }

  .sb-box {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: rgba(16, 16, 22, 0.88);
    backdrop-filter: blur(14px);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 0.45rem 0.75rem;
    transition: border-color 0.15s, box-shadow 0.15s;
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  }
  .sb-box.open,
  .sb-box:focus-within {
    border-color: var(--accent);
    box-shadow: 0 4px 20px rgba(0,0,0,0.4), 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent);
  }

  .sb-icon {
    font-size: 1rem;
    color: var(--muted);
    flex-shrink: 0;
    line-height: 1;
  }

  .sb-input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    font-size: 0.88rem;
    color: var(--ink-2);
    font-family: inherit;
  }
  .sb-input::placeholder { color: var(--muted); }

  .sb-clear {
    font-size: 0.75rem;
    color: var(--muted);
    padding: 0.15rem 0.3rem;
    flex-shrink: 0;
  }
  .sb-hint {
    font-size: 0.6rem;
    color: var(--muted);
    opacity: 0.6;
    white-space: nowrap;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0.1rem 0.35rem;
    flex-shrink: 0;
  }

  /* Dropdown */
  .sb-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    background: rgba(14, 14, 20, 0.96);
    backdrop-filter: blur(16px);
    border: 1px solid var(--accent);
    border-radius: var(--rad);
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    padding: 0.5rem 0;
  }
  .sb-section-title {
    font-size: 0.58rem;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--muted);
    margin: 0;
    padding: 0 0.75rem 0.25rem;
  }

  /* Rows */
  .sb-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s;
    min-height: 40px;
    font-size: 0.82rem;
    color: var(--ink-2);
  }
  .sb-row.focused,
  .sb-row:hover {
    background: color-mix(in srgb, var(--accent) 10%, var(--surface));
  }

  /* Node row */
  .sb-node-label {
    flex: 1;
    color: var(--accent);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sb-node-iri {
    font-size: 0.62rem;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 40%;
  }
  .sb-degree {
    font-size: 0.62rem;
    color: var(--muted);
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0.05rem 0.4rem;
    flex-shrink: 0;
  }

  /* Statement row */
  .sb-stmt-status {
    font-size: 0.75rem;
    color: var(--muted);
    flex-shrink: 0;
    width: 1rem;
    text-align: center;
  }
  .sb-stmt-body {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    flex-wrap: wrap;
    flex: 1;
    font-size: 0.78rem;
    overflow: hidden;
  }
  .sb-stmt-s { color: var(--accent); font-weight: 500; }
  .sb-stmt-sep { font-size: 0.65rem; color: var(--muted); white-space: nowrap; }
  .sb-stmt-o { color: var(--data); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 10rem; }

  /* Empty */
  .sb-empty { padding: 0.75rem; display: flex; flex-direction: column; align-items: center; gap: 0.6rem; }
  .sb-no-results { font-size: 0.78rem; color: var(--muted); margin: 0; text-align: center; }

  /* Persistent Shelly button in search bar */
  .sb-shelly-pill {
    flex-shrink: 0;
    background: none;
    border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line));
    border-radius: 999px;
    padding: 0.1rem 0.45rem;
    font-size: 0.85rem;
    cursor: pointer;
    line-height: 1;
    transition: background 0.12s, border-color 0.12s;
    color: var(--accent);
  }
  .sb-shelly-pill:hover {
    background: var(--accent-soft);
    border-color: var(--accent);
  }

  /* Shelly row */
  .sb-shelly-row {
    border-top: 1px solid var(--line);
    margin-top: 0.25rem;
    padding: 0.25rem 0 0;
  }
  .sb-shelly-btn {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    color: var(--accent);
    font-size: 0.8rem;
    border-radius: var(--rad-sm);
    transition: background 0.1s;
  }
  .sb-shelly-btn:hover { background: color-mix(in srgb, var(--accent) 10%, var(--surface)); }
  .sb-shelly-head { height: 1rem; width: auto; flex-shrink: 0; }
  .sb-shelly-label { font-family: var(--font-mono); font-size: 0.75rem; }
  .sb-shelly-prominent {
    border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line));
    border-radius: var(--rad);
    padding: 0.5rem 1rem;
  }

  /* highlight */
  :global(.sb-dropdown mark) {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
    color: var(--accent);
    border-radius: 2px;
    padding: 0 1px;
  }

  /* Mobile: narrower, push below nav if needed */
  @media (max-width: 640px) {
    .sb-wrap {
      top: 0.5rem;
      width: calc(100vw - 1rem);
    }
    .sb-wrap.banner-offset {
      top: 2.3rem;
    }
    .sb-hint { display: none; }
  }
</style>
