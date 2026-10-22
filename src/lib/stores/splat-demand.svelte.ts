/**
 * F58.9 on-demand entity splats. SplatLayer puts the keys of entity splats it held back (over
 * ENTITY_SPLAT_STARTUP_BUDGET) in `deferred`; the detail panel, or opening the entity's asset, calls
 * `request(key)`, and SplatLayer then loads it. A loaded splat stays loaded until you leave
 * (no unload on deselect: reloading a 3.5 MB file on every click is worse than keeping it).
 */
import { SvelteSet } from 'svelte/reactivity';

export const splatDemand = {
  /** Keys with a splat that has not loaded because it is over budget. */
  deferred: new SvelteSet<string>(),
  /** Gaussian count per deferred key, for the button's label. */
  counts: new Map<string, number>(),
  /** Keys the person asked to load. */
  requested: new SvelteSet<string>(),
  request(key: string) { this.requested.add(key); },
  reset() { this.deferred.clear(); this.counts.clear(); this.requested.clear(); },
};
