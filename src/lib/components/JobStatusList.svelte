<script lang="ts">
  import { applyShellyViewAdjust } from '$lib/stores/shelly-bridge.svelte';
  import { cancelJob, generationJobs as gen } from '$lib/stores/generation-jobs.svelte';
  import { jobEntity } from '$lib/generation/job-node';
  import { generationEntity, STAGE_LABELS, type GenerationRequest } from '$lib/generation/protocol';

  /** F166.1.2: the jobs one approved Shelly plan queued, with live state from the shared store. */
  let { ids }: { ids: string[] } = $props();
  const rows = $derived(ids.map(id => gen.requests.find(r => r.id === id)).filter((r): r is GenerationRequest => !!r));
  const indexOf = (id?: string) => rows.findIndex(r => r.id === id) + 1;

  function status(request: GenerationRequest): string {
    const job = gen.jobOf(request.id);
    if (gen.attached.includes(request.id)) return 'Ready, added to this space for review';
    if (job?.state === 'failed') return `Failed: ${job.error || 'no checked result'}`;
    if (job?.state === 'cancelled') return 'Cancelled';
    if (job?.state === 'completed') return 'Checking and adding…';
    if (job?.state === 'running') return 'Running on your GPU…';
    if (request.parentId && !gen.attached.includes(request.parentId)) {
      const n = indexOf(request.parentId);
      return n ? `Waiting for image ${n}` : 'Waiting for its image';
    }
    return gen.capabilities ? 'Queued' : 'Saved; waiting for the local runner';
  }
</script>

<ol class="job-status-list" aria-live="polite">
  {#each rows as request (request.id)}
    {@const job = gen.jobOf(request.id)}
    <li>
      <span class="stage">{STAGE_LABELS[request.stage]}</span>
      <span class="what">{request.parentId ? `from image ${indexOf(request.parentId) || '?'}` : request.prompt}</span>
      <span class="state" class:failed={job?.state === 'failed'}>{status(request)}</span>
      {#if gen.previews[request.id] && request.stage === 'image'}
        <img src={gen.previews[request.id]} alt={`Generated: ${request.prompt}`} />
      {/if}
      <span class="btns">
        {#if gen.attached.includes(request.id)}
          <button class="sm" onclick={() => applyShellyViewAdjust({ selectEntity: generationEntity(request.id), layout: 'focus' })}>show</button>
        {:else if !gen.isFinished(request.id)}
          <button class="sm" onclick={() => cancelJob(request)} disabled={gen.busy}>cancel</button>
        {/if}
        <button class="sm" onclick={() => applyShellyViewAdjust({ selectEntity: jobEntity(request.id), layout: 'focus' })}>job</button>
      </span>
    </li>
  {/each}
</ol>

<style>
  .job-status-list { margin: 0.25rem 0 0; padding-left: 1.25rem; display: grid; gap: 0.4rem; font-size: 0.8rem; }
  li { display: grid; grid-template-columns: 7rem 1fr; gap: 0.1rem 0.5rem; align-items: baseline; }
  .stage { font-family: var(--font-mono); color: var(--accent); text-transform: uppercase; font-size: 0.7rem; }
  .what { overflow-wrap: anywhere; }
  .state { grid-column: 2; color: var(--text-muted, var(--muted)); }
  .state.failed { color: var(--danger, #ef4444); }
  img { grid-column: 2; max-width: 5rem; border-radius: 4px; }
  .btns { grid-column: 2; display: flex; gap: 0.35rem; }
  /* Same size as the chat panel's button.sm, whose scoped rule does not reach this component. */
  .btns button { padding: 0.25rem 0.6rem; font-size: 0.72rem; }
</style>
