/**
 * F51 review-anchored generation — the grounding constraint.
 * Every generated sentence must trace to a CONFIRMED triple, or it is hallucination at the render
 * step. Uncited, dangling, and unconfirmed citations are all caught.
 */
import { describe, it, expect } from 'vitest';
import {
  validateGeneration,
  isFullyGrounded,
  statementsById,
  generationGroundingSummary,
  type GroundedSentence,
} from '../generation-grounding';
import type { Statement, ReviewStatus } from '../types';

function st(id: string, status: ReviewStatus = 'confirmed'): Statement {
  return {
    id,
    s: { kind: 'iri', value: `urn:kbase:concept/${id}` },
    p: { kind: 'iri', value: 'urn:kbase:predicate/note' },
    o: { kind: 'literal', value: id },
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'x',
    confidence: 1,
    status,
    createdAt: 1,
    updatedAt: 1,
  } as Statement;
}

const graph = statementsById([st('c1'), st('c2'), st('pending1', 'pending'), st('rejected1', 'rejected')]);
const sent = (text: string, citations: string[]): GroundedSentence => ({ text, citations });

describe('validateGeneration — every sentence traces to a confirmed triple', () => {
  it('a fully-grounded generation has no violations', () => {
    const gen = [sent('Alpha is blue.', ['c1']), sent('Beta ships Friday.', ['c2'])];
    expect(validateGeneration(gen, graph)).toEqual([]);
    expect(isFullyGrounded(gen, graph)).toBe(true);
  });

  it('an uncited sentence is a violation — the hallucination case', () => {
    const v = validateGeneration([sent('Invented claim with no source.', [])], graph);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('uncited');
  });

  it('a citation to a non-existent statement is dangling', () => {
    const v = validateGeneration([sent('x', ['does-not-exist'])], graph);
    expect(v[0].kind).toBe('dangling-citation');
  });

  it('a citation to a non-confirmed statement is rejected (anchor to REVIEWED facts only)', () => {
    expect(validateGeneration([sent('x', ['pending1'])], graph)[0].kind).toBe('unconfirmed-citation');
    expect(validateGeneration([sent('x', ['rejected1'])], graph)[0].kind).toBe('unconfirmed-citation');
  });

  it('one confirmed anchor is enough — a good citation plus a weak one is still grounded', () => {
    // c1 is confirmed, pending1 is not; the sentence is anchored, so no cry-wolf.
    expect(validateGeneration([sent('x', ['c1', 'pending1'])], graph)).toEqual([]);
  });

  it('a sentence anchored to NOTHING confirmed reports each bad citation', () => {
    const v = validateGeneration([sent('x', ['pending1', 'does-not-exist'])], graph);
    expect(v).toHaveLength(2);
    expect(v.map((x) => x.kind).sort()).toEqual(['dangling-citation', 'unconfirmed-citation']);
  });
});

describe('summary', () => {
  it('reports fully grounded', () => {
    expect(generationGroundingSummary([sent('a', ['c1'])], graph)).toMatch(/grounded in confirmed/);
  });
  it('warns not to publish when ungrounded', () => {
    expect(generationGroundingSummary([sent('a', [])], graph)).toMatch(/do not publish/i);
  });
  it('handles empty', () => {
    expect(generationGroundingSummary([], graph)).toMatch(/nothing/i);
  });
});
