<script lang="ts">
  /**
   * Per-node controls (F58.9.18). A collapsible "controls" section in the node details panel: position
   * (writing it pins the node), scale, turn, opacity and three motions (spin, bob, pulse). Matt, 2026-10-20:
   * "tweakpane or other control mechanisms should be implemented for the nodes, so they can individually
   * controlled motion, etc."
   *
   * Tweakpane (MIT) is imported only when the section is opened and the pane is disposed when it closes or
   * the node changes. Each change is debounced (~300 ms) into meta triples on the node (writeNodeControls);
   * the renderers read them with nodeMotionFrom and apply them per frame, so dragging a slider writes nothing
   * until you pause. The room extras (place on the floor in front of the camera, adjust in the room) live here,
   * because they only make sense for a space with a surround room and used to sit on a button that did nothing
   * everywhere else.
   */
  import { onDestroy } from 'svelte';
  import { statements } from '$lib/stores/kb.svelte';
  import { placementsFrom, backgroundSplatFrom, backgroundSettingsFrom } from '$lib/3d/splat';
  import { nodeMotionFrom, pins2dFrom, MOTION_DEFAULTS } from '$lib/3d/node-controls';
  import { nodeView } from '$lib/3d/node-view';
  import { pinNode, writeNodeControls, resetNodeControls, unpinNode } from '$lib/stores/node-pins';
  import { placeInRoom } from '$lib/stores/space-room';
  import { startPlacing } from '$lib/stores/placement-mode.svelte';
  import { reducedMotion } from '$lib/stores/reduced-motion';

  let { iri, mode }: { iri: string; mode: '2d' | '3d' } = $props();

  let open = $state(false);
  let host: HTMLDivElement | undefined = $state();
  let note = $state('');
  let roomMsg = $state('');

  const pin3 = $derived(placementsFrom(statements()).get(iri) ?? null);
  const pin2 = $derived(pins2dFrom(statements()).get(iri) ?? null);
  const pinned = $derived(mode === '3d' ? !!pin3 : !!pin2);
  const motion = $derived(nodeMotionFrom(statements()).get(iri) ?? null);
  const hasBackground = $derived(!!backgroundSplatFrom(statements()));
  const surround = $derived(backgroundSettingsFrom(statements()).mode === 'surround');

  /** The object Tweakpane edits. Plain, not reactive: Tweakpane owns it while the pane is open. */
  type Params = { x: number; y: number; z: number; scale: number; yaw: number; opacity: number; spin: number; bobAmp: number; bobPeriod: number; pulseAmp: number; pulsePeriod: number };
  const params: Params = { x: 0, y: 0, z: 0, scale: 1, yaw: 0, opacity: 1, spin: 0, bobAmp: 0, bobPeriod: 3, pulseAmp: 0, pulsePeriod: 2 };
  let pane: { dispose(): void; refresh(): void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = new Set<keyof Params>();
  let editing = false;

  function loadParams() {
    const m = motion ?? MOTION_DEFAULTS;
    params.scale = m.scale; params.yaw = m.yaw; params.opacity = m.opacity; params.spin = m.spin;
    params.bobAmp = m.bob.amp; params.bobPeriod = m.bob.period; params.pulseAmp = m.pulse.amp; params.pulsePeriod = m.pulse.period;
    const at = mode === '3d' ? (pin3?.at ?? null) : pin2;
    const live = at ?? (nodeView.mode === mode ? nodeView.read?.(iri) ?? null : null);
    if (live) { params.x = live[0]; params.y = live[1]; params.z = live[2] ?? 0; }
  }

  function flush() {
    timer = null;
    const keys = dirty; dirty = new Set();
    editing = false;
    if (!keys.size) return;
    if (keys.has('x') || keys.has('y') || keys.has('z')) {
      void pinNode(iri, mode, mode === '3d' ? [params.x, params.y, params.z] : [params.x, params.y]).then((ok) => { note = ok ? '' : 'The graph is not drawn right now, so the node could not be pinned.'; });
    }
    const patch: Parameters<typeof writeNodeControls>[1] = {};
    if (keys.has('scale')) patch.scale = params.scale;
    if (keys.has('yaw')) patch.yaw = params.yaw;
    if (keys.has('opacity')) patch.opacity = params.opacity;
    if (keys.has('spin')) patch.spin = params.spin;
    if (keys.has('bobAmp') || keys.has('bobPeriod')) patch.bob = { amp: params.bobAmp, period: params.bobPeriod };
    if (keys.has('pulseAmp') || keys.has('pulsePeriod')) patch.pulse = { amp: params.pulseAmp, period: params.pulsePeriod };
    if (Object.keys(patch).length) void writeNodeControls(iri, patch);
  }
  function changed(k: keyof Params) {
    dirty.add(k); editing = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 300);
  }

  async function reset() {
    if (timer) { clearTimeout(timer); timer = null; }
    dirty = new Set(); editing = false;
    await resetNodeControls(iri);
    Object.assign(params, { scale: 1, yaw: 0, opacity: 1, spin: 0, bobAmp: 0, bobPeriod: 3, pulseAmp: 0, pulsePeriod: 2 });
    pane?.refresh();
  }

  // Build the pane when the section opens (importing Tweakpane only then); dispose it on close, node change or unmount.
  $effect(() => {
    if (!open || !host) return;
    void iri; void mode; // a different node or renderer is a different pane
    const el = host;
    let cancelled = false;
    let made: { dispose(): void; refresh(): void } | null = null;
    loadParams();
    (async () => {
      const { Pane } = await import('tweakpane');
      if (cancelled) return;
      const p = new Pane({ container: el });
      made = p; pane = p;
      const bind = <K extends keyof Params>(parent: any, key: K, label: string, opts: Record<string, unknown>) => {
        parent.addBinding(params, key, { label, ...opts }).on('change', () => changed(key));
      };
      const pos = p.addFolder({ title: pinned ? 'position (pinned)' : 'position (writing pins it)', expanded: true });
      bind(pos, 'x', 'x', { step: 0.1 });
      bind(pos, 'y', 'y', { step: 0.1 });
      if (mode === '3d') bind(pos, 'z', 'z', { step: 0.1 });
      const look = p.addFolder({ title: 'look', expanded: true });
      bind(look, 'scale', 'scale', { min: 0.1, max: 10, step: 0.05 });
      bind(look, 'yaw', 'turn °', { min: -180, max: 180, step: 1 });
      bind(look, 'opacity', 'opacity', { min: 0, max: 1, step: 0.01 });
      const mo = p.addFolder({ title: 'motion', expanded: true });
      bind(mo, 'spin', 'spin °/s', { min: -360, max: 360, step: 1 });
      bind(mo, 'bobAmp', 'bob size', { min: 0, max: 3, step: 0.05 });
      bind(mo, 'bobPeriod', 'bob secs', { min: 0.5, max: 20, step: 0.1 });
      bind(mo, 'pulseAmp', 'pulse size', { min: 0, max: 1, step: 0.01 });
      bind(mo, 'pulsePeriod', 'pulse secs', { min: 0.5, max: 20, step: 0.1 });
      p.addButton({ title: 'reset controls' }).on('click', () => { void reset(); });
    })();

    // An unpinned node keeps moving with the layout: follow it, unless the person is mid-edit.
    const follow = setInterval(() => {
      if (editing || pinned || !pane) return;
      const live = nodeView.mode === mode ? nodeView.read?.(iri) ?? null : null;
      if (live) { params.x = live[0]; params.y = live[1]; params.z = live[2] ?? 0; pane.refresh(); }
    }, 500);

    return () => {
      cancelled = true;
      clearInterval(follow);
      if (timer) { clearTimeout(timer); flush(); } // a pending change is written, not dropped
      made?.dispose();
      if (pane === made) pane = null;
    };
  });

  // The store changed under the pane (a drag elsewhere, Unpin, another panel): show the stored values, unless mid-edit.
  $effect(() => {
    void pin3; void pin2; void motion;
    if (!pane || editing) return;
    loadParams();
    pane.refresh();
  });

  onDestroy(() => { if (timer) { clearTimeout(timer); flush(); } });

  async function placeOnFloor() {
    const res = await placeInRoom(iri);
    roomMsg = res.message;
    if (res.ok) startPlacing(iri);
  }
</script>

<div class="nc" data-testid="node-controls">
  <button class="nc-toggle mono" aria-expanded={open} aria-controls="nc-body-{iri}" onclick={() => (open = !open)} data-testid="node-controls-toggle">
    controls {open ? '▲' : '▼'}
    {#if motion}<span class="nc-badge">set</span>{/if}
  </button>
  {#if open}
    <div class="nc-body" id="nc-body-{iri}">
      <div class="nc-pane" bind:this={host} data-testid="node-controls-pane"></div>
      {#if reducedMotion()}<p class="nc-note mono">Spin, bob and pulse are paused: your system asks for reduced motion. Scale, turn and opacity still apply.</p>{/if}
      {#if mode === '2d'}<p class="nc-note mono">2D draws scale, turn, opacity, pulse, bob (half size) and spin (the shape turns, its icon stays upright). Position here is the 2D layout's own, separate from the 3D pin.</p>{/if}
      {#if note}<p class="nc-note mono" role="status">{note}</p>{/if}
      <div class="nc-row">
        {#if pinned}<button class="nc-btn mono" onclick={() => unpinNode(iri, mode)} data-testid="node-controls-unpin">unpin</button>{/if}
        {#if mode === '3d'}
          {#if hasBackground}
            <button class="nc-btn mono" onclick={placeOnFloor} data-testid="place-on-floor" title="Put this node on the floor of the space's room, in front of the camera, and show the move / turn / scale bar">place on floor</button>
            {#if pin3 && surround}<button class="nc-btn mono" onclick={() => startPlacing(iri)} data-testid="adjust-in-space" title="Move, raise, turn and scale this node inside the room">adjust in room</button>{/if}
          {:else}
            <p class="nc-note mono">Room placement (floor, raise, turn) needs a background scan in this space; pinning and the controls above work without one.</p>
          {/if}
        {/if}
      </div>
      {#if roomMsg}<p class="nc-note mono" role="status">{roomMsg}</p>{/if}
    </div>
  {/if}
</div>

<style>
  .nc { margin-top: 0.5rem; }
  .nc-toggle {
    width: 100%; text-align: left; background: transparent; border: 1px solid var(--line); border-radius: 6px;
    color: var(--accent); font-size: 0.7rem; padding: 0.4rem 0.6rem; cursor: pointer; min-height: 44px;
  }
  .nc-toggle:hover { border-color: var(--accent); }
  .nc-badge { margin-left: 0.4rem; color: var(--muted); font-size: 0.6rem; }
  .nc-body { margin-top: 0.4rem; display: flex; flex-direction: column; gap: 0.4rem; }
  /* Tweakpane takes its colours from these; ours follow the theme (docs/STYLE_GUIDE.md). */
  .nc-pane {
    --tp-base-background-color: var(--surface-2);
    --tp-base-shadow-color: transparent;
    --tp-base-font-family: var(--font-mono);
    --tp-container-background-color: var(--surface);
    --tp-container-background-color-hover: var(--surface-3);
    --tp-container-background-color-focus: var(--surface-3);
    --tp-container-background-color-active: var(--surface-3);
    --tp-container-foreground-color: var(--ink-2);
    --tp-label-foreground-color: var(--muted);
    --tp-groove-foreground-color: var(--line);
    --tp-input-background-color: var(--surface);
    --tp-input-background-color-hover: var(--surface-3);
    --tp-input-background-color-focus: var(--surface-3);
    --tp-input-background-color-active: var(--surface-3);
    --tp-input-foreground-color: var(--ink);
    --tp-button-background-color: var(--surface-3);
    --tp-button-background-color-hover: var(--accent-soft);
    --tp-button-background-color-focus: var(--accent-soft);
    --tp-button-background-color-active: var(--accent-soft);
    --tp-button-foreground-color: var(--accent);
    --tp-monitor-background-color: var(--surface);
    --tp-monitor-foreground-color: var(--ink-2);
  }
  .nc-row { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .nc-btn {
    min-height: 44px; min-width: 44px; padding: 0 0.7rem; border-radius: 8px;
    border: 1px solid var(--line); background: var(--surface); color: var(--accent); font-size: 0.7rem; cursor: pointer;
  }
  .nc-btn:hover { border-color: var(--accent); }
  .nc-note { font-size: 0.62rem; color: var(--muted); margin: 0; }
</style>
