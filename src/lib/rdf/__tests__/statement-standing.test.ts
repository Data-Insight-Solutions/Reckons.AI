/**
 * A statement's standing (F223.9 / kb:statement-standing).
 *
 * One pure function gives every statement a standing from fields it already has, with no new
 * review status: held, pending, proposed, question. And a node's standing is the standing
 * of the statements that touch it, with held winning.
 *
 * Synthetic data only: the subjects and options below are invented names, not real ones.
 */
import { describe, it, expect } from 'vitest';
import type { Statement } from '../types';
import { iri, lit } from '../types';
import { standingOf, nodeStanding } from '../statement-standing';
import { encodePortableMetadata, decodePortableMetadata } from '../portable-metadata';

const KP = 'urn:kbase:predicate/';
const KB = 'urn:kbase:concept/';

let n = 0;
function st(subject: string, status: Statement['status'], extra: Partial<Statement> = {}): Statement {
  return {
    id: `st${++n}`,
    s: iri(`${KB}${subject}`),
    p: iri(`${KP}relates-to`),
    o: iri(`${KB}other`),
    g: iri('urn:kbase:source/test'),
    sourceId: 'src',
    confidence: 1,
    status,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  };
}

describe('standingOf — one rule per kind', () => {
  it('a question is a question: needsObject outranks whatever the status says', () => {
    // The object is open, so there is nothing to hold or propose until an object exists.
    // Even a "confirmed" question is still a question.
    expect(standingOf(st('a', 'pending', { needsObject: true, o: lit('?') }))).toBe('question');
    expect(standingOf(st('b', 'confirmed', { needsObject: true, o: lit('?') }))).toBe('question');
  });

  it('confirmed is held', () => {
    expect(standingOf(st('a', 'confirmed'))).toBe('held');
  });

  it('refined is held', () => {
    expect(standingOf(st('a', 'refined'))).toBe('held');
  });

  it('pending with a proposal option is proposed', () => {
    expect(standingOf(st('a', 'pending', { proposalOption: 'option-b' }))).toBe('proposed');
  });

  it('pending with no option is pending', () => {
    expect(standingOf(st('a', 'pending'))).toBe('pending');
  });
});

describe('nodeStanding — the standing of the statements that touch a node', () => {
  it('a node touched by one held and one proposed statement is held', () => {
    const touched = [
      st('a', 'confirmed'),
      st('b', 'pending', { proposalOption: 'option-b' }),
    ];
    expect(nodeStanding(touched)).toBe('held');
  });

  it('a node touched only by questions is a question', () => {
    const touched = [
      st('a', 'pending', { needsObject: true, o: lit('?') }),
      st('b', 'pending', { needsObject: true, o: lit('?') }),
    ];
    expect(nodeStanding(touched)).toBe('question');
  });

  it('a node touched only by proposed statements is proposed', () => {
    const touched = [
      st('a', 'pending', { proposalOption: 'option-a' }),
      st('b', 'pending', { proposalOption: 'option-a' }),
    ];
    expect(nodeStanding(touched)).toBe('proposed');
  });

  it('a proposed statement beside a plain pending one leaves the node pending', () => {
    const touched = [
      st('a', 'pending', { proposalOption: 'option-a' }),
      st('b', 'pending'),
    ];
    expect(nodeStanding(touched)).toBe('pending');
  });
});

describe('proposalOption survives export and import (portable metadata)', () => {
  it('round-trips through the portable record, like findingClass', () => {
    const source = st('a', 'pending', { proposalOption: 'option-b', findingClass: 'drift' });
    const decoded = decodePortableMetadata(encodePortableMetadata(source, 'statement'), 'statement');
    expect(decoded.proposalOption).toBe('option-b');
    // It travels beside the fields it sits next to, not in place of them.
    expect(decoded.findingClass).toBe('drift');
  });

  it('stays absent when the statement names no option — import never invents one', () => {
    const source = st('a', 'pending');
    const decoded = decodePortableMetadata(encodePortableMetadata(source, 'statement'), 'statement');
    expect('proposalOption' in decoded).toBe(false);
  });
});
