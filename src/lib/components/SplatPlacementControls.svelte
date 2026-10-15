<script lang="ts">
  /**
   * Place a node's splat in the space's room (F58.9.9): Place in room, then move, raise, turn and
   * scale in steps, and Unplace. Buttons, not a gizmo: every step is a number the person can read
   * and an export carries. Moves are along the ROOM's axes, not the camera's.
   */
  import { statements } from '$lib/stores/kb.svelte';
  import { placeInRoom, adjustInRoom, unplace } from '$lib/stores/space-room';
  import { placementsFrom, type PlacementOp } from '$lib/3d/splat';

  let { iri }: { iri: string } = $props();
  const placement = $derived(placementsFrom(statements()).get(iri) ?? null);
  let msg = $state('');

  const MOVE = 0.25, TURN = 15, SCALE = 1.25;
  async function place() { msg = (await placeInRoom(iri)).message; }
  const step = (op: PlacementOp) => () => adjustInRoom(iri, op);
</script>

<div class="place" data-testid="splat-placement">
  {#if !placement}
    <button class="pl-btn mono" onclick={place} title="Put this splat in the space's room, on the floor in front of the camera">Place in room</button>
  {:else}
    <div class="pl-row" role="group" aria-label="Move in the room">
      <button class="pl-btn mono" onclick={step({ kind: 'move', dx: -MOVE })} aria-label="Move left" title="Move left (room axis)">←</button>
      <button class="pl-btn mono" onclick={step({ kind: 'move', dx: MOVE })} aria-label="Move right" title="Move right (room axis)">→</button>
      <button class="pl-btn mono" onclick={step({ kind: 'move', dz: -MOVE })} aria-label="Move back" title="Move back (room axis)">↑</button>
      <button class="pl-btn mono" onclick={step({ kind: 'move', dz: MOVE })} aria-label="Move forward" title="Move forward (room axis)">↓</button>
      <button class="pl-btn mono" onclick={step({ kind: 'move', dy: MOVE })} aria-label="Raise" title="Raise">⤒</button>
      <button class="pl-btn mono" onclick={step({ kind: 'move', dy: -MOVE })} aria-label="Lower" title="Lower">⤓</button>
    </div>
    <div class="pl-row" role="group" aria-label="Turn and scale">
      <button class="pl-btn mono" onclick={step({ kind: 'turn', degrees: -TURN })} aria-label="Turn left" title="Turn left 15°">↺</button>
      <button class="pl-btn mono" onclick={step({ kind: 'turn', degrees: TURN })} aria-label="Turn right" title="Turn right 15°">↻</button>
      <button class="pl-btn mono" onclick={step({ kind: 'scale', factor: 1 / SCALE })} aria-label="Smaller" title="Smaller">−</button>
      <button class="pl-btn mono" onclick={step({ kind: 'scale', factor: SCALE })} aria-label="Larger" title="Larger">+</button>
      <button class="pl-btn mono" onclick={() => unplace(iri)} title="Return this node to the layout">Unplace</button>
    </div>
    <span class="pl-read mono" data-testid="placement-readout">at {placement.at.join(' ')} · size {placement.scale} · turn {placement.yaw}°</span>
  {/if}
  {#if msg}<span class="pl-read mono" role="status">{msg}</span>{/if}
</div>

<style>
  .place { display: flex; flex-direction: column; gap: 0.3rem; margin-top: 0.4rem; max-width: 18rem; }
  .pl-row { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .pl-btn {
    min-height: 44px; min-width: 44px; padding: 0 0.7rem; border-radius: 8px;
    border: 1px solid var(--line); background: var(--surface); color: var(--accent); font-size: 0.75rem; cursor: pointer;
  }
  .pl-btn:hover { border-color: var(--accent); }
  .pl-read { font-size: 0.65rem; color: var(--muted); background: var(--surface); border-radius: 6px; padding: 0.2rem 0.4rem; }
</style>
