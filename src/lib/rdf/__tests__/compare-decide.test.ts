import { describe, it, expect } from 'vitest';
import { decideContradiction, knownDisagreements } from '../compare-decide';
import type { Statement } from '../types';
import { iri, lit } from '../types';

const st = (id: string, o: string, status: Statement['status'], extra: Partial<Statement> = {}): Statement => ({
  id, s: iri('urn:kbase:concept/co-op'), p: iri('urn:kbase:predicate/members'), o: lit(o),
  g: iri('urn:kbase:source/x'), sourceId: `src-${id}`, confidence: 0.9, status, createdAt: 1, updatedAt: 1, ...extra
} as Statement);

const held = st('held', '40', 'confirmed', { excerpt: 'has forty members' });
const incoming = st('new', '52', 'pending', { excerpt: 'now fifty-two' });
const pair = { incoming, held: [held] };

describe('decideContradiction', () => {
  it('keep mine: held stays confirmed, incoming is rejected', () => {
    expect(decideContradiction(pair, 'keep-mine')).toEqual({
      statuses: [{ id: 'held', status: 'confirmed' }, { id: 'new', status: 'rejected' }], marks: []
    });
  });
  it('take the new one: incoming is held, the old one is superseded (kept, not deleted)', () => {
    const d = decideContradiction(pair, 'take-new');
    expect(d.statuses).toEqual([{ id: 'held', status: 'superseded' }, { id: 'new', status: 'refined' }]);
    expect(d.statuses.some((s) => s.status === 'rejected')).toBe(false);
    expect(d.marks).toEqual([]);
  });
  it('take the new one supersedes every held side it opposes', () => {
    const d = decideContradiction({ incoming, held: [held, st('h2', '41', 'confirmed')] }, 'take-new');
    expect(d.statuses.filter((s) => s.status === 'superseded').map((s) => s.id)).toEqual(['held', 'h2']);
  });
  it('keep both: incoming is confirmed, nothing replaced, both marked as a known disagreement', () => {
    const d = decideContradiction(pair, 'keep-both');
    expect(d.statuses).toEqual([{ id: 'new', status: 'confirmed' }]);
    expect(d.marks).toEqual([{ id: 'new', disagreesWith: ['held'] }, { id: 'held', disagreesWith: ['new'] }]);
  });
  it('does not touch the statements it is given', () => {
    decideContradiction(pair, 'take-new');
    expect(held.status).toBe('confirmed');
    expect(held.excerpt).toBe('has forty members');
  });
});

describe('knownDisagreements', () => {
  it('lists each standing pair once, and drops a pair once one side is replaced', () => {
    const a = st('a', '40', 'confirmed', { knownDisagreement: ['b'] });
    const b = st('b', '52', 'confirmed', { knownDisagreement: ['a'] });
    expect(knownDisagreements([a, b])).toHaveLength(1);
    expect(knownDisagreements([a, { ...b, status: 'superseded' }])).toHaveLength(0);
  });
});
