import { describe, it, expect } from 'vitest';
import { trustDecision, shouldAutoTrust, statusForNewFact } from '../auto-trust';
import { CAPTURED_NOTE, EXTRACTED_AT, EXTRACTED_FROM } from '../captured-notes';
import type { Statement } from '../types';

let n = 0;
function st(
  predicate: string,
  object: { kind: 'literal' | 'iri'; value: string },
  extra: Partial<Statement> = {},
): Statement {
  return {
    id: `t${n++}`,
    s: { kind: 'iri', value: 'urn:kbase:concept/orange-logic' },
    p: { kind: 'iri', value: predicate },
    o: object,
    g: { kind: 'iri', value: 'urn:kbase:graph/personal-notes' },
    sourceId: 'src',
    confidence: 1,
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  } as Statement;
}

const lit = (value: string) => ({ kind: 'literal' as const, value });
const iri = (value: string) => ({ kind: 'iri' as const, value });

describe('the capture path asserts things about itself', () => {
  it('a dictated note is a log — nobody can confirm what they themselves said', () => {
    const note = st(CAPTURED_NOTE, lit('I have a new idea for Recon\'s AI.'));
    expect(trustDecision(note).trusted).toBe(true);
  });

  it('when extraction ran is a log', () => {
    expect(shouldAutoTrust(st(EXTRACTED_AT, lit('2026-08-27T16:56:41.444Z')))).toBe(true);
  });

  it('which sentence a triple came from is settled without a human', () => {
    // Trusted for WHO WROTE IT, not its altitude: it classifies as a `record`, and records in
    // general still need a human (kpred:relates-to is a record).
    const link = st(EXTRACTED_FROM, iri('urn:kbase:concept/note-2026-08-27'));
    expect(trustDecision(link)).toEqual({ trusted: true, reason: 'system-asserted' });
  });
});

describe('what a model READ OUT of a note still needs a human', () => {
  it('"Orange Logic is an enterprise DAM" is not auto-trusted', () => {
    // The worked example from the brief. Mundane is not the same as verified, and the claim came
    // from a language model reading a possibly-misheard transcript.
    const claim = st('urn:kbase:predicate/is-a', lit('Enterprise DAM'));
    expect(trustDecision(claim)).toEqual({ trusted: false, reason: 'needs-human' });
  });

  it('a record predicate NOT on the capture allowlist still needs a human', () => {
    // The guard that keeps the allowlist from becoming "records are fine".
    expect(shouldAutoTrust(st('urn:kbase:predicate/relates-to', iri('urn:kbase:concept/x')))).toBe(false);
  });

  it('an unknown predicate is never auto-trusted', () => {
    // Unclassified predicates default to `judgment` in the altitude table. Inferring trust from a
    // predicate we do not recognise would auto-confirm exactly the facts we understand least.
    expect(shouldAutoTrust(st('urn:kbase:predicate/invented-by-a-model', lit('x')))).toBe(false);
  });

  it('a partial fact is always a human question, whatever its predicate', () => {
    const partial = st(EXTRACTED_AT, lit('?'), { needsObject: true, question: 'when?' });
    expect(trustDecision(partial).trusted).toBe(false);
  });
});

describe('statusForNewFact', () => {
  it('confirms bookkeeping and queues claims', () => {
    expect(statusForNewFact(st(EXTRACTED_AT, lit('2026-08-27T00:00:00Z')))).toBe('confirmed');
    expect(statusForNewFact(st('urn:kbase:predicate/is-a', lit('Enterprise DAM')))).toBe('pending');
  });
});
