/**
 * One choice, and everything it settles. The tests that matter here are the ones asserting what a
 * cascade does NOT do — a mechanism that settles too much is worse than one that settles too
 * little, because the person cannot see what they were charged for.
 */
import { describe, it, expect } from 'vitest';
import { planOptionCascade, cascadeWrites } from '../option-cascade';
import type { Statement } from '../types';

const KP = 'urn:kbase:predicate/';
const KC = 'urn:kbase:concept/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
let n = 0;
function st(s: string, p: string, o: string, opts: Partial<Statement> & { oIri?: boolean } = {}): Statement {
  n += 1;
  const { oIri, ...rest } = opts;
  return {
    id: rest.id ?? `s${n}`,
    s: { kind: 'iri', value: s },
    p: { kind: 'iri', value: p },
    o: { kind: oIri ? 'iri' : 'literal', value: o },
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'x', confidence: 1, status: rest.status ?? 'pending', createdAt: n, updatedAt: n,
    ...rest,
  } as Statement;
}

/** The fixture's shape: one decision, two rival claims, each option priced by what it kills. */
function graph() {
  const all: Statement[] = [
    st(`${KC}choice`, `${KP}open-question`, 'Lumenpath or Vantage Suite?', { id: 'q' }),
    st(`${KC}choice`, `${KP}chosen-platform`, `${KC}opt-lumenpath`, { id: 'sideA', oIri: true }),
    st(`${KC}choice`, `${KP}chosen-platform`, `${KC}opt-vantage`, { id: 'sideB', oIri: true }),
    st(`${KC}opt-lumenpath`, RDFS_LABEL, 'Choose Lumenpath', { id: 'lblA', status: 'confirmed' }),
    st(`${KC}opt-vantage`, RDFS_LABEL, 'Choose Vantage Suite', { id: 'lblB', status: 'confirmed' }),

    // Dies if Lumenpath wins.
    st(`${KC}ev-speed`, RDFS_LABEL, 'Large assemblies open in under a minute', { id: 'speedLbl' }),
    st(`${KC}ev-speed`, `${KP}ruled-out-by`, `${KC}opt-lumenpath`, { id: 'speedKill', oIri: true }),
    // Dies if Vantage wins.
    st(`${KC}ev-open`, RDFS_LABEL, 'Drawings readable without a vendor licence', { id: 'openLbl' }),
    st(`${KC}ev-open`, `${KP}ruled-out-by`, `${KC}opt-vantage`, { id: 'openKill', oIri: true }),
  ];
  const sides = all.filter((s) => s.id === 'sideA' || s.id === 'sideB');
  return { all, sides };
}

describe('planOptionCascade', () => {
  it('picking a side rejects the rival', () => {
    const { all, sides } = graph();
    const plan = planOptionCascade(sides, 'sideA', all)!;
    expect(plan.chosen.id).toBe('sideA');
    expect(plan.rejectedRivals.map((s) => s.id)).toEqual(['sideB']);
  });

  it('pays the WINNER\'s price — rejects the facts it rules out', () => {
    const { all, sides } = graph();
    const plan = planOptionCascade(sides, 'sideA', all)!;
    const rejected = plan.effects.filter((e) => e.status === 'rejected').map((e) => e.statement.id);
    // ev-speed dies with a Lumenpath win, and its label goes with it.
    expect(rejected).toContain('speedLbl');
    expect(plan.effects.every((e) => e.because.length > 10)).toBe(true);
  });

  it('does NOT pay the loser\'s price — a cost nobody chose is not charged', () => {
    const { all, sides } = graph();
    const plan = planOptionCascade(sides, 'sideA', all)!;
    const touched = plan.effects.map((e) => e.statement.id);
    // ev-open was only ever conditional on Vantage winning. Vantage lost, so it stays pending.
    expect(touched).not.toContain('openLbl');
    expect(touched).not.toContain('openKill');
  });

  it('never settles a fact twice, and never settles a side as a consequence', () => {
    const { all, sides } = graph();
    const writes = cascadeWrites(planOptionCascade(sides, 'sideA', all)!);
    const ids = writes.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('leaves already-settled facts alone', () => {
    const { all, sides } = graph();
    const settled = all.map((s) => (s.id === 'speedLbl' ? { ...s, status: 'confirmed' as const } : s));
    const plan = planOptionCascade(sides, 'sideA', settled)!;
    expect(plan.effects.map((e) => e.statement.id)).not.toContain('speedLbl');
  });

  it('returns null for a choice that is not one of the sides', () => {
    const { all, sides } = graph();
    expect(planOptionCascade(sides, 'not-a-side', all)).toBeNull();
  });
});

describe('downstream decisions are SURFACED, never settled', () => {
  function withDownstream() {
    const { all, sides } = graph();
    all.push(
      st(`${KC}archive`, `${KP}open-question`, 'Neutral export or native format?', { id: 'q2' }),
      st(`${KC}archive`, RDFS_LABEL, 'Which archive format', { id: 'q2lbl', status: 'confirmed' }),
      st(`${KC}archive`, `${KP}depends-on`, `${KC}choice`, { id: 'dep', oIri: true }),
      st(`${KC}archive`, `${KP}chosen-format`, 'Neutral STEP export', { id: 'fmtA' }),
      st(`${KC}archive`, `${KP}chosen-format`, 'Native platform format', { id: 'fmtB' }),
    );
    return { all, sides };
  }

  it('reports the dependent decision as unblocked', () => {
    const { all, sides } = withDownstream();
    const plan = planOptionCascade(sides, 'sideA', all)!;
    const d = plan.downstream.find((x) => x.subjectIri === `${KC}archive`);
    expect(d?.effect).toBe('unblocked');
  });

  it('does NOT settle the dependent decision\'s own facts', () => {
    const { all, sides } = withDownstream();
    const writes = cascadeWrites(planOptionCascade(sides, 'sideA', all)!);
    const ids = writes.map((w) => w.id);
    // THE LOAD-BEARING ASSERTION. Settling a second decision from the first would decide
    // something nobody was asked — the rule kb:cascade-aggregation already established.
    expect(ids).not.toContain('fmtA');
    expect(ids).not.toContain('fmtB');
    expect(ids).not.toContain('q2');
  });

  it('ignores an unrelated open decision entirely', () => {
    const { all, sides } = withDownstream();
    all.push(st(`${KC}unrelated`, `${KP}open-question`, 'Something else?', { id: 'q3' }));
    const plan = planOptionCascade(sides, 'sideA', all)!;
    expect(plan.downstream.map((d) => d.subjectIri)).not.toContain(`${KC}unrelated`);
  });
});

describe('the summary says what will happen before it happens', () => {
  it('names the pick and every consequence', () => {
    const { all, sides } = graph();
    const plan = planOptionCascade(sides, 'sideA', all)!;
    expect(plan.summary).toContain('Choose Lumenpath');
    expect(plan.summary).toContain('reject 1 rival');
    expect(plan.summary).toContain('Nothing else is touched.');
  });

  it('confirms the chosen side and nothing else as confirmed', () => {
    const { all, sides } = graph();
    const writes = cascadeWrites(planOptionCascade(sides, 'sideA', all)!);
    expect(writes.filter((w) => w.status === 'confirmed').map((w) => w.id)).toEqual(['sideA']);
  });
});
