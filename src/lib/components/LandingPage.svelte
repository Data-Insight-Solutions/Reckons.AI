<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { ONBOARDING_TEMPLATES, BLANK_TEMPLATE } from '$lib/onboarding/templates';
  import { addStatements, addSource } from '$lib/stores/kb.svelte';
  import { nudge } from '$lib/stores/tutorial.svelte';
  import { activateOfficialKb, preloadOfficialKb } from '$lib/stores/official-kb.svelte';
  import { importTurtleFull } from '$lib/rdf/import-ttl';
  import { startStory } from '$lib/stores/shelly-bridge.svelte';
  import * as kokoro from '$lib/integrations/llm/kokoro-tts';

  // Eagerly pre-fetch the official KB so it's ready when user clicks "Getting Started"
  preloadOfficialKb();

  // Kokoro TTS is lazy-loaded on first voice use — no automatic download.
  // The 87MB model only downloads when the user explicitly enables voice.

  let loadingTemplate = $state<string | null>(null);
  let loadingDocs = $state(false);
  let loadingExample = $state<string | null>(null);

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
    try {
      await activateOfficialKb();
      startStory(GUIDE_STORY_ID, true);
      goto('/');
    } finally {
      loadingDocs = false;
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
      body: 'Every statement knows its source, when it was added, and how trustworthy that source has proven to be over time.',
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
      body: 'Scrub back in time and reconstruct the KB at any moment. Trust scores decay correctly at historical timestamps.',
      color: 'var(--accent)'
    },
    {
      icon: '⟁',
      title: 'Semantic diff',
      body: 'Compare any two states: what was added, reinforced, conflicted, merged, or removed. Source attribution on every change.',
      color: 'var(--data)'
    }
  ];

  const ROADMAP = [
    { status: 'next',    label: 'MCP server',              note: 'Expose the KB as tools to any AI agent (Claude, Cursor, etc.)' },
    { status: 'next',    label: 'Markdown ingestion',       note: 'Drop .md files or Obsidian vaults → auto-extract triples' },
    { status: 'next',    label: 'A Reckoning',              note: 'STP workflow: Situation → Target → AI-synthesised Proposal from your KB' },
    { status: 'next',    label: 'Firecrawl + web research', note: 'Scrape any URL or crawl an entire site; each page becomes a traceable source' },
    { status: 'planned', label: 'Git version backbone',     note: 'Commit .ttl snapshots; GitHub Actions for automated KB analysis' },
    { status: 'planned', label: 'Voice interface',          note: 'Hume.AI voice + local GPU — ask questions aloud, review by voice' },
    { status: 'planned', label: 'Mobile + home server',     note: 'QR-link your iPhone to a local GPU server for full-model inference' },
    { status: 'planned', label: 'Hybrid retrieval',         note: 'BM25 + vector search over the triple store for MCP query answers' },
  ];
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
        An assistant that understands your context, <em>controlled by you,</em> private by default.
      </p>

      <div class="ctas">
        <button class="btn-primary" onclick={openDocsKb} disabled={loadingDocs}>
          {#if loadingDocs}
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
    <p class="section-sub">The documentation is itself a knowledge graph — browse it in 3D, talk to Shelly, play the guided story. Or import example data to see how your own KB will look.</p>

    <div class="template-grid">
      <button
        class="template-card template-docs"
        onclick={openDocsKb}
        disabled={loadingDocs}
      >
        <span class="tmpl-icon">📖</span>
        <strong class="tmpl-label">Documentation Graph</strong>
        <p class="tmpl-desc">The full Reckons.AI guide as an interactive knowledge graph. Read-only — your KB stays untouched.</p>
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
          <span class="tmpl-scenario mono">example data · imports into your KB</span>
          {#if loadingExample === kb.id}
            <span class="tmpl-loading mono">importing...</span>
          {:else}
            <span class="tmpl-cta">Import example →</span>
          {/if}
        </button>
      {/each}

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
      <p class="section-sub">Describe your situation. State your target. Reckons.AI consults your entire knowledge graph and synthesises a brief proposal, drawing only on what you've already verified.</p>

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
          <p>AI synthesises options from your KB: sourced, ranked, traceable.</p>
        </div>
      </div>

      <p class="reckoning-note mono">Voice-first version available. Brief input, conversational refinement, no forms.</p>
      <span class="coming-soon">coming next</span>
    </div>
  </section>

  <!-- Roadmap -->
  <section class="section">
    <p class="section-kicker mono">roadmap</p>
    <h2>What's being built.</h2>

    <div class="roadmap-list">
      {#each ROADMAP as item}
        <div class="roadmap-row">
          <span class="rm-status {item.status}">{item.status === 'next' ? 'up next' : 'planned'}</span>
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
          <p>Approve statements, merge duplicate entities, flag conflicts. Your KB grows with every decision, all logged.</p>
          <a href="/review" class="step-link">Open Review →</a>
        </div>
      </div>
    </div>
  </section>

  <footer class="landing-footer">
    <p class="mono"><img src="/svg/logo-text.svg" alt="Reckons.AI" class="footer-logo" /> · local-first · open source · RDF/Turtle</p>
    <p class="mono footer-pricing">Core is free forever. Cloud and enterprise services available. <a href="https://data-insight.solutions/contact" target="_blank" rel="noopener noreferrer">Contact for inquiries →</a></p>
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

  .rm-status.next {
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid var(--accent);
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
