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
</style>
