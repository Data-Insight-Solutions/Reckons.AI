/**
 * Partial facts — the well-formed absence (F32 / F80 / kb:mission).
 *
 * This is the feature the mission rests on, and it had NO tests. Two fields were being
 * dropped on import, and the landing page was already claiming otherwise.
 */
import { describe, it, expect } from 'vitest';
import {
  isPartial,
  openQuestions,
  blockedWork,
  questionsByImpact,
  resolvePartial,
  questionSummary,
  UNKNOWN_OBJECT,
} from '../partial-facts';
import { computeDiff } from '../diff';
import type { Statement } from '../types';
import { iri, lit } from '../types';

const KB = 'urn:kbase:concept/';
const KP = 'urn:kbase:predicate/';

let n = 0;
function fact(subject: string, predicate: string, object: string, over: Partial<Statement> = {}): Statement {
  return {
    id: `s${++n}`,
    s: iri(`${KB}${subject}`),
    p: iri(`${KP}${predicate}`),
    o: lit(object),
    g: iri('urn:kbase:source/test'),
    sourceId: 'src',
    confidence: 0.9,
    status: 'pending',
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

/** A question: subject and predicate known, object unknown. */
const question = (subject: string, predicate: string, over: Partial<Statement> = {}) =>
  fact(subject, predicate, UNKNOWN_OBJECT, {
    needsObject: true,
    question: `What should ${subject} ${predicate}?`,
    ...over,
  });

describe('isPartial / openQuestions', () => {
  it('tells a question from an assertion', () => {
    expect(isPartial(question('auto-merge', 'threshold'))).toBe(true);
    expect(isPartial(fact('auto-merge', 'threshold', '0.8'))).toBe(false);
  });

  it('ignores questions the user already rejected', () => {
    const qs = openQuestions([
      question('a', 'x'),
      question('b', 'y', { status: 'rejected' }),
      question('c', 'z', { status: 'superseded' }),
    ]);
    expect(qs).toHaveLength(1);
  });

  it('surfaces the newest question first', () => {
    const qs = openQuestions([
      question('old', 'x', { createdAt: 100 }),
      question('new', 'y', { createdAt: 900 }),
    ]);
    expect(qs[0].s.value).toContain('new');
  });
});

// ── THE POINT OF THE WHOLE THING ─────────────────────────────────────────────
describe('blocks — what a question COSTS, not merely that it exists', () => {
  it('answers "what is stalled behind this?"', () => {
    const q = question('browser-fact-finding', 'link-floor', {
      blocks: [`${KB}auto-merge`, `${KB}extension-linking`],
    });

    const blocked = blockedWork([q]);
    expect(blocked.get(`${KB}auto-merge`)).toHaveLength(1);
    expect(blocked.get(`${KB}extension-linking`)).toHaveLength(1);
  });

  it('ranks by how much answering it would unblock', () => {
    // A question blocking four things is not four times as urgent as one blocking one —
    // it is the difference between a decision and a curiosity.
    const ranked = questionsByImpact([
      question('curiosity', 'x'),
      question('decision', 'y', { blocks: [`${KB}a`, `${KB}b`, `${KB}c`, `${KB}d`] }),
      question('minor', 'z', { blocks: [`${KB}a`] }),
    ]);

    expect(ranked.map((r) => r.blocks)).toEqual([4, 1, 0]);
    expect(ranked[0].question.s.value).toContain('decision');
  });

  it('breaks ties toward the OLDER question', () => {
    // A hole nobody has filled in a week is evidence nobody will fill it by accident.
    const ranked = questionsByImpact([
      question('fresh', 'x', { blocks: [`${KB}a`], createdAt: 900 }),
      question('stale', 'y', { blocks: [`${KB}b`], createdAt: 100 }),
    ]);
    expect(ranked[0].question.s.value).toContain('stale');
  });

  it('a question with no declared blocks is still a question, just not a priority', () => {
    const ranked = questionsByImpact([question('a', 'x')]);
    expect(ranked[0].blocks).toBe(0);
    expect(blockedWork([question('a', 'x')]).size).toBe(0);
  });
});

describe('computeDiff — a hole must never be diffed against a real value', () => {
  it('always surfaces a partial fact as its own card', () => {
    // Diffing '?' against an existing object would compare a HOLE to a VALUE and produce
    // a bogus conflict or refinement. The user would be asked to adjudicate nonsense.
    const existing = [fact('auto-merge', 'threshold', '0.95', { status: 'confirmed' })];
    const incoming = [question('auto-merge', 'threshold')];

    const diff = computeDiff(incoming, existing);

    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0].kind).toBe('new');       // not 'conflicts', not 'refines'
    expect(diff.summary.conflicts).toBe(0);
    expect(diff.summary.refines).toBe(0);
  });

  it('does not treat two questions about the same thing as duplicates of each other', () => {
    const diff = computeDiff([question('a', 'x'), question('a', 'x')], []);
    expect(diff.entries.every((e) => e.kind === 'new')).toBe(true);
  });
});

describe('resolvePartial — answering it, and getting the answer BACK to who asked', () => {
  it('produces the patch and the answer without applying either', () => {
    const q = question('auto-merge', 'threshold', {
      askedBy: 'claude-code',
      blocks: [`${KB}auto-merge`],
    });

    const { patch, answer, unblocks } = resolvePartial(q, lit('0.8'));

    expect(patch.needsObject).toBe(false);
    expect(patch.o.value).toBe('0.8');

    expect(answer.subject).toBe(`${KB}auto-merge`);
    expect(answer.object).toBe('0.8');
    expect(answer.objectKind).toBe('literal');
    expect(unblocks).toEqual([`${KB}auto-merge`]);
  });

  it('carries WHO ASKED — an unattributed answer cannot be claimed', () => {
    // With more than one agent waiting, an answer with no agent belongs to nobody. This
    // field was being dropped on import, so it was ALWAYS undefined.
    const { answer } = resolvePartial(question('a', 'x', { askedBy: 'offline:describe' }), lit('yes'));
    expect(answer.agent).toBe('offline:describe');
  });

  it('distinguishes an entity answer from a literal one', () => {
    const asIri = resolvePartial(question('a', 'x'), iri(`${KB}production`));
    expect(asIri.answer.objectKind).toBe('iri');
    expect(asIri.answer.object).toBe(`${KB}production`);
  });

  it('refuses to resolve something that was never a question', () => {
    expect(() => resolvePartial(fact('a', 'x', 'already answered'), lit('y'))).toThrow(/not a question/);
  });
});

describe('questionSummary', () => {
  it('states the price, because a question with a price gets answered', () => {
    const q = question('x', 'y', { question: 'What threshold?', blocks: [`${KB}a`, `${KB}b`] });
    expect(questionSummary(q)).toBe('What threshold? (blocks 2 things)');
  });

  it('says "1 thing", not "1 things"', () => {
    const q = question('x', 'y', { question: 'What?', blocks: [`${KB}a`] });
    expect(questionSummary(q)).toContain('blocks 1 thing)');
  });

  it('falls back to the triple when no question text was given', () => {
    const q = question('x', 'y', { question: undefined });
    expect(questionSummary(q)).toContain('What is the object of');
  });
});
