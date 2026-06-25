<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { importTurtleFull } from '$lib/rdf/import-ttl';
  import { addStatements, addSource } from '$lib/stores/kb.svelte';
  import { activateOfficialKb, officialKbActive } from '$lib/stores/official-kb.svelte';
  import { startStory } from '$lib/stores/shelly-bridge.svelte';

  // ── Compression benchmark data ─────────────────────────────────────────
  const GITHUB_REPO = 'https://github.com/Data-Insight-Solutions/Reckons.AI';
  const FIXTURES_PATH = `${GITHUB_REPO}/tree/main/tests/bench/fixtures/why`;
  const BENCH_SCRIPT = `${GITHUB_REPO}/blob/main/tests/bench/run-compression-bench.ts`;

  type CategoryResult = {
    category: string;
    label: string;
    source: { bytes: number; words: number; tokens: number };
    triples: { count: number; turtleBytes: number; turtleTokens: number };
    compression: { byteReduction: number; tokenReduction: number; factDensity: number; densityMultiplier: number };
  };
  type BenchData = {
    timestamp: string;
    categories: CategoryResult[];
    averages: { byteReduction: number; tokenReduction: number; densityMultiplier: number };
  };

  let benchData = $state<BenchData | null>(null);
  let selectedIdx = $state(0);
  const selected = $derived(benchData?.categories[selectedIdx] ?? null);

  function barWidth(pct: number): string {
    return `${Math.min(Math.abs(pct), 100)}%`;
  }

  // ── Example KBs (importable into user's own KB) ──────────────────────
  const EXAMPLE_KBS = [
    {
      id: 'quickstart',
      icon: '🚀',
      title: 'Quick-Start Example',
      body: 'People, projects, research notes, decisions, and metrics — see how real-world data maps to triples.',
      file: '/starter-quickstart.ttl',
      entities: 15,
      triples: 90
    },
  ];

  let loadingKb = $state<string | null>(null);
  let loadError = $state('');
  let switchingToOfficial = $state(false);

  async function importStarterKB(kb: typeof EXAMPLE_KBS[0]) {
    loadingKb = kb.id;
    loadError = '';
    try {
      const res = await fetch(kb.file);
      if (!res.ok) throw new Error(`Failed to fetch ${kb.file}`);
      const ttl = await res.text();
      const { statements, sources } = await importTurtleFull(ttl);
      for (const src of sources) await addSource(src);
      if (statements.length) await addStatements(statements, 'starter-kb');
      goto('/');
    } catch (e) {
      loadError = (e as Error).message || 'Import failed';
      loadingKb = null;
    }
  }

  async function switchToOfficialKb() {
    switchingToOfficial = true;
    loadError = '';
    try {
      await activateOfficialKb();
      startStory('urn:reckons:story/ReckonsPhilosophy', true);
      goto('/');
    } catch (e) {
      loadError = (e as Error).message || 'Failed to load official KB';
      switchingToOfficial = false;
    }
  }

  // ── Cycling triple examples ──────────────────────────────────────────────
  const EXAMPLES = [
    { s: 'Alice',          p: 'knows',          o: 'Bob',              src: 'linkedin.com'   },
    { s: 'IPCC Report',    p: 'states',          o: 'CO₂ at 421 ppm',  src: 'ipcc.ch'        },
    { s: 'Project Alpha',  p: 'deadline',        o: '2025-Q3',          src: 'meeting notes'  },
    { s: 'Aspirin',        p: 'reduces risk of', o: 'heart attack',     src: 'pubmed #2945812'},
    { s: 'Q4 Revenue',     p: 'exceeded',        o: 'forecast by 12%',  src: 'earnings call'  },
    { s: 'Paris Agreement',p: 'targets',         o: '1.5°C warming',    src: 'unfccc.int'     },
  ];

  let exIdx = $state(0);
  let fading = $state(false);

  onMount(() => {
    const iv = setInterval(() => {
      fading = true;
      setTimeout(() => {
        exIdx = (exIdx + 1) % EXAMPLES.length;
        fading = false;
      }, 250);
    }, 3200);

    // Fetch compression benchmark data
    fetch('/compression-results.json')
      .then(res => { if (res.ok) return res.json(); })
      .then(json => { if (json) benchData = json; })
      .catch(() => {});

    return () => clearInterval(iv);
  });

  const ex = $derived(EXAMPLES[exIdx]);

  // ── Hero canvas ──────────────────────────────────────────────────────────
  let canvas = $state<HTMLCanvasElement | null>(null);

  onMount(() => {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => { canvas!.width = Math.round(canvas!.offsetWidth * dpr); canvas!.height = Math.round(canvas!.offsetHeight * dpr); };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    type Pt = { x: number; y: number; vx: number; vy: number };
    const pts: Pt[] = Array.from({ length: 28 }, () => ({
      x: Math.random(), y: Math.random(),
      vx: (Math.random() - 0.5) * 0.00025,
      vy: (Math.random() - 0.5) * 0.00025,
    }));
    const links: [number,number][] = [];
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        if (Math.random() < 0.12) links.push([i, j]);
      }
    }

    let raf = 0;
    const draw = () => {
      const width = canvas!.offsetWidth, height = canvas!.offsetHeight;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      for (const p of pts) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > 1) p.vx *= -1;
        if (p.y < 0 || p.y > 1) p.vy *= -1;
      }
      for (const [a, b] of links) {
        const pa = pts[a], pb = pts[b];
        const dist = Math.hypot((pa.x - pb.x) * width, (pa.y - pb.y) * height);
        if (dist > 260) continue;
        ctx.beginPath();
        ctx.moveTo(pa.x * width, pa.y * height);
        ctx.lineTo(pb.x * width, pb.y * height);
        ctx.strokeStyle = `rgba(26,155,142,${0.12 * (1 - dist / 260)})`;
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x * width, p.y * height, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(26,155,142,0.35)';
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  });

  // ── Architecture features ────────────────────────────────────────────────
  const ARCH = [
    { icon: '⬡', title: 'No backend server',   body: 'Everything runs in your browser. No cloud, no deploy, no ops.' },
    { icon: '◎', title: 'No account needed',    body: 'No sign-up, no email, no profile. Open the app and start.' },
    { icon: '◷', title: 'No tracking, ever',    body: 'Zero analytics, zero telemetry. We literally cannot see your data.' },
    { icon: '⬢', title: 'Local-first storage',  body: 'All triples live in IndexedDB in your browser. Export as .ttl anytime.' },
    { icon: '⧖', title: 'Portable Turtle file', body: 'Export a .ttl: W3C standard RDF. Any RDF tool can read it, forever.' },
    { icon: '⟁', title: 'Open source',          body: 'MIT-licensed. Read it, fork it, self-host it, run it offline forever.' },
  ];

  // ── Use cases ────────────────────────────────────────────────────────────
  const USES = [
    { icon: '🔬', title: 'Research & Academia', body: 'Track papers, authors, claims, contradictions. Build a lit-review graph where every statement traces back to its source.' },
    { icon: '📈', title: 'Business Intelligence', body: 'Capture meeting notes, competitor signals, market data. Ask "what do we know about X?" and get sourced answers from your KB.' },
    { icon: '🧠', title: 'Personal Knowledge', body: 'Your second brain, but structured. Every book summary, insight, and decision logged as verifiable triples, not just text.' },
    { icon: '⚖️',  title: 'Decision Making',    body: 'State your Situation and Target, and get a Proposal that cites only facts you\'ve already confirmed. No hallucinations, only your KB.' },
    { icon: '🏗️', title: 'Project Planning',    body: 'Timelines, dependencies, stakeholders, constraints: all as triples with provenance. History playback shows the project at any past moment.' },
    { icon: '🤝', title: 'Collaboration',        body: 'Export your .ttl, share it. Recipients see a full semantic diff: what you added, what conflicts with their own KB.' },
  ];
</script>

<div class="page">

  <!-- ── Hero ────────────────────────────────────────────────────────────── -->
  <section class="hero">
    <canvas bind:this={canvas} class="hero-canvas" aria-hidden="true"></canvas>
    <div class="hero-inner">
      <p class="kicker mono">knowledge graph · RDF · W3C standard</p>
      <h1>A simple model<br>that scales to <em>anything.</em></h1>
      <p class="tagline">
        One fact. Three parts. Infinite reach.<br>
        Reckons.AI turns your notes, documents, and research into a structured,<br>
        <strong>traceable, AI-queryable knowledge graph</strong>, running entirely on your device.
      </p>
      <div class="hero-badges">
        <span class="badge">local-first</span>
        <span class="badge">open source</span>
        <span class="badge">RDF / Turtle</span>
        <span class="badge">no account</span>
        <span class="badge">no backend</span>
        <span class="badge">MIT license</span>
      </div>
      <div class="hero-ctas">
        <a href="/" class="btn-primary">Open Graph →</a>
        <a href="/ingest" class="btn-secondary">Add your first source</a>
      </div>
    </div>
    <div class="scroll-hint" aria-hidden="true">↓</div>

    <!-- Sea creature: graph-fish swimming right -->
    <div class="sea-creature sea-hero-fish" aria-hidden="true">
      <svg viewBox="0 0 200 130" width="100%">
        <g stroke="#3a9a92" stroke-width="1.3" fill="none">
          <polyline points="160,65 105,40 64,65 105,90 160,65"></polyline>
          <line x1="108" y1="65" x2="160" y2="65"></line><line x1="108" y1="65" x2="105" y2="40"></line><line x1="108" y1="65" x2="64" y2="65"></line><line x1="108" y1="65" x2="105" y2="90"></line>
          <line x1="105" y1="40" x2="102" y2="22"></line>
          <line x1="64" y1="65" x2="32" y2="44"></line><line x1="64" y1="65" x2="32" y2="88"></line><line x1="32" y1="44" x2="32" y2="88"></line>
        </g>
        <g fill="#2E8F8C"><circle cx="108" cy="65" r="3.2"></circle><circle cx="105" cy="40" r="3"></circle><circle cx="64" cy="65" r="3"></circle><circle cx="105" cy="90" r="3"></circle></g>
        <g fill="#68b8ae"><circle cx="160" cy="65" r="4.5" class="sea-twinkle"></circle><circle cx="102" cy="22" r="4" class="sea-twinkle d1"></circle><circle cx="32" cy="44" r="4" class="sea-twinkle d2"></circle><circle cx="32" cy="88" r="4" class="sea-twinkle d3"></circle></g>
        <circle cx="150" cy="60" r="2" fill="#0b1116"></circle>
      </svg>
    </div>

    <!-- Bubbles -->
    <div class="sea-bubbles sea-hero-bubbles" aria-hidden="true">
      <div class="bubble b1"></div>
      <div class="bubble b2"></div>
      <div class="bubble b3"></div>
    </div>
  </section>

  <!-- ── What is a Triple ─────────────────────────────────────────────────── -->
  <section class="section">
    <p class="section-kicker mono">the foundation</p>
    <h2>What is a Triple?</h2>
    <p class="section-sub">
      An RDF triple is the atomic unit of structured knowledge.
      Three parts. One fact. Anything expressible in human language can be expressed as a triple.
    </p>

    <!-- Animated triple display -->
    <div class="triple-display" class:fading>
      <div class="triple-node triple-s">
        <span class="triple-role mono">Subject</span>
        <span class="triple-value">{ex.s}</span>
      </div>
      <div class="triple-connector">
        <div class="triple-arrow-line"></div>
        <div class="triple-node triple-p">
          <span class="triple-role mono">Predicate</span>
          <span class="triple-value">{ex.p}</span>
        </div>
        <div class="triple-arrow-line"></div>
      </div>
      <div class="triple-node triple-o">
        <span class="triple-role mono">Object</span>
        <span class="triple-value">{ex.o}</span>
      </div>
      <div class="triple-src">
        <span class="triple-src-label mono">source</span>
        <span class="triple-src-value mono">{ex.src}</span>
      </div>
    </div>

    <div class="triple-explainer">
      <div class="triple-rule">
        <span class="rule-num">1</span>
        <div>
          <strong>Subject</strong> — the thing being described. A person, event, concept, dataset, or anything with a unique identity.
        </div>
      </div>
      <div class="triple-rule">
        <span class="rule-num">2</span>
        <div>
          <strong>Predicate</strong> — the relationship or property. What is true of the subject? What does it do? What does it measure?
        </div>
      </div>
      <div class="triple-rule">
        <span class="rule-num">3</span>
        <div>
          <strong>Object</strong> — the value or target. Another entity, a literal string, a number, a date, a measurement.
        </div>
      </div>
    </div>

    <!-- Turtle syntax callout -->
    <div class="code-callout">
      <p class="code-label mono">The Turtle (.ttl) format — W3C standard, human-readable</p>
      <pre class="code-block mono"><code
><span class="tok-prefix">@prefix kb:   &lt;urn:kbase:concept/&gt; .</span>
<span class="tok-prefix">@prefix pred: &lt;urn:kbase:predicate/&gt; .</span>

<span class="tok-s">kb:alice</span>  <span class="tok-p">pred:knows</span>     <span class="tok-o">kb:bob</span> .
<span class="tok-s">kb:alice</span>  <span class="tok-p">pred:role</span>      <span class="tok-o">"engineer"</span> .
<span class="tok-s">kb:report</span> <span class="tok-p">pred:cites</span>     <span class="tok-o">kb:alice</span> .
<span class="tok-s">kb:report</span> <span class="tok-p">pred:published</span> <span class="tok-o">"2025-01-12"^^xsd:date</span> .</code></pre>
      <p class="code-note">Any RDF tool (SPARQL endpoints, Protégé, PoolParty, Neo4j, Python's rdflib) can read your .ttl file directly.</p>
    </div>

    <div class="triple-power-grid">
      <div class="power-item">
        <span class="power-icon">∞</span>
        <strong>Infinite expressivity</strong>
        <p>Any fact about any domain. Chemistry, history, finance, relationships, code: the model never changes.</p>
      </div>
      <div class="power-item">
        <span class="power-icon">⟳</span>
        <strong>Machine-readable by design</strong>
        <p>Structured from the ground up. AI can query, reason over, and extend your graph — no parsing required.</p>
      </div>
      <div class="power-item">
        <span class="power-icon">◈</span>
        <strong>Provenance as first class</strong>
        <p>Every triple in Reckons.AI carries its source. You always know where a fact came from and how trusted that source is.</p>
      </div>
      <div class="power-item">
        <span class="power-icon">⬡</span>
        <strong>W3C open standard</strong>
        <p>RDF has been an open web standard since 1999. Your Turtle file will be readable by any tool, forever.</p>
      </div>
    </div>
  </section>

  <!-- ── Pipeline diagram ──────────────────────────────────────────────────── -->
  <section class="section pipeline-section">
    <p class="section-kicker mono">how it works</p>
    <h2>From raw source to <em>structured knowledge.</em></h2>
    <p class="section-sub">
      Reckons.AI extracts triples from anything you give it, lets you review every claim,
      and builds a knowledge graph you can query, visualise, and reason over.
    </p>

    <div class="pipeline">
      <!-- Row 1: Sources -->
      <div class="pipe-node pipe-sources">
        <span class="pipe-tag mono">inputs</span>
        <div class="pipe-sources-grid">
          <span class="source-chip mono">📄 note</span>
          <span class="source-chip mono">🔗 url</span>
          <span class="source-chip mono">📁 document</span>
          <span class="source-chip mono"><img src="/svg/head1.svg" alt="" style="height:0.85em;width:auto;vertical-align:middle" /> .ttl file</span>
          <span class="source-chip mono">📅 calendar</span>
        </div>
      </div>

      <div class="pipe-arrow-v" aria-hidden="true">
        <div class="pipe-line"></div>
        <div class="pipe-arrowhead">▼</div>
      </div>

      <!-- Row 2: AI Extraction -->
      <div class="pipe-node pipe-ai">
        <span class="pipe-tag mono">extraction</span>
        <strong>AI extracts triples</strong>
        <p>Claude · GPT · Gemini · Ollama · WASM. Any backend, fully offline if preferred. No cloud required.</p>
      </div>

      <div class="pipe-arrow-v" aria-hidden="true">
        <div class="pipe-line"></div>
        <div class="pipe-arrowhead">▼</div>
      </div>

      <!-- Row 3: Review -->
      <div class="pipe-node pipe-review">
        <span class="pipe-tag mono">you decide</span>
        <strong>Review &amp; Confirm</strong>
        <p>Accept, reject, or refine each proposed triple. Merge duplicate entities. Resolve conflicts. Nothing enters your KB without your approval.</p>
      </div>

      <div class="pipe-arrow-v" aria-hidden="true">
        <div class="pipe-line"></div>
        <div class="pipe-arrowhead">▼</div>
      </div>

      <!-- Row 4: Knowledge Graph (hub) -->
      <div class="pipe-node pipe-hub">
        <span class="pipe-tag mono">your knowledge graph</span>
        <strong>Turtle (.ttl) · RDF · W3C standard</strong>
        <div class="pipe-triple-demo">
          <span class="ptr-s">Subject</span>
          <span class="ptr-arrow">→</span>
          <span class="ptr-p">Predicate</span>
          <span class="ptr-arrow">→</span>
          <span class="ptr-o">Object</span>
        </div>
        <p>All confirmed triples live in IndexedDB locally. Export to .ttl anytime. Import into any RDF tool. Portable forever.</p>
      </div>

      <!-- Row 5: Fork to 3D + Reckoning -->
      <div class="pipe-fork">
        <div class="pipe-fork-branch">
          <div class="pipe-arrow-v" aria-hidden="true">
            <div class="pipe-line"></div>
            <div class="pipe-arrowhead">▼</div>
          </div>
          <div class="pipe-node pipe-output">
            <span class="pipe-tag mono">explore</span>
            <strong>3D Graph View</strong>
            <p>Force-directed graph. Filter by type or source. Hub emphasis. History playback.</p>
          </div>
        </div>
        <div class="pipe-fork-branch">
          <div class="pipe-arrow-v" aria-hidden="true">
            <div class="pipe-line"></div>
            <div class="pipe-arrowhead">▼</div>
          </div>
          <div class="pipe-node pipe-output pipe-reckoning">
            <span class="pipe-tag mono">decide</span>
            <strong>A Reckoning</strong>
            <p>Context-aware AI proposals. Only draws on facts you've confirmed. Every option is sourced and traceable.</p>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Sea creature: graph-fish swimming left (between sections) -->
  <div class="sea-divider" aria-hidden="true">
    <div class="sea-creature sea-mid-fish">
      <svg viewBox="0 0 170 110" width="100%">
        <g stroke="#3a9a92" stroke-width="1.3" fill="none">
          <line x1="24" y1="55" x2="58" y2="32"></line><line x1="24" y1="55" x2="58" y2="78"></line>
          <line x1="58" y1="32" x2="104" y2="55"></line><line x1="58" y1="78" x2="104" y2="55"></line><line x1="58" y1="32" x2="58" y2="78"></line>
          <line x1="104" y1="55" x2="126" y2="55"></line>
          <line x1="126" y1="55" x2="148" y2="30"></line><line x1="126" y1="55" x2="148" y2="80"></line><line x1="148" y1="30" x2="148" y2="80"></line>
          <polyline points="70,33 86,16 100,35"></polyline>
        </g>
        <g fill="#2E8F8C"><circle cx="24" cy="55" r="3"></circle><circle cx="58" cy="32" r="3"></circle><circle cx="58" cy="78" r="3"></circle><circle cx="104" cy="55" r="3"></circle><circle cx="126" cy="55" r="3"></circle></g>
        <g fill="#68b8ae"><circle cx="148" cy="30" r="4" class="sea-twinkle"></circle><circle cx="148" cy="80" r="4" class="sea-twinkle d1"></circle></g>
        <circle cx="40" cy="50" r="2.2" fill="#0b1116"></circle>
      </svg>
    </div>
    <div class="sea-bubbles sea-mid-bubbles">
      <div class="bubble b1"></div>
      <div class="bubble b2"></div>
    </div>
  </div>

  <!-- ── Compression benchmarks (verified) ──────────────────────────────────── -->
  {#if benchData}
    <section class="section bench-section">
      <p class="section-kicker mono">verified calculation</p>
      <h2>Condense your context.<br><em>Keep the meaning.</em></h2>
      <p class="section-sub">
        We checked the math — {benchData.categories.length} categories, real text, measured byte-for-byte.
        Each source is condensed to the facts it asserts.
      </p>

      <!-- Hero stats -->
      <div class="bench-hero-stats">
        <div class="bench-stat" title="View benchmark script" aria-label="Average byte reduction across {benchData.categories.length} categories">
          <a href={BENCH_SCRIPT} target="_blank" rel="noopener noreferrer" class="bench-stat-link">
            <span class="bench-stat-value mono">{benchData.averages.byteReduction}%</span>
            <span class="bench-stat-label mono">bytes</span>
          </a>
        </div>
        <div class="bench-stat" title="View benchmark script" aria-label="Average token reduction">
          <a href={BENCH_SCRIPT} target="_blank" rel="noopener noreferrer" class="bench-stat-link">
            <span class="bench-stat-value mono">{benchData.averages.tokenReduction}%</span>
            <span class="bench-stat-label mono">tokens</span>
          </a>
        </div>
        <div class="bench-stat" title="View benchmark script" aria-label="Average density multiplier">
          <a href={BENCH_SCRIPT} target="_blank" rel="noopener noreferrer" class="bench-stat-link">
            <span class="bench-stat-value mono">{benchData.averages.densityMultiplier}×</span>
            <span class="bench-stat-label mono">denser</span>
          </a>
        </div>
      </div>

      <!-- Category picker -->
      <div class="bench-picker">
        {#each benchData.categories as cat, i}
          <button
            class="bench-chip"
            class:active={selectedIdx === i}
            onclick={() => selectedIdx = i}
          >
            {cat.category}
          </button>
        {/each}
      </div>

      <!-- Selected category detail -->
      {#if selected}
        <div class="bench-detail">
          <div class="bench-detail-header">
            <span class="bench-detail-cat mono">{selected.category}</span>
            <a href={FIXTURES_PATH} target="_blank" rel="noopener noreferrer" class="bench-detail-title" title="View test fixtures on GitHub">{selected.label}</a>
          </div>

          <div class="bench-metrics-grid">
            <div class="bench-metric">
              <div class="bench-bar-track">
                <div class="bench-bar bench-bar-byte" style:width={barWidth(selected.compression.byteReduction)}></div>
              </div>
              <div class="bench-metric-row">
                <span class="bench-metric-value mono">{selected.compression.byteReduction}%</span>
                <span class="bench-metric-label mono">bytes</span>
              </div>
              <div class="bench-metric-detail mono">{selected.source.bytes.toLocaleString()} → {selected.triples.turtleBytes.toLocaleString()} bytes</div>
            </div>
            <div class="bench-metric">
              <div class="bench-bar-track">
                <div class="bench-bar bench-bar-token" style:width={barWidth(selected.compression.tokenReduction)}></div>
              </div>
              <div class="bench-metric-row">
                <span class="bench-metric-value mono">{selected.compression.tokenReduction}%</span>
                <span class="bench-metric-label mono">tokens</span>
              </div>
              <div class="bench-metric-detail mono">{selected.source.tokens.toLocaleString()} → {selected.triples.turtleTokens.toLocaleString()} tokens</div>
            </div>
            <div class="bench-metric">
              <div class="bench-bar-track">
                <div class="bench-bar bench-bar-density" style:width={`${Math.min(selected.compression.densityMultiplier / 5 * 100, 100)}%`}></div>
              </div>
              <div class="bench-metric-row">
                <span class="bench-metric-value mono">{selected.compression.densityMultiplier}×</span>
                <span class="bench-metric-label mono">denser</span>
              </div>
              <div class="bench-metric-detail mono">{selected.triples.count} facts from {selected.source.words} words</div>
            </div>
          </div>
        </div>
      {/if}

      <!-- Summary table -->
      <div class="bench-table-wrap">
        <table class="bench-table">
          <thead>
            <tr>
              <th>Category</th>
              <th>Source</th>
              <th>Bytes</th>
              <th>Tokens</th>
              <th>Density</th>
            </tr>
          </thead>
          <tbody>
            {#each benchData.categories as cat}
              <tr>
                <td>
                  <span class="bench-td-cat mono">{cat.category}</span>
                  <span class="bench-td-label">{cat.label}</span>
                </td>
                <td class="bench-num mono">{cat.source.words} words</td>
                <td class="bench-num mono">{cat.compression.byteReduction}%</td>
                <td class="bench-num mono">{cat.compression.tokenReduction}%</td>
                <td class="bench-num mono">{cat.compression.densityMultiplier}×</td>
              </tr>
            {/each}
          </tbody>
          <tfoot>
            <tr>
              <td>Average</td>
              <td></td>
              <td class="bench-num mono">{benchData.averages.byteReduction}%</td>
              <td class="bench-num mono">{benchData.averages.tokenReduction}%</td>
              <td class="bench-num mono">{benchData.averages.densityMultiplier}×</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p class="bench-methodology mono">
        <a href={FIXTURES_PATH} target="_blank" rel="noopener noreferrer">test fixtures</a> ·
        <a href={BENCH_SCRIPT} target="_blank" rel="noopener noreferrer">benchmark script</a> ·
        run <code>npm run bench:compression</code> to reproduce
        {#if benchData.timestamp}
          · last run {new Date(benchData.timestamp).toLocaleDateString()}
        {/if}
      </p>
    </section>
  {/if}

  <!-- ── STP Framework ──────────────────────────────────────────────────────── -->
  <section class="section stp-section">
    <div class="stp-inner">
      <p class="section-kicker mono">the reckoning framework</p>
      <h2>Situation · Target · Proposal</h2>
      <p class="section-sub">
        Most AI assistants know nothing about your specific context.
        Reckons.AI inverts this: the AI sees only your confirmed facts, and nothing it hasn't earned.
      </p>

      <div class="stp-cards">
        <div class="stp-card">
          <span class="stp-num mono">S</span>
          <strong>Situation</strong>
          <p>Describe where you are right now. What's happening? What constraints exist? What do you know?</p>
          <div class="stp-example mono">"Our Q3 revenue missed forecast by 8%. Competitor launched a competing product last week. Team morale is low."</div>
        </div>
        <div class="stp-sep">→</div>
        <div class="stp-card">
          <span class="stp-num mono">T</span>
          <strong>Target</strong>
          <p>State what outcome you want. Be specific. What does success look like?</p>
          <div class="stp-example mono">"Recover to forecast trajectory by end of Q4 without reducing headcount."</div>
        </div>
        <div class="stp-sep">→</div>
        <div class="stp-card stp-proposal">
          <span class="stp-num mono">P</span>
          <strong>Proposal</strong>
          <p>The AI synthesises options grounded <em>only</em> in triples from your Knowledge Graph. Every option cites its sources.</p>
          <div class="stp-example mono">"Based on <em>3 confirmed sources</em>: Option A — accelerate feature X (revenue est. +6%). Option B — …"</div>
        </div>
      </div>

      <div class="stp-note">
        <span class="stp-note-icon">◈</span>
        <p>
          A Reckoning is not general AI advice. It is a <strong>structured reasoning pass over your verified facts</strong>.
          The quality of the Proposal is bounded by the quality of your KB, which is bounded by your own review decisions.
        </p>
      </div>
    </div>
  </section>

  <!-- ── Architecture ───────────────────────────────────────────────────────── -->
  <section class="section">
    <p class="section-kicker mono">architecture</p>
    <h2>No infrastructure.<br><em>By design.</em></h2>
    <p class="section-sub">
      The simplicity of the triple model carries through to the entire stack.
      There is nothing to deploy, nothing to maintain, and nothing that can leak your data.
    </p>

    <div class="arch-grid">
      {#each ARCH as a}
        <div class="arch-card">
          <span class="arch-icon">{a.icon}</span>
          <strong>{a.title}</strong>
          <p>{a.body}</p>
        </div>
      {/each}
    </div>

    <!-- Architecture stack diagram -->
    <div class="stack-diagram">
      <p class="stack-label mono">the complete dependency stack</p>
      <div class="stack-layers">
        <div class="stack-layer stack-you">
          <span class="stack-layer-label mono">your browser</span>
          <div class="stack-items">
            <span>SvelteKit</span>
            <span>Threlte / Three.js</span>
            <span>Dexie / IndexedDB</span>
            <span>N3.js (RDF)</span>
            <span>Transformers.js</span>
          </div>
        </div>
        <div class="stack-arrow-right" aria-hidden="true">
          <div class="stack-line-h"></div>
          <span class="stack-optional-label mono">optional, only if you choose</span>
        </div>
        <div class="stack-layer stack-optional">
          <span class="stack-layer-label mono">optional AI backends</span>
          <div class="stack-items">
            <span>Claude API</span>
            <span>OpenAI API</span>
            <span>Gemini API</span>
            <span>Ollama (local)</span>
            <span>WASM (built-in)</span>
          </div>
        </div>
      </div>
      <p class="stack-note">
        The AI backends are only called during extraction and Reckoning. Your Turtle data is never sent to any AI provider.
        If you use Ollama or the built-in WASM model, zero data leaves your machine. Ever.
      </p>
    </div>
  </section>

  <!-- ── AI without the downsides ──────────────────────────────────────────── -->
  <section class="section ethics-section">
    <p class="section-kicker mono">AI for the people</p>
    <h2>The power of AI.<br><em>Without the downsides.</em></h2>
    <p class="section-sub">
      AI should work for you, not harvest you.
      Reckons.AI is built on a simple principle: your knowledge is yours, full stop.
    </p>

    <div class="ethics-grid">
      <div class="ethics-card">
        <span class="ethics-icon">🔒</span>
        <strong>Your data stays yours</strong>
        <p>Nothing is sent to any server unless you explicitly choose an external AI backend. Your knowledge graph lives in your browser, on your device. No accounts, no sync, no surveillance.</p>
      </div>
      <div class="ethics-card">
        <span class="ethics-icon">🌱</span>
        <strong>No datacenter footprint</strong>
        <p>The core app runs entirely in your browser. Use Ollama or the built-in WASM model and zero inference traffic leaves your machine. No GPU clusters burning energy to process your notes.</p>
      </div>
      <div class="ethics-card">
        <span class="ethics-icon">⚖️</span>
        <strong>Not governed by big tech</strong>
        <p>Reckons.AI is an independent project. No investor pressure to monetise your data. No platform lock-in. Built on open W3C standards so your Turtle files work with any RDF tool, forever.</p>
      </div>
      <div class="ethics-card">
        <span class="ethics-icon">🔓</span>
        <strong>Open by default</strong>
        <p>The data format is W3C RDF. The app runs offline. You can export everything at any time. There is no proprietary format, no walled garden, and no way to be locked out of your own knowledge.</p>
      </div>
    </div>
  </section>

  <!-- ── Use cases ──────────────────────────────────────────────────────────── -->
  <section class="section">
    <p class="section-kicker mono">use it for anything</p>
    <h2>Personal knowledge. Business intelligence.<br><em>Same model. Same tools.</em></h2>
    <p class="section-sub">
      The triple model is domain-agnostic. Reckons.AI is a general-purpose knowledge graph
      that happens to be embedded with an AI assistant that knows exactly what you've confirmed.
    </p>

    <div class="uses-grid">
      {#each USES as u}
        <div class="use-card">
          <span class="use-icon">{u.icon}</span>
          <strong>{u.title}</strong>
          <p>{u.body}</p>
        </div>
      {/each}
    </div>
  </section>

  <!-- ── Getting Started ────────────────────────────────────────────────── -->
  <section class="section starter-section starter-hero">
    <p class="section-kicker mono">getting started</p>
    <h2>Explore the <em>documentation graph</em></h2>
    <p class="section-sub">
      The documentation is itself a knowledge graph. Browse it in 3D, talk to Shelly,
      play the guided story — then switch back to your own KB when you're ready to build.
    </p>

    {#if loadError}
      <div class="starter-error">{loadError}</div>
    {/if}

    <button
      class="starter-card official-card"
      onclick={switchToOfficialKb}
      disabled={switchingToOfficial || officialKbActive()}
    >
      <span class="starter-icon">📖</span>
      <div class="starter-info">
        <strong>Reckons.AI Documentation</strong>
        <p>Philosophy, triple architecture, RDF/Turtle syntax, language models, personal empowerment, all features, integrations, tips, security — plus a guided story walkthrough.</p>
        <div class="starter-stats mono">
          <span class="official-badge">read-only</span>
        </div>
      </div>
      {#if switchingToOfficial}
        <span class="starter-loading mono">loading...</span>
      {:else if officialKbActive()}
        <span class="starter-action mono">active</span>
      {:else}
        <span class="starter-action mono">open docs →</span>
      {/if}
    </button>

    <p class="starter-sub-heading mono">example data</p>
    <p class="starter-sub-desc">
      Import example triples into your own KB to see how real-world data looks as a graph.
    </p>

    <div class="starter-grid">
      {#each EXAMPLE_KBS as kb (kb.id)}
        <button
          class="starter-card"
          onclick={() => importStarterKB(kb)}
          disabled={loadingKb !== null}
        >
          <span class="starter-icon">{kb.icon}</span>
          <div class="starter-info">
            <strong>{kb.title}</strong>
            <p>{kb.body}</p>
            <div class="starter-stats mono">
              <span>{kb.entities} entities</span>
              <span>{kb.triples} triples</span>
            </div>
          </div>
          {#if loadingKb === kb.id}
            <span class="starter-loading mono">importing...</span>
          {:else}
            <span class="starter-action mono">import →</span>
          {/if}
        </button>
      {/each}
    </div>
  </section>

  <!-- ── Quick Reference ──────────────────────────────────────────────────── -->
  <section class="section ref-section" aria-label="Quick reference">
    <p class="section-kicker mono">quick reference</p>
    <h2>Common Predicates &amp; Patterns</h2>
    <p class="section-sub">
      These are real triple patterns you can use in your knowledge graph.
      Reckons.AI uses standard RDF vocabularies wherever possible.
    </p>

    <div class="ref-grid">
      <div class="ref-card">
        <h4 class="ref-card-title mono">describing things</h4>
        <div class="ref-triple mono"><span class="rt-s">kb:Earth</span> <span class="rt-p">rdf:type</span> <span class="rt-o">kb:Planet</span></div>
        <div class="ref-triple mono"><span class="rt-s">kb:Earth</span> <span class="rt-p">rdfs:label</span> <span class="rt-o">"Earth"</span></div>
        <div class="ref-triple mono"><span class="rt-s">kb:Earth</span> <span class="rt-p">dc:description</span> <span class="rt-o">"Third planet from the Sun"</span></div>
      </div>
      <div class="ref-card">
        <h4 class="ref-card-title mono">relationships</h4>
        <div class="ref-triple mono"><span class="rt-s">kb:Alice</span> <span class="rt-p">foaf:knows</span> <span class="rt-o">kb:Bob</span></div>
        <div class="ref-triple mono"><span class="rt-s">kb:Alice</span> <span class="rt-p">pred:worksAt</span> <span class="rt-o">kb:AcmeCorp</span></div>
        <div class="ref-triple mono"><span class="rt-s">kb:TaskA</span> <span class="rt-p">pred:dependsOn</span> <span class="rt-o">kb:TaskB</span></div>
      </div>
      <div class="ref-card">
        <h4 class="ref-card-title mono">classification</h4>
        <div class="ref-triple mono"><span class="rt-s">kb:ML</span> <span class="rt-p">skos:broader</span> <span class="rt-o">kb:AI</span></div>
        <div class="ref-triple mono"><span class="rt-s">kb:NLP</span> <span class="rt-p">skos:related</span> <span class="rt-o">kb:ML</span></div>
        <div class="ref-triple mono"><span class="rt-s">kb:Report</span> <span class="rt-p">skos:definition</span> <span class="rt-o">"Annual sales analysis"</span></div>
      </div>
      <div class="ref-card">
        <h4 class="ref-card-title mono">temporal data</h4>
        <div class="ref-triple mono"><span class="rt-s">kb:Q2Revenue</span> <span class="rt-p">pred:value</span> <span class="rt-o">"$2.4M"</span></div>
        <div class="ref-triple mono"><span class="rt-s">kb:Q2Revenue</span> <span class="rt-p">pred:measuredAt</span> <span class="rt-o">"2026-06-01"^^xsd:date</span></div>
        <div class="ref-triple mono"><span class="rt-s">kb:Launch</span> <span class="rt-p">pred:deadline</span> <span class="rt-o">"2026-09-15"^^xsd:date</span></div>
      </div>
    </div>
  </section>

  <!-- ── CTA footer ─────────────────────────────────────────────────────────── -->
  <section class="section cta-section">
    <p class="section-kicker mono">start now</p>
    <h2>Your knowledge graph starts<br>with one triple.</h2>
    <p class="section-sub">
      No account. No install. No API key required. The built-in WASM model works out of the box.
    </p>
    <div class="cta-buttons">
      <a href="/ingest" class="btn-primary">Add your first source →</a>
      <a href="/" class="btn-secondary">Explore the graph</a>
      <a href="/settings" class="btn-secondary">Configure a backend</a>
    </div>

    <!-- Sea creature: flipped graph-fish -->
    <div class="sea-creature sea-cta-fish" aria-hidden="true">
      <svg viewBox="0 0 170 110" width="100%" style="transform:scaleX(-1)">
        <g stroke="#44a79d" stroke-width="1.3" fill="none">
          <line x1="24" y1="55" x2="58" y2="32"></line><line x1="24" y1="55" x2="58" y2="78"></line>
          <line x1="58" y1="32" x2="104" y2="55"></line><line x1="58" y1="78" x2="104" y2="55"></line><line x1="58" y1="32" x2="58" y2="78"></line>
          <line x1="104" y1="55" x2="126" y2="55"></line>
          <line x1="126" y1="55" x2="148" y2="30"></line><line x1="126" y1="55" x2="148" y2="80"></line><line x1="148" y1="30" x2="148" y2="80"></line>
          <polyline points="70,33 86,16 100,35"></polyline>
        </g>
        <g fill="#2E8F8C"><circle cx="24" cy="55" r="3"></circle><circle cx="58" cy="32" r="3"></circle><circle cx="58" cy="78" r="3"></circle><circle cx="104" cy="55" r="3"></circle><circle cx="126" cy="55" r="3"></circle></g>
        <g fill="#68b8ae"><circle cx="148" cy="30" r="4" class="sea-twinkle"></circle><circle cx="148" cy="80" r="4" class="sea-twinkle d1"></circle></g>
        <circle cx="40" cy="50" r="2.2" fill="#0b1116"></circle>
      </svg>
    </div>
    <div class="sea-bubbles sea-cta-bubbles" aria-hidden="true">
      <div class="bubble b1"></div>
      <div class="bubble b2"></div>
      <div class="bubble b3"></div>
    </div>
  </section>

  <!-- ── Pricing / Support ────────────────────────────────────────────────── -->
  <section class="section pricing-section">
    <p class="section-kicker mono">pricing &amp; support</p>
    <h2>Core is free. <em>Always.</em></h2>
    <p class="section-sub">
      MIT-licensed and entirely self-funded. No VC, no ads, no tracking.
      Optional cloud and enterprise tiers are planned for teams that need more.
    </p>

    <div class="pricing-grid">
      <div class="pricing-tier">
        <span class="tier-badge mono">free forever</span>
        <strong>Core app</strong>
        <p>The full knowledge graph, local inference, provenance tracking, RDF/Turtle export and the complete open-source codebase. No account, no telemetry, no expiry.</p>
        <a
          href="https://www.paypal.com/ncp/payment/KH5J484QMVFS2"
          target="_blank"
          rel="noopener noreferrer"
          class="tier-contact mono"
          aria-label="Support Reckons.AI — Buy me a coffee"
        >☕ buy me a coffee</a>
        <img src="/png/BuymeaCoffee-qrcode.png" alt="Scan to support Reckons.AI" class="coffee-qr" />
      </div>
      <div class="pricing-tier">
        <span class="tier-badge mono tier-planned">coming</span>
        <strong>Cloud services</strong>
        <p>Managed inference with custom extraction and embedding models, higher-quality triple parsing, and hosted sync. Pay only for what you use.</p>
      </div>
      <div class="pricing-tier">
        <span class="tier-badge mono tier-enterprise">enterprise</span>
        <strong>Enterprise</strong>
        <p>Private deployment, custom model integrations, SLA support, and professional services through Data Insight Solutions LLC.</p>
        <a
          href="https://data-insight.solutions/contact"
          target="_blank"
          rel="noopener noreferrer"
          class="tier-contact mono"
        >Contact for inquiries →</a>
      </div>
    </div>
  </section>

  <footer class="page-footer">
    <p class="mono">Reckons.AI · local-first · open source · RDF/Turtle · MIT license</p>
    <p class="mono footer-credit">Developed by <a href="https://data-insight.solutions/" target="_blank" rel="noopener noreferrer">Data Insight Solutions LLC</a></p>
    <a href="https://github.com/Data-Insight-Solutions/Reckons.AI" target="_blank" rel="noopener noreferrer" class="footer-github mono">GitHub</a>
  </footer>
</div>

<style>
  .page {
    overflow-y: auto;
    overflow-x: hidden;
    padding-bottom: 5rem; /* clear nav bar */
  }

  /* ── Hero ────────────────────────────────────────────────────── */
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

  .hero-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    opacity: 0.6;
  }

  .hero-inner {
    position: relative;
    z-index: 1;
    max-width: 700px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.2rem;
    animation: rise 0.9s ease-out both;
  }

  @keyframes rise {
    from { opacity: 0; transform: translateY(28px); }
    to   { opacity: 1; transform: translateY(0);    }
  }

  .kicker {
    font-size: 0.7rem;
    color: var(--muted);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    margin: 0;
  }

  .hero h1 {
    font-family: var(--font-display);
    font-size: clamp(2.8rem, 9vw, 6rem);
    font-weight: 700;
    letter-spacing: -0.04em;
    line-height: 1.05;
    margin: 0;
    color: var(--ink);
  }
  .hero h1 em { color: var(--accent); font-style: italic; }

  .tagline {
    font-size: 1.05rem;
    color: var(--ink-2);
    line-height: 1.65;
    margin: 0;
  }
  .tagline strong { color: var(--ink); }

  .hero-badges {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.45rem;
  }

  .badge {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    color: var(--muted);
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
  }

  .hero-ctas {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    justify-content: center;
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
    0%,100% { transform: translateX(-50%) translateY(0); }
    50%      { transform: translateX(-50%) translateY(7px); }
  }

  /* ── Buttons ──────────────────────────────────────────────────── */
  .btn-primary {
    background: var(--accent);
    color: #fff;
    padding: 0.7rem 1.4rem;
    border-radius: var(--rad);
    text-decoration: none;
    font-size: 0.95rem;
    font-weight: 500;
    transition: opacity 0.15s, transform 0.15s;
    display: inline-block;
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
    display: inline-block;
  }
  .btn-secondary:hover { background: var(--surface-3); }

  /* ── Sections ──────────────────────────────────────────────────── */
  .section {
    padding: 5rem 2rem;
    max-width: 920px;
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
    font-family: var(--font-display);
    font-size: clamp(1.8rem, 4vw, 2.8rem);
    font-weight: 700;
    color: var(--ink);
    line-height: 1.15;
  }
  .section h2 em { color: var(--accent); font-style: italic; }

  .section-sub {
    color: var(--ink-2);
    font-size: 1rem;
    margin: 0 0 2.5rem;
    max-width: 600px;
    line-height: 1.65;
  }

  /* ── Triple display ────────────────────────────────────────────── */
  .triple-display {
    display: flex;
    align-items: center;
    gap: 0;
    justify-content: center;
    flex-wrap: wrap;
    margin: 0 0 2.5rem;
    padding: 2rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad-lg);
    transition: opacity 0.25s ease;
    min-height: 130px;
  }

  .triple-display.fading { opacity: 0.15; }

  .triple-node {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    padding: 0.9rem 1.4rem;
    border-radius: var(--rad);
    min-width: 120px;
    text-align: center;
  }

  .triple-s {
    background: color-mix(in srgb, var(--accent) 12%, var(--surface-2));
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  }

  .triple-p {
    background: color-mix(in srgb, var(--data) 12%, var(--surface-2));
    border: 1px solid color-mix(in srgb, var(--data) 40%, transparent);
    min-width: 140px;
  }

  .triple-o {
    background: color-mix(in srgb, var(--accent) 8%, var(--surface-2));
    border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
  }

  .triple-role {
    font-size: 0.6rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .triple-value {
    font-family: var(--font-display);
    font-size: 1.15rem;
    color: var(--ink);
    font-style: italic;
  }

  .triple-connector {
    display: flex;
    align-items: center;
    gap: 0;
  }

  .triple-arrow-line {
    width: 2rem;
    height: 2px;
    background: linear-gradient(90deg, var(--line), var(--muted));
    position: relative;
  }
  .triple-arrow-line::after {
    content: '▶';
    position: absolute;
    right: -8px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 0.6rem;
    color: var(--muted);
  }

  .triple-src {
    position: absolute;
    right: 1.5rem;
    bottom: 0.8rem;
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .triple-display { position: relative; }

  .triple-src-label {
    font-size: 0.6rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted-2);
  }

  .triple-src-value {
    font-size: 0.7rem;
    color: var(--accent);
  }

  /* ── Triple explainer rules ────────────────────────────────────── */
  .triple-explainer {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
    margin-bottom: 2rem;
  }

  .triple-rule {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
  }

  .rule-num {
    font-family: var(--font-mono);
    font-size: 1.4rem;
    color: var(--accent);
    font-weight: 700;
    line-height: 1.2;
    flex-shrink: 0;
    min-width: 1.4rem;
  }

  .triple-rule strong {
    display: block;
    color: var(--ink);
    margin-bottom: 0.2rem;
  }

  .triple-rule div {
    font-size: 0.9rem;
    color: var(--ink-2);
    line-height: 1.55;
  }

  /* ── Code callout ──────────────────────────────────────────────── */
  .code-callout {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    overflow: hidden;
    margin: 0 0 2.5rem;
  }

  .code-label {
    font-size: 0.65rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
    background: var(--surface-2);
    border-bottom: 1px solid var(--line);
    padding: 0.5rem 1.2rem;
    margin: 0;
  }

  .code-block {
    margin: 0;
    padding: 1.2rem 1.4rem;
    font-size: 0.82rem;
    line-height: 1.75;
    overflow-x: auto;
  }

  .code-block code { display: block; }
  .tok-prefix { color: var(--muted); }
  .tok-s { color: var(--accent); }
  .tok-p { color: var(--data); opacity: 0.9; }
  .tok-o { color: #6ab68a; }

  .code-note {
    font-size: 0.8rem;
    color: var(--muted);
    padding: 0.7rem 1.4rem;
    border-top: 1px solid var(--line);
    margin: 0;
    font-style: italic;
  }

  /* ── Triple power grid ─────────────────────────────────────────── */
  .triple-power-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
  }

  .power-item {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.3rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    transition: border-color 0.2s, transform 0.2s;
  }
  .power-item:hover { border-color: var(--accent); transform: translateY(-2px); }

  .power-icon {
    font-size: 1.4rem;
    color: var(--accent);
    line-height: 1;
    font-family: var(--font-mono);
  }

  .power-item strong {
    font-size: 0.95rem;
    color: var(--ink);
  }

  .power-item p {
    font-size: 0.83rem;
    color: var(--muted);
    margin: 0;
    line-height: 1.55;
  }

  /* ── Pipeline diagram ──────────────────────────────────────────── */
  .pipeline-section {
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
  }

  .pipeline {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0;
  }

  .pipe-node {
    width: 100%;
    max-width: 520px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.2rem 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    transition: border-color 0.2s;
  }

  .pipe-node strong {
    font-size: 1rem;
    color: var(--ink);
  }

  .pipe-node p {
    font-size: 0.82rem;
    color: var(--muted);
    margin: 0;
    line-height: 1.5;
  }

  .pipe-tag {
    font-size: 0.6rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 0.1rem;
  }

  .pipe-sources {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 6%, var(--surface));
  }

  .pipe-sources-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .source-chip {
    font-size: 0.72rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0.18rem 0.6rem;
    color: var(--ink-2);
  }

  .pipe-ai {
    border-color: var(--data);
    background: color-mix(in srgb, var(--data) 5%, var(--surface));
  }

  .pipe-review {
    border-color: var(--ok);
    background: color-mix(in srgb, var(--ok) 5%, var(--surface));
  }

  .pipe-hub {
    border-color: var(--accent);
    border-width: 2px;
    background: color-mix(in srgb, var(--accent) 10%, var(--surface));
    box-shadow: 0 0 32px -8px rgba(26,155,142,0.25);
  }

  .pipe-triple-demo {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.3rem 0;
    font-family: var(--font-mono);
    font-size: 0.82rem;
  }

  .ptr-s { color: var(--accent); }
  .ptr-p { color: var(--data); }
  .ptr-o { color: #6ab68a; }
  .ptr-arrow { color: var(--muted); }

  .pipe-output {
    border-color: var(--line);
  }

  .pipe-reckoning {
    border-color: var(--data);
    background: color-mix(in srgb, var(--data) 5%, var(--surface));
  }

  .pipe-arrow-v {
    display: flex;
    flex-direction: column;
    align-items: center;
    height: 2.5rem;
    gap: 0;
  }

  .pipe-line {
    width: 2px;
    flex: 1;
    background: var(--line);
  }

  .pipe-arrowhead {
    font-size: 0.6rem;
    color: var(--muted);
    line-height: 1;
  }

  .pipe-fork {
    width: 100%;
    max-width: 640px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
  }

  .pipe-fork-branch {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .pipe-fork-branch .pipe-node {
    max-width: 100%;
  }

  /* ── STP section ───────────────────────────────────────────────── */
  .stp-section {
    max-width: 100%;
    padding: 0;
  }

  .stp-inner {
    background: linear-gradient(135deg, var(--surface) 0%, #120d28 100%);
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    padding: 5rem 2rem;
    max-width: 920px;
    margin: 0 auto;
  }

  .stp-cards {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-bottom: 1.5rem;
  }

  .stp-card {
    flex: 1;
    min-width: 200px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.3rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .stp-proposal {
    border-color: var(--data);
    background: color-mix(in srgb, var(--data) 8%, var(--surface-2));
  }

  .stp-num {
    font-size: 1.6rem;
    font-weight: 700;
    color: var(--accent);
    line-height: 1;
  }

  .stp-proposal .stp-num { color: var(--data); }

  .stp-card strong {
    font-size: 1rem;
    color: var(--ink);
  }

  .stp-card p {
    font-size: 0.83rem;
    color: var(--ink-2);
    margin: 0;
    line-height: 1.55;
  }

  .stp-example {
    font-size: 0.72rem;
    color: var(--muted);
    background: var(--surface-3);
    border-left: 2px solid var(--accent);
    padding: 0.5rem 0.7rem;
    border-radius: 0 var(--rad-sm) var(--rad-sm) 0;
    font-style: italic;
    line-height: 1.5;
  }

  .stp-proposal .stp-example { border-left-color: var(--data); }
  .stp-example em { color: var(--data); font-style: normal; }

  .stp-sep {
    font-size: 1.6rem;
    color: var(--muted);
    align-self: center;
    flex-shrink: 0;
    padding-top: 1rem;
  }

  .stp-note {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1rem 1.2rem;
  }

  .stp-note-icon {
    font-family: var(--font-mono);
    font-size: 1.2rem;
    color: var(--data);
    flex-shrink: 0;
    line-height: 1.4;
  }

  .stp-note p {
    font-size: 0.85rem;
    color: var(--ink-2);
    margin: 0;
    line-height: 1.6;
  }

  .stp-note strong { color: var(--ink); }

  /* ── Architecture grid ─────────────────────────────────────────── */
  .arch-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1rem;
    margin-bottom: 2.5rem;
  }

  .arch-card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.3rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    transition: border-color 0.2s, transform 0.2s;
  }
  .arch-card:hover { border-color: var(--accent); transform: translateY(-2px); }

  .arch-icon {
    font-family: var(--font-mono);
    font-size: 1.4rem;
    color: var(--accent);
    line-height: 1;
  }

  .arch-card strong { font-size: 0.95rem; color: var(--ink); }
  .arch-card p { font-size: 0.82rem; color: var(--muted); margin: 0; line-height: 1.55; }

  /* ── AI without the downsides ──────────────────────────────────── */
  .ethics-section { background: var(--surface); border-radius: var(--rad-lg); padding: 3rem 2rem; }
  .ethics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 1rem;
    margin-top: 2rem;
  }
  .ethics-card {
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.4rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    transition: border-color 0.2s, transform 0.2s;
  }
  .ethics-card:hover { border-color: var(--accent); transform: translateY(-2px); }
  .ethics-icon { font-size: 1.6rem; line-height: 1; }
  .ethics-card strong { font-size: 0.95rem; color: var(--ink); }
  .ethics-card p { font-size: 0.82rem; color: var(--muted); margin: 0; line-height: 1.6; }

  /* ── Stack diagram ──────────────────────────────────────────────── */
  .stack-diagram {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.5rem;
  }

  .stack-label {
    font-size: 0.65rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0 0 1rem;
  }

  .stack-layers {
    display: flex;
    align-items: stretch;
    gap: 0;
    flex-wrap: wrap;
    margin-bottom: 1rem;
  }

  .stack-layer {
    flex: 1;
    min-width: 180px;
    border-radius: var(--rad-sm);
    padding: 1rem 1.2rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .stack-you {
    background: color-mix(in srgb, var(--accent) 8%, var(--surface-2));
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  }

  .stack-optional {
    background: var(--surface-2);
    border: 1px dashed var(--line);
  }

  .stack-arrow-right {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 0 1rem;
    gap: 0.3rem;
  }

  .stack-line-h {
    width: 2rem;
    height: 2px;
    background: var(--line);
    position: relative;
  }
  .stack-line-h::after {
    content: '▶';
    position: absolute;
    right: -8px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 0.55rem;
    color: var(--muted);
  }

  .stack-optional-label {
    font-size: 0.58rem;
    color: var(--muted-2);
    letter-spacing: 0.06em;
    text-align: center;
    max-width: 80px;
    line-height: 1.3;
  }

  .stack-layer-label {
    font-size: 0.62rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--accent);
    display: block;
    margin-bottom: 0.2rem;
  }

  .stack-optional .stack-layer-label { color: var(--muted); }

  .stack-items {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .stack-items span {
    font-size: 0.82rem;
    color: var(--ink-2);
  }

  .stack-note {
    font-size: 0.8rem;
    color: var(--muted);
    margin: 0;
    line-height: 1.6;
    font-style: italic;
  }

  /* ── Use cases ─────────────────────────────────────────────────── */
  .uses-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 1rem;
  }

  .use-card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.4rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    transition: border-color 0.2s, transform 0.2s;
  }
  .use-card:hover { border-color: var(--accent); transform: translateY(-2px); }

  .use-icon { font-size: 1.6rem; line-height: 1; }
  .use-card strong { font-size: 0.95rem; color: var(--ink); }
  .use-card p { font-size: 0.83rem; color: var(--muted); margin: 0; line-height: 1.55; }

  /* ── CTA section ───────────────────────────────────────────────── */
  .cta-section { text-align: center; }

  .cta-buttons {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    justify-content: center;
  }

  /* ── Pricing / Support ─────────────────────────────────────────── */
  .pricing-section {
    border-top: 1px solid var(--line);
  }
  .pricing-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1rem;
    margin-top: 2rem;
  }
  .pricing-tier {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.4rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .pricing-tier strong {
    font-size: 1.05rem;
  }
  .pricing-tier p {
    font-size: 0.84rem;
    color: var(--muted);
    line-height: 1.55;
    margin: 0;
    flex: 1;
  }
  .tier-badge {
    display: inline-block;
    font-size: 0.6rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid var(--accent);
    width: fit-content;
  }
  .tier-badge.tier-planned {
    background: color-mix(in srgb, var(--data, #4a9eff) 10%, var(--surface));
    color: var(--data, #4a9eff);
    border-color: var(--data, #4a9eff);
  }
  .tier-badge.tier-enterprise {
    background: color-mix(in srgb, var(--muted) 15%, var(--surface));
    color: var(--ink);
    border-color: var(--line);
  }
  .tier-contact {
    display: inline-block;
    margin-top: 0.5rem;
    font-size: 0.72rem;
    color: var(--accent);
    text-decoration: none;
    transition: opacity 0.15s;
  }
  .tier-contact:hover { opacity: 0.75; }
  .coffee-qr {
    width: 120px;
    height: 120px;
    margin-top: 0.5rem;
    border-radius: var(--rad-sm);
    opacity: 0.85;
    transition: opacity 0.15s;
  }
  .coffee-qr:hover { opacity: 1; }

  /* ── Footer ────────────────────────────────────────────────────── */
  .page-footer {
    text-align: center;
    padding: 2rem;
    border-top: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
  }
  .page-footer p {
    font-size: 0.72rem;
    color: var(--muted-2);
    margin: 0;
  }
  .footer-credit a {
    color: var(--muted);
    text-decoration: none;
    transition: color 0.15s;
  }
  .footer-credit a:hover { color: var(--accent); }
  .footer-github {
    font-size: 0.68rem;
    color: var(--muted);
    text-decoration: none;
    padding: 0.2rem 0.7rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    transition: color 0.15s, border-color 0.15s;
  }
  .footer-github:hover { color: var(--accent); border-color: var(--accent); }

  /* ── Compression benchmarks ──────────────────────────────────── */
  .bench-section {
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    text-align: center;
  }
  .bench-hero-stats {
    display: flex;
    justify-content: center;
    gap: 3rem;
    margin-bottom: 2rem;
  }
  .bench-stat-link {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-decoration: none;
    color: inherit;
    transition: opacity 0.15s;
  }
  .bench-stat-link:hover { opacity: 0.75; }
  .bench-stat-value {
    font-size: 2.4rem;
    font-weight: 700;
    color: var(--ok);
  }
  .bench-stat-label {
    font-size: 0.68rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .bench-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    justify-content: center;
    margin-bottom: 1.5rem;
  }
  .bench-chip {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    padding: 0.4rem 0.9rem;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: transparent;
    color: var(--ink-2);
    cursor: pointer;
    transition: all 0.15s;
  }
  .bench-chip:hover { border-color: var(--accent); color: var(--ink); }
  .bench-chip.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .bench-detail {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.5rem;
    margin-bottom: 1.5rem;
    text-align: left;
    max-width: 640px;
    margin-left: auto;
    margin-right: auto;
  }
  .bench-detail-header {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  .bench-detail-cat {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
  }
  .bench-detail-title {
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--ink);
    text-decoration: none;
    border-bottom: 1px dashed var(--line);
    transition: color 0.15s, border-color 0.15s;
  }
  .bench-detail-title:hover { color: var(--accent); border-color: var(--accent); }
  .bench-metrics-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1rem;
  }
  .bench-metric { display: flex; flex-direction: column; gap: 0.35rem; }
  .bench-bar-track {
    height: 5px;
    background: var(--surface-2);
    border-radius: 3px;
    overflow: hidden;
  }
  .bench-bar {
    height: 100%;
    border-radius: 3px;
    transition: width 0.4s ease;
  }
  .bench-bar-byte { background: var(--ok); }
  .bench-bar-token { background: var(--accent); }
  .bench-bar-density { background: var(--data); }
  .bench-metric-row { display: flex; align-items: baseline; gap: 0.4rem; }
  .bench-metric-value { font-size: 1.4rem; font-weight: 700; }
  .bench-metric-label { font-size: 0.65rem; color: var(--muted); text-transform: uppercase; }
  .bench-metric-detail { font-size: 0.7rem; color: var(--muted); }
  .bench-table-wrap { overflow-x: auto; max-width: 640px; margin: 0 auto 1rem; }
  .bench-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82rem;
    text-align: left;
  }
  .bench-table th {
    font-family: var(--font-mono);
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--line);
  }
  .bench-table td {
    padding: 0.6rem 0.75rem;
    border-bottom: 1px solid var(--surface-2);
  }
  .bench-num { text-align: right; }
  .bench-td-cat {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    display: block;
  }
  .bench-td-label { font-size: 0.82rem; }
  .bench-table tfoot td {
    font-weight: 700;
    border-top: 1px solid var(--line);
    border-bottom: none;
  }
  .bench-methodology {
    font-size: 0.72rem;
    color: var(--muted);
    max-width: 640px;
    margin: 0 auto;
  }
  .bench-methodology a {
    color: var(--accent);
    text-decoration: none;
    border-bottom: 1px dashed var(--accent);
    transition: opacity 0.15s;
  }
  .bench-methodology a:hover { opacity: 0.7; }
  .bench-methodology code {
    font-family: var(--font-mono);
    font-size: 0.88em;
    background: var(--surface-2);
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
  }

  /* ── Getting started hero treatment ──────────────────────────── */
  .starter-hero {
    background: linear-gradient(180deg, transparent, rgba(26, 155, 142, 0.04) 30%, rgba(26, 155, 142, 0.08) 70%, transparent);
    border-top: 2px solid var(--accent);
    position: relative;
  }
  .starter-hero::before {
    content: '';
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 200px;
    height: 2px;
    background: var(--accent);
    box-shadow: 0 0 20px 4px rgba(26, 155, 142, 0.4);
  }

  /* ── Responsive ────────────────────────────────────────────────── */
  @media (max-width: 640px) {
    .triple-display {
      flex-direction: column;
      gap: 0.5rem;
      padding: 1.2rem;
    }
    .triple-connector { flex-direction: column; align-items: center; }
    .triple-arrow-line { width: 2px; height: 1.5rem; }
    .triple-arrow-line::after { content: '▼'; right: auto; top: auto; bottom: -10px; left: 50%; transform: translateX(-50%); }
    .stp-cards { flex-direction: column; }
    .stp-sep { transform: rotate(90deg); align-self: center; }
    .pipe-fork { grid-template-columns: 1fr; }
    .stack-layers { flex-direction: column; }
    .stack-arrow-right { transform: rotate(90deg); }
    .bench-hero-stats { gap: 1.5rem; }
    .bench-stat-value { font-size: 1.8rem; }
    .bench-metrics-grid { grid-template-columns: 1fr; }
  }

  /* ── Starter KBs ───────────────────────────────────────────── */
  .starter-section { text-align: center; }

  .starter-grid {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 640px;
    margin: 2rem auto 0;
  }

  .starter-card {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1.2rem 1.4rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-lg);
    cursor: pointer;
    text-align: left;
    transition: border-color 0.2s, box-shadow 0.2s;
    color: inherit;
    font: inherit;
  }
  .starter-card:hover:not(:disabled) {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .starter-card:disabled {
    opacity: 0.6;
    cursor: wait;
  }

  .starter-icon {
    font-size: 2.2rem;
    flex-shrink: 0;
  }

  .starter-info {
    flex: 1;
    min-width: 0;
  }
  .starter-info strong {
    display: block;
    font-size: 1rem;
    margin-bottom: 0.3rem;
  }
  .starter-info p {
    font-size: 0.82rem;
    color: var(--ink-2);
    line-height: 1.5;
    margin: 0 0 0.5rem;
  }

  .starter-stats {
    display: flex;
    gap: 1rem;
    font-size: 0.68rem;
    color: var(--muted);
  }
  .starter-stats span {
    background: var(--surface-3);
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
  }
  .starter-stats .official-badge {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }
  .official-card {
    border-color: var(--accent);
    background: rgba(26, 155, 142, 0.04);
  }
  .official-card:hover:not(:disabled) {
    border-color: var(--accent);
    background: rgba(26, 155, 142, 0.08);
  }
  .starter-sub-heading {
    font-size: 0.78rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-top: 2.5rem;
    margin-bottom: 0.3rem;
  }
  .starter-sub-desc {
    font-size: 0.82rem;
    color: var(--muted);
    margin-bottom: 1rem;
    max-width: 520px;
  }

  .starter-action {
    font-size: 0.78rem;
    color: var(--accent);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .starter-loading {
    font-size: 0.75rem;
    color: var(--muted);
    white-space: nowrap;
    flex-shrink: 0;
    animation: pulse 1s infinite;
  }

  .starter-error {
    background: var(--danger);
    color: white;
    padding: 0.5rem 1rem;
    border-radius: var(--rad);
    font-size: 0.8rem;
    max-width: 500px;
    margin: 1rem auto;
  }

  /* ── Quick Reference ──────────────────────────────────────── */
  .ref-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 0.75rem;
    margin-top: 1.5rem;
  }
  .ref-card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .ref-card-title {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--accent);
    margin: 0 0 0.25rem;
  }
  .ref-triple {
    font-size: 0.72rem;
    padding: 0.2rem 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    color: var(--ink-2);
  }
  .rt-s { color: var(--accent); }
  .rt-p { color: var(--muted); }
  .rt-o { color: var(--data); }

  /* ── Sea creature animations ─────────────────────────────── */
  @keyframes sea-swim {
    0%, 100% { transform: translateX(0); }
    50% { transform: translateX(26px); }
  }
  @keyframes sea-float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-5px); }
  }
  @keyframes sea-drift {
    0% { transform: translateY(18px) scale(0.7); opacity: 0; }
    18% { opacity: 0.5; }
    82% { opacity: 0.32; }
    100% { transform: translateY(-150px) scale(1); opacity: 0; }
  }
  @keyframes sea-twinkle-kf {
    0%, 100% { opacity: 0.32; }
    50% { opacity: 1; }
  }

  .sea-creature {
    position: absolute;
    pointer-events: none;
    animation: sea-swim 7s ease-in-out infinite;
  }
  .sea-creature :global(.sea-twinkle) {
    animation: sea-twinkle-kf 3s ease-in-out infinite;
  }
  .sea-creature :global(.sea-twinkle.d1) { animation-delay: 0.5s; }
  .sea-creature :global(.sea-twinkle.d2) { animation-delay: 0.8s; }
  .sea-creature :global(.sea-twinkle.d3) { animation-delay: 1.1s; }

  /* Hero fish — bottom right */
  .sea-hero-fish {
    right: 5%;
    bottom: 60px;
    width: 180px;
    opacity: 0.5;
  }
  .sea-hero-bubbles {
    position: absolute;
    right: 4%;
    bottom: 40px;
    width: 100px;
    height: 200px;
  }

  /* Mid-section divider fish */
  .sea-divider {
    position: relative;
    height: 80px;
    overflow: hidden;
  }
  .sea-mid-fish {
    left: 8%;
    top: 10px;
    width: 120px;
    opacity: 0.4;
    animation-duration: 6s;
  }
  .sea-mid-bubbles {
    position: absolute;
    left: 6%;
    top: 0;
    width: 80px;
    height: 80px;
  }

  /* CTA fish — top right */
  .cta-section { position: relative; overflow: hidden; }
  .sea-cta-fish {
    right: 6%;
    top: 30px;
    width: 110px;
    opacity: 0.45;
    animation-duration: 5.5s;
  }
  .sea-cta-bubbles {
    position: absolute;
    right: 8%;
    top: 10px;
    width: 90px;
    height: 180px;
  }

  /* Bubbles */
  .sea-bubbles { pointer-events: none; }
  .bubble {
    position: absolute;
    border-radius: 50%;
    background: rgba(127, 224, 168, 0.4);
    box-shadow: 0 0 7px rgba(127, 224, 168, 0.45);
    animation: sea-drift 9s ease-in infinite;
  }
  .bubble.b1 { left: 24px; bottom: 0; width: 9px; height: 9px; }
  .bubble.b2 { left: 52px; bottom: 0; width: 6px; height: 6px; animation-duration: 10.5s; animation-delay: 3s; opacity: 0.34; }
  .bubble.b3 { left: 38px; bottom: 0; width: 12px; height: 12px; animation-duration: 12s; animation-delay: 5.5s; opacity: 0.3; box-shadow: 0 0 9px rgba(127, 224, 168, 0.4); }

  /* Hide sea creatures on very small screens to avoid clutter */
  @media (max-width: 600px) {
    .sea-hero-fish { width: 100px; right: 2%; bottom: 40px; opacity: 0.35; }
    .sea-hero-bubbles { display: none; }
    .sea-divider { height: 50px; }
    .sea-mid-fish { width: 80px; opacity: 0.3; }
    .sea-cta-fish { width: 70px; opacity: 0.3; }
    .sea-cta-bubbles, .sea-mid-bubbles { display: none; }
  }
</style>
