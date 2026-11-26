<script lang="ts">
  /**
   * Guided connect popup for the local generation runner (F166.1.3). Opened from RunnerConnect's
   * button, so it works wherever that control appears. Three steps with live state: start the
   * runner, choose the workspace folder, check. It reuses the shared store (connectJobs) and never
   * starts anything itself. Dialog on desktop, the existing bottom Sheet on a phone.
   */
  import { untrack } from 'svelte';
  import { Dialog } from 'bits-ui';
  import Sheet from '$lib/components/Sheet.svelte';
  import { isMobile } from '$lib/stores/viewport.svelte';
  import { supportsWorkspace, workspaceState } from '$lib/stores/workspace.svelte';
  import { connectJobs, useGenerationJobs, generationJobs as gen } from '$lib/stores/generation-jobs.svelte';
  import { connectView, serviceLines, RUNNER_COMMAND } from '$lib/generation/connect-steps';
  import { probeBridge, startRunner, WORKSPACE_PATH_KEY, type BridgeState } from '$lib/generation/runner-bridge';

  let { open = $bindable(false) }: { open?: boolean } = $props();
  let copied = $state(false);
  let justConnected = $state(false);
  let bridge = $state<BridgeState>({ available: false, running: false });
  let folderPath = $state('');
  let startError = $state('');
  let starting = $state(false);
  try { folderPath = localStorage.getItem(WORKSPACE_PATH_KEY) ?? ''; } catch { /* storage blocked: the person types it */ }

  const view = $derived(connectView({
    supported: supportsWorkspace(), workspace: workspaceState(), connecting: gen.connecting,
    runnerReady: !!gen.capabilities, services: gen.capabilities?.stages, error: gen.connectionError, bridge,
  }));

  // While open, ask the dev-server bridge whether it can start the runner and whether one is running.
  $effect(() => {
    if (!open) return;
    let alive = true;
    const look = async () => { const b = await probeBridge(); if (alive) bridge = b; };
    void look();
    const t = setInterval(look, 2500);
    return () => { alive = false; clearInterval(t); };
  });
  async function start() {
    starting = true; startError = '';
    try { localStorage.setItem(WORKSPACE_PATH_KEY, folderPath.trim()); } catch { /* fine */ }
    startError = await startRunner(folderPath.trim());
    bridge = await probeBridge();
    starting = false;
  }
  // Poll while the popup is open so the heartbeat shows up without a click.
  $effect(() => { if (!open) return; return untrack(() => useGenerationJobs()); });
  // Close itself once connected, after a short confirmation. Only if it was open when that happened.
  $effect(() => {
    if (!open || status !== 'connected') return;
    justConnected = true;
    const t = setTimeout(() => { open = false; justConnected = false; }, untrack(() => lines.some(l => !l.installed)) ? 4000 : 1800);
    return () => clearTimeout(t);
  });
  $effect(() => { if (!open) { justConnected = false; copied = false; } });

  async function copy() {
    try { await navigator.clipboard.writeText(RUNNER_COMMAND); copied = true; setTimeout(() => (copied = false), 2000); } catch { copied = false; }
  }
  // A primitive, so a fresh heartbeat object every two seconds does not restart the close timer.
  const status = $derived(view.status);
  const lines = $derived(serviceLines(gen.capabilities?.stages));
  const mark = (s: string) => (s === 'done' ? 'done' : s === 'active' ? 'now' : 'next');
</script>

{#snippet body()}
  <p class="rc-lead">Generation runs on your own computer. Nothing starts until you do these steps.</p>
  <ol class="rc-steps">
    <li data-step="start" data-step-state={view.steps.start}>
      <h3><span class="rc-mark">{mark(view.steps.start)}</span> 1. Start the agent watcher</h3>
      {#if view.start === 'running'}
        <p>The agent watcher is running. It starts each generation service only when a request needs it, and stops it again when idle.</p>
      {:else if view.start === 'button'}
        <p>This computer can start it for you. It serves <code class="rc-inline">~/Documents/reckons-assets</code> unless you add another folder below.</p>
        <div class="rc-cmd"><input class="rc-input" bind:value={folderPath} placeholder="Another folder, full path (optional)" aria-label="Another generation folder, full path (optional)" />
          <button class="rc-btn rc-primary" onclick={start} disabled={starting}>Start the agent watcher</button></div>
        {#if startError}<p class="rc-small" role="alert">{startError}</p>{/if}
      {:else}
        <p>This page cannot start programs, so start the agent watcher once on this computer. In a terminal in the Reckons.AI folder run:</p>
        <div class="rc-cmd"><code>{RUNNER_COMMAND}</code>
          <button class="rc-btn" onclick={copy} aria-label="Copy the command">{copied ? 'Copied' : 'Copy'}</button></div>
        <p class="rc-small">It serves <code class="rc-inline">~/Documents/reckons-assets</code>, so choose that folder in step 2. For another folder, list it under "folders" in <code class="rc-inline">~/.config/reckons/generation-folders.json</code> and restart it.</p>
      {/if}
      <p class="rc-small"><a href="/docs/features/generation-setup" target="_blank" rel="noopener noreferrer">Setup for your operating system</a> · <a href="/settings/device" onclick={() => (open = false)}>Open the device page</a></p>
    </li>
    <li data-step="folder" data-step-state={view.steps.folder}>
      <h3><span class="rc-mark">{mark(view.steps.folder)}</span> 2. Choose the workspace folder</h3>
      {#if view.status === 'unsupported'}
        <p class="rc-small">{view.message} {view.fix}</p>
      {:else if view.steps.folder === 'done'}
        <p>Folder chosen.</p>
      {:else}
        <button class="rc-btn rc-primary" onclick={() => connectJobs(true)} disabled={gen.connecting}>Choose workspace folder</button>
      {/if}
    </li>
    <li data-step="check" data-step-state={view.steps.check}>
      <h3><span class="rc-mark">{mark(view.steps.check)}</span> 3. Check</h3>
      <p class="rc-status" role="status" data-connect-status={view.status}>
        {#if justConnected}Connected{:else if view.steps.folder === 'todo' || view.status === 'need-folder' || view.status === 'unsupported'}Waiting for steps 1 and 2.{:else}{view.message}{/if}
      </p>
      {#if lines.length}
        <ul class="rc-services" aria-label="Generation services">
          {#each lines as l (l.stage)}
            <li data-service={l.stage} data-installed={l.installed}>{l.label}: {l.text}{#if !l.installed} — <a href="/docs/features/generation-setup" target="_blank" rel="noopener noreferrer">Install</a>{/if}</li>
          {/each}
        </ul>
      {/if}
      {#if view.fix && (view.status === 'waiting' || view.status === 'failed' || view.status === 'needs-install')}<p class="rc-small">{view.fix}</p>{/if}
      {#if view.steps.folder === 'done' && view.status !== 'connected'}
        <button class="rc-btn" onclick={() => connectJobs(false)} disabled={gen.connecting}>Check again</button>
      {/if}
    </li>
  </ol>
{/snippet}

{#if isMobile()}
  <Sheet bind:open title="Connect the local generation runner" zIndex={600}>
    <div class="rc-body">{@render body()}</div>
  </Sheet>
{:else}
  <Dialog.Root bind:open>
    <Dialog.Portal>
      <Dialog.Overlay class="rc-overlay" />
      <Dialog.Content class="rc-dialog">
        <Dialog.Title class="rc-title">Connect the local generation runner</Dialog.Title>
        <Dialog.Description class="rc-sr">Three steps: start the runner, choose its folder, check.</Dialog.Description>
        {@render body()}
        <Dialog.Close class="rc-btn rc-close">Close</Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
{/if}

<style>
  :global(.rc-overlay) { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 600; backdrop-filter: blur(2px); }
  :global(.rc-dialog) { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 601; width: calc(100vw - 2rem); max-width: 520px; max-height: calc(100vh - 3rem); overflow-y: auto; background: var(--surface); border: 1px solid var(--line); border-radius: var(--rad-md, 10px); padding: 1.1rem 1.25rem; color: var(--text); font-size: 0.85rem; }
  :global(.rc-title) { font-family: var(--font-mono); font-size: 0.85rem; color: var(--accent); text-transform: uppercase; margin: 0 0 0.5rem; }
  :global(.rc-sr) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  :global(.rc-btn) { padding: 0.25rem 0.6rem; font-size: 0.75rem; border: 1px solid var(--line, currentColor); border-radius: 0.4rem; background: var(--surface-2, transparent); color: inherit; cursor: pointer; font-family: inherit; }
  :global(.rc-btn:disabled) { opacity: 0.5; cursor: default; }
  :global(.rc-primary) { border-color: var(--accent); color: var(--accent); }
  :global(.rc-close) { margin-top: 0.75rem; }
  .rc-body { padding: 0 1rem 1rem; font-size: 0.85rem; }
  .rc-lead { margin: 0 0 0.6rem; color: var(--text-muted, var(--muted)); }
  .rc-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.7rem; }
  .rc-steps li { border-left: 2px solid var(--line); padding-left: 0.7rem; }
  .rc-steps li[data-step-state='active'] { border-left-color: var(--accent); }
  .rc-steps li[data-step-state='done'] { border-left-color: var(--accent); opacity: 0.8; }
  h3 { margin: 0 0 0.25rem; font-size: 0.82rem; }
  p { margin: 0.2rem 0; line-height: 1.4; }
  .rc-mark { font-family: var(--font-mono); font-size: 0.65rem; color: var(--accent); text-transform: uppercase; margin-right: 0.3rem; }
  .rc-services { margin: 0.3rem 0; padding-left: 1.1rem; font-size: 0.78rem; }
  .rc-inline { display: inline; padding: 0; background: none; }
  .rc-small { font-size: 0.75rem; color: var(--text-muted, var(--muted)); }
  .rc-input { flex: 1; min-width: 0; font: 0.75rem var(--font-mono); padding: 0.25rem 0.4rem; background: var(--surface-2, transparent); color: inherit; border: 1px solid var(--line); border-radius: 0.3rem; }
  .rc-cmd { display: flex; gap: 0.4rem; align-items: flex-start; }
  code { flex: 1; font: 0.72rem var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface-2, transparent); padding: 0.3rem 0.4rem; border-radius: 0.3rem; }
  .rc-status { font-family: var(--font-mono); font-size: 0.75rem; color: var(--accent); }
</style>
