<script lang="ts">
  /**
   * The space background's settings (F58.9.8, F58.9.16): backdrop or surround, scale, yaw, opacity, up
   * axis, offset, Level the floor and Set focal point. One component, shown in the Graphs tab beside
   * the import button and in the graph view's View settings panel, so the two cannot drift apart.
   * Settings are meta triples on the space, never edges. Renders nothing when there is no background.
   */
  import { onDestroy } from 'svelte';
  import { statements } from '$lib/stores/kb.svelte';
  import { setMeta } from '$lib/stores/space-room';
  import {
    backgroundSplatFrom, splatOrientationFor, SPACE_SUBJECT,
    backgroundSettingsFrom, UP_AXES, upAxisQuaternion, fitFloor, levelQuaternion, rotatePoints, qMul, TRIPOSPLAT_BASE,
    BG_MODE_PREDICATE, BG_UP_PREDICATE, BG_YAW_PREDICATE, BG_LEVEL_PREDICATE, BG_SCALE_PREDICATE, BG_OFFSET_PREDICATE,
    BG_OPACITY_PREDICATE, BG_FLOOR_PREDICATE, BG_FOCAL_PREDICATE, type Vec3,
  } from '$lib/3d/splat';
  import { plyCentresFromSource, blobSource } from '$lib/3d/splat-check';
  import { readSplatFile } from '$lib/storage/splat-files';
  import { roomView, focalPick } from '$lib/3d/room-view';
  import { scaleFromSlider, sliderFromScale, rayToRoomLocal, pickOnRay, formatFocal } from '$lib/3d/room-focus';

  const background = $derived(backgroundSplatFrom(statements()));
  const bg = $derived(backgroundSettingsFrom(statements()));
  const put = (pred: string, v: string | number) => setMeta(SPACE_SUBJECT, pred, String(v));
  const num = (e: Event) => Number((e.target as HTMLInputElement).value);
  const putOffset = (axis: 0 | 1 | 2, e: Event) => {
    const o = [...bg.offset]; const v = num(e); o[axis] = Number.isFinite(v) ? v : 0;
    return put(BG_OFFSET_PREDICATE, o.join(' '));
  };
  const focalIsSet = $derived(bg.focal.some((x) => x !== 0));

  let msg = $state('');
  const resetSettings = async () => {
    for (const p of [BG_MODE_PREDICATE, BG_UP_PREDICATE, BG_YAW_PREDICATE, BG_LEVEL_PREDICATE, BG_SCALE_PREDICATE, BG_OFFSET_PREDICATE, BG_OPACITY_PREDICATE, BG_FLOOR_PREDICATE, BG_FOCAL_PREDICATE]) await setMeta(SPACE_SUBJECT, p, '');
    msg = '';
  };

  /**
   * The splat's sampled Gaussian centres, turned by the up axis (and the TripoSplat correction) and,
   * when `levelled`, by the stored levelling too; relative to the bounding-box centre, which is the
   * point the room turns about.
   */
  async function sampledCentres(levelled: boolean): Promise<{ centres: Float32Array; q: ReturnType<typeof upAxisQuaternion> } | string> {
    if (!background) return 'There is no background to read.';
    let blob: Blob | null = null;
    if (background.startsWith('asset:splat/')) blob = (await readSplatFile(background))?.blob ?? null;
    else if (/\.(ply|spz|sog)(\?|#|$)/i.test(background)) blob = await (await fetch(background)).blob();
    if (!blob) return 'This background could not be read here.';
    const bgKind = /\.(spz|sog)(\?|#|$)/i.exec(background)?.[1].toLowerCase();
    // PLY is read in chunks; SPZ and SOG are decoded by the renderer's decoder (the same one that draws them).
    const centres = bgKind ? await (await import('$lib/3d/splat-decode')).sampleCentres(blob, bgKind as 'spz' | 'sog') : await plyCentresFromSource(blobSource(blob));
    let q = upAxisQuaternion(bg.up);
    if (splatOrientationFor(statements(), background) === 'triposplat') q = qMul(q, TRIPOSPLAT_BASE);
    if (levelled && bg.level) q = qMul(bg.level, q);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < centres.length; i++) { const k = i % 3; if (centres[i] < lo[k]) lo[k] = centres[i]; if (centres[i] > hi[k]) hi[k] = centres[i]; }
    const centred = Float32Array.from(centres, (v, i) => v - (lo[i % 3] + hi[i % 3]) / 2);
    return { centres: rotatePoints(centred, q), q };
  }

  /** Fit the dominant horizontal plane to the splat's Gaussian centres and store the tilt to remove. */
  async function levelFloor() {
    msg = 'fitting…';
    try {
      // Fit in the un-levelled frame (the room turns about its bounding-box centre), so the plane's
      // offset IS the floor height above the room's centre.
      const got = await sampledCentres(false);
      if (typeof got === 'string') { msg = got.replace('could not be read here', 'could not be read here for levelling'); return; }
      const fit = fitFloor(got.centres);
      if (!fit) { msg = 'No flat horizontal surface holds a tenth of the sampled points, so nothing was changed. Check the up axis first.'; return; }
      const lq = levelQuaternion(fit);
      await put(BG_LEVEL_PREDICATE, lq.map((x) => x.toFixed(6)).join(' '));
      // A plane above the room's middle is the ceiling, not the floor: levelling is the same, but it is no floor to stand things on.
      const isFloor = fit.offset < 0;
      await put(BG_FLOOR_PREDICATE, isFloor ? fit.offset.toFixed(4) : '');
      msg = `Removed a ${fit.tiltDeg.toFixed(1)}° tilt; ${(fit.fraction * 100).toFixed(0)}% of ${(got.centres.length / 3).toLocaleString()} sampled points lie on that plane.`
        + (isFloor ? ' Floor height set.' : ' That plane is above the room\'s middle (a ceiling?), so no floor height was set.');
    } catch (e) {
      msg = `Could not fit: ${(e as Error).message}`;
    }
  }

  // ── Set focal point (F58.9.16) ──
  let picking = $state(false);
  function stopPicking() { picking = false; focalPick.active = false; focalPick.onray = null; }
  onDestroy(stopPicking);

  /**
   * Click a point in the 3D view to make it the room's centre. The pick is a DEPTH PICK against the
   * sampled Gaussian centres (a splat has no mesh to raycast); with nothing under the cursor it falls
   * back to the floor plane and says so. A backdrop resizes with the graph every frame, so a point
   * picked in it would drift: choosing a focal point switches to surround and says so.
   */
  async function startFocal() {
    if (picking) { stopPicking(); msg = 'Set focal point cancelled.'; return; }
    if (!roomView.live) { msg = 'Open the 3D graph first: the focal point is picked by clicking in it.'; return; }
    msg = 'reading the room…';
    const got = await sampledCentres(true);
    if (typeof got === 'string') { msg = got; return; }
    let note = '';
    if (bg.mode !== 'surround') {
      await put(BG_MODE_PREDICATE, 'surround');
      await put(BG_SCALE_PREDICATE, '');
      note = ' (Switched to surround: a backdrop resizes with the graph, so a point in it would not hold still.)';
    }
    const floor = bg.floor ?? 0;
    let radius = 0;
    for (let i = 0; i + 2 < got.centres.length; i += 3) radius = Math.max(radius, Math.hypot(got.centres[i], got.centres[i + 2]));
    focalPick.active = true; picking = true;
    focalPick.onray = async (origin: Vec3, dir: Vec3) => {
      const local = rayToRoomLocal(origin, dir, { centre: roomView.centre, scale: roomView.scale, yaw: roomView.yaw });
      const hit = pickOnRay(got.centres, local.origin, local.dir, floor, 0.03, radius * 1.5);
      stopPicking();
      if (!hit) { msg = 'Nothing under that click, and the ray does not reach the floor. Click on the room or below the horizon.'; return; }
      await put(BG_FOCAL_PREDICATE, formatFocal(hit.point));
      msg = hit.hit === 'splat' ? 'Focal point set on the room surface under the click.' : 'Nothing was under the click, so the floor plane was used. Click on the room itself for a surface point.';
    };
    msg = 'Click the point in the 3D view that should be the room\'s centre. Esc cancels.' + note;
  }
  $effect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { stopPicking(); msg = 'Set focal point cancelled.'; } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

{#if background}
  <div class="settings mono" data-testid="background-settings">
    <div class="chip-row" role="group" aria-label="Background mode">
      <button class="pkg-chip" class:active={bg.mode === 'backdrop'} onclick={() => put(BG_MODE_PREDICATE, 'backdrop')} data-testid="bg-mode-backdrop" title="A dimmed scene behind the graph, sized to it">backdrop</button>
      <button class="pkg-chip" class:active={bg.mode === 'surround'} onclick={() => put(BG_MODE_PREDICATE, 'surround')} data-testid="bg-mode-surround" title="The graph sits inside the space, which keeps its own scale">surround</button>
    </div>
    <label>scale
      <input type="range" min="0" max="1" step="0.005" value={sliderFromScale(bg.scale)} data-testid="bg-scale-slider"
        oninput={(e) => put(BG_SCALE_PREDICATE, scaleFromSlider(num(e)))} aria-label="Scale, logarithmic"
        title="Logarithmic: every tenfold change gets the same travel, from 0.001 to 1000" />
      <input type="number" min="0.001" max="1000" step="any" value={bg.scale} data-testid="bg-scale" onchange={(e) => put(BG_SCALE_PREDICATE, num(e))}
        title={bg.mode === 'surround' ? 'World units per file unit. A scan has no true size until you set one.' : 'Multiplier on the automatic size'} />
    </label>
    <label>up axis
      <select class="pkg-chip" value={bg.up} onchange={(e) => put(BG_UP_PREDICATE, (e.target as HTMLSelectElement).value)} title="Which of the file's axes points up. Scans from COLMAP-based tools usually point down (−y).">
        {#each UP_AXES as a}<option value={a}>{a.replace('-', '−')}</option>{/each}
      </select>
    </label>
    <label>yaw {bg.yaw}°
      <input type="range" min="-180" max="180" step="5" value={bg.yaw} onchange={(e) => put(BG_YAW_PREDICATE, num(e))} />
    </label>
    <label>opacity {Math.round(bg.opacity * 100)}%
      <input type="range" min="0" max="1" step="0.05" value={bg.opacity} onchange={(e) => put(BG_OPACITY_PREDICATE, num(e))} />
    </label>
    <label>offset
      {#each [0, 1, 2] as k}<input type="number" step="0.5" value={bg.offset[k]} onchange={(e) => putOffset(k as 0 | 1 | 2, e)} aria-label={'offset ' + 'xyz'[k]} />{/each}
    </label>
    <div class="chip-row">
      <button class="pkg-chip" onclick={levelFloor} data-testid="level-floor" title="Fit the dominant horizontal plane to the scan and remove its tilt">Level the floor</button>
      {#if bg.level}<button class="pkg-chip" data-testid="remove-levelling" onclick={async () => { await put(BG_LEVEL_PREDICATE, ''); await put(BG_FLOOR_PREDICATE, ''); }}>remove levelling</button>{/if}
      <button class="pkg-chip" class:active={picking} onclick={startFocal} data-testid="set-focal-point"
        title="Click a point in the 3D view to make it the centre of the room (a depth pick against the scan's points)">{picking ? 'Cancel focal point' : 'Set focal point'}</button>
      {#if focalIsSet}<button class="pkg-chip" data-testid="clear-focal-point" onclick={() => put(BG_FOCAL_PREDICATE, '')} title="Back to the room's own centre">clear focal point</button>{/if}
      <button class="pkg-chip" onclick={resetSettings}>reset settings</button>
    </div>
    {#if focalIsSet}<span class="pkg-note mono" data-testid="focal-readout">focal point {bg.focal.map((x) => Math.round(x * 100) / 100).join(' ')} (room units from its centre)</span>{/if}
    {#if msg}<span class="pkg-note pkg-msg mono" role="status" data-testid="background-message">{msg}</span>{/if}
  </div>
{/if}

<style>
  .chip-row { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
  .pkg-chip {
    display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.28rem 0.6rem; border-radius: 999px;
    border: 1px solid var(--line); background: var(--surface); color: var(--muted);
    font-family: var(--font-mono); font-size: 0.68rem; cursor: pointer; transition: all 0.15s;
  }
  .pkg-chip:hover { border-color: var(--muted-2); color: var(--ink); }
  .pkg-chip.active { border-color: var(--accent); color: var(--accent); }
  .settings { display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.68rem; color: var(--muted); margin-top: 0.3rem; }
  .settings label { display: flex; align-items: center; gap: 0.5rem; }
  .settings input[type='range'] { flex: 1; min-width: 4rem; accent-color: var(--accent); }
  .settings input[type='number'] { width: 4.5rem; background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 4px; padding: 0.15rem 0.3rem; font-family: var(--font-mono); font-size: 0.68rem; }
  .pkg-note { font-size: 0.6rem; color: var(--muted); opacity: 0.75; padding: 0 0.1rem; }
  .pkg-msg { color: var(--accent); opacity: 1; }
</style>
