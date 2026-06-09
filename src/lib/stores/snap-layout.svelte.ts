/**
 * Tracks all mounted SnapPanel instances so columns can share vertical space
 * and panels never visually overlap.
 *
 * Usage in SnapPanel:
 *   $effect(() => { registerPanel(id, snappedCorner); return () => unregisterPanel(id); });
 *   const maxH = $derived(isSnapped ? getColumnMaxH(id, windowH) : null);
 */

type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

const TOP_MARGIN = 60;   // SearchBar / top chrome
const BOT_MARGIN = 52;   // NavBar + breathing room
const COL_GAP    = 8;    // gap between top and bottom panel in same column
const TOP_FRAC   = 0.25; // top panel gets 1/4, bottom gets 3/4

// Plain Map for data storage. _tick is the reactive signal — replaced with a new
// object on every change. Writing `_tick = {}` never reads the old value, so
// calling registerPanel/unregisterPanel inside a $effect won't create a
// dependency that would re-trigger that effect.
const _panels = new Map<string, Corner>();
let _tick = $state<object>({});

function partnerOf(c: Corner): Corner {
  switch (c) {
    case 'top-left':     return 'bottom-left';
    case 'bottom-left':  return 'top-left';
    case 'top-right':    return 'bottom-right';
    case 'bottom-right': return 'top-right';
  }
}

export function registerPanel(id: string, corner: Corner): void {
  _panels.set(id, corner);
  _tick = {};
}

export function unregisterPanel(id: string): void {
  _panels.delete(id);
  _tick = {};
}

/**
 * Returns the max-height (px) this panel should have, or null if unconstrained.
 * Pass `vh` as reactive state from the component so this re-derives on resize.
 */
export function getColumnMaxH(id: string, vh: number): number | null {
  void _tick; // reactive dependency — re-derives when panels register/unregister
  const corner = _panels.get(id);
  if (!corner) return null;
  const partner = partnerOf(corner);
  const hasPartner = [..._panels.values()].some(c => c === partner);
  if (!hasPartner) return null;
  const available = vh - TOP_MARGIN - BOT_MARGIN - COL_GAP;
  const isTop = corner === 'top-left' || corner === 'top-right';
  return Math.floor(available * (isTop ? TOP_FRAC : 1 - TOP_FRAC));
}
