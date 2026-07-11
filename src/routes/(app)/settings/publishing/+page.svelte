<script lang="ts">
  import { page } from '$app/stores';
  import { settings } from '$lib/stores/settings.svelte';
  import { exportJsonLd, exportLlmsTxt } from '$lib/storage/semantic-export';

  let exportingJsonLd = $state(false);
  let exportingLlmsTxt = $state(false);

  async function handleExportJsonLd() {
    exportingJsonLd = true;
    try { await exportJsonLd({ kbTitle: settings().kbTitle, kbDescription: settings().kbDescription }); }
    catch (e) { console.error(e); } finally { exportingJsonLd = false; }
  }
  async function handleExportLlmsTxt() {
    exportingLlmsTxt = true;
    try { await exportLlmsTxt({ kbTitle: settings().kbTitle, kbDescription: settings().kbDescription }); }
    catch (e) { console.error(e); } finally { exportingLlmsTxt = false; }
  }
</script>

<header class="head">
  <p class="kicker mono">settings</p>
  <h1>system configuration</h1>
  <div class="settings-nav">
    <a href="/settings" class="nav-link">backends</a>
    <a href="/settings/publishing" class="nav-link active">publishing</a>
    <a href="/settings/integrations" class="nav-link">integrations</a>
    <a href="/settings/turtle" class="nav-link">turtle</a>
    <a href="/settings/entity-types" class="nav-link">entity types</a>
    <a href="/analyze" class="nav-link">analyze history ↗</a>
  </div>
</header>

<section class="settings-section">
  <h2 class="section-title">Semantic Web &amp; LLM Search</h2>
  <p class="section-desc">Export your graph in structured formats that help AI crawlers, LLM search systems, and Schema.org-aware tools understand your content.</p>
  <div class="export-list">
    <div class="export-item">
      <div>
        <strong>JSON-LD / Schema.org</strong>
        <p class="check-hint">Structured data graph using Schema.org vocabulary. Embed in a <code>&lt;script type="application/ld+json"&gt;</code> tag on any web page for Google, Bing, and LLM crawlers.</p>
      </div>
      <button onclick={handleExportJsonLd} disabled={exportingJsonLd}>
        {exportingJsonLd ? '…' : '↓ .jsonld'}
      </button>
    </div>
    <div class="export-item">
      <div>
        <strong>llms.txt</strong>
        <p class="check-hint">Plain-text graph summary for AI crawlers, following the <a href="https://llmstxt.org" target="_blank" rel="noopener">llmstxt.org</a> spec. Serve at <code>/llms.txt</code> on your site so LLMs can quickly understand your content during indexing or RAG retrieval.</p>
      </div>
      <button onclick={handleExportLlmsTxt} disabled={exportingLlmsTxt}>
        {exportingLlmsTxt ? '…' : '↓ llms.txt'}
      </button>
    </div>
  </div>
</section>

<style>
  .head { margin-bottom: 1.25rem; }
  .kicker { color: var(--accent); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.2em; margin: 0 0 0.5rem; }
  .settings-nav { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 1rem; border-bottom: 1px solid var(--line); padding-bottom: 0.75rem; }
  .nav-link {
    padding: 0.35rem 0.75rem; border-radius: var(--rad-sm); font-family: var(--font-mono);
    font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted);
    border: 1px solid transparent; transition: all 0.15s; text-decoration: none;
  }
  .nav-link:hover { color: var(--ink-2); border-color: var(--muted-2); }
  .nav-link.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }

  .settings-section { max-width: 760px; }
  .section-title { font-size: 1.15rem; margin: 0 0 0.3rem; }
  .section-desc { color: var(--muted); font-size: 0.85rem; line-height: 1.5; margin: 0 0 1rem; }
  .export-list { display: flex; flex-direction: column; gap: 0.5rem; }
  .export-item {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem;
    padding: 0.65rem 0.75rem; border: 1px solid var(--line); border-radius: var(--rad-sm);
  }
  .export-item > div { flex: 1; }
  .export-item strong { font-size: 0.82rem; }
  .export-item button {
    white-space: nowrap; padding: 0.35rem 0.8rem; font-size: 0.78rem;
    background: var(--surface-2); color: var(--ink); border: 1px solid var(--line);
    border-radius: var(--rad-sm); cursor: pointer;
  }
  .export-item button:hover { border-color: var(--accent); color: var(--accent); }
  .export-item button:disabled { opacity: 0.5; cursor: default; }
  .check-hint { margin: 0.2rem 0 0; color: var(--muted); font-size: 0.78rem; line-height: 1.45; }
  code { font-family: var(--font-mono); font-size: 0.85em; background: var(--surface-2); padding: 0.05rem 0.3rem; border-radius: 4px; }
</style>
