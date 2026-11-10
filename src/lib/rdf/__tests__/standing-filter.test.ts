import { describe, it, expect } from 'vitest';
import { passesStandingFilters, focusOption, statementNodeKeys } from '../standing-filter';
import type { Statement } from '../types';
import { iri, lit } from '../types';

let n = 0;
function st(s: string, o: string | null, extra: Partial<Statement> = {}): Statement {
  return {
    id: `s${++n}`, s: iri(`urn:t/${s}`), p: iri('urn:t/rel'), o: o === null ? lit('?') : iri(`urn:t/${o}`),
    g: iri('urn:t/g'), sourceId: 'x', confidence: 1, status: 'confirmed', createdAt: 0, updatedAt: 0, ...extra,
  } as Statement;
}

describe('standing filters are exact to the statement (F223.11)', () => {
  const held = st('a', 'b');
  const proposed = st('a', 'b', { status: 'pending', proposalOption: 'opt-1' });
  const q1 = st('a', null, { status: 'pending', needsObject: true });
  const q2 = st('b', null, { status: 'pending', needsObject: true });

  it('the proposed filter lights only the proposed edge, though a held edge joins the same two nodes', () => {
    const on = new Set(['proposed']);
    expect(passesStandingFilters(proposed, on)).toBe(true);
    expect(passesStandingFilters(held, on)).toBe(false);
  });
  it('the questions filter lights only question edges, and their ends are their own nodes', () => {
    const on = new Set(['questions']);
    expect([held, proposed, q1, q2].filter((s) => passesStandingFilters(s, on))).toEqual([q1, q2]);
    expect(statementNodeKeys(q1)[1]).not.toBe(statementNodeKeys(q2)[1]);
    expect(statementNodeKeys(q1)[1]).not.toContain('l:?');
  });
  it('confirmed lights held only; status filters union; none active passes everything', () => {
    expect(passesStandingFilters(held, new Set(['confirmed']))).toBe(true);
    expect(passesStandingFilters(proposed, new Set(['confirmed']))).toBe(false);
    expect(passesStandingFilters(q1, new Set(['confirmed', 'questions']))).toBe(true);
    expect(passesStandingFilters(held, new Set(['hubs']))).toBe(true);
  });
});

describe('focus one option of a proposal', () => {
  const heldFact = st('a', 'b');
  const a1 = st('a', 'plan-a', { status: 'pending', proposalOption: 'A' });
  const b1 = st('a', 'plan-b', { status: 'pending', proposalOption: 'B' });
  const gap = st('plan-a', null, { status: 'pending', needsObject: true, blocks: ['urn:t/plan-a'] });
  const all = [heldFact, a1, b1, gap];

  it('lights the option, cites quietly, lights its blocking gaps, dims the rest', () => {
    const f = focusOption(all, 'A', { citations: [heldFact.id] });
    expect([...f.lit].sort()).toEqual([a1.id, gap.id].sort());
    expect([...f.quiet]).toEqual([heldFact.id]);
    expect(f.lit.has(b1.id) || f.quiet.has(b1.id)).toBe(false);
  });
  it('switching option swaps what is lit', () => {
    const fb = focusOption(all, 'B');
    expect([...fb.lit]).toEqual([b1.id]);
    expect(fb.nodeKeys.has('i:urn:t/plan-b')).toBe(true);
    expect(fb.nodeKeys.has('i:urn:t/plan-a')).toBe(false);
  });
});
