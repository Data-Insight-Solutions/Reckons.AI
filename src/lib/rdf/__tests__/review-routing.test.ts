/**
 * Review routing + blast radius (F88).
 *
 * The property under test is what the USER is shown. Route too much to `machine` and facts
 * get accepted with no competent reviewer; rank badly and the item with four things stalled
 * behind it sits under fifty trivia. Both failures are quiet, which is why they are tested.
 */
import { describe, it, expect } from 'vitest';
import { routeQueue, blastRadius, routingSummary } from '../review-routing';
import type { Statement } from '../types';

const KPRED = 'urn:kbase:predicate/';
let n = 0;

function stmt(p: string, o: string, extra: Partial<Statement> = {}): Statement {
  n += 1;
  return {
    id: `s${n}`,
    s: { kind: 'iri', value: `urn:kbase:concept/e${n}` },
    p: { kind: 'iri', value: p },
    o: { kind: 'literal', value: o },
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'src',
    confidence: 1,
    status: 'pending',
    createdAt: n,
    updatedAt: n,
    ...extra,
  } as Statement;
}

describe('routeQueue — who is competent to judge this', () => {
  it('keeps code facts OFF the user\'s desk and puts principles ON it', () => {
    const codeFact = stmt(`${KPRED}has-file`, 'src/lib/rdf/types.ts');
    const principle = stmt(`${KPRED}principle`, 'The user is the bottleneck.');
    const userFact = stmt(`${KPRED}likes`, 'coffee', { sourceId: 'manual' });

    const q = routeQueue([codeFact, principle, userFact]);

    expect(q.machine.map((i) => i.statement.id)).toEqual([codeFact.id]);
    expect(q.user.map((i) => i.statement.id).sort()).toEqual([principle.id, userFact.id].sort());
  });

  it('a fact about a Tenet is the user\'s however checkable it looks', () => {
    const onTenet = stmt(`${KPRED}has-file`, 'src/lib/rdf/types.ts');
    const typeOf = (iri: string) => (iri === onTenet.s.value ? 'urn:kbase:type/Tenet' : undefined);

    expect(routeQueue([onTenet], typeOf).user).toHaveLength(1);
    expect(routeQueue([onTenet], typeOf).machine).toHaveLength(0);
    // …and without the Tenet type, the same fact is a machine's to settle.
    expect(routeQueue([onTenet]).machine).toHaveLength(1);
  });

  it('an UNCLASSIFIED fact goes to the user — never machine-approved by default', () => {
    const mystery = stmt(`${KPRED}whatever`, 'something');
    const q = routeQueue([mystery]);
    expect(q.user).toHaveLength(1);
    expect(q.machine).toHaveLength(0);
  });
});

describe('blastRadius — what does leaving this unsettled actually cost', () => {
  it('counts what a question directly blocks', () => {
    const q1 = stmt(`${KPRED}confidence-threshold`, '?', {
      needsObject: true,
      blocks: ['urn:kbase:concept/a', 'urn:kbase:concept/b'],
    });
    expect(blastRadius([q1]).get(q1.id)).toBe(2);
  });

  it('follows the CHAIN — blocking a blocker counts for more than blocking a leaf', () => {
    // deep: blocks B. B is itself a pending fact blocking two more things.
    const b = stmt(`${KPRED}x`, '?', {
      needsObject: true,
      blocks: ['urn:kbase:concept/c', 'urn:kbase:concept/d'],
    });
    const deep = stmt(`${KPRED}y`, '?', { needsObject: true, blocks: [b.s.value] });

    // shallow: blocks two leaves that block nothing.
    const shallow = stmt(`${KPRED}z`, '?', {
      needsObject: true,
      blocks: ['urn:kbase:concept/leaf1', 'urn:kbase:concept/leaf2'],
    });

    const r = blastRadius([b, deep, shallow]);
    expect(r.get(deep.id)!).toBeGreaterThan(r.get(shallow.id)!);
  });

  it('does not spin forever on a cycle — deadlocked work must not hang the queue', () => {
    const a = stmt(`${KPRED}a`, '?', { needsObject: true });
    const b = stmt(`${KPRED}b`, '?', { needsObject: true, blocks: [a.s.value] });
    a.blocks = [b.s.value];
    expect(() => blastRadius([a, b])).not.toThrow();
  });

  it('a fact blocking nothing has zero blast radius', () => {
    expect(blastRadius([stmt(`${KPRED}p`, 'o')]).get('s' + n)).toBe(0);
  });
});

describe('ranking', () => {
  it('the most-blocking item is first, not the newest', () => {
    const trivial = stmt(`${KPRED}a`, '?', { needsObject: true, createdAt: 100 });
    const urgent = stmt(`${KPRED}b`, '?', {
      needsObject: true,
      createdAt: 1,
      blocks: ['urn:kbase:concept/x', 'urn:kbase:concept/y', 'urn:kbase:concept/z'],
    });
    const q = routeQueue([trivial, urgent]);
    expect(q.user[0].statement.id).toBe(urgent.id);
    expect(q.user[0].impact).toBe(3);
  });

  it('ties break toward the OLDER item — a week-old hole will not fill itself', () => {
    const older = stmt(`${KPRED}a`, '?', { needsObject: true, createdAt: 1 });
    const newer = stmt(`${KPRED}b`, '?', { needsObject: true, createdAt: 999 });
    const q = routeQueue([newer, older]);
    expect(q.user[0].statement.id).toBe(older.id);
  });
});

describe('routingSummary — say what the user is being spared', () => {
  it('reports how much of the queue is not theirs', () => {
    const code = stmt(`${KPRED}has-file`, 'src/a/b.ts');
    const mine = stmt(`${KPRED}principle`, 'x');
    expect(routingSummary(routeQueue([code, mine]))).toContain('1 of 2 need you');
  });

  it('says so plainly when everything really is the user\'s', () => {
    expect(routingSummary(routeQueue([stmt(`${KPRED}principle`, 'x')]))).toContain('yours to decide');
  });
});
