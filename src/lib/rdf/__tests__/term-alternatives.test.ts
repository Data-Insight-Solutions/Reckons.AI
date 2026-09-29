/**
 * Alternatives per triple position (F99.5).
 *
 * THE CASE THIS EXISTS FOR IS MATT'S OWN. On 2026-09-10 he met a node called "high" in his graph
 * and only worked out later that it was a priority value. graph-lint now refuses that shape in the
 * corpus; the first test below is the same catch offered at REVIEW time, as a correction, before it
 * is ever written.
 *
 * Everything here is grounded: a candidate is something the graph already contains, so the tests
 * assert on evidence ("used with this predicate before") rather than on similarity scores.
 */
import { describe, it, expect } from 'vitest';
import { SHORTLIST, alternativesFor, alternativesForStatement } from '../term-alternatives';
import type { Statement } from '../types';

const KB = 'urn:kbase:concept/';
const P = 'urn:kbase:predicate/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

let n = 0;
function st(s: string, p: string, o: string, oKind: 'iri' | 'literal' = 'iri'): Statement {
  return {
    id: `s${++n}`, sourceId: 'test', confidence: 1, status: 'confirmed',
    s: { kind: 'iri', value: s }, p: { kind: 'iri', value: p },
    o: { kind: oKind, value: o },
    g: { kind: 'iri', value: 'urn:g' }, createdAt: 1, updatedAt: 1,
  } as Statement;
}

describe('the value-hub correction — Matt\'s "high" node', () => {
  const vocab = new Set(['high', 'medium', 'low']);

  it('offers the LITERAL as the top alternative when an entity is really a value', () => {
    const bad = st(`${KB}thing`, `${P}priority`, `${KB}high`);
    const alts = alternativesFor(bad, 'object', [bad], { vocabularyValues: vocab });
    expect(alts[0].term.kind).toBe('literal');
    expect(alts[0].term.value).toBe('high');
    expect(alts[0].reason).toMatch(/value from a declared vocabulary/);
  });

  it('explains the consequence, not just that it is wrong', () => {
    const bad = st(`${KB}thing`, `${P}priority`, `${KB}high`);
    const alts = alternativesFor(bad, 'object', [bad], { vocabularyValues: vocab });
    // A reviewer needs to know why it matters: a hub reads like a key concept.
    expect(alts[0].reason).toMatch(/hub|key concept/);
  });

  it('does NOT offer it when the object is already a literal', () => {
    const good = st(`${KB}thing`, `${P}priority`, 'high', 'literal');
    const alts = alternativesFor(good, 'object', [good], { vocabularyValues: vocab });
    expect(alts.some((a) => a.term.kind === 'literal' && a.term.value === 'high')).toBe(false);
  });

  it('does not fire for an ordinary entity whose name is not a declared value', () => {
    const fine = st(`${KB}a`, `${P}depends-on`, `${KB}b`);
    const alts = alternativesFor(fine, 'object', [fine], { vocabularyValues: vocab });
    expect(alts.every((a) => a.term.kind === 'iri')).toBe(true);
  });
});

describe('subject and object alternatives come from the graph', () => {
  const graph = [
    st(`${KB}ava-lions`, RDFS_LABEL, 'Ava Lions Club', 'literal'),
    st(`${KB}ava-lions-club`, RDFS_LABEL, 'Ava Lions Club', 'literal'),
    st(`${KB}ava-growers`, RDFS_LABEL, 'Ava Growers Project', 'literal'),
    st(`${KB}food-tokens`, `${P}run-by`, `${KB}ava-lions`),
    st(`${KB}market-day`, `${P}run-by`, `${KB}ava-growers`),
  ];

  it('offers a same-named entity first — these are probably one thing under two IRIs', () => {
    const target = st(`${KB}food-tokens`, `${P}run-by`, `${KB}ava-lions`);
    const alts = alternativesFor(target, 'object', [...graph, target]);
    expect(alts[0].term.value).toBe(`${KB}ava-lions-club`);
    expect(alts[0].reason).toMatch(/same name/);
  });

  it('offers an entity already used in this position with this predicate', () => {
    const target = st(`${KB}new-program`, `${P}run-by`, `${KB}someone-else`);
    const alts = alternativesFor(target, 'object', [...graph, target]);
    const labels = alts.map((a) => a.label);
    expect(labels).toContain('Ava Growers Project');
    const growers = alts.find((a) => a.label === 'Ava Growers Project')!;
    expect(growers.reason).toMatch(/appears in this position with "run-by"/);
  });

  it('uses the label, not the IRI, so a reviewer reads words', () => {
    const target = st(`${KB}food-tokens`, `${P}run-by`, `${KB}ava-lions`);
    const alts = alternativesFor(target, 'object', [...graph, target]);
    expect(alts[0].label).toBe('Ava Lions Club');
  });

  it('never offers the term that is already there', () => {
    const target = st(`${KB}food-tokens`, `${P}run-by`, `${KB}ava-lions`);
    const alts = alternativesFor(target, 'object', [...graph, target]);
    expect(alts.every((a) => a.term.value !== `${KB}ava-lions`)).toBe(true);
  });
});

describe('predicate alternatives', () => {
  const graph = [
    st(`${KB}f1`, `${P}has-status`, 'planned', 'literal'),
    st(`${KB}f1`, `${P}priority`, 'high', 'literal'),
    st(`${KB}f1`, `${P}depends-on`, `${KB}f2`),
    st(`${KB}f9`, `${P}has-status-note`, 'x', 'literal'),
  ];

  it('offers predicates already used on THIS subject first', () => {
    const target = st(`${KB}f1`, `${P}state`, 'planned', 'literal');
    const alts = alternativesFor(target, 'predicate', [...graph, target]);
    expect(alts[0].reason).toMatch(/already used on this subject/);
  });

  it('offers a predicate that shares wording, with its usage count as the evidence', () => {
    const target = st(`${KB}f9`, `${P}status`, 'x', 'literal');
    const alts = alternativesFor(target, 'predicate', [...graph, target]);
    const shared = alts.find((a) => a.label.includes('status'));
    expect(shared?.reason).toMatch(/shares wording|already used/);
  });

  it('offers nothing when no predicate relates at all', () => {
    const lonely = st(`${KB}zz`, `${P}quixotic`, 'v', 'literal');
    expect(alternativesFor(lonely, 'predicate', [lonely])).toEqual([]);
  });
});

describe('the shortlist stays short', () => {
  it('caps the list, because a long list is a wall rather than a help', () => {
    const many = Array.from({ length: 40 }, (_, i) => st(`${KB}e${i}`, `${P}run-by`, `${KB}x`));
    const target = st(`${KB}new`, `${P}run-by`, `${KB}y`);
    expect(alternativesFor(target, 'object', [...many, target]).length).toBeLessThanOrEqual(SHORTLIST);
  });

  it('reports a weight so an order that looks wrong can be argued with', () => {
    const graph = [st(`${KB}a`, RDFS_LABEL, 'Thing', 'literal'), st(`${KB}b`, RDFS_LABEL, 'Thing', 'literal')];
    const target = st(`${KB}a`, `${P}p`, `${KB}x`);
    const alts = alternativesFor(target, 'subject', [...graph, target]);
    for (const a of alts) expect(typeof a.weight).toBe('number');
  });
});

describe('all three positions at once, for one click', () => {
  it('returns a shortlist per position', () => {
    const graph = [
      st(`${KB}a`, RDFS_LABEL, 'A', 'literal'),
      st(`${KB}a`, `${P}rel`, `${KB}b`),
      st(`${KB}c`, `${P}rel`, `${KB}b`),
    ];
    const target = st(`${KB}a`, `${P}rel`, `${KB}b`);
    const out = alternativesForStatement(target, [...graph, target]);
    expect(Object.keys(out).sort()).toEqual(['object', 'predicate', 'subject']);
    for (const pos of ['subject', 'predicate', 'object'] as const) {
      expect(Array.isArray(out[pos])).toBe(true);
    }
  });

  it('every alternative carries a human-readable reason, never a bare score', () => {
    const graph = [st(`${KB}a`, RDFS_LABEL, 'Same', 'literal'), st(`${KB}b`, RDFS_LABEL, 'Same', 'literal')];
    const target = st(`${KB}a`, `${P}p`, `${KB}q`);
    const out = alternativesForStatement(target, [...graph, target]);
    for (const list of Object.values(out)) {
      for (const a of list) expect(a.reason.length, JSON.stringify(a)).toBeGreaterThan(10);
    }
  });
});
