/**
 * F139 step 3 — freeform re-analysis of the pending set.
 *
 * The rule under test: RE-ANALYSIS MOVES FACTS, IT NEVER MINTS THEM. The risk this guards is a
 * reorganization pass quietly introducing a claim under cover of tidying — the human asked for
 * grouping and got a new assertion they never read.
 */
import { describe, it, expect } from 'vitest';
import { reanalysisRequest, validateProposedReanalysis, reanalysisSummary } from '../reanalysis';
import type { Statement } from '../types';

const KPRED = 'urn:kbase:predicate/';
let n = 0;
const st = (s: string, p: string, o: string, id?: string): Statement => {
  n += 1;
  return {
    id: id ?? `f${n}`,
    s: { kind: 'iri', value: s }, p: { kind: 'iri', value: p }, o: { kind: 'literal', value: o },
    g: { kind: 'iri', value: 'urn:g' }, sourceId: 'x', confidence: 1, status: 'pending',
    createdAt: n, updatedAt: n,
  } as Statement;
};

const pending = [
  st('urn:kbase:concept/deploy', `${KPRED}note`, 'ran the migration', 'f1'),
  st('urn:kbase:concept/deploy', `${KPRED}note`, 'rolled back once', 'f2'),
  st('urn:kbase:concept/deploy', `${KPRED}note`, 'finished 02:10', 'f3'),
];
const decisions = [
  { id: 'd1', subjectIri: 'urn:kbase:concept/deploy', question: 'Ship on Friday or Monday?' },
  { id: 'd2', subjectIri: 'urn:kbase:concept/rollback', question: 'Automatic rollback or manual?' },
];
const request = reanalysisRequest('these are all about the March deploy', pending, decisions);

describe('reanalysisRequest — the instruction is kept verbatim as provenance', () => {
  it('carries the words the person typed, and only pending facts', () => {
    expect(request.instruction).toBe('these are all about the March deploy');
    expect(request.facts.map((f) => f.id)).toEqual(['f1', 'f2', 'f3']);
    expect(request.facts[0].predicate).toBe('kpred:note');
  });
});

describe('validateProposedReanalysis — the operation set is closed', () => {
  it('accepts attach, group, depend and drop over ids that exist', () => {
    const out = validateProposedReanalysis({
      operations: [
        { op: 'attach', factIds: ['f1'], decisionId: 'd1' },
        { op: 'group', factIds: ['f2', 'f3'], question: 'Did the March deploy succeed?' },
        { op: 'depend', blockerDecisionId: 'd2', blockedDecisionId: 'd1' },
      ],
    }, request);
    expect(out.rejected).toEqual([]);
    expect(out.operations).toHaveLength(3);
  });

  it('REJECTS any operation outside the closed set — there is no add or edit', () => {
    const out = validateProposedReanalysis({
      operations: [
        { op: 'add', factIds: ['f1'], object: 'a brand new claim' } as never,
        { op: 'settle', factIds: ['f2'] } as never,
      ],
    }, request);
    expect(out.operations).toEqual([]);
    expect(out.rejected).toHaveLength(2);
    expect(out.rejected.join(' ')).toMatch(/never mints them/);
  });

  it('REJECTS ids that were not in the request', () => {
    const out = validateProposedReanalysis({
      operations: [{ op: 'attach', factIds: ['f1', 'f99'], decisionId: 'd1' }],
    }, request);
    expect(out.operations).toEqual([]);
    expect(out.rejected.join(' ')).toMatch(/f99/);
  });

  it('REJECTS attaching to a decision that does not exist', () => {
    const out = validateProposedReanalysis({
      operations: [{ op: 'attach', factIds: ['f1'], decisionId: 'nope' }],
    }, request);
    expect(out.rejected.join(' ')).toMatch(/not in the request/);
  });

  it('refuses to let two operations fight over one fact', () => {
    const out = validateProposedReanalysis({
      operations: [
        { op: 'attach', factIds: ['f1', 'f2'], decisionId: 'd1' },
        { op: 'drop', factIds: ['f2'] },
      ],
    }, request);
    expect(out.operations).toHaveLength(1);
    expect(out.rejected.join(' ')).toMatch(/already claimed by an earlier attach/);
  });

  it('REJECTS a group of one, and a group whose question nobody can answer', () => {
    const out = validateProposedReanalysis({
      operations: [
        { op: 'group', factIds: ['f1'], question: 'Did it work?' },
        { op: 'group', factIds: ['f2', 'f3'], question: 'deploy notes' },
      ],
    }, request);
    expect(out.operations).toEqual([]);
    expect(out.rejected.join(' ')).toMatch(/reorganizes nothing/);
    expect(out.rejected.join(' ')).toMatch(/not a question a person can answer/);
  });

  it('REJECTS a decision made its own prerequisite', () => {
    const out = validateProposedReanalysis({
      operations: [{ op: 'depend', blockerDecisionId: 'd1', blockedDecisionId: 'd1' }],
    }, request);
    expect(out.rejected.join(' ')).toMatch(/its own prerequisite/);
  });
});

describe('reanalysisSummary — say what would happen before anything happens', () => {
  it('counts the operations and states plainly that nothing is settled', () => {
    const out = validateProposedReanalysis({
      operations: [
        { op: 'attach', factIds: ['f1'], decisionId: 'd1' },
        { op: 'group', factIds: ['f2', 'f3'], question: 'Did the March deploy succeed?' },
      ],
    }, request);
    const s = reanalysisSummary(out);
    expect(s).toMatch(/1 attach/);
    expect(s).toMatch(/1 group/);
    expect(s).toMatch(/3 pending facts affected/);
    expect(s).toMatch(/nothing settled/);
  });

  it('is honest when a run produced nothing usable', () => {
    const out = validateProposedReanalysis({ operations: [{ op: 'add' } as never] }, request);
    expect(reanalysisSummary(out)).toMatch(/Nothing survived validation \(1 rejected\)/);
    expect(reanalysisSummary(out)).toMatch(/pending set is unchanged/);
  });
});
