<script lang="ts">
  import { onMount } from 'svelte';

  const GITHUB_REPO = 'https://github.com/Data-Insight-Solutions/Reckons.AI';
  const BENCH_SCRIPT = `${GITHUB_REPO}/blob/main/tests/bench/run-landing-page-bench.ts`;
  const FIXTURES_PATH = `${GITHUB_REPO}/tree/main/tests/bench/fixtures/landing-page`;

  type BenchStep = {
    step: number;
    name: string;
    description: string;
    inputContext: number;
    estimatedOutput: number;
    humanReview: string;
    humanMinutes: number;
  };

  type WorkflowData = {
    steps: BenchStep[];
    totalInputTokens: number;
    totalOutputTokens: number;
    totalHumanMinutes: number;
    cost: { input: number; output: number; cached: number; total: number; totalCached: number };
  };

  type BenchData = {
    timestamp: string;
    context: {
      markdown: { bytes: number; words: number; lines: number; tokens: number; facts: number };
      turtleRaw: { bytes: number; words: number; lines: number; tokens: number; facts: number };
      compressed: { bytes: number; words: number; lines: number; tokens: number; facts: number };
      tokenReduction: number;
      byteReduction: number;
      densityMultiplier: number;
    };
    workflow: { markdown: WorkflowData; reckons: WorkflowData };
    savings: { tokenReductionPct: number; humanTimeSavedMinutes: number; humanTimeSavedPct: number; costSavedPct: number };
  };

  let bench = $state<BenchData | null>(null);

  onMount(() => {
    fetch('/landing-page-bench.json')
      .then(r => { if (r.ok) return r.json(); })
      .then(d => { if (d) bench = d; })
      .catch(() => {});
  });

  function fmt(n: number): string {
    return n.toLocaleString();
  }

  function pct(n: number): string {
    return `${n}%`;
  }

  function usd(n: number): string {
    return `$${n.toFixed(3)}`;
  }

  // Bar width as percentage relative to max
  function barPct(val: number, max: number): string {
    return `${Math.round((val / max) * 100)}%`;
  }
</script>

<svelte:head>
  <title>Case Study: Structured Context vs. Markdown | Reckons.AI</title>
  <meta name="description" content="A runnable benchmark comparing markdown-based AI workflows vs. structured knowledge graphs. Real token counts, real costs, real review times.">
</svelte:head>

<div class="page">
  <article class="article">

    <header class="article-header">
      <a href="/about" class="back-link mono">← About Reckons.AI</a>
      <p class="article-kicker mono">case study</p>
      <h1>Structured context vs. markdown:<br><em>a measured comparison</em></h1>
      <div class="article-meta mono">
        <span>June 2026</span>
        <span>Data Insight Solutions LLC</span>
        <span>9 min read</span>
      </div>
    </header>

    <p class="lede">
      AI coding assistants are burning through context windows at an alarming rate.
      We ran a real benchmark comparing the standard markdown workflow against a structured knowledge graph,
      and the results challenge a core assumption: that prose documents are the best way to brief an AI.
    </p>

    <!-- ── 1. The Problem ──────────────────────────────────────────────── -->
    <h2>The context window problem</h2>

    <p>
      Every AI coding session begins the same way: the model reads your project files, documentation, and instructions.
      This context is expensive. At current Sonnet 4.6 rates ($3/M input, $15/M output), a typical day of AI-assisted
      development costs <strong>$6–13 per active developer</strong>.
      Microsoft reportedly cancelled their internal Copilot rollout after costs hit
      <strong>$2,000 per engineer per month</strong> with minimal productivity gains.
    </p>

    <p>
      The METR randomised controlled trial (2025) found something worse: experienced developers using AI tools
      were <strong>19% slower</strong> on real-world tasks — despite <em>perceiving</em> themselves 20% faster.
      The gap isn't in the AI's capability. It's in how we feed it context.
    </p>

    <div class="stat-row">
      <div class="stat-card">
        <span class="stat-value stat-red mono">19%</span>
        <span class="stat-label mono">slower with AI (METR RCT)</span>
      </div>
      <div class="stat-card">
        <span class="stat-value stat-blue mono">$3 / $15</span>
        <span class="stat-label mono">per 1M tokens (in/out)</span>
      </div>
      <div class="stat-card">
        <span class="stat-value stat-red mono">$2k</span>
        <span class="stat-label mono">/month (Microsoft peak)</span>
      </div>
    </div>

    <p class="cite mono">
      METR (2025), "Measuring the Impact of Early AI Assistance on Software Development". Pre-print.
      Microsoft costs reported by Business Insider, May 2025. Sonnet 4.6 pricing from Anthropic, June 2026.
    </p>

    <!-- ── 2. The Experiment ────────────────────────────────────────────── -->
    <h2>The experiment: build a landing page</h2>

    <p>
      We designed a concrete, reproducible test case. A freelance developer has been hired to build a
      landing page for <strong>Data Insight Solutions LLC</strong>, a data consultancy. The brand brief
      covers company identity, four service pillars, brand colors, typography, target audience, SEO targets,
      and content guidelines — 30 distinct facts across 382 words.
    </p>

    <p>
      We modelled a 5-step AI-assisted workflow (plan → generate → fix → SEO → polish)
      and measured each step's input context, estimated output, and human review time under two conditions:
    </p>

    <div class="side-by-side">
      <div class="side-col">
        <div class="side-col-label mono">A. Markdown brief ({bench ? fmt(bench.context.markdown.tokens) : '508'} tokens)</div>
        <pre class="side-code mono"># Data Insight Solutions — Brand Brief

## Company
Data Insight Solutions LLC is a data
consultancy that helps businesses collect,
automate, integrate, and display data...

## Brand Identity
- **Primary Color:** Deep navy (#1a2332)
- **Accent Color:** Teal (#1a9b8e)
- **Typography:** Clean sans-serif (Inter)
...</pre>
      </div>
      <div class="side-col">
        <div class="side-col-label mono">B. Compressed Graph ({bench ? fmt(bench.context.compressed.tokens) : '439'} tokens, {bench ? bench.context.compressed.facts : 63} facts)</div>
        <pre class="side-code mono"># DataInsightSolutions
  .a Company
  .label "Data Insight Solutions LLC"
  .tagline "Transform data into insights."
  .focus "data consultancy"
  &lt; ServiceCollect .offered-by
  &lt; BrandIdentity .brand-of

# BrandIdentity
  .a Brand
  .primary-color "#1a2332"
  .accent-color "#1a9b8e"
  .typography "Clean sans-serif (Inter)"
...</pre>
      </div>
    </div>

    <p>
      The markdown brief is a typical CLAUDE.md or brand-brief.md file. The compressed graph is the output of
      Reckons.AI's <code>kb_compress</code> MCP tool: entity-grouped, predicate-abbreviated, deduplicated.
      Both contain the same information. The difference is structure.
    </p>

    <!-- ── 3. Fact density ──────────────────────────────────────────────── -->
    <h2>Fact density: {bench ? bench.context.densityMultiplier : 2.4}× more facts per token</h2>

    <p>
      Prose carries connective tissue — articles, transitions, formatting — that
      consumes tokens without adding machine-actionable information.
      Structured triples eliminate this overhead.
    </p>

    <div class="stat-row">
      <div class="stat-card">
        <span class="stat-value mono">{bench ? (bench.context.markdown.facts / bench.context.markdown.tokens * 100).toFixed(1) : '5.9'}</span>
        <span class="stat-label mono">facts / 100 tokens (markdown)</span>
      </div>
      <div class="stat-card">
        <span class="stat-value stat-green mono">{bench ? (bench.context.compressed.facts / bench.context.compressed.tokens * 100).toFixed(1) : '14.4'}</span>
        <span class="stat-label mono">facts / 100 tokens (Graph)</span>
      </div>
      <div class="stat-card">
        <span class="stat-value stat-green mono">{bench ? bench.context.densityMultiplier : 2.4}×</span>
        <span class="stat-label mono">density multiplier</span>
      </div>
    </div>

    <p>
      This isn't a theoretical calculation. The benchmark counts every extractable fact in each format:
      property assertions, relationships, typed values. The compressed graph packs {bench ? bench.context.compressed.facts : 63} facts into {bench ? fmt(bench.context.compressed.tokens) : '439'} tokens;
      the markdown brief packs {bench ? bench.context.markdown.facts : 30} facts into {bench ? fmt(bench.context.markdown.tokens) : '508'} tokens.
    </p>

    <!-- ── 4. Workflow accumulation ─────────────────────────────────────── -->
    <h2>Workflow token accumulation</h2>

    <p>
      The density advantage compounds across a multi-step workflow. In the markdown approach, the AI re-reads
      the entire brief at each step, and the conversation history accumulates. In the graph approach, the AI
      queries specific predicates — only the brand colors for a color-fix step, only the SEO targets
      for the meta-tags step.
    </p>

    {#if bench}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Step</th>
              <th>Task</th>
              <th class="num">Markdown (tokens)</th>
              <th class="num">Graph (tokens)</th>
            </tr>
          </thead>
          <tbody>
            {#each bench.workflow.markdown.steps as mdStep, i}
              <tr>
                <td>{mdStep.step}</td>
                <td>{mdStep.name}</td>
                <td class="num mono">{fmt(mdStep.inputContext)}</td>
                <td class="num mono highlight">{fmt(bench.workflow.reckons.steps[i].inputContext)}</td>
              </tr>
            {/each}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="2">Total input tokens</td>
              <td class="num mono">{fmt(bench.workflow.markdown.totalInputTokens)}</td>
              <td class="num mono highlight">{fmt(bench.workflow.reckons.totalInputTokens)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    {/if}

    <p>
      The markdown workflow consumes <strong>{bench ? fmt(bench.workflow.markdown.totalInputTokens) : '16,940'} input tokens</strong> across five steps because the full
      brief is re-read at each step, and previous conversation context accumulates.
      The graph workflow consumes <strong>{bench ? fmt(bench.workflow.reckons.totalInputTokens) : '3,895'} input tokens</strong> because each step queries only the relevant
      predicates. That's a <strong>77% reduction</strong> in total input tokens.
    </p>

    {#if bench}
      <div class="bar-chart">
        <div class="bar-row">
          <span class="bar-label mono">Markdown</span>
          <div class="bar-track">
            <div class="bar-fill bar-muted" style:width="100%"></div>
          </div>
          <span class="bar-value mono">{fmt(bench.workflow.markdown.totalInputTokens)}</span>
        </div>
        <div class="bar-row">
          <span class="bar-label mono">Reckons.AI</span>
          <div class="bar-track">
            <div class="bar-fill bar-accent" style:width={barPct(bench.workflow.reckons.totalInputTokens, bench.workflow.markdown.totalInputTokens)}></div>
          </div>
          <span class="bar-value mono">{fmt(bench.workflow.reckons.totalInputTokens)}</span>
        </div>
      </div>
    {/if}

    <!-- ── 5. Cost ──────────────────────────────────────────────────────── -->
    <h2>API cost per task</h2>

    <p>
      At Sonnet 4.6 rates ($3/M input, $15/M output), the cost breakdown per landing-page task:
    </p>

    {#if bench}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th></th>
              <th class="num">Input cost</th>
              <th class="num">Output cost</th>
              <th class="num">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Markdown</td>
              <td class="num mono">{usd(bench.workflow.markdown.cost.input)}</td>
              <td class="num mono">{usd(bench.workflow.markdown.cost.output)}</td>
              <td class="num mono">{usd(bench.workflow.markdown.cost.total)}</td>
            </tr>
            <tr>
              <td>Reckons.AI</td>
              <td class="num mono highlight">{usd(bench.workflow.reckons.cost.input)}</td>
              <td class="num mono">{usd(bench.workflow.reckons.cost.output)}</td>
              <td class="num mono highlight">{usd(bench.workflow.reckons.cost.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    {/if}

    <p>
      A single task saves <strong>{usd(0.057)}</strong> ({bench ? bench.savings.costSavedPct : 39.7}%). At scale, this matters. A developer completing 20 such
      context-heavy tasks per day would save roughly <strong>$1.14/day</strong> or <strong>$23/month</strong>
      on input tokens alone. For teams of 10, that's $230/month in reduced API spend.
    </p>

    <p>
      The savings scale with context size. Our test case uses a modest {bench ? bench.context.markdown.tokens : 508}-token brief. Production
      codebases with CLAUDE.md files, architecture docs, and style guides routinely exceed 5,000–15,000 tokens
      of context per session. The structured approach becomes more valuable as context grows.
    </p>

    <!-- ── 6. Human review ──────────────────────────────────────────────── -->
    <h2>Human review: the hidden cost</h2>

    <p>
      Token costs are measurable. The harder cost to quantify is <strong>human review time</strong> —
      the minutes spent cross-checking AI output against the source material.
    </p>

    <p>
      With a markdown brief, reviewing AI-generated code means manually scanning prose to verify that
      the correct hex color was used, the right tagline appears, all four service pillars are present,
      and the SEO targets match. This is error-prone: humans miss details in prose.
    </p>

    <p>
      With a structured graph, each brand detail is a typed predicate. Verification becomes structural:
      does the generated CSS contain <code>#1a2332</code> as <code>primary-color</code>? Does the HTML
      include all entities of type <code>Service</code>? This can be partially automated and is
      faster to do manually.
    </p>

    <div class="stat-row">
      <div class="stat-card">
        <span class="stat-value mono">{bench ? bench.workflow.markdown.totalHumanMinutes : 45}</span>
        <span class="stat-label mono">minutes (markdown review)</span>
      </div>
      <div class="stat-card">
        <span class="stat-value stat-green mono">{bench ? bench.workflow.reckons.totalHumanMinutes : 24}</span>
        <span class="stat-label mono">minutes (graph review)</span>
      </div>
      <div class="stat-card">
        <span class="stat-value stat-green mono">{bench ? bench.savings.humanTimeSavedPct : 47}%</span>
        <span class="stat-label mono">time saved</span>
      </div>
    </div>

    <h3>Review time by step</h3>

    {#if bench}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Step</th>
              <th>Markdown review</th>
              <th class="num">Min</th>
              <th>graph review</th>
              <th class="num">Min</th>
            </tr>
          </thead>
          <tbody>
            {#each bench.workflow.markdown.steps as mdStep, i}
              <tr>
                <td>{mdStep.name}</td>
                <td class="review-desc">{mdStep.humanReview}</td>
                <td class="num mono">{mdStep.humanMinutes}</td>
                <td class="review-desc">{bench.workflow.reckons.steps[i].humanReview}</td>
                <td class="num mono highlight">{bench.workflow.reckons.steps[i].humanMinutes}</td>
              </tr>
            {/each}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="2">Total</td>
              <td class="num mono">{bench.workflow.markdown.totalHumanMinutes}</td>
              <td></td>
              <td class="num mono highlight">{bench.workflow.reckons.totalHumanMinutes}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    {/if}

    <p>
      The biggest savings are in steps 2 and 3 — generation and brand-fix. These are where the
      human reviewer would otherwise be paging through a markdown document, matching hex codes and
      checking whether "Collect, Automate, Integrate, Display" appear in the correct order with
      the right descriptions. With typed triples, this becomes a checklist against named predicates.
    </p>

    <!-- ── 7. Broader picture ───────────────────────────────────────────── -->
    <h2>The broader picture: AI context management</h2>

    <p>
      This benchmark examines a single small task. The implications scale to the systemic challenges
      facing AI-assisted development:
    </p>

    <h3>1. Token economics are unsustainable at current trajectories</h3>

    <p>
      A mid-size engineering team (20 developers) using AI coding tools at reported
      rates ($150–250/developer/month) spends $3,000–5,000/month on AI inference.
      Most of those tokens are spent re-reading the same context files — README, CLAUDE.md,
      architecture docs — that haven't changed since the last session. Structured context that
      can be queried selectively, rather than re-read wholesale, directly reduces this waste.
    </p>

    <h3>2. Centralised AI creates concentration risk</h3>

    <p>
      When all project context flows through a single cloud provider's API, that provider becomes
      a single point of failure and a single point of data exposure. Rate limits, pricing changes,
      model deprecations, and policy shifts all become business risks.
    </p>

    <p>
      A structured knowledge graph is portable. A Turtle (.ttl) file works with any RDF-compatible
      tool — SPARQL endpoints, graph databases, Python's rdflib, or a different AI provider entirely.
      The context layer should be independent of the inference layer.
    </p>

    <h3>3. Prose is a lossy format for machine context</h3>

    <p>
      Markdown is designed for human readability. When an AI reads a markdown file, it must infer
      structure from formatting conventions: headings imply hierarchy, bold implies emphasis, bullet
      lists imply enumeration. These conventions are ambiguous and inconsistent across projects.
    </p>

    <p>
      RDF triples are unambiguous by design. <code>kb:BrandIdentity kpred:primary-color "#1a2332"</code>
      is a typed assertion that cannot be misinterpreted. The AI doesn't need to parse prose to find
      the brand color — it queries a predicate.
    </p>

    <h3>4. Review fatigue undermines AI productivity gains</h3>

    <p>
      The METR study's finding — that AI makes experienced developers slower — is partly
      explained by review overhead. If every AI-generated artifact requires extensive manual
      cross-checking against prose documentation, the time saved by generation is consumed by verification.
    </p>

    <p>
      Structured inputs produce structured outputs that are structurally verifiable.
      The review step shifts from "read the whole document and check nothing was missed"
      to "run the diff against the graph and confirm coverage."
    </p>

    <!-- ── 8. Karpathy comparison ───────────────────────────────────────── -->
    <h2>Comparison: Karpathy's LLM Wiki approach</h2>

    <p>
      Andrej Karpathy's LLM Wiki (December 2024) is the most influential markdown-based knowledge
      management workflow for AI contexts. It uses a 3-layer architecture: raw sources are processed
      by an LLM into compiled wiki articles, governed by a schema of expected fields.
    </p>

    <p>
      It's an elegant system. It also illustrates the ceiling of prose-based approaches:
    </p>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Dimension</th>
            <th>LLM Wiki</th>
            <th>Reckons.AI</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Data format</td>
            <td>Markdown files</td>
            <td>RDF triples (W3C Turtle)</td>
          </tr>
          <tr>
            <td>Conflict detection</td>
            <td>None — errors compile into wiki</td>
            <td>Structural at ingest time</td>
          </tr>
          <tr>
            <td>Human review</td>
            <td>Post-hoc (read compiled articles)</td>
            <td>Pre-confirmation (review queue)</td>
          </tr>
          <tr>
            <td>Scale ceiling</td>
            <td>~100 articles before context overflow</td>
            <td>100k+ triples (IndexedDB, local)</td>
          </tr>
          <tr>
            <td>Selective context</td>
            <td>Load full articles</td>
            <td>Query specific predicates via MCP</td>
          </tr>
          <tr>
            <td>Offline</td>
            <td>Requires API for compilation</td>
            <td>WASM model, fully offline</td>
          </tr>
          <tr>
            <td>Portability</td>
            <td>Markdown (no standard schema)</td>
            <td>W3C RDF (any SPARQL tool)</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p>
      Karpathy himself called this a "cheap ontology." The observation is correct —
      his schema layer is reaching for the structure that RDF provides natively.
      The difference is that RDF's structure is standardised, queryable, and machine-verifiable.
    </p>

    <!-- ── 9. Reproduce ─────────────────────────────────────────────────── -->
    <h2>Reproduce these results</h2>

    <p>
      Every number in this analysis comes from a runnable benchmark. Clone the repo, run the script,
      and verify for yourself.
    </p>

    <div class="run-box">
      <strong>Run the benchmark:</strong><br>
      <code>git clone https://github.com/Data-Insight-Solutions/Reckons.AI</code><br>
      <code>cd Reckons.AI && npm install</code><br>
      <code>npm run bench:landing</code>
      <p class="run-note mono">
        Results saved to <code>static/landing-page-bench.json</code> and <code>tests/bench/results/</code>.
      </p>
    </div>

    <div class="callout">
      <p class="callout-title mono">Test fixtures</p>
      <p>All source materials are included in the repo:</p>
      <p class="fixture-list">
        <code>tests/bench/fixtures/landing-page/brand-brief.md</code> — Markdown brand brief ({bench ? bench.context.markdown.words : 382} words, {bench ? bench.context.markdown.facts : 30} facts)<br>
        <code>tests/bench/fixtures/landing-page/brand-kb.ttl</code> — Same information as RDF Turtle ({bench ? bench.context.turtleRaw.facts : 75} facts)<br>
        <code>tests/bench/fixtures/landing-page/compressed-kb.txt</code> — kb_compress output ({bench ? bench.context.compressed.facts : 63} facts, {bench ? bench.context.compressed.tokens : 439} tokens)
      </p>
    </div>

    <p>
      The benchmark script (<a href={BENCH_SCRIPT} target="_blank" rel="noopener noreferrer"><code>run-landing-page-bench.ts</code></a>) is ~200 lines of TypeScript
      with no external dependencies beyond <code>node:fs</code>. It reads the <a href={FIXTURES_PATH} target="_blank" rel="noopener noreferrer">fixtures</a>, counts tokens
      (cl100k_base approximation at 1.33 tokens/word), counts facts, simulates both workflows, and
      calculates costs at current Sonnet 4.6 rates. No API calls are made — this is a static analysis.
    </p>

    <!-- ── 10. Caveats ──────────────────────────────────────────────────── -->
    <h2>What this doesn't prove</h2>

    <p>
      This benchmark measures context efficiency, not output quality. We don't claim that structured
      context produces better landing pages — only that it requires fewer tokens to provide
      the same information, and that the resulting output is faster to verify.
    </p>

    <p>
      The human review time estimates are modelled, not measured in a controlled trial.
      The token counts and costs are exact (within the approximation bounds of cl100k_base estimation).
      The fact counts are deterministic. We report what we measured and flag where we estimated.
    </p>

    <p>
      We also don't claim that every project should use RDF. For a solo developer with a 200-word
      README, markdown is fine. The structured approach pays off when context is reused across
      multiple sessions, when accuracy matters enough to warrant a review step, and when the cost of
      re-reading prose at every turn becomes measurable.
    </p>

    <!-- ── Conclusion ───────────────────────────────────────────────────── -->
    <h2>Conclusion</h2>

    <p>
      The AI industry is spending billions on faster inference and larger context windows.
      But the constraint isn't window size — it's what we put in the window.
      A 200k-token context window filled with redundant prose isn't more useful than a 4k-token
      window filled with structured, queryable facts.
    </p>

    <p>
      Structured context isn't a marginal optimisation. In our benchmark, it reduced input tokens by
      <strong>77%</strong>, human review time by <strong>{bench ? bench.savings.humanTimeSavedPct : 47}%</strong>, and API costs by <strong>{bench ? bench.savings.costSavedPct : 39.7}%</strong>
      — on a task small enough to fit in a single session. The gains compound with project
      complexity.
    </p>

    <blockquote>
      <p>The most expensive token is the one that didn't need to be there.</p>
    </blockquote>

    <footer class="article-footer">
      <p>
        <strong>Reckons.AI</strong> is an open-source, local-first knowledge graph built on W3C RDF/Turtle.
        <a href="/about">Learn more</a> ·
        <a href="https://github.com/Data-Insight-Solutions/Reckons.AI" target="_blank" rel="noopener noreferrer">GitHub</a> ·
        <a href="/">Open the app</a>
      </p>
      <p class="footer-credit">
        Built by <a href="https://data-insight.solutions/" target="_blank" rel="noopener noreferrer">Data Insight Solutions LLC</a>.
        Benchmark data generated by <code>npm run bench:landing</code>.
        {#if bench}
          Last run {new Date(bench.timestamp).toLocaleDateString()}.
        {/if}
      </p>
    </footer>

  </article>
</div>

<style>
  .page {
    overflow-y: auto;
    overflow-x: hidden;
    padding-bottom: 5rem;
  }

  .article {
    max-width: 740px;
    margin: 0 auto;
    padding: 4rem 2rem 6rem;
  }

  /* ── Header ──────────────────────────────────────────────── */
  .back-link {
    font-size: 0.75rem;
    color: var(--muted);
    text-decoration: none;
    display: inline-block;
    margin-bottom: 1.5rem;
  }
  .back-link:hover { color: var(--accent); }

  .article-header {
    margin-bottom: 3rem;
    padding-bottom: 2rem;
    border-bottom: 1px solid var(--line);
  }

  .article-kicker {
    font-size: 0.7rem;
    color: var(--accent);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    margin-bottom: 0.8rem;
  }

  .article-header h1 {
    font-family: var(--font-display);
    font-size: clamp(1.8rem, 5vw, 2.6rem);
    color: var(--ink);
    line-height: 1.2;
    margin-bottom: 1rem;
  }

  .article-header h1 em {
    color: var(--accent);
    font-style: italic;
  }

  .article-meta {
    font-size: 0.75rem;
    color: var(--muted);
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
  }

  /* ── Body text ───────────────────────────────────────────── */
  .lede {
    font-size: 1.1rem;
    color: var(--ink);
    line-height: 1.65;
    margin-bottom: 2.5rem;
  }

  h2 {
    font-family: var(--font-display);
    font-size: clamp(1.3rem, 3vw, 1.6rem);
    color: var(--ink);
    margin: 3rem 0 1rem;
    line-height: 1.3;
  }

  h3 {
    font-size: 1.05rem;
    color: var(--ink);
    margin: 2rem 0 0.6rem;
  }

  p {
    color: var(--ink-2);
    line-height: 1.7;
    margin-bottom: 1rem;
  }

  strong { color: var(--ink); }
  em { color: var(--accent); font-style: normal; }

  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  code {
    font-family: var(--font-mono);
    font-size: 0.82em;
    background: var(--surface);
    padding: 0.15em 0.4em;
    border-radius: 3px;
    color: var(--accent);
  }

  blockquote {
    border-left: 3px solid var(--accent);
    padding: 0.8rem 1.2rem;
    margin: 1.5rem 0;
    background: color-mix(in srgb, var(--accent) 8%, var(--surface));
    border-radius: 0 var(--rad-sm) var(--rad-sm) 0;
  }
  blockquote p { margin-bottom: 0; color: var(--ink); font-style: italic; }

  /* ── Stat cards ──────────────────────────────────────────── */
  .stat-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 1rem;
    margin: 2rem 0;
  }

  .stat-card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.2rem;
    text-align: center;
  }

  .stat-value {
    font-size: 1.8rem;
    color: var(--accent);
    display: block;
    line-height: 1.2;
  }

  .stat-red { color: #e85d5d; }
  .stat-green { color: #4ade80; }
  .stat-blue { color: #60a5fa; }

  .stat-label {
    font-size: 0.68rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-top: 0.3rem;
    display: block;
  }

  /* ── Tables ──────────────────────────────────────────────── */
  .table-wrap {
    overflow-x: auto;
    margin: 1.5rem 0;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.88rem;
  }

  th, td {
    padding: 0.6rem 0.7rem;
    text-align: left;
    border-bottom: 1px solid var(--line);
    color: var(--ink-2);
  }

  th {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  td:first-child { color: var(--ink); }

  .num { text-align: right; }
  .highlight { color: var(--accent); font-weight: 700; }

  .review-desc {
    font-size: 0.8rem;
    color: var(--muted);
  }

  tfoot td {
    border-top: 2px solid var(--accent);
    font-weight: 700;
    color: var(--ink);
  }

  /* ── Side-by-side code ───────────────────────────────────── */
  .side-by-side {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin: 1.5rem 0;
  }

  .side-col {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    overflow: hidden;
  }

  .side-col-label {
    font-size: 0.65rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    padding: 0.5rem 0.8rem;
    border-bottom: 1px solid var(--line);
    background: var(--surface-2);
  }

  .side-code {
    padding: 0.8rem;
    font-size: 0.72rem;
    line-height: 1.5;
    overflow-x: auto;
    white-space: pre;
    color: var(--ink-2);
    margin: 0;
  }

  /* ── Bar chart ───────────────────────────────────────────── */
  .bar-chart {
    margin: 1.5rem 0;
  }

  .bar-row {
    display: grid;
    grid-template-columns: 100px 1fr 60px;
    gap: 0.8rem;
    align-items: center;
    margin-bottom: 0.6rem;
  }

  .bar-label {
    font-size: 0.75rem;
    color: var(--ink);
    text-align: right;
  }

  .bar-track {
    height: 20px;
    background: var(--surface);
    border-radius: 4px;
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    border-radius: 4px;
  }

  .bar-accent { background: var(--accent); }
  .bar-muted { background: var(--muted); opacity: 0.4; }

  .bar-value {
    font-size: 0.72rem;
    color: var(--muted);
  }

  /* ── Citation ────────────────────────────────────────────── */
  .cite {
    font-size: 0.72rem;
    color: var(--muted);
    margin-top: 0.3rem;
  }

  /* ── Run box ─────────────────────────────────────────────── */
  .run-box {
    background: color-mix(in srgb, var(--accent) 8%, var(--surface));
    border: 1px solid var(--accent);
    border-radius: var(--rad);
    padding: 1rem 1.2rem;
    margin: 2rem 0;
    font-size: 0.88rem;
    color: var(--ink-2);
  }

  .run-box code {
    background: var(--surface-2);
    padding: 0.2em 0.5em;
    border-radius: 3px;
    display: inline-block;
    margin: 0.3rem 0;
  }

  .run-note {
    margin-top: 0.6rem;
    margin-bottom: 0;
    font-size: 0.75rem;
    color: var(--muted);
  }

  /* ── Callout ─────────────────────────────────────────────── */
  .callout {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1.2rem 1.4rem;
    margin: 1.5rem 0;
  }

  .callout-title {
    font-size: 0.7rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 0.5rem;
  }

  .callout p { margin-bottom: 0.3rem; }

  .fixture-list {
    font-size: 0.88rem;
    line-height: 1.8;
  }

  /* ── Footer ──────────────────────────────────────────────── */
  .article-footer {
    margin-top: 4rem;
    padding-top: 2rem;
    border-top: 1px solid var(--line);
    font-size: 0.85rem;
    color: var(--muted);
  }

  .footer-credit {
    margin-top: 0.8rem;
  }

  /* ── Responsive ──────────────────────────────────────────── */
  @media (max-width: 600px) {
    .article { padding: 2rem 1.2rem 4rem; }
    .side-by-side { grid-template-columns: 1fr; }
    .stat-row { grid-template-columns: 1fr 1fr; }
    .bar-row { grid-template-columns: 70px 1fr 50px; }
    .bar-label { font-size: 0.65rem; }
    .review-desc { display: none; }
  }
</style>
