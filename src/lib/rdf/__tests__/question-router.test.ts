/**
 * Question router (F91 phase 1).
 *
 * The property that matters: the graph that ALREADY KNOWS THE SUBJECT ranks first — that is the
 * strongest honest answer to "who could answer this?". And a graph with no overlap must NOT be
 * addressed, because routing to it is spam and, across owners, a privacy leak.
 */
import { describe, it, expect } from 'vitest';
import { routeQuestion, questionContext, addressees, type CandidateGraph } from '../question-router';
import type { Statement } from '../types';

const KPRED = 'urn:kbase:predicate/';
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

const ALICE = 'urn:kbase:person/alice';
const ACME = 'urn:kbase:org/acme';

describe('routeQuestion', () => {
  it('ranks the graph that KNOWS THE SUBJECT first', () => {
    const knowsAlice: CandidateGraph = { id: 'hr', name: 'HR', statements: [st(ALICE, `${KPRED}role`, 'engineer'), st(ALICE, RDFS_LABEL, 'Alice')] };
    const unrelated: CandidateGraph = { id: 'inventory', name: 'Inventory', statements: [st('urn:kbase:item/x', `${KPRED}count`, '5')] };

    const ranked = routeQuestion({ subject: ALICE, predicate: `${KPRED}salary` }, [unrelated, knowsAlice]);
    expect(ranked[0].id).toBe('hr');
    expect(ranked[0].signals.knowsSubject).toBe(true);
    expect(ranked[0].reason).toMatch(/this exact entity/);
  });

  it('a graph with NO overlap scores ~zero and is not addressed', () => {
    const unrelated: CandidateGraph = { id: 'weather', statements: [st('urn:kbase:city/london', `${KPRED}temp`, '12')] };
    const ranked = routeQuestion({ subject: ALICE, predicate: `${KPRED}salary` }, [unrelated]);
    expect(ranked[0].score).toBe(0);
    expect(addressees(ranked)).toHaveLength(0); // never spam an unrelated graph
  });

  it('uses neighbourhood overlap when the exact subject is absent', () => {
    // Neither graph has ALICE, but one is about her org.
    const aboutAcme: CandidateGraph = { id: 'orgdir', statements: [st('urn:kbase:person/bob', `${KPRED}works-at`, ACME, true), st(ACME, RDFS_LABEL, 'Acme')] };
    const empty: CandidateGraph = { id: 'blank', statements: [st('urn:kbase:x/y', `${KPRED}z`, '1')] };

    const q = { subject: ALICE, predicate: `${KPRED}role`, contextIris: [ACME] };
    const ranked = routeQuestion(q, [empty, aboutAcme]);
    expect(ranked[0].id).toBe('orgdir');
    expect(ranked[0].signals.contextOverlap).toBeGreaterThan(0);
  });

  it('predicate familiarity is a weak signal, below knowing the subject', () => {
    const knowsSubject: CandidateGraph = { id: 'a', statements: [st(ALICE, `${KPRED}note`, 'x')] };
    const speaksPredicate: CandidateGraph = { id: 'b', statements: [st('urn:kbase:person/carol', `${KPRED}salary`, '100')] };

    const ranked = routeQuestion({ subject: ALICE, predicate: `${KPRED}salary` }, [speaksPredicate, knowsSubject]);
    expect(ranked[0].id).toBe('a'); // knowing the subject wins over speaking the predicate
  });

  it('excludes the source graph from its own routing', () => {
    const source: CandidateGraph = { id: '__source__', statements: [st(ALICE, RDFS_LABEL, 'Alice')] };
    const other: CandidateGraph = { id: 'hr', statements: [st(ALICE, `${KPRED}role`, 'eng')] };
    const ranked = routeQuestion({ subject: ALICE, predicate: `${KPRED}salary` }, [source, other]);
    expect(ranked.every((r) => r.id !== '__source__')).toBe(true);
  });
});

describe('questionContext', () => {
  it('gathers the subject neighbourhood (IRIs + label terms) from the source graph', () => {
    const source = [
      st(ALICE, `${KPRED}works-at`, ACME, true),
      st(ALICE, RDFS_LABEL, 'Alice Anderson'),
      st(ACME, RDFS_LABEL, 'Acme Corporation'),
    ];
    const q = questionContext(ALICE, `${KPRED}salary`, source);
    expect(q.contextIris).toContain(ACME);
    expect(q.contextTerms).toContain('anderson'); // from Alice's own label
  });
});

describe('addressees', () => {
  it('caps how many graphs get the question — routing, not broadcast', () => {
    const scores = [
      { id: 'a', score: 0.9, signals: { knowsSubject: true, usesPredicate: true, contextOverlap: 1 }, reason: '' },
      { id: 'b', score: 0.5, signals: { knowsSubject: true, usesPredicate: false, contextOverlap: 0 }, reason: '' },
      { id: 'c', score: 0.3, signals: { knowsSubject: false, usesPredicate: false, contextOverlap: 0.5 }, reason: '' },
      { id: 'd', score: 0.2, signals: { knowsSubject: false, usesPredicate: false, contextOverlap: 0.3 }, reason: '' },
    ];
    expect(addressees(scores, 0.15, 3)).toHaveLength(3);
    expect(addressees(scores, 0.4)).toHaveLength(2);
  });
});
