import { describe, it, expect } from 'vitest';
import { compareOverlay, toCanvasOverlay } from '../compare-overlay';
import type { DiffEntry } from '../diff';
import type { Statement } from '../types';
import { iri, lit, termKey } from '../types';

let n = 0;
function st(s: string, p: string, o: string, over: Partial<Statement> = {}, literal = false): Statement {
  return {
    id: `st-${++n}`,
    s: iri(`urn:kbase:concept/${s}`),
    p: iri(`urn:kbase:predicate/${p}`),
    o: literal ? lit(o) : iri(`urn:kbase:concept/${o}`),
    g: iri('urn:kbase:source/a'),
    sourceId: 'a',
    confidence: 0.9,
    status: 'confirmed',
    createdAt: 1,
    updatedAt: 1,
    ...over
  };
}

const held1 = st('club', 'press-day', 'Thursday', {}, true);
const held2 = st('club', 'members', '40', {}, true);
const held3 = st('shed', 'stores', 'crates');
const existing = [held1, held2, held3];
const inc = (s: string, p: string, o: string, literal = true) => st(s, p, o, { sourceId: 'b', status: 'pending' }, literal);

const repeat = inc('club', 'press-day', 'Thursday');
const contra = inc('club', 'members', '52');
const fresh = inc('shed', 'has-roof', 'slate');
const near = inc('club-society', 'has-cellar', 'cellar', false);
const entries: DiffEntry[] = [
  { kind: 'reinforces', incoming: repeat, existing: [held1] },
  { kind: 'conflicts', incoming: contra, existing: [held2] },
  { kind: 'new', incoming: fresh },
  { kind: 'near-duplicate', incoming: near, existing: held3, subjectSimilarity: 0.9 }
];
const label = (s: Statement) => (s.sourceId === 'a' ? 'Orchard seed' : 'Orchard meeting');

describe('compareOverlay', () => {
  const o = compareOverlay(entries, existing, { sourceLabel: label });

  it('draws a new statement as one ghost attached to the end already held', () => {
    expect(o.ghosts).toHaveLength(1);
    expect(o.ghosts[0].attachKey).toBe(termKey(fresh.s));
    expect(o.ghosts[0].label).toBe('slate');
  });
  it('folds a repeat onto the statement it repeats without adding a mark', () => {
    expect(o.folded).toHaveLength(1);
    expect(o.folded[0].targets.map((t) => t.id)).toEqual([held1.id]);
  });
  it('thickens the statement a differently worded one reinforces', () => {
    expect(o.thickened).toHaveLength(1);
    expect(o.thickened[0].targets.map((t) => t.id)).toEqual([held3.id]);
  });
  it('shows each contradiction as a pair carrying both sources', () => {
    expect(o.contradictions).toHaveLength(1);
    const c = o.contradictions[0];
    expect(c.held.map((h) => h.id)).toEqual([held2.id]);
    expect(c.incomingSource).toBe('Orchard meeting');
    expect(c.heldSources).toEqual(['Orchard seed']);
    expect(c.opposite).toBe(false);
  });
  it('treats an opposite-wording contradiction as a pair too, keeping its note', () => {
    const r = compareOverlay([{ kind: 'antonym-conflicts', incoming: contra, existing: [held2], note: 'opens vs closes' }], existing);
    expect(r.contradictions[0]).toMatchObject({ opposite: true, note: 'opens vs closes' });
  });
  it('does not draw updates or already dismissed rows', () => {
    const r = compareOverlay(
      [
        { kind: 'updates', incoming: contra, existing: [held2] },
        { kind: 'returned', incoming: fresh, existing: [], priorStatus: 'rejected' }
      ],
      existing
    );
    expect(r.skipped).toBe(2);
    expect(r.ghosts.length + r.folded.length + r.contradictions.length).toBe(0);
  });
  it('leaves a ghost unattached when neither end is held', () => {
    const r = compareOverlay([{ kind: 'new', incoming: inc('stranger', 'near', 'elsewhere', false) }], existing);
    expect(r.ghosts[0].attachKey).toBeNull();
  });
  it('does not mutate its inputs', () => {
    const before = JSON.stringify(existing);
    compareOverlay(entries, existing);
    expect(JSON.stringify(existing)).toBe(before);
  });
  it('gives the canvas ghosts (contradictions marked) and a weight per statement repeated or reinforced', () => {
    const c = toCanvasOverlay(o);
    expect(c.ghosts.map((g) => g.contradiction)).toEqual([false, true]);
    expect(c.weighted.map((w) => [w.p.split('/').pop(), w.weight]).sort()).toEqual([['press-day', 1], ['stores', 1]]);
    const twice = toCanvasOverlay(compareOverlay(
      [{ kind: 'reinforces', incoming: repeat, existing: [held1] }, { kind: 'near-duplicate', incoming: near, existing: held1, subjectSimilarity: 0.9 }],
      existing
    ));
    expect(twice.weighted[0].weight).toBe(2);
  });
});
