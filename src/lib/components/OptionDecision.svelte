<script lang="ts">
  /**
   * F223.12.4: weigh one option of a Reckoning's proposal: accept it, put it aside, or (once accepted) answer its
   * missing-input questions. Used on the Reckoning card and on the canvas beside the option being shown, so both
   * places say the same thing and change the same rows.
   *
   * Accepting asks first, in words: how many statements get confirmed, how many jobs are queued (in one approval),
   * how many statements of the other options are superseded. The rules are in rdf/reckoning-accept.ts; this only shows them.
   */
  import { statements } from '$lib/stores/kb.svelte';
  import { acceptProposalOption, rejectProposalOption, answerOpenQuestion } from '$lib/stores/reckoning.svelte';
  import { readStoredProposal, reckoningOfOption, acceptOption, describeAccept, optionState } from '$lib/rdf/reckoning-accept';
  import { ACTION_STATUS } from '$lib/rdf/proposal';

  let { optionId }: { optionId: string } = $props();

  const reckoningId = $derived(reckoningOfOption(optionId));
  const stored = $derived(reckoningId ? readStoredProposal(statements(), reckoningId) : null);
  const standing = $derived(reckoningId ? optionState(statements(), reckoningId, optionId) : 'proposed');
  const waiting = $derived(stored?.proposal.status === ACTION_STATUS.potential);
  const preview = $derived(stored && waiting ? acceptOption(stored.proposal, optionId, statements(), stored.statusRowId) : null);
  const questions = $derived(standing === 'accepted' ? statements().filter((st) => st.proposalOption === optionId && st.needsObject && st.status === 'pending') : []);

  let confirming = $state<'accept' | 'reject' | null>(null);
  let working = $state(false);
  let message = $state('');
  let answers = $state<Record<string, string>>({});

  async function accept() {
    if (!reckoningId) return;
    working = true; message = '';
    const out = await acceptProposalOption(reckoningId, optionId);
    working = false;
    if (out.ok) { confirming = null; message = out.queued ? `Accepted. ${out.queued} job${out.queued === 1 ? '' : 's'} queued.` : 'Accepted.'; }
    else message = out.message;
  }
  async function reject() {
    if (!reckoningId) return;
    working = true; message = '';
    const out = await rejectProposalOption(reckoningId, optionId);
    working = false;
    if (out.ok) { confirming = null; message = 'Rejected. Its statements stay readable.'; }
    else message = out.message;
  }
  async function answer(id: string) {
    if (!reckoningId) return;
    working = true;
    await answerOpenQuestion(reckoningId, id, answers[id] ?? '');
    working = false;
  }
</script>

{#if stored}
  <div class="decision" data-testid="option-decision" data-state={standing}>
    {#if standing === 'proposed' && waiting}
      {#if confirming === null}
        <div class="row">
          <button class="d-btn d-accept" data-testid="accept-option" onclick={() => (confirming = 'accept')}>Accept this option</button>
          <button class="d-btn" data-testid="reject-option" onclick={() => (confirming = 'reject')}>Reject</button>
        </div>
      {:else if confirming === 'accept'}
        <div class="confirm" data-testid="accept-confirm">
          <p>{preview?.ok ? describeAccept(preview.plan) : (preview?.message ?? 'This option cannot be accepted.')}</p>
          <div class="row">
            <button class="d-btn d-accept" data-testid="accept-confirm-yes" disabled={working || !preview?.ok} onclick={accept}>{working ? 'Working…' : 'Yes, accept'}</button>
            <button class="d-btn" disabled={working} onclick={() => (confirming = null)}>Cancel</button>
          </div>
        </div>
      {:else}
        <div class="confirm" data-testid="reject-confirm">
          <p>This marks this option's statements as rejected. They stay readable, and no job is queued.</p>
          <div class="row">
            <button class="d-btn" data-testid="reject-confirm-yes" disabled={working} onclick={reject}>{working ? 'Working…' : 'Yes, reject'}</button>
            <button class="d-btn" disabled={working} onclick={() => (confirming = null)}>Cancel</button>
          </div>
        </div>
      {/if}
    {:else if standing === 'accepted'}
      <p class="d-state">Accepted by you.{stored.proposal.status === ACTION_STATUS.completed ? ' The proposal is completed: its target is reached.' : ' The proposal is active until its target is reached.'}</p>
      {#each questions as q (q.id)}
        <div class="q" data-testid="open-question">
          <p>{q.question ?? 'A missing input'}</p>
          <div class="row">
            <input type="text" data-testid="open-question-input" aria-label={q.question ?? 'Answer'} placeholder="Your answer" bind:value={answers[q.id]} />
            <button class="d-btn d-accept" data-testid="open-question-answer" disabled={working || !(answers[q.id] ?? '').trim()} onclick={() => answer(q.id)}>Answer</button>
          </div>
        </div>
      {/each}
    {:else if standing === 'superseded'}
      <p class="d-state">Superseded: another option was accepted. Kept on record.</p>
    {:else if standing === 'rejected'}
      <p class="d-state">Rejected by you. Kept on record.</p>
    {/if}
    {#if message}<p class="d-msg" role="status">{message}</p>{/if}
  </div>
{/if}

<style>
  .decision { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 0.4rem; }
  .row { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
  .confirm p, .q p, .d-state, .d-msg { font-size: 0.8rem; color: var(--ink-2); margin: 0; line-height: 1.5; }
  .d-btn { font-family: var(--font-mono); font-size: 0.75rem; padding: 0.3rem 0.7rem; border: 1px solid var(--border); background: var(--surface); color: var(--ink); cursor: pointer; }
  .d-btn:disabled { opacity: 0.5; cursor: default; }
  .d-accept { border-color: var(--accent); color: var(--accent); }
  input { font-size: 0.8rem; padding: 0.3rem 0.5rem; border: 1px solid var(--border); background: var(--surface); color: var(--ink); min-width: 12rem; }
</style>
