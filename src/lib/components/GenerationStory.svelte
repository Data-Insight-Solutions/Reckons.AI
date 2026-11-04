<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { getCurrentKbId } from '$lib/storage/kb-registry';
  import { workspaceHandle, workspaceState, pickWorkspace, reconnectWorkspace, supportsWorkspace } from '$lib/stores/workspace.svelte';
  import { applyShellyViewAdjust } from '$lib/stores/shelly-bridge.svelte';
  import { officialKbActive } from '$lib/stores/official-kb.svelte';
  import { attachGeneration } from '$lib/generation/attach';
  import { WorkspaceGenerationClient } from '$lib/generation/workspace-client';
  import {
    generationEntity, parseRequest, STAGE_LABELS,
    type GenerationCapabilities, type GenerationJob, type GenerationRequest, type GenerationStage,
  } from '$lib/generation/protocol';

  let { onexit }: { onexit: () => void } = $props();
  const spaceId = getCurrentKbId();
  const storageKey = `reckons:generation-story:${spaceId}`;
  let prompt = $state('');
  let stage = $state<GenerationStage>('image');
  let requests = $state<GenerationRequest[]>([]);
  let jobs = $state<GenerationJob[]>([]);
  let previews = $state<Record<string, string>>({});
  let attached = $state<string[]>([]);
  let capabilities = $state<GenerationCapabilities | null>(null);
  let connectionError = $state('');
  let error = $state('');
  let busy = $state(false);
  let connecting = $state(false);
  let client: WorkspaceGenerationClient | null = null;
  let folder: FileSystemDirectoryHandle | null = null;
  let generationWorkspaceId: string | null = null;
  let alive = true;
  let polling = false;
  const cancelling = new Set<string>();
  let list: HTMLDivElement;
  const active = $derived(requests.find(r => !jobs.some(j => j.request.id === r.id
    && (j.state === 'failed' || j.state === 'cancelled' || (j.state === 'completed' && attached.includes(r.id))))));
  const imageJob = $derived([...jobs].reverse().find(j => j.request.stage === 'image'
    && j.state === 'completed' && attached.includes(j.request.id)));
  let composing = $state(true);
  const available = (kind: GenerationStage) => !!capabilities?.stages.find(c => c.stage === kind)?.available;
  const reason = (kind: GenerationStage) => capabilities?.stages.find(c => c.stage === kind)?.reason ?? 'Connect the local runner first.';

  function save() {
    // Save the ID before dispatch. A reload or uncertain write retries the same job.
    localStorage.setItem(storageKey, JSON.stringify({ prompt, stage, requests, composing, generationWorkspaceId }));
  }
  function showError(e: unknown) { return e instanceof Error ? e.message : String(e); }
  async function scroll() {
    await tick();
    // On phones the sheet owns the scroll container; on desktop the conversation owns it.
    list?.lastElementChild?.scrollIntoView({ block: 'end' });
  }
  async function connect(choose = false) {
    if (connecting) return;
    connecting = true;
    connectionError = '';
    try {
      if (choose) {
        const connected = workspaceState() === 'disconnected' ? await reconnectWorkspace() : await pickWorkspace();
        if (!connected) return;
      }
      folder = workspaceHandle();
      if (!folder || workspaceState() !== 'connected') throw new Error('Connect your workspace folder to run generation locally.');
      client = new WorkspaceGenerationClient(folder);
      const caps = await client.capabilities();
      if (generationWorkspaceId && caps.workspaceId !== generationWorkspaceId && requests.length > 0) {
        client = null;
        throw new Error('Connect the original generation workspace to resume this story.');
      }
      generationWorkspaceId = caps.workspaceId;
      capabilities = caps;
      save();
      await poll();
    } catch (e) { capabilities = null; connectionError = showError(e); }
    finally { connecting = false; }
  }

  async function poll() {
    if (polling || busy || !client || !alive) return;
    polling = true;
    try {
      const currentFolder = workspaceHandle();
      if (getCurrentKbId() !== spaceId || !currentFolder || !folder
        || !(await folder.isSameEntry(currentFolder))) {
        throw new Error('The space or workspace changed. Reopen this story in the original space to continue.');
      }
      // Results remain readable after the runner stops. A stale heartbeat disables new submissions.
      let caps: GenerationCapabilities | null = null;
      try {
        caps = await client.capabilities();
        capabilities = caps;
        connectionError = '';
      }
      catch (e) { capabilities = null; connectionError = showError(e); }
      if (caps && caps.workspaceId !== generationWorkspaceId) {
        capabilities = null;
        throw new Error('The generation workspace identity changed. Reconnect the original workspace.');
      }
      for (const request of requests) {
        if (attached.includes(request.id) || jobs.some(j => j.request.id === request.id && ['failed', 'cancelled'].includes(j.state))) continue;
        let job: GenerationJob;
        try { job = await client.status(request); }
        catch (e) {
          if (!(e instanceof DOMException) || e.name !== 'NotFoundError') throw e;
          // A saved request whose submit was interrupted can be resumed with the same ID.
          await client.submit(request);
          job = { request, state: 'queued' };
        }
        if (!alive) return;
        jobs = [...jobs.filter(j => j.request.id !== request.id), job];
        if (job.state === 'completed') {
          const file = await client.result(job);
          // Cancellation can race reading a large output. Check again before attaching.
          if (!alive || (await client.status(request)).state !== 'completed' || cancelling.has(request.id)) continue;
          busy = true;
          const entity = await attachGeneration(job, file);
          if (!alive) return;
          attached = [...attached, request.id];
          if (request.stage !== 'splat') previews[request.id] = URL.createObjectURL(file);
          save();
          // Selecting automatically opens a competing details sheet on phones. Highlight the
          // result while keeping Shelly's next question reachable; Show in space selects it.
          applyShellyViewAdjust({ spotlight: [entity] });
          await scroll();
        }
      }
    } catch (e) { error = showError(e); }
    finally { polling = false; busy = false; }
  }

  async function submit(kind = stage, retry?: GenerationRequest) {
    if (busy || active || !client) return;
    busy = true;
    error = '';
    try {
      if (officialKbActive()) throw new Error('Open an editable copy of this space before generating assets.');
      const currentFolder = workspaceHandle();
      if (getCurrentKbId() !== spaceId || !folder || !currentFolder || !(await folder.isSameEntry(currentFolder))) {
        throw new Error('Return to the originating space and workspace before submitting.');
      }
      const text = retry?.prompt ?? (kind === 'splat' ? imageJob?.request.prompt : prompt.trim());
      const request = parseRequest({
        version: 1, id: crypto.randomUUID(), spaceId, stage: kind, prompt: text,
        seed: retry?.seed ?? Math.floor(Math.random() * 2147483648),
        ...(kind !== 'image' ? { parentId: retry?.parentId ?? imageJob?.request.id } : {}),
      });
      requests = [...requests, request];
      composing = false;
      save();
      await client.submit(request);
      jobs = [...jobs, { request, state: 'queued' }];
      await scroll();
    } catch (e) { error = showError(e); }
    finally { busy = false; }
  }

  async function cancel(request: GenerationRequest) {
    if (!client || busy) return;
    busy = true;
    cancelling.add(request.id);
    try {
      await client.cancel(request);
      jobs = [...jobs.filter(j => j.request.id !== request.id), { request, state: 'cancelled' }];
      error = '';
    } catch (e) { error = showError(e); }
    finally { busy = false; cancelling.delete(request.id); }
  }
  function compose(kind: GenerationStage) {
    stage = kind;
    prompt = '';
    composing = true;
    save();
    void scroll();
  }

  onMount(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      if (saved) {
        requests = saved.requests.map(parseRequest).filter((r: GenerationRequest) => r.spaceId === spaceId);
        prompt = typeof saved.prompt === 'string' ? saved.prompt : '';
        stage = saved.stage === 'video' ? 'video' : 'image';
        composing = saved.composing !== false;
        generationWorkspaceId = typeof saved.generationWorkspaceId === 'string' ? saved.generationWorkspaceId : null;
      }
    } catch { error = 'The saved story could not be restored. You can start a new image.'; }
    void connect();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
      Object.values(previews).forEach(url => URL.revokeObjectURL(url));
    };
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
      {@const job = jobs.find(j => j.request.id === request.id)}
      <div class="turn">
        <p class="user-message">{request.stage === 'image' ? request.prompt : `${STAGE_LABELS[request.stage]}: ${request.prompt}`}</p>
        <div class="result">
          <p class="status" role="status">
            {#if attached.includes(request.id)}
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
          {#if previews[request.id] && request.stage === 'image'}
            <img class="preview" src={previews[request.id]} alt={`Generated: ${request.prompt}`} onload={() => void scroll()} />
          {:else if previews[request.id] && request.stage === 'video'}
            <!-- Generated silent clips have no speech or separate caption track. -->
            <!-- svelte-ignore a11y_media_has_caption -->
            <video class="preview" src={previews[request.id]} controls aria-label="Generated video" onloadedmetadata={() => void scroll()}></video>
          {/if}
          {#if attached.includes(request.id)}
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

    {#if imageJob && !active && !composing}
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
    {#if error}<p class="error" role="alert">{error}</p><button onclick={() => { error = ''; void poll(); }}>Check again</button>{/if}
  </div>

  <div class="composer">
    {#if (composing || (!imageJob && !active)) && !active}
      <form onsubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label for="generation-prompt">{stage === 'video' ? 'How should the scene move?' : 'What image would you like?'}</label>
        <textarea id="generation-prompt" bind:value={prompt} oninput={() => queueMicrotask(save)} maxlength="2000" rows="3"
          placeholder={stage === 'video' ? 'Describe the movement or camera motion…' : 'A tiny lighthouse on a floating island, painted in watercolor…'} disabled={busy}></textarea>
        <div class="choices">
          <button class="primary" type="submit" disabled={busy || !prompt.trim() || !available(stage)}>Generate {stage}</button>
          {#if imageJob}<button type="button" onclick={() => { composing = false; save(); }}>Back to choices</button>{/if}
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
