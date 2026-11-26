/**
 * Compare on the canvas (F264.2): what an incoming note would do to the person's own canvas,
 * as a pure mapping from the diff. Nothing here writes; the canvas draws it and the person decides.
 *
 *  - NEW (and refining) statements become ghosts, attached to the statement end already held.
 *  - REPEATS (reinforces, duplicate) fold onto the statement they repeat: no new mark, a count on it.
 *  - REINFORCEMENTS in other wording (near-duplicate, synonym-reinforces) thicken that statement.
 *  - each CONTRADICTION (conflicts, antonym-conflicts) is a pair: what is held and what arrives,
 *    side by side with both sources.
 *  - 'updates' (same origin, applied without asking), and statements already dismissed, are not drawn.
 */
import type { DiffEntry } from './diff';
import type { Statement } from './types';
import { termKey } from './types';

export type OverlayGhost = {
  id: string;
  incoming: Statement;
  /** Canvas key of the end this attaches to, or null when neither end is held. */
  attachKey: string | null;
  label: string;
  refines: boolean;
};
export type OverlayFold = { incoming: Statement; targets: Statement[] };
export type OverlayThicken = { incoming: Statement; targets: Statement[]; how: 'near-duplicate' | 'synonym-reinforces' };
export type OverlayContradiction = {
  id: string;
  incoming: Statement;
  held: Statement[];
  incomingSource: string;
  heldSources: string[];
  attachKey: string | null;
  opposite: boolean;
  note?: string;
};
export type CompareOverlay = {
  ghosts: OverlayGhost[];
  folded: OverlayFold[];
  thickened: OverlayThicken[];
  contradictions: OverlayContradiction[];
  /** Rows deliberately not drawn (updates, already dismissed). */
  skipped: number;
};

const asArray = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export function localLabel(v: string): string {
  const t = (v.split(/[/#]/).pop() ?? v).replace(/-/g, ' ');
  return t.length > 28 ? t.slice(0, 27) + '…' : t;
}

export function compareOverlay(
  entries: DiffEntry[],
  existing: Statement[],
  opts: { sourceLabel?: (st: Statement) => string } = {}
): CompareOverlay {
  const sourceLabel = opts.sourceLabel ?? ((st: Statement) => st.sourceId);
  const heldKeys = new Set(existing.flatMap((s) => [termKey(s.s), termKey(s.o)]));
  const heldIds = new Set(existing.map((s) => s.id));
  /** Prefer the subject; fall back to the object; null when neither is held. */
  const attach = (st: Statement): string | null => {
    const sk = termKey(st.s);
    if (heldKeys.has(sk)) return sk;
    const ok = termKey(st.o);
    return heldKeys.has(ok) ? ok : null;
  };
  // A target the canvas does not hold cannot be drawn on; it stays a count in the list below.
  const onCanvas = (list: Statement[]) => list.filter((s) => heldIds.has(s.id));

  const out: CompareOverlay = { ghosts: [], folded: [], thickened: [], contradictions: [], skipped: 0 };
  for (const e of entries) {
    switch (e.kind) {
      case 'new':
      case 'refines':
        out.ghosts.push({
          id: e.incoming.id,
          incoming: e.incoming,
          attachKey: attach(e.incoming),
          label: localLabel(e.incoming.o.value),
          refines: e.kind === 'refines'
        });
        break;
      case 'duplicate':
      case 'reinforces':
        out.folded.push({ incoming: e.incoming, targets: onCanvas(asArray(e.existing)) });
        break;
      case 'near-duplicate':
      case 'synonym-reinforces':
        out.thickened.push({ incoming: e.incoming, targets: onCanvas(asArray(e.existing)), how: e.kind });
        break;
      case 'conflicts':
      case 'antonym-conflicts': {
        const held = asArray(e.existing);
        out.contradictions.push({
          id: e.incoming.id,
          incoming: e.incoming,
          held,
          incomingSource: sourceLabel(e.incoming),
          heldSources: [...new Set(held.map(sourceLabel))],
          attachKey: attach(e.incoming),
          opposite: e.kind === 'antonym-conflicts',
          note: e.kind === 'antonym-conflicts' ? e.note : undefined
        });
        break;
      }
      default:
        out.skipped++;
    }
  }
  return out;
}

/** What the canvas component draws: ghost marks, and the held statements that carry extra weight. */
export type CanvasOverlay = {
  ghosts: { id: string; label: string; attachKey: string | null; contradiction: boolean }[];
  weighted: { s: string; o: string; p: string; weight: number }[];
};

export function toCanvasOverlay(o: CompareOverlay): CanvasOverlay {
  const weight = new Map<string, { st: Statement; n: number }>();
  for (const f of [...o.folded, ...o.thickened]) {
    for (const t of f.targets) {
      const cur = weight.get(t.id);
      if (cur) cur.n++;
      else weight.set(t.id, { st: t, n: 1 });
    }
  }
  return {
    ghosts: [
      ...o.ghosts.map((g) => ({ id: g.id, label: g.label, attachKey: g.attachKey, contradiction: false })),
      ...o.contradictions.map((c) => ({ id: c.id, label: localLabel(c.incoming.o.value), attachKey: c.attachKey, contradiction: true }))
    ],
    weighted: [...weight.values()].map(({ st, n }) => ({ s: termKey(st.s), o: termKey(st.o), p: st.p.value, weight: n }))
  };
}
