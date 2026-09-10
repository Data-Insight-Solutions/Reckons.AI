import { describe, it, expect, afterEach } from 'vitest';
import {
  altitudeFromValues,
  surveyAltitudes,
  acceptedAltitudes,
  decidedPredicates,
  ALTITUDE_PREDICATE,
} from '../altitude-proposals';
import { altitudeOf, isClassified, setUserAltitudes } from '../fact-altitude';
import type { Statement } from '../types';

let n = 0;
function st(predicate: string, object: string | { iri: string }, status: Statement['status'] = 'confirmed'): Statement {
  return {
    id: `s${++n}`,
    s: { kind: 'iri', value: 'urn:kbase:concept/thing' },
    p: { kind: 'iri', value: predicate },
    o: typeof object === 'string'
      ? { kind: 'literal', value: object }
      : { kind: 'iri', value: object.iri },
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'src',
    confidence: 1,
    status,
    createdAt: 0,
    updatedAt: 0,
  };
}

// The classifier holds module state; never let one test's overrides leak into the next.
afterEach(() => setUserAltitudes(new Map()));

const lits = (...values: string[]) => values.map((value) => ({ literal: true, value }));
const iris = (...values: string[]) => values.map((value) => ({ literal: false, value }));

describe('altitudeFromValues — only the object shape decides', () => {
  it('reads timestamps as logs', () => {
    expect(altitudeFromValues(lits('2026-08-28', '2026-01-02T10:00'))?.altitude).toBe('log');
  });

  it('reads paths and URLs as records', () => {
    expect(altitudeFromValues(lits('src/lib/rdf/diff.ts'))?.altitude).toBe('record');
    expect(altitudeFromValues(lits('https://example.com/a'))?.altitude).toBe('record');
  });

  it('reads numbers as evidence — a measurement', () => {
    expect(altitudeFromValues(lits('42', '3.5', '-7'))?.altitude).toBe('evidence');
  });

  it('reads entity-to-entity links as records', () => {
    expect(altitudeFromValues(iris('urn:kbase:concept/a', 'urn:kbase:concept/b'))?.altitude).toBe('record');
  });

  it('routes prose UPWARD to judgment, never down', () => {
    const prose = 'This is a long sentence that states a verdict about how good something is.';
    expect(altitudeFromValues(lits(prose))?.altitude).toBe('judgment');
  });

  // The most important behaviour in the module: it is allowed to have no answer.
  it('declines when the values do not agree', () => {
    expect(altitudeFromValues(lits('2026-08-28', 'a short label'))).toBeNull();
    expect(altitudeFromValues([])).toBeNull();
  });

  it('one counter-example is enough to withdraw a shape', () => {
    expect(altitudeFromValues(lits('2026-08-28', '2026-08-29', 'not a date at all'))).toBeNull();
  });

  it('does not call a mixed literal/IRI predicate a structural link', () => {
    expect(altitudeFromValues([...iris('urn:kbase:concept/a'), ...lits('42')])).toBeNull();
  });
});

describe('surveyAltitudes', () => {
  const KP = 'urn:kbase:predicate/';
  const graph = () => [
    st(`${KP}seen-on`, '2026-08-28'),
    st(`${KP}seen-on`, '2026-08-27'),
    st(`${KP}has-property`, 'blue'),
    st(`${KP}has-property`, 'a much longer piece of prose that will not match the short label'),
    st(`${KP}depends-on`, { iri: 'urn:kbase:concept/other' }),   // already in the built-in table
  ];

  it('proposes only where the shape is decisive', () => {
    const survey = surveyAltitudes(graph());
    expect(survey.proposals.map((p) => p.predicate)).toEqual([`${KP}seen-on`]);
    expect(survey.proposals[0].altitude).toBe('log');
  });

  it('reports what it could not settle rather than guessing', () => {
    const survey = surveyAltitudes(graph());
    const unsettled = survey.unsettled.find((u) => u.predicate === `${KP}has-property`);
    expect(unsettled).toBeDefined();
    expect(unsettled!.sample.length).toBeGreaterThan(0);
  });

  it('leaves predicates the built-in table already covers alone', () => {
    const survey = surveyAltitudes(graph());
    const touched = [...survey.proposals, ...survey.unsettled].map((p) => p.predicate);
    expect(touched).not.toContain(`${KP}depends-on`);
  });

  it('orders by blast radius — most-used first', () => {
    // Neutral invented names on purpose: anything ending in a classifying suffix (-date, -at,
    // -on...) is already covered by the built-in table and never reaches the proposer.
    const many = [
      st(`${KP}alpha`, '2026-08-28'),
      ...Array.from({ length: 5 }, () => st(`${KP}beta`, '2026-08-28')),
    ];
    const proposals = surveyAltitudes(many).proposals;
    expect(proposals).toHaveLength(2);
    expect(proposals[0].predicate).toBe(`${KP}beta`);
  });

  it('never re-asks a settled question', () => {
    const survey = surveyAltitudes(graph(), { alreadyDecided: new Set([`${KP}seen-on`]) });
    expect(survey.proposals).toHaveLength(0);
  });

  it('carries the use count, because accepting one changes that many facts', () => {
    expect(surveyAltitudes(graph()).proposals[0].uses).toBe(2);
  });
});

describe('accepted classifications change what the graph says', () => {
  const P = 'urn:kbase:predicate/has-property';

  it('an unclassified predicate defaults to judgment and reads as unclassified', () => {
    const fact = st(P, 'blue');
    expect(altitudeOf(fact)).toBe('judgment');
    expect(isClassified(fact)).toBe(false);
  });

  it('a user-accepted classification outranks the default, and counts as coverage', () => {
    setUserAltitudes(new Map([[P, 'record']]));
    const fact = st(P, 'blue');
    expect(altitudeOf(fact)).toBe('record');
    expect(isClassified(fact)).toBe(true);
  });

  it('reads only ACCEPTED facts out of the graph', () => {
    const accepted = acceptedAltitudes([
      st(ALTITUDE_PREDICATE, 'log', 'confirmed'),
      { ...st(ALTITUDE_PREDICATE, 'decision', 'rejected'), s: { kind: 'iri', value: 'urn:p/b' } },
      { ...st(ALTITUDE_PREDICATE, 'decision', 'pending'), s: { kind: 'iri', value: 'urn:p/c' } },
    ]);
    expect(accepted.get('urn:kbase:concept/thing')).toBe('log');
    expect(accepted.has('urn:p/b')).toBe(false);   // the user said NO to this one
    expect(accepted.has('urn:p/c')).toBe(false);   // still a proposal, not an answer
  });

  it('ignores a value that is not an altitude at all', () => {
    expect(acceptedAltitudes([st(ALTITUDE_PREDICATE, 'nonsense', 'confirmed')]).size).toBe(0);
  });

  it('counts a rejected classification as decided, so it is never proposed again', () => {
    const decided = decidedPredicates([st(ALTITUDE_PREDICATE, 'log', 'rejected')]);
    expect(decided.has('urn:kbase:concept/thing')).toBe(true);
  });
});
