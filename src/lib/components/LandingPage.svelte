<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { ONBOARDING_TEMPLATES, BLANK_TEMPLATE } from '$lib/onboarding/templates';
  import { addStatements, addSource } from '$lib/stores/kb.svelte';
  import { nudge } from '$lib/stores/tutorial.svelte';
  import { activateOfficialKb, preloadOfficialKb, officialKbError } from '$lib/stores/official-kb.svelte';
  import { importTurtleFull } from '$lib/rdf/import-ttl';
  import { startStory, startExplore } from '$lib/stores/shelly-bridge.svelte';
  import * as kokoro from '$lib/integrations/llm/kokoro-tts';

  // Eagerly pre-fetch the official KB so it's ready when user clicks "Getting Started"
  preloadOfficialKb();

  // Kokoro TTS is lazy-loaded on first voice use — no automatic download.
  // The 87MB model only downloads when the user explicitly enables voice.

  let loadingTemplate = $state<string | null>(null);
  let loadingDocs = $state(false);
  let loadingStarter = $state(false);
  let docsError = $state<string | null>(null);
  let loadingExample = $state<string | null>(null);
  let loadingVisualReview = $state(false);

  // Track core module loading (Kokoro TTS voice model)
  let kokoroStatus = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  let kokoroPct = $state(0);
  kokoro.onKokoroStatus((status, pct) => {
    kokoroStatus = status;
    kokoroPct = pct;
  });

  const EXAMPLE_KBS = [
    { id: 'quickstart', icon: '🚀', title: 'Quick-Start Example', body: 'People, projects, decisions, metrics', file: '/starter-quickstart.ttl' },
  ];

  const GUIDE_STORY_ID = 'urn:reckons:story/ReckonsPhilosophy';

  async function openDocsKb() {
    loadingDocs = true;
    docsError = null;
    try {
      const ok = await activateOfficialKb();
      if (!ok) {
        docsError = officialKbError() ?? 'Could not open the documentation graph. Please try again.';
        return;
      }
      startStory(GUIDE_STORY_ID, true);
      goto('/');
    } finally {
      loadingDocs = false;
    }
  }

  // Soft landing: the "Getting started" button loads an everyday graph — two
  // friends meeting in the middle for a weekend camping trip (two people, two
  // campgrounds, two forecasts, two prices, four drive routes, one real
  // tension, a natural Reckon) — as an EDITABLE KB and opens Shelly's tour on
  // it, instead of dropping the large, concept-dense docs graph on a first-time
  // user. The full docs graph is the "go deeper" path.
  async function openStarter() {
    loadingStarter = true;
    try {
      const res = await fetch('/starter-everyday.ttl');
      if (!res.ok) throw new Error(`Failed to fetch starter graph: ${res.status}`);
      const ttl = await res.text();
      const { statements, sources } = await importTurtleFull(ttl);
      for (const src of sources) await addSource(src);
      // Curated example — land it as CONFIRMED facts (not pending review), so the
      // graph reads as real and Shelly's tour (which sees confirmed statements)
      // has something to talk about.
      const confirmed = statements.map((s) => ({ ...s, status: 'confirmed' as const }));
      if (confirmed.length) await addStatements(confirmed, 'starter');
      startExplore(); // opens Shelly's guided tour on the graph page
      goto('/');
    } finally {
      loadingStarter = false;
    }
  }

  // One-click visual-test review: load the demo visual-test story (four captured
  // screens with assertions + verdicts) as confirmed facts and open Shelly, who
  // flips into review mode (F34 / PR #77) — walking the screens and asking you to
  // confirm or flag each. Regenerate the real thing with `npm run test:crawl`.
  async function openVisualReview() {
    loadingVisualReview = true;
    try {
      const res = await fetch('/starter-visual-review.ttl');
      if (!res.ok) throw new Error(`Failed to fetch visual-review story: ${res.status}`);
      const ttl = await res.text();
      const { statements, sources } = await importTurtleFull(ttl);
      for (const src of sources) await addSource(src);
      const confirmed = statements.map((s) => ({ ...s, status: 'confirmed' as const }));
      if (confirmed.length) await addStatements(confirmed, 'visual-review');
      startExplore(); // Shelly detects the visual-test steps → review mode
      goto('/');
    } finally {
      loadingVisualReview = false;
    }
  }

  async function importExample(kb: typeof EXAMPLE_KBS[0]) {
    loadingExample = kb.id;
    try {
      const res = await fetch(kb.file);
      if (!res.ok) throw new Error(`Failed to fetch ${kb.file}`);
      const ttl = await res.text();
      const { statements, sources } = await importTurtleFull(ttl);
      for (const src of sources) await addSource(src);
      if (statements.length) await addStatements(statements, 'example-kb');
      goto('/');
    } finally {
      loadingExample = null;
    }
  }

  async function loadTemplate(id: string) {
    if (id === 'blank') { goto('/ingest'); return; }
    const tmpl = ONBOARDING_TEMPLATES.find(t => t.id === id);
    if (!tmpl) return;

    loadingTemplate = id;
    try {
      const { source, statements } = tmpl.buildData();
      await addSource(source);
      await addStatements(statements);
      await nudge('template-selected');
      goto('/');
    } finally {
      loadingTemplate = null;
    }
  }

  // Animated graph nodes rendered on canvas
  let canvas = $state<HTMLCanvasElement | null>(null);
  let raf = 0;

  type Node = { x: number; y: number; vx: number; vy: number; r: number; color: string; label: string };
  type Edge = { a: number; b: number };

  onMount(() => {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      canvas!.width = Math.round(canvas!.offsetWidth * dpr);
      canvas!.height = Math.round(canvas!.offsetHeight * dpr);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const TEAL = '#1a9b8e';
    const PURPLE = '#6b4399';
    const labels = ['Climate', 'IPCC', 'CO₂ ppm', 'Arctic', 'sea level', 'credibility', 'Reckons.AI', 'policy', 'evidence'];
    const nodes: Node[] = Array.from({ length: 9 }, (_, i) => ({
      x: Math.random() * 0.8 + 0.1,
      y: Math.random() * 0.8 + 0.1,
      vx: (Math.random() - 0.5) * 0.0004,
      vy: (Math.random() - 0.5) * 0.0004,
      r: 5 + Math.random() * 4,
      color: i % 3 === 0 ? TEAL : i % 3 === 1 ? PURPLE : '#2a4a5e',
      label: labels[i] ?? ''
    }));
    const edges: Edge[] = [
      { a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 },
      { a: 3, b: 4 }, { a: 4, b: 5 }, { a: 0, b: 6 },
      { a: 6, b: 7 }, { a: 7, b: 8 }, { a: 5, b: 8 }, { a: 1, b: 6 }
    ];

    let t = 0;
    const draw = () => {
      const w = canvas!.offsetWidth, h = canvas!.offsetHeight;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      t += 0.008;

      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < 0.05 || n.x > 0.95) n.vx *= -1;
        if (n.y < 0.05 || n.y > 0.95) n.vy *= -1;
      }

      // edges
      for (const e of edges) {
        const a = nodes[e.a], b = nodes[e.b];
        const ax = a.x * w, ay = a.y * h;
        const bx = b.x * w, by = b.y * h;
        const grad = ctx.createLinearGradient(ax, ay, bx, by);
        grad.addColorStop(0, `${a.color}55`);
        grad.addColorStop(1, `${b.color}55`);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // nodes
      for (const n of nodes) {
        const px = n.x * w, py = n.y * h;
        const glow = ctx.createRadialGradient(px, py, 0, px, py, n.r * 3);
        glow.addColorStop(0, `${n.color}66`);
        glow.addColorStop(1, `${n.color}00`);
        ctx.beginPath();
        ctx.arc(px, py, n.r * 3, 0, Math.PI * 2);
        ctx.fillStyle = glow;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(px, py, n.r, 0, Math.PI * 2);
        ctx.fillStyle = n.color;
        ctx.fill();

        ctx.font = '11px Supreme, system-ui, sans-serif';
        ctx.fillStyle = '#b8c5d488';
        ctx.fillText(n.label, px + n.r + 4, py + 4);
      }

      raf = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  });

  const FEATURES = [
    {
      icon: '⬡',
      title: 'Provenance-first',
      body: 'Every fact knows its source, when it was added, and how trustworthy that source has proven to be over time.',
      color: 'var(--accent)'
    },
    {
      icon: '◷',
      title: 'Temporal facts',
      body: 'Claims are time-bounded. Conflicts between old and new beliefs are surfaced automatically with PROV-O reification.',
      color: 'var(--data)'
    },
    {
      icon: '◎',
      title: 'Trust scoring',
      body: 'Sources accumulate a trust score with time-decay. Auto-confirm from trusted sources; flag and review the rest.',
      color: 'var(--accent)'
    },
    {
      icon: '⬢',
      title: '3D knowledge graph',
      body: 'Navigate your knowledge spatially. Nodes cluster by entity type, filter by source, and orbit the structure.',
      color: 'var(--data)'
    },
    {
      icon: '⧖',
      title: 'History playback',
      body: 'Scrub back in time and reconstruct the graph at any moment. Trust scores decay correctly at historical timestamps.',
      color: 'var(--accent)'
    },
    {
      icon: '⟁',
      title: 'Semantic diff',
      body: 'Compare any two states: what was added, reinforced, conflicted, merged, or removed. Source attribution on every change.',
      color: 'var(--data)'
    }
  ];

  // Generated FROM THE GRAPH by scripts/landing-features.ts (npm run landing:features).
  // Do not hand-edit: this list used to be hardcoded and had already drifted, claiming
  // "MCP server (16 tools)" when the graph said 20. The landing page is a public claim,
  // so it is driven by kpred:has-status and cannot say "shipped" when the graph says
  // "planned" (kb:honest-status). CI fails if this file goes stale.
  import ROADMAP from '$lib/data/landing-roadmap.json';

  // Generated FROM THE GRAPH by scripts/landing-principles.ts. Philosophy is worse than a
  // feature list to get wrong: a principle we have quietly stopped honouring, still printed
  // on the front page, is precisely the overclaim kb:honest-status exists to prevent. Each
  // tenet is marked `built` (enforced by code today) or `belief` (a commitment, not yet a
  // control) — and that distinction is RENDERED, not hidden. CI fails if this goes stale.
  import THESIS from '$lib/data/landing-thesis.json';

  // Seven tenets is an essay, not a section — most visitors bounce off a wall of philosophy
  // before reaching the product. Show three and disclose the rest. Order is the GRAPH's order
  // (kb:thesis), not a hand-picked "best three": re-ranking here would quietly editorialise a
  // list whose whole point is that it is generated, and CI checks it against the graph.
  const THESIS_PREVIEW = 3;
  let thesisExpanded = $state(false);
  const visibleThesis = $derived(thesisExpanded ? THESIS : THESIS.slice(0, THESIS_PREVIEW));

  const RM_LABEL: Record<string, string> = {
    done: 'shipped',
    building: 'building',
    planned: 'planned',
    exploring: 'exploring',
  };
</script>

<div class="landing">
  <!-- Hero -->
  <section class="hero">
    <canvas bind:this={canvas} class="nodes-canvas" aria-hidden="true"></canvas>

    <div class="hero-content">
      <p class="kicker mono">knowledge graph · provenance · trust</p>
      <img src="/svg/logo-text.svg" alt="Reckons.AI" class="hero-logo" />
      <p class="tagline">
        A knowledge graph that knows<br/><em>your situation.</em>
      </p>
      <p class="sub">
        Condense your context. Keep the meaning.<br/>
        An assistant that understands your situation, <em>controlled by you,</em> private by default.
      </p>

      <div class="ctas">
        <button class="btn-primary" onclick={openStarter} disabled={loadingStarter}>
          {#if loadingStarter}
            loading...
          {:else}
            Getting started →
          {/if}
          {#if kokoroStatus === 'loading'}
            <span class="btn-loader">
              <span class="btn-loader-bar" style="width: {kokoroPct}%"></span>
            </span>
          {/if}
        </button>
        <a href="/ingest" class="btn-secondary">Add your own source</a>
      </div>
      <p class="starter-hint mono">
        Starts with a tiny everyday example — one weekend, one decision.
        <button class="link-btn" onclick={openDocsKb} disabled={loadingDocs}>
          {loadingDocs ? 'loading…' : 'Or explore the full concept graph →'}
        </button>
      </p>
      {#if docsError}
        <p class="docs-error mono" role="alert">Couldn't open the documentation graph — {docsError}</p>
      {/if}
      {#if kokoroStatus === 'loading'}
        <p class="core-loading mono">loading voice model — {kokoroPct}%</p>
      {/if}

      <div class="badges">
        <span class="badge">local-first</span>
        <span class="badge">open source</span>
        <span class="badge">RDF / Turtle</span>
        <span class="badge">PROV-O provenance</span>
      </div>
    </div>

    <div class="scroll-hint" aria-hidden="true">↓</div>
  </section>

  <!-- Getting Started -->
  <section class="section starter-section" id="start">
    <p class="section-kicker mono">getting started</p>
    <h2>Learn by exploring.</h2>
    <p class="section-sub">The documentation is itself a knowledge graph — browse it in 3D, talk to Shelly, play the guided story. Or import example data to see how your own graph will look.</p>

    <div class="template-grid">
      <button
        class="template-card template-docs"
        onclick={openDocsKb}
        disabled={loadingDocs}
      >
        <span class="tmpl-icon">📖</span>
        <strong class="tmpl-label">Documentation Graph</strong>
        <p class="tmpl-desc">The full Reckons.AI guide as an interactive knowledge graph. Read-only — your graph stays untouched.</p>
        <span class="tmpl-scenario mono">philosophy · architecture · features · story</span>
        {#if loadingDocs}
          <span class="tmpl-loading mono">loading...</span>
        {:else}
          <span class="tmpl-cta">Open docs →</span>
        {/if}
        {#if kokoroStatus === 'loading'}
          <span class="tmpl-loader">
            <span class="tmpl-loader-track">
              <span class="tmpl-loader-bar" style="width: {kokoroPct}%"></span>
            </span>
            <span class="tmpl-loader-label mono">voice {kokoroPct}%</span>
          </span>
        {/if}
      </button>

      {#each EXAMPLE_KBS as kb}
        <button
          class="template-card"
          onclick={() => importExample(kb)}
          disabled={loadingExample !== null}
        >
          <span class="tmpl-icon">{kb.icon}</span>
          <strong class="tmpl-label">{kb.title}</strong>
          <p class="tmpl-desc">{kb.body}</p>
          <span class="tmpl-scenario mono">example data · imports into your graph</span>
          {#if loadingExample === kb.id}
            <span class="tmpl-loading mono">importing...</span>
          {:else}
            <span class="tmpl-cta">Import example →</span>
          {/if}
        </button>
      {/each}

      <button
        class="template-card"
        onclick={openVisualReview}
        disabled={loadingVisualReview}
      >
        <span class="tmpl-icon">🔍</span>
        <strong class="tmpl-label">Review a visual test</strong>
        <p class="tmpl-desc">Four captured screens of the core flow — Shelly walks you through, screen by screen, to confirm or flag each.</p>
        <span class="tmpl-scenario mono">Shelly review mode · screenshots + verdicts</span>
        {#if loadingVisualReview}
          <span class="tmpl-loading mono">loading...</span>
        {:else}
          <span class="tmpl-cta">Start review →</span>
        {/if}
      </button>

      <button
        class="template-card template-blank"
        onclick={() => loadTemplate('blank')}
        disabled={loadingTemplate !== null}
      >
        <span class="tmpl-icon">{BLANK_TEMPLATE.icon}</span>
        <strong class="tmpl-label">{BLANK_TEMPLATE.label}</strong>
        <p class="tmpl-desc">{BLANK_TEMPLATE.description}</p>
        <span class="tmpl-cta">Open Ingest →</span>
      </button>
    </div>
  </section>

  <!-- Features -->
  <section class="section">
    <p class="section-kicker mono">what makes it different</p>
    <h2>Built for knowing <em>why</em> you know something.</h2>
    <p class="section-sub">Most knowledge tools store information. Reckons.AI stores the epistemics behind it.</p>

    <div class="features-grid">
      {#each FEATURES as f}
        <div class="feature-card">
          <span class="feat-icon" style="color: {f.color}">{f.icon}</span>
          <h3>{f.title}</h3>
          <p>{f.body}</p>
        </div>
      {/each}
    </div>
  </section>

  <!-- THE THESIS — generated from kb:thesis in the graph -->
  <section class="section thesis-section">
    <p class="section-kicker mono">what we believe</p>
    <h2>An unverifiable claim, made by the party it benefits,<br/><em>is not evidence.</em></h2>
    <p class="section-sub">
      We arrived at that three separate times, from three different directions — so we stopped
      treating it as a rule and started treating it as the point.
    </p>

    <p class="thesis-mission">
      It was never about the tool. The knowledge you need to <em>decide</em> something is usually
      a few team members away — and that is a distance problem, not an information problem. A
      document records <em>conclusions</em>, not the structure that produced them: you cannot tell
      which constraint was load-bearing, which option was already rejected, or which number was
      measured rather than guessed. Two documents cannot be diffed for reasoning. Two graphs can.
    </p>

    <div class="thesis-list" id="thesis-list">
      {#each visibleThesis as t}
        <div class="tenet">
          <div class="tenet-head">
            <h3>{t.headline}</h3>
            <span class="tenet-badge mono {t.status}">
              {t.status === 'built' ? 'enforced in code' : 'what we believe'}
            </span>
          </div>
          <p>{t.body}</p>
        </div>
      {/each}
    </div>

    {#if THESIS.length > THESIS_PREVIEW}
      <button
        class="thesis-more mono"
        aria-expanded={thesisExpanded}
        aria-controls="thesis-list"
        onclick={() => (thesisExpanded = !thesisExpanded)}
      >
        {thesisExpanded
          ? 'Show fewer'
          : `Show ${THESIS.length - THESIS_PREVIEW} more`}
        <span class="thesis-more-chevron" class:open={thesisExpanded} aria-hidden="true">▾</span>
      </button>
    {/if}

    <p class="thesis-foot mono">
      Marked <strong>enforced in code</strong> where a test proves it, and <strong>what we
      believe</strong> where it is a commitment we have not finished building. We would rather
      tell you which is which.
    </p>
  </section>

  <!-- Why not documents -->
  <section class="section docs-problem-section">
    <p class="section-kicker mono">why facts, not documents</p>
    <h2>Documents grow stale.<br/><em>Graphs stay current.</em></h2>
    <p class="section-sub">Wikis, notebooks, and markdown files store knowledge as prose. Updating one fact means editing an entire page — so people don't. Facts are atomic: change one fact without touching anything else.</p>

    <div class="docs-compare">
      <div class="docs-col docs-old">
        <span class="docs-col-label mono">documents & wikis</span>
        <ul>
          <li>Update = rewrite a page</li>
          <li>Search = keyword matching on prose</li>
          <li>Duplicates = same info in 10 pages</li>
          <li>Contradictions = invisible until someone notices</li>
          <li>AI reads text, guesses structure</li>
        </ul>
      </div>
      <div class="docs-col docs-new">
        <span class="docs-col-label mono">semantic facts</span>
        <ul>
          <li>Update = change one fact</li>
          <li>Search = typed relationship queries</li>
          <li>Duplicates = same fact auto-merges</li>
          <li>Contradictions = detected at ingest</li>
          <li>AI queries a structured graph directly</li>
        </ul>
      </div>
    </div>
  </section>

  <!-- Context Compression -->
  <section class="section compress-section">
    <p class="section-kicker mono">context compression</p>
    <h2>Condense your context.<br/><em>Keep the meaning.</em></h2>
    <p class="section-sub">Knowledge graphs are dense by nature. Reckons.AI compresses what you know into structured triples — retaining semantic meaning while reducing the tokens an AI needs to understand your situation.</p>

    <div class="compress-grid">
      <div class="compress-card">
        <span class="compress-num mono">3×</span>
        <strong>Denser than documents</strong>
        <p>Measured across 7 text categories: prose compresses to ~68% fewer tokens as triples. Run <code>npm run bench:compression</code> to verify.</p>
      </div>
      <div class="compress-card">
        <span class="compress-num mono">RDF</span>
        <strong>Structured, not summarised</strong>
        <p>Unlike summaries that lose detail, triples preserve every relationship. Nothing is paraphrased away.</p>
      </div>
      <div class="compress-card">
        <span class="compress-num mono">MCP</span>
        <strong>AI-ready context</strong>
        <p>Feed your compressed graph directly to AI agents via MCP. They get the full picture in fewer tokens.</p>
      </div>
    </div>
  </section>

  <!-- AI without the downsides -->
  <section class="section ethics-section">
    <p class="section-kicker mono">AI for the people</p>
    <h2>The power of AI.<br><em>Without the downsides.</em></h2>
    <p class="section-sub">Your knowledge is yours. Not a product. Not a training set. Not a liability.</p>

    <div class="ethics-grid">
      <div class="ethics-card">
        <span class="ethics-icon">🔒</span>
        <strong>No data harvesting</strong>
        <p>Your graph lives in your browser. Nothing is sent anywhere unless you choose an external AI backend. No accounts required, no telemetry, no ads.</p>
      </div>
      <div class="ethics-card">
        <span class="ethics-icon">🌱</span>
        <strong>No datacenter footprint</strong>
        <p>Run entirely on your device with the built-in WASM model or Ollama. Zero inference traffic, zero GPU clusters burning energy to process your notes.</p>
      </div>
      <div class="ethics-card">
        <span class="ethics-icon">⚖️</span>
        <strong>Independent, not corporate</strong>
        <p>No investor mandate to monetise your attention. No platform lock-in. Built on open W3C standards so your data works with any RDF tool, forever.</p>
      </div>
    </div>
  </section>

  <!-- A Reckoning teaser -->
  <section class="section reckoning-section">
    <div class="reckoning-inner">
      <p class="section-kicker mono">core workflow</p>
      <h2>A Reckoning</h2>
      <p class="section-sub">Describe your situation. State your target. Reckons.AI consults your entire knowledge graph and synthesizes a brief proposal, drawing only on what you've already verified.</p>

      <div class="stp-flow">
        <div class="stp-step">
          <span class="stp-label mono">01 — Situation</span>
          <p>Where are you now? What context matters?</p>
        </div>
        <div class="stp-arrow">→</div>
        <div class="stp-step">
          <span class="stp-label mono">02 — Target</span>
          <p>What outcome are you trying to reach?</p>
        </div>
        <div class="stp-arrow">→</div>
        <div class="stp-step">
          <span class="stp-label mono">03 — Proposal</span>
          <p>AI synthesizes options from your graph: sourced, ranked, traceable.</p>
        </div>
      </div>

      <p class="reckoning-note mono">Voice-first version available. Brief input, conversational refinement, no forms.</p>
    </div>
  </section>

  <!-- Enterprise -->
  <section class="section enterprise-section">
    <p class="section-kicker mono">enterprise</p>
    <h2>People · Policy · Procedure</h2>
    <p class="section-sub">Structure organizational knowledge around the three dimensions that matter. Who knows what, what governs it, and how it gets done.</p>

    <div class="enterprise-grid">
      <div class="enterprise-card">
        <span class="enterprise-icon">👥</span>
        <strong>People</strong>
        <p>Role-based access controls. Team KBs with ownership, delegation, and audit trails. Know who contributed what, when.</p>
      </div>
      <div class="enterprise-card">
        <span class="enterprise-icon">📜</span>
        <strong>Policy</strong>
        <p>Legal, cultural, and compliance constraints as first-class graph entities. Governance rules that travel with the knowledge.</p>
      </div>
      <div class="enterprise-card enterprise-card-accent">
        <span class="enterprise-icon">📋</span>
        <strong>Procedure</strong>
        <p>Depth of specifics — SOPs, decision trees, and process graphs. From high-level intent down to step-by-step execution.</p>
      </div>
    </div>

    <div class="enterprise-details">
      <div class="enterprise-detail">
        <span class="enterprise-detail-label mono">delivery</span>
        <p>File-based <code>.ttl</code> distribution. No platform lock-in — your enterprise graph is a portable W3C standard file.</p>
      </div>
      <div class="enterprise-detail">
        <span class="enterprise-detail-label mono">authentication</span>
        <p>Bring your own auth. SSO, LDAP, OIDC — plug in what you already run. No new identity provider required.</p>
      </div>
      <div class="enterprise-detail">
        <span class="enterprise-detail-label mono">self-hosted</span>
        <p>Deploy on your infrastructure. n8n cloud sync, private AI backends, air-gapped operation. Your data never leaves your network.</p>
      </div>
    </div>

    <p class="enterprise-cta mono">Enterprise features in development. <a href="https://data-insight.solutions/contact" target="_blank" rel="noopener noreferrer">Get in touch →</a></p>
  </section>

  <!-- Roadmap -->
  <section class="section">
    <p class="section-kicker mono">roadmap</p>
    <h2>What's being built.</h2>

    <div class="roadmap-list">
      {#each ROADMAP as item}
        <div class="roadmap-row">
          <span class="rm-status {item.status}">{RM_LABEL[item.status] ?? item.status}</span>
          <div class="rm-body">
            <strong>{item.label}</strong>
            <span class="rm-note">{item.note}</span>
          </div>
        </div>
      {/each}
    </div>
  </section>

  <!-- Quick start -->
  <section class="section quickstart-section">
    <p class="section-kicker mono">quick start</p>
    <h2>Three steps to your first knowledge graph.</h2>

    <div class="steps">
      <div class="step">
        <span class="step-num">01</span>
        <div>
          <strong>Configure a backend</strong>
          <p>Add an API key for Claude, OpenAI, Gemini, or run fully offline with Ollama or WASM. No cloud required.</p>
          <a href="/settings" class="step-link">Open Settings →</a>
        </div>
      </div>
      <div class="step">
        <span class="step-num">02</span>
        <div>
          <strong>Ingest a source</strong>
          <p>Paste a URL, drop a PDF, type a note, or connect Google Drive. The AI extracts RDF triples and shows you a diff.</p>
          <a href="/ingest" class="step-link">Open Ingest →</a>
        </div>
      </div>
      <div class="step">
        <span class="step-num">03</span>
        <div>
          <strong>Review and confirm</strong>
          <p>Approve facts, merge duplicate entities, flag conflicts. Your graph grows with every decision, all logged.</p>
          <a href="/review" class="step-link">Open Review →</a>
        </div>
      </div>
    </div>
  </section>

  <footer class="landing-footer">
    <p class="mono"><img src="/svg/logo-text.svg" alt="Reckons.AI" class="footer-logo" /> · local-first · open source · RDF/Turtle</p>
    <p class="mono footer-pricing">Core is free forever. Private n8n cloud sync and enterprise RBAC available. <a href="https://data-insight.solutions/contact" target="_blank" rel="noopener noreferrer">Contact for inquiries →</a></p>
    <p class="mono footer-credit">Developed by <a href="https://data-insight.solutions/" target="_blank" rel="noopener noreferrer">Data Insight Solutions LLC</a></p>
  </footer>
</div>

<style>
  .landing {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    overflow-x: hidden;
    scroll-behavior: smooth;
  }

  /* ── Hero ───────────────────────────────────────────── */
  .hero {
    position: relative;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 4rem 2rem 6rem;
    overflow: hidden;
  }

  .nodes-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0.5;
    pointer-events: none;
  }

  .hero-content {
    position: relative;
    z-index: 1;
    max-width: 640px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.1rem;
    animation: rise 0.9s ease-out both;
  }

  @keyframes rise {
    from { opacity: 0; transform: translateY(24px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .kicker {
    font-size: 0.72rem;
    color: var(--muted);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    margin: 0;
  }

  .hero-logo {
    width: clamp(240px, 60vw, 480px);
    height: auto;
    display: block;
  }

  .tagline {
    font-family: var(--font-display);
    font-size: clamp(1.3rem, 4vw, 1.9rem);
    font-weight: 700;
    color: var(--ink-2);
    line-height: 1.25;
    margin: 0;
  }

  .tagline em {
    font-style: italic;
    color: var(--accent);
  }

  .sub {
    font-size: 0.95rem;
    color: var(--muted);
    line-height: 1.6;
    margin: 0;
  }

  .ctas {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    justify-content: center;
    margin-top: 0.5rem;
  }

  .btn-primary {
    position: relative;
    background: var(--accent);
    color: #fff;
    padding: 0.7rem 1.4rem;
    border-radius: var(--rad);
    text-decoration: none;
    font-size: 0.95rem;
    font-weight: 500;
    overflow: hidden;
    transition: opacity 0.15s, transform 0.15s;
  }
  .btn-primary:hover { opacity: 0.85; transform: translateY(-1px); }

  .btn-secondary {
    background: var(--surface-2);
    color: var(--ink-2);
    padding: 0.7rem 1.4rem;
    border-radius: var(--rad);
    text-decoration: none;
    font-size: 0.95rem;
    border: 1px solid var(--line);
    transition: background 0.15s;
  }
  .btn-secondary:hover { background: var(--surface-3); }

  .badges {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    justify-content: center;
  }

  .badge {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    color: var(--muted);
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
  }

  .scroll-hint {
    position: absolute;
    bottom: 2rem;
    left: 50%;
    transform: translateX(-50%);
    color: var(--muted);
    font-size: 1.2rem;
    animation: bob 2s ease-in-out infinite;
    z-index: 1;
  }

  @keyframes bob {
    0%, 100% { transform: translateX(-50%) translateY(0); }
    50%       { transform: translateX(-50%) translateY(6px); }
  }

  /* ── Sections ───────────────────────────────────────── */
  .section {
    padding: 5rem 2rem;
    max-width: 900px;
    margin: 0 auto;
  }

  .section-kicker {
    font-size: 0.7rem;
    color: var(--accent);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    margin: 0 0 0.6rem;
  }

  .section h2 {
    margin: 0 0 0.5rem;
    color: var(--ink);
  }

  .section h2 em {
    color: var(--accent);
    font-style: italic;
  }

  .section-sub {
    color: var(--ink-2);
    font-size: 1rem;
    margin: 0 0 2.5rem;
    max-width: 560px;
    line-height: 1.6;
  }

  /* ── Template picker ────────────────────────────────── */
  .starter-section {
    border-top: 1px solid var(--line);
  }

  .template-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0.75rem;
  }

  .template-card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.3rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    text-align: left;
    cursor: pointer;
    transition: border-color 0.15s, transform 0.15s, background 0.15s;
  }

  .template-card:hover:not(:disabled) {
    border-color: var(--accent);
    transform: translateY(-2px);
    background: var(--surface-2);
  }

  .template-card:disabled { opacity: 0.6; cursor: default; }

  .template-docs {
    border-color: var(--accent);
    background: rgba(26, 155, 142, 0.04);
  }
  .template-docs:hover:not(:disabled) {
    background: rgba(26, 155, 142, 0.08);
  }
  .template-blank {
    border-style: dashed;
    opacity: 0.75;
  }

  .template-blank:hover:not(:disabled) {
    opacity: 1;
    border-style: solid;
  }

  .tmpl-icon { font-size: 1.8rem; line-height: 1; margin-bottom: 0.2rem; }

  .tmpl-label {
    font-size: 1rem;
    color: var(--ink);
    display: block;
  }

  .tmpl-desc {
    font-size: 0.82rem;
    color: var(--muted);
    margin: 0;
    line-height: 1.5;
    flex: 1;
  }

  .tmpl-scenario {
    font-size: 0.65rem;
    color: var(--accent);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    display: block;
    margin-top: 0.2rem;
  }

  .tmpl-hint {
    font-size: 0.75rem;
    color: var(--ink-2);
    font-style: italic;
    border-left: 2px solid var(--accent);
    padding-left: 0.5rem;
    margin: 0.2rem 0;
    line-height: 1.4;
  }

  .tmpl-cta {
    font-size: 0.78rem;
    color: var(--accent);
    margin-top: auto;
    padding-top: 0.5rem;
  }

  .tmpl-loading {
    font-size: 0.75rem;
    color: var(--muted);
    animation: blink 1s step-end infinite;
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  /* ── Core module loading indicator ───────────────── */
  .core-loading {
    font-size: 0.7rem;
    color: var(--muted);
    margin: 0;
    letter-spacing: 0.04em;
  }
  .docs-error {
    font-size: 0.72rem;
    color: var(--danger, #d4726d);
    margin: 0.6rem 0 0;
    letter-spacing: 0.02em;
  }
  .starter-hint {
    font-size: 0.72rem;
    color: var(--muted);
    margin: 0.9rem 0 0;
    letter-spacing: 0.02em;
    line-height: 1.5;
  }
  .starter-hint .link-btn {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--accent);
    cursor: pointer;
    text-decoration: none;
    white-space: nowrap;
  }
  .starter-hint .link-btn:hover:not(:disabled) { text-decoration: underline; }
  .starter-hint .link-btn:disabled { color: var(--muted); cursor: default; }

  .btn-loader {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 3px;
    background: rgba(0, 0, 0, 0.15);
    border-radius: 0 0 var(--rad) var(--rad);
    overflow: hidden;
  }

  .btn-loader-bar {
    display: block;
    height: 100%;
    background: rgba(255, 255, 255, 0.6);
    border-radius: 0 0 var(--rad) var(--rad);
    transition: width 0.3s ease;
  }

  .tmpl-loader {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.3rem;
  }

  .tmpl-loader-track {
    flex: 1;
    height: 3px;
    background: var(--line);
    border-radius: 2px;
    overflow: hidden;
  }

  .tmpl-loader-bar {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .tmpl-loader-label {
    font-size: 0.62rem;
    color: var(--muted);
    white-space: nowrap;
  }

  /* ── Features grid ──────────────────────────────────── */
  .features-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 1rem;
  }

  .feature-card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.4rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    transition: border-color 0.2s, transform 0.2s;
  }

  .feature-card:hover {
    border-color: var(--accent);
    transform: translateY(-2px);
  }

  .feat-icon {
    font-size: 1.6rem;
    line-height: 1;
  }

  .feature-card h3 {
    font-size: 1rem;
    color: var(--ink);
    margin: 0;
  }

  .feature-card p {
    font-size: 0.85rem;
    color: var(--muted);
    margin: 0;
    line-height: 1.55;
  }

  /* ── Ethics ──────────────────────────────────────────── */
  .ethics-section { background: var(--surface); border-radius: var(--rad-lg); padding: 2.5rem 2rem; }
  .ethics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1rem;
    margin-top: 2rem;
  }
  .ethics-card {
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.3rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    transition: border-color 0.2s, transform 0.2s;
  }
  .ethics-card:hover { border-color: var(--accent); transform: translateY(-2px); }
  .ethics-icon { font-size: 1.5rem; line-height: 1; }
  .ethics-card strong { font-size: 0.95rem; color: var(--ink); }
  .ethics-card p { font-size: 0.82rem; color: var(--muted); margin: 0; line-height: 1.6; }

  /* ── A Reckoning ─────────────────────────────────────── */
  .reckoning-section {
    max-width: 100%;
    padding: 0;
  }

  .reckoning-inner {
    background: linear-gradient(135deg, var(--surface) 0%, #1a1040 100%);
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    padding: 5rem 2rem;
    max-width: 900px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 1.2rem;
  }

  .stp-flow {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    flex-wrap: wrap;
    margin-top: 0.5rem;
  }

  .stp-step {
    flex: 1;
    min-width: 160px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1rem 1.2rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .stp-label {
    font-size: 0.68rem;
    color: var(--accent);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .stp-step p {
    font-size: 0.85rem;
    color: var(--ink-2);
    margin: 0;
    line-height: 1.5;
  }

  .stp-arrow {
    color: var(--muted);
    font-size: 1.2rem;
    align-self: center;
    padding-top: 0.2rem;
  }

  .reckoning-note {
    font-size: 0.75rem;
    color: var(--muted);
    margin: 0;
  }

  .coming-soon {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: 0.68rem;
    background: var(--data-soft);
    color: var(--data);
    border: 1px solid var(--data);
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    letter-spacing: 0.06em;
    align-self: flex-start;
  }

  /* ── Roadmap ─────────────────────────────────────────── */
  .thesis-section { max-width: 62rem; }
  .thesis-mission {
    max-width: 46rem;
    margin: 1.6rem auto 0;
    color: var(--text-2);
    line-height: 1.7;
    font-size: 0.98rem;
  }
  .thesis-list {
    display: flex;
    flex-direction: column;
    gap: 1.4rem;
    margin-top: 2.2rem;
    text-align: left;
  }
  .tenet {
    padding: 1.25rem 1.4rem;
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 8px;
    background: var(--surface-2);
  }
  .tenet-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 0.5rem;
  }
  .tenet h3 {
    margin: 0;
    font-size: 1.05rem;
    line-height: 1.35;
  }
  .tenet p {
    margin: 0;
    color: var(--text-2);
    line-height: 1.6;
    font-size: 0.95rem;
  }
  .tenet-badge {
    font-size: 0.68rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    white-space: nowrap;
  }
  .tenet-badge.built {
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .tenet-badge.belief {
    color: var(--text-2);
    border: 1px solid var(--border);
  }
  .thesis-more {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    margin-top: 1.2rem;
    padding: 0.45rem 0.9rem;
    font-size: 0.72rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
    border-radius: 999px;
    cursor: pointer;
  }
  .thesis-more:hover { background: color-mix(in srgb, var(--accent) 16%, transparent); }
  .thesis-more-chevron {
    transition: transform 0.18s ease;
    font-size: 0.8rem;
    line-height: 1;
  }
  .thesis-more-chevron.open { transform: rotate(180deg); }
  @media (prefers-reduced-motion: reduce) {
    .thesis-more-chevron { transition: none; }
  }

  .thesis-foot {
    margin-top: 1.6rem;
    font-size: 0.78rem;
    color: var(--text-2);
    line-height: 1.6;
  }
  @media (max-width: 640px) {
    .tenet-head { flex-direction: column; align-items: flex-start; gap: 0.35rem; }
  }

  .roadmap-list {
    display: flex;
    flex-direction: column;
    gap: 0;
    border: 1px solid var(--line);
    border-radius: var(--rad);
    overflow: hidden;
  }

  .roadmap-row {
    display: flex;
    align-items: flex-start;
    gap: 1.2rem;
    padding: 1rem 1.2rem;
    border-bottom: 1px solid var(--line);
    background: var(--surface);
    transition: background 0.15s;
  }

  .roadmap-row:last-child { border-bottom: none; }
  .roadmap-row:hover { background: var(--surface-2); }

  .rm-status {
    font-family: var(--font-mono);
    font-size: 0.65rem;
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    white-space: nowrap;
    flex-shrink: 0;
    margin-top: 0.15rem;
  }

  .rm-status.done {
    background: rgba(34, 197, 94, 0.1);
    color: #22c55e;
    border: 1px solid rgba(34, 197, 94, 0.3);
  }

  .rm-status.building,
  .rm-status.next {
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid var(--accent);
  }

  .rm-status.exploring,
  .rm-status.enterprise {
    background: rgba(107, 67, 153, 0.1);
    color: #a78bfa;
    border: 1px solid rgba(107, 67, 153, 0.4);
  }

  .rm-status.planned {
    background: var(--surface-2);
    color: var(--muted);
    border: 1px solid var(--line);
  }

  .rm-body {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .rm-body strong {
    font-size: 0.9rem;
    color: var(--ink-2);
  }

  .rm-note {
    font-size: 0.8rem;
    color: var(--muted);
  }

  /* ── Quick start ─────────────────────────────────────── */
  .quickstart-section {
    border-top: 1px solid var(--line);
  }

  .steps {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .step {
    display: flex;
    gap: 1.5rem;
    align-items: flex-start;
  }

  .step-num {
    font-family: var(--font-mono);
    font-size: 2rem;
    color: var(--accent);
    font-weight: 700;
    line-height: 1;
    flex-shrink: 0;
    min-width: 2.5rem;
  }

  .step strong {
    display: block;
    font-size: 1rem;
    color: var(--ink);
    margin-bottom: 0.3rem;
  }

  .step p {
    font-size: 0.87rem;
    color: var(--muted);
    margin: 0 0 0.5rem;
    line-height: 1.55;
  }

  .step-link {
    font-size: 0.82rem;
    color: var(--accent);
    text-decoration: none;
  }
  .step-link:hover { text-decoration: underline; }

  /* ── Document Problem ────────────────────────────────── */
  .docs-problem-section {
    border-top: 1px solid var(--line);
  }

  .docs-compare {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
  }

  .docs-col {
    padding: 1.2rem;
    border-radius: var(--rad);
    border: 1px solid var(--line);
  }
  .docs-col ul {
    margin: 0.6rem 0 0;
    padding-left: 1.2rem;
    list-style: none;
  }
  .docs-col li {
    position: relative;
    padding: 0.3rem 0;
    font-size: 0.88rem;
    color: var(--ink-2);
    line-height: 1.5;
  }
  .docs-col li::before {
    position: absolute;
    left: -1.2rem;
    font-size: 0.75rem;
  }
  .docs-old { background: var(--surface-2); }
  .docs-old li::before { content: '✕'; color: var(--muted); }
  .docs-new { background: var(--surface); border-color: var(--accent); }
  .docs-new li::before { content: '✓'; color: var(--accent); }

  .docs-col-label {
    font-size: 0.7rem;
    color: var(--muted);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .docs-new .docs-col-label { color: var(--accent); }

  /* ── Context Compression ─────────────────────────────── */
  .compress-section {
    border-top: 1px solid var(--line);
  }

  .compress-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1rem;
  }

  .compress-card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.3rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    transition: border-color 0.2s, transform 0.2s;
  }

  .compress-card:hover {
    border-color: var(--accent);
    transform: translateY(-2px);
  }

  .compress-num {
    font-size: 1.6rem;
    font-weight: 700;
    color: var(--accent);
    line-height: 1;
  }

  .compress-card strong {
    font-size: 0.95rem;
    color: var(--ink);
  }

  .compress-card p {
    font-size: 0.82rem;
    color: var(--muted);
    margin: 0;
    line-height: 1.6;
  }

  /* ── Enterprise ────────────────────────────────────────── */
  .enterprise-section {
    background: linear-gradient(135deg, var(--surface) 0%, rgba(107, 67, 153, 0.06) 100%);
    border-radius: var(--rad-lg);
    padding: 3rem 2rem;
  }

  .enterprise-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1rem;
    margin-bottom: 2rem;
  }

  .enterprise-card {
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.3rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    transition: border-color 0.2s, transform 0.2s;
  }

  .enterprise-card:hover {
    border-color: #a78bfa;
    transform: translateY(-2px);
  }

  .enterprise-card-accent {
    border-color: rgba(107, 67, 153, 0.3);
  }

  .enterprise-icon { font-size: 1.5rem; line-height: 1; }
  .enterprise-card strong { font-size: 0.95rem; color: var(--ink); }
  .enterprise-card p { font-size: 0.82rem; color: var(--muted); margin: 0; line-height: 1.6; }

  .enterprise-details {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .enterprise-detail {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .enterprise-detail-label {
    font-size: 0.65rem;
    color: #a78bfa;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .enterprise-detail p {
    font-size: 0.82rem;
    color: var(--muted);
    margin: 0;
    line-height: 1.6;
  }

  .enterprise-detail code {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    background: var(--surface-3);
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    color: var(--ink-2);
  }

  .enterprise-cta {
    font-size: 0.75rem;
    color: var(--muted);
    margin: 0;
  }

  .enterprise-cta a {
    color: #a78bfa;
    text-decoration: none;
    transition: color 0.15s;
  }

  .enterprise-cta a:hover { color: var(--accent); }

  /* ── Footer ──────────────────────────────────────────── */
  .landing-footer {
    text-align: center;
    padding: 2rem;
    border-top: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.4rem;
  }

  .landing-footer p {
    font-size: 0.72rem;
    color: var(--muted-2);
    margin: 0;
  }
  .footer-credit a,
  .footer-pricing a {
    color: var(--muted);
    text-decoration: none;
    transition: color 0.15s;
  }
  .footer-credit a:hover,
  .footer-pricing a:hover { color: var(--accent); }
  .footer-logo {
    height: 0.85rem;
    width: auto;
    vertical-align: middle;
    display: inline;
  }

  /* ── Responsive ──────────────────────────────────────── */
  @media (max-width: 600px) {
    .hero { padding: 3rem 1rem 5rem; }
    .hero-logo { width: clamp(200px, 65vw, 340px); }
    .tagline { font-size: clamp(1.1rem, 3.5vw, 1.5rem); }
    .sub { font-size: 0.85rem; }
    .ctas { flex-direction: column; align-items: stretch; gap: 0.5rem; }
    .btn-primary, .btn-secondary { text-align: center; padding: 0.65rem 1rem; font-size: 0.9rem; }
    .badges { gap: 0.35rem; }
    .badge { font-size: 0.6rem; padding: 0.15rem 0.4rem; }
    .section { padding: 3rem 1rem; }
    .section h2 { font-size: 1.3rem; }
    .section-sub { font-size: 0.88rem; }
    .template-grid { grid-template-columns: 1fr; }
    .features-grid { grid-template-columns: 1fr; }
    .ethics-grid { grid-template-columns: 1fr; }
    .ethics-section { padding: 1.5rem 1rem; border-radius: var(--rad); }
    .stp-flow { flex-direction: column; }
    .stp-arrow { transform: rotate(90deg); align-self: center; }
    .reckoning-inner { padding: 3rem 1rem; }
    .docs-compare { grid-template-columns: 1fr; }
    .compress-grid { grid-template-columns: 1fr; }
    .enterprise-grid { grid-template-columns: 1fr; }
    .enterprise-details { grid-template-columns: 1fr; }
    .enterprise-section { padding: 1.5rem 1rem; border-radius: var(--rad); }
    .step { gap: 1rem; }
    .step-num { font-size: 1.4rem; min-width: 2rem; }
    .roadmap-row { gap: 0.7rem; padding: 0.8rem 0.9rem; flex-wrap: wrap; }
    .rm-status { font-size: 0.6rem; }
  }

  @media (max-width: 380px) {
    .hero-logo { width: 180px; }
    .kicker { font-size: 0.6rem; }
    .tagline { font-size: 1rem; }
    .section h2 { font-size: 1.15rem; }
  }
</style>
