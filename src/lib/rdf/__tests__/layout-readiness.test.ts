import { describe, it, expect } from 'vitest';
import { layoutReadiness } from '../layout-readiness';
import { type Statement, type ReviewStatus } from '../types';

const DUE_AT = 'urn:kbase:predicate/due-at';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const BROADER = 'http://www.w3.org/2004/02/skos/core#broader';
const DEPENDS_ON = 'urn:kbase:predicate/depends-on';
const ORDER = 'urn:reckons:nav/order';

let n = 0;

function fact(
  subject: string,
  predicate: string,
  literal: string,
  opts: { status?: ReviewStatus } = {},
): Statement {
  return {
    id: `s${++n}`,
    s: { kind: 'iri', value: subject },
    p: { kind: 'iri', value: predicate },
    o: { kind: 'literal', value: literal },
    g: { kind: 'iri', value: 'urn:kbase:source/manual' },
    sourceId: 'manual',
    confidence: 1,
    status: opts.status ?? 'confirmed',
    createdAt: 1_700_000_000_000,
    updatedAt: 0,
  };
}

function edge(
  subject: string,
  predicate: string,
  object: string,
  opts: { status?: ReviewStatus } = {},
): Statement {
  return {
    id: `s${++n}`,
    s: { kind: 'iri', value: subject },
    p: { kind: 'iri', value: predicate },
    o: { kind: 'iri', value: object },
    g: { kind: 'iri', value: 'urn:kbase:source/manual' },
    sourceId: 'manual',
    confidence: 1,
    status: opts.status ?? 'confirmed',
    createdAt: 1_700_000_000_000,
    updatedAt: 0,
  };
}

describe('layoutReadiness — time', () => {
  it('a space with 3 dated things of 10 reports time 3 of 10 with 7 undated', () => {
    const things = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'].map(
      (t) => `urn:kbase:concept/${t}`,
    );
    const stmts = things.map((t) => fact(t, LABEL, 'a thing'));
    stmts.push(
      fact(things[0], DUE_AT, '2026-01-01'),
      fact(things[4], DUE_AT, '2026-06-15'),
      fact(things[8], DUE_AT, '2027-03-01'),
    );
    const r = layoutReadiness(stmts);
    expect(r.total).toBe(10);
    expect(r.time).toEqual({ placeable: 3, total: 10, missing: 7, reason: 'undated' });
  });

  it('never counts the moment a fact was added as the thing being dated', () => {
    // Every fixture fact carries a createdAt; only the due-at ones are dates.
    const a = 'urn:kbase:concept/dated';
    const b = 'urn:kbase:concept/undated';
    const r = layoutReadiness([
      fact(a, DUE_AT, '2026-05-05'),
      fact(b, LABEL, 'no date anywhere'),
    ]);
    expect(r.time.placeable).toBe(1);
    expect(r.time.total).toBe(2);
    expect(r.time.missing).toBe(1);
  });

  it('an unparseable value is not a date', () => {
    const a = 'urn:kbase:concept/fuzzy';
    const r = layoutReadiness([fact(a, DUE_AT, 'sometime next year')]);
    expect(r.time.placeable).toBe(0);
  });
});

describe('layoutReadiness — tree', () => {
  it('one broader edge places exactly the two things it touches', () => {
    const t = [1, 2, 3, 4, 5].map((i) => `urn:kbase:concept/t${i}`);
    const stmts = t.map((x) => fact(x, LABEL, 'a thing'));
    stmts.push(edge(t[0], BROADER, t[1]));
    const r = layoutReadiness(stmts);
    expect(r.tree).toEqual({ placeable: 2, total: 5, missing: 3, reason: 'no-parent' });
  });

  it('a depends-on edge is a hierarchy edge too', () => {
    const t = [1, 2, 3].map((i) => `urn:kbase:concept/t${i}`);
    const stmts = t.map((x) => fact(x, LABEL, 'a thing'));
    stmts.push(edge(t[0], DEPENDS_ON, t[1]));
    const r = layoutReadiness(stmts);
    expect(r.tree.placeable).toBe(2);
    expect(r.tree.total).toBe(3);
  });
});

describe('layoutReadiness — arrange', () => {
  it('no stated order reports arrange 0 of N', () => {
    const t = [1, 2, 3, 4].map((i) => `urn:kbase:concept/t${i}`);
    const r = layoutReadiness(t.map((x) => fact(x, LABEL, 'a thing')));
    expect(r.arrange).toEqual({ placeable: 0, total: 4, missing: 4, reason: 'no-order' });
  });

  it('places exactly the things carrying an order', () => {
    const t = [1, 2, 3, 4].map((i) => `urn:kbase:concept/t${i}`);
    const stmts = t.map((x) => fact(x, LABEL, 'a thing'));
    stmts.push(fact(t[2], ORDER, '3'));
    const r = layoutReadiness(stmts);
    expect(r.arrange.placeable).toBe(1);
    expect(r.arrange.total).toBe(4);
    expect(r.arrange.missing).toBe(3);
  });
});

describe('layoutReadiness — review state and emptiness', () => {
  it('rejected facts are not about anything and place nothing', () => {
    const a = 'urn:kbase:concept/a';
    const b = 'urn:kbase:concept/b';
    const ghost = 'urn:kbase:concept/only-rejected';
    const r = layoutReadiness([
      fact(a, LABEL, 'a'),
      fact(b, LABEL, 'b'),
      fact(ghost, LABEL, 'a thing that was only ever proposed and rejected', { status: 'rejected' }),
      fact(a, DUE_AT, '2026-01-01', { status: 'rejected' }),
      edge(a, BROADER, b, { status: 'rejected' }),
      fact(b, ORDER, '1', { status: 'rejected' }),
    ]);
    expect(r.total).toBe(2);
    expect(r.time.placeable).toBe(0);
    expect(r.tree.placeable).toBe(0);
    expect(r.arrange.placeable).toBe(0);
  });

  it('an empty list gives zeros across the board', () => {
    const r = layoutReadiness([]);
    expect(r).toEqual({
      total: 0,
      time: { placeable: 0, total: 0, missing: 0, reason: 'undated' },
      tree: { placeable: 0, total: 0, missing: 0, reason: 'no-parent' },
      arrange: { placeable: 0, total: 0, missing: 0, reason: 'no-order' },
    });
  });
});
