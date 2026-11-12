/**
 * F89.4.4 — the run tree. A run is a set: group → subject → predicate, each level with a count
 * and row ids, and "no run" is a flag on the group, never a run invented for the row.
 */
import { describe, it, expect } from 'vitest';
import { buildRunTree } from '../review-run-tree.js';
import { rowId } from '../review-session.js';
import type { PendingRow } from '../review-links.js';

const S = 'urn:kbase:concept/';
const P = 'urn:kbase:predicate/';
const RUN = 'run-20261110-example';

/** Synthetic rows: 3 subjects, 4 predicates, one producer, one recorded run, one space. */
function makeRows(n: number, over: Partial<PendingRow> = {}): PendingRow[] {
  const subjects = [`${S}alpha`, `${S}beta`, `${S}gamma`];
  return Array.from({ length: n }, (_, i) => ({
    subject: subjects[i % subjects.length],
    predicate: `${P}p${i % 4}`,
    object: `value-${i}`,
    agent: 'offline:example-job',
    kb: 'roadmap',
    run: RUN,
    addedAt: '2026-11-10T08:00:00.000Z',
    ...over,
  }));
}

describe('buildRunTree', () => {
  it('40 rows from one run about 3 subjects give 1 group with 3 subject groups whose counts sum to 40', () => {
    const tree = buildRunTree(makeRows(40));
    expect(tree).toHaveLength(1);
    const [g] = tree;
    expect(g.kb).toBe('roadmap');
    expect(g.run).toBe(RUN);
    expect(g.runRecorded).toBe(true);
    expect(g.count).toBe(40);
    expect(g.rowIds).toHaveLength(40);
    expect(g.subjects).toHaveLength(3);
    expect(g.subjects.reduce((n, s) => n + s.count, 0)).toBe(40);
  });

  it('a row with no run lands in a group flagged runRecorded false, named by producer and UTC day', () => {
    const [g] = buildRunTree([
      { subject: `${S}alpha`, predicate: `${P}has-status`, object: 'planned', agent: 'offline:example-job', kb: 'roadmap', addedAt: '2026-11-09T23:30:00.000Z' },
    ]);
    expect(g.runRecorded).toBe(false);
    expect(g.run).toBe('2026-11-09');
    expect(g.agent).toBe('offline:example-job');
  });

  it('a row with neither run nor addedAt groups under its producer with an empty day, also runRecorded false', () => {
    const [g] = buildRunTree([
      { subject: `${S}alpha`, predicate: `${P}has-status`, object: 'planned', agent: 'offline:example-job', kb: 'roadmap' },
    ]);
    expect(g.runRecorded).toBe(false);
    expect(g.run).toBe('');
    expect(g.agent).toBe('offline:example-job');
  });

  it('a runId where no run was written is the run', () => {
    const [g] = buildRunTree([
      { subject: `${S}alpha`, predicate: `${P}has-status`, object: 'planned', agent: 'offline:example-job', kb: 'roadmap', runId: RUN },
    ]);
    expect(g.run).toBe(RUN);
    expect(g.runRecorded).toBe(true);
  });

  it('the same run id in two spaces gives two groups', () => {
    const tree = buildRunTree([...makeRows(3, { kb: 'roadmap' }), ...makeRows(2, { kb: 'production' })]);
    expect(tree).toHaveLength(2);
    expect(tree.map((g) => [g.kb, g.run]).sort()).toEqual([
      ['production', RUN],
      ['roadmap', RUN],
    ]);
  });

  it('an empty list gives an empty tree', () => {
    expect(buildRunTree([])).toEqual([]);
  });

  it('lists predicates inside each subject, larger first, with counts and row ids that line up', () => {
    const rows = makeRows(12);
    const [g] = buildRunTree(rows);
    for (const s of g.subjects) {
      expect(s.count).toBe(s.rowIds.length);
      expect(s.predicates.reduce((n, p) => n + p.count, 0)).toBe(s.count);
      expect(s.predicates.reduce((n, p) => n + p.rowIds.length, 0)).toBe(s.rowIds.length);
      // 12 rows over 3 subjects and 4 predicates: each subject (i % 3) strides i % 4, so every
      // subject touches all 4 predicates, once each.
      expect(s.predicates).toHaveLength(4);
      expect(s.predicates.map((p) => p.count)).toEqual([1, 1, 1, 1]);
    }
    // rowIds are the review-session ids of exactly this group's rows, in queue order.
    const expected = rows.map(rowId);
    expect(g.rowIds).toEqual(expected);
  });

  it('orders larger groups first, and ties in a stable order that does not depend on input order', () => {
    const small = makeRows(2, { run: 'run-small' });
    const bigA = makeRows(5, { run: 'run-b' });
    const bigB = makeRows(5, { run: 'run-c' });
    const first = buildRunTree([...small, ...bigA, ...bigB]);
    const second = buildRunTree([...bigB, ...small, ...bigA]);
    expect(first.map((g) => g.run)).toEqual(['run-b', 'run-c', 'run-small']);
    expect(first.map((g) => g.run)).toEqual(second.map((g) => g.run));
  });

  it('keeps a recorded run and an unrecorded day apart even when they are spelled the same', () => {
    const tree = buildRunTree([
      { subject: `${S}alpha`, predicate: `${P}has-status`, object: 'a', agent: 'offline:example-job', kb: 'roadmap', run: '2026-11-09' },
      { subject: `${S}alpha`, predicate: `${P}has-status`, object: 'b', agent: 'offline:example-job', kb: 'roadmap', addedAt: '2026-11-09T10:00:00.000Z' },
    ]);
    expect(tree).toHaveLength(2);
    expect(tree.map((g) => g.runRecorded)).toEqual([true, false]);
  });
});
