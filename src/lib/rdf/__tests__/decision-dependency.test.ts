/**
 * F139 decision ordering — settle the prerequisite before the thing that needs it.
 *
 * The relations were never missing, they were held at FEATURE level while the queue asked at FACT
 * level: `Statement.blocks` carried 8 of 529 rows, while the roadmap's `kpred:depends-on` carried
 * 140 edges. These tests pin the projection from one to the other, and pin the two things it must
 * refuse to do: bury a contested decision, and spin on a cycle.
 */
import { describe, it, expect } from 'vitest';
import { buildReviewTree, decisionDependencies } from '../review-tree';
import type { Statement } from '../types';

const KPRED = 'urn:kbase:predicate/';
let n = 0;
function st(s: string, p: string, o: string, extra: Partial<Statement> = {}): Statement {
  n += 1;
  return {
    id: extra.id ?? `s${n}`,
    s: { kind: 'iri', value: s },
    p: { kind: 'iri', value: p },
    o: extra.o ?? { kind: 'literal', value: o },
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'x', confidence: 1, status: 'pending', createdAt: n, updatedAt: n,
    ...extra,
  } as Statement;
}
const iri = (v: string) => ({ kind: 'iri' as const, value: v });

const STORAGE = 'urn:kbase:concept/storage';
const SYNC = 'urn:kbase:concept/sync';
const UI = 'urn:kbase:concept/ui';
const ask = (subject: string, q: string, id: string) =>
  st(subject, `${KPRED}open-question`, q, { id });

describe('decisionDependencies — the order is projected from the plan, not invented', () => {
  it('waits on a prerequisite that has its own open decision', () => {
    const all = [
      ask(STORAGE, 'One file or many?', 'q1'),
      ask(SYNC, 'Push or pull?', 'q2'),
      st(SYNC, `${KPRED}depends-on`, '', { o: iri(STORAGE) }),
    ];
    const { blockedBy } = decisionDependencies(all, new Set([STORAGE, SYNC]));
    expect(blockedBy.get(SYNC)).toEqual([STORAGE]);
    expect(blockedBy.has(STORAGE)).toBe(false);
  });

  it('follows the chain transitively — a grandparent still blocks', () => {
    const all = [
      ask(STORAGE, 'One file or many?', 'q1'),
      ask(UI, 'Panel or page?', 'q3'),
      st(SYNC, `${KPRED}depends-on`, '', { o: iri(STORAGE) }),
      st(UI, `${KPRED}depends-on`, '', { o: iri(SYNC) }),
    ];
    // SYNC has no open decision, so it is not itself a blocker — but it does not break the chain.
    const { blockedBy } = decisionDependencies(all, new Set([STORAGE, UI]));
    expect(blockedBy.get(UI)).toEqual([STORAGE]);
  });

  it('ignores a prerequisite that has nothing open — a settled foundation blocks nobody', () => {
    const all = [
      ask(SYNC, 'Push or pull?', 'q2'),
      st(SYNC, `${KPRED}depends-on`, '', { o: iri(STORAGE) }),
    ];
    const { blockedBy } = decisionDependencies(all, new Set([SYNC]));
    expect(blockedBy.has(SYNC)).toBe(false);
  });

  it('REPORTS a cycle instead of spinning on it', () => {
    const all = [
      ask(STORAGE, 'One file or many?', 'q1'),
      ask(SYNC, 'Push or pull?', 'q2'),
      st(SYNC, `${KPRED}depends-on`, '', { o: iri(STORAGE) }),
      st(STORAGE, `${KPRED}depends-on`, '', { o: iri(SYNC) }),
    ];
    const { cycles } = decisionDependencies(all, new Set([STORAGE, SYNC]));
    expect(cycles.size).toBeGreaterThan(0);
  });
});

describe('buildReviewTree — prerequisite is offered before dependant', () => {
  it('puts the blocker above the blocked, and names what to settle first', () => {
    const all = [
      ask(SYNC, 'Push or pull?', 'q2'),
      ask(STORAGE, 'One file or many?', 'q1'),
      st(SYNC, `${KPRED}depends-on`, '', { o: iri(STORAGE) }),
    ];
    const tree = buildReviewTree(all, all);
    expect(tree.decisions[0].subjectIri).toBe(STORAGE);
    const sync = tree.decisions.find((d) => d.subjectIri === SYNC)!;
    expect(sync.blockedBy).toEqual([STORAGE]);
    expect(tree.decisions[0].blockedBy).toEqual([]);
  });

  it('NEVER buries a contested decision beneath an unblocked one', () => {
    // Contested outranks everything: a live disagreement is the one thing that must not sink,
    // even when it is waiting on a prerequisite.
    // A dichotomy needs a well-identified entity and two HAND-ENTERED values — otherwise it is
    // an import artefact, not a change of mind.
    const all = [
      ask(STORAGE, 'One file or many?', 'q1'),
      st(SYNC, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', '', { o: iri('urn:kbase:type/Concept'), id: 't' }),
      st(SYNC, 'http://www.w3.org/2000/01/rdf-schema#label', 'Sync', { id: 'lbl' }),
      st(SYNC, `${KPRED}has-status`, 'planned', { sourceId: 'manual', id: 'c1' }),
      st(SYNC, `${KPRED}has-status`, 'functional', { sourceId: 'manual', id: 'c2' }),
      st(SYNC, `${KPRED}depends-on`, '', { o: iri(STORAGE) }),
    ];
    const tree = buildReviewTree(all, all);
    const first = tree.decisions[0];
    expect(first.subjectIri).toBe(SYNC);
    expect(first.contested).toBe(true);
    // It is still honest about waiting on something.
    expect(first.blockedBy).toEqual([STORAGE]);
  });
});
