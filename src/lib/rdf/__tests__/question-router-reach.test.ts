/**
 * F91 phase 2 — reach by consent, and external-graph provenance.
 *
 * Two properties this must not get wrong:
 *   1. A graph that has NOT opted in is never addressed, however related it is — a routed
 *      question must not trespass into a graph whose owner did not agree to receive it.
 *   2. An answer another graph returns is that party's CLAIM — it can never be machine-settled.
 */
import { describe, it, expect } from 'vitest';
import { graphAnswersQuestions, optedInCandidates, routeQuestion, addressees, type CandidateGraph } from '../question-router';
import { competentGate, inferVerifiability } from '../verifiability';
import type { Statement } from '../types';

const KPRED = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
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

const SUBJ = 'urn:kbase:concept/trust-system';

/** A graph that knows the subject well — highly related. `optedIn` toggles consent. */
function graph(id: string, optedIn: boolean): CandidateGraph {
  const stmts = [st(SUBJ, RDF_TYPE, 'urn:kbase:type/Feature', true), st(SUBJ, `${KPRED}confidence`, '0.9')];
  if (optedIn) stmts.push(st(`urn:reckons:graph/${id}`, `${KPRED}answers-questions`, 'true'));
  return { id, name: id, statements: stmts };
}

describe('reach by consent (opt-in registry)', () => {
  it('a graph that opted in answers questions; one that did not, does not', () => {
    expect(graphAnswersQuestions(graph('a', true))).toBe(true);
    expect(graphAnswersQuestions(graph('b', false))).toBe(false);
  });

  it('optedInCandidates drops the non-consenting graphs', () => {
    const kept = optedInCandidates([graph('a', true), graph('b', false), graph('c', true)]);
    expect(kept.map((g) => g.id).sort()).toEqual(['a', 'c']);
  });

  it('a highly-related graph that did NOT opt in is never addressed', () => {
    // Both graphs know the subject equally well; only consent differs.
    const consenting = graph('yes', true);
    const silent = graph('no', false);
    const reachable = optedInCandidates([consenting, silent]);
    const ranked = routeQuestion({ subject: SUBJ, predicate: `${KPRED}confidence` }, reachable);
    const addressed = addressees(ranked).map((r) => r.id);
    expect(addressed).toContain('yes');
    expect(addressed).not.toContain('no'); // consent, not relatedness, decides reach
  });

  it('an opt-in marker that was rejected does not count as consent', () => {
    const g = graph('x', true);
    // flip the opt-in statement to rejected
    const optIn = g.statements.find((s) => s.p.value === `${KPRED}answers-questions`)!;
    (optIn as any).status = 'rejected';
    expect(graphAnswersQuestions(g)).toBe(false);
  });
});

describe('external-graph provenance (a returned answer is another party\'s claim)', () => {
  it('a fact with answeredByGraph is classified external-graph', () => {
    const returned = { ...st(SUBJ, `${KPRED}confidence`, '0.95'), answeredByGraph: 'reckons-shipped' } as Statement;
    expect(inferVerifiability(returned)).toBe('external-graph');
  });

  it('external-graph is NEVER machine-settled — a human owns accepting another graph\'s word', () => {
    expect(competentGate('external-graph')).toBe('user');
    expect(competentGate('external-graph')).not.toBe('machine');
  });

  it('answeredByGraph outranks what the value happens to look like (provenance first)', () => {
    // A value that would otherwise infer as `code` (a path) is still external if a graph answered it.
    const looksLikeCode = { ...st(SUBJ, `${KPRED}has-file`, 'src/lib/rdf/types.ts'), answeredByGraph: 'other' } as Statement;
    expect(inferVerifiability(looksLikeCode)).toBe('external-graph');
  });
});
