<script lang="ts">
  import type { Statement } from '$lib/rdf/types';
  import { readSourceBaseline } from '$lib/stores/workspace.svelte';
  import { deriveEvidence, evidenceNotice, EVIDENCE_LIMITS_NOTE } from '$lib/ingest/statement-evidence';

  // Thin renderer: the derivation is in $lib/ingest/statement-evidence (pure, tested).
  let { statement, sourceTitle } = $props<{ statement: Statement; sourceTitle: string }>();

  let sourceText = $state<string | null>(null);
  let loaded = $state(false);

  $effect(() => {
    const id = statement.sourceId;
    loaded = false;
    sourceText = null;
    let live = true;
    readSourceBaseline(id)
      .then((b) => { if (live) sourceText = b?.text ?? null; })
      .catch(() => {})
      .finally(() => { if (live) loaded = true; });
    return () => { live = false; };
  });

  const evidence = $derived(loaded
    ? deriveEvidence({ sourceTitle, excerpt: statement.excerpt, sourceText, grounded: statement.grounded })
    : null);
  const notice = $derived(evidence ? evidenceNotice(evidence) : null);
</script>

{#if evidence && evidence.kind !== 'none'}
  <section class="statement-evidence-section" aria-label="Evidence">
    <h5 class="statement-evidence-title">Evidence</h5>
    <p class="statement-evidence-source">From <strong>{evidence.sourceTitle}</strong>
      {#if evidence.kind === 'anchored'}
        <span class="statement-evidence-where">· passage {evidence.passageNumber} of {evidence.passageCount}</span>
      {/if}
    </p>
    {#if evidence.kind === 'anchored'}
      <blockquote class="statement-evidence-text">{evidence.before}<mark class="statement-evidence-mark">{evidence.highlight}</mark>{evidence.after}</blockquote>
    {:else if evidence.excerpt}
      <blockquote class="statement-evidence-text">{evidence.excerpt}</blockquote>
    {/if}
    {#if notice}<p class="statement-evidence-note">{notice}</p>{/if}
    <p class="statement-evidence-note">{EVIDENCE_LIMITS_NOTE}</p>
  </section>
{/if}

<style>
  .statement-evidence-section { margin-top: 0.4rem; padding: 0.5rem 0.6rem; border: 1px solid var(--line); border-radius: var(--rad); background: var(--surface); }
  .statement-evidence-title { margin: 0 0 0.2rem; font-family: var(--font-mono); font-size: 0.85rem; color: var(--accent); text-transform: uppercase; }
  .statement-evidence-source { margin: 0 0 0.3rem; font-size: 0.8rem; }
  .statement-evidence-where { color: var(--muted); }
  .statement-evidence-text { margin: 0; padding: 0.4rem 0.6rem; max-height: 14rem; overflow: auto; border-left: 3px solid var(--line); font-size: 0.82rem; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
  .statement-evidence-mark { background: color-mix(in srgb, var(--accent) 30%, transparent); color: inherit; border-radius: 2px; }
  .statement-evidence-note { margin: 0.3rem 0 0; font-size: 0.75rem; color: var(--muted); }
</style>
