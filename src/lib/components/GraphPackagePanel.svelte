<script lang="ts">
  /**
   * Graph-package controls for the graph menu (the "Filters & layout" panel).
   *
   * Everything here is specific to THIS graph's package — its `.ttl`, sidecar
   * files (icons / preview images / GLB models), its guided story, its
   * pod/currents view, and the local folder it syncs to. System-level render
   * settings (2D/3D fallback, label size) intentionally stay on the Settings
   * page — they're device preferences, not part of the graph.
   */
  import { db } from '$lib/storage/db';
  import { getCurrentKbName } from '$lib/storage/kb-registry';
  import { collectAssets } from '$lib/storage/kb-assets';
  import { settings } from '$lib/stores/settings.svelte';
  import { podViewEnabled, setPodViewEnabled } from '$lib/stores/pod-view.svelte';
  import {
    workspaceName, workspaceState, supportsWorkspace,
    pickWorkspace, reconnectWorkspace, clearWorkspace,
    resyncNow, syncAllKbs, autoSyncEnabled, setAutoSync,
    lastSyncTime, syncedKbCount, importKbsFromWorkspace, listKbFolders,
  } from '$lib/stores/workspace.svelte';
  import {
    driveConfigured, driveLinked, driveFolderName, driveBusy,
    linkDriveFolder, unlinkDrive, driveResyncNow, driveLastSync,
    driveAutoSync, setDriveAutoSync,
  } from '$lib/stores/drive-sync.svelte';

  // Re-count sidecar assets whenever the graph changes.
  let { statementCount = 0 }: { statementCount?: number } = $props();
  let assetCounts = $state<{ icons: number; previews: number; models: number }>({ icons: 0, previews: 0, models: 0 });

  async function refreshAssetCounts() {
    try {
      const assets = await collectAssets(db);
      assetCounts = {
        icons: assets.filter(a => a.category === 'icons').length,
        previews: assets.filter(a => a.category === 'previews').length,
        models: assets.filter(a => a.category === 'models').length,
      };
    } catch { /* best-effort */ }
  }
  // Recount on mount and when the statement count shifts (assets ride with edits).
  $effect(() => { void statementCount; refreshAssetCounts(); });

  const storySteps = $derived(settings().kbStory?.length ?? 0);
  let pod = $state(podViewEnabled());
  function togglePod() { pod = !pod; setPodViewEnabled(pod); }

  // ── Folder sync actions ────────────────────────────────────────────────────
  let busy = $state(false);
  let msg = $state('');
  let auto = $state(autoSyncEnabled());

  function flash(text: string) { msg = text; setTimeout(() => { if (msg === text) msg = ''; }, 5000); }

  async function link() {
    busy = true;
    const ok = await pickWorkspace();
    if (ok) {
      // Existing graphs in the folder are imported; an empty folder is seeded.
      const folders = await listKbFolders();
      if (folders.length > 0) {
        const { imported } = await importKbsFromWorkspace();
        flash(imported.length ? `imported ${imported.length} graph(s)` : `${folders.length} graph(s) linked`);
      } else {
        const n = await syncAllKbs();
        flash(`synced ${n} graph${n !== 1 ? 's' : ''} to folder`);
      }
    }
    busy = false;
  }

  async function reconnect() {
    busy = true;
    const ok = await reconnectWorkspace();
    if (ok) { await importKbsFromWorkspace(); flash('reconnected'); }
    busy = false;
  }

  async function resync() {
    busy = true;
    const r = await resyncNow();
    const pulled = r.imported.length + r.updated.length;
    flash(pulled ? `pulled ${pulled}, pushed ${r.pushed}` : `pushed ${r.pushed} graph${r.pushed !== 1 ? 's' : ''}`);
    busy = false;
  }

  function toggleAuto() { auto = !auto; setAutoSync(auto); }

  // ── Google Drive folder sync (F56) ─────────────────────────────────────────
  async function linkDrive() {
    busy = true;
    const ok = await linkDriveFolder();
    if (ok) { const r = await driveResyncNow(); flash(`Drive: pulled ${r.imported.length + r.updated.length}, pushed ${r.pushed}`); }
    else flash('Drive link failed — check Google sign-in');
    busy = false;
  }
  async function driveResync() {
    busy = true;
    const r = await driveResyncNow();
    const pulled = r.imported.length + r.updated.length;
    flash(pulled ? `Drive: pulled ${pulled}, pushed ${r.pushed}` : `Drive: pushed ${r.pushed}`);
    busy = false;
  }

  function ago(t: number | null): string {
    if (!t) return 'never';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  }
</script>

<!-- THIS GRAPH'S PACKAGE -->
<div class="overlay-group">
  <span class="group-label mono">graph package · {getCurrentKbName()}</span>
  <div class="pkg-row mono">
    <span class="pkg-stat" title="2D node icons">◇ {assetCounts.icons} icons</span>
    <span class="pkg-stat" title="hover preview images">▣ {assetCounts.previews} previews</span>
    <span class="pkg-stat" title="3D GLB models">◈ {assetCounts.models} models</span>
    <a class="pkg-stat pkg-link" href="/kb" title="edit the guided story">▸ {storySteps} story · edit →</a>
  </div>
</div>

<!-- POD / CURRENTS -->
<div class="overlay-group">
  <span class="group-label mono">currents</span>
  <div class="chip-row">
    <button class="pkg-chip" class:active={pod} onclick={togglePod}>🐋 pod view {pod ? 'on' : 'off'}</button>
    <a class="pkg-chip pkg-link" href="/kb">edit currents →</a>
  </div>
</div>

<!-- FOLDER SYNC -->
<div class="overlay-group">
  <span class="group-label mono">folder sync</span>
  {#if !supportsWorkspace()}
    <span class="pkg-note mono">not supported in this browser</span>
  {:else if workspaceState() === 'connected'}
    <div class="pkg-row mono">
      <span class="pkg-stat pkg-ok" title="linked folder">📁 {workspaceName()}/</span>
      <button class="pkg-chip" disabled={busy} onclick={clearWorkspace}>unlink</button>
    </div>
    <div class="chip-row">
      <button class="pkg-chip" disabled={busy} onclick={resync}>⟳ resync now</button>
      <button class="pkg-chip" class:active={auto} onclick={toggleAuto} title="poll the folder for external changes">
        auto-sync {auto ? 'on' : 'off'}
      </button>
    </div>
    <span class="pkg-note mono">
      {syncedKbCount() > 0 ? `${syncedKbCount()} graph${syncedKbCount() !== 1 ? 's' : ''}` : 'no graphs yet'} · synced {ago(lastSyncTime())}
    </span>
  {:else if workspaceState() === 'disconnected'}
    <div class="pkg-row mono">
      <span class="pkg-stat pkg-warn" title="permission lapsed this session">📁 {workspaceName()}/ (disconnected)</span>
      <button class="pkg-chip" disabled={busy} onclick={reconnect}>reconnect</button>
    </div>
  {:else}
    <button class="pkg-chip pkg-cta" disabled={busy} onclick={link}>📁 link a folder</button>
    <span class="pkg-note mono">back up every graph to disk · survives cache clears</span>
  {/if}

  <!-- Google Drive (cloud) folder sync (F56) -->
  {#if driveConfigured()}
    {#if driveLinked()}
      <div class="pkg-row mono">
        <span class="pkg-stat pkg-ok" title="linked Google Drive folder">☁ {driveFolderName()}/</span>
        <button class="pkg-chip" disabled={busy || driveBusy()} onclick={driveResync}>⟳ resync</button>
        <button class="pkg-chip" disabled={busy || driveBusy()} onclick={unlinkDrive}>unlink</button>
      </div>
      <div class="chip-row">
        <button
          class="pkg-chip"
          class:active={driveAutoSync()}
          onclick={() => setDriveAutoSync(!driveAutoSync())}
          title="auto-push on edit + poll Drive for changes"
        >auto-sync {driveAutoSync() ? 'on' : 'off'}</button>
      </div>
      <span class="pkg-note mono">Drive · synced {ago(driveLastSync())}</span>
    {:else}
      <button class="pkg-chip" disabled={busy || driveBusy()} onclick={linkDrive}>☁ sync to Google Drive</button>
    {/if}
  {:else}
    <a class="pkg-note pkg-link mono" href="/settings/integrations">☁ set a Google client ID to sync to Drive →</a>
  {/if}
  {#if msg}<span class="pkg-note pkg-msg mono">{msg}</span>{/if}
</div>

<style>
  .pkg-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem 0.6rem;
    font-size: 0.68rem;
    color: var(--muted);
  }
  .pkg-stat { white-space: nowrap; }
  .pkg-ok { color: var(--accent); }
  .pkg-warn { color: #d9a441; }
  .pkg-link { color: var(--muted); text-decoration: none; }
  .pkg-link:hover { color: var(--accent); }

  .pkg-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.28rem 0.6rem;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.68rem;
    cursor: pointer;
    text-decoration: none;
    transition: all 0.15s;
  }
  .pkg-chip:hover { border-color: var(--muted-2); color: var(--ink); }
  .pkg-chip.active { border-color: var(--accent); color: var(--accent); }
  .pkg-chip:disabled { opacity: 0.5; cursor: default; }
  .pkg-cta { border-color: var(--accent); color: var(--accent); }

  .pkg-note {
    font-size: 0.6rem;
    color: var(--muted);
    opacity: 0.75;
    padding: 0 0.1rem;
  }
  .pkg-msg { color: var(--accent); opacity: 1; }
</style>
