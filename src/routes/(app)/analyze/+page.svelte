<script lang="ts">
  import ReAnalysisPanel from '$lib/components/ReAnalysisPanel.svelte';
</script>

<header class="head">
  <p class="kicker mono">settings</p>
  <h1>system configuration</h1>
  <div class="settings-nav">
    <a href="/settings" class="nav-link">backends</a>
    <a href="/settings/integrations" class="nav-link">integrations</a>
    <a href="/settings/turtle" class="nav-link">turtle</a>
    <a href="/settings/entity-types" class="nav-link">entity types</a>
    <a href="/analyze" class="nav-link active">analyze history ↗</a>
  </div>
</header>

<ReAnalysisPanel />

<style>
  .head { margin-bottom: 1.25rem; }
  .kicker {
    font-size: 0.7rem;
    color: var(--muted);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin: 0 0 0.25rem;
    font-family: var(--font-mono);
  }
  h1 { font-size: clamp(1.6rem, 4vw, 2.2rem); margin: 0 0 1rem; }
  .settings-nav {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
    border-bottom: 1px solid var(--line);
    padding-bottom: 0.75rem;
    /* Scroll rather than clip the section tabs on narrow viewports (mobile). */
    overflow-x: auto;
    scrollbar-width: none;
  }
  .settings-nav::-webkit-scrollbar { display: none; }
  .nav-link {
    padding: 0.35rem 0.75rem;
    border-radius: var(--rad-sm);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    border: 1px solid transparent;
    transition: all 0.15s;
    text-decoration: none;
    white-space: nowrap;
    flex: 0 0 auto;
  }
  .nav-link:hover { color: var(--ink); background: var(--surface-2); }
  .nav-link.active { color: var(--accent); background: var(--accent-soft); border-color: var(--accent); }
</style>
