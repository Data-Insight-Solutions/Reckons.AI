<script lang="ts">
  /**
   * The space's background controls (F58.9.3, F58.9.7): bring in a scanned room from this device,
   * see what the background is, and clear it. Lives in the Graphs tab beside the share package; the
   * space's 3D graph draws it. Nothing leaves the device: the file goes into this browser's storage.
   */
  import { statements } from '$lib/stores/kb.svelte';
  import { importScan, setMeta } from '$lib/stores/space-room';
  import {
    backgroundSplatFrom, splatOriginOf, splatOrientationFor, SPACE_SUBJECT, BACKGROUND_SPLAT_PREDICATE, type SplatOrigin,
    backgroundSettingsFrom, BACKGROUND_DEFAULTS, UP_AXES, upAxisQuaternion, fitFloor, levelQuaternion, rotatePoints, qMul, TRIPOSPLAT_BASE,
    BG_MODE_PREDICATE, BG_UP_PREDICATE, BG_YAW_PREDICATE, BG_LEVEL_PREDICATE, BG_SCALE_PREDICATE, BG_OFFSET_PREDICATE, BG_OPACITY_PREDICATE, BG_FLOOR_PREDICATE,
  } from '$lib/3d/splat';
  import { plyCentresFromSource, blobSource } from '$lib/3d/splat-check';
  import { readSplatFile } from '$lib/storage/splat-files';

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

  // ── Settings (F58.9.8): meta triples on the space, never edges ──
  const bg = $derived(backgroundSettingsFrom(statements()));
  const put = (pred: string, v: string | number) => setMeta(SPACE_SUBJECT, pred, String(v));
  const num = (e: Event) => Number((e.target as HTMLInputElement).value);
  const putOffset = (axis: 0 | 1 | 2, e: Event) => {
    const o = [...bg.offset]; const v = num(e); o[axis] = Number.isFinite(v) ? v : 0;
    return put(BG_OFFSET_PREDICATE, o.join(' '));
  };
  const resetSettings = async () => {
    for (const p of [BG_MODE_PREDICATE, BG_UP_PREDICATE, BG_YAW_PREDICATE, BG_LEVEL_PREDICATE, BG_SCALE_PREDICATE, BG_OFFSET_PREDICATE, BG_OPACITY_PREDICATE, BG_FLOOR_PREDICATE]) await setMeta(SPACE_SUBJECT, p, '');
    levelMsg = '';
  };

  let levelMsg = $state('');
  /** Fit the dominant horizontal plane to the splat's Gaussian centres and store the tilt to remove. */
  async function levelFloor() {
    if (!background) return;
    levelMsg = 'fitting…';
    try {
      let blob: Blob | null = null;
      if (background.startsWith('asset:splat/')) blob = (await readSplatFile(background))?.blob ?? null;
      else if (/\.ply(\?|#|$)/i.test(background)) blob = await (await fetch(background)).blob();
      if (!blob || background.endsWith('.spz')) { levelMsg = 'Level the floor reads PLY files; this background is not one it can read here.'; return; }
      const centres = await plyCentresFromSource(blobSource(blob));
      let q = upAxisQuaternion(bg.up);
      if (splatOrientationFor(statements(), background) === 'triposplat') q = qMul(q, TRIPOSPLAT_BASE);
      // The room turns about its bounding-box centre, so fit in that frame: then the plane's offset
      // IS the floor height above the room's centre.
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < centres.length; i++) { const k = i % 3; if (centres[i] < lo[k]) lo[k] = centres[i]; if (centres[i] > hi[k]) hi[k] = centres[i]; }
      const centred = Float32Array.from(centres, (v, i) => v - (lo[i % 3] + hi[i % 3]) / 2);
      const fit = fitFloor(rotatePoints(centred, q));
      if (!fit) { levelMsg = 'No flat horizontal surface holds a tenth of the sampled points, so nothing was changed. Check the up axis first.'; return; }
      const lq = levelQuaternion(fit);
      await put(BG_LEVEL_PREDICATE, lq.map((x) => x.toFixed(6)).join(' '));
      // A plane above the room's middle is the ceiling, not the floor: levelling is the same, but it is no floor to stand things on.
      const isFloor = fit.offset < 0;
      await put(BG_FLOOR_PREDICATE, isFloor ? fit.offset.toFixed(4) : '');
      levelMsg = `Removed a ${fit.tiltDeg.toFixed(1)}° tilt; ${(fit.fraction * 100).toFixed(0)}% of ${(centres.length / 3).toLocaleString()} sampled points lie on that plane.`
        + (isFloor ? ' Floor height set.' : ' That plane is above the room\'s middle (a ceiling?), so no floor height was set.');
    } catch (e) {
      levelMsg = `Could not fit: ${(e as Error).message}`;
    }
  }
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
    <input bind:this={picker} type="file" accept=".ply,.spz" hidden onchange={onpick} data-testid="import-scan-input" />
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
  {#if background}
    <div class="settings mono" data-testid="background-settings">
      <div class="chip-row" role="group" aria-label="Background mode">
        <button class="pkg-chip" class:active={bg.mode === 'backdrop'} onclick={() => put(BG_MODE_PREDICATE, 'backdrop')} title="A dimmed scene behind the graph, sized to it">backdrop</button>
        <button class="pkg-chip" class:active={bg.mode === 'surround'} onclick={() => put(BG_MODE_PREDICATE, 'surround')} title="The graph sits inside the room, which keeps its own scale">surround</button>
      </div>
      <label>up axis
        <select class="pkg-chip" value={bg.up} onchange={(e) => put(BG_UP_PREDICATE, (e.target as HTMLSelectElement).value)} title="Which of the file's axes points up. Scans from COLMAP-based tools usually point down (−y).">
          {#each UP_AXES as a}<option value={a}>{a.replace('-', '−')}</option>{/each}
        </select>
      </label>
      <label>yaw {bg.yaw}°
        <input type="range" min="-180" max="180" step="5" value={bg.yaw} onchange={(e) => put(BG_YAW_PREDICATE, num(e))} />
      </label>
      <label>scale
        <input type="number" min="0.001" step="0.1" value={bg.scale} onchange={(e) => put(BG_SCALE_PREDICATE, num(e))}
          title={bg.mode === 'surround' ? 'World units per file unit. A scan has no true size until you set one.' : 'Multiplier on the automatic size'} />
      </label>
      <label>opacity {Math.round(bg.opacity * 100)}%
        <input type="range" min="0" max="1" step="0.05" value={bg.opacity} onchange={(e) => put(BG_OPACITY_PREDICATE, num(e))} />
      </label>
      <label>offset
        {#each [0, 1, 2] as k}<input type="number" step="0.5" value={bg.offset[k]} onchange={(e) => putOffset(k as 0 | 1 | 2, e)} aria-label={'offset ' + 'xyz'[k]} />{/each}
      </label>
      <div class="chip-row">
        <button class="pkg-chip" onclick={levelFloor} data-testid="level-floor" title="Fit the dominant horizontal plane to the scan and remove its tilt">Level the floor</button>
        {#if bg.level}<button class="pkg-chip" onclick={async () => { await put(BG_LEVEL_PREDICATE, ''); await put(BG_FLOOR_PREDICATE, ''); }}>remove levelling</button>{/if}
        <button class="pkg-chip" onclick={resetSettings}>reset settings</button>
      </div>
      {#if levelMsg}<span class="pkg-note pkg-msg mono" role="status">{levelMsg}</span>{/if}
    </div>
  {/if}
  <span class="pkg-note mono">
    {#if background}background: {background.startsWith('asset:splat/') ? 'a scan stored in this browser' : background}{origin ? ` · ${origin}` : ''}
    {:else}.ply or .spz, checked before it is kept. It stays in this browser and travels with an export of the space.{/if}
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
  .pkg-chip.active { border-color: var(--accent); color: var(--accent); }
  .settings { display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.68rem; color: var(--muted); margin-top: 0.3rem; }
  .settings label { display: flex; align-items: center; gap: 0.5rem; }
  .settings input[type='number'] { width: 4.5rem; background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 4px; padding: 0.15rem 0.3rem; font-family: var(--font-mono); font-size: 0.68rem; }
  .pkg-note { font-size: 0.6rem; color: var(--muted); opacity: 0.75; padding: 0 0.1rem; }
  .pkg-msg { color: var(--accent); opacity: 1; }
  .pkg-problems { font-size: 0.68rem; color: #d9a441; border: 1px solid #d9a441; border-radius: 6px; padding: 0.4rem 0.6rem; }
  .pkg-problems ul { margin: 0.2rem 0 0 1rem; padding: 0; }
</style>
