<script lang="ts">
  import '$lib/styles/global.css';
  import { page } from '$app/stores';

  let { data, children } = $props();

  let currentLocation = $derived.by(() => {
    const pathname = $page.url.pathname.replace(/\/+$/, '') || '/';

    for (const { section, docs } of data.sections) {
      const doc = docs.find(({ path }) => `/docs/${path}` === pathname);
      if (doc) return { section, title: doc.metadata.title };
    }

    return { section: 'Documentation', title: 'All topics' };
  });
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
                  aria-current={$page.url.pathname === `/docs/${doc.path}` ? 'page' : undefined}
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

    <details class="docs-mobile-nav">
      <summary>
        <span class="docs-mobile-summary-copy">
          <span class="docs-mobile-summary-label">Browse docs</span>
          <span class="docs-mobile-current">
            {currentLocation.section} · {currentLocation.title}
          </span>
        </span>
      </summary>

      <nav class="docs-mobile-nav-panel" aria-label="Docs navigation">
        {#each data.sections as { section, docs } (section)}
          <div class="docs-nav-section">
            <p class="docs-nav-heading">{section}</p>
            <ul>
              {#each docs as doc (doc.path)}
                <li>
                  <a
                    href={`/docs/${doc.path}`}
                    class:active={$page.url.pathname === `/docs/${doc.path}`}
                    aria-current={$page.url.pathname === `/docs/${doc.path}` ? 'page' : undefined}
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
    </details>

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

  .docs-mobile-nav {
    display: none;
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

  .docs-nav ul,
  .docs-mobile-nav-panel ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .docs-nav a,
  .docs-mobile-nav-panel a {
    display: block;
    padding: 0.3rem 0.5rem;
    border-radius: var(--rad-sm);
    color: var(--ink-2);
    font-size: 0.88rem;
    border-bottom: none;
  }
  .docs-nav a:hover,
  .docs-mobile-nav-panel a:hover {
    background: var(--surface-2);
    color: var(--ink);
  }
  .docs-nav a.active,
  .docs-mobile-nav-panel a.active {
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
      gap: 1.25rem;
      padding-top: 1rem;
    }

    .docs-nav {
      display: none;
    }

    .docs-mobile-nav {
      display: block;
      width: 100%;
      border: 1px solid var(--line);
      border-radius: var(--rad);
      background: var(--surface);
      overflow: hidden;
    }

    .docs-mobile-nav summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      min-height: 3.25rem;
      padding: 0.6rem 0.9rem;
      color: var(--ink);
      cursor: pointer;
      list-style: none;
      user-select: none;
    }

    .docs-mobile-nav summary::-webkit-details-marker {
      display: none;
    }

    .docs-mobile-nav summary::after {
      content: '+';
      flex: 0 0 auto;
      font-family: var(--font-mono);
      font-size: 1.25rem;
      line-height: 1;
      color: var(--accent);
    }

    .docs-mobile-nav[open] summary::after {
      content: '−';
    }

    .docs-mobile-nav summary:hover {
      background: var(--surface-2);
    }

    .docs-mobile-nav summary:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }

    .docs-mobile-summary-copy {
      display: flex;
      min-width: 0;
      flex-direction: column;
      gap: 0.12rem;
    }

    .docs-mobile-summary-label {
      font-family: var(--font-mono);
      font-size: 0.78rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--accent);
    }

    .docs-mobile-current {
      overflow: hidden;
      color: var(--ink-2);
      font-size: 0.82rem;
      line-height: 1.3;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .docs-mobile-nav-panel {
      max-height: min(68dvh, 32rem);
      padding: 1rem 0.75rem 1.25rem;
      overflow-y: auto;
      overscroll-behavior: contain;
      border-top: 1px solid var(--line);
      scrollbar-gutter: stable;
    }

    .docs-mobile-nav-panel a {
      display: flex;
      min-height: 2.75rem;
      padding: 0.55rem 0.65rem;
      flex-direction: column;
      justify-content: center;
    }

    .docs-mobile-nav-panel a:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }

    .docs-main {
      width: 100%;
    }
  }
</style>
