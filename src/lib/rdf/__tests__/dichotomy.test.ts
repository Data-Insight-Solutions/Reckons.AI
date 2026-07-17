/**
 * Dichotomy detection (kb:dichotomy).
 *
 * The metric drives review: a CONFLICT is fixed before a merge, a natural DICHOTOMY is preserved
 * through one, so mislabelling one as the other sends the reviewer the wrong way. And the two
 * gates matter — divergence on a stub, or on a structural link, is noise. These assert both.
 */
import { describe, it, expect } from 'vitest';
import { findDichotomies, dichotomyNodeKeys } from '../dichotomy';
import type { Statement } from '../types';

const KPRED = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
let n = 0;

function st(s: string, p: string, o: string, oIsIri = false): Statement {
  n += 1;
  return {
    id: `s${n}`,
    s: { kind: 'iri', value: s },
    p: { kind: 'iri', value: p },
    o: oIsIri ? { kind: 'iri', value: o } : { kind: 'literal', value: o },
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'x',
    confidence: 1,
    status: 'confirmed',
    createdAt: n,
    updatedAt: n,
  } as Statement;
}

/** A well-identified person: type + label + several facts → identity clears the gate. */
function person(iri: string, extra: Statement[]): Statement[] {
  return [
    st(iri, RDF_TYPE, 'urn:kbase:type/Person', true),
    st(iri, RDFS_LABEL, 'Alex'),
    st(iri, `${KPRED}note`, 'joined 2021'),
    ...extra,
  ];
}

describe('findDichotomies', () => {
  it('flags the sales-vs-technical case as a natural DICHOTOMY (role can coexist)', () => {
    const A = 'urn:kbase:person/alex';
    const d = findDichotomies(person(A, [st(A, `${KPRED}role`, 'sales team'), st(A, `${KPRED}role`, 'technical resource')]));
    expect(d).toHaveLength(1);
    expect(d[0].kind).toBe('dichotomy'); // role is multi-valued — both can be true
    expect(d[0].values.sort()).toEqual(['sales team', 'technical resource']);
  });

  it('flags divergent has-status as a CONFLICT (single-valued — one must be wrong)', () => {
    const A = 'urn:kbase:person/alex';
    const d = findDichotomies(person(A, [st(A, `${KPRED}has-status`, 'active'), st(A, `${KPRED}has-status`, 'departed')]));
    expect(d).toHaveLength(1);
    expect(d[0].kind).toBe('conflict');
  });

  it('GATE 1: divergence on a bare stub (no type, no label) is NOT flagged', () => {
    const S = 'urn:kbase:thing/x';
    // Two roles but the entity is barely identified — identity below the gate.
    const d = findDichotomies([st(S, `${KPRED}role`, 'a'), st(S, `${KPRED}role`, 'b')]);
    expect(d).toHaveLength(0);
  });

  it('GATE 2: many structural links (has-file, relates-to) are NOT a dichotomy', () => {
    const F = 'urn:kbase:feature/thing';
    const d = findDichotomies([
      st(F, RDF_TYPE, 'urn:kbase:type/Feature', true),
      st(F, RDFS_LABEL, 'Thing'),
      st(F, `${KPRED}note`, 'x'),
      st(F, `${KPRED}has-file`, 'src/a.ts'),
      st(F, `${KPRED}has-file`, 'src/b.ts'),
      st(F, `${KPRED}relates-to`, 'urn:kbase:concept/other', true),
    ]);
    expect(d).toHaveLength(0); // structural fan-out is normal, not tension
  });

  it('a single value is not a dichotomy', () => {
    const A = 'urn:kbase:person/alex';
    expect(findDichotomies(person(A, [st(A, `${KPRED}role`, 'sales')]))).toHaveLength(0);
  });

  it('ignores rejected/superseded statements — a resolved divergence is not a divergence', () => {
    const A = 'urn:kbase:person/alex';
    const stmts = person(A, [st(A, `${KPRED}role`, 'sales'), { ...st(A, `${KPRED}role`, 'technical'), status: 'rejected' } as Statement]);
    expect(findDichotomies(stmts)).toHaveLength(0);
  });

  it('conflicts sort before natural dichotomies (fix-first ordering)', () => {
    const A = 'urn:kbase:person/a', B = 'urn:kbase:person/b';
    const d = findDichotomies([
      ...person(A, [st(A, `${KPRED}role`, 'x'), st(A, `${KPRED}role`, 'y')]), // dichotomy
      ...person(B, [st(B, `${KPRED}has-status`, 'p'), st(B, `${KPRED}has-status`, 'q')]), // conflict
    ]);
    expect(d[0].kind).toBe('conflict');
  });

  it('dichotomyNodeKeys returns filterable keys, deduped', () => {
    const A = 'urn:kbase:person/alex';
    const keys = dichotomyNodeKeys(person(A, [st(A, `${KPRED}role`, 'a'), st(A, `${KPRED}role`, 'b'), st(A, `${KPRED}description`, 'c'), st(A, `${KPRED}description`, 'd')]));
    expect(keys).toHaveLength(1); // two divergent predicates, one entity → one node key
  });
});
