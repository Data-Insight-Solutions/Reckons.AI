/**
 * F139 decision ordering — settle the prerequisite before the thing that needs it.
 *
 * The relations were never missing, they were held at FEATURE level while the queue asked at FACT
 * level: `Statement.blocks` carried 8 of 529 rows, while the roadmap's `kpred:depends-on` carried
 * 140 edges. These tests pin the projection from one to the other, and pin the two things it must
 * refuse to do: bury a contested decision, and spin on a cycle.
 */
import { describe, it, expect } from 'vitest';
import { buildReviewTree, decisionDependencies, unlockCounts } from '../review-tree';
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
    expect(cycles).toEqual(new Set([STORAGE, SYNC]));

    // A cycle member may unlock the other member, but never itself. Counts must not depend on
    // which side the DFS happened to visit first.
    const unlocks = unlockCounts(all);
    expect(unlocks.get(STORAGE)).toBe(1);
    expect(unlocks.get(SYNC)).toBe(1);
  });

  it('gives every member of a longer cycle the same complete prerequisite closure', () => {
    const all = [
      ask(STORAGE, 'One file or many?', 'q1'),
      ask(SYNC, 'Push or pull?', 'q2'),
      ask(UI, 'Panel or page?', 'q3'),
      st(STORAGE, `${KPRED}depends-on`, '', { o: iri(SYNC) }),
      st(SYNC, `${KPRED}depends-on`, '', { o: iri(UI) }),
      st(UI, `${KPRED}depends-on`, '', { o: iri(STORAGE) }),
    ];
    const { blockedBy, cycles } = decisionDependencies(all, new Set([STORAGE, SYNC, UI]));

    expect(cycles).toEqual(new Set([STORAGE, SYNC, UI]));
    expect(blockedBy.get(STORAGE)).toEqual([SYNC, UI]);
    expect(blockedBy.get(SYNC)).toEqual([STORAGE, UI]);
    expect(blockedBy.get(UI)).toEqual([STORAGE, SYNC]);
  });

  it('marks every member of a branched strongly-connected dependency component', () => {
    const API = 'urn:kbase:concept/api';
    const all = [
      st(STORAGE, `${KPRED}depends-on`, '', { o: iri(SYNC) }),
      st(STORAGE, `${KPRED}depends-on`, '', { o: iri(UI) }),
      st(SYNC, `${KPRED}depends-on`, '', { o: iri(API) }),
      st(UI, `${KPRED}depends-on`, '', { o: iri(API) }),
      st(API, `${KPRED}depends-on`, '', { o: iri(STORAGE) }),
    ];
    const { cycles } = decisionDependencies(all, new Set());
    expect(cycles).toEqual(new Set([STORAGE, SYNC, UI, API]));
  });

  it('counts a shared downstream dependant once instead of once per path', () => {
    const LEAF = 'urn:kbase:concept/leaf';
    const all = [
      st(SYNC, `${KPRED}depends-on`, '', { o: iri(STORAGE) }),
      st(UI, `${KPRED}depends-on`, '', { o: iri(STORAGE) }),
      st(LEAF, `${KPRED}depends-on`, '', { o: iri(SYNC) }),
      st(LEAF, `${KPRED}depends-on`, '', { o: iri(UI) }),
    ];

    const unlocks = unlockCounts(all);
    expect(unlocks.get(STORAGE)).toBe(3); // SYNC, UI and LEAF — not LEAF twice
    expect(unlocks.get(SYNC)).toBe(1);
    expect(unlocks.get(UI)).toBe(1);
  });

  it('does not let a rejected dependency keep blocking a live decision', () => {
    const all = [
      ask(STORAGE, 'One file or many?', 'q1'),
      ask(SYNC, 'Push or pull?', 'q2'),
      st(SYNC, `${KPRED}depends-on`, '', { o: iri(STORAGE), status: 'rejected' }),
    ];
    const tree = buildReviewTree(all, all);
    expect(tree.decisions.find((d) => d.subjectIri === SYNC)?.blockedBy).toEqual([]);
  });
});

describe('dependency closure scaling', () => {
  it('keeps a 6,000-node chain below the interactive freeze budget', () => {
    const count = 6_000;
    const node = (index: number) => `urn:kbase:concept/scale-${index}`;
    const all = Array.from({ length: count - 1 }, (_, index) =>
      st(node(index + 1), `${KPRED}depends-on`, '', {
        id: `scale-dependency-${index}`,
        o: iri(node(index)),
      }),
    );
    const middle = Math.floor(count / 2);
    const open = new Set([node(0), node(middle), node(count - 1)]);

    const started = performance.now();
    const unlocks = unlockCounts(all);
    const dependencies = decisionDependencies(all, open);
    const elapsed = performance.now() - started;

    expect(unlocks.get(node(0))).toBe(count - 1);
    expect(unlocks.get(node(middle))).toBe(count - middle - 1);
    expect(dependencies.blockedBy.get(node(count - 1))).toEqual([node(0), node(middle)].sort());
    expect(dependencies.cycles.size).toBe(0);
    // The former per-node DFS takes several seconds on this fixture. Leave generous CI headroom
    // while still making a return to that O(V·E) implementation fail loudly.
    expect(elapsed).toBeLessThan(1_500);
  }, 10_000);
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
