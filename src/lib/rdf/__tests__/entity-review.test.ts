/**
 * F83 entity-granularity review — decide about THINGS, not rows.
 * Pending facts bundle into one card per subject; each card carries the strongest gate so it
 * lands in the right lane as a unit; settled facts are excluded.
 */
import { describe, it, expect } from 'vitest';
import { groupPendingByEntity, entityReviewSummary, isPendingReview } from '../entity-review';
import type { Statement, ReviewStatus } from '../types';

let n = 0;
function st(s: string, p: string, o: string, extra: Partial<Statement> = {}): Statement {
  n += 1;
  return {
    id: extra.id ?? `s${n}`,
    s: { kind: 'iri', value: s },
    p: { kind: 'iri', value: p },
    o: { kind: 'literal', value: o },
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'x',
    confidence: 1,
    status: (extra.status ?? 'pending') as ReviewStatus,
    createdAt: extra.createdAt ?? n,
    updatedAt: extra.updatedAt ?? n,
    ...extra,
  } as Statement;
}

const A = 'urn:kbase:concept/alpha';
const B = 'urn:kbase:concept/beta';
const HASFILE = 'urn:kbase:predicate/has-file'; // path-ish -> machine gate
const NOTE = 'urn:kbase:predicate/note';        // -> user gate

describe('groupPendingByEntity', () => {
  it('bundles all pending facts about one subject into a single card', () => {
    const cards = groupPendingByEntity([
      st(A, NOTE, 'first', { id: '1' }),
      st(A, NOTE, 'second', { id: '2' }),
      st(B, NOTE, 'other', { id: '3' }),
    ]);
    expect(cards).toHaveLength(2);
    const alpha = cards.find((c) => c.entityIri === A)!;
    expect(alpha.facts).toHaveLength(2);
    expect(alpha.additions).toBe(2);
  });

  it('counts additions, removals and questions separately', () => {
    const cards = groupPendingByEntity([
      st(A, NOTE, 'keep', { id: '1', status: 'pending' }),
      st(A, NOTE, 'drop', { id: '2', status: 'pending-removal' }),
      st(A, 'urn:kbase:predicate/owner', '?', { id: '3', needsObject: true }),
    ]);
    const c = cards[0];
    expect(c.additions).toBe(2); // pending + the partial (not a removal)
    expect(c.removals).toBe(1);
    expect(c.questions).toBe(1);
  });

  it('excludes settled/terminal statuses — only pending & pending-removal are under review', () => {
    const cards = groupPendingByEntity([
      st(A, NOTE, 'confirmed', { id: '1', status: 'confirmed' }),
      st(A, NOTE, 'rejected', { id: '2', status: 'rejected' }),
      st(B, NOTE, 'live', { id: '3', status: 'pending' }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].entityIri).toBe(B);
  });

  it('prefers an rdfs:label fact for the card label', () => {
    const cards = groupPendingByEntity([
      st(A, 'http://www.w3.org/2000/01/rdf-schema#label', 'Alpha Thing', { id: '1' }),
      st(A, NOTE, 'x', { id: '2' }),
    ]);
    expect(cards[0].label).toBe('Alpha Thing');
  });

  it('a card carries the STRONGEST gate among its facts (user pulls it to the human)', () => {
    // has-file is machine-checkable; a free-text note is the user's. The card must be user-gated.
    const cards = groupPendingByEntity([
      st(A, HASFILE, 'src/lib/x.ts', { id: '1' }),
      st(A, NOTE, 'a judgement call', { id: '2' }),
    ]);
    expect(cards[0].gate).toBe('user');
  });

  it('ranks user-gated cards ahead of machine-only cards', () => {
    const cards = groupPendingByEntity([
      st(A, HASFILE, 'src/lib/x.ts', { id: '1' }),          // machine-only entity
      st(B, NOTE, 'decide me', { id: '2' }),                 // user entity
    ]);
    expect(cards[0].entityIri).toBe(B); // user lane first
  });

  it('is deterministic regardless of input order', () => {
    const facts = [st(A, NOTE, 'x', { id: '1' }), st(B, NOTE, 'y', { id: '2' })];
    const a = groupPendingByEntity(facts).map((c) => c.entityIri);
    const b = groupPendingByEntity([...facts].reverse()).map((c) => c.entityIri);
    expect(a).toEqual(b);
  });
});

describe('helpers', () => {
  it('isPendingReview accepts only pending & pending-removal', () => {
    expect(isPendingReview(st(A, NOTE, 'x', { status: 'pending' }))).toBe(true);
    expect(isPendingReview(st(A, NOTE, 'x', { status: 'pending-removal' }))).toBe(true);
    expect(isPendingReview(st(A, NOTE, 'x', { status: 'confirmed' }))).toBe(false);
  });

  it('summary condenses rows into entity count', () => {
    const cards = groupPendingByEntity([st(A, NOTE, 'x'), st(A, NOTE, 'y'), st(B, NOTE, 'z')]);
    expect(entityReviewSummary(cards)).toMatch(/2 entities to review \(3 facts\)/);
    expect(entityReviewSummary([])).toMatch(/nothing/i);
  });
});
