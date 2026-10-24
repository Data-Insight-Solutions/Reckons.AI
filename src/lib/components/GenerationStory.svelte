<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { getCurrentKbId } from '$lib/storage/kb-registry';
  import { supportsWorkspace } from '$lib/stores/workspace.svelte';
  import { applyShellyViewAdjust } from '$lib/stores/shelly-bridge.svelte';
  import {
    cancelJob, clearJobsError, connectJobs, generationJobs as gen, retryJob, submitJobs, useGenerationJobs,
  } from '$lib/stores/generation-jobs.svelte';
  import { generationEntity, STAGE_LABELS, type GenerationRequest, type GenerationStage } from '$lib/generation/protocol';

  let { onexit }: { onexit: () => void } = $props();
  // Jobs, polling and attaching live in the shared store (F166.1.2); this keeps only the compose box.
  const storageKey = `reckons:generation-story-ui:${getCurrentKbId()}`;
  let prompt = $state('');
  let stage = $state<GenerationStage>('image');
  let composing = $state(true);
  let list: HTMLDivElement;
  const requests = $derived(gen.requests.filter(r => gen.originOf(r.id) === 'story'));
  const active = $derived(requests.find(r => !gen.isFinished(r.id)));
  const imageRequest = $derived([...requests].reverse().find(r => r.stage === 'image' && gen.attached.includes(r.id)));
  const capabilities = $derived(gen.capabilities);
  const connectionError = $derived(gen.connectionError);
  const busy = $derived(gen.busy);
  const connecting = $derived(gen.connecting);
  const error = $derived(gen.error);
  const available = (kind: GenerationStage) => gen.available(kind);
  const reason = (kind: GenerationStage) => gen.reason(kind);

  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify({ prompt, stage, composing })); } catch { /* per-viewer convenience only */ }
  }
  async function scroll() {
    await tick();
    // On phones the sheet owns the scroll container; on desktop the conversation owns it.
    list?.lastElementChild?.scrollIntoView({ block: 'end' });
  }
  const connect = (choose = false) => connectJobs(choose);

  async function submit(kind = stage, retry?: GenerationRequest) {
    if (busy || active) return;
    try {
      if (retry) await retryJob(retry, 'story');
      else if (kind === 'image' || !imageRequest) await submitJobs([{ stage: 'image', prompt: prompt.trim() }], 'story');
      // A video takes its own motion prompt; a splat is made from the picture alone.
      else await submitJobs([{ stage: kind, prompt: kind === 'video' ? prompt.trim() : imageRequest.prompt, parentId: imageRequest.id }], 'story');
      composing = false;
      save();
      await scroll();
    } catch { /* the store reports the error */ }
  }
  const cancel = (request: GenerationRequest) => cancelJob(request);
  function compose(kind: GenerationStage) {
    stage = kind;
    prompt = '';
    composing = true;
    save();
    void scroll();
  }

  $effect(() => { if (gen.attached.length) void scroll(); });

  onMount(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      if (saved) {
        prompt = typeof saved.prompt === 'string' ? saved.prompt : '';
        stage = saved.stage === 'video' ? 'video' : 'image';
        composing = saved.composing !== false;
      }
    } catch { /* start with an empty compose box */ }
    return useGenerationJobs();
  });
</script>

<div class="generation-story">
  <div class="conversation" bind:this={list} aria-live="polite">
    <div class="shelly-message">
      <img src="/svg/head1.svg" alt="Shelly" width="28" height="28" />
      <div><h3>Let’s create something</h3><p>What image would you like me to generate? Describe the subject, setting, and style. Once it’s ready, we can make a video or a Gaussian splat from it.</p></div>
    </div>

    <details class="capability-guide">
      <summary>What works now, and what needs setup?</summary>
      <p><strong>Included:</strong> explore the example images, videos, GLB models and splats; view and import your own assets. No generation model is bundled.</p>
      <p><strong>With local setup:</strong> create an image from a prompt, then a video or Gaussian splat from that image. GLB mesh generation and other derivations are not available in this story yet.</p>
      <p><a href="/docs/features/generation-setup" target="_blank" rel="noopener noreferrer">Generation tools and setup guide</a> · <a href="/settings/integrations" target="_blank" rel="noopener noreferrer">Integrations settings</a></p>
      <p><strong>Warning — agent device control:</strong> an external agent with terminal or SSH access can change files, install software and modify services with the permissions you give it. Use a limited account, review its install plan, and keep credentials outside your space. This story does not grant that access.</p>
      <a href="/docs/features/agent-setup" target="_blank" rel="noopener noreferrer">Agent setup and installation permissions</a>
    </details>

    {#if !capabilities || connectionError}
      <div class="connection">
        <p>{connectionError || 'Checking the local generation runner…'}</p>
        {#if supportsWorkspace()}
          <button onclick={() => connect(true)} disabled={connecting}>Connect workspace folder</button>
          <button onclick={() => connect()} disabled={connecting}>Reconnect runner</button>
        {:else}
          <p>Local generation needs a browser with workspace folder access, such as desktop Chrome or Edge.</p>
        {/if}
        <details>
          <summary>Set up local generation</summary>
          <p>On your generation machine, install the tools with <code>bash scripts/content/gen-setup.sh</code>, then start:</p>
          <code>npm run gen:serve -- --workspace=/path/to/your/private-workspace</code>
          <p>Connect that same folder here. Your prompts and generated files stay in it.</p>
        </details>
      </div>
    {/if}

    {#each requests as request (request.id)}
      {@const job = gen.jobOf(request.id)}
      <div class="turn">
        <p class="user-message">{request.stage === 'image' ? request.prompt : `${STAGE_LABELS[request.stage]}: ${request.prompt}`}</p>
        <div class="result">
          <p class="status" role="status">
            {#if gen.attached.includes(request.id)}
              Your {STAGE_LABELS[request.stage].toLowerCase()} is ready. I’ve added it to this space for review.
            {:else if job?.state === 'failed'}
              Generation failed: {job.error || 'The runner did not produce a checked result.'}
            {:else if job?.state === 'cancelled'}
              Cancelled. No result from this job will be added.
            {:else if job?.state === 'completed'}
              Checking and adding your {STAGE_LABELS[request.stage].toLowerCase()}…
            {:else if job?.state === 'running'}
              Creating your {STAGE_LABELS[request.stage].toLowerCase()}…
            {:else}
              {capabilities ? 'Queued for the local runner.' : 'Waiting for the local runner. Your request is saved.'}
            {/if}
          </p>
          {#if gen.previews[request.id] && request.stage === 'image'}
            <img class="preview" src={gen.previews[request.id]} alt={`Generated: ${request.prompt}`} onload={() => void scroll()} />
          {:else if gen.previews[request.id] && request.stage === 'video'}
            <!-- Generated silent clips have no speech or separate caption track. -->
            <!-- svelte-ignore a11y_media_has_caption -->
            <video class="preview" src={gen.previews[request.id]} controls aria-label="Generated video" onloadedmetadata={() => void scroll()}></video>
          {/if}
          {#if gen.attached.includes(request.id)}
            <span class="generated-label">Generated · {STAGE_LABELS[request.stage]}</span>
            <button onclick={() => applyShellyViewAdjust({ selectEntity: generationEntity(request.id), layout: 'focus' })}>Show in space</button>
          {:else if job?.state === 'failed' || job?.state === 'cancelled'}
            <button onclick={() => submit(request.stage, request)} disabled={busy || !!active || !available(request.stage)}>Retry</button>
          {:else}
            <button onclick={() => cancel(request)} disabled={busy}>Cancel generation</button>
          {/if}
        </div>
      </div>
    {/each}

    {#if imageRequest && !active && !composing}
      <div class="shelly-message">
        <img src="/svg/head1.svg" alt="Shelly" width="28" height="28" />
        <div>
          <p>Would you like a video or a Gaussian splat from this image, or shall we create another image?</p>
          <div class="choices">
            <button onclick={() => compose('video')} disabled={!available('video') || busy}>Make a video</button>
            <button onclick={() => submit('splat')} disabled={!available('splat') || busy}>Make a Gaussian splat</button>
            <button onclick={() => compose('image')} disabled={busy}>Create another image</button>
            <button onclick={onexit}>Done for now</button>
          </div>
          {#each ['video', 'splat'] as kind}
            {#if !available(kind as GenerationStage)}<p class="hint">{reason(kind as GenerationStage)}</p>{/if}
          {/each}
          <p class="hint">A generated splat imagines unseen geometry from your image.</p>
        </div>
      </div>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p><button onclick={clearJobsError}>Check again</button>{/if}
  </div>

  <div class="composer">
    {#if (composing || (!imageRequest && !active)) && !active}
      <form onsubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label for="generation-prompt">{stage === 'video' ? 'How should the scene move?' : 'What image would you like?'}</label>
        <textarea id="generation-prompt" bind:value={prompt} oninput={() => queueMicrotask(save)} maxlength="2000" rows="3"
          placeholder={stage === 'video' ? 'Describe the movement or camera motion…' : 'A tiny lighthouse on a floating island, painted in watercolor…'} disabled={busy}></textarea>
        <div class="choices">
          <button class="primary" type="submit" disabled={busy || !prompt.trim() || !available(stage)}>Generate {stage}</button>
          {#if imageRequest}<button type="button" onclick={() => { composing = false; save(); }}>Back to choices</button>{/if}
        </div>
        {#if capabilities && !available(stage)}<p class="hint">{reason(stage)}</p>{/if}
      </form>
    {/if}
    <button class="exit" onclick={onexit}>Exit story mode</button>
    {#if active}<span class="hint">You can leave and return while this job runs.</span>{/if}
  </div>
</div>

<style>
  .generation-story { display: flex; flex-direction: column; min-height: 0; height: 100%; color: var(--ink); font-size: 0.85rem; }
  .conversation { flex: 1; overflow-y: auto; min-height: 0; padding: 1rem; }
  .shelly-message { display: flex; gap: 0.65rem; align-items: flex-start; margin-bottom: 1rem; }
  .shelly-message > img { flex-shrink: 0; }
  .shelly-message > div { min-width: 0; }
  h3 { margin: 0 0 0.5rem; font-size: 1rem; }
  p { margin: 0 0 0.7rem; line-height: 1.5; overflow-wrap: anywhere; }
  .connection, .result { padding: 0.8rem; border: 1px solid var(--line); border-radius: 0.6rem; margin-bottom: 1rem; background: var(--surface); }
  .user-message { padding: 0.7rem; margin-left: 2rem; background: var(--accent-soft); border-radius: 0.6rem; white-space: pre-wrap; }
  .preview { display: block; width: 100%; max-height: 260px; object-fit: contain; border-radius: 0.4rem; margin: 0.6rem 0; }
  .generated-label, .hint { font-size: 0.75rem; color: var(--ink-2); }
  .generated-label { display: block; margin-bottom: 0.5rem; }
  .choices { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.5rem; }
  button { padding: 0.45rem 0.65rem; border: 1px solid var(--line); border-radius: 0.4rem; background: var(--surface-2); color: var(--ink); cursor: pointer; font: inherit; }
  button:disabled { opacity: 0.5; cursor: default; }
  button.primary { background: var(--accent); color: var(--bg); }
  .composer { padding: 0.8rem 1rem; border-top: 1px solid var(--line); }
  label { display: block; margin-bottom: 0.5rem; }
  textarea { width: 100%; box-sizing: border-box; resize: vertical; border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 0.4rem; padding: 0.6rem; font: inherit; margin-bottom: 0.5rem; }
  .error { color: var(--danger); }
  details { margin-top: 0.7rem; }
  .capability-guide { margin-bottom: 1rem; }
  summary { cursor: pointer; margin-bottom: 0.5rem; }
  code { display: inline-block; max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; font: 0.75rem var(--font-mono); }
  .exit { margin-right: 0.5rem; }
</style>
