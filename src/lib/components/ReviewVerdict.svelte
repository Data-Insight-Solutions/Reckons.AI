<script lang="ts">
  /**
   * Review verdict (F34.5) — pass / fail / note on one step of a release review space.
   *
   * It writes a meta triple on the step itself (<step> kmeta:review-verdict "pass" | "fail" |
   * "unreviewed", and <step> kmeta:review-note "…"), so the verdict lives in the space, is
   * exported with it, and is hidden from the drawn graph like every kmeta: predicate.
   *
   * Shown only for a node that carries a kmeta:review-verdict triple, which the generator
   * (scripts/offline/release-review-space.ts) puts on every step. It is not the Review tab: that
   * settles proposed claims (pending/confirmed/rejected); nothing existing records a human
   * judgement of a screenshot, so this is the small new surface, kept inside the node panel.
   */
  import { v4 as uuid } from 'uuid';
  import { statements, addStatements, updateStatement } from '$lib/stores/kb.svelte';

  const VERDICT = 'urn:kbase:meta/review-verdict';
  const NOTE = 'urn:kbase:meta/review-note';

  let { entityIri }: { entityIri: string } = $props();

  const verdictSt = $derived(statements().find((s) => s.s.value === entityIri && s.p.value === VERDICT && s.status !== 'rejected'));
  const noteSt = $derived(statements().find((s) => s.s.value === entityIri && s.p.value === NOTE && s.status !== 'rejected'));
  const verdict = $derived(verdictSt?.o.value ?? '');
  let draft = $state('');
  let draftFor = $state('');
  $effect(() => {
    if (draftFor !== entityIri) { draftFor = entityIri; draft = noteSt?.o.value ?? ''; }
  });

  async function write(existing: typeof verdictSt, predicate: string, value: string) {
    if (existing) { await updateStatement(existing.id, { o: { kind: 'literal', value } }); return; }
    const now = Date.now();
    await addStatements([{
      id: uuid(),
      s: { kind: 'iri', value: entityIri },
      p: { kind: 'iri', value: predicate },
      o: { kind: 'literal', value },
      g: { kind: 'iri', value: 'urn:kbase:source/manual' },
      sourceId: 'manual',
      confidence: 1.0,
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    }]);
  }
  const setVerdict = (v: 'pass' | 'fail' | 'unreviewed') => write(verdictSt, VERDICT, v);
  const saveNote = () => write(noteSt, NOTE, draft.trim());
</script>

{#if verdictSt}
  <div class="rv" data-testid="review-verdict">
    <span class="rv-title mono">review verdict</span>
    <div class="rv-row" role="group" aria-label="Review verdict">
      <button class="rv-btn" class:on={verdict === 'pass'} aria-pressed={verdict === 'pass'} data-testid="verdict-pass" onclick={() => setVerdict('pass')}>pass</button>
      <button class="rv-btn fail" class:on={verdict === 'fail'} aria-pressed={verdict === 'fail'} data-testid="verdict-fail" onclick={() => setVerdict('fail')}>fail</button>
      <button class="rv-btn" class:on={verdict === 'unreviewed'} aria-pressed={verdict === 'unreviewed'} data-testid="verdict-clear" onclick={() => setVerdict('unreviewed')}>clear</button>
    </div>
    <p class="rv-state mono" data-testid="verdict-state">{verdict}</p>
    <label class="rv-note-label mono" for="rv-note">note</label>
    <textarea id="rv-note" class="rv-note" rows="3" bind:value={draft} placeholder="what looks wrong, or what you would change" data-testid="verdict-note"></textarea>
    <button class="rv-btn" data-testid="verdict-note-save" onclick={saveNote} disabled={draft.trim() === (noteSt?.o.value ?? '')}>save note</button>
  </div>
{/if}

<style>
  .rv { margin-top: 0.6rem; display: flex; flex-direction: column; gap: 0.35rem; }
  .rv-title, .rv-note-label { font-size: 0.7rem; color: var(--accent); text-transform: uppercase; }
  .rv-row { display: flex; gap: 0.35rem; }
  .rv-btn {
    font-family: var(--font-mono); font-size: 0.75rem; padding: 0.25rem 0.6rem;
    background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 4px; cursor: pointer;
  }
  .rv-btn:disabled { opacity: 0.5; cursor: default; }
  .rv-btn.on { background: var(--accent); color: var(--bg, #000); border-color: var(--accent); }
  .rv-btn.fail.on { background: #c0392b; border-color: #c0392b; color: #fff; }
  .rv-state { font-size: 0.75rem; color: var(--muted); margin: 0; }
  .rv-note { font-family: var(--font-body, inherit); font-size: 0.8rem; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.3rem; resize: vertical; }
</style>
