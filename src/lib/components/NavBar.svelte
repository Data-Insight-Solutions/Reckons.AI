<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { pendingStatements } from '$lib/stores/kb.svelte';
  import { analysisRunning, runAndStoreAnalysis } from '$lib/stores/auto-analyze.svelte';
  import type { AnalysisType } from '$lib/integrations/llm/re-analyze';

  const items: { href: string; label: string; glyph?: string; svg?: string; img?: string; small?: boolean }[] = [
    { href: '/', label: 'graph' },
    { href: '/ingest', label: 'ingest', glyph: '＋' },
    { href: '/review', label: 'review', glyph: '◐' },
    { href: '/reckoning', label: 'reckon', glyph: '⟁' },
    { href: '/kb', label: 'kb', svg: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" width="14" height="14"><line x1="4" y1="4" x2="10" y2="4"/><line x1="4" y1="4" x2="7" y2="10"/><line x1="10" y1="4" x2="7" y2="10"/><circle cx="4" cy="4" r="1.5" fill="currentColor" stroke="none"/><circle cx="10" cy="4" r="1.5" fill="currentColor" stroke="none"/><circle cx="7" cy="10" r="1.5" fill="currentColor" stroke="none"/></svg>` },
  ];

  const smallItems = [
    { href: '/settings', label: 'settings', svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width="14" height="14"><path stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94H9.782c-.55 0-1.02-.397-1.11-.94l-.214-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.281Z"/><path stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/></svg>` },
    { href: '/about', label: 'info', glyph: 'ⓘ' },
  ];

  const DEFAULT_ACTIONS: { type: AnalysisType; glyph: string; label: string }[] = [
    { type: 'enrich',       glyph: '◎', label: 'enrich'        },
    { type: 'merge',        glyph: '⟷', label: 'merge'         },
    { type: 'entity-types', glyph: '◈', label: 'types'         },
    { type: 'delete',       glyph: '✕', label: 'prune'         },
  ];

  const REVIEW_ACTIONS: { type: AnalysisType; glyph: string; label: string }[] = [
    { type: 'enrich',       glyph: '◎', label: 'enrich'        },
    { type: 'align',        glyph: '⊕', label: 'align'         },
    { type: 'entity-types', glyph: '◈', label: 'types'         },
    { type: 'delete',       glyph: '✕', label: 'prune'         },
  ];

  const analysisActions = $derived(
    page.url.pathname.startsWith('/review') ? REVIEW_ACTIONS : DEFAULT_ACTIONS
  );

  const pendingCount = $derived(pendingStatements().length);
  const running = $derived(analysisRunning());

  let analyzeOpen = $state(false);

  function toggleAnalyze(e: MouseEvent) {
    e.stopPropagation();
    analyzeOpen = !analyzeOpen;
  }

  async function runAnalysis(type: AnalysisType) {
    analyzeOpen = false;
    if (type === 'align') {
      // Navigate to review page's align tab instead of running LLM analysis
      await goto('/review?tab=align');
      return;
    }
    await runAndStoreAnalysis('manual', type);
  }

  function closePopup() { analyzeOpen = false; }
</script>

<svelte:window onclick={closePopup} />

{#if analyzeOpen}
  <div class="analyze-popup" role="menu" aria-label="Analysis actions" onclick={(e) => e.stopPropagation()}>
    {#each analysisActions as action}
      <button
        class="popup-item"
        role="menuitem"
        onclick={() => runAnalysis(action.type)}
        disabled={running}
        title={action.label}
        aria-label={action.label}
      >
        <span class="popup-glyph">{action.glyph}</span>
        <span class="popup-label">{action.label}</span>
      </button>
      {#if action !== analysisActions[analysisActions.length - 1]}
        <div class="popup-divider"></div>
      {/if}
    {/each}
  </div>
{/if}

<nav aria-label="Main navigation">
  <a href="/" class="wordmark" class:active={page.url.pathname === '/'} aria-label="Reckons.AI — graph view">
    <img src="/svg/circlegraph.svg" alt="Reckons.AI" class="wm-logo" />
  </a>
  <div class="divider"></div>
  {#each items.slice(1) as it, i}
    <a
      href={it.href}
      aria-label={it.label}
      class:active={page.url.pathname === it.href ||
        (it.href !== '/' && page.url.pathname.startsWith(it.href))}
    >
      <span class="glyph-wrap">
        {#if it.svg}
          <span class="glyph glyph-svg">{@html it.svg}</span>
        {:else if it.img}
          <img src={it.img} alt="" class="glyph-img" />
        {:else}
          <span class="glyph">{it.glyph}</span>
        {/if}
        {#if it.href === '/review' && pendingCount > 0}
          <span class="badge">{pendingCount > 99 ? '99+' : pendingCount}</span>
        {/if}
      </span>
      <span class="label">{it.label}</span>
    </a>
    {#if i === 1}
      <!-- Analyze popup button sits between review and reckon -->
      <button
        class="nav-btn"
        class:active={analyzeOpen}
        class:running
        onclick={toggleAnalyze}
        title="analyze"
        aria-label="Analyze knowledge base"
        aria-expanded={analyzeOpen}
      >
        <span class="glyph-wrap">
          <span class="glyph">◈</span>
          {#if running}
            <span class="badge running">…</span>
          {/if}
        </span>
        <span class="label">analyze</span>
      </button>
    {/if}
  {/each}

  <div class="divider"></div>
  <!-- Settings + Info stacked in a single right-side slot -->
  <div class="nav-pair">
    {#each smallItems as it, i}
      <a
        href={it.href}
        class="nav-pair-item"
        class:active={page.url.pathname === it.href ||
          (it.href !== '/' && page.url.pathname.startsWith(it.href))}
        title={it.label}
        aria-label={it.label}
      >
        {#if it.svg}
          <span class="nav-pair-svg">{@html it.svg}</span>
        {:else}
          <span class="glyph nav-pair-glyph">{it.glyph}</span>
        {/if}
      </a>
      {#if i < smallItems.length - 1}
        <div class="pair-divider"></div>
      {/if}
    {/each}
  </div>
</nav>

<style>
  nav {
    position: fixed;
    z-index: 400;
    left: 50%;
    bottom: max(1rem, env(safe-area-inset-bottom));
    transform: translateX(-50%);
    display: flex;
    gap: 0.15rem;
    padding: 0.4rem;
    background: rgba(20, 20, 26, 0.78);
    backdrop-filter: blur(18px) saturate(140%);
    -webkit-backdrop-filter: blur(18px) saturate(140%);
    border: 1px solid var(--line);
    border-radius: 999px;
    box-shadow: var(--shadow-1);
  }
  a {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 0.55rem 0.85rem;
    border-radius: 999px;
    color: var(--muted);
    border: none;
    transition: color 0.15s, background 0.15s;
    min-width: 56px;
  }
  a:hover { color: var(--ink); background: var(--surface-2); }
  a.active {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .glyph-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .glyph {
    font-size: 1.1rem;
    line-height: 1;
    font-family: var(--font-mono);
  }
  .glyph-svg {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .glyph-img {
    height: 1.15rem;
    width: auto;
    display: block;
    opacity: 0.75;
    transition: opacity 0.15s;
  }
  a:hover .glyph-img,
  a.active .glyph-img {
    opacity: 1;
  }
  /* SVG is rendered via {@html}, so scoped styles won't reach it — use :global */
  .glyph-svg :global(svg) {
    width: 1.15rem;
    height: 1.3rem;
    display: block;
  }
  .badge {
    position: absolute;
    top: -5px;
    right: -8px;
    background: var(--accent);
    color: #fff;
    font-family: var(--font-mono);
    font-size: 0.52rem;
    font-weight: 700;
    line-height: 1;
    padding: 2px 4px;
    border-radius: 999px;
    min-width: 14px;
    text-align: center;
  }
  /* ── Analyze popup ── */
  .analyze-popup {
    position: fixed;
    z-index: 21;
    left: 50%;
    bottom: calc(max(1rem, env(safe-area-inset-bottom)) + 68px);
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 0;
    padding: 0.35rem;
    background: rgba(20, 20, 26, 0.92);
    backdrop-filter: blur(18px) saturate(140%);
    -webkit-backdrop-filter: blur(18px) saturate(140%);
    border: 1px solid var(--line);
    border-radius: 999px;
    box-shadow: var(--shadow-1), 0 0 0 1px rgba(255,255,255,0.04);
    animation: popup-in 0.14s ease-out;
  }
  @keyframes popup-in {
    from { opacity: 0; transform: translateX(-50%) translateY(6px) scale(0.97); }
    to   { opacity: 1; transform: translateX(-50%) translateY(0)   scale(1);    }
  }
  .popup-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.18rem;
    padding: 0.5rem 0.9rem;
    border-radius: 999px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--muted);
    font-family: inherit;
    transition: color 0.12s, background 0.12s;
    min-width: 52px;
  }
  .popup-item:hover:not(:disabled) { color: var(--accent); background: var(--accent-soft); }
  .popup-item:disabled { opacity: 0.4; cursor: not-allowed; }
  .popup-glyph {
    font-size: 1.05rem;
    line-height: 1;
    font-family: var(--font-mono);
  }
  .popup-label {
    font-family: var(--font-mono);
    font-size: 0.55rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .popup-divider {
    width: 1px;
    height: 22px;
    background: var(--line);
    flex-shrink: 0;
  }

  /* ── Analyze nav button (not an <a>) ── */
  .nav-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 0.55rem 0.85rem;
    border-radius: 999px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--muted);
    font-family: inherit;
    transition: color 0.15s, background 0.15s;
    min-width: 56px;
  }
  .nav-btn:hover { color: var(--ink); background: var(--surface-2); }
  .nav-btn.active {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .nav-btn.running { color: var(--data); }

  .badge.running {
    background: var(--data);
    animation: pulse 1s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .label {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-top: 0.2rem;
  }
  a.wordmark {
    padding: 0.35rem 0.6rem;
    min-width: unset;
  }
  .wm-logo {
    height: 1.5rem;
    width: auto;
    display: block;
    opacity: 0.7;
    transition: opacity 0.15s;
    border-radius: 50%;
  }
  a.wordmark.active .wm-logo,
  a.wordmark:hover .wm-logo {
    opacity: 1;
  }
  .divider {
    width: 1px;
    height: 24px;
    background: var(--line);
    align-self: center;
    margin: 0 0.1rem;
  }

  /* ── Settings + Info stacked pair ── */
  .nav-pair {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    flex-shrink: 0;
    /* Wrap in a subtle inset container to visually group the two mini buttons */
    background: rgba(255,255,255,0.04);
    border-radius: 8px;
    overflow: hidden;
    margin: 0 0.1rem;
    align-self: center;
  }
  .nav-pair-item {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.22rem 0.6rem;
    border-radius: 0;
    border: none;
    min-width: 34px;
    color: var(--muted);
    transition: color 0.12s, background 0.12s;
  }
  .nav-pair-item:hover { color: var(--ink); background: var(--surface-2); }
  .nav-pair-item.active { color: var(--accent); background: var(--accent-soft); }
  .nav-pair-glyph {
    font-size: 0.88rem;
    line-height: 1;
    font-family: var(--font-mono);
  }
  .pair-divider {
    height: 1px;
    background: var(--line);
  }
  .nav-pair-svg {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  /* SVG rendered via @html — needs :global to reach inner elements */
  .nav-pair-svg :global(svg) {
    display: block;
    width: 14px;
    height: 14px;
  }

  /* ── Mobile: compress nav to fit iPhone 375–393px ── */
  @media (max-width: 500px) {
    nav {
      gap: 0;
      padding: 0.25rem 0.15rem;
      /* Ensure nav fits on small screens */
      max-width: calc(100vw - 1rem);
    }

    /* Labels hidden — glyphs only, saves ~50px total */
    .label { display: none; }

    a.wordmark { padding: 0.3rem 0.4rem; }
    .wm-logo { height: 1.3rem; }

    a:not(.wordmark), .nav-btn {
      padding: 0.5rem 0.55rem;
      min-width: 40px;
    }

    /* nav-pair: increase tap targets to 44px minimum */
    .nav-pair { margin: 0; border-radius: 6px; }
    .nav-pair-item {
      padding: 0.45rem 0.5rem;
      min-width: 32px;
    }

    .divider { margin: 0; height: 20px; }
  }

  /* Extra-small screens (iPhone SE, 320-375px) */
  @media (max-width: 380px) {
    nav {
      padding: 0.2rem 0.1rem;
    }
    a:not(.wordmark), .nav-btn {
      padding: 0.45rem 0.4rem;
      min-width: 36px;
    }
    .glyph { font-size: 1rem; }
    .glyph-svg :global(svg) { width: 1rem; height: 1.1rem; }
    .nav-pair-item { padding: 0.35rem 0.4rem; min-width: 28px; }
  }
</style>
