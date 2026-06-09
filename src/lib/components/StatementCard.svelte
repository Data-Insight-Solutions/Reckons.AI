<script lang="ts">
  import type { Statement } from '$lib/rdf/types';
  import { isIRI, isLit, termKey } from '$lib/rdf/types';

  let {
    statement,
    compact = false,
    showGraph = true,
    onclick = undefined,
    onclicksubject = undefined,
    onclickpredicate = undefined,
    onclickobject = undefined,
    onhoverterm = undefined
  } = $props<{
    statement: Statement;
    compact?: boolean;
    showGraph?: boolean;
    onclick?: (e: MouseEvent) => void;
    onclicksubject?: (key: string) => void;
    onclickpredicate?: (key: string) => void;
    onclickobject?: (key: string) => void;
    onhoverterm?: (key: string | null) => void;
  }>();

  function short(value: string): string {
    return value.split('/').pop() || value;
  }

  function termLabel(t: Statement['s']): string {
    if (isIRI(t)) return short(t.value);
    if (isLit(t)) return `"${t.value}"`;
    return `_:${t.value}`;
  }
</script>

<div class="row" class:compact role="button" tabindex="0" onclick={onclick} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { onclick?.(e as any); } }}>
  {#if statement.gloss && !compact}
    <div class="gloss">{statement.gloss}</div>
  {/if}
  {#if statement.excerpt && !compact}
    <blockquote class="excerpt">{statement.excerpt}</blockquote>
  {/if}
  <div class="triple mono">
    <button class="term subj"
      onclick={(e) => { e.stopPropagation(); onclicksubject?.(termKey(statement.s)); }}
      onpointerenter={() => onhoverterm?.(termKey(statement.s))}
      onpointerleave={() => onhoverterm?.(null)}>
      {termLabel(statement.s)}
    </button>
    <button class="term pred"
      onclick={(e) => { e.stopPropagation(); onclickpredicate?.(termKey(statement.p)); }}
      onpointerenter={() => onhoverterm?.(termKey(statement.p))}
      onpointerleave={() => onhoverterm?.(null)}>
      {short(statement.p.value)}
    </button>
    <button class="term obj"
      onclick={(e) => { e.stopPropagation(); onclickobject?.(termKey(statement.o)); }}
      onpointerenter={() => onhoverterm?.(termKey(statement.o))}
      onpointerleave={() => onhoverterm?.(null)}>
      {termLabel(statement.o)}
    </button>
  </div>
  <div class="meta">
    {#if showGraph}
      <span class="meta-item mono">⊳ {short(statement.g.value)}</span>
    {/if}
    <span class="meta-item mono">c={statement.confidence.toFixed(2)}</span>
    <span class="meta-item tag {statement.status}">{statement.status}</span>
  </div>
</div>

<style>
  .row {
    display: block;
    width: 100%;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--rad);
    padding: 1rem 1.1rem;
    margin: 0;
    cursor: pointer;
    transition: border-color 0.15s, transform 0.15s, background 0.15s;
  }
  .row:hover {
    border-color: var(--muted-2);
    background: var(--surface-2);
  }
  .row.compact { padding: 0.6rem 0.85rem; }
  .gloss {
    font-family: var(--font-display);
    font-size: 1.1rem;
    line-height: 1.3;
    margin-bottom: 0.55rem;
    color: var(--ink);
  }
  .excerpt {
    font-size: 0.82rem;
    font-style: italic;
    color: var(--muted);
    border-left: 2px solid var(--line);
    padding: 0.25rem 0.6rem;
    margin: 0 0 0.5rem 0;
    line-height: 1.35;
  }
  .triple {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    align-items: baseline;
    color: var(--ink-2);
    font-size: 0.86rem;
  }
  .term {
    background: none;
    border: none;
    padding: 0.1rem 0.25rem;
    border-radius: var(--rad-sm);
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
    font-style: inherit;
    transition: background 0.1s;
  }
  .term:hover {
    background: var(--surface-3);
  }
  .term.subj {
    color: var(--accent);
  }
  .term.subj:hover {
    background: var(--accent-soft);
  }
  .term.pred {
    color: var(--ink-2);
    font-style: italic;
  }
  .term.obj {
    color: var(--data);
  }
  .term.obj:hover {
    background: var(--data-soft);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    margin-top: 0.7rem;
    color: var(--muted);
    font-size: 0.72rem;
  }
  .meta-item.tag { font-size: 0.65rem; }
</style>
