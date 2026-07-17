<script lang="ts">
  import '$lib/styles/global.css';
  import { page } from '$app/stores';

  let { data, children } = $props();
</script>

<svelte:head>
  <title>Docs — Reckons.AI</title>
  <!-- Self-describing graph (F72 kb:published-ttl): advertise the source TTL so
       another Reckons.AI can Add-from-URL and import these facts with no LLM. -->
  <link rel="alternate" type="text/turtle" href="/knowledge.ttl" title="Reckons.AI graph (Turtle)" />
</svelte:head>

<div class="docs-shell">
  <header class="docs-header">
    <a href="/" class="docs-brand">Reckons.AI</a>
    <a href="/docs" class="docs-title">Docs</a>
  </header>

  <div class="docs-body">
    <nav class="docs-nav" aria-label="Docs navigation">
      {#each data.sections as { section, docs } (section)}
        <div class="docs-nav-section">
          <p class="docs-nav-heading">{section}</p>
          <ul>
            {#each docs as doc (doc.path)}
              <li>
                <a
                  href={`/docs/${doc.path}`}
                  class:active={$page.url.pathname === `/docs/${doc.path}`}
                >
                  {doc.metadata.title}
                  {#if doc.metadata.template === 'post' && doc.metadata.date}
                    <span class="docs-nav-date">{doc.metadata.date}</span>
                  {/if}
                </a>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </nav>

    <main class="docs-main">
      {@render children()}
    </main>
  </div>
</div>

<style>
  .docs-shell {
    min-height: 100dvh;
    background: var(--bg-grade) fixed, var(--bg);
    color: var(--ink);
  }

  .docs-header {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--line);
    background: var(--surface);
  }

  .docs-brand {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 1.1rem;
    color: var(--ink);
    border-bottom: none;
  }
  .docs-brand:hover {
    color: var(--accent);
  }

  .docs-title {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--accent);
    border-bottom: none;
  }

  .docs-body {
    display: flex;
    align-items: flex-start;
    max-width: 1100px;
    margin: 0 auto;
    padding: 2rem 1.5rem 5rem;
    gap: 2.5rem;
  }

  .docs-nav {
    flex: 0 0 200px;
    position: sticky;
    top: 1.5rem;
  }

  .docs-nav-section + .docs-nav-section {
    margin-top: 1.5rem;
  }

  .docs-nav-heading {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin: 0 0 0.5rem;
  }

  .docs-nav ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .docs-nav a {
    display: block;
    padding: 0.3rem 0.5rem;
    border-radius: var(--rad-sm);
    color: var(--ink-2);
    font-size: 0.88rem;
    border-bottom: none;
  }
  .docs-nav a:hover {
    background: var(--surface-2);
    color: var(--ink);
  }
  .docs-nav a.active {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .docs-nav-date {
    display: block;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--muted);
    margin-top: 0.1rem;
  }

  .docs-main {
    flex: 1 1 auto;
    min-width: 0;
  }

  @media (max-width: 720px) {
    .docs-body {
      flex-direction: column;
      gap: 1.5rem;
    }
    .docs-nav {
      position: static;
      flex: none;
      width: 100%;
    }
  }
</style>
