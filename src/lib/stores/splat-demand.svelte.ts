/**
 * F58.9 on-demand node splats. SplatLayer puts the keys of node splats it held back (over
 * NODE_SPLAT_STARTUP_BUDGET) in `deferred`; the node panel, or opening the node's asset, calls
 * `request(key)`, and SplatLayer then loads it. A loaded splat stays loaded until the space is left
 * (no unload on deselect: reloading a 3.5 MB file on every click is worse than keeping it).
 */
import { SvelteSet } from 'svelte/reactivity';

export const splatDemand = {
  /** Node keys with a splat that has not loaded because it is over budget. */
  deferred: new SvelteSet<string>(),
  /** Gaussian count per deferred key, for the button's label. */
  counts: new Map<string, number>(),
  /** Node keys the person asked to load. */
  requested: new SvelteSet<string>(),
  request(key: string) { this.requested.add(key); },
  reset() { this.deferred.clear(); this.counts.clear(); this.requested.clear(); },
};
