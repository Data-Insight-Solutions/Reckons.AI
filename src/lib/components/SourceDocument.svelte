<script lang="ts">
  import { isIRI, type Statement } from '$lib/rdf/types';
  import { readSourceBaseline } from '$lib/stores/workspace.svelte';
  import { readRetainedSourceText } from '$lib/stores/source-corpus';
  import {
    deriveSourceDocument, groupByStatus, statusSummary, sourceDocumentNotice,
    UNPLACED_REASON, EMPTY_PASSAGE_NOTE,
  } from '$lib/ingest/source-document';
  import StatementCard from './StatementCard.svelte';

  // Thin renderer: the derivation is in $lib/ingest/source-document (pure, tested). Text is read
  // the same way StatementEvidence reads it, so both views cut the same passages.
  let { sourceId, sourceHash, statements, onterm } = $props<{
    sourceId: string;
    sourceHash?: string;
    statements: Statement[];
    /** Open an entity (a statement's subject or object) in the source view. */
    onterm: (key: string) => void;
  }>();

  let sourceText = $state<string | null>(null);
  let loaded = $state(false);
  let openPassage = $state<number | null>(null);
  let showUnplaced = $state(false);

  $effect(() => {
    const id = sourceId;
    const hash = sourceHash;
    loaded = false;
    sourceText = null;
    openPassage = null;
    let live = true;
    readRetainedSourceText(hash)
      .then((t) => t ?? readSourceBaseline(id).then((b) => b?.text ?? null))
      .then((t) => { if (live) sourceText = t; })
      .catch(() => {})
      .finally(() => { if (live) loaded = true; });
    return () => { live = false; };
  });

  const doc = $derived(loaded ? deriveSourceDocument(sourceText, statements) : null);
  const notice = $derived(doc ? sourceDocumentNotice(doc) : null);
</script>

{#if doc}
  <section class="source-document-section" aria-label="Source document">
    {#if doc.kind === 'no-text'}
      <h4>Document</h4>
      <p class="source-document-note">{notice}</p>
    {:else}
      <h4>Document · {doc.passages.length} passage{doc.passages.length === 1 ? '' : 's'}</h4>
      <p class="source-document-note">Choose a passage to see the statements that came from it.</p>
      <ol class="source-document-passages">
        {#each doc.passages as passage (passage.index)}
          {@const summary = statusSummary(passage.counts)}
          <li class="source-document-passage" class:open={openPassage === passage.index} data-passage={passage.number}>
            <button class="source-document-boundary" aria-expanded={openPassage === passage.index}
              onclick={() => (openPassage = openPassage === passage.index ? null : passage.index)}>
              <span class="mono">Passage {passage.number}</span>
              <span class="source-document-counts">{summary ?? 'no statements'}</span>
            </button>
            <p class="source-document-text">{passage.text}</p>
            {#if openPassage === passage.index}
              <div class="source-document-statements" role="region" aria-label={`Statements from passage ${passage.number}`}>
                {#each groupByStatus(passage.statements) as group (group.status)}
                  <h5>{group.status.replace('-', ' ')} ({group.statements.length})</h5>
                  {#each group.statements as st (st.id)}
                    <StatementCard statement={st} compact={true} showGraph={false} onclicksubject={onterm} onclickobject={isIRI(st.o) ? onterm : undefined} />
                  {/each}
                {:else}
                  <p class="source-document-note">{EMPTY_PASSAGE_NOTE}</p>
                {/each}
              </div>
            {/if}
          </li>
        {/each}
      </ol>
      {#if doc.unplaced.length}
        <button class="source-document-unplaced-toggle" aria-expanded={showUnplaced} onclick={() => (showUnplaced = !showUnplaced)}>
          {doc.unplaced.length} statement{doc.unplaced.length === 1 ? '' : 's'} not placed in a passage
        </button>
        {#if showUnplaced}
          <ul class="source-document-unplaced">
            {#each doc.unplaced as item (item.statement.id)}
              <li>
                <StatementCard statement={item.statement} compact={true} showGraph={false} onclicksubject={onterm} onclickobject={isIRI(item.statement.o) ? onterm : undefined} />
                <small>Not placed: {UNPLACED_REASON[item.reason]}.</small>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    {/if}
  </section>
{/if}

<style>
  .source-document-section { margin-top: 0.6rem; }
  .source-document-note { margin: 0.2rem 0 0.4rem; font-size: 0.75rem; color: var(--muted); }
  .source-document-passages { list-style: none; margin: 0; padding: 0; max-height: 26rem; overflow: auto; border: 1px solid var(--line); border-radius: var(--rad); background: var(--surface); }
  .source-document-passage { border-top: 1px dashed var(--line); }
  .source-document-passage:first-child { border-top: none; }
  .source-document-passage.open { background: var(--surface-2); }
  .source-document-boundary { display: flex; justify-content: space-between; gap: 0.5rem; width: 100%; min-height: 44px; padding: 0.35rem 0.6rem; border: none; background: none; color: var(--ink-2); cursor: pointer; text-align: left; font-size: 0.75rem; }
  .source-document-boundary:hover { color: var(--accent); }
  .source-document-counts { color: var(--muted); text-align: right; }
  .source-document-text { margin: 0; padding: 0 0.6rem 0.5rem; font-size: 0.8rem; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
  .source-document-statements { padding: 0 0.6rem 0.6rem; display: grid; gap: 0.3rem; }
  .source-document-statements h5 { margin: 0.3rem 0 0; font-family: var(--font-mono); font-size: 0.7rem; color: var(--accent); text-transform: uppercase; }
  .source-document-unplaced-toggle { margin-top: 0.4rem; min-height: 44px; background: none; border: 1px solid var(--line); border-radius: var(--rad); color: var(--ink-2); cursor: pointer; font-size: 0.75rem; padding: 0.3rem 0.6rem; }
  .source-document-unplaced { list-style: none; margin: 0.3rem 0 0; padding: 0; display: grid; gap: 0.4rem; }
  .source-document-unplaced small { font-size: 0.72rem; color: var(--muted); }
</style>
