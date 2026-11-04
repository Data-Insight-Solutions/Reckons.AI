<script lang="ts">
  /**
   * The space's background controls (F58.9.3, F58.9.7): bring in a scanned room from this device,
   * see what the background is, and clear it. Lives in the Graphs tab beside the share package; the
   * space's 3D graph draws it. Nothing leaves the device: the file goes into this browser's storage.
   */
  import { statements } from '$lib/stores/kb.svelte';
  import { importScan, setMeta } from '$lib/stores/space-room';
  import { backgroundSplatFrom, splatOriginOf, SPACE_SUBJECT, BACKGROUND_SPLAT_PREDICATE, type SplatOrigin } from '$lib/3d/splat';
  import BackgroundSettingsControls from './BackgroundSettingsControls.svelte';

  const background = $derived(backgroundSplatFrom(statements()));
  const origin = $derived(background ? splatOriginOf(statements(), background) : null);

  let picker: HTMLInputElement | undefined = $state();
  let kind = $state<SplatOrigin>('reconstructed');
  let busy = $state(false);
  let problems = $state<string[]>([]);
  let done = $state('');
  let warnings = $state<string[]>([]);

  async function onpick(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    busy = true; problems = []; done = ''; warnings = [];
    try {
      const res = await importScan(file, kind);
      if (res.ok) {
        done = `${Number(res.check.measured.count ?? 0).toLocaleString()} Gaussians, ${(res.size / 1048576).toFixed(1)} MB, now the background${res.alreadyHad ? ' (this file was already here)' : ''}`;
        warnings = res.warnings;
      }
      else problems = res.problems;
    } catch (err) {
      problems = [(err as Error).message];
    } finally {
      busy = false;
    }
  }
  const clear = () => setMeta(SPACE_SUBJECT, BACKGROUND_SPLAT_PREDICATE, '');
</script>

<div class="overlay-group" data-testid="space-background">
  <span class="group-label mono">space background</span>
  <div class="chip-row">
    <button class="pkg-chip pkg-cta" disabled={busy} onclick={() => picker?.click()} data-testid="import-scan">⬆ Import a scan</button>
    <select class="pkg-chip" bind:value={kind} aria-label="What this file is" title="A reconstructed splat records a real place; a generated one is invented by a model">
      <option value="reconstructed">reconstructed (a real place)</option>
      <option value="generated">generated (invented)</option>
    </select>
    {#if background}<button class="pkg-chip" onclick={clear} data-testid="clear-background">Clear background</button>{/if}
    <input bind:this={picker} type="file" accept=".ply,.spz,.sog" hidden onchange={onpick} data-testid="import-scan-input" />
  </div>
  {#if busy}<span class="pkg-note mono">checking the file…</span>{/if}
  {#if problems.length}
    <div class="pkg-problems mono" role="alert" data-testid="import-scan-refused">
      <strong>Not imported.</strong>
      <ul>{#each problems as p}<li>{p}</li>{/each}</ul>
    </div>
  {/if}
  {#each warnings as w}<span class="pkg-note mono" style="color:#d9a441;opacity:1" role="alert" data-testid="import-scan-warning">{w}</span>{/each}
  {#if done}<span class="pkg-note pkg-msg mono" role="status">{done}</span>{/if}
  <BackgroundSettingsControls />
  <span class="pkg-note mono">
    {#if background}background: {background.startsWith('asset:splat/') ? 'a scan stored in this browser' : background}{origin ? ` · ${origin}` : ''}
    {:else}.ply, .spz or .sog, checked before it is kept. It stays in this browser and travels with an export of the space.{/if}
  </span>
</div>

<style>
  .chip-row { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
  .pkg-chip {
    display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.28rem 0.6rem; border-radius: 999px;
    border: 1px solid var(--line); background: var(--surface); color: var(--muted);
    font-family: var(--font-mono); font-size: 0.68rem; cursor: pointer; transition: all 0.15s;
  }
  .pkg-chip:hover { border-color: var(--muted-2); color: var(--ink); }
  .pkg-chip:disabled { opacity: 0.5; cursor: default; }
  .pkg-cta { border-color: var(--accent); color: var(--accent); }
  .pkg-note { font-size: 0.6rem; color: var(--muted); opacity: 0.75; padding: 0 0.1rem; }
  .pkg-msg { color: var(--accent); opacity: 1; }
  .pkg-problems { font-size: 0.68rem; color: #d9a441; border: 1px solid #d9a441; border-radius: 6px; padding: 0.4rem 0.6rem; }
  .pkg-problems ul { margin: 0.2rem 0 0 1rem; padding: 0; }
</style>
