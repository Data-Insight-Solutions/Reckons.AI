<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { pendingStatements } from '$lib/stores/kb.svelte';
  import { analysisRunning, runAndStoreAnalysis } from '$lib/stores/auto-analyze.svelte';
  import type { AnalysisType } from '$lib/integrations/llm/re-analyze';
  import { openFeedback } from '$lib/stores/feedback.svelte';

  const items: { href: string; label: string; glyph?: string; svg?: string; img?: string; small?: boolean }[] = [
    // Labels are the USER register from static/reckons-terminology.ttl, not the
    // developer one. kterm:graph-view records the decision: the user-facing word
    // is "space", and it deliberately spans BOTH 2D and 3D, because switching
    // dimension is a change of view and not a change of thing.
    { href: '/', label: 'space' },
    { href: '/ingest', label: 'add', glyph: '＋' },
    { href: '/review', label: 'review', glyph: '◐' },
    { href: '/reckoning', label: 'reckon', glyph: '⟁' },
    { href: '/kb', label: 'spaces', svg: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" width="14" height="14"><line x1="4" y1="4" x2="10" y2="4"/><line x1="4" y1="4" x2="7" y2="10"/><line x1="10" y1="4" x2="7" y2="10"/><circle cx="4" cy="4" r="1.5" fill="currentColor" stroke="none"/><circle cx="10" cy="4" r="1.5" fill="currentColor" stroke="none"/><circle cx="7" cy="10" r="1.5" fill="currentColor" stroke="none"/></svg>` },
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
  let moreOpen = $state(false);
  let addOpen = $state(false);
  let hydrated = $state(false);
  let analyzeTrigger = $state<HTMLButtonElement>();
  let addTrigger = $state<HTMLButtonElement>();
  let addMenu = $state<HTMLDivElement>();
  let moreTrigger = $state<HTMLButtonElement>();
  let analyzeMenu = $state<HTMLDivElement>();
  let moreMenu = $state<HTMLDivElement>();
  let activePopup = $state<'analyze' | 'more' | 'add' | null>(null);

  /**
   * The add quick menu (Matt, 2026-09-30). It leads with WHAT you are adding — "Add should display
   * statement, set, space" — and a source comes first, because adding whole documents is the main
   * goal. Below that, the channels a source can arrive through. Each entry opens the right place
   * already set up (?mode= on /ingest, ?new=space on /kb), so the common ways in are one click from
   * any page. Labels are the user register: "link" not "url", "space file" not "kb".
   */
  type AddAction = { href: string; label: string; glyph: string; hint: string };
  const addGroups: { name: string; actions: AddAction[] }[] = [
    {
      name: 'new',
      actions: [
        { href: '/ingest?mode=document', label: 'source', glyph: '▤', hint: 'a whole document — its facts are read for review' },
        { href: '/ingest?mode=triples', label: 'statement', glyph: '⟶', hint: 'a fact, written by hand' },
        { href: '/?add=set', label: 'collection', glyph: '⬡', hint: 'group nodes you select in your space' },
        { href: '/kb?new=space', label: 'space', glyph: '◯', hint: 'a new, empty space' },
      ],
    },
    {
      name: 'from',
      actions: [
        { href: '/ingest?mode=note', label: 'note', glyph: '✎', hint: 'write or dictate' },
        { href: '/ingest?mode=url', label: 'link', glyph: '↗', hint: 'a web page' },
        { href: '/ingest?mode=folder', label: 'folder', glyph: '▭', hint: 'many files at once' },
        { href: '/ingest?mode=repo', label: 'repository', glyph: '⑂', hint: 'a code repository' },
        { href: '/ingest?mode=calendar', label: 'calendar', glyph: '▦', hint: 'events' },
        { href: '/ingest?mode=reminder', label: 'reminder', glyph: '◷', hint: 'something due' },
        { href: '/ingest?mode=kb', label: 'space file', glyph: '⬢', hint: 'a .ttl another space was exported to' },
      ],
    },
  ];

  const triggerFor = (kind: typeof activePopup) => (kind === 'analyze' ? analyzeTrigger : kind === 'more' ? moreTrigger : kind === 'add' ? addTrigger : null);

  onMount(() => { hydrated = true; });

  async function focusFirstItem(kind: 'analyze' | 'more' | 'add') {
    await tick();
    const menu = kind === 'analyze' ? analyzeMenu : kind === 'add' ? addMenu : moreMenu;
    menu?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }

  async function toggleAnalyze(e: MouseEvent) {
    e.stopPropagation();
    const opening = !analyzeOpen;
    analyzeOpen = opening;
    moreOpen = false;
    addOpen = false;
    activePopup = opening ? 'analyze' : null;
    if (opening) await focusFirstItem('analyze');
  }

  async function toggleMore(e: MouseEvent) {
    e.stopPropagation();
    const opening = !moreOpen;
    moreOpen = opening;
    analyzeOpen = false;
    addOpen = false;
    activePopup = opening ? 'more' : null;
    if (opening) await focusFirstItem('more');
  }

  async function toggleAdd(e: MouseEvent) {
    e.stopPropagation();
    const opening = !addOpen;
    addOpen = opening;
    analyzeOpen = false;
    moreOpen = false;
    activePopup = opening ? 'add' : null;
    if (opening) await focusFirstItem('add');
  }

  async function openAdd(href = '/ingest') {
    addOpen = false;
    activePopup = null;
    await goto(href);
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

  function openMobileFeedback() {
    moreOpen = false;
    openFeedback(page.url.pathname);
  }

  function closePopup(restoreFocus = false) {
    const trigger = triggerFor(activePopup);
    analyzeOpen = false;
    moreOpen = false;
    addOpen = false;
    activePopup = null;
    if (restoreFocus) queueMicrotask(() => trigger?.focus());
  }

  function handleMenuKeydown(e: KeyboardEvent) {
    const menu = e.currentTarget as HTMLElement;
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    let target: HTMLElement | undefined;
    if (e.key === 'ArrowDown') target = items[(index + 1 + items.length) % items.length];
    else if (e.key === 'ArrowUp') target = items[(index - 1 + items.length) % items.length];
    else if (e.key === 'Home') target = items[0];
    else if (e.key === 'End') target = items.at(-1);
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePopup(true);
      return;
    } else if (e.key === 'Tab') {
      // Leave the disclosure in the same direction as ordinary sequential navigation. Returning
      // focus to the trigger traps keyboard users for an extra keystroke and makes Tab behave like
      // Escape. Resolve the next visible control before the menu disappears, then move there after
      // Svelte removes the popup.
      const trigger = triggerFor(activePopup);
      const focusable = [...document.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !menu.contains(element) && !element.classList.contains('popup-scrim');
      });
      const triggerIndex = trigger ? focusable.indexOf(trigger) : -1;
      const destination = triggerIndex < 0
        ? null
        : focusable[triggerIndex + (e.shiftKey ? -1 : 1)] ?? null;
      e.preventDefault();
      e.stopPropagation();
      closePopup(false);
      queueMicrotask(() => destination?.focus());
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    target?.focus();
  }

  function handleWindowKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && (analyzeOpen || moreOpen || addOpen)) {
      e.preventDefault();
      closePopup(true);
    }
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#if analyzeOpen || moreOpen || addOpen}
  <button
    type="button"
    class="popup-scrim"
    aria-label="Close navigation menu"
    tabindex="-1"
    onclick={() => closePopup(true)}
  ></button>
{/if}

{#if addOpen}
  <div
    id="add-actions-menu"
    class="analyze-popup add-popup"
    bind:this={addMenu}
    role="menu"
    tabindex="-1"
    aria-label="Ways to add"
    onclick={(e) => e.stopPropagation()}
    onkeydown={handleMenuKeydown}
  >
    {#each addGroups as group, g}
      {#if g > 0}<div class="popup-divider"></div>{/if}
      <div class="popup-group mono" aria-hidden="true">{group.name}</div>
      {#each group.actions as action}
        <button class="popup-item" role="menuitem" onclick={() => openAdd(action.href)}>
          <span class="popup-glyph">{action.glyph}</span>
          <span class="add-text"><span class="popup-label">{action.label}</span><span class="add-hint">{action.hint}</span></span>
        </button>
      {/each}
    {/each}
    <div class="popup-divider"></div>
    <button class="popup-item" role="menuitem" onclick={() => openAdd()}>
      <span class="popup-glyph">＋</span>
      <span class="add-text"><span class="popup-label">all ways to add…</span></span>
    </button>
  </div>
{/if}

{#if analyzeOpen}
  <div
    id="analyze-actions-menu"
    class="analyze-popup"
    bind:this={analyzeMenu}
    role="menu"
    tabindex="-1"
    aria-label="Analysis actions"
    onclick={(e) => e.stopPropagation()}
    onkeydown={handleMenuKeydown}
  >
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

{#if moreOpen}
  <div
    id="mobile-more-menu"
    class="mobile-more-popup"
    bind:this={moreMenu}
    role="menu"
    tabindex="-1"
    aria-label="More navigation"
    onclick={(e) => e.stopPropagation()}
    onkeydown={handleMenuKeydown}
  >
    {#each smallItems as it}
      <a
        href={it.href}
        class="mobile-more-item"
        class:active={page.url.pathname === it.href || page.url.pathname.startsWith(it.href)}
        role="menuitem"
        onclick={() => { moreOpen = false; }}
      >
        {#if it.svg}
          <span class="nav-pair-svg">{@html it.svg}</span>
        {:else}
          <span class="glyph nav-pair-glyph">{it.glyph}</span>
        {/if}
        <span>{it.label}</span>
      </a>
    {/each}
    <button class="mobile-more-item" role="menuitem" onclick={openMobileFeedback}>
      <span class="glyph nav-pair-glyph">✎</span>
      <span>send feedback</span>
    </button>
  </div>
{/if}

<nav aria-label="Main navigation">
  <a href="/" class="wordmark" class:active={page.url.pathname === '/'} aria-label="Reckons.AI — space">
    <img src="/svg/circlegraph.svg" alt="Reckons.AI" class="wm-logo" />
  </a>
  <div class="divider"></div>
  {#each items.slice(1) as it, i}
    {#if it.href === '/ingest'}
      <!-- The add quick menu: one click from anywhere into a specific way of adding. -->
      <button
        bind:this={addTrigger}
        class="nav-btn add-trigger"
        class:active={addOpen || page.url.pathname.startsWith('/ingest')}
        onclick={toggleAdd}
        aria-label="add"
        aria-haspopup="menu"
        aria-expanded={addOpen}
        aria-controls="add-actions-menu"
        disabled={!hydrated}
      >
        <span class="glyph-wrap"><span class="glyph">{it.glyph}</span></span>
        <span class="label">{it.label}</span>
      </button>
    {:else}
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
    {/if}
    {#if i === 1}
      <!-- Analyze popup button sits between review and reckon -->
      <button
        bind:this={analyzeTrigger}
        class="nav-btn"
        class:active={analyzeOpen}
        class:running
        onclick={toggleAnalyze}
        title="analyze"
        aria-label="Analyze space"
        aria-haspopup="menu"
        aria-expanded={analyzeOpen}
        aria-controls="analyze-actions-menu"
        disabled={!hydrated}
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
    <div class="pair-divider"></div>
    <!-- Feedback from ANY page. Opens in place rather than navigating to /about, so the user
         keeps the state they were annoyed about and we learn which page the friction was on. -->
    <button
      class="nav-pair-item nav-feedback"
      title="send feedback"
      aria-label="send feedback"
      disabled={!hydrated}
      onclick={() => openFeedback(page.url.pathname)}
    >
      <span class="glyph nav-pair-glyph">✎</span>
    </button>
  </div>
  <button
    bind:this={moreTrigger}
    class="nav-more"
    class:active={moreOpen || smallItems.some((it) => page.url.pathname.startsWith(it.href))}
    title="more"
    aria-label="More"
    aria-haspopup="menu"
    aria-expanded={moreOpen}
    aria-controls="mobile-more-menu"
    disabled={!hydrated}
    onclick={toggleMore}
  >
    <span class="glyph">⋯</span>
    <span class="label">more</span>
  </button>
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
  .popup-scrim {
    position: fixed;
    z-index: 399;
    inset: 0;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: default;
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
    z-index: 401;
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
  .nav-btn:disabled,
  .nav-feedback:disabled,
  .nav-more:disabled {
    opacity: 0.55;
    cursor: wait;
  }
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
  /* The feedback item is a <button> among <a> siblings — strip the UA button styling so it is
     visually indistinguishable from them. It has no .active state: it opens a dialog rather
     than navigating, so there is no route for it to be "on". */
  .nav-feedback {
    background: none;
    font: inherit;
    cursor: pointer;
    appearance: none;
  }
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

  /* Mobile-only disclosure: secondary destinations should not turn the phone
     nav into a row of undersized mystery icons. */
  .nav-more,
  .mobile-more-popup {
    display: none;
  }

  /* ── Mobile: compress nav to fit iPhone 375–393px ── */
  @media (max-width: 640px) {
    nav {
      /* Full-width bottom bar on mobile — was a cramped centred pill (F36). */
      left: 0;
      right: 0;
      bottom: 0;
      transform: none;
      max-width: none;
      width: 100%;
      gap: 0;
      justify-content: space-around;
      padding: 0.25rem 0.15rem calc(0.25rem + env(safe-area-inset-bottom));
      border-radius: 0;
      border-left: none;
      border-right: none;
    }

    /* Labels hidden — glyphs only, saves ~50px total */
    .label { display: none; }

    a.wordmark {
      padding: 0.3rem 0.4rem;
      min-width: 44px;
      min-height: 44px;
    }
    .wm-logo { height: 1.3rem; }

    a:not(.wordmark), .nav-btn {
      padding: 0.5rem 0.55rem;
      min-width: 44px;
      min-height: 44px;
    }

    /* Keep the five primary tasks visible. Secondary destinations live behind
       one labelled disclosure, leaving every visible target at least 44px. */
    .nav-pair {
      display: none;
    }
    .nav-more {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0.5rem;
      min-width: 44px;
      min-height: 44px;
      border: none;
      border-radius: 999px;
      background: none;
      color: var(--muted);
      cursor: pointer;
      font: inherit;
    }
    .nav-more:hover,
    .nav-more.active {
      color: var(--accent);
      background: var(--accent-soft);
    }
    .mobile-more-popup {
      position: fixed;
      z-index: 401;
      right: 0.5rem;
      bottom: calc(3.75rem + env(safe-area-inset-bottom));
      display: flex;
      flex-direction: column;
      width: min(13rem, calc(100vw - 1rem));
      padding: 0.35rem;
      background: rgba(20, 20, 26, 0.96);
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
      border: 1px solid var(--line);
      border-radius: 12px;
      box-shadow: var(--shadow-1);
      animation: mobile-more-in 0.14s ease-out;
    }
    .mobile-more-item {
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: flex-start;
      gap: 0.65rem;
      width: 100%;
      min-width: 44px;
      /* The app's narrow-screen 0.98 scale would turn 44px into 43.12px. */
      min-height: 45px;
      height: 45px;
      flex: 0 0 45px;
      box-sizing: border-box;
      padding: 0.65rem 0.75rem;
      border: none;
      border-radius: 8px;
      background: none;
      color: var(--muted);
      cursor: pointer;
      font: 0.72rem var(--font-mono);
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .mobile-more-item:hover,
    .mobile-more-item:focus-visible,
    .mobile-more-item.active {
      color: var(--accent);
      background: var(--accent-soft);
    }

    .divider { margin: 0; height: 20px; }
  }

  @keyframes mobile-more-in {
    from { opacity: 0; transform: translateY(6px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  /* Extra-small screens (iPhone SE, 320-375px) */
  @media (max-width: 380px) {
    nav {
      padding: 0.2rem 0.1rem;
    }
    a:not(.wordmark), .nav-btn, .nav-more {
      padding: 0.45rem 0.4rem;
      min-width: 44px;
    }
    .glyph { font-size: 1rem; }
    .glyph-svg :global(svg) { width: 1rem; height: 1.1rem; }
  }
  /* The add menu is a LIST, not the analyze strip: fifteen entries in a pill ran 900px wide and,
     on a 390px phone, started 256px off-screen (checked in Chromium, 2026-09-30). */
  .add-popup {
    flex-direction: column;
    align-items: stretch;
    width: min(17rem, calc(100vw - 1rem));
    max-height: calc(100dvh - 9rem);
    overflow-y: auto;
    border-radius: 16px;
    padding: 0.4rem;
  }
  .add-popup .popup-item {
    flex-direction: row;
    align-items: center;
    justify-content: flex-start;
    gap: 0.7rem;
    min-height: 44px;
    padding: 0.35rem 0.7rem;
    border-radius: 10px;
    text-align: left;
    width: 100%;
  }
  .add-popup .popup-divider {
    width: auto;
    height: 1px;
    margin: 0.3rem 0.4rem;
  }
  .add-popup .popup-label {
    font-size: 0.74rem;
    color: var(--text, inherit);
  }
  .add-popup .popup-glyph {
    width: 1.2rem;
    text-align: center;
  }
  .add-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .add-hint {
    font-size: 0.72rem;
    color: var(--muted);
    opacity: 0.8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .popup-group {
    padding: 0.35rem 0.7rem 0.15rem;
    font-size: 0.66rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }
</style>
