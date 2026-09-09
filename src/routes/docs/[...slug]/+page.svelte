<script lang="ts">
  import { findDoc } from '../_content/docs';

  let { data } = $props();
  // Resolved locally (not through `data`) so the mdsvex-compiled component class
  // never has to cross a load-function serialization boundary.
  let doc = $derived(findDoc(data.slug));
</script>

<svelte:head>
  <title>{data.metadata.title} — Reckons.AI Docs</title>
  {#if data.metadata.excerpt}
    <meta name="description" content={data.metadata.excerpt} />
  {/if}
</svelte:head>

{#if doc}
  <article class="doc-prose">
    {#if data.metadata.template === 'post' && data.metadata.date}
      <p class="doc-date">{data.metadata.date}</p>
    {/if}
    <doc.component />
  </article>
{/if}

<style>
  .doc-prose {
    max-width: 68ch;
  }
  .doc-date {
    font-family: var(--font-mono);
    font-size: 0.8rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 0.5rem;
  }
  .doc-prose :global(h1) {
    font-size: clamp(1.9rem, 5vw, 2.6rem);
    margin-bottom: 1rem;
  }
  .doc-prose :global(h2) {
    margin-top: 2rem;
    margin-bottom: 0.75rem;
  }
  .doc-prose :global(h3) {
    margin-top: 1.5rem;
    margin-bottom: 0.5rem;
  }
  .doc-prose :global(p) {
    margin: 0 0 1rem;
    color: var(--ink-2);
  }
  .doc-prose :global(ul),
  .doc-prose :global(ol) {
    margin: 0 0 1rem;
    padding-left: 1.4rem;
    color: var(--ink-2);
  }
  .doc-prose :global(li) {
    margin-bottom: 0.35rem;
  }
  .doc-prose :global(code) {
    font-family: var(--font-mono);
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0.1em 0.35em;
    font-size: 0.9em;
  }
  .doc-prose :global(pre) {
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--rad-sm);
    padding: 1rem;
    overflow-x: auto;
    margin: 0 0 1rem;
  }
  .doc-prose :global(pre code) {
    background: none;
    border: none;
    padding: 0;
  }
  .doc-prose :global(blockquote) {
    margin: 0 0 1rem;
    padding: 0.5rem 1rem;
    border-left: 2px solid var(--accent);
    color: var(--muted);
  }

  /* ── Diagrams ──────────────────────────────────────────────────────────────
     Rendered to SVG at build time (scripts/lib/mermaid-render.ts), so there is no
     mermaid runtime here and the docs route keeps csr = false. The renderer strips
     mermaid's baked width/height, which is what lets the figure size itself to the
     column rather than to whatever viewport happened to render it. */
  /*
   * DERIVED PROSE (F192) — a sentence COMPUTED from the graph rather than written into it.
   * Set apart visually because a reader is owed the difference: everything else on the page is
   * something a person wrote, and this is a statement of what the facts currently are.
   */
  .doc-prose :global(p.derived) {
    margin: 0.75rem 0 1.5rem;
    padding: 0.6rem 0 0.6rem 0.9rem;
    border-left: 2px solid var(--accent);
    color: var(--ink-2);
    font-size: 0.9rem;
  }

  /*
   * SET MEMBERSHIP (F187.5) — which sets an entity belongs to. Styled like the derived sentence
   * because it is the same kind of statement: computed from the graph, not written by anyone.
   */
  .doc-prose :global(p.in-sets) {
    margin: -0.5rem 0 1.5rem;
    font-family: var(--font-mono);
    font-size: 0.8rem;
    color: var(--muted);
  }
  .doc-prose :global(p.in-sets a) { color: var(--accent); }

  /*
   * CARD GALLERY and ACCORDION (F190/F191) — both declared in the graph by kpred:render-as, and
   * both deliberately ZERO JavaScript so they can exist on a route with csr = false. The
   * accordion is <details>/<summary>, which is keyboard-accessible for free and which the
   * browser's own find-in-page can reach once opened.
   */
  .doc-prose :global(.card-grid) {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
    gap: 0.75rem;
    margin: 1.25rem 0 2rem;
  }
  .doc-prose :global(.card) {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.9rem 1rem;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--surface);
    text-decoration: none;
    color: inherit;
    transition: border-color 0.12s ease;
  }
  .doc-prose :global(.card:hover),
  .doc-prose :global(.card:focus-visible) { border-color: var(--accent); }
  .doc-prose :global(.card-title) {
    font-family: var(--font-mono);
    font-size: 0.92rem;
    color: var(--accent);
  }
  .doc-prose :global(.card-text) {
    font-size: 0.84rem;
    line-height: 1.5;
    color: var(--muted);
  }
  .doc-prose :global(.card-status) {
    font-family: var(--font-mono);
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
  }
  .doc-prose :global(details.accordion) {
    border-top: 1px solid var(--line);
    padding: 0.15rem 0;
  }
  .doc-prose :global(details.accordion summary) {
    cursor: pointer;
    padding: 0.65rem 0;
    font-family: var(--font-mono);
    font-size: 0.95rem;
  }
  .doc-prose :global(details.accordion summary:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .doc-prose :global(details.accordion[open] summary) { color: var(--accent); }
  .doc-prose :global(details.accordion > :not(summary)) {
    margin: 0 0 0.85rem;
    padding-left: 1rem;
    border-left: 2px solid var(--line);
  }

  .doc-prose :global(figure.diagram) {
    margin: 1.75rem 0;
    padding: 1.25rem 1rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 10px;
    /* A wide flowchart scrolls inside its own box instead of forcing the page to. */
    overflow-x: auto;
  }
  .doc-prose :global(figure.diagram svg) {
    display: block;
    width: 100%;
    height: auto;
    /* NO max-height. The first version capped this at 420px, which sounds prudent and is not:
       the tallest diagram here is 944x988, so the cap scaled it to ~0.42 and rendered its 16px
       labels at about 7px — a picture technically present and practically unreadable. A diagram
       is worth its height, and the reader can scroll. */
  }
  .doc-prose :global(figure.diagram figcaption) {
    margin-top: 0.9rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--line);
    font-family: var(--font-mono);
    font-size: 0.78rem;
    line-height: 1.5;
    color: var(--muted);
  }

</style>
