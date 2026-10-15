<script lang="ts">
  /**
   * The compact floating bar for placing a splat in the space's background (F58.9.16): move, raise,
   * turn, scale, Done and Unplace, over the live graph, so the person sees the splat move inside the
   * background. Buttons, not a gizmo: every step is a number the person can read and an export
   * carries. Moves are along the SPACE's axes, not the camera's. Escape also leaves (handled by the page).
   */
  import { statements } from '$lib/stores/kb.svelte';
  import { adjustInRoom, unplace } from '$lib/stores/space-room';
  import { placementsFrom, type PlacementOp } from '$lib/3d/splat';
  import { stopPlacing } from '$lib/stores/placement-mode.svelte';

  let { iri, label = '' }: { iri: string; label?: string } = $props();
  const placed = $derived(placementsFrom(statements()).get(iri) ?? null);

  const MOVE = 0.25, TURN = 15, SCALE = 1.25;
  const step = (op: PlacementOp) => () => adjustInRoom(iri, op);
  async function remove() { await unplace(iri); stopPlacing(); }
</script>

<div class="bar" data-testid="placement-bar" role="toolbar" aria-label="Place in space">
  <span class="title mono">Place in space{label ? ` · ${label}` : ''}</span>
  <div class="row" role="group" aria-label="Move in the space">
    <button class="btn mono" onclick={step({ kind: 'move', dx: -MOVE })} aria-label="Move left" title="Move left (space axis)">←</button>
    <button class="btn mono" onclick={step({ kind: 'move', dx: MOVE })} aria-label="Move right" title="Move right (space axis)">→</button>
    <button class="btn mono" onclick={step({ kind: 'move', dz: -MOVE })} aria-label="Move back" title="Move back (space axis)">↑</button>
    <button class="btn mono" onclick={step({ kind: 'move', dz: MOVE })} aria-label="Move forward" title="Move forward (space axis)">↓</button>
    <button class="btn mono" onclick={step({ kind: 'move', dy: MOVE })} aria-label="Raise" title="Raise">⤒</button>
    <button class="btn mono" onclick={step({ kind: 'move', dy: -MOVE })} aria-label="Lower" title="Lower">⤓</button>
  </div>
  <div class="row" role="group" aria-label="Turn and scale">
    <button class="btn mono" onclick={step({ kind: 'turn', degrees: -TURN })} aria-label="Turn left" title="Turn left 15°">↺</button>
    <button class="btn mono" onclick={step({ kind: 'turn', degrees: TURN })} aria-label="Turn right" title="Turn right 15°">↻</button>
    <button class="btn mono" onclick={step({ kind: 'scale', factor: 1 / SCALE })} aria-label="Smaller" title="Smaller">−</button>
    <button class="btn mono" onclick={step({ kind: 'scale', factor: SCALE })} aria-label="Larger" title="Larger">+</button>
  </div>
  <div class="row">
    <button class="btn mono done" onclick={stopPlacing} data-testid="placement-done" title="Leave placement (Esc)">Done</button>
    <button class="btn mono" onclick={remove} data-testid="placement-unplace" title="Return this node to the layout">Unplace</button>
  </div>
  {#if placed}<span class="read mono" data-testid="placement-readout">at {placed.at.join(' ')} · size {Number(placed.scale.toPrecision(3))} · turn {placed.yaw}°</span>{/if}
</div>

<style>
  /* Bottom centre, below the panels (z 300) and above the canvas; compact so the graph stays visible. */
  .bar {
    position: fixed; left: 50%; bottom: 6.75rem; /* above the NavBar (z 400, about 5.5rem tall) */ transform: translateX(-50%); z-index: 310;
    display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 0.4rem 0.7rem;
    max-width: min(60rem, calc(100vw - 2rem)); padding: 0.45rem 0.7rem; border-radius: 12px;
    background: color-mix(in srgb, var(--surface) 92%, transparent); border: 1px solid var(--accent);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  }
  .title { font-size: 0.7rem; color: var(--accent); text-transform: uppercase; letter-spacing: 0.04em; }
  .row { display: flex; gap: 0.25rem; }
  .btn {
    min-height: 44px; min-width: 44px; padding: 0 0.6rem; border-radius: 8px;
    border: 1px solid var(--line); background: var(--surface); color: var(--accent); font-size: 0.75rem; cursor: pointer;
  }
  .btn:hover { border-color: var(--accent); }
  .done { background: var(--accent); color: var(--bg, #000); font-weight: 600; }
  .read { font-size: 0.65rem; color: var(--muted); width: 100%; text-align: center; }
</style>
