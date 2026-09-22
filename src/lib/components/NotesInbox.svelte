<script lang="ts">
  /**
   * The Personal Notes inbox: capture verbatim, browse, then review a copy into a chosen graph.
   *
   * THIS IS A COMPONENT, NOT A PAGE, AND THAT IS THE POINT. It shipped as a second top-level
   * `notes` tab beside `add`, which gave the product TWO places to write a note — /ingest already
   * defaults to `mode = 'note'`. Matt, 2026-09-16: it "should just be an enhancement to the Add
   * tab note page". A second place to write a note is a second thing to learn and a second thing
   * to keep in step, and it works against the one thing capture has to be, which is obvious.
   *
   * The /notes route still renders this so existing deep links and the e2e smoke tests keep
   * working; it is simply no longer advertised as its own destination in the navigation.
   */
  import { onMount } from 'svelte';
  import { liveQuery } from 'dexie';
  import { KBaseDB } from '$lib/storage/db';
  import { appDb } from '$lib/storage/app-db';
  import { getRegistry, kbUrl, subscribeRegistry, type KbEntry } from '$lib/storage/kb-registry';
  import { personalNotesPolicy, savePersonalNote, allowNotesDestination, approveNoteTransfer,
    deliverApprovedNoteTransfers } from '$lib/storage/personal-notes';
  import { CAPTURED_NOTE } from '$lib/rdf/captured-notes';
  import type { NotesPolicy, NoteTransfer } from '$lib/rdf/personal-notes';
  import type { Statement } from '$lib/rdf/types';
  import { syncNotesGraphToWorkspace, workspaceState, drainAndImportPending } from '$lib/stores/workspace.svelte';

  let policy = $state<NotesPolicy | null>(null);
  let registry = $state<KbEntry[]>([]);
  let notes = $state<Statement[]>([]);
  let transfers = $state<NoteTransfer[]>([]);
  let draft = $state('');
  let query = $state('');
  let selectedIri = $state('');
  let destination = $state('');
  let transferText = $state('');
  let busy = $state(false);
  let error = $state('');
  let message = $state('');
  let loaded = $state(false);
  const selected = $derived(notes.find((note) => note.s.value === selectedIri));
  const filtered = $derived(notes.filter((note) => note.o.value.toLowerCase().includes(query.toLowerCase())));
  const destinations = $derived(registry.filter((graph) => graph.id !== policy?.inboxId && !graph.archiveOf));
  const allowed = $derived(destinations.filter((graph) => policy?.allowedGraphIds.includes(graph.id)));
  const history = $derived(transfers.filter((transfer) => transfer.noteIri === selectedIri));
  const graphName = (id: string) => registry.find((graph) => graph.id === id)?.name ?? 'Unavailable graph';

  function selectNote(note: Statement) {
    selectedIri = note.s.value;
    transferText = note.o.value;
    destination = '';
    message = '';
  }

  async function act(action: () => Promise<void>) {
    busy = true; error = ''; message = '';
    try { await action(); }
    catch (e) { error = e instanceof Error ? e.message : 'Could not save. Your text is still here.'; }
    finally { busy = false; }
  }

  async function exportGraph(id: string): Promise<string> {
    if (workspaceState() !== 'connected') return 'Saved on this browser. Link a workspace in Settings to save graph files.';
    try {
      return await syncNotesGraphToWorkspace(id)
        ? 'Saved on this browser and in your workspace.'
        : 'Saved on this browser. Workspace export is waiting for reconciliation; retry after syncing.';
    } catch { return 'Saved on this browser. Workspace export failed; retry after reconnecting.'; }
  }

  async function save() {
    await act(async () => {
      selectedIri = await savePersonalNote(draft);
      transferText = draft;
      draft = ''; destination = ''; query = '';
      message = await exportGraph(policy!.inboxId);
    });
  }

  async function send() {
    await act(async () => {
      const transfer = await approveNoteTransfer(selectedIri, destination, transferText);
      await deliverApprovedNoteTransfers();
      const receipt = await appDb.noteTransfers.get(transfer.id);
      if (receipt?.state !== 'delivered') throw new Error(receipt?.error ?? 'Approved transfer is waiting. Use Retry transfers.');
      message = `Copied to ${graphName(destination)}. ${await exportGraph(destination)}`;
    });
  }

  onMount(() => {
    let graph: KBaseDB | undefined;
    let stopped = false;
    let stopData = () => {};
    registry = getRegistry();
    const stopRegistry = subscribeRegistry((entries) => { registry = entries; });
    void (async () => {
      const initial = await personalNotesPolicy();
      if (stopped) return;
      registry = getRegistry();
      graph = new KBaseDB(initial.inboxId);
      const subscription = liveQuery(async () => ({
        policy: await appDb.notesPolicy.get('main'),
        notes: await graph!.statements.toArray(),
        transfers: await appDb.noteTransfers.where('inboxId').equals(initial.inboxId).toArray(),
      })).subscribe({ next: (data) => {
        policy = data.policy ?? initial;
        // Multiple transport deliveries are one note, independent of extraction/review status.
        const unique = new Map<string, Statement>();
        for (const note of data.notes) {
          if (note.p.value === CAPTURED_NOTE && note.o.kind === 'literal' &&
              note.status !== 'rejected' && note.status !== 'superseded') unique.set(note.s.value, note);
        }
        notes = [...unique.values()].sort((a, b) => b.createdAt - a.createdAt);
        transfers = data.transfers;
        if (!selectedIri && notes[0]) selectNote(notes[0]);
        loaded = true;
      }, error: (e) => { error = String(e); } });
      stopData = () => subscription.unsubscribe();
      await drainAndImportPending();
    })().catch((e) => { if (!stopped) error = e.message; });
    return () => { stopped = true; stopData(); stopRegistry(); graph?.close(); };
  });
</script>

<svelte:head><title>Personal Notes · Reckons.AI</title></svelte:head>

<main class="notes-page">
  <header>
    <div><p class="eyebrow">Your everyday inbox</p><h1>Personal Notes</h1>
      <p>Catch a thought. Keep the original. Decide where it goes next.</p></div>
    {#if policy}<a href={kbUrl(policy.inboxId)}>Open personal graph ↗</a>{/if}
  </header>

  <section class="capture" aria-label="Capture a personal note">
    <label for="new-note">What’s on your mind?</label>
    <textarea id="new-note" bind:value={draft} placeholder="A thought, a plan, a reminder, a bit of everything…" rows="4" maxlength="64000"></textarea>
    <div class="capture-footer"><span>Voice notes arrive here when the linked workspace is connected and the app is open.</span>
      <button class="primary" disabled={busy || !loaded || !draft.trim()} onclick={save}>Save note</button></div>
  </section>

  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#if message}<p role="status" class="message">{message}</p>{/if}

  <details class="permissions">
    <summary>Allowed graphs <span>{allowed.length}</span></summary>
    <p>Allow a destination here, then approve each transfer below. Removing permission stops further attempts; copies already saved remain. Permissions and transfer history are saved on this browser.</p>
    <div class="permission-options">
      {#each destinations as graph (graph.id)}
        <label><input type="checkbox" checked={policy?.allowedGraphIds.includes(graph.id)} disabled={busy}
          onchange={(event) => act(() => allowNotesDestination(graph.id, event.currentTarget.checked))} />{graph.name}</label>
      {/each}
    </div>
    <a href="/kb">Manage graphs ↗</a>
  </details>

  <div class="notebook">
    <section class="inbox" aria-label="Personal notes inbox">
      <div class="inbox-heading"><h2>All notes <span>{notes.length}</span></h2>
        <button disabled={busy} onclick={() => act(async () => {
          const count = await drainAndImportPending();
          message = workspaceState() === 'connected' ? `${count} new notes imported from the workspace.` : 'Link a workspace in Settings to collect voice notes.';
        })}>Check inbox</button></div>
      <label class="search">Find a note<input type="search" bind:value={query} placeholder="Search your words" /></label>
      {#if !loaded && !error}<p>Opening your notebook…</p>
      {:else if notes.length === 0}<p class="empty">Start anywhere. Your notes can stay here for as long as you need.</p>
      {:else if filtered.length === 0}<p class="empty">No notes match this search.</p>{/if}
      <div class="note-list">
        {#each filtered as note (note.id)}
          <button class="note-card" class:selected={selectedIri === note.s.value} aria-pressed={selectedIri === note.s.value}
            disabled={busy} onclick={() => selectNote(note)}>
            <time datetime={new Date(note.createdAt).toISOString()}>{new Date(note.createdAt).toLocaleString()}</time>
            <span class="note-preview">{note.o.value}</span>
          </button>
        {/each}
      </div>
    </section>

    <section class="review" aria-label="Review note transfer">
      {#if selected}
        <p class="eyebrow">Review before sending</p><h2>Give this thought a home</h2>
        <details class="original"><summary>Original note</summary><p>{selected.o.value}</p></details>
        <label for="destination">Destination graph</label>
        <select id="destination" bind:value={destination} disabled={busy}>
          <option value="">Choose an allowed graph</option>
          {#each allowed as graph (graph.id)}<option value={graph.id}>{graph.name}</option>{/each}
        </select>
        {#if allowed.length === 0}<p class="hint">Open “Allowed graphs” above to choose where reviewed notes may go.</p>{/if}
        <label for="transfer-text">Text to send</label>
        <textarea id="transfer-text" bind:value={transferText} rows="9" maxlength="64000" disabled={busy}></textarea>
        <p class="hint">Send the whole note or edit this copy to include just one part. Only this text and a link to the original will be copied. The full original stays in Personal Notes.</p>
        <button class="primary" disabled={busy || !transferText.trim() || !allowed.some((graph) => graph.id === destination)} onclick={send}>
          Approve and send copy
        </button>
        {#if history.length}
          <h3>Transfers</h3>
          <ul class="history">
            {#each history as transfer (transfer.id)}
              <li><strong>{graphName(transfer.destinationId)}</strong> · {transfer.state === 'delivered' ? 'Copied' : transfer.state === 'cancelled' ? 'Cancelled' : 'Waiting to retry'}
                <details><summary>Reviewed text</summary><p>{transfer.text}</p></details>
                {#if transfer.error}<p class="hint">{transfer.error}</p>{/if}
              </li>
            {/each}
          </ul>
        {/if}
      {:else}<p class="empty">Choose a note to review a copy for another graph.</p>{/if}
      {#if transfers.some((transfer) => transfer.state === 'approved')}
        <button disabled={busy} onclick={() => act(async () => {
          const ids = await deliverApprovedNoteTransfers();
          for (const id of ids) message = await exportGraph(id);
        })}>Retry transfers</button>
      {/if}
      {#if policy && workspaceState() === 'connected'}
        <button class="export" disabled={busy} onclick={() => act(async () => {
          const ids = new Set([policy!.inboxId, ...transfers.filter((t) => t.state === 'delivered').map((t) => t.destinationId)]);
          const results = await Promise.all([...ids].map((id) => syncNotesGraphToWorkspace(id)));
          message = results.every(Boolean) ? 'Note graphs saved in your workspace.' : 'Some graph exports are waiting. Your notes are saved on this browser.';
        })}>Save note graphs to workspace</button>
      {/if}
    </section>
  </div>
</main>

<style>
  .notes-page { max-width: 1180px; margin: 0 auto; padding: 1.6rem 1.2rem 6rem; }
  header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1.5rem; }
  h1 { font-size: clamp(1.8rem, 4vw, 2.7rem); margin: .1rem 0 .5rem; }
  h2 { font-size: 1.12rem; margin: 0 0 1rem; }
  h3 { font-size: 1rem; margin-top: 1.8rem; }
  p { line-height: 1.55; }
  .eyebrow { color: var(--accent); text-transform: uppercase; letter-spacing: .1em; font-size: .73rem; margin: 0 0 .4rem; }
  .capture, .permissions, .review { background: var(--surface); border: 1px solid var(--line); border-radius: var(--rad); padding: 1.2rem; }
  label { display: block; font-size: .86rem; margin-bottom: .5rem; }
  input[type='search'], textarea, select { width: 100%; box-sizing: border-box; background: var(--bg); color: inherit; border: 1px solid var(--line); border-radius: 8px; padding: .8rem; font: inherit; }
  textarea { resize: vertical; line-height: 1.55; }
  select { margin-bottom: 1.2rem; }
  button { cursor: pointer; min-height: 44px; padding: .6rem .85rem; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: inherit; font: inherit; }
  button:disabled { cursor: default; opacity: .5; }
  .primary { background: var(--accent); color: var(--bg); font-weight: 600; white-space: nowrap; }
  .capture-footer { display: flex; gap: 1rem; align-items: center; justify-content: space-between; margin-top: .7rem; }
  .capture-footer span, .hint, .empty { font-size: .82rem; opacity: .8; }
  .permissions { margin: 1rem 0 1.5rem; }
  summary { cursor: pointer; min-height: 32px; align-content: center; }
  .permissions p { font-size: .85rem; }
  .permission-options { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1rem 0; }
  .permission-options label { display: flex; align-items: center; gap: .5rem; min-height: 36px; }
  .notebook { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); gap: 1.4rem; align-items: start; }
  .inbox-heading { display: flex; justify-content: space-between; gap: 1rem; align-items: center; margin-bottom: .6rem; }
  .inbox-heading h2 { margin: 0; }
  h2 span, summary span { opacity: .65; font-size: .85rem; margin-left: .4rem; }
  .search input { margin-top: .4rem; }
  .note-list { display: grid; gap: .65rem; margin-top: 1rem; max-height: 750px; overflow: auto; }
  .note-card { text-align: left; padding: 1rem; min-width: 0; }
  .note-card.selected { border-color: var(--accent); box-shadow: inset 3px 0 var(--accent); }
  time { display: block; font-size: .73rem; opacity: .65; margin-bottom: .6rem; }
  .note-preview { display: -webkit-box; line-clamp: 4; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .9rem; line-height: 1.55; }
  .original { margin: 1rem 0; font-size: .9rem; }
  .original p, .history p { white-space: pre-wrap; overflow-wrap: anywhere; }
  .history { padding-left: 1.2rem; font-size: .82rem; }
  .history li { margin-bottom: 1rem; }
  .export { display: block; margin-top: 1.4rem; font-size: .82rem; }
  .error { color: var(--danger, #cc5555); }
  .message { color: var(--accent); }
  @media (max-width: 700px) {
    .notebook { grid-template-columns: 1fr; }
    .notes-page { padding: 1rem .8rem 6rem; }
    .capture-footer { flex-direction: column; align-items: stretch; }
    .note-list { max-height: 340px; }
  }
</style>
