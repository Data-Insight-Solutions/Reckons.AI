<script lang="ts">
  import { onMount } from 'svelte';
  import { BM25Index, type BM25Doc } from '$lib/rdf/bm25';

  interface SearchDoc { path: string; title: string; section: string; excerpt: string; headings: string[]; text: string }

  let query = $state('');
  let docs = $state<SearchDoc[]>([]);
  let index = $state<BM25Index | null>(null);
  let state_ = $state<'loading' | 'ready' | 'failed'>('loading');
  let input: HTMLInputElement;

  onMount(async () => {
    try {
      const res = await fetch('/docs-search-index.json');
      if (!res.ok) throw new Error(`index ${res.status}`);
      const data = (await res.json()) as { docs: SearchDoc[] };
      docs = data.docs;
      // The title and headings are repeated into the document on purpose: BM25 has no field
      // weighting, so a term in a heading is made to count more by appearing more often.
      index = new BM25Index(docs.map((d): BM25Doc => ({
        id: d.path,
        subject: `${d.title} ${d.title} ${d.headings.join(' ')}`,
        predicate: d.section,
        object: `${d.excerpt} ${d.text}`,
      })));
      state_ = 'ready';
      input?.focus();
      // A query in the URL makes a result linkable — someone can share a search, not just a page.
      const q = new URLSearchParams(location.search).get('q');
      if (q) query = q;
    } catch {
      state_ = 'failed';
    }
  });

  const byPath = $derived(new Map(docs.map((d) => [d.path, d])));
  const results = $derived(
    !index || query.trim().length < 2 ? [] : index.search(query.trim(), 25)
      .map((r) => ({ score: r.score, doc: byPath.get(r.id)! }))
      .filter((r) => r.doc),
  );

  /** A short window of body text around the first match, so a result shows WHY it matched. */
  function snippet(text: string, q: string): string {
    const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const lower = text.toLowerCase();
    let at = -1;
    for (const t of terms) { const i = lower.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
    if (at < 0) return text.slice(0, 180);
    const start = Math.max(0, at - 70);
    return (start > 0 ? '…' : '') + text.slice(start, start + 220).trim() + '…';
  }
</script>

<svelte:head><title>Search the docs — Reckons.AI</title></svelte:head>

<div class="search">
  <p class="kicker">Reckons.AI</p>
  <h1>Search the docs</h1>

  <label class="field">
    <span class="sr-only">Search</span>
    <input
      bind:this={input}
      bind:value={query}
      type="search"
      placeholder="Try: review queue, altitude, deployment…"
      autocomplete="off"
      spellcheck="false"
    />
  </label>

  {#if state_ === 'loading'}
    <p class="note">Loading the index…</p>
  {:else if state_ === 'failed'}
    <p class="note error">The search index could not be loaded. Every page is still reachable from
      the <a href="/docs">contents</a>.</p>
  {:else if query.trim().length < 2}
    <p class="note">{docs.length} pages indexed. Type at least two characters.</p>
  {:else if results.length === 0}
    <p class="note">Nothing matched “{query}”.</p>
  {:else}
    <p class="note">{results.length} result{results.length === 1 ? '' : 's'}</p>
    <ul>
      {#each results as r (r.doc.path)}
        <li>
          <a href={`/docs/${r.doc.path}`}>{r.doc.title}</a>
          <span class="section">{r.doc.section}</span>
          <p class="snippet">{snippet(r.doc.text, query)}</p>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .kicker {
    font-family: var(--font-mono); font-size: 0.72rem; color: var(--accent);
    text-transform: uppercase; letter-spacing: 0.2em; margin: 0 0 0.5rem;
  }
  .field { display: block; margin: 1.5rem 0; }
  .field input {
    width: 100%; padding: 0.75rem 1rem; font-size: 1.05rem;
    font-family: var(--font-mono); color: var(--ink);
    background: var(--surface); border: 1px solid var(--line); border-radius: 4px;
  }
  .field input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .sr-only {
    position: absolute; width: 1px; height: 1px; overflow: hidden;
    clip: rect(0 0 0 0); white-space: nowrap;
  }
  .note { color: var(--muted); font-size: 0.9rem; }
  .note.error { color: var(--accent); }
  ul { list-style: none; margin: 1rem 0 0; padding: 0; }
  li { padding: 0.9rem 0; border-top: 1px solid var(--line); }
  li a { font-family: var(--font-mono); font-size: 1rem; }
  .section {
    font-family: var(--font-mono); font-size: 0.72rem; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.12em; margin-left: 0.6rem;
  }
  .snippet { margin: 0.35rem 0 0; color: var(--ink-2); font-size: 0.88rem; line-height: 1.55; }
</style>
