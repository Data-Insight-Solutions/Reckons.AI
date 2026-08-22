/**
 * F139 altitude — how much does this fact matter, and what does it decide?
 * The discriminating test: if this fact were wrong, what would we do differently?
 */
import { describe, it, expect } from 'vitest';
import {
  altitudeOf, reviewAltitude, isOpenDecision, isClassified,
  liftedAltitudes, censusByAltitude, explainAltitude, isAltitude, ALTITUDE_RANK,
} from '../fact-altitude';
import type { Statement } from '../types';

const KPRED = 'urn:kbase:predicate/';
let n = 0;
function st(p: string, o: string, extra: Partial<Statement> = {}): Statement {
  n += 1;
  return {
    id: extra.id ?? `s${n}`,
    s: { kind: 'iri', value: extra.s?.value ?? 'urn:kbase:concept/thing' },
    p: { kind: 'iri', value: p },
    o: { kind: 'literal', value: o },
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'x',
    confidence: 1,
    status: 'pending',
    createdAt: n,
    updatedAt: n,
    ...extra,
  } as Statement;
}

describe('altitudeOf', () => {
  it('classifies the five levels from the predicate', () => {
    expect(altitudeOf(st(`${KPRED}open-question`, 'Which way?'))).toBe('decision');
    expect(altitudeOf(st(`${KPRED}has-status`, 'functional'))).toBe('judgment');
    expect(altitudeOf(st(`${KPRED}measured`, '92.3% coverage'))).toBe('evidence');
    expect(altitudeOf(st(`${KPRED}has-file`, 'src/lib/rdf/types.ts'))).toBe('record');
    expect(altitudeOf(st(`${KPRED}progress`, 'REMEDIATED 2026-08-16. Removed addons.'))).toBe('log');
  });

  it('has-status is a JUDGMENT even though tests can be run — F135.2', () => {
    // "STATUS IS A QUALITATIVE CLAIM EVEN WHEN IT RESTS ON CALCULABLE EVIDENCE."
    expect(altitudeOf(st(`${KPRED}has-status`, 'production'))).toBe('judgment');
  });

  it('THE TRAP: the predicate table beats the log-shaped literal', () => {
    // kpred:evidence "MEASURED 2026-08-15, and it is worse than it reads..." opens exactly like a
    // log and is the load-bearing measurement behind a planned feature. Shape must not win.
    const s = st(`${KPRED}evidence`, 'MEASURED 2026-08-15, and it is worse than it reads.');
    expect(altitudeOf(s)).toBe('evidence');
  });

  it('applies the shape rule ONLY to unclassified predicates', () => {
    expect(altitudeOf(st('urn:other:pred/whatever', 'SHIPPED the thing yesterday'))).toBe('log');
    expect(altitudeOf(st('urn:other:pred/whatever', '2026-08-19'))).toBe('log');
  });

  it('defaults unclassified to judgment — fails UPWARD so a decision is never hidden', () => {
    const s = st('urn:novel:pred/unheard-of', 'some prose nobody classified');
    expect(altitudeOf(s)).toBe('judgment');
    expect(isClassified(s)).toBe(false);
  });

  it('a partial fact is always a decision — an open hole is a question', () => {
    expect(altitudeOf(st('urn:novel:pred/x', '?', { needsObject: true }))).toBe('decision');
  });

  it('classifies whole namespaces, not just terms (nav/story/schema/prov)', () => {
    expect(altitudeOf(st('urn:reckons:nav/layer', '2'))).toBe('record');
    expect(altitudeOf(st('urn:reckons:story/partOf', 'urn:x'))).toBe('record');
    expect(altitudeOf(st('http://www.w3.org/ns/prov#wasDerivedFrom', 'urn:x'))).toBe('record');
    expect(altitudeOf(st('http://purl.org/dc/terms/created', '2026-01-01'))).toBe('log');
  });

  it('a suffix rule lifts prose out of a structural namespace', () => {
    expect(altitudeOf(st('urn:reckons:story/content', 'A long explanation.'))).toBe('judgment');
    expect(altitudeOf(st('urn:reckons:story/order', '3'))).toBe('record');
  });

  it('reads the everyday decision vocabulary as decisions', () => {
    expect(altitudeOf(st(`${KPRED}ruled-out-by`, 'kb:lake-george', { o: { kind: 'iri', value: 'kb:lake-george' } }))).toBe('decision');
    expect(altitudeOf(st(`${KPRED}decides`, 'kb:the-weekend'))).toBe('decision');
  });
});

describe('reviewAltitude — authority can LIFT, never lower', () => {
  it('lifts a user-authority record to judgment so it cannot be hidden', () => {
    // Minting a feature looks like bookkeeping but is an act of authorship (verifiability.ts).
    const s = st(`${KPRED}feature-id`, 'F140');
    expect(altitudeOf(s)).toBe('record');
    expect(reviewAltitude(s)).toBe('judgment');
  });

  it('never pushes a decision DOWN', () => {
    const s = st(`${KPRED}principle`, 'Agents propose, humans settle.');
    expect(reviewAltitude(s)).toBe('decision');
  });

  it('leaves a non-authority record alone', () => {
    expect(reviewAltitude(st('urn:reckons:nav/order', '1'))).toBe('record');
  });
});

describe('isOpenDecision — a settled decision is context, not work', () => {
  it('separates the open question from the decision already made', () => {
    expect(isOpenDecision(st(`${KPRED}open-question`, 'Which way?'))).toBe(true);
    expect(isOpenDecision(st(`${KPRED}decided`, 'Two axes, not a longer enum.'))).toBe(false);
  });

  it('a partial fact is open', () => {
    expect(isOpenDecision(st(`${KPRED}anything`, '?', { needsObject: true }))).toBe(true);
  });
});

describe('liftedAltitudes — a log under a live decision is a deciding factor', () => {
  const subj = { kind: 'iri' as const, value: 'urn:kbase:concept/f139' };
  const other = { kind: 'iri' as const, value: 'urn:kbase:concept/unrelated' };

  it('lifts a low fact to the highest OPEN altitude on its own subject', () => {
    const q = st(`${KPRED}open-question`, 'Which way?', { s: subj, id: 'q' });
    const log = st(`${KPRED}progress`, 'WIRED 2026-08-01.', { s: subj, id: 'l' });
    const lifted = liftedAltitudes([q, log]);
    expect(altitudeOf(log)).toBe('log');
    expect(lifted.get('l')).toBe('decision');
  });

  it('does NOT lift a log whose subject has no open decision', () => {
    const settled = st(`${KPRED}decided`, 'Done deal.', { s: other, id: 'd' });
    const log = st(`${KPRED}progress`, 'WIRED.', { s: other, id: 'l2' });
    expect(liftedAltitudes([settled, log]).get('l2')).toBe('log');
  });

  it('never lowers a fact that is already higher', () => {
    const q = st(`${KPRED}open-question`, 'Q?', { s: subj, id: 'q2' });
    const dec = st(`${KPRED}principle`, 'P', { s: subj, id: 'p2' });
    expect(liftedAltitudes([q, dec]).get('p2')).toBe('decision');
  });
});

describe('censusByAltitude', () => {
  it('reports coverage and the suppressed share honestly', () => {
    const c = censusByAltitude([
      st(`${KPRED}open-question`, 'Q?'),
      st(`${KPRED}has-file`, 'a.ts'),
      st(`${KPRED}progress`, 'DONE.'),
      st('urn:novel:pred/x', 'prose'),
    ]);
    expect(c.total).toBe(4);
    expect(c.classified).toBe(3);
    expect(c.counts.record + c.counts.log).toBe(2);
    expect(c.suppressedShare).toBeCloseTo(0.5);
  });
});

describe('metadata', () => {
  it('ranks decision above log and explains itself', () => {
    expect(ALTITUDE_RANK.decision).toBeGreaterThan(ALTITUDE_RANK.log);
    expect(explainAltitude('log')).toContain('nothing');
    expect(isAltitude('decision')).toBe(true);
    expect(isAltitude('nonsense')).toBe(false);
  });
});
