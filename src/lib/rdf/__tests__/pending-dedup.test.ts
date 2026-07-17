/**
 * F80.1 pending-fact dedupe — the user must never triage the same finding twice.
 * Exact duplicates fold (auto, sim 1.0); semantically near facts on the same predicate are
 * SUGGESTED, never acted on; different predicates never merge however similar the subjects.
 */
import { describe, it, expect } from 'vitest';
import {
  findPendingDuplicates,
  findMergeSuggestions,
  duplicatesRemoved,
  canonicalTerm,
} from '../pending-dedup';
import type { Statement, Term } from '../types';

let n = 0;
function st(
  s: string,
  p: string,
  o: string | Term,
  extra: Partial<Statement> = {},
): Statement {
  n += 1;
  const obj: Term = typeof o === 'string' ? { kind: 'iri', value: o } : o;
  return {
    id: extra.id ?? `s${n}`,
    s: { kind: 'iri', value: s },
    p: { kind: 'iri', value: p },
    o: obj,
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'x',
    confidence: extra.confidence ?? 0.7,
    status: 'pending',
    createdAt: extra.createdAt ?? n,
    updatedAt: n,
    ...extra,
  } as Statement;
}

const A = 'urn:kbase:concept/a';
const B = 'urn:kbase:concept/b';
const P = 'urn:kbase:predicate/likes';
const Q = 'urn:kbase:predicate/dislikes';

describe('findPendingDuplicates — exact duplicates fold (auto)', () => {
  it('two identical triples collapse to one, verdict auto, similarity 1', () => {
    const groups = findPendingDuplicates([st(A, P, B), st(A, P, B)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].verdict).toBe('auto');
    expect(groups[0].similarity).toBe(1);
    expect(groups[0].duplicates).toHaveLength(1);
    expect(duplicatesRemoved(groups)).toBe(1);
  });

  it('keeps the HIGHEST-confidence statement as canonical', () => {
    const low = st(A, P, B, { id: 'low', confidence: 0.4 });
    const high = st(A, P, B, { id: 'high', confidence: 0.95 });
    const groups = findPendingDuplicates([low, high]);
    expect(groups[0].keep.id).toBe('high');
    expect(groups[0].duplicates[0].id).toBe('low');
  });

  it('distinct facts are never grouped', () => {
    expect(findPendingDuplicates([st(A, P, B), st(A, Q, B)])).toHaveLength(0);
    expect(findPendingDuplicates([st(A, P, B), st(B, P, A)])).toHaveLength(0);
  });

  it('literal object matching normalizes whitespace/case but respects datatype & lang', () => {
    const lit = (value: string, extra: Partial<Term> = {}): Term => ({ kind: 'literal', value, ...extra });
    // same after normalization -> merge
    expect(findPendingDuplicates([st(A, P, lit('  Hello  World ')), st(A, P, lit('hello world'))])).toHaveLength(1);
    // different datatype -> NOT the same assertion
    expect(
      findPendingDuplicates([
        st(A, P, lit('5', { datatype: 'xsd:integer' })),
        st(A, P, lit('5', { datatype: 'xsd:string' })),
      ]),
    ).toHaveLength(0);
  });

  it('is deterministic and order-independent', () => {
    const a = st(A, P, B, { id: 'a' });
    const b = st(A, P, B, { id: 'b' });
    const c = st(A, P, B, { id: 'c' });
    const g1 = findPendingDuplicates([a, b, c]);
    const g2 = findPendingDuplicates([c, b, a]);
    expect(g1).toHaveLength(1);
    // same canonical chosen regardless of input order (all equal confidence/time -> id order)
    expect(g1[0].keep.id).toBe(g2[0].keep.id);
    expect(g1[0].duplicates).toHaveLength(2);
  });
});

describe('findMergeSuggestions — semantic near-dupes (suggest, never act)', () => {
  it('same predicate, similarity in [0.5,0.9) is a suggestion', () => {
    const a = st(A, P, B, { id: 'a' });
    const b = st('urn:kbase:concept/a2', P, B, { id: 'b' });
    const groups = findMergeSuggestions([a, b], () => 0.7);
    expect(groups).toHaveLength(1);
    expect(groups[0].verdict).toBe('suggest');
    expect(groups[0].similarity).toBe(0.7);
  });

  it('does NOT surface pairs at/above the auto threshold — those are the auto tier', () => {
    const a = st(A, P, B, { id: 'a' });
    const b = st('urn:kbase:concept/a2', P, B, { id: 'b' });
    expect(findMergeSuggestions([a, b], () => 0.95)).toHaveLength(0);
    expect(findMergeSuggestions([a, b], () => 0.3)).toHaveLength(0); // below floor
  });

  it('different predicates never merge however similar the subjects (predicate is the clue)', () => {
    const a = st(A, P, B, { id: 'a' });
    const b = st('urn:kbase:concept/a2', Q, B, { id: 'b' });
    expect(findMergeSuggestions([a, b], () => 0.99)).toHaveLength(0);
  });
});

describe('canonicalTerm', () => {
  it('two distinct blank nodes never share a token', () => {
    expect(canonicalTerm({ kind: 'bnode', value: 'b1' })).not.toBe(canonicalTerm({ kind: 'bnode', value: 'b2' }));
  });
});
