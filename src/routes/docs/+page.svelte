<script lang="ts">
  let { data } = $props();
</script>

<svelte:head>
  <title>Docs — Reckons.AI</title>
</svelte:head>

<div class="index">
  <p class="kicker">Reckons.AI</p>
  <h1>Docs</h1>
  <p class="lede">
    Pages are nodes in the Reckons.AI graph — this site is generated from it.
  </p>

  {#each data.sections as { section, docs } (section)}
    <section class="index-section">
      <h2>{section}</h2>
      <ul>
        {#each docs as doc (doc.path)}
          <li>
            <a href={`/docs/${doc.path}`}>{doc.metadata.title}</a>
            {#if doc.metadata.excerpt}
              <p class="excerpt">{doc.metadata.excerpt}</p>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {:else}
    <p class="empty">No pages published yet.</p>
  {/each}
</div>

<style>
  .kicker {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.2em;
    margin: 0 0 0.5rem;
  }
  .lede {
    color: var(--ink-2);
    margin: 0.75rem 0 2.5rem;
    max-width: 60ch;
  }
  .index-section + .index-section {
    margin-top: 2rem;
  }
  .index-section h2 {
    font-size: 1.3rem;
    margin-bottom: 0.75rem;
  }
  .index-section ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .index-section li {
    padding: 0.75rem 0;
    border-top: 1px solid var(--line);
  }
  .index-section a {
    font-family: var(--font-mono);
    font-size: 1rem;
  }
  .excerpt {
    margin: 0.3rem 0 0;
    color: var(--muted);
    font-size: 0.88rem;
  }
  .empty {
    color: var(--muted);
  }
</style>
