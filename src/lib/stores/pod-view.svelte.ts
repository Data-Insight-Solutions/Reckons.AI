/**
 * Pod view (F29 Currents) — per-device UI preference.
 *
 * When enabled, the graph view renders pending "arrival" nodes (facts brought in
 * by currents, not yet accepted) translucent and drifting, with accept/dismiss
 * available on the node. This is a view preference, not graph data, so it lives
 * in localStorage rather than the KB — it's configured on the Graph tab (/kb,
 * currents section) and honoured by the home graph view.
 */

const KEY = 'reckons:pod-view-enabled';

function readInitial(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(KEY) === 'true';
}

let _enabled = $state(readInitial());

/** Reactive getter — true when pod view should render arrivals distinctly. */
export function podViewEnabled(): boolean {
  return _enabled;
}

/** Set the preference (persists to localStorage). */
export function setPodViewEnabled(on: boolean): void {
  _enabled = on;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(KEY, on ? 'true' : 'false');
  }
}
