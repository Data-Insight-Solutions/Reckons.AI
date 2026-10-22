<script lang="ts">
  /**
   * Start placing a node's splat in the space's background (F58.9.9, F58.9.16). Place in space puts
   * it on the floor in front of the camera and enters placement mode: the large preview collapses
   * and a compact bar (PlacementBar) floats over the graph, so the person sees the splat move inside
   * the background. A placed node offers Adjust in space and Unplace.
   */
  import { statements } from '$lib/stores/kb.svelte';
  import { placeInRoom, unplace } from '$lib/stores/space-room';
  import { placementsFrom } from '$lib/3d/splat';
  import { startPlacing } from '$lib/stores/placement-mode.svelte';

  let { iri }: { iri: string } = $props();
  const placement = $derived(placementsFrom(statements()).get(iri) ?? null);
  let msg = $state('');

  async function place() {
    const res = await placeInRoom(iri);
    msg = res.message;
    if (res.ok) startPlacing(iri);
  }
</script>

<div class="place" data-testid="splat-placement">
  {#if !placement}
    <button class="pl-btn mono" onclick={place} data-testid="place-in-space" title="Put this splat in the space's background, on the floor in front of the camera">Place in space</button>
  {:else}
    <div class="pl-row">
      <button class="pl-btn mono" onclick={() => startPlacing(iri)} data-testid="adjust-in-space" title="Move, raise, turn and scale this splat inside the background">Adjust in space</button>
      <button class="pl-btn mono" onclick={() => unplace(iri)} title="Return this node to the layout">Unplace</button>
    </div>
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
